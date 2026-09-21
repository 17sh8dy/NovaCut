/**
 * Shape geometry.
 *
 * Every shape the editor can draw is a pure function from (kind, size, params) to a list of
 * path commands in the shape's own box — `(0,0)` top-left to `(w,h)`. Nothing here touches a
 * canvas, a DOM node or WebGL, which is what lets three very different consumers share one
 * definition of "what a star is":
 *
 *   • the rasterizer, which replays the commands into a `Path2D`;
 *   • the layers panel, which replays them into a thumbnail;
 *   • hit-testing, which needs the same outline the user can see.
 *
 * The alternative — each consumer drawing its own arrow — is how a shape ends up looking one
 * way on the canvas and another way in the thumbnail, with no single place to fix it.
 *
 * Curves are emitted as cubic Béziers only. An arc command would be shorter for ellipses, but
 * `Path2D.arc` and SVG's `A` disagree on parameterisation and neither survives a non-uniform
 * scale cleanly; cubics are exact under any affine transform, which matters the moment a
 * shape layer is scaled by its transform.
 */

/** The shapes the picker offers. Adding one means adding a `case` in `shapePath`. */
export type ShapeKind =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'star'
  | 'polygon'
  | 'heart'
  | 'diamond'
  | 'chevron'
  | 'speech-bubble'
  | 'callout'
  | 'plus'
  | 'cross'
  | 'lightning'
  | 'cloud'
  | 'crescent'
  | 'ring'
  | 'hexagon'
  | 'octagon'
  | 'parallelogram'
  | 'trapezoid'
  | 'right-triangle'
  | 'double-arrow'
  | 'checkmark'
  | 'droplet'
  | 'shield'
  | 'ribbon'
  | 'bookmark'
  | 'pin'
  | 'sparkle';

/** Tuning knobs. Every shape reads only the ones that mean something for it. */
export interface ShapeParams {
  /** Corner rounding in px, for rectangles and the bubble family. */
  cornerRadius: number;
  /** Point count for stars and polygons. */
  points: number;
  /** Star only: inner radius as a fraction of the outer. 0.5 is the classic five-point star. */
  innerRatio: number;
  /** Arrow/line only: head size as a fraction of the box's short side. */
  headSize: number;
  /** Arrow/line only: shaft thickness as a fraction of the box height. */
  thickness: number;
  /** Bubble/callout only: the tail's tip, in 0..1 box coordinates. */
  tailX: number;
  tailY: number;
}

export const DEFAULT_SHAPE_PARAMS: Readonly<ShapeParams> = Object.freeze({
  cornerRadius: 24,
  points: 5,
  innerRatio: 0.44,
  headSize: 0.55,
  thickness: 0.34,
  tailX: 0.28,
  tailY: 1.34,
});

// ─────────────────────────────────────────────────────────────────────────────
// Path commands
// ─────────────────────────────────────────────────────────────────────────────

export type PathCmd =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Z' };

const M = (x: number, y: number): PathCmd => ({ c: 'M', x, y });
const L = (x: number, y: number): PathCmd => ({ c: 'L', x, y });
const C = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): PathCmd =>
  ({ c: 'C', x1, y1, x2, y2, x, y });
const Z: PathCmd = { c: 'Z' };

/** Bézier circle constant: the handle length that approximates a quarter arc of radius 1. */
const K = 0.5522847498307936;

/**
 * True when the shape is an open path — a stroke with no interior.
 *
 * The rasterizer must not `fill()` these: filling an open path implicitly closes it, so a
 * two-point line would paint a degenerate sliver instead of nothing, and its fill color would
 * fight its stroke color for no reason the user asked for.
 */
export const isOpenShape = (kind: ShapeKind): boolean => kind === 'line';

/**
 * Build the outline for `kind` inside a `w × h` box.
 *
 * Sizes are absolute pixels so the caller never has to rescale; a shape layer's box IS its
 * `width`/`height`, and its `transform.scale` is applied later by the render graph.
 */
export function shapePath(kind: ShapeKind, w: number, h: number, params: ShapeParams): PathCmd[] {
  const p = { ...DEFAULT_SHAPE_PARAMS, ...params };
  switch (kind) {
    case 'rectangle':
      return rect(0, 0, w, h, 0);
    case 'rounded-rectangle':
      return rect(0, 0, w, h, p.cornerRadius);
    case 'ellipse':
      return ellipse(w / 2, h / 2, w / 2, h / 2);
    case 'triangle':
      return [M(w / 2, 0), L(w, h), L(0, h), Z];
    case 'diamond':
      return [M(w / 2, 0), L(w, h / 2), L(w / 2, h), L(0, h / 2), Z];
    case 'line':
      return [M(0, h / 2), L(w, h / 2)];
    case 'arrow':
      return arrow(w, h, p);
    case 'chevron':
      return chevron(w, h, p);
    case 'star':
      return starPath(w, h, Math.max(3, Math.round(p.points)), p.innerRatio);
    case 'polygon':
      return starPath(w, h, Math.max(3, Math.round(p.points)), 1);
    case 'heart':
      return heart(w, h);
    case 'speech-bubble':
      return bubble(w, h, p, true);
    case 'callout':
      return bubble(w, h, p, false);
    case 'plus':
      return plus(w, h, p);
    case 'cross':
      return cross(w, h, p);
    case 'lightning':
      return unitPoly(w, h, [
        [0.6, 0], [0.14, 0.56], [0.46, 0.56], [0.32, 1], [0.9, 0.38], [0.56, 0.38], [0.78, 0],
      ]);
    case 'cloud':
      return cloud(w, h);
    case 'crescent':
      return crescent(w, h);
    case 'ring':
      return ring(w, h, p);
    case 'hexagon':
      return regular(w, h, 6, 0);
    case 'octagon':
      return regular(w, h, 8, -Math.PI / 2 + Math.PI / 8);
    case 'parallelogram':
      return unitPoly(w, h, [[0.2, 0], [1, 0], [0.8, 1], [0, 1]]);
    case 'trapezoid':
      return unitPoly(w, h, [[0.2, 0], [0.8, 0], [1, 1], [0, 1]]);
    case 'right-triangle':
      return [M(0, 0), L(0, h), L(w, h), Z];
    case 'double-arrow':
      return doubleArrow(w, h, p);
    case 'checkmark':
      return unitPoly(w, h, [
        [0.02, 0.55], [0.17, 0.4], [0.39, 0.62], [0.83, 0.1], [0.98, 0.25], [0.39, 0.92],
      ]);
    case 'droplet':
      return unitPath(w, h, [
        ['M', 0.5, 0],
        ['C', 0.62, 0.22, 0.95, 0.5, 0.95, 0.68],
        ['C', 0.95, 0.87, 0.74, 1, 0.5, 1],
        ['C', 0.26, 1, 0.05, 0.87, 0.05, 0.68],
        ['C', 0.05, 0.5, 0.38, 0.22, 0.5, 0],
      ]);
    case 'shield':
      return unitPath(w, h, [
        ['M', 0, 0.14],
        ['C', 0.2, 0.14, 0.38, 0.08, 0.5, 0],
        ['C', 0.62, 0.08, 0.8, 0.14, 1, 0.14],
        ['L', 1, 0.5],
        ['C', 1, 0.78, 0.75, 0.92, 0.5, 1],
        ['C', 0.25, 0.92, 0, 0.78, 0, 0.5],
      ]);
    case 'ribbon':
      return [M(0, 0), L(w, 0), L(w * 0.92, h / 2), L(w, h), L(0, h), L(w * 0.08, h / 2), Z];
    case 'bookmark':
      return unitPoly(w, h, [[0.2, 0], [0.8, 0], [0.8, 1], [0.5, 0.72], [0.2, 1]]);
    case 'pin':
      return pin(w, h);
    case 'sparkle':
      return unitPath(w, h, [
        ['M', 0.5, 0],
        ['C', 0.52, 0.3, 0.7, 0.48, 1, 0.5],
        ['C', 0.7, 0.52, 0.52, 0.7, 0.5, 1],
        ['C', 0.48, 0.7, 0.3, 0.52, 0, 0.5],
        ['C', 0.3, 0.48, 0.48, 0.3, 0.5, 0],
      ]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

function rect(x: number, y: number, w: number, h: number, radius: number): PathCmd[] {
  // Clamping to half the SHORT side is what stops a big radius from inverting the corners into
  // a bow-tie — the classic rounded-rect artifact when the box is thinner than 2r.
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r === 0) return [M(x, y), L(x + w, y), L(x + w, y + h), L(x, y + h), Z];
  const k = r * K;
  return [
    M(x + r, y),
    L(x + w - r, y),
    C(x + w - r + k, y, x + w, y + r - k, x + w, y + r),
    L(x + w, y + h - r),
    C(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h),
    L(x + r, y + h),
    C(x + r - k, y + h, x, y + h - r + k, x, y + h - r),
    L(x, y + r),
    C(x, y + r - k, x + r - k, y, x + r, y),
    Z,
  ];
}

function ellipse(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const kx = rx * K;
  const ky = ry * K;
  return [
    M(cx, cy - ry),
    C(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    C(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
    C(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
    C(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
    Z,
  ];
}

/** A filled arrow pointing right: a rectangular shaft into a triangular head. */
function arrow(w: number, h: number, p: ShapeParams): PathCmd[] {
  const head = Math.min(w, Math.max(2, h * p.headSize + h * 0.2));
  const half = (h * Math.max(0.02, Math.min(1, p.thickness))) / 2;
  const cy = h / 2;
  const shaftEnd = Math.max(0, w - head);
  return [
    M(0, cy - half),
    L(shaftEnd, cy - half),
    L(shaftEnd, 0),
    L(w, cy),
    L(shaftEnd, h),
    L(shaftEnd, cy + half),
    L(0, cy + half),
    Z,
  ];
}

/** An open-ended ">" — the arrowhead alone, as a thick chevron. */
function chevron(w: number, h: number, p: ShapeParams): PathCmd[] {
  const t = h * Math.max(0.05, Math.min(0.9, p.thickness));
  return [M(0, 0), L(w, h / 2), L(0, h), L(t, h / 2), Z];
}

/**
 * A star (or, at innerRatio 1, a regular polygon), inscribed in the box.
 *
 * The first point is at the top and the box is filled edge to edge on both axes, so a star in
 * a square box reads upright and a star in a wide box stretches — which is what a user
 * dragging a bounding box expects, rather than a circle-inscribed star that ignores the box.
 */
function starPath(w: number, h: number, points: number, innerRatio: number): PathCmd[] {
  const cx = w / 2;
  const cy = h / 2;
  const inner = Math.max(0.05, Math.min(1, innerRatio));
  const steps = inner === 1 ? points : points * 2;
  const cmds: PathCmd[] = [];
  for (let i = 0; i < steps; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / steps;
    const r = inner === 1 || i % 2 === 0 ? 1 : inner;
    const x = cx + Math.cos(angle) * cx * r;
    const y = cy + Math.sin(angle) * cy * r;
    cmds.push(i === 0 ? M(x, y) : L(x, y));
  }
  cmds.push(Z);
  return cmds;
}

function heart(w: number, h: number): PathCmd[] {
  const x = (n: number) => n * w;
  const y = (n: number) => n * h;
  return [
    M(x(0.5), y(0.98)),
    C(x(0.08), y(0.66), x(0), y(0.4), x(0), y(0.28)),
    C(x(0), y(0.08), x(0.22), y(-0.03), x(0.5), y(0.2)),
    C(x(0.78), y(-0.03), x(1), y(0.08), x(1), y(0.28)),
    C(x(1), y(0.4), x(0.92), y(0.66), x(0.5), y(0.98)),
    Z,
  ];
}

/**
 * A rounded body with a tail.
 *
 * `rounded` picks between a speech bubble (fully rounded body, curved tail) and a callout
 * (same body, straight-sided tail). The tail attaches along the nearest body edge to the tip,
 * so dragging the tip around the shape keeps it plausibly connected instead of detaching.
 */
function bubble(w: number, h: number, p: ShapeParams, rounded: boolean): PathCmd[] {
  const tipX = p.tailX * w;
  const tipY = p.tailY * h;
  const body = rect(0, 0, w, h, Math.max(4, p.cornerRadius));

  // Attach along the body edge nearest the tip. Anything else — a fixed bottom attachment —
  // leaves the tail crossing the body when the tip is dragged above or beside it.
  const below = tipY > h;
  const above = tipY < 0;
  const baseHalf = Math.max(8, Math.min(w, h) * 0.16);

  let a: [number, number];
  let b: [number, number];
  if (below || above) {
    const edgeY = below ? h : 0;
    const cx = Math.max(baseHalf + 4, Math.min(w - baseHalf - 4, tipX));
    a = [cx - baseHalf, edgeY];
    b = [cx + baseHalf, edgeY];
  } else {
    const edgeX = tipX > w / 2 ? w : 0;
    const cy = Math.max(baseHalf + 4, Math.min(h - baseHalf - 4, tipY));
    a = [edgeX, cy - baseHalf];
    b = [edgeX, cy + baseHalf];
  }

  const tail: PathCmd[] = rounded
    ? [
        M(a[0], a[1]),
        C((a[0] + tipX) / 2, (a[1] + tipY) / 2, tipX, tipY, tipX, tipY),
        C(tipX, tipY, (b[0] + tipX) / 2, (b[1] + tipY) / 2, b[0], b[1]),
        Z,
      ]
    : [M(a[0], a[1]), L(tipX, tipY), L(b[0], b[1]), Z];

  // Two subpaths, not one: the body stays a clean rounded rect and the tail overlaps it. With
  // nonzero winding (the canvas default) the union fills as a single silhouette.
  return [...body, ...tail];
}

// ─────────────────────────────────────────────────────────────────────────────
// More builders
//
// WINDING: every solid contour here is drawn clockwise (screen space) and every hole
// counter-clockwise. The rasterizer fills with the default nonzero rule, so overlapping
// same-direction contours UNION (a cloud is built from several circles) and an opposite-direction
// contour cuts a hole (a ring, a pin). Mixing the directions by accident makes overlaps vanish.
// ─────────────────────────────────────────────────────────────────────────────

/** A closed polygon from 0..1 coordinates scaled to the box. */
function unitPoly(w: number, h: number, pts: readonly (readonly [number, number])[]): PathCmd[] {
  return [...pts.map(([x, y], i) => (i === 0 ? M(x * w, y * h) : L(x * w, y * h))), Z];
}

/** A path from 0..1 coordinates ('M' 'L' 'C' segments), closed, scaled to the box. */
function unitPath(w: number, h: number, segs: readonly (readonly (string | number)[])[]): PathCmd[] {
  const out: PathCmd[] = [];
  for (const s of segs) {
    const n = s.slice(1) as number[];
    if (s[0] === 'M') out.push(M(n[0]! * w, n[1]! * h));
    else if (s[0] === 'L') out.push(L(n[0]! * w, n[1]! * h));
    else out.push(C(n[0]! * w, n[1]! * h, n[2]! * w, n[3]! * h, n[4]! * w, n[5]! * h));
  }
  out.push(Z);
  return out;
}

/** An ellipse wound the OTHER way, for cutting holes under the nonzero rule. */
function ellipseHole(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const kx = rx * K;
  const ky = ry * K;
  return [
    M(cx, cy - ry),
    C(cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy),
    C(cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry),
    C(cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy),
    C(cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry),
    Z,
  ];
}

/** A regular n-gon inscribed in the box, first vertex at `start` radians (0 = right). */
function regular(w: number, h: number, n: number, start: number): PathCmd[] {
  const cx = w / 2;
  const cy = h / 2;
  const cmds: PathCmd[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (i * Math.PI * 2) / n;
    const x = cx + Math.cos(a) * cx;
    const y = cy + Math.sin(a) * cy;
    cmds.push(i === 0 ? M(x, y) : L(x, y));
  }
  cmds.push(Z);
  return cmds;
}

/** A "+": two bars crossing. `thickness` is the bar width as a fraction of the box. */
function plus(w: number, h: number, p: ShapeParams): PathCmd[] {
  const t = Math.max(0.08, Math.min(0.9, p.thickness));
  const x0 = (w - w * t) / 2;
  const x1 = x0 + w * t;
  const y0 = (h - h * t) / 2;
  const y1 = y0 + h * t;
  return [
    M(x0, 0), L(x1, 0), L(x1, y0), L(w, y0), L(w, y1), L(x1, y1),
    L(x1, h), L(x0, h), L(x0, y1), L(0, y1), L(0, y0), L(x0, y0), Z,
  ];
}

/**
 * An "X" as ONE outline (16 vertices).
 *
 * Two overlapping bars would union under the nonzero fill, but a STROKE follows every contour, so
 * the overlap would show as crossed lines inside the shape. A single outline strokes cleanly.
 */
function cross(w: number, h: number, p: ShapeParams): PathCmd[] {
  const k = w * Math.max(0.06, Math.min(0.6, p.thickness * 0.6)); // horizontal bar width
  const e = (h / w) * (k / 2); // the same half-thickness, measured vertically
  const cx = w / 2;
  const cy = h / 2;
  return [
    M(0, 0), L(k / 2, 0), L(cx, cy - e), L(w - k / 2, 0), L(w, 0), L(w, e), L(cx + k / 2, cy),
    L(w, h - e), L(w, h), L(w - k / 2, h), L(cx, cy + e), L(k / 2, h), L(0, h), L(0, h - e),
    L(cx - k / 2, cy), L(0, e), Z,
  ];
}

/** A cloud as ONE outline (see `cross` for why it is not a union of circles). */
function cloud(w: number, h: number): PathCmd[] {
  return unitPath(w, h, [
    ['M', 0.2, 0.95],
    ['C', 0.08, 0.95, 0.01, 0.85, 0.01, 0.72],
    ['C', 0.01, 0.58, 0.11, 0.49, 0.24, 0.49],
    ['C', 0.25, 0.25, 0.41, 0.06, 0.6, 0.06],
    ['C', 0.78, 0.06, 0.9, 0.21, 0.88, 0.4],
    ['C', 0.96, 0.42, 1, 0.56, 1, 0.71],
    ['C', 1, 0.85, 0.91, 0.95, 0.8, 0.95],
  ]);
}

/** A circular arc as cubic Béziers, from angle a0 to a1 (radians, y-down), split at 90°. */
function arcCubics(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): PathCmd[] {
  const out: PathCmd[] = [];
  const segs = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const step = (a1 - a0) / segs;
  const t = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < segs; i++) {
    const s = a0 + i * step;
    const e = s + step;
    const cs = Math.cos(s), sn = Math.sin(s), ce = Math.cos(e), se = Math.sin(e);
    out.push(
      C(
        cx + rx * (cs - t * sn), cy + ry * (sn + t * cs),
        cx + rx * (ce + t * se), cy + ry * (se - t * ce),
        cx + rx * ce, cy + ry * se,
      ),
    );
  }
  return out;
}

/** A crescent moon: the outer circle less a second circle shifted to the right. One contour. */
function crescent(w: number, h: number): PathCmd[] {
  const r0 = 0.5;
  const d = 0.2;
  const r1 = 0.42;
  // Where the two circles cross, in 0..1 box coordinates (both centres are on y = 0.5).
  const xi = (d * d + r0 * r0 - r1 * r1) / (2 * d);
  const yi = Math.sqrt(Math.max(0, r0 * r0 - xi * xi));
  const top: [number, number] = [0.5 + xi, 0.5 - yi];
  const phi = Math.atan2(yi, xi);
  const psi = Math.atan2(yi, xi - d);
  return [
    M(top[0] * w, top[1] * h),
    // Outer circle, the long way round through the left...
    ...arcCubics(0.5 * w, 0.5 * h, r0 * w, r0 * h, -phi, -2 * Math.PI + phi),
    // ...then back along the inner circle's left edge.
    ...arcCubics((0.5 + d) * w, 0.5 * h, r1 * w, r1 * h, psi, 2 * Math.PI - psi),
    Z,
  ];
}

/** A donut: the outer ellipse with a smaller one cut out of the middle. */
function ring(w: number, h: number, p: ShapeParams): PathCmd[] {
  const inner = 1 - Math.max(0.05, Math.min(0.9, p.thickness)) * 0.85;
  return [
    ...ellipse(w / 2, h / 2, w / 2, h / 2),
    ...ellipseHole(w / 2, h / 2, (w / 2) * inner, (h / 2) * inner),
  ];
}

/** An arrow pointing both ways: a shaft with a head at each end. */
function doubleArrow(w: number, h: number, p: ShapeParams): PathCmd[] {
  const head = Math.min(w / 2, Math.max(2, h * p.headSize + h * 0.2));
  const half = (h * Math.max(0.02, Math.min(1, p.thickness))) / 2;
  const cy = h / 2;
  return [
    M(0, cy), L(head, 0), L(head, cy - half), L(w - head, cy - half), L(w - head, 0),
    L(w, cy), L(w - head, h), L(w - head, cy + half), L(head, cy + half), L(head, h), Z,
  ];
}

/** A map pin: a teardrop pointing down with a round hole. */
function pin(w: number, h: number): PathCmd[] {
  return [
    ...unitPath(w, h, [
      ['M', 0.5, 1],
      ['C', 0.5, 1, 0.08, 0.62, 0.08, 0.38],
      ['C', 0.08, 0.17, 0.27, 0, 0.5, 0],
      ['C', 0.73, 0, 0.92, 0.17, 0.92, 0.38],
      ['C', 0.92, 0.62, 0.5, 1, 0.5, 1],
    ]),
    ...ellipseHole(0.5 * w, 0.38 * h, 0.17 * w, 0.17 * h),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The path's own extent, which is NOT always the `w × h` box.
 *
 * A speech bubble's tail and a heart's lobes deliberately overshoot. The rasterizer sizes its
 * bitmap from this, so a tail dragged outside the box is drawn rather than clipped.
 */
export function pathBounds(cmds: readonly PathCmd[]): { x: number; y: number; w: number; h: number } {
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
  for (const cmd of cmds) {
    if (cmd.c === 'Z') continue;
    hit(cmd.x, cmd.y);
    // Control points are included rather than solved for: the true curve stays inside its
    // control hull, so this over-estimates by a few px and never under-estimates. For sizing a
    // bitmap that is the correct direction to be wrong in.
    if (cmd.c === 'C') {
      hit(cmd.x1, cmd.y1);
      hit(cmd.x2, cmd.y2);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Display names for the picker. */
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rectangle: 'Rectangle',
  'rounded-rectangle': 'Rounded Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  line: 'Line',
  arrow: 'Arrow',
  star: 'Star',
  polygon: 'Polygon',
  heart: 'Heart',
  diamond: 'Diamond',
  chevron: 'Chevron',
  'speech-bubble': 'Speech Bubble',
  callout: 'Callout',
  plus: 'Plus',
  cross: 'Cross',
  lightning: 'Lightning Bolt',
  cloud: 'Cloud',
  crescent: 'Crescent Moon',
  ring: 'Ring',
  hexagon: 'Hexagon',
  octagon: 'Octagon',
  parallelogram: 'Parallelogram',
  trapezoid: 'Trapezoid',
  'right-triangle': 'Right Triangle',
  'double-arrow': 'Double Arrow',
  checkmark: 'Checkmark',
  droplet: 'Droplet',
  shield: 'Shield',
  ribbon: 'Ribbon',
  bookmark: 'Bookmark',
  pin: 'Map Pin',
  sparkle: 'Sparkle',
};

export const SHAPE_KINDS: readonly ShapeKind[] = Object.keys(SHAPE_LABELS) as ShapeKind[];
