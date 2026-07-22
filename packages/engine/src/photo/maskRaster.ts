/**
 * Selections and layer masks → coverage bitmaps.
 *
 * Both are geometry plus painted ops resolved to per-pixel coverage, so both are thin wrappers
 * over `coverage.ts`. What lives here is the part that is specific to each: a selection's
 * "everything is selected" shortcut, and a mask's base coverage and inversion.
 *
 * Nothing is stored. A selection is regions + feather + expand + invert; a mask is a base + regions
 * + brush ops. Neither holds a pixel, which is what lets both ride History — see the header of
 * `@opencut/photo`'s `selection.ts` for the full argument.
 */

import {
  hasSelection,
  isEverythingSelected,
  type LayerMask,
  type Selection,
} from '@opencut/photo';
import { invertCoverage, newCoverage, paintRegions, rasterizeCoverage, type CoverageCanvas, type Size } from './coverage.js';
import { replayPaintOps } from './paintRaster.js';

/**
 * Rasterize a selection, or null when everything is selected.
 *
 * Null is a real answer, not a failure: "everything" means there is nothing to clip against,
 * and callers skip the masking pass rather than multiplying by an all-white canvas-sized bitmap
 * every frame.
 */
export function rasterizeSelection(selection: Selection | null, size: Size): CoverageCanvas | null {
  if (isEverythingSelected(selection)) return null;
  if (!hasSelection(selection)) {
    // Nothing selected. An empty coverage is the honest answer for callers that ask anyway;
    // callers that treat "no selection" as "unclipped" check `hasSelection` first.
    const empty = newCoverage(size);
    return empty ? empty.canvas : null;
  }
  const sel = selection!;
  return rasterizeCoverage(sel.regions, sel.feather, sel.expand, sel.inverted, size);
}

/**
 * Rasterize a layer mask, or null when it is disabled or provably has no effect.
 *
 * A `reveal` mask with no regions and no ops is fully opaque — returning null there is what
 * stops "add a mask" from costing a canvas-sized allocation and a GPU pass per frame before the
 * user has painted a single stroke.
 */
export function rasterizeMask(mask: LayerMask | undefined, size: Size): CoverageCanvas | null {
  if (!mask || !mask.enabled) return null;
  const untouched = mask.regions.length === 0 && mask.ops.length === 0;
  if (untouched && (mask.base === 'reveal') !== mask.inverted) return null;

  const built = newCoverage(size);
  if (!built) return null;
  const { ctx, canvas } = built;

  if (mask.base === 'reveal') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (mask.regions.length > 0) paintRegions(ctx, mask.regions, size);

  if (mask.ops.length > 0) {
    // Brush work on a mask deposits COVERAGE, not colour: the ops are replayed into their own
    // buffer and drawn in as alpha, so white paint adds coverage and the eraser removes it.
    // One replay engine serves both a paint layer and a mask, which is why painting a mask
    // feels identical to painting pixels.
    const painted = replayPaintOps(mask.ops, size);
    if (painted) ctx.drawImage(painted, 0, 0);
  }

  return mask.inverted ? invertCoverage(canvas) : canvas;
}

/**
 * A stable signature for the mask cache.
 *
 * Same discipline as the vector rasterizer's: name only the fields that change pixels, so an
 * unrelated edit — the layer's opacity, its blend mode — does not invalidate a mask that has
 * not moved.
 */
export const maskSignature = (mask: LayerMask | undefined): string =>
  mask ? JSON.stringify([mask.enabled, mask.inverted, mask.base, mask.regions, mask.ops]) : '';

export type { CoverageCanvas, Size };
