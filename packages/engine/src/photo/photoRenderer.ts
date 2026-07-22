/**
 * PhotoRenderer — the photo editor's GPU render graph.
 *
 * Given a PhotoDocument, it draws the composited canvas. It replaces `Compositor.renderStill`,
 * which could only aspect-fit a flat list of layers and apply opacity — enough for the first
 * milestone, and structurally unable to grow a layer tree, because a fixed ping/pong pair
 * cannot render a group whose children are themselves mid-render.
 *
 * ## The pipeline, per layer
 *
 *     source bitmap ─place(model matrix)─→ canvas-sized raster
 *                   ─effect chain────────→ processed raster
 *                   ─blend(mode, opacity)→ new accumulator
 *
 * Everything after `place` happens in canvas space. That is what makes the graph uniform:
 * groups, images and adjustments differ only in how they produce their raster, and from there
 * they all blend identically. It is also why a blur radius means the same thing on a scaled
 * layer as on an unscaled one.
 *
 * ## Non-destructive by construction
 *
 * There is no path in here that writes back to a MediaAsset. The document describes how to
 * composite the originals and this re-derives the result from scratch every draw, so a layer's
 * transform, adjustment params and effect stack stay editable forever. "Rasterize" is a
 * document-level operation that mints a NEW asset; it is not this file's business.
 *
 * ## Buffer discipline
 *
 * Every buffer comes from the FboPool and its contents are undefined on acquire. Two rules keep
 * that safe, and both are load-bearing:
 *   1. Every pass writes its ENTIRE target (fullscreen quad, or clear-then-draw).
 *   2. Whoever acquires, releases. Helpers return an owned Fbo; callers release it.
 * `render()` asserts the pool is balanced afterwards, so a leak fails loudly in dev rather
 * than by exhausting VRAM twenty minutes into a session.
 */

import { getEffectDef, type EffectInstance, type MediaAsset, type MediaId, type Ticks } from '@opencut/core';
import {
  clipMatrix,
  fitModeOf,
  flattenLayers,
  isAdjustmentLayer,
  isGroupLayer,
  isVectorLayer,
  type FitMode,
  type Layer,
  type PhotoDocument,
  type Transform2D,
} from '@opencut/photo';
import { GLContext, type Fbo } from '../gl/glContext.js';
import { FboPool } from '../gl/fboPool.js';
import { runEffectChain } from '../gl/effectChain.js';
import { VERTEX_SHADER } from '../compositor/shaders.js';
import { VectorRasterCache } from './vectorRaster.js';
import { BLEND_FRAGMENT, BLEND_MODE_ID, BLEND_VERTEX, PLACE_FRAGMENT } from './blendShaders.js';
import type { FrameBitmap } from '../media/frameSource.js';
import { dlog, dthrottle } from '../debug.js';

/** A still has no time to sample at; effects read their static param values. */
const STILL_TIME = 0 as Ticks;

export interface PhotoRenderContext {
  doc: PhotoDocument;
  /**
   * The layer's decoded bitmap, or null while it is still decoding.
   *
   * A callback rather than a field because the document stores no pixels (History snapshots it
   * whole). The caller owns decoding and hands the graph the frame it should draw — the same
   * seam `Compositor.StillLayer` used, kept for the same reason.
   */
  getFrame: (mediaId: MediaId) => FrameBitmap | null;
  getMedia: (mediaId: MediaId) => MediaAsset | undefined;
}

export class PhotoRenderer {
  private gl: GLContext;
  private pool: FboPool;
  /** Uploads land here, never in an FBO attachment — see GLContext.uploadFrame. */
  private source: WebGLTexture;
  /**
   * Text and shapes, rasterized on the CPU and cached by pixel signature.
   *
   * Owned by the renderer rather than the caller so its lifetime matches the GL context's:
   * both are torn down together in `dispose`, and neither can outlive the canvas.
   */
  private vectors = new VectorRasterCache();
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new GLContext(canvas);
    this.pool = new FboPool(this.gl);
    this.source = this.gl.createTexture();
  }

  /** Draw the document to the canvas. */
  render(ctx: PhotoRenderContext): void {
    const { doc } = ctx;
    this.resize(doc.width, doc.height);
    // Deleted layers' bitmaps would otherwise be retained for the life of the session.
    this.vectors.retain(new Set(flattenLayers(doc.layers).map((l) => l.id)));

    try {
      // The root accumulator starts as the document background; every layer blends onto it.
      // The background carries ALPHA (`#rrggbbaa`), and defaults to fully transparent — a
      // thumbnail or sticker exported straight to PNG has to keep its transparency, and an
      // opaque clear would silently bake a black frame into every export.
      const acc = this.pool.acquire(this.width, this.height);
      this.gl.bindTarget(acc, this.width, this.height);
      const [r, g, b, a] = hexToRgba(doc.background);
      this.gl.clear(r, g, b, a);

      const composited = this.renderList(ctx, doc.layers, acc);
      this.blitToCanvas(composited);
      this.pool.release(composited);

      if (!this.pool.balanced) {
        // A leak is silent until VRAM runs out, and by then the stack that caused it is long
        // gone. Fail at the frame that leaked.
        throw new Error('PhotoRenderer: FBO pool left unbalanced — a render pass leaked a buffer');
      }
    } finally {
      // Whatever went wrong, hand the buffers back. Without this, a throw part-way through
      // leaves them checked out and EVERY later frame fails the balance check instead — burying
      // the real error under a leak report that is really just its aftermath.
      this.pool.reclaimAll();
    }
    dthrottle('photoRender', 400, 'render', () => [
      'PhotoRenderer.render()',
      { canvas: `${this.width}x${this.height}`, layers: doc.layers.length },
    ]);
  }

  // ── The graph ───────────────────────────────────────────────────────────────

  /**
   * Composite a sibling list bottom-to-top onto `acc`, consuming it and returning the result.
   *
   * Ownership: takes `acc`, returns a buffer the caller must release. It may or may not be the
   * same object — each blend ping-pongs into a fresh buffer, because a pass cannot read and
   * write one FBO.
   */
  private renderList(ctx: PhotoRenderContext, layers: readonly Layer[], acc: Fbo): Fbo {
    let current = acc;
    let i = 0;

    while (i < layers.length) {
      const layer = layers[i]!;

      // A clipped layer with no unclipped layer beneath it in this parent has no base to clip
      // to. Photoshop drops it; so do we, rather than promoting it to a normal layer.
      if (!layer.visible || layer.clipped) {
        i++;
        continue;
      }

      // Gather the run of layers clipped to this one. They composite INTO this layer's unit
      // before the unit blends onto the backdrop — that grouping is what makes a clipping mask
      // adopt its base's blend mode and opacity, rather than each member blending separately.
      let end = i + 1;
      while (end < layers.length && layers[end]!.clipped) end++;
      const run = layers.slice(i + 1, end);

      current = isAdjustmentLayer(layer)
        ? this.applyAdjustmentLayer(layer, current, run)
        : this.compositeUnit(ctx, layer, current, run);

      i = end;
    }
    return current;
  }

  /**
   * Render `layer` (+ anything clipped to it) and blend the result onto the backdrop.
   */
  private compositeUnit(
    ctx: PhotoRenderContext,
    layer: Layer,
    backdrop: Fbo,
    run: readonly Layer[],
  ): Fbo {
    let unit = this.renderContent(ctx, layer);
    if (!unit) return backdrop; // nothing to draw (undecoded image, empty group)

    for (const clipped of run) {
      if (!clipped.visible) continue;
      unit = isAdjustmentLayer(clipped)
        ? // Clipped to `unit`, which is ALSO the backdrop it adjusts — so the clip is already
          // implied and passing a mask here would multiply the base's alpha in a second time
          // (quarter-strength on a half-covered edge).
          this.applyAdjustmentLayer(clipped, unit, [])
        : this.blendClippedOnto(ctx, unit, clipped);
    }

    const out = this.blend(backdrop, unit.tex, layer, null);
    this.pool.release(unit);
    this.pool.release(backdrop);
    return out;
  }

  /** A clipped layer painted into its base's unit, masked by the base's alpha. */
  private blendClippedOnto(ctx: PhotoRenderContext, unit: Fbo, clipped: Layer): Fbo {
    const content = this.renderContent(ctx, clipped);
    if (!content) return unit;
    const out = this.blend(unit, content.tex, clipped, unit.tex);
    this.pool.release(content);
    this.pool.release(unit);
    return out;
  }

  /**
   * An adjustment layer: re-run its effect against the live backdrop, then mix the adjusted
   * copy back over the original by the layer's opacity, using its blend mode.
   *
   * Mixing rather than replacing is what makes opacity mean "strength" — 40% Curves is a 40%
   * mix of the adjusted result — and it costs nothing, since at opacity 1 / Normal the mix is
   * exactly the adjusted copy.
   *
   * It goes through the blend pass in PRESERVE-ALPHA mode, not the ordinary source-over path.
   * The adjusted copy is the backdrop, so compositing it over itself would double its coverage
   * (ao = 2ab - ab²) and under-apply the adjustment on any soft edge. See the shader.
   *
   * `run` is accepted for symmetry with compositeUnit but an adjustment cannot be a clipping
   * base (it has no pixels of its own to clip to), so a run above one is skipped, as in PS.
   */
  private applyAdjustmentLayer(
    layer: Layer,
    backdrop: Fbo,
    _run: readonly Layer[],
    clipMask?: WebGLTexture,
  ): Fbo {
    if (!isAdjustmentLayer(layer)) return backdrop;
    const fx = layer.adjustment;
    // An unregistered effect type must degrade to a no-op, not a crash: documents outlive
    // registries, and a plugin that supplied this type may simply not be loaded.
    if (!fx.enabled || !getEffectDef(fx.type)) return backdrop;

    const chain = this.runEffects(backdrop.tex, [fx]);
    if (!chain.owned) return backdrop; // registry said no — nothing ran

    const out = this.blend(backdrop, chain.tex, layer, clipMask ?? null, true);
    this.pool.release(chain.owned);
    this.pool.release(backdrop);
    return out;
  }

  /**
   * Rasterise a layer's own pixels into a canvas-sized buffer: place through its transform,
   * then run its effect chain. Returns null when there is nothing to draw.
   *
   * Owned by the caller.
   */
  private renderContent(ctx: PhotoRenderContext, layer: Layer): Fbo | null {
    let placed: Fbo | null = null;

    if (isGroupLayer(layer)) {
      if (layer.children.length === 0) return null;
      // Recurse. The group's children composite against a TRANSPARENT backdrop, not the
      // document's — that isolation is the whole difference between a group and loose layers,
      // and it is what lets a group's own opacity cross-fade the flattened result.
      const inner = this.pool.acquire(this.width, this.height);
      this.gl.bindTarget(inner, this.width, this.height);
      this.gl.clear(0, 0, 0, 0);
      const flattened = this.renderList(ctx, layer.children, inner);
      // The flattened group is already canvas-sized, so its "natural size" IS the canvas.
      placed = this.place(flattened.tex, this.width, this.height, layer.transform, 'contain');
      this.pool.release(flattened);
    } else if (isAdjustmentLayer(layer)) {
      return null; // adjustments have no pixels; applyAdjustmentLayer handles them
    } else if (isVectorLayer(layer)) {
      // Text and shapes are drawn on the CPU (see vectorRaster.ts for why) and uploaded like
      // any other bitmap from here on. The raster's size already includes the layer's bleed —
      // stroke, shadow, glow — so placing it EXACTLY, not aspect-fitted, is what makes a
      // shape's `width` in the inspector the width it actually occupies.
      const raster = this.vectors.get(layer);
      if (!raster) return null;
      this.gl.uploadFrame(this.source, raster.canvas);
      placed = this.place(this.source, raster.width, raster.height, layer.transform, 'exact');
    } else {
      if (!layer.mediaId) return null;
      const media = ctx.getMedia(layer.mediaId);
      const frame = ctx.getFrame(layer.mediaId);
      // Still decoding. Skipping beats drawing blank: the caller's onFrameReady brings us back.
      if (!media || !frame) return null;
      this.gl.uploadFrame(this.source, frame);
      placed = this.place(this.source, media.width, media.height, layer.transform, fitModeOf(layer));
    }

    if (!placed) return null;

    const chain = this.runEffects(placed.tex, layer.effects);
    if (chain.owned) {
      this.pool.release(placed);
      return chain.owned;
    }
    return placed;
  }

  private runEffects(input: WebGLTexture, effects: readonly EffectInstance[]) {
    return runEffectChain(
      this.gl,
      this.pool,
      input,
      effects,
      this.width,
      this.height,
      0,
      STILL_TIME,
    );
  }

  // ── Passes ──────────────────────────────────────────────────────────────────

  /**
   * Draw `tex` (natural size srcW×srcH) into a canvas-sized buffer through `transform`.
   * The buffer is cleared to transparent first, so the region the quad misses is empty rather
   * than whatever the pool handed us.
   */
  private place(
    tex: WebGLTexture,
    srcW: number,
    srcH: number,
    transform: Transform2D,
    fit: FitMode,
  ): Fbo {
    const out = this.pool.acquire(this.width, this.height);
    this.gl.bindTarget(out, this.width, this.height);
    this.gl.clear(0, 0, 0, 0);
    this.gl.disableBlend();

    const prog = this.gl.getProgram('__photoPlace', VERTEX_SHADER, PLACE_FRAGMENT);
    this.gl.useProgram(prog);
    this.gl.setUniformMat3(
      prog,
      'u_model',
      clipMatrix(transform, { width: srcW, height: srcH }, { width: this.width, height: this.height }, fit),
    );
    this.gl.bindTexture(prog, 'u_texture', tex, 0);
    this.gl.drawQuad();
    return out;
  }

  /**
   * Blend `srcTex` onto `backdrop` using the layer's mode and opacity. Fullscreen; writes every
   * texel of a fresh buffer, which the caller owns. `backdrop` is NOT released here — callers
   * differ on whether they still need it.
   */
  private blend(
    backdrop: Fbo,
    srcTex: WebGLTexture,
    layer: Layer,
    clipMask: WebGLTexture | null,
    /** Adjustment layers: keep the backdrop's alpha, mix colour only. See the shader. */
    preserveAlpha = false,
  ): Fbo {
    const out = this.pool.acquire(this.width, this.height);
    this.gl.bindTarget(out, this.width, this.height);
    this.gl.disableBlend();

    const prog = this.gl.getProgram('__photoBlend', BLEND_VERTEX, BLEND_FRAGMENT);
    this.gl.useProgram(prog);
    this.gl.setUniform1i(prog, 'u_mode', BLEND_MODE_ID[layer.blendMode] ?? 0);
    this.gl.setUniform1f(prog, 'u_opacity', clamp01(layer.opacity));
    this.gl.setUniform1i(prog, 'u_useClipMask', clipMask ? 1 : 0);
    this.gl.setUniform1i(prog, 'u_preserveAlpha', preserveAlpha ? 1 : 0);
    // Stable per-layer seed so two Dissolve layers don't punch identical holes, while a given
    // layer's noise stays put across redraws.
    this.gl.setUniform1f(prog, 'u_seed', seedOf(layer.id));
    this.gl.bindTexture(prog, 'u_src', srcTex, 0);
    this.gl.bindTexture(prog, 'u_backdrop', backdrop.tex, 1);
    // Samplers must be bound even when unused: an unbound sampler2D reads unit 0 by default,
    // which is u_src — harmless here, but only by accident.
    this.gl.bindTexture(prog, 'u_clipMask', clipMask ?? backdrop.tex, 2);
    this.gl.drawQuad();
    return out;
  }

  /** Final blit of the composited result to the visible canvas. */
  private blitToCanvas(src: Fbo): void {
    this.gl.bindTarget(null, this.width, this.height);
    this.gl.disableBlend();
    const prog = this.gl.getProgram('__photoBlit', BLEND_VERTEX, PLACE_FRAGMENT);
    this.gl.useProgram(prog);
    this.gl.bindTexture(prog, 'u_texture', src.tex, 0);
    this.gl.drawQuad();
  }

  // ── Geometry ────────────────────────────────────────────────────────────────
  //
  // There used to be a `modelMatrix` here that composed the clip-space transform by hand. It is
  // gone, and where it went matters: `@opencut/photo`'s `clipMatrix` now owns it, because the
  // UI needs the SAME placement to draw the selection box and hit-test drags. Two independent
  // derivations of "where does this layer land" is a bug generator — handles that float a few
  // pixels off the artwork, a drag that accelerates away from the cursor — with no single place
  // to fix it.
  //
  // The shared version also works in canvas PIXELS and converts to clip space at the end, which
  // makes the old hand-composed version's trickiest correction unnecessary: clip space is -1..1
  // on both axes, so one unit is W/2 px across but H/2 px down, and rotating there shears
  // instead of turning. That needed an explicit un-squash/rotate/re-squash sandwich. Working in
  // pixels first makes the error unrepresentable rather than corrected.

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    dlog('gl', 'PhotoRenderer resize', { from: `${this.width}x${this.height}`, to: `${width}x${height}` });
    this.width = width;
    this.height = height;
    this.gl.canvas.width = width;
    this.gl.canvas.height = height;
    // Old-size buffers would otherwise sit in the pool forever; acquire() matches on exact size
    // so they could never be handed out again either.
    this.pool.evictOtherSizes(width, height);
  }

  /**
   * Drop every cached vector bitmap, forcing text and shapes to re-rasterize.
   *
   * The one thing the pixel-signature cache cannot see: a font that finishes loading changes
   * what a layer looks like without changing a single field of it. The UI calls this from
   * `document.fonts`, which is the only signal that happened.
   */
  invalidateVectors(): void {
    this.vectors.clear();
  }

  dispose(): void {
    this.vectors.clear();
    this.pool.dispose();
    this.gl.deleteTexture(this.source);
    this.gl.dispose();
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Cheap stable string hash → 0..1000, for decorrelating per-layer noise. */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return Math.abs(h % 1000);
}

/**
 * `#rgb` / `#rrggbb` / `#rrggbbaa` → normalized RGBA.
 *
 * Alpha defaults to 1 so every pre-existing document (which stored six digits) still clears to
 * an opaque background exactly as before; only the new eight-digit form can be transparent.
 */
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 || h.length === 4 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v.slice(0, 6), 16);
  const a = v.length >= 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1;
  if (!Number.isFinite(n)) return [0, 0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}
