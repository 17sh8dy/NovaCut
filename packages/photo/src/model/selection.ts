/**
 * Selections.
 *
 * A selection is a stack of GEOMETRIC regions combined with boolean operators, plus three
 * post-modifiers (feather, expand, invert). It holds no pixels, which is the whole design, and
 * it is worth being explicit about why — because the obvious alternative is a mask bitmap and
 * that alternative is what makes selections un-undoable in most implementations.
 *
 * ## Why geometry, and what the Magic Wand does about it
 *
 * A mask bitmap cannot live in the document: History snapshots the document whole, and a 4K
 * mask per undo step is exactly the "ruinous" case `types.ts` warns about. Storing the wand's
 * *parameters* instead (seed point + tolerance) looks like the clean answer, but it is
 * circular: re-deriving the mask means flood-filling the composite, the composite depends on
 * every layer, and a layer's paint can be clipped to the selection. The graph eats itself.
 *
 * So the wand is a **tool, not a region kind**. It flood-fills once, at the moment of the
 * click, and traces the result into polygon contours (`engine/src/photo/trace.ts`). What lands
 * in the document is a `path` region like any other. That makes every selection:
 *
 *   • deterministic — rasterizing it never samples anything,
 *   • serializable — plain numbers,
 *   • undoable for free — it is part of the document, so History already handles it.
 *
 * The cost, stated plainly: a wand selection's tolerance is not re-tunable after the click.
 * Neither is Photoshop's. Re-click with a different tolerance.
 *
 * ## Coordinates
 *
 * Canvas pixels, origin top-left — the same space `geometry.ts` works in and the same space the
 * canvas overlay draws in, so a region can be handed between them with no conversion.
 */

import type { Point } from './geometry.js';

/** How a region combines with everything below it in the stack. */
export type CombineMode = 'replace' | 'add' | 'subtract' | 'intersect';

interface RegionBase {
  combine: CombineMode;
}

export interface RectRegion extends RegionBase {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EllipseRegion extends RegionBase {
  kind: 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One or more closed contours, filled with the EVEN-ODD rule.
 *
 * Even-odd rather than nonzero because this is what the wand produces: an outer contour with
 * holes punched in it, where the holes come back from the tracer with whatever winding the
 * scan happened to give them. Nonzero would fill the holes in.
 */
export interface PathRegion extends RegionBase {
  kind: 'path';
  contours: Point[][];
}

export type SelectionRegion = RectRegion | EllipseRegion | PathRegion;

export interface Selection {
  /** Applied in order, bottom to top. An empty stack means "nothing selected". */
  regions: SelectionRegion[];
  /** Blur radius in px applied to the finished mask, softening its edge. */
  feather: number;
  /** Positive grows the selection, negative shrinks it. In pixels. */
  expand: number;
  /** Flip the whole thing. Applied last, after feather and expand. */
  inverted: boolean;
}

export const EMPTY_SELECTION: Readonly<Selection> = Object.freeze({
  regions: [],
  feather: 0,
  expand: 0,
  inverted: false,
});

/**
 * Is anything actually selected?
 *
 * An inverted empty selection is the whole canvas, not nothing — which is exactly what
 * Select All → Invert → Invert has to round-trip to, and the reason this is a function rather
 * than a `regions.length` check at every call site.
 */
export const hasSelection = (selection: Selection | null | undefined): boolean =>
  !!selection && (selection.regions.length > 0 || selection.inverted);

/** True when the selection covers everything — nothing to clip, so callers can skip the mask. */
export const isEverythingSelected = (selection: Selection | null | undefined): boolean =>
  !selection || (selection.regions.length === 0 && selection.inverted);

// ─────────────────────────────────────────────────────────────────────────────
// Building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push a region onto a selection.
 *
 * `replace` clears the stack rather than appending, which is what keeps a selection from
 * growing without bound as the user re-drags a marquee twenty times. The other three modes are
 * genuinely cumulative and have to be kept.
 */
export function combineRegion(selection: Selection, region: SelectionRegion): Selection {
  if (region.combine === 'replace') {
    return { ...selection, regions: [region], inverted: false };
  }
  return { ...selection, regions: [...selection.regions, region] };
}

export const rectRegion = (
  x: number,
  y: number,
  width: number,
  height: number,
  combine: CombineMode = 'replace',
): RectRegion => ({ kind: 'rect', combine, x, y, width, height });

export const ellipseRegion = (
  x: number,
  y: number,
  width: number,
  height: number,
  combine: CombineMode = 'replace',
): EllipseRegion => ({ kind: 'ellipse', combine, x, y, width, height });

export const pathRegion = (
  contours: Point[][],
  combine: CombineMode = 'replace',
): PathRegion => ({ kind: 'path', combine, contours });

/**
 * The modifier keys → combine mode, resolved in one place.
 *
 * Shift adds, Alt subtracts, both intersect. Every editor agrees on this and every editor
 * re-implements it per tool; doing it once means the marquee, the lasso and the wand can never
 * drift apart.
 */
export const combineFromModifiers = (shift: boolean, alt: boolean): CombineMode =>
  shift && alt ? 'intersect' : shift ? 'add' : alt ? 'subtract' : 'replace';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The axis-aligned box the selection could possibly cover, or null when it covers everything.
 *
 * Deliberately conservative: subtract regions are ignored (removing area can only shrink the
 * result, never grow it) and feather/expand pad the box outward. Callers use this to avoid
 * rasterizing a full-canvas mask for a 40px marquee, so over-estimating costs a little work
 * and under-estimating would clip the user's selection — only one of those is acceptable.
 */
export function selectionBounds(
  selection: Selection,
  canvas: { width: number; height: number },
): SelectionBounds | null {
  if (selection.inverted || selection.regions.length === 0) {
    return selection.inverted ? null : { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const hit = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const region of selection.regions) {
    if (region.combine === 'subtract') continue;
    if (region.kind === 'path') {
      for (const contour of region.contours) for (const p of contour) hit(p.x, p.y);
    } else {
      hit(region.x, region.y);
      hit(region.x + region.width, region.y + region.height);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  const pad = Math.ceil(Math.abs(selection.expand) + selection.feather * 2) + 2;
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  return {
    x,
    y,
    width: Math.min(canvas.width, Math.ceil(maxX + pad)) - x,
    height: Math.min(canvas.height, Math.ceil(maxY + pad)) - y,
  };
}

/**
 * A stable string over everything that changes the rasterized mask.
 *
 * The rasterizer caches on this. It is a plain `JSON.stringify` because every field of a
 * Selection affects the pixels — unlike a layer, there is nothing here to leave out.
 */
export const selectionSignature = (selection: Selection | null): string =>
  selection ? JSON.stringify(selection) : '';
