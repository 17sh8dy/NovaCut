/**
 * Coverage bitmaps — the shared substrate for selections, layer masks and paint clipping.
 *
 * All three answer the same question: which pixels, how much. The answer is a canvas whose
 * ALPHA is the coverage and whose RGB is white. Alpha rather than luminance because that is
 * what every consumer actually wants — the GPU multiplies it into a layer's alpha, and a 2D
 * `destination-in` composite clips paint with it directly, both with no conversion.
 *
 * This module exists so the selection rasterizer, the mask rasterizer and the paint clipper are
 * the same code. When a stroke is clipped to a feathered marquee, the boundary it is clipped at
 * and the boundary the marching ants are drawn at have to be the same boundary — and the only
 * way to guarantee that is for there to be one implementation.
 */

import type { SelectionRegion } from '@opencut/photo';

export interface Size {
  width: number;
  height: number;
}

/** A canvas whose alpha channel is coverage, 0..255. */
export type CoverageCanvas = HTMLCanvasElement;

export function newCoverage(size: Size): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width));
  canvas.height = Math.max(1, Math.round(size.height));
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paint a region stack into `ctx`, honoring each region's combine mode.
 *
 * `add` and `replace` draw normally, `subtract` uses `destination-out`. `intersect` needs the
 * region drawn into a scratch buffer FIRST and then applied with `destination-in` — you cannot
 * intersect against a path you are drawing incrementally, because `destination-in` would erase
 * everything the path has not reached yet.
 */
export function paintRegions(
  ctx: CanvasRenderingContext2D,
  regions: readonly SelectionRegion[],
  size: Size,
): void {
  for (const region of regions) {
    if (region.combine === 'intersect') {
      const scratch = newCoverage(size);
      if (!scratch) continue;
      scratch.ctx.fillStyle = '#fff';
      traceRegion(scratch.ctx, region);
      fillTraced(scratch.ctx, region);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(scratch.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      continue;
    }
    ctx.globalCompositeOperation = region.combine === 'subtract' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#fff';
    traceRegion(ctx, region);
    fillTraced(ctx, region);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Add a region's outline to the current path. Exported so the overlay can draw ants from it. */
export function traceRegion(ctx: CanvasRenderingContext2D, region: SelectionRegion): void {
  ctx.beginPath();
  if (region.kind === 'rect') {
    ctx.rect(region.x, region.y, region.width, region.height);
    return;
  }
  if (region.kind === 'ellipse') {
    ctx.ellipse(
      region.x + region.width / 2,
      region.y + region.height / 2,
      Math.abs(region.width) / 2,
      Math.abs(region.height) / 2,
      0,
      0,
      Math.PI * 2,
    );
    return;
  }
  for (const contour of region.contours) {
    if (contour.length < 2) continue;
    ctx.moveTo(contour[0]!.x, contour[0]!.y);
    for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i]!.x, contour[i]!.y);
    ctx.closePath();
  }
}

/** Path regions fill EVEN-ODD so a traced blob's holes stay holes. See `PathRegion`. */
const fillTraced = (ctx: CanvasRenderingContext2D, region: SelectionRegion): void =>
  ctx.fill(region.kind === 'path' ? 'evenodd' : 'nonzero');

// ─────────────────────────────────────────────────────────────────────────────
// Modifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grow or shrink coverage by `amount` pixels.
 *
 * Blur-then-threshold rather than a true morphological pass. A blur turns the edge into a ramp;
 * re-thresholding that ramp above or below 50% moves the boundary by a predictable distance,
 * which is a dilate or an erode. One canvas filter and one pass over the buffer, instead of a
 * per-pixel structuring-element sweep — and at the scale a selection edge is ever inspected,
 * the difference is invisible.
 */
export function expandCoverage(canvas: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  if (Math.abs(amount) < 0.5) return canvas;
  const work = newCoverage(canvas);
  if (!work) return canvas;
  work.ctx.filter = `blur(${Math.abs(amount)}px)`;
  work.ctx.drawImage(canvas, 0, 0);
  work.ctx.filter = 'none';

  // The two cut points are deliberately asymmetric: a blur loses more mass on the inside of a
  // boundary than it gains on the outside, so a symmetric 0.5 threshold would shrink a grown
  // selection back toward where it started.
  const level = (amount > 0 ? 0.12 : 0.86) * 255;
  const image = work.ctx.getImageData(0, 0, work.canvas.width, work.canvas.height);
  const data = image.data;
  for (let i = 3; i < data.length; i += 4) data[i] = data[i]! >= level ? 255 : 0;
  work.ctx.putImageData(image, 0, 0);
  return work.canvas;
}

export function featherCoverage(canvas: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius < 0.5) return canvas;
  const work = newCoverage(canvas);
  if (!work) return canvas;
  work.ctx.filter = `blur(${radius}px)`;
  work.ctx.drawImage(canvas, 0, 0);
  work.ctx.filter = 'none';
  return work.canvas;
}

/** Flip coverage: full becomes empty and vice versa. */
export function invertCoverage(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const work = newCoverage(canvas);
  if (!work) return canvas;
  work.ctx.fillStyle = '#fff';
  work.ctx.fillRect(0, 0, work.canvas.width, work.canvas.height);
  work.ctx.globalCompositeOperation = 'destination-out';
  work.ctx.drawImage(canvas, 0, 0);
  work.ctx.globalCompositeOperation = 'source-over';
  return work.canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regions + feather + expand + invert → coverage.
 *
 * Order matters and matches every editor: grow or shrink the hard edge FIRST, then soften it.
 * Feathering before expanding would re-harden the soft edge at the threshold step, which is a
 * subtle way for a feathered selection to come back with an aliased boundary.
 *
 * Returns null when the result would be uniformly opaque — an inverted empty region set is
 * "everything", and callers skip the whole masking pass rather than multiplying by white.
 */
export function rasterizeCoverage(
  regions: readonly SelectionRegion[],
  feather: number,
  expand: number,
  inverted: boolean,
  size: Size,
): CoverageCanvas | null {
  if (regions.length === 0 && inverted) return null;
  const built = newCoverage(size);
  if (!built) return null;
  paintRegions(built.ctx, regions, size);

  let canvas: HTMLCanvasElement = built.canvas;
  if (expand !== 0) canvas = expandCoverage(canvas, expand);
  if (feather > 0) canvas = featherCoverage(canvas, feather);
  if (inverted) canvas = invertCoverage(canvas);
  return canvas;
}
