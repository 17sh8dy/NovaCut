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
        // Let async video seeks settle before we grab pixels.
        await settle();
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

/** Yield to the event loop briefly so pending <video> seeks can resolve. */
const settle = () => new Promise<void>((r) => setTimeout(r, 24));
