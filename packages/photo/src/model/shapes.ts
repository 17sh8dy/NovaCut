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
  | 'callout';

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
};

export const SHAPE_KINDS: readonly ShapeKind[] = Object.keys(SHAPE_LABELS) as ShapeKind[];
