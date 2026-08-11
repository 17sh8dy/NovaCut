/**
 * OfflineExporter — renders a sequence to frames and pushes them into a FrameEncoder.
 *
 * It reuses the exact same Compositor as the live preview, guaranteeing the export matches
 * what the user sees. Frames are produced one at a time and streamed to the encoder so we
 * never hold the whole video in memory.
 *
 * Note on decoding: this path drives frames from <video> elements, whose seeks are async.
 * We give each seek a brief settle window. The frame-accurate upgrade is WebCodecs, which
 * slots in behind FrameSource without touching this class.
 */

import {
  findMedia,
  framesToTicks,
  toSeconds,
  type FrameEncoder,
  type MediaAsset,
  type Project,
  type Sequence,
  type Ticks,
} from '@opencut/core';
import { Compositor } from '../compositor/compositor.js';
import { FrameSourcePool } from '../media/frameSource.js';

export interface ExportProgressInfo {
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  etaSeconds: number;
}

/**
 * Wall-clock milliseconds spent in each phase of the render loop, accumulated across the whole
 * export.
 *
 * This exists because export cost is not where it looks like it is. The obvious suspect is the
 * GPU composite, and on measured runs the compositor is a small minority of the time — the loop
 * is dominated by waiting for decodes and by handing frames to the encoder. Optimising without
 * this is guessing, and the phases are cheap to record: six performance.now() calls against a
 * frame that costs milliseconds.
 */
export interface ExportProfile {
  /** Issuing seeks for the frame about to be rendered. */
  prepare: number;
  /** Waiting for those seeks to actually decode. */
  awaitDecode: number;
  /** The GPU composite whose pixels are kept. */
  render: number;
  /** glReadPixels — a synchronous pipeline stall by nature. */
  readback: number;
  /** Handing the frame to the encoder, including backpressure. */
  encode: number;
  frames: number;
  totalMs: number;
}

export class OfflineExporter {
  private compositor: Compositor;
  private pool: FrameSourcePool;
  private aborted = false;
  private outWidth: number;
  private outHeight: number;
  /** Phase timings for the run that just finished (or is in progress). See ExportProfile. */
  readonly profile: ExportProfile = {
    prepare: 0,
    awaitDecode: 0,
    render: 0,
    readback: 0,
    encode: 0,
    frames: 0,
    totalMs: 0,
  };

  constructor(
    private project: Project,
    private sequence: Sequence,
    resolveUrl: (src: string) => string,
    outputWidth: number,
    outputHeight: number,
  ) {
    this.outWidth = outputWidth;
    this.outHeight = outputHeight;
    // Use a real <canvas> (WebGL2 on OffscreenCanvas is inconsistent across engines).
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    this.pool = new FrameSourcePool(resolveUrl);
    this.compositor = new Compositor(canvas, this.pool);
    this.compositor.resize(outputWidth, outputHeight);
  }

  /**
   * Two reusable readback targets, alternated per frame.
   *
   * A 1080p RGBA frame is 8 MB, so allocating one per frame makes a quarter of a gigabyte of
   * garbage every second of output and hands the collector a bill in the middle of the render.
   * Two buffers rather than one because the frame just read is still travelling to the encoder
   * while the next one is composited: reusing a single buffer would let a later readback
   * overwrite a frame that had not finished being sent.
   */
  private buffers: [Uint8Array, Uint8Array] | null = null;
  private readbackBuffer(frame: number): Uint8Array {
    this.buffers ??= [
      new Uint8Array(this.outWidth * this.outHeight * 4),
      new Uint8Array(this.outWidth * this.outHeight * 4),
    ];
    return this.buffers[frame % 2]!;
  }

  abort(): void {
    this.aborted = true;
  }

  /**
   * Did this run stop because it was cancelled?
   *
   * `run()` resolves normally on abort rather than throwing, because a cancellation is not an
   * error — but that means the caller cannot tell "finished" from "stopped" by control flow
   * alone, and would go on to announce a completed export and open a folder on a partial file.
   */
  get cancelled(): boolean {
    return this.aborted;
  }

  /** Render every frame in the export range and stream them to `encoder`. */
  async run(
    encoder: FrameEncoder,
    fps: number,
    onProgress: (info: ExportProgressInfo) => void,
    range?: { start: number; end: number },
  ): Promise<void> {
    const startTicks = range?.start ?? 0;
    const endTicks = range?.end ?? this.sequence.duration;
    const durationSeconds = Math.max(0, toSeconds(endTicks - startTicks));
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * fps));
    const startWall = performance.now();

    const getMedia = (id: string): MediaAsset | undefined => findMedia(this.project, id as never);
    const P = this.profile;
    let mark = performance.now();
    /** Charge the time since the last mark to one phase. */
    const lap = (phase: 'prepare' | 'awaitDecode' | 'render' | 'readback' | 'encode'): void => {
      const now = performance.now();
      P[phase] += now - mark;
      mark = now;
    };

    const timeOf = (f: number): Ticks => (startTicks + framesToTicks(f, fps)) as Ticks;
    const frameCtx = (f: number) => ({ sequence: this.sequence, time: timeOf(f), getMedia });

    try {
      // Start the first frame's decodes before entering the loop; from then on each iteration
      // starts the NEXT frame's while it finishes the current one.
      mark = performance.now();
      this.compositor.prepare(frameCtx(0));
      lap('prepare');

      for (let f = 0; f < totalFrames; f++) {
        if (this.aborted) {
          await encoder.abort();
          return;
        }
        // Wait for the seeks issued for THIS frame — one iteration ago, or just above for f=0.
        // It must be an event-driven wait, not a sleep: see FrameSource.whenReady.
        await this.pool.whenAllReady(SEEK_TIMEOUT_MS);
        await nextFrame();
        lap('awaitDecode');

        this.compositor.render(frameCtx(f));
        lap('render');

        /*
         * ── THE PIPELINE ────────────────────────────────────────────────────────────────
         *
         * The next frame's seeks are issued HERE, before this frame is drained, because the two
         * are independent: the decoder answers a seek while the CPU is still reading back and
         * encoding the frame already composited. Serialised, an export paid both in full; the
         * readback and the encode now happen inside the decode wait that was dead time anyway.
         *
         * This is safe to do before readPixels: the frame has already been uploaded to a texture
         * and composited onto the canvas, so moving the <video> elements on cannot change the
         * pixels being read. And it is safe for the next render(), whose own sync() lands on a
         * source that is already at the target and returns without re-seeking.
         */
        if (f + 1 < totalFrames) this.compositor.prepare(frameCtx(f + 1));
        lap('prepare');

        /*
         * Queue this frame's readback, then collect and send the PREVIOUS one.
         *
         * The pixels are identical to a synchronous read — the frame is fetched a beat later,
         * after the GPU has had the intervening work to complete the transfer, instead of the
         * CPU standing still waiting for it. GL executes in order, so the read queued here
         * captures THIS frame even though the next render overwrites the canvas before it is
         * collected.
         */
        this.compositor.beginReadPixels(f);
        if (f > 0) {
          const pixels = this.compositor.endReadPixels(f - 1, this.readbackBuffer(f - 1));
          lap('readback');
          await encoder.writeFrame(pixels);
          lap('encode');
        } else {
          lap('readback');
        }
        P.frames++;
        P.totalMs = P.prepare + P.awaitDecode + P.render + P.readback + P.encode;

        const done = f + 1;
        const elapsed = (performance.now() - startWall) / 1000;
        const eta = elapsed > 0 ? (elapsed / done) * (totalFrames - done) : 0;
        onProgress({ progress: done / totalFrames, renderedFrames: done, totalFrames, etaSeconds: eta });
      }
      // The final frame's readback is still in flight — one frame of latency is the cost of
      // overlapping them, and it has to be drained or the export would be one frame short.
      if (totalFrames > 0 && !this.aborted) {
        const last = totalFrames - 1;
        mark = performance.now();
        const pixels = this.compositor.endReadPixels(last, this.readbackBuffer(last));
        lap('readback');
        await encoder.writeFrame(pixels);
        lap('encode');
      }
      await encoder.finish();
    } finally {
      this.compositor.dispose();
      this.pool.disposeAll();
    }
  }
}

/**
 * Upper bound on how long one frame may wait for its decode. Generous on purpose: it is a
 * deadlock guard, not a pacing knob — a healthy seek resolves in a few milliseconds, so this
 * only costs anything on a source that is genuinely stuck.
 */
const SEEK_TIMEOUT_MS = 2000;

/**
 * Hand the compositor one presentation tick after the decode completes. `seeked` fires when the
 * frame is decoded; this gives the element the beat it needs to present it, so texImage2D reads
 * the new frame rather than the outgoing one.
 *
 * It races a timer because rAF does not fire in a minimised/occluded window — and an export the
 * user backgrounded on purpose must not be the one that hangs.
 */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 32);
  });
