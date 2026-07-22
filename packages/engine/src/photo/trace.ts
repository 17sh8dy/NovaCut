/**
 * Flood fill and contour tracing — the Magic Wand's engine.
 *
 * The wand is a TOOL, not a stored region kind (see the header of `@opencut/photo`'s
 * `selection.ts`): it samples the composite once, at the click, and what lands in the document
 * is ordinary polygon geometry. These two functions are that conversion.
 *
 *   `floodSelect` — which pixels match the seed.
 *   `traceMask`   — the boundary of those pixels, as closed contours.
 *
 * Keeping them here rather than in the model package is the layering rule: they read pixels, so
 * they belong on the browser side of the line.
 */

export interface FloodOptions {
  /** 0..1. How far a pixel may differ from the seed across R,G,B,A and still match. */
  tolerance: number;
  /** False matches every similar pixel in the image, not just the connected blob. */
  contiguous: boolean;
}

/**
 * A binary mask of the pixels matching the seed. 1 byte per pixel, 0 or 255.
 *
 * Scanline flood fill rather than the four-way recursive one everybody writes first: a
 * recursive fill over a 4K sky is somewhere between very slow and a stack overflow, and it is
 * the same algorithm either way. This fills whole horizontal runs and only pushes the rows
 * above and below, which cuts the queue by roughly the width of the region.
 */
export function floodSelect(
  image: ImageData,
  seedX: number,
  seedY: number,
  options: FloodOptions,
): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return out;

  const seed = sampleAt(data, (sy * width + sx) * 4);
  // Tolerance is compared against a squared distance over four channels, so the threshold is
  // squared too — doing it once here rather than a sqrt per pixel is the whole reason this
  // stays interactive on a large image.
  const maxDist = options.tolerance * 255;
  const threshold = maxDist * maxDist * 4;

  const matches = (index: number): boolean => {
    const o = index * 4;
    const dr = data[o]! - seed[0];
    const dg = data[o + 1]! - seed[1];
    const db = data[o + 2]! - seed[2];
    const da = data[o + 3]! - seed[3];
    return dr * dr + dg * dg + db * db + da * da <= threshold;
  };

  if (!options.contiguous) {
    for (let i = 0; i < width * height; i++) if (matches(i)) out[i] = 255;
    return out;
  }

  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    let left = x;
    const row = y * width;
    // Walk left, then right, filling the whole run in one pass.
    while (left >= 0 && out[row + left] === 0 && matches(row + left)) left--;
    left++;
    let right = x;
    while (right < width && out[row + right] === 0 && matches(row + right)) right++;
    right--;
    if (left > right) continue;

    for (let i = left; i <= right; i++) out[row + i] = 255;

    // Push only the START of each unfilled span above and below, not every pixel — that is what
    // keeps the stack proportional to the region's complexity rather than its area.
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inSpan = false;
      for (let i = left; i <= right; i++) {
        const hit = out[nrow + i] === 0 && matches(nrow + i);
        if (hit && !inSpan) {
          stack.push(i, ny);
          inSpan = true;
        } else if (!hit) {
          inSpan = false;
        }
      }
    }
  }
  return out;
}

const sampleAt = (data: Uint8ClampedArray, o: number): [number, number, number, number] =>
  [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!];

/**
 * Select by colour across the whole image, ignoring connectivity.
 *
 * A separate entry point from `floodSelect(contiguous: false)` because it takes a COLOUR rather
 * than a seed position — which is what a "select all the reds" control offers.
 */
export function colorRangeSelect(
  image: ImageData,
  color: [number, number, number],
  tolerance: number,
): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  const maxDist = tolerance * 255;
  const threshold = maxDist * maxDist * 3;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    // Fully transparent pixels have no colour to compare — matching them by their arbitrary
    // RGB would select every empty region of the canvas.
    if (data[o + 3]! < 8) continue;
    const dr = data[o]! - color[0];
    const dg = data[o + 1]! - color[1];
    const db = data[o + 2]! - color[2];
    if (dr * dr + dg * dg + db * db <= threshold) out[i] = 255;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contour tracing
// ─────────────────────────────────────────────────────────────────────────────

export interface TracePoint {
  x: number;
  y: number;
}

/**
 * Trace a binary mask into closed contours, in pixel coordinates.
 *
 * Marching squares on the mask's CORNER lattice: each cell looks at the four pixels around a
 * lattice point and emits the edge segments separating inside from outside. Collecting those
 * segments and chaining them end-to-end gives closed loops — outer boundaries and holes alike,
 * which is exactly why the resulting region fills with the even-odd rule.
 *
 * The output is axis-aligned and therefore stair-stepped; `simplify` collapses collinear runs,
 * which removes almost all of it because most of a contour IS collinear. The remaining steps
 * are one pixel and disappear under any feather.
 */
export function traceMask(mask: Uint8Array, width: number, height: number): TracePoint[][] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;

  // Segments keyed by their start point, so chaining is a hash lookup rather than a search.
  const segments = new Map<string, TracePoint[]>();
  const key = (p: TracePoint) => `${p.x},${p.y}`;
  const push = (a: TracePoint, b: TracePoint) => {
    const k = key(a);
    const list = segments.get(k);
    if (list) list.push(b);
    else segments.set(k, [b]);
  };

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      // The four pixels around lattice point (x, y).
      const tl = at(x - 1, y - 1);
      const tr = at(x, y - 1);
      const bl = at(x - 1, y);
      const br = at(x, y);
      // Edges are emitted so that "inside" is consistently on the left of travel — which is
      // what makes the chained loops close instead of forking at a saddle.
      if (tl !== tr) (tr ? push({ x, y }, { x, y: y - 1 } as TracePoint) : push({ x, y: y - 1 }, { x, y }));
      if (tr !== br) (br ? push({ x, y }, { x: x + 1, y } as TracePoint) : push({ x: x + 1, y }, { x, y }));
      if (br !== bl) (bl ? push({ x, y }, { x, y: y + 1 } as TracePoint) : push({ x, y: y + 1 }, { x, y }));
      if (bl !== tl) (tl ? push({ x, y }, { x: x - 1, y } as TracePoint) : push({ x: x - 1, y }, { x, y }));
    }
  }

  const contours: TracePoint[][] = [];
  const used = new Set<string>();

  for (const [startKey, targets] of segments) {
    for (const first of targets) {
      const edgeKey = `${startKey}>${key(first)}`;
      if (used.has(edgeKey)) continue;

      const contour: TracePoint[] = [];
      let from = parseKey(startKey);
      let to = first;
      // A hard cap: a corrupt segment map would otherwise spin forever, and a hung editor is a
      // far worse failure than a dropped contour. The bound is generous — a contour cannot
      // legitimately have more points than the lattice has edges.
      const limit = (width + 1) * (height + 1) * 4;
      for (let guard = 0; guard < limit; guard++) {
        used.add(`${key(from)}>${key(to)}`);
        contour.push(from);
        const next = segments.get(key(to));
        if (!next) break;
        const step = next.find((p) => !used.has(`${key(to)}>${key(p)}`));
        if (!step) break;
        from = to;
        to = step;
        if (key(from) === startKey) break;
      }
      if (contour.length >= 4) contours.push(simplify(contour));
    }
  }
  return contours;
}

const parseKey = (k: string): TracePoint => {
  const [x, y] = k.split(',');
  return { x: Number(x), y: Number(y) };
};

/**
 * Drop points that lie on the straight line between their neighbours.
 *
 * A traced contour is entirely axis-aligned steps, so a 1000px straight edge arrives as 1000
 * points and leaves as 2. That matters: the contours go into the document, get serialized, and
 * get re-rasterized on every draw.
 */
function simplify(points: readonly TracePoint[]): TracePoint[] {
  if (points.length < 3) return [...points];
  const out: TracePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length]!;
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const cross = (cur.x - prev.x) * (next.y - prev.y) - (cur.y - prev.y) * (next.x - prev.x);
    if (cross !== 0) out.push(cur);
  }
  return out.length >= 3 ? out : [...points];
}
