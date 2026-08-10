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
  type Project,
  type Sequence,
} from '@opencut/core';
import { Compositor } from '../compositor/compositor.js';
import { FrameSourcePool } from '../media/frameSource.js';

export interface ExportProgressInfo {
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  etaSeconds: number;
}

export class OfflineExporter {
  private compositor: Compositor;
  private pool: FrameSourcePool;
  private aborted = false;

  constructor(
    private project: Project,
    private sequence: Sequence,
    resolveUrl: (src: string) => string,
    outputWidth: number,
    outputHeight: number,
  ) {
    // Use a real <canvas> (WebGL2 on OffscreenCanvas is inconsistent across engines).
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    this.pool = new FrameSourcePool(resolveUrl);
    this.compositor = new Compositor(canvas, this.pool);
    this.compositor.resize(outputWidth, outputHeight);
  }

  abort(): void {
    this.aborted = true;
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

    try {
      for (let f = 0; f < totalFrames; f++) {
        if (this.aborted) {
          await encoder.abort();
          return;
        }
        const time = startTicks + framesToTicks(f, fps);
        this.compositor.render({
          sequence: this.sequence,
          time,
          getMedia: (id) => findMedia(this.project, id as never),
        });
        // The render above ISSUES the seeks; this waits for them to actually decode. It must be
        // an event-driven wait, not a sleep — see FrameSource.whenReady. The second render is
        // what samples the freshly decoded frame.
        await this.pool.whenAllReady(SEEK_TIMEOUT_MS);
        await nextFrame();
        this.compositor.render({
          sequence: this.sequence,
          time,
          getMedia: (id) => findMedia(this.project, id as never),
        });

        await encoder.writeFrame(this.compositor.readPixels());

        const done = f + 1;
        const elapsed = (performance.now() - startWall) / 1000;
        const eta = elapsed > 0 ? (elapsed / done) * (totalFrames - done) : 0;
        onProgress({ progress: done / totalFrames, renderedFrames: done, totalFrames, etaSeconds: eta });
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
