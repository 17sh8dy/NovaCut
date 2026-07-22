/**
 * Marching ants — the selection's outline, as SVG path data.
 *
 * The naive version draws each region's own shape and lets them overlap. That is wrong the
 * moment a selection has more than one region: a subtracted circle would be drawn as a circle
 * rather than as a bite taken out of the rectangle, and a feathered edge would show a hard line
 * nowhere near where paint will actually land.
 *
 * So the outline is derived from the SAME coverage bitmap the clipping uses: rasterize the
 * selection, trace the result, emit the contours. Booleans, feather and expand are all already
 * baked into that bitmap, so the ants sit exactly on the boundary that edits respect. The 50%
 * coverage contour is what a feathered selection's ants mark, which is also Photoshop's rule.
 *
 * ## Why it rasterizes small
 *
 * A marquee drag re-derives this on every pointermove, and rasterizing plus tracing a 4K
 * coverage bitmap at that rate would drop frames. The ants only ever need to be accurate to a
 * screen pixel, so the work happens at a bounded resolution and the contours are scaled back
 * up. At 1024px on the long edge the error is under half a document pixel on a 4K canvas —
 * invisible under a 1px dashed stroke.
 */

import { rasterizeSelection, traceMask } from '@opencut/engine';
import { hasSelection, isEverythingSelected, type Selection } from '@opencut/photo';

/** Longest edge of the bitmap the outline is traced from. See the header. */
const TRACE_RESOLUTION = 1024;

export interface OutlineResult {
  /** SVG path data in CANVAS pixel coordinates, ready for the overlay's viewBox. */
  d: string;
  /** True when the selection covers the whole canvas, so the overlay can just outline it. */
  everything: boolean;
}

/**
 * Trace a selection into SVG path data, or null when there is nothing to draw.
 *
 * Null for "no selection" and a whole-canvas rectangle for "everything selected" — the two are
 * genuinely different states and the overlay shows them differently.
 */
export function selectionOutline(
  selection: Selection | null,
  canvas: { width: number; height: number },
): OutlineResult | null {
  if (!hasSelection(selection)) return null;
  if (isEverythingSelected(selection)) {
    return {
      d: `M0 0 H${canvas.width} V${canvas.height} H0 Z`,
      everything: true,
    };
  }

  const scale = Math.min(1, TRACE_RESOLUTION / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  // Rasterize at the reduced size by scaling the geometry itself, not by drawing large and
  // downsampling — downsampling would blur the edge and shift the traced 50% contour inward.
  const scaled: Selection = {
    ...selection!,
    regions: selection!.regions.map(scaleRegion(scale)),
    feather: selection!.feather * scale,
    expand: selection!.expand * scale,
  };

  const coverage = rasterizeSelection(scaled, { width: w, height: h });
  if (!coverage) return null;
  const ctx = coverage.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const image = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  // The 50% alpha contour. For a hard selection every pixel is 0 or 255 and the threshold is
  // irrelevant; for a feathered one it is the line where paint reaches half strength, which is
  // the boundary users read as "the edge".
  for (let i = 0; i < mask.length; i++) mask[i] = image.data[i * 4 + 3]! >= 128 ? 1 : 0;

  const contours = traceMask(mask, w, h);
  if (contours.length === 0) return null;

  const inv = 1 / scale;
  const parts: string[] = [];
  for (const contour of contours) {
    if (contour.length < 3) continue;
    const points = contour.map((p) => `${round(p.x * inv)} ${round(p.y * inv)}`);
    parts.push(`M${points[0]} L${points.slice(1).join(' L')} Z`);
  }
  return parts.length > 0 ? { d: parts.join(' '), everything: false } : null;
}

const scaleRegion = (k: number) => (region: Selection['regions'][number]): Selection['regions'][number] => {
  if (region.kind === 'path') {
    return { ...region, contours: region.contours.map((c) => c.map((p) => ({ x: p.x * k, y: p.y * k }))) };
  }
  return { ...region, x: region.x * k, y: region.y * k, width: region.width * k, height: region.height * k };
};

/** Two decimals is plenty for a 1px dashed stroke, and keeps the path string short. */
const round = (n: number): number => Math.round(n * 100) / 100;
