/**
 * Compositor — the WebGL2 renderer for video.
 *
 * Given a Sequence and a playhead time, it draws the composited frame to a canvas: for each
 * visible video track (bottom-up), it finds the active clip, uploads its current frame to a
 * texture, runs the clip's enabled effects through the shared effect chain, then composites the
 * result with its transform (position/scale/rotation) and opacity.
 *
 * The SAME code path renders preview and export — export just points it at an offscreen canvas
 * and reads pixels per frame. That guarantees "what you see is what you render."
 *
 * ## Why the GL plumbing lives elsewhere
 *
 * The quad, the program cache, the frame upload and the effect chain are all in `../gl`, shared
 * with the photo render graph. They started here and moved out when the photo editor grew a
 * graph of its own, because the alternative was two copies of the texture-orientation
 * convention — and that convention has already caused one silent, shipped bug (every effect
 * pass flipping the frame; upside-down at odd effect counts, self-cancelling at even ones).
 * Two copies of a rule that must never disagree is how it disagrees. `.verify:orientation` pins
 * it, through whichever renderer, because there is now only one implementation to pin.
 *
 * What remains here is what is genuinely video-specific: the track walk, the clip time-window
 * search, source seeking, and the clip transform.
 */

import {
  sample,
  toSeconds,
  videoTracksTopDown,
  type Clip,
  type MediaAsset,
  type Sequence,
  type Ticks,
} from '@opencut/core';
import type { FrameSourcePool } from '../media/frameSource.js';
import { COMPOSITE_FRAGMENT, VERTEX_SHADER } from './shaders.js';
import { GLContext } from '../gl/glContext.js';
import { FboPool } from '../gl/fboPool.js';
import { runEffectChain } from '../gl/effectChain.js';
import { dthrottle } from '../debug.js';

export interface RenderContext {
  sequence: Sequence;
  time: Ticks;
  getMedia: (id: string) => MediaAsset | undefined;
  /** True during live playback: video sources play instead of seeking per frame. Omit
   * (or false) for scrubbing/export, where each frame is seeked exactly. */
  playing?: boolean;
  /** Global preview speed from the transport (e.g. 2 for ×2). The playhead already advances
   * at this rate, so the decoded element must run at clipSpeed × this to keep pace. Default 1. */
  speed?: number;
}

export class Compositor {
  private ctx: GLContext;
  /** Recycled render targets for the effect chain. */
  private fbos: FboPool;
  /**
   * Where every decoded frame is uploaded. Deliberately NOT an FBO attachment: texImage2D's
   * DOM-source overload re-specifies the texture at the frame's natural size, so uploading into
   * a pooled buffer would silently resize that FBO's attachment away from the render size — and
   * any second effect pass would then draw into a mis-sized target under the old viewport,
   * writing one corner and leaving stale pixels around it.
   */
  private source: WebGLTexture;
  private width = 0;
  private height = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sources: FrameSourcePool,
  ) {
    this.ctx = new GLContext(canvas);
    this.fbos = new FboPool(this.ctx);
    this.source = this.ctx.createTexture();
    this.resize(canvas.width || 1920, canvas.height || 1080);
  }

  /** Resize the render targets to the sequence resolution. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    // Buffers at the old size can never be handed out again (acquire matches on exact size).
    this.fbos.evictOtherSizes(width, height);
  }

  /** Render one composited frame to the canvas. */
  render(ctx: RenderContext): void {
    const { sequence } = ctx;
    if (sequence.width !== this.width || sequence.height !== this.height) {
      this.resize(sequence.width, sequence.height);
    }

    // Clear to the sequence background, then composite tracks top-over-bottom.
    this.ctx.bindTarget(null, this.width, this.height);
    const [br, bg, bb] = hexToRgb(sequence.background);
    this.ctx.clear(br, bg, bb, 1);
    this.ctx.enableSourceOver();

    // videoTracksTopDown returns top-first; reverse so we paint bottom → top.
    const tracks = videoTracksTopDown(sequence).reverse();
    let active = 0;
    for (const track of tracks) {
      if (track.hidden) continue;
      const clip = track.clips.find(
        (c) => c.enabled && ctx.time >= c.start && ctx.time < c.start + c.duration,
      );
      if (!clip) continue;
      active++;
      this.renderClip(ctx, clip);
    }
    dthrottle('render', 400, 'render', () => [
      'render()',
      {
        time: ctx.time,
        canvas: `${this.canvas.width}x${this.canvas.height}`,
        videoTracks: tracks.length,
        activeClips: active,
        bg: sequence.background,
      },
    ]);
  }

  /** Render a single clip: raw frame → effect chain → composite onto the canvas. */
  private renderClip(ctx: RenderContext, clip: Clip): void {
    const media = clip.mediaId ? ctx.getMedia(clip.mediaId) : undefined;

    // 1. Get the source frame and upload it to the dedicated source texture.
    let uploaded = false;
    if (media && media.kind !== 'audio') {
      const source = this.sources.get(media);
      // Map timeline time → source time honoring trim + speed.
      const localTicks = ctx.time - clip.start;
      const speedRate = clip.speed.reverse ? -clip.speed.rate : clip.speed.rate;
      const sourceTicks = clip.sourceIn + localTicks * speedRate;
      // Run the element at clipSpeed × previewSpeed. sourceTicks (above) is already correct
      // because ctx.time — the playhead — advances at the preview speed; it's only the
      // element's own playbackRate that must be scaled up, or it lags the playhead and the
      // drift-correction seek fires every frame (the black flash on sped-up preview).
      // Reverse/zero rates fall back to per-frame seeking inside sync().
      source.sync(sourceTicks, !!ctx.playing, speedRate * (ctx.speed ?? 1));
      const frame = source.getFrame();
      if (frame) {
        this.ctx.uploadFrame(this.source, frame);
        uploaded = true;
      }
      dthrottle(`clip:${clip.id}`, 400, 'render', () => [
        'renderClip',
        { clip: clip.id, mediaId: clip.mediaId, hasMedia: !!media, gotFrame: !!frame, uploaded },
      ]);
    }
    if (!uploaded) return; // text/shape clips are drawn by the DOM overlay layer for now

    // 2. Run enabled effects as a chain, starting from the source texture.
    const localTicks = (ctx.time - clip.start) as Ticks;
    const chain = runEffectChain(
      this.ctx,
      this.fbos,
      this.source,
      clip.effects,
      this.width,
      this.height,
      toSeconds(localTicks),
      localTicks,
    );

    // 3. Composite the processed texture to the canvas with the clip transform + opacity.
    this.composite(ctx.sequence, clip, chain.tex, localTicks, media);
    if (chain.owned) this.fbos.release(chain.owned);
  }

  private composite(
    sequence: Sequence,
    clip: Clip,
    tex: WebGLTexture,
    localTicks: Ticks,
    media?: MediaAsset,
  ): void {
    const prog = this.ctx.getProgram('__composite', VERTEX_SHADER, COMPOSITE_FRAGMENT);
    this.ctx.bindTarget(null, this.width, this.height);
    this.ctx.enableSourceOver();
    this.ctx.useProgram(prog);

    const opacity = sample(clip.transform.opacity, localTicks);
    this.ctx.setUniform1f(prog, 'u_opacity', opacity);
    this.ctx.setUniformMat3(prog, 'u_model', this.buildModelMatrix(sequence, clip, localTicks, media));
    this.ctx.bindTexture(prog, 'u_texture', tex, 0);
    this.ctx.drawQuad();
  }

  /** Column-major 3x3 model matrix in clip space (-1..1). */
  private buildModelMatrix(
    sequence: Sequence,
    clip: Clip,
    localTicks: Ticks,
    media?: MediaAsset,
  ): Float32Array {
    const t = clip.transform;
    const sx = sample(t.scaleX, localTicks);
    const sy = sample(t.scaleY, localTicks);
    const rot = (sample(t.rotation, localTicks) * Math.PI) / 180;
    const tx = sample(t.x, localTicks);
    const ty = sample(t.y, localTicks);

    // Aspect-fit the media inside the frame so it isn't stretched (default "fit").
    let fitX = 1;
    let fitY = 1;
    if (media && media.width && media.height) {
      const seqAspect = sequence.width / sequence.height;
      const mediaAspect = media.width / media.height;
      if (mediaAspect > seqAspect) fitY = seqAspect / mediaAspect;
      else fitX = mediaAspect / seqAspect;
    }

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const scaleX = sx * fitX;
    const scaleY = sy * fitY;
    // Translate in clip space: sequence px → clip units (2 / dimension).
    const ndcX = (tx / sequence.width) * 2;
    const ndcY = -(ty / sequence.height) * 2;

    // M = T * R * S, column-major.
    return new Float32Array([
      cos * scaleX, sin * scaleX, 0,
      -sin * scaleY, cos * scaleY, 0,
      ndcX, ndcY, 1,
    ]);
  }

  /** Read the current canvas pixels — the export path uses this per frame. */
  readPixels(): Uint8Array {
    this.ctx.bindTarget(null, this.width, this.height);
    return this.ctx.readPixels(this.width, this.height);
  }

  dispose(): void {
    this.fbos.dispose();
    this.ctx.deleteTexture(this.source);
    this.ctx.dispose();
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
