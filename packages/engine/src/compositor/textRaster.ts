/**
 * Text rasterization for the video compositor — a `TextStyle` becomes pixels the GPU can composite.
 *
 * ## Why this file had to exist
 *
 * Until now `renderClip` bailed out on text with `if (!uploaded) return; // text/shape clips are
 * drawn by the DOM overlay layer for now`, and the preview painted text as absolutely-positioned
 * `<div>`s on top of the canvas. That works on screen and **is invisible to the export**: the
 * offline exporter's only output is `Compositor.readPixels()`, which reads the WebGL canvas and
 * knows nothing about DOM siblings. Every title, caption and lower third a user added was
 * silently dropped from the rendered file. It also broke the promise in OfflineExporter's own
 * header — "reuses the exact same Compositor as the live preview, guaranteeing the export matches
 * what the user sees" — for the one clip kind where the two renderers disagreed.
 *
 * Rasterizing here puts text on the same path as video: upload → effect chain → composite. So a
 * blur on a title now works, text sits correctly under a transition, and what exports is what the
 * preview showed because it is literally the same texture.
 *
 * ## Why a 2D canvas and not a shader
 *
 * The same reason the photo editor's `vectorRaster.ts` chose one, and its header is worth
 * repeating: text shaping is not a shader problem. Kerning, ligatures, fallback chains, colour
 * emoji and the platform's hinting mean shipping a font stack; the browser already has one and
 * `fillText` is its front door. The cost is one texture upload per *distinct style*, not per
 * frame — see the cache below.
 *
 * ## The bleed rule
 *
 * The bitmap is the text box PLUS symmetric room for whatever spills outside it (stroke, shadow
 * offset and blur, glow radius). Symmetric is load-bearing: the compositor places this bitmap by
 * its CENTRE, so padding equally on all sides means switching a shadow on grows the bitmap
 * without moving the letters. Asymmetric padding would make text visibly jump the moment a
 * decoration was toggled.
 */

import type { TextStyle } from '@opencut/core';

export interface TextRaster {
  canvas: HTMLCanvasElement;
  /** Size in SEQUENCE pixels — the compositor scales its quad to exactly this. */
  width: number;
  height: number;
}

/**
 * Hard ceiling on either dimension. A user can type font size 4000 with a 500px glow; without a
 * cap the allocation gets big enough to lose the GL context, which takes the editor with it.
 * Clipped decoration is a far better failure than a black canvas.
 */
const MAX_RASTER = 4096;

/**
 * Rasters are cached by a signature of everything that affects pixels.
 *
 * Without this, scrubbing re-rasterizes identical text on every frame — a 150px Impact string
 * with a glow is milliseconds of `fillText` per frame, per clip. The cache is small because the
 * working set is: the handful of text clips visible around the playhead.
 */
const CACHE_LIMIT = 64;
const cache = new Map<string, TextRaster>();

/**
 * Everything that changes the bitmap, and nothing that does not (position/opacity are transform).
 *
 * `shown` — the character count a typewriter is currently up to — is part of the key because
 * each prefix is a different bitmap. It is keyed on the integer COUNT rather than on the raw
 * reveal fraction, so the sixty frames that all show the same twelve characters share one entry
 * instead of minting sixty identical bitmaps.
 */
function signature(style: TextStyle, shown: number): string {
  const s = style;
  return JSON.stringify([
    s.content, s.fontFamily, s.fontSize, s.fontWeight, s.italic, s.underline,
    s.align, s.letterSpacing, s.lineHeight, s.color,
    s.gradient, s.stroke, s.shadow, s.glow, s.background,
    shown,
  ]);
}

/** Shared measuring context — `measureText` never touches a bitmap, so one is enough. */
let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    measureCtx = c.getContext('2d')!;
  }
  return measureCtx;
}

const cssFont = (s: TextStyle): string =>
  `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;

/**
 * Rasterize, or return the cached bitmap for this exact style.
 *
 * Returns null when there is nothing to draw, which the compositor treats as "no texture" — the
 * same branch an undecoded video frame takes.
 */
export function rasterizeText(style: TextStyle, reveal = 1): TextRaster | null {
  // Character-accurate, and rounded UP so the first frame of a typewriter already shows one
  // letter: starting from an empty bitmap makes the animation look like it begins late.
  const total = String(style.content ?? '').split('\n').join('').length;
  const shown = reveal >= 1 ? total : Math.min(total, Math.ceil(reveal * total));
  if (shown <= 0) return null;

  const key = signature(style, shown);
  const hit = cache.get(key);
  if (hit) return hit;

  const raster = build(style, shown);
  if (!raster) return null;

  // Cheap LRU: oldest insertion out first. Map preserves insertion order.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, raster);
  return raster;
}

/**
 * Drop cached rasters. Called when fonts finish loading: a string measured before its face
 * arrived was measured against the fallback, so every bitmap taken until then is stale.
 */
export function clearTextRasterCache(): void {
  cache.clear();
}

// A late-arriving font changes metrics for text already rasterized. Fonts resolve once, early,
// so this fires a handful of times per session at most.
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener('loadingdone', () => clearTextRasterCache());
}

/**
 * `shown` is a count of characters across ALL lines. Layout always uses the full string and
 * only the painting is truncated — see the note on `drawLines` below.
 */
function build(style: TextStyle, shown: number): TextRaster | null {
  const lines = String(style.content ?? '').split('\n');
  if (lines.length === 0 || lines.every((l) => l.length === 0)) return null;

  const m = measurer();
  m.font = cssFont(style);
  // Chromium supports canvas letterSpacing; it must be set BEFORE measuring or the measured
  // width and the drawn width disagree and the last glyph clips.
  m.letterSpacing = `${style.letterSpacing || 0}px`;

  const widths = lines.map((l) => m.measureText(l).width);
  const textW = Math.max(1, ...widths);
  const lineH = style.fontSize * (style.lineHeight || 1.2);
  const textH = Math.max(1, lines.length * lineH);

  const pad = style.background?.padding ?? 0;
  const boxW = textW + pad * 2;
  const boxH = textH + pad * 2;

  // Symmetric bleed: the largest distance anything reaches beyond the box on ANY side.
  const strokeReach = style.stroke ? style.stroke.width : 0;
  const shadowReach = style.shadow
    ? style.shadow.blur + Math.max(Math.abs(style.shadow.x), Math.abs(style.shadow.y))
    : 0;
  const glowReach = style.glow ? style.glow.radius * 1.5 : 0;
  // +2 so antialiasing at the very edge is never shaved off.
  const bleed = Math.ceil(Math.max(strokeReach, shadowReach, glowReach) + 2);

  const width = Math.min(MAX_RASTER, Math.ceil(boxW + bleed * 2));
  const height = Math.min(MAX_RASTER, Math.ceil(boxH + bleed * 2));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.font = cssFont(style);
  ctx.letterSpacing = `${style.letterSpacing || 0}px`;
  ctx.textBaseline = 'middle';
  /*
   * Alignment is resolved into an explicit left edge per line, and the context is left on
   * 'left'.
   *
   * Letting the canvas centre each line for us would be equivalent for static text and WRONG
   * for a reveal: a half-typed line is narrower than the finished one, so the canvas would
   * centre the prefix and every character already on screen would slide leftward as the next
   * one appeared. Measuring the FULL line and painting the prefix at that line's real left edge
   * pins each glyph to the position it will still occupy when the line is complete.
   */
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const align = style.align === 'justify' ? 'left' : style.align;
  const boxLeft = bleed;
  const lineLeft = (i: number): number => {
    const w = widths[i]!;
    if (align === 'center') return boxLeft + boxW / 2 - w / 2;
    if (align === 'right') return boxLeft + boxW - pad - w;
    return boxLeft + pad;
  };

  if (style.background) {
    ctx.save();
    ctx.fillStyle = style.background.color;
    // A radius over half the short side is a pill, which is exactly how `999` is meant to read.
    const r = Math.min(style.background.radius, Math.min(boxW, boxH) / 2);
    roundRect(ctx, boxLeft, bleed, boxW, boxH, r);
    ctx.fill();
    ctx.restore();
  }

  /*
   * Every drawing pass — glow, shadow, stroke, fill — goes through here, so all of them are
   * truncated identically. Truncating only the fill would leave a stroke outlining letters that
   * have not been typed yet.
   */
  const drawLines = (draw: (line: string, x: number, y: number) => void): void => {
    let budget = shown;
    for (let i = 0; i < lines.length; i++) {
      const full = lines[i]!;
      // Newlines are not characters the user watches appear, so they cost nothing from the
      // budget — otherwise a two-line title would visibly pause at the line break.
      const text = budget >= full.length ? full : full.slice(0, Math.max(0, budget));
      budget -= full.length;
      if (text.length === 0) continue;
      // +lineH/2 because the baseline is 'middle': this centres each line in its own slot.
      const y = bleed + pad + i * lineH + lineH / 2;
      draw(text, lineLeft(i), y);
    }
  };

  // 1. Glow, first and underneath. Canvas has no glow primitive — a blurred shadow at zero
  //    offset is one, and repeating it compounds alpha the way a real bloom does. Capped at
  //    three passes: beyond that it is just cost.
  if (style.glow && style.glow.radius > 0) {
    ctx.save();
    ctx.shadowColor = style.glow.color;
    ctx.shadowBlur = style.glow.radius;
    ctx.fillStyle = style.glow.color;
    const passes = Math.max(1, Math.min(3, Math.round(style.glow.intensity * 3)));
    for (let p = 0; p < passes; p++) drawLines((l, x, y) => ctx.fillText(l, x, y));
    ctx.restore();
  }

  // 2. Drop shadow, applied to the widest silhouette the glyph will have. If there is a stroke
  //    the shadow must come off the STROKE, not the fill, or it peeks out inside the outline.
  if (style.shadow) {
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur;
    ctx.shadowOffsetX = style.shadow.x;
    ctx.shadowOffsetY = style.shadow.y;
    if (style.stroke && style.stroke.width > 0) {
      ctx.lineWidth = style.stroke.width * 2;
      ctx.strokeStyle = style.stroke.color;
      drawLines((l, x, y) => ctx.strokeText(l, x, y));
    } else {
      ctx.fillStyle = '#000';
      drawLines((l, x, y) => ctx.fillText(l, x, y));
    }
    ctx.restore();
  }

  // 3. Stroke. `strokeText` centres the line on the outline, so half of a 12px stroke would eat
  //    into the letterform. Doubling the width and drawing the fill over it leaves exactly the
  //    requested width OUTSIDE — the same trick the photo rasterizer uses for `align: 'outside'`,
  //    and what makes a thick keyline read as a keyline rather than a bolder font.
  if (style.stroke && style.stroke.width > 0) {
    ctx.save();
    ctx.lineWidth = style.stroke.width * 2;
    ctx.strokeStyle = style.stroke.color;
    drawLines((l, x, y) => ctx.strokeText(l, x, y));
    ctx.restore();
  }

  // 4. Fill, last, on top of its own stroke.
  ctx.save();
  ctx.fillStyle = style.gradient
    ? linearGradient(ctx, style.gradient, boxLeft, bleed, boxW, boxH)
    : style.color;
  drawLines((l, x, y) => ctx.fillText(l, x, y));

  if (style.underline) {
    const thickness = Math.max(1, style.fontSize * 0.06);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = thickness;
    // The rule is drawn under the REVEALED text only, so it types on with the characters
    // instead of sitting there ahead of them announcing how long the line is going to be.
    let budget = shown;
    for (let i = 0; i < lines.length; i++) {
      const full = lines[i]!;
      const text = budget >= full.length ? full : full.slice(0, Math.max(0, budget));
      budget -= full.length;
      if (text.length === 0) continue;
      const w = text.length === full.length ? widths[i]! : m.measureText(text).width;
      const y = bleed + pad + i * lineH + lineH / 2 + style.fontSize * 0.34;
      const x0 = lineLeft(i);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
    }
  }
  ctx.restore();

  return { canvas, width, height };
}

/**
 * A linear gradient across the text box at `angle` degrees (0 = left→right, 90 = top→bottom),
 * matching how the same field reads in the photo editor.
 */
function linearGradient(
  ctx: CanvasRenderingContext2D,
  g: NonNullable<TextStyle['gradient']>,
  x: number,
  y: number,
  w: number,
  h: number,
): CanvasGradient {
  const rad = ((g.angle ?? 90) * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Half-extent along the gradient direction, so the stops span the box corner to corner.
  const half = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2;
  const dx = Math.cos(rad) * half;
  const dy = Math.sin(rad) * half;
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  grad.addColorStop(0, g.from);
  grad.addColorStop(1, g.to);
  return grad;
}

/** `roundRect` with a manual fallback — kept explicit so a clamped radius stays predictable. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
