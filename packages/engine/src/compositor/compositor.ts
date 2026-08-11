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
  getTransitionDef,
  sample,
  toSeconds,
  transitionAtTime,
  videoTracksTopDown,
  type ActiveTransition,
  type Clip,
  type MediaAsset,
  type Sequence,
  type Ticks,
} from '@opencut/core';
import type { FrameSource, FrameSourcePool } from '../media/frameSource.js';
import { COMPOSITE_FRAGMENT, VERTEX_SHADER } from './shaders.js';
import { GLContext, type Fbo } from '../gl/glContext.js';
import { FboPool } from '../gl/fboPool.js';
import { runEffectChain } from '../gl/effectChain.js';
import { getTransitionFragment, TRANSITION_VERTEX_SHADER } from './transitions.js';
import { rasterizeText } from './textRaster.js';
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

  /**
   * Visit whatever contributes to the frame at `ctx.time`, bottom track first.
   *
   * Extracted from render() so that prepare() walks the frame by the SAME rule. The export
   * pipeline calls prepare() one frame ahead of render(); if the two ever disagreed about which
   * clips a frame needs, the render would sample a source nobody waited for — which is exactly
   * the un-awaited-decode bug that once wrote black into half an export.
   */
  private walkFrame(
    ctx: RenderContext,
    onTransition: (crossing: ActiveTransition) => void,
    onClip: (clip: Clip) => void,
  ): number {
    // videoTracksTopDown returns top-first; reverse so we paint bottom → top.
    const tracks = videoTracksTopDown(ctx.sequence).reverse();
    let active = 0;
    for (const track of tracks) {
      if (track.hidden) continue;
      // A transition wins over the plain clip lookup: while the playhead is inside its window
      // BOTH clips are on screen, and each of them is outside its own time range for part of
      // that window — which is precisely why this cannot be expressed as a clip search.
      const crossing = transitionAtTime(track, ctx.time);
      if (crossing) {
        active += 2;
        onTransition(crossing);
        continue;
      }
      const clip = track.clips.find(
        (c) => c.enabled && ctx.time >= c.start && ctx.time < c.start + c.duration,
      );
      if (!clip) continue;
      active++;
      onClip(clip);
    }
    return active;
  }

  /**
   * Point every decoder this frame needs at the source time it needs, and do nothing else.
   *
   * This is the front half of renderClip with the GPU work removed, and it exists for the export
   * pipeline: a seek is answered in tens of milliseconds while the readback and the encode of the
   * PREVIOUS frame cost tens more, and those two waits are independent. Issuing the next frame's
   * seeks before draining the current one overlaps them, which is where most of an export's time
   * was going. It changes no pixels — it only starts the same work sooner.
   */
  prepare(ctx: RenderContext): void {
    this.walkFrame(
      ctx,
      (crossing) => {
        this.prepareClip(ctx, crossing.from);
        this.prepareClip(ctx, crossing.to);
      },
      (clip) => this.prepareClip(ctx, clip),
    );
  }

  private prepareClip(ctx: RenderContext, clip: Clip): void {
    const media = clip.mediaId ? ctx.getMedia(clip.mediaId) : undefined;
    if (!media || media.kind === 'audio') return;
    this.syncClipSource(ctx, clip, media);
  }

  /**
   * Map timeline time → source time for one clip and reconcile its decoder to it.
   *
   * Shared by prepare() and renderClip() so the seek that gets issued and the seek that gets
   * waited for are computed by the same arithmetic. Returns the source so the caller can sample
   * it; prepare() ignores the return.
   */
  private syncClipSource(ctx: RenderContext, clip: Clip, media: MediaAsset): FrameSource {
    const source = this.sources.get(media);
    const localTicks = ctx.time - clip.start;
    const speedRate = clip.speed.reverse ? -clip.speed.rate : clip.speed.rate;
    const sourceTicks = clip.sourceIn + localTicks * speedRate;
    // Run the element at clipSpeed × previewSpeed. sourceTicks (above) is already correct
    // because ctx.time — the playhead — advances at the preview speed; it's only the
    // element's own playbackRate that must be scaled up, or it lags the playhead and the
    // drift-correction seek fires every frame (the black flash on sped-up preview).
    // Reverse/zero rates fall back to per-frame seeking inside sync().
    source.sync(sourceTicks as Ticks, !!ctx.playing, speedRate * (ctx.speed ?? 1));
    return source;
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

    const active = this.walkFrame(
      ctx,
      (crossing) => this.renderTransition(ctx, crossing),
      (clip) => this.renderClip(ctx, clip, null),
    );
    dthrottle('render', 400, 'render', () => [
      'render()',
      {
        time: ctx.time,
        canvas: `${this.canvas.width}x${this.canvas.height}`,
        // Inside the throttled closure: this only runs when a line is actually logged.
        videoTracks: videoTracksTopDown(ctx.sequence).length,
        activeClips: active,
        bg: sequence.background,
      },
    ]);
  }

  /**
   * Render one transition: both clips to their own buffers, then blended by its shader.
   *
   * The two clips have to be rendered OFF-SCREEN rather than painted over each other, because a
   * transition is not a composite — a wipe has to read the incoming clip's colour at a pixel
   * the outgoing clip also covers, and there is no blend mode that expresses that. Two textures
   * in, one out.
   *
   * The result is drawn to the canvas with ordinary source-over, so a transition on an upper
   * track still composites correctly over the tracks beneath it.
   */
  private renderTransition(ctx: RenderContext, crossing: ActiveTransition): void {
    const { transition, from, to, progress } = crossing;
    const def = getTransitionDef(transition.type);

    const fromBuf = this.fbos.acquire(this.width, this.height);
    const toBuf = this.fbos.acquire(this.width, this.height);
    try {
      // Each buffer is cleared to TRANSPARENT, not to the sequence background: these are layers
      // to be blended, and a background baked into them would make every transition composite
      // an opaque rectangle over the tracks below.
      this.ctx.bindTarget(fromBuf, this.width, this.height);
      this.ctx.clear(0, 0, 0, 0);
      this.renderClip(ctx, from, fromBuf);

      this.ctx.bindTarget(toBuf, this.width, this.height);
      this.ctx.clear(0, 0, 0, 0);
      this.renderClip(ctx, to, toBuf);

      const render = def?.render ?? 'cut';
      const prog = this.ctx.getProgram(
        `__transition:${render}`,
        TRANSITION_VERTEX_SHADER,
        getTransitionFragment(render),
      );
      this.ctx.bindTarget(null, this.width, this.height);
      this.ctx.enableSourceOver();
      this.ctx.useProgram(prog);
      // The transition draws a plain fullscreen quad; the clip transforms were already applied
      // when each clip was rendered into its buffer.
      this.ctx.setUniformMat3(prog, 'u_model', IDENTITY_MAT3);
      this.ctx.setUniform1f(prog, 'u_progress', progress);
      this.ctx.setUniform2f(prog, 'u_texel', 1 / this.width, 1 / this.height);
      // Params come from the instance, falling back to the definition's defaults so a
      // transition saved before a param existed still renders with a sane value.
      for (const p of def?.params ?? []) {
        this.ctx.setUniform1f(prog, `u_${p.key}`, transition.params[p.key] ?? p.default);
      }
      this.ctx.bindTexture(prog, 'u_from', fromBuf.tex, 0);
      this.ctx.bindTexture(prog, 'u_to', toBuf.tex, 1);
      this.ctx.drawQuad();
    } finally {
      // Released in a finally: a shader compile error inside the try would otherwise strand
      // both buffers, and every later frame would fail the pool's balance check instead —
      // burying the real error under its own aftermath.
      this.fbos.release(fromBuf);
      this.fbos.release(toBuf);
    }
  }

  /**
   * Render a single clip: raw frame → effect chain → composite onto `target`.
   *
   * `target` is null for the canvas. It exists so a transition can render each of its clips
   * into a buffer; without it the composite step would hard-code the canvas and there would be
   * no way to get a clip's pixels anywhere else.
   */
  private renderClip(ctx: RenderContext, clip: Clip, target: Fbo | null): void {
    const media = clip.mediaId ? ctx.getMedia(clip.mediaId) : undefined;

    // 1. Get the source frame and upload it to the dedicated source texture.
    let uploaded = false;
    /**
     * Set for text: the quad must be the raster's size in sequence pixels, NOT aspect-fitted to
     * the frame the way media is. Fitting would blow a short caption up to fill the height.
     */
    let fit: { x: number; y: number } | undefined;

    if (clip.kind === 'text' && clip.text) {
      const raster = rasterizeText(clip.text);
      if (raster) {
        this.ctx.uploadFrame(this.source, raster.canvas);
        uploaded = true;
        fit = { x: raster.width / ctx.sequence.width, y: raster.height / ctx.sequence.height };
      }
    } else if (media && media.kind !== 'audio') {
      // Same seek arithmetic prepare() uses — see syncClipSource. When the export pipeline has
      // already prepared this frame the sync is a no-op: the element is at the target and
      // seekTo's "already there" guard returns without touching it.
      const source = this.syncClipSource(ctx, clip, media);
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
    // Shape clips still have no rasterizer, and a video frame that has not decoded yet has
    // nothing to show. Both mean "draw nothing this pass" rather than "draw black".
    if (!uploaded) return;

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

    // 3. Composite the processed texture with the clip transform + opacity.
    //
    // Released in a `finally`, for the same reason the transition path above is: an exception in
    // composite — a shader that fails to compile, a context that was lost mid-frame — would
    // otherwise strand this buffer in the pool. The difference is rate. That path runs once per
    // transition; this one runs for every clip of every frame, so a throw here leaks at frame
    // rate until the pool has consumed the GPU.
    try {
      this.composite(ctx.sequence, clip, chain.tex, localTicks, target, media, fit);
    } finally {
      if (chain.owned) this.fbos.release(chain.owned);
    }
  }

  private composite(
    sequence: Sequence,
    clip: Clip,
    tex: WebGLTexture,
    localTicks: Ticks,
    target: Fbo | null,
    media?: MediaAsset,
    fit?: { x: number; y: number },
  ): void {
    const prog = this.ctx.getProgram('__composite', VERTEX_SHADER, COMPOSITE_FRAGMENT);
    this.ctx.bindTarget(target, this.width, this.height);
    this.ctx.enableSourceOver();
    this.ctx.useProgram(prog);

    const opacity = sample(clip.transform.opacity, localTicks);
    this.ctx.setUniform1f(prog, 'u_opacity', opacity);
    this.ctx.setUniformMat3(prog, 'u_model', this.buildModelMatrix(sequence, clip, localTicks, media, fit));
    this.ctx.bindTexture(prog, 'u_texture', tex, 0);
    this.ctx.drawQuad();
  }

  /** Column-major 3x3 model matrix in clip space (-1..1). */
  private buildModelMatrix(
    sequence: Sequence,
    clip: Clip,
    localTicks: Ticks,
    media?: MediaAsset,
    fitOverride?: { x: number; y: number },
  ): Float32Array {
    const t = clip.transform;
    const sx = sample(t.scaleX, localTicks);
    const sy = sample(t.scaleY, localTicks);
    const rot = (sample(t.rotation, localTicks) * Math.PI) / 180;
    const tx = sample(t.x, localTicks);
    const ty = sample(t.y, localTicks);

    // Aspect-fit the media inside the frame so it isn't stretched (default "fit").
    // A caller may override it outright — text passes its raster's own size in frame units,
    // where "fit to the frame" would be exactly the wrong answer.
    let fitX = fitOverride?.x ?? 1;
    let fitY = fitOverride?.y ?? 1;
    if (!fitOverride && media && media.width && media.height) {
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
  readPixels(into?: Uint8Array): Uint8Array {
    this.ctx.bindTarget(null, this.width, this.height);
    return this.ctx.readPixels(this.width, this.height, into);
  }

  /** Queue an async readback of the frame just rendered. See GLContext.beginReadPixels. */
  beginReadPixels(slot: number): void {
    this.ctx.bindTarget(null, this.width, this.height);
    this.ctx.beginReadPixels(this.width, this.height, slot);
  }

  /** Collect a readback queued earlier. */
  endReadPixels(slot: number, into: Uint8Array): Uint8Array {
    return this.ctx.endReadPixels(slot, into);
  }

  dispose(): void {
    this.fbos.dispose();
    this.ctx.deleteTexture(this.source);
    this.ctx.dispose();
  }
}

/** Identity model matrix, for passes that draw a plain fullscreen quad. */
const IDENTITY_MAT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
