/**
 * Canvas rotate / flip — a geometry check, not a pixel check.
 *
 * `rotateCanvas` and `flipCanvas` claim to be RIGID: turning the frame must move every layer
 * exactly where the canvas map sends it, changing nothing about the composition but its
 * orientation. That claim is falsifiable, so it is tested rather than eyeballed.
 *
 * The assertion is deliberately NOT "do the transform fields look plausible". It maps every
 * layer's four drawn corners through the same `layerCorners()` the selection box and hit-testing
 * use, and compares against the corners pushed through the canvas map directly. If this passes,
 * what the user sees and what they can click are both right — checking fields would prove
 * neither.
 *
 * Unlike its siblings this harness needs no Electron and no GPU: canvas orientation is pure
 * geometry, and a check that runs in 200ms gets run.
 *
 * ── THE THREE CASES THAT ACTUALLY BITE ───────────────────────────────────────
 * Each layer in the fixture exists to catch one specific way of getting this wrong. All three
 * were confirmed to FAIL against a deliberately broken build before being trusted:
 *
 *   `img`   a bitmap, fit 'contain'. Its drawn size is an aspect-fit of the canvas, so a quarter
 *           turn changes the frame it fits into. Without the base-size compensation it silently
 *           resizes — 149px of error, and ONLY on the quarter turns, which is exactly the kind of
 *           bug that survives a round-trip test.
 *   `shape` a leaf, fit 'exact', rotated AND flipped AND non-uniformly scaled — the combination
 *           that catches getting `S(-1,1)·R(θ) = R(-θ)·S(-1,1)` backwards.
 *   `grp`   a group with its own non-identity transform, holding a child. A group flattens into a
 *           canvas-SIZED buffer, so its children move with the recursion and its own transform
 *           must be conjugated, not composed. Treating it like a leaf turns its contents twice:
 *           185px of error.
 *
 * The round-trip case (four right turns == identity) is kept, but note it passes against the
 * broken-group build. It is a cheap smoke test, not the real assertion.
 */

import { rotateCanvas, flipCanvas, layerCorners, fitModeOf } from '@opencut/photo';

const t = (p = {}) => ({
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
  anchorX: 0.5, anchorY: 0.5, flipH: false, flipV: false, ...p,
});
const leaf = (id, kind, extra) => ({
  id, kind, name: id, visible: true, locked: false, opacity: 1,
  blendMode: 'normal', effects: [], mask: null, ...extra,
});

const DOC = {
  schemaVersion: 4, id: 'd1', name: 'test', createdAt: 0, modifiedAt: 0,
  width: 800, height: 600, background: '#00000000', media: [],
  selection: {
    regions: [
      { kind: 'rect', combine: 'replace', x: 100, y: 50, width: 200, height: 120 },
      { kind: 'path', combine: 'add', contours: [[{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 90 }]] },
    ],
    feather: 0, expand: 0, inverted: false,
  },
  layers: [
    leaf('img', 'image', {
      assetId: 'a1',
      transform: t({ x: 120, y: -40, rotation: 25, scaleX: 1.3, scaleY: 1.3 }),
    }),
    leaf('shape', 'shape', {
      shape: 'rect', params: {}, width: 160, height: 90,
      fill: { kind: 'solid', color: '#ffffff' }, stroke: null, shadow: null, glow: null,
      transform: t({ x: -200, y: 130, rotation: -40, flipH: true, scaleX: 0.8, scaleY: 1.4 }),
    }),
    leaf('grp', 'group', {
      transform: t({ x: 60, y: 20, rotation: 15, scaleX: 1.2, scaleY: 0.7 }),
      children: [
        leaf('child', 'shape', {
          shape: 'ellipse', params: {}, width: 100, height: 60,
          fill: { kind: 'solid', color: '#ff0000' }, stroke: null, shadow: null, glow: null,
          transform: t({ x: -90, y: 40, rotation: 10 }),
        }),
      ],
    }),
  ],
};

const NATURAL = {
  img: { width: 1600, height: 900 },
  shape: { width: 160, height: 90 },
  child: { width: 100, height: 60 },
};
const natural = (l) => NATURAL[l.id] ?? { width: 100, height: 100 };

/**
 * A group's own matrix, about the canvas centre — its buffer is canvas-sized, so its children's
 * canvas-space corners are mapped through this to get what is finally drawn.
 */
function groupMatrix(g, canvas) {
  const tr = g.transform;
  const r = (tr.rotation * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const sx = tr.scaleX * (tr.flipH ? -1 : 1);
  const sy = tr.scaleY * (tr.flipV ? -1 : 1);
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  return { a, b, c, d, e: cx + tr.x - (a * cx + c * cy), f: cy + tr.y - (b * cx + d * cy) };
}

/** Every drawn leaf's four corners in canvas pixels, in draw order. */
function corners(doc) {
  const canvas = { width: doc.width, height: doc.height };
  const out = [];
  const walk = (layers, group) => {
    for (const l of layers) {
      if (l.kind === 'group') { walk(l.children, l); continue; }
      let pts = layerCorners(l.transform, natural(l), canvas, fitModeOf(l));
      if (group) {
        const m = groupMatrix(group, canvas);
        pts = pts.map((p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }));
      }
      out.push({ id: l.id, pts });
    }
  };
  walk(doc.layers, null);
  return out;
}

// The canvas maps, written out independently of the implementation so the test is a second
// opinion rather than a restatement.
const CASES = {
  rotate_90_right: { cmd: () => rotateCanvas(1, natural), size: (c) => [c.height, c.width],
    pt: (p, c) => ({ x: c.height - p.y, y: p.x }) },
  rotate_180: { cmd: () => rotateCanvas(2, natural), size: (c) => [c.width, c.height],
    pt: (p, c) => ({ x: c.width - p.x, y: c.height - p.y }) },
  rotate_90_left: { cmd: () => rotateCanvas(3, natural), size: (c) => [c.height, c.width],
    pt: (p, c) => ({ x: p.y, y: c.width - p.x }) },
  flip_horizontal: { cmd: () => flipCanvas('h', natural), size: (c) => [c.width, c.height],
    pt: (p, c) => ({ x: c.width - p.x, y: p.y }) },
  flip_vertical: { cmd: () => flipCanvas('v', natural), size: (c) => [c.width, c.height],
    pt: (p, c) => ({ x: p.x, y: c.height - p.y }) },
};

const EPS = 1e-6;
const canvas = { width: DOC.width, height: DOC.height };
const before = corners(DOC);
const result = {};
let ok = true;

for (const [name, c] of Object.entries(CASES)) {
  const next = c.cmd().apply(DOC);
  const after = corners(next);
  const [w, h] = c.size(canvas);

  let worst = 0, worstId = '';
  for (let i = 0; i < before.length; i++) {
    if (before[i].id !== after[i].id) { worst = Infinity; worstId = 'ORDER CHANGED'; break; }
    for (let j = 0; j < 4; j++) {
      const want = c.pt(before[i].pts[j], canvas);
      const err = Math.hypot(want.x - after[i].pts[j].x, want.y - after[i].pts[j].y);
      if (err > worst) { worst = err; worstId = before[i].id; }
    }
  }

  // The marquee has to ride along, or the next edit is clipped to a region of the OLD frame.
  const r = next.selection.regions[0];
  const a = c.pt({ x: 100, y: 50 }, canvas);
  const b = c.pt({ x: 300, y: 170 }, canvas);
  const selErr = Math.hypot(Math.min(a.x, b.x) - r.x, Math.min(a.y, b.y) - r.y);
  const pathPt = next.selection.regions[1].contours[0][0];
  const pathWant = c.pt({ x: 10, y: 20 }, canvas);
  const pathErr = Math.hypot(pathWant.x - pathPt.x, pathWant.y - pathPt.y);

  const pass = worst < EPS && selErr < EPS && pathErr < EPS && next.width === w && next.height === h;
  ok &&= pass;
  result[name] = {
    pass, size: `${next.width}x${next.height}`, expectedSize: `${w}x${h}`,
    worstCornerError: worst, worstLayer: worstId, selectionError: selErr, pathError: pathErr,
  };
}

// Four right turns is the identity. Cheap, and it does NOT subsume the cases above.
let spun = DOC;
for (let i = 0; i < 4; i++) spun = rotateCanvas(1, natural).apply(spun);
const spunPts = corners(spun);
let rt = 0;
for (let i = 0; i < before.length; i++)
  for (let j = 0; j < 4; j++)
    rt = Math.max(rt, Math.hypot(before[i].pts[j].x - spunPts[i].pts[j].x, before[i].pts[j].y - spunPts[i].pts[j].y));
const rtPass = rt < EPS && spun.width === DOC.width && spun.height === DOC.height;
ok &&= rtPass;
result.four_right_turns_is_identity = { pass: rtPass, error: rt, size: `${spun.width}x${spun.height}` };

// Angles must land clean, not drift by floating-point dust across repeated turns.
const angles = rotateCanvas(1, natural).apply(DOC).layers.map((l) => [l.id, l.transform.rotation]);
const anglesPass = angles.every(([, deg]) => Number.isFinite(deg) && Math.abs(deg) <= 180);
ok &&= anglesPass;
result.angles_stay_in_slider_range = { pass: anglesPass, angles };

result.ok = ok;
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
