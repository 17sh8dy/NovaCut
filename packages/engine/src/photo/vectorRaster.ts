/**
 * The vector rasterizer — text and shapes → pixels the render graph can composite.
 *
 * This is the pass the photo model's "text / shape layers need their own rasterization" note
 * was waiting for. It is deliberately a **2D canvas** rasterizer rather than a GPU one, and
 * that is the central decision here, so it is worth being explicit about:
 *
 *   Text shaping is not a shader problem. Getting glyph outlines, kerning pairs, ligatures,
 *   colour emoji and the platform's own hinting right means shipping a font stack. The browser
 *   already has one — the same one the OS uses — and `fillText` is its front door. Rendering
 *   there and uploading the result costs one texture upload per *edit*, not per frame (see the
 *   cache), which is nothing next to being wrong about what a font looks like.
 *
 * ## What the graph gets back
 *
 * A bitmap sized to the layer's geometry PLUS its bleed (stroke, shadow, glow), centred on the
 * geometry's centre. The centring is load-bearing: the render graph places the bitmap by its
 * centre, so symmetric padding means enabling a shadow grows the bitmap without moving the
 * artwork. Asymmetric padding would make the layer visibly jump the moment a shadow came on.
 *
 * ## Two shapes of drawable
 *
 * Shapes have a path; text does not, and no 2D context exposes glyph outlines. So instead of
 * pretending both are paths, both are expressed as a `Drawable` — an object that knows how to
 * fill, stroke and (where it can) clip itself. Everything downstream works in those terms, so
 * the decoration pipeline is written once and neither kind has to fake being the other.
 */

import {
  cssFont,
  displayText,
  isOpenShape,
  isShapeLayer,
  isTextLayer,
  paintBleed,
  pathBounds,
  shapePath,
  withAlpha,
  type Fill,
  type Glow,
  type Layer,
  type PathCmd,
  type Shadow,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
  type TextStyle,
} from '@opencut/photo';

/** A rasterized layer: the bitmap plus the size the graph should place it at. */
export interface VectorRaster {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * A hard ceiling on either bitmap dimension.
 *
 * A user can type a font size of 4000 on a 4K canvas, or a 500px glow. Without a cap the
 * allocation gets large enough to lose the GL context, which takes the whole editor with it.
 * A clipped glow is a far better failure than a black canvas.
 */
const MAX_RASTER = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// Measuring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A scratch context used only for measurement.
 *
 * Shared and never drawn into: `measureText` does not touch the bitmap, and allocating a canvas
 * per measurement is the kind of thing that quietly costs hundreds of allocations per keystroke
 * once the inspector measures on every render.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function scratch(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    measureCtx = c.getContext('2d')!;
  }
  return measureCtx;
}

export interface TextLayout {
  lines: string[];
  /** Advance width of each line, letter spacing included. */
  lineWidths: number[];
  blockWidth: number;
  blockHeight: number;
  lineHeight: number;
}

/**
 * Break `content` into drawn lines and measure them.
 *
 * Explicit newlines always break. A `boxWidth` additionally word-wraps; without one the block
 * is as wide as its longest line, which is what "the box follows the words" means for a
 * headline. A single word longer than the box is NOT split mid-word — overflowing reads as a
 * layout the user can fix, while a word sliced in half reads as a bug.
 */
export function layoutText(layer: TextLayer): TextLayout {
  const style = layer.style;
  const ctx = scratch();
  ctx.font = cssFont(style);
  const text = displayText(layer.content, style.transform);
  const measure = (s: string) => measureLine(ctx, s, style.letterSpacing);

  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (layer.boxWidth === null || para === '') {
      lines.push(para);
      continue;
    }
    let current = '';
    for (const token of para.split(/(\s+)/)) {
      if (token === '') continue;
      const candidate = current + token;
      if (current !== '' && token.trim() !== '' && measure(candidate) > layer.boxWidth) {
        lines.push(current.trimEnd());
        current = token;
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }

  const lineWidths = lines.map(measure);
  const lineHeight = style.fontSize * style.lineHeight;
  return {
    lines,
    lineWidths,
    blockWidth: Math.max(1, layer.boxWidth ?? Math.max(1, ...lineWidths)),
    blockHeight: Math.max(lineHeight, lines.length * lineHeight),
    lineHeight,
  };
}

/**
 * Line width with letter spacing folded in.
 *
 * `letterSpacing` on a 2D context is not honored everywhere, and where it is not, the measured
 * width and the drawn width disagree — which centres text off-centre by exactly the accumulated
 * spacing. Measuring the way this file *draws* (glyph by glyph, adding the gap) keeps the two
 * definitions identical by construction rather than by luck.
 */
function measureLine(ctx: CanvasRenderingContext2D, line: string, letterSpacing: number): number {
  if (letterSpacing === 0) return ctx.measureText(line).width;
  // `[...line]` splits by code point, keeping emoji and other astral characters whole; indexing
  // by UTF-16 unit would measure two halves of a broken surrogate pair.
  let w = 0;
  for (const g of [...line]) w += ctx.measureText(g).width + letterSpacing;
  return Math.max(0, w - letterSpacing);
}

/**
 * The size the render graph should place a drawn layer at, bleed included.
 *
 * The UI calls this too — the selection box has to match the pixels exactly — which is why it
 * is exported rather than staying a private detail of `rasterizeVector`.
 */
export function vectorNaturalSize(layer: Layer): { width: number; height: number } {
  if (isTextLayer(layer)) {
    const l = layoutText(layer);
    const pad = paintBleed(layer.style);
    return {
      width: Math.min(MAX_RASTER, Math.ceil(l.blockWidth) + pad * 2),
      height: Math.min(MAX_RASTER, Math.ceil(l.blockHeight) + pad * 2),
    };
  }
  if (isShapeLayer(layer)) {
    const geom = shapeGeometry(layer);
    return { width: geom.width, height: geom.height };
  }
  return { width: 0, height: 0 };
}

/**
 * A shape's drawn extent.
 *
 * NOT simply `width × height`: a speech bubble's tail and a heart's lobes overshoot the box on
 * purpose (see `shapes.ts`), and the bleed adds stroke and shadow on top. `originX/Y` is where
 * the box's own origin sits inside the bitmap, which is what the draw code translates by.
 */
interface ShapeGeometry {
  width: number;
  height: number;
  originX: number;
  originY: number;
  path: PathCmd[];
}

function shapeGeometry(layer: ShapeLayer): ShapeGeometry {
  const path = shapePath(layer.shape, layer.width, layer.height, layer.params);
  const bounds = pathBounds(path);
  const pad = paintBleed(layer);
  // The bitmap is centred on the BOX's centre, not the path's. If it were centred on the path,
  // dragging a bubble's tail to the left would slide the body to the right — a layer's position
  // must not depend on its decorations. So each half-extent is measured from the box centre.
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const halfW = Math.max(cx - bounds.x, bounds.x + bounds.w - cx) + pad;
  const halfH = Math.max(cy - bounds.y, bounds.y + bounds.h - cy) + pad;
  return {
    width: Math.min(MAX_RASTER, Math.ceil(halfW * 2)),
    height: Math.min(MAX_RASTER, Math.ceil(halfH * 2)),
    originX: Math.ceil(halfW) - cx,
    originY: Math.ceil(halfH) - cy,
    path,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Something the decoration pipeline can paint.
 *
 * `clip` is optional because text cannot supply one: `fillText` paints, it does not produce a
 * path, and no 2D context exposes glyph outlines. Rather than pretend otherwise, the pipeline
 * checks and degrades an inside-aligned stroke to a centred one for text — a small, visible,
 * explainable difference, instead of an inside stroke that silently renders as an outside one.
 */
interface Drawable {
  fill(ctx: CanvasRenderingContext2D): void;
  stroke(ctx: CanvasRenderingContext2D): void;
  clip?(ctx: CanvasRenderingContext2D): void;
}

function pathDrawable(cmds: readonly PathCmd[], fillable: boolean): Drawable {
  const trace = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    for (const cmd of cmds) {
      switch (cmd.c) {
        case 'M': ctx.moveTo(cmd.x, cmd.y); break;
        case 'L': ctx.lineTo(cmd.x, cmd.y); break;
        case 'C': ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
        case 'Z': ctx.closePath(); break;
      }
    }
  };
  return {
    // An OPEN path must never be filled: `fill()` closes it implicitly, so a two-point line
    // would paint a degenerate sliver in the fill colour, fighting its own stroke.
    fill: (ctx) => { if (fillable) { trace(ctx); ctx.fill(); } },
    stroke: (ctx) => { trace(ctx); ctx.stroke(); },
    clip: (ctx) => { trace(ctx); ctx.clip(); },
  };
}

/**
 * Text as a drawable: each line placed by the layout, then filled or stroked in place.
 *
 * Straight and curved text differ only in where the glyphs go, so both funnel through one
 * `place` walk that hands the painter a transform per glyph run. That keeps stroke and fill
 * guaranteed to land on identical geometry — which they must, or a heavy stroke would drift
 * off its own letters.
 */
function textDrawable(layer: TextLayer, layout: TextLayout): Drawable {
  const style = layer.style;

  const place = (ctx: CanvasRenderingContext2D, paint: (t: string, x: number, y: number) => void) => {
    if (style.curve !== 0 && layout.lines.length === 1) {
      placeCurved(ctx, layout, style, paint);
      return;
    }
    for (const [i, line] of layout.lines.entries()) {
      const y = i * layout.lineHeight + layout.lineHeight / 2;
      const x = alignOffset(layout.lineWidths[i] ?? 0, layout.blockWidth, style.align);
      if (style.letterSpacing === 0) {
        paint(line, x, y);
        continue;
      }
      let cursor = x;
      for (const glyph of [...line]) {
        paint(glyph, cursor, y);
        cursor += ctx.measureText(glyph).width + style.letterSpacing;
      }
    }
  };

  return {
    fill: (ctx) => place(ctx, (t, x, y) => ctx.fillText(t, x, y)),
    stroke: (ctx) => place(ctx, (t, x, y) => ctx.strokeText(t, x, y)),
  };
}

const alignOffset = (lineWidth: number, blockWidth: number, align: TextStyle['align']): number =>
  align === 'center' ? (blockWidth - lineWidth) / 2 : align === 'right' ? blockWidth - lineWidth : 0;

/**
 * Glyphs placed on a circular arc.
 *
 * The radius is derived from the curve amount and the line's own width, so a longer word at the
 * same setting bends over a proportionally larger circle. That keeps the *visual* curvature
 * constant instead of wrapping long text around into a spiral.
 *
 * The arc's midpoint is pinned to where a straight baseline would have been, so turning the
 * curve up from zero bends the text in place rather than translating it off its position.
 */
function placeCurved(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  style: TextStyle,
  paint: (t: string, x: number, y: number) => void,
): void {
  const line = layout.lines[0] ?? '';
  const width = layout.lineWidths[0] ?? 0;
  if (width <= 0) return;

  const curve = Math.max(-100, Math.min(100, style.curve));
  const arcSpan = (Math.abs(curve) / 100) * Math.PI * 1.2; // up to ~216° at the extreme
  if (arcSpan < 1e-4) return;
  const radius = width / arcSpan;
  const up = curve > 0;
  const cx = layout.blockWidth / 2;
  const baselineY = layout.lineHeight / 2;
  // Circle centre: below the text for a rainbow, above it for a valley.
  const cy = up ? baselineY + radius : baselineY - radius;

  let travelled = 0;
  for (const glyph of [...line]) {
    const advance = ctx.measureText(glyph).width + style.letterSpacing;
    const theta = ((travelled + advance / 2) / width - 0.5) * arcSpan;
    const gx = cx + Math.sin(theta) * radius;
    const gy = up ? cy - Math.cos(theta) * radius : cy + Math.cos(theta) * radius;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(up ? theta : -theta);
    paint(glyph, -advance / 2, 0);
    ctx.restore();
    travelled += advance;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rasterizing
// ─────────────────────────────────────────────────────────────────────────────

/** Rasterize a drawn layer, or null when it is neither text nor a shape. */
export function rasterizeVector(layer: Layer): VectorRaster | null {
  if (isTextLayer(layer)) return rasterizeText(layer);
  if (isShapeLayer(layer)) return rasterizeShape(layer);
  return null;
}

function newBitmap(width: number, height: number) {
  const w = Math.max(1, Math.min(MAX_RASTER, Math.ceil(width)));
  const h = Math.max(1, Math.min(MAX_RASTER, Math.ceil(height)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function rasterizeShape(layer: ShapeLayer): VectorRaster | null {
  const geom = shapeGeometry(layer);
  const bmp = newBitmap(geom.width, geom.height);
  if (!bmp) return null;
  const { canvas, ctx } = bmp;

  ctx.save();
  ctx.translate(geom.originX, geom.originY);
  paint(ctx, canvas, pathDrawable(geom.path, !isOpenShape(layer.shape)), {
    fill: isOpenShape(layer.shape) ? null : layer.fill,
    stroke: layer.stroke,
    shadow: layer.shadow,
    glow: layer.glow,
    box: { x: 0, y: 0, width: layer.width, height: layer.height },
  });
  ctx.restore();

  return { canvas, width: canvas.width, height: canvas.height };
}

function rasterizeText(layer: TextLayer): VectorRaster | null {
  const style = layer.style;
  const layout = layoutText(layer);
  const pad = paintBleed(style);
  const bmp = newBitmap(layout.blockWidth + pad * 2, layout.blockHeight + pad * 2);
  if (!bmp) return null;
  const { canvas, ctx } = bmp;

  ctx.font = cssFont(style);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  ctx.save();
  ctx.translate(pad, pad);
  // Skew about the block's vertical centre, so slanting text pivots in place instead of
  // sliding sideways as the angle grows.
  if (style.skew !== 0) {
    const k = Math.tan((Math.max(-45, Math.min(45, style.skew)) * Math.PI) / 180);
    ctx.translate(0, layout.blockHeight / 2);
    ctx.transform(1, 0, -k, 1, 0, 0);
    ctx.translate(0, -layout.blockHeight / 2);
  }

  paint(ctx, canvas, textDrawable(layer, layout), {
    fill: style.fill,
    stroke: style.stroke,
    shadow: style.shadow,
    glow: style.glow,
    box: { x: 0, y: 0, width: layout.blockWidth, height: layout.blockHeight },
  });
  ctx.restore();

  return { canvas, width: canvas.width, height: canvas.height };
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared decoration pipeline
// ─────────────────────────────────────────────────────────────────────────────

interface PaintOpts {
  fill: Fill | null;
  stroke: Stroke | null;
  shadow: Shadow | null;
  glow: Glow | null;
  /** The geometry's box, for anchoring gradients. */
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Paint a drawable with all of its decorations, in the order they stack.
 *
 * Shadow and glow are cast from the SILHOUETTE — fill plus stroke together — not from the fill
 * alone. A shadow cast from just the fill leaves a fat white outline apparently floating with
 * no shadow of its own, which is the single most common way a text shadow looks wrong.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  drawable: Drawable,
  opts: PaintOpts,
): void {
  const { fill, stroke, shadow, glow, box } = opts;
  const strokeWidth = stroke && stroke.width > 0 ? stroke.width : 0;
  // Text has no clip path, so an inside stroke degrades to a centred one. See `Drawable`.
  const align = strokeWidth && stroke!.align === 'inside' && !drawable.clip ? 'center' : stroke?.align;

  const silhouette = () => {
    if (strokeWidth) {
      ctx.lineWidth = align === 'center' ? strokeWidth : strokeWidth * 2;
      ctx.lineJoin = stroke!.join;
      ctx.lineCap = 'round';
      drawable.stroke(ctx);
    }
    if (fill) drawable.fill(ctx);
  };

  if (shadow) cast(ctx, canvas, silhouette, {
    color: withAlpha(shadow.color, shadow.opacity),
    blur: shadow.blur,
    offsetX: shadow.offsetX,
    offsetY: shadow.offsetY,
    passes: 1,
  });
  if (glow) cast(ctx, canvas, silhouette, {
    color: glow.color,
    blur: glow.blur,
    offsetX: 0,
    offsetY: 0,
    // One pass of a wide canvas shadow is far too faint to read as a glow — the blur spreads
    // the same total alpha over a much larger area. Stacking accumulates it, which is also how
    // the intensity control earns its range instead of saturating at 20%.
    passes: 1 + Math.round(Math.max(0, Math.min(1, glow.intensity)) * 3),
  });

  // ── The artwork itself ──
  //
  // Stroke alignment, in the only three ways a 2D context can express it:
  //   outside — stroke at 2× width first, then the fill covers the inner half;
  //   center  — fill first, then a normal stroke straddling the edge;
  //   inside  — fill, then a 2× stroke clipped to the path so only the inner half survives.
  if (strokeWidth && align === 'outside') {
    ctx.lineWidth = strokeWidth * 2;
    ctx.lineJoin = stroke!.join;
    ctx.lineCap = 'round';
    ctx.strokeStyle = stroke!.color;
    drawable.stroke(ctx);
  }

  if (fill) {
    ctx.fillStyle = resolveFill(ctx, fill, box);
    drawable.fill(ctx);
  }

  if (strokeWidth && align !== 'outside') {
    ctx.save();
    if (align === 'inside' && drawable.clip) {
      drawable.clip(ctx);
      ctx.lineWidth = strokeWidth * 2;
    } else {
      ctx.lineWidth = strokeWidth;
    }
    ctx.lineJoin = stroke!.join;
    ctx.lineCap = 'round';
    ctx.strokeStyle = stroke!.color;
    drawable.stroke(ctx);
    ctx.restore();
  }
}

/**
 * Draw a shadow without drawing the thing casting it.
 *
 * The trick: shift the drawing off the bitmap entirely and add the same shift to the shadow's
 * offset, so the shadow lands where it belongs while the source never touches a visible pixel.
 * The alternative — draw, blur, then erase the source — needs a second canvas and a composite
 * pass per layer, per decoration.
 */
function cast(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  silhouette: () => void,
  spec: { color: string; blur: number; offsetX: number; offsetY: number; passes: number },
): void {
  const away = canvas.width + 1000;
  ctx.save();
  ctx.shadowColor = spec.color;
  ctx.shadowBlur = Math.max(0, spec.blur);
  ctx.shadowOffsetX = spec.offsetX + away;
  ctx.shadowOffsetY = spec.offsetY;
  // The source is invisible, so its own colours are irrelevant — but they must be OPAQUE, or
  // the shadow inherits the source's alpha and a transparent fill would cast no shadow at all.
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.translate(-away, 0);
  for (let i = 0; i < spec.passes; i++) silhouette();
  ctx.restore();
}

/** Turn a model `Fill` into something `fillStyle` accepts, anchored to the geometry's box. */
function resolveFill(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  box: { x: number; y: number; width: number; height: number },
): string | CanvasGradient {
  if (fill.kind === 'solid') return fill.color;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  if (fill.kind === 'radial') {
    const r = Math.max(1, (Math.hypot(box.width, box.height) / 2) * Math.max(0.01, fill.radius));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    addStops(g, fill.stops);
    return g;
  }

  // Linear: project the box onto the gradient axis so the ramp spans it exactly at any angle.
  // A naive corner-to-corner gradient compresses or clips as the angle changes.
  const a = (fill.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(box.width * dx) + Math.abs(box.height * dy)) / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  addStops(g, fill.stops);
  return g;
}

/**
 * `addColorStop` throws on an out-of-range offset or an unparseable colour — and a throw here
 * would take down the entire render, over a gradient. Sorting, clamping and skipping bad stops
 * makes any stop list drawable.
 */
function addStops(gradient: CanvasGradient, stops: readonly { offset: number; color: string }[]): void {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  if (sorted.length === 0) {
    gradient.addColorStop(0, 'transparent');
    return;
  }
  for (const s of sorted) {
    try {
      gradient.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
    } catch {
      /* an unparseable colour is skipped; the rest of the ramp still draws */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rasterized bitmaps, keyed by layer and invalidated by a signature of the fields that affect
 * pixels.
 *
 * Rasterizing a 4K headline takes milliseconds, and the graph redraws on every pointermove of
 * an unrelated opacity slider. Keying on a *pixel* signature — not on the layer object — means
 * dragging an unrelated control costs nothing, while dragging a text control re-rasterizes
 * exactly once per frame.
 */
export class VectorRasterCache {
  private entries = new Map<string, { signature: string; raster: VectorRaster }>();

  get(layer: Layer): VectorRaster | null {
    const signature = signatureOf(layer);
    if (signature === null) return null;
    const hit = this.entries.get(layer.id);
    if (hit && hit.signature === signature) return hit.raster;
    const raster = rasterizeVector(layer);
    if (!raster) {
      this.entries.delete(layer.id);
      return null;
    }
    this.entries.set(layer.id, { signature, raster });
    return raster;
  }

  /**
   * Drop entries for layers that no longer exist.
   *
   * Without this a session that adds and deletes a hundred text layers retains a hundred
   * bitmaps — and at 4K that is real memory, held by a Map nobody thinks to look at.
   */
  retain(liveIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!liveIds.has(id)) this.entries.delete(id);
  }

  /** Force everything to re-rasterize — used when a webfont finishes loading. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * A stable string over exactly the fields that change pixels.
 *
 * `JSON.stringify` of the whole layer would also churn on `name`, `opacity` and `blendMode` —
 * all of which the GPU applies AFTER rasterization — so every opacity drag would re-rasterize
 * for nothing. Listing the fields explicitly is the point.
 */
function signatureOf(layer: Layer): string | null {
  if (isTextLayer(layer)) {
    return JSON.stringify(['t', layer.content, layer.boxWidth, layer.style]);
  }
  if (isShapeLayer(layer)) {
    return JSON.stringify([
      's', layer.shape, layer.width, layer.height, layer.params,
      layer.fill, layer.stroke, layer.shadow, layer.glow,
    ]);
  }
  return null;
}
