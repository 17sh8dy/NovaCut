/**
 * Where a layer lands on the canvas — the single source of truth.
 *
 * This file exists because two very different pieces of code have to agree on it *exactly*:
 * the GPU render graph, which draws the layer, and the UI, which draws the selection box and
 * handles the user drags. When those disagree the failure is maddening rather than obvious —
 * handles that float a few pixels off the artwork, a rotated layer whose box shears the wrong
 * way, a drag that accelerates away from the cursor.
 *
 * So the math lives here, in canvas PIXEL space, and both consumers derive from it. The
 * renderer converts the result to clip space at the last moment (`clipMatrix`), which is a
 * fixed change of basis rather than a second copy of the reasoning.
 *
 * ## The space
 *
 * Canvas pixels, origin top-left, **+y down** — the same convention `Transform2D.x/y` uses and
 * the same one every inspector field reads. A layer's LOCAL space is its drawn rect centred on
 * the origin: `[-w/2, w/2] × [-h/2, h/2]`.
 *
 * ## Fit modes
 *
 * `contain` aspect-fits the source into the canvas, which is what an imported photo wants: on
 * the common path (canvas sized to the image at import) it is exactly identity, so a fresh
 * import is 1:1 with no resampling. `exact` maps one source pixel to one canvas pixel, which is
 * what every *vector* layer wants — a 400px-wide shape is 400px wide, and aspect-fitting it
 * into the canvas would make its size field mean nothing.
 */

import type { Transform2D } from './types.js';

/** A 2D affine transform, in the order a canvas context takes them: `x' = a·x + c·y + e`. */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type FitMode = 'contain' | 'exact';

export const IDENTITY_MAT2D: Readonly<Mat2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// Matrix algebra
// ─────────────────────────────────────────────────────────────────────────────

/** `m ∘ n` — n applied first, then m. Matches the canvas `transform()` convention. */
export function mul(m: Mat2D, n: Mat2D): Mat2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export const composeMat = (...ms: Mat2D[]): Mat2D =>
  ms.reduce((acc, m) => mul(acc, m), { ...IDENTITY_MAT2D });

export const translateMat = (x: number, y: number): Mat2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
export const scaleMat = (x: number, y: number): Mat2D => ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });

/** Clockwise on screen, because +y points down here. `degrees` matches `Transform2D.rotation`. */
export function rotateMat(degrees: number): Mat2D {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export const applyMat = (m: Mat2D, p: Point): Point => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/**
 * The inverse, or null when the matrix is degenerate.
 *
 * Degenerate is reachable from the UI — a layer scaled to 0 on one axis — and the caller that
 * hits it is hit-testing, which must answer "nothing here", not divide by zero and report a
 * hit at infinity.
 */
export function invertMat(m: Mat2D): Mat2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (!det || !Number.isFinite(det)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The size the layer's source occupies BEFORE its own scale — the "100%" the inspector means.
 *
 * For `contain` this is the aspect-fit of the source into the canvas; for `exact` it is the
 * source's own size. A zero-sized source falls back to the canvas so a half-built layer still
 * has a box the user can grab.
 */
export function baseSize(natural: Size, canvas: Size, fit: FitMode): Size {
  if (!natural.width || !natural.height) return { width: canvas.width, height: canvas.height };
  if (fit === 'exact') return { width: natural.width, height: natural.height };
  const canvasAspect = canvas.width / canvas.height;
  const srcAspect = natural.width / natural.height;
  return srcAspect > canvasAspect
    ? { width: canvas.width, height: canvas.width / srcAspect }
    : { width: canvas.height * srcAspect, height: canvas.height };
}

/**
 * Local-space → canvas-pixel-space for one layer.
 *
 * Reading right to left, in the order things physically happen: un-anchor, flip, scale, rotate,
 * re-anchor, then offset by the transform's position from the canvas centre. The anchor
 * sandwich is what makes `anchorX/anchorY` a real pivot rather than a decorative field — core's
 * video Transform declares the same thing and ignores it, which is exactly the gap this model
 * exists not to repeat.
 *
 * Flip is applied INSIDE the rotation, so flipping an already-rotated layer mirrors it in its
 * own axes. That is what "flip horizontal" means to a user looking at a tilted layer; applying
 * it outside would mirror the tilt too, which reads as an unrelated rotation.
 */
export function layerMatrix(
  transform: Transform2D,
  natural: Size,
  canvas: Size,
  fit: FitMode,
): Mat2D {
  const base = baseSize(natural, canvas, fit);
  // The anchor, as an offset from the local origin (the layer's centre).
  const ax = base.width * (transform.anchorX - 0.5);
  const ay = base.height * (transform.anchorY - 0.5);
  return composeMat(
    translateMat(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y),
    translateMat(ax, ay),
    rotateMat(transform.rotation),
    scaleMat(transform.scaleX, transform.scaleY),
    scaleMat(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1),
    translateMat(-ax, -ay),
  );
}

/**
 * The layer's four corners in canvas pixels, clockwise from top-left.
 *
 * This is what the selection box draws and what hit-testing tests against, so it must come
 * from the same matrix the renderer uses — hence deriving it rather than re-deriving it.
 */
export function layerCorners(
  transform: Transform2D,
  natural: Size,
  canvas: Size,
  fit: FitMode,
): [Point, Point, Point, Point] {
  const base = baseSize(natural, canvas, fit);
  const m = layerMatrix(transform, natural, canvas, fit);
  const hw = base.width / 2;
  const hh = base.height / 2;
  return [
    applyMat(m, { x: -hw, y: -hh }),
    applyMat(m, { x: hw, y: -hh }),
    applyMat(m, { x: hw, y: hh }),
    applyMat(m, { x: -hw, y: hh }),
  ];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The axis-aligned bounding box of the corners. Used for snapping and for "fit to selection". */
export function boundsOf(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Is `point` (canvas pixels) inside the layer's box?
 *
 * Tested in LOCAL space by inverting the matrix, rather than by a polygon test on the rotated
 * corners: same answer, but it also hands the caller the local coordinate, which is what a
 * future per-pixel alpha hit-test will need.
 */
export function hitTestBox(
  point: Point,
  transform: Transform2D,
  natural: Size,
  canvas: Size,
  fit: FitMode,
): Point | null {
  const inv = invertMat(layerMatrix(transform, natural, canvas, fit));
  if (!inv) return null;
  const base = baseSize(natural, canvas, fit);
  const local = applyMat(inv, point);
  const hw = base.width / 2;
  const hh = base.height / 2;
  if (local.x < -hw || local.x > hw || local.y < -hh || local.y > hh) return null;
  return local;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clip space (the renderer's basis)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same placement, as the column-major mat3 the vertex shader multiplies `a_pos` by.
 *
 * Two changes of basis wrap the canvas-space matrix above:
 *
 *   `local`  — `a_pos` is the unit quad in -1..1 with **+y up**, so mapping it to local pixels
 *              is `scale(w/2, -h/2)`. The negative y is the whole y-axis flip, in one place.
 *   `clip`   — canvas pixels back to -1..1: `x' = 2x/W - 1`, `y' = 1 - 2y/H`.
 *
 * Deriving it this way (rather than composing a second, independent clip-space chain) is what
 * guarantees the handles the user drags sit exactly on the pixels the GPU drew. The old
 * hand-composed version also needed an explicit un-squash/re-squash sandwich around its
 * rotation, because rotating in clip space — where one unit is W/2 px across but H/2 px down —
 * shears instead of turning. Working in pixels first makes that failure unrepresentable.
 */
export function clipMatrix(
  transform: Transform2D,
  natural: Size,
  canvas: Size,
  fit: FitMode,
): Float32Array {
  const base = baseSize(natural, canvas, fit);
  const m = composeMat(
    // canvas px → clip
    translateMat(-1, 1),
    scaleMat(2 / canvas.width, -2 / canvas.height),
    layerMatrix(transform, natural, canvas, fit),
    // unit quad → local px (+y up → +y down)
    scaleMat(base.width / 2, -base.height / 2),
  );
  // Column-major, matching `uniformMatrix3fv(loc, false, m)`.
  return new Float32Array([m.a, m.b, 0, m.c, m.d, 0, m.e, m.f, 1]);
}
