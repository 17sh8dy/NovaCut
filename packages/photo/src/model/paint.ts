/**
 * Paint: fills, strokes, shadows, glows.
 *
 * The shared vocabulary for anything that is *drawn* rather than sampled from a bitmap — text
 * and shapes today, brush strokes later. It lives here rather than in the renderer because a
 * fill is part of the document: it round-trips through JSON, it is what the inspector edits,
 * and it must mean the same thing to the rasterizer and to the layers panel's thumbnail.
 *
 * Two rules, both inherited from `types.ts`:
 *
 *   • **Only what the rasterizer honors.** Every field below has a live path through
 *     `engine/src/photo/vectorRaster.ts`. Conical gradients, dashed strokes and inner shadows
 *     are absent for exactly that reason; they land with their draw code, not before.
 *
 *   • **Colors are CSS strings, not packed numbers.** These are consumed by a 2D canvas
 *     context, which speaks CSS. (GPU *effects* are a different story — core's effect params
 *     are floats, so an effect's color is packed into one; see `packColor` in core. The two
 *     never meet, so neither has to compromise.)
 */

/** One stop in a gradient. `offset` is 0..1 along the gradient axis. */
export interface GradientStop {
  offset: number;
  /** Any CSS color. Hex with alpha (`#rrggbbaa`) is honored by every 2D canvas. */
  color: string;
}

/**
 * How an area is painted.
 *
 * A discriminated union rather than an optional-gradient-on-a-solid, so the rasterizer's
 * switch stays exhaustive and adding a kind breaks the compile where the drawing happens.
 */
export type Fill =
  | { kind: 'solid'; color: string }
  /** `angle` in degrees, 0 = left→right, growing clockwise (screen convention, +y down). */
  | { kind: 'linear'; angle: number; stops: GradientStop[] }
  /** Centred on the painted box; `radius` is a fraction of half the box diagonal. */
  | { kind: 'radial'; radius: number; stops: GradientStop[] };

/**
 * An outline.
 *
 * `align` matches the design-tool convention rather than the canvas one: a 2D context only
 * strokes centred, so inside/outside are implemented by clipping (`vectorRaster` does the
 * work). Modelling the intent here keeps that a rendering detail.
 */
export interface Stroke {
  width: number;
  color: string;
  align: 'center' | 'inside' | 'outside';
  join: 'miter' | 'round' | 'bevel';
}

/** A cast shadow. `blur` and the offsets are in canvas pixels. */
export interface Shadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
  /** 0..1, multiplied into the shadow color's own alpha. */
  opacity: number;
}

/**
 * An outer glow.
 *
 * Structurally a shadow with no offset, and deliberately kept as its own field anyway: a
 * creator wants "add a glow" to be one toggle, not "add a shadow, then zero its offsets, then
 * pick a bright color". A shape can carry both at once, which is why one field cannot serve.
 */
export interface Glow {
  color: string;
  blur: number;
  /** 0..1 — how strongly the glow is laid down. */
  intensity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const SOLID = (color: string): Fill => ({ kind: 'solid', color });

export const DEFAULT_FILL: Readonly<Fill> = Object.freeze(SOLID('#ffffff'));

export const DEFAULT_STROKE: Readonly<Stroke> = Object.freeze({
  width: 8,
  color: '#000000',
  align: 'outside',
  join: 'round',
});

export const DEFAULT_SHADOW: Readonly<Shadow> = Object.freeze({
  color: '#000000',
  blur: 18,
  offsetX: 0,
  offsetY: 8,
  opacity: 0.55,
});

export const DEFAULT_GLOW: Readonly<Glow> = Object.freeze({
  color: '#6d5efc',
  blur: 26,
  intensity: 0.9,
});

/**
 * The furthest a fill's decorations can bleed past the geometry, in pixels.
 *
 * The rasterizer sizes its bitmap from this. Getting it wrong is not a subtle bug — a
 * shadow or a fat outside stroke simply gets sliced off at the bitmap edge — so the one
 * calculation lives here, next to the fields it reads, instead of inline at the draw site.
 */
export function paintBleed(opts: {
  stroke?: Stroke | null;
  shadow?: Shadow | null;
  glow?: Glow | null;
}): number {
  let bleed = 0;
  if (opts.stroke && opts.stroke.width > 0) {
    // A centred stroke bleeds half its width; an outside stroke, all of it.
    bleed = Math.max(bleed, opts.stroke.align === 'center' ? opts.stroke.width / 2 : opts.stroke.width);
  }
  if (opts.shadow) {
    // Canvas shadows fade out well before `blur` px; 1.5× is the empirical safe envelope.
    const reach = opts.shadow.blur * 1.5;
    bleed = Math.max(bleed, reach + Math.hypot(opts.shadow.offsetX, opts.shadow.offsetY));
  }
  if (opts.glow) bleed = Math.max(bleed, opts.glow.blur * 1.5);
  return Math.ceil(bleed) + 2; // +2 so antialiasing never touches the bitmap's last row
}

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize `#rgb` / `#rrggbb` / `#rrggbbaa` to `#rrggbb`, dropping alpha. Never throws. */
export function normalizeHex(color: string, fallback = '#000000'): string {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!m) return fallback;
  const h = m[1]!;
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  if (h.length >= 6) return `#${h.slice(0, 6)}`.toLowerCase();
  return fallback;
}

/** Apply an alpha multiplier to any hex color, producing `#rrggbbaa`. */
export function withAlpha(color: string, alpha: number): string {
  const hex = normalizeHex(color);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return `${hex}${a.toString(16).padStart(2, '0')}`;
}
