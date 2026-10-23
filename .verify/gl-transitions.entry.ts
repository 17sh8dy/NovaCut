/**
 * GL Transitions GPU harness: every registered shader is compiled and drawn on a real WebGL2
 * context, through the same GlTransitions adapter the compositor uses.
 *
 *   npm run verify:gltransitions
 *
 * Hard failures (these are what the exit code is for):
 *   - a shader that does not compile or link
 *   - progress 0 / 1 that is not the exact outgoing / incoming frame
 *   - the wrong picture orientation (the four directional wipes, solid colours)
 *   - a draw that raises a GL error, at any of four aspect ratios
 *   - two identical draws that disagree (non-determinism would break preview/export parity)
 *   - a broken shader that is retried, reported more than once, or throws
 *   - parameter defaults that do not behave as defaults
 *
 * Measured and REPORTED, not failed (a shader is never excluded for imperfect endpoints):
 *   - how far each shader's RAW output is from the exact frame at progress 0 and 1
 *   - how big a jump the forced endpoint makes against the first frame just inside the window,
 *     compared with the ordinary frame-to-frame step there ("is it still smooth?")
 *   - render cost per shader, as data for later preview-resolution tiers
 */

import { GLContext, GlTransitions, type Fbo } from '@opencut/engine';
import { getTransitionDef, registerBuiltins, GL_TRANSITIONS, type TransitionDefinition } from '@opencut/core';

window.addEventListener('error', (e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e.message) })));
window.addEventListener('unhandledrejection', (e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: 'rejection: ' + String(e.reason) })));

registerBuiltins();

const results: Record<string, unknown> = {};
let failures = 0;
const check = (name: string, pass: boolean, detail?: Record<string, unknown>) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};
const info = (name: string, data: unknown) => {
  results[name] = data;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────

/** Paint something recognisably asymmetric: a gradient and a marker block in ONE corner. */
function paint(w: number, h: number, kind: 'from' | 'to' | 'red' | 'blue'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  if (kind === 'red' || kind === 'blue') {
    g.fillStyle = kind === 'red' ? '#ff0000' : '#0000ff';
    g.fillRect(0, 0, w, h);
    return c;
  }
  const grad = g.createLinearGradient(0, 0, w, h);
  if (kind === 'from') {
    grad.addColorStop(0, '#d62828');
    grad.addColorStop(1, '#f7b801');
  } else {
    grad.addColorStop(0, '#1d3557');
    grad.addColorStop(1, '#2ec4b6');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = kind === 'from' ? '#ffffff' : '#ffe14d';
  // top-left for the outgoing frame, bottom-right for the incoming one
  if (kind === 'from') g.fillRect(w * 0.06, h * 0.08, w * 0.22, h * 0.22);
  else g.fillRect(w * 0.72, h * 0.7, w * 0.22, h * 0.22);
  g.fillStyle = '#00000066';
  for (let i = 0; i < 6; i++) g.fillRect(w * (0.1 + i * 0.13), h * 0.45, w * 0.05, h * 0.1);
  return c;
}

interface Rig {
  w: number;
  h: number;
  ctx: GLContext;
  gts: GlTransitions;
  fromTex: WebGLTexture;
  toTex: WebGLTexture;
  target: Fbo;
  fromPx: Uint8ClampedArray; // top-down, as painted
  toPx: Uint8ClampedArray;
}

function rig(w: number, h: number, kinds: ['from' | 'red', 'to' | 'blue'] = ['from', 'to']): Rig {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = new GLContext(canvas);
  const gts = new GlTransitions(ctx);
  const a = paint(w, h, kinds[0]);
  const b = paint(w, h, kinds[1]);
  const fromTex = ctx.createTexture();
  const toTex = ctx.createTexture();
  ctx.uploadFrame(fromTex, a);
  ctx.uploadFrame(toTex, b);
  return {
    w, h, ctx, gts, fromTex, toTex,
    target: ctx.createFbo(w, h),
    fromPx: a.getContext('2d')!.getImageData(0, 0, w, h).data,
    toPx: b.getContext('2d')!.getImageData(0, 0, w, h).data,
  };
}

/** Draw into the rig's FBO and read it back. Row 0 of the result is the BOTTOM row (GL order). */
function render(r: Rig, def: TransitionDefinition, progress: number, values: Record<string, number> = {}, raw = false, src?: string): { px: Uint8Array; ok: boolean; glError: number } {
  const { gl } = r.ctx;
  r.ctx.bindTarget(r.target, r.w, r.h);
  r.ctx.clear(0, 0, 0, 0);
  r.ctx.disableBlend();
  gl.getError(); // drain anything stale so an error below is ours
  const ok = r.gts.draw(def, { from: r.fromTex, to: r.toTex, progress, ratio: r.w / r.h, values, rawEndpoints: raw }, src);
  const glError = gl.getError();
  const px = new Uint8Array(r.w * r.h * 4);
  gl.readPixels(0, 0, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { px, ok, glError };
}

/** Mean absolute channel difference (0..255) between a GL-order readback and a top-down image. */
function diffToImage(gl: Uint8Array, img: Uint8ClampedArray, w: number, h: number): number {
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (y * w + x) * 4;
      const b = ((h - 1 - y) * w + x) * 4;
      sum += Math.abs(gl[a]! - img[b]!) + Math.abs(gl[a + 1]! - img[b + 1]!) + Math.abs(gl[a + 2]! - img[b + 2]!);
    }
  }
  return sum / (w * h * 3);
}
function maxDiffToImage(gl: Uint8Array, img: Uint8ClampedArray, w: number, h: number): number {
  let m = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (y * w + x) * 4;
      const b = ((h - 1 - y) * w + x) * 4;
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(gl[a + c]! - img[b + c]!));
    }
  }
  return m;
}
const diffGL = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  return sum / ((a.length / 4) * 3);
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const defs = GL_TRANSITIONS.map((m) => getTransitionDef(`gl:${m.name}`)!);
const W = 256;
const H = 144;
const main = rig(W, H);

// ── 1. Compile every shader ──────────────────────────────────────────────────────
{
  const failed: { name: string; reason: string }[] = [];
  const t0 = performance.now();
  for (const d of defs) {
    const reason = main.gts.compile(d.gl!.name);
    if (reason) failed.push({ name: d.gl!.name, reason });
  }
  check('all_shaders_compile', failed.length === 0, { count: defs.length, failed: failed.slice(0, 12), ms: Math.round(performance.now() - t0) });
}

// ── 2. Endpoints are the exact frames ────────────────────────────────────────────
{
  const off: { name: string; end: number; max: number }[] = [];
  for (const d of defs) {
    if (main.gts.brokenReason(d.gl!.name)) continue;
    const p0 = render(main, d, 0);
    const p1 = render(main, d, 1);
    const m0 = maxDiffToImage(p0.px, main.fromPx, W, H);
    const m1 = maxDiffToImage(p1.px, main.toPx, W, H);
    if (m0 > 1) off.push({ name: d.gl!.name, end: 0, max: m0 });
    if (m1 > 1) off.push({ name: d.gl!.name, end: 1, max: m1 });
  }
  check('endpoints_are_exact_frames', off.length === 0, { offenders: off.slice(0, 10) });
}

// ── 3. How imperfect are the RAW endpoints, and is the transition smooth next to them? ──
{
  const STEP = 0.02;
  const rows: { name: string; raw0: number; raw1: number; jump0: number; jump1: number; step: number }[] = [];
  for (const d of defs) {
    if (main.gts.brokenReason(d.gl!.name)) continue;
    const raw0 = diffToImage(render(main, d, 0, {}, true).px, main.fromPx, W, H);
    const raw1 = diffToImage(render(main, d, 1, {}, true).px, main.toPx, W, H);
    const forced0 = render(main, d, 0).px;
    const forced1 = render(main, d, 1).px;
    const a = render(main, d, STEP).px;
    const b = render(main, d, STEP * 2).px;
    const y = render(main, d, 1 - STEP).px;
    const jump0 = diffGL(forced0, a);
    const jump1 = diffGL(y, forced1);
    const step = diffGL(a, b);
    rows.push({ name: d.gl!.name, raw0: +raw0.toFixed(2), raw1: +raw1.toFixed(2), jump0: +jump0.toFixed(2), jump1: +jump1.toFixed(2), step: +step.toFixed(2) });
  }
  const drift = rows.filter((r) => r.raw0 > 0.5 || r.raw1 > 0.5);
  // "Not smooth": the forced endpoint jumps to the next frame by far more than the next two ordinary frames do.
  const popping = rows
    .filter((r) => Math.max(r.jump0, r.jump1) > Math.max(8, 4 * r.step))
    .sort((p, q) => Math.max(q.jump0, q.jump1) - Math.max(p.jump0, p.jump1));
  info('endpoint_report', {
    shaders: rows.length,
    rawEndpointDrift: drift.length,
    driftWorst: drift.sort((p, q) => Math.max(q.raw0, q.raw1) - Math.max(p.raw0, p.raw1)).slice(0, 12),
    notSmoothNearEndpoint: popping.length,
    notSmoothWorst: popping.slice(0, 20),
  });
}

// ── 4. Orientation: the four directional wipes, in solid colours ─────────────────
{
  const solid = rig(W, H, ['red', 'blue']);
  const at = (px: Uint8Array, fx: number, fy: number) => {
    const x = Math.floor(fx * (W - 1));
    const y = Math.floor(fy * (H - 1)); // GL order: fy 0 is the bottom
    const i = (y * W + x) * 4;
    return px[i]! > 200 && px[i + 2]! < 55 ? 'red' : px[i + 2]! > 200 && px[i]! < 55 ? 'blue' : `other(${px[i]},${px[i + 1]},${px[i + 2]})`;
  };
  // The library's own convention is y-up. `to` (blue) arrives from: wipeUp = bottom, wipeDown = top,
  // wipeLeft = right, wipeRight = left.
  const cases: [string, [number, number, string][]][] = [
    ['wipeUp', [[0.5, 0.2, 'blue'], [0.5, 0.8, 'red']]],
    ['wipeDown', [[0.5, 0.8, 'blue'], [0.5, 0.2, 'red']]],
    ['wipeLeft', [[0.8, 0.5, 'blue'], [0.2, 0.5, 'red']]],
    ['wipeRight', [[0.2, 0.5, 'blue'], [0.8, 0.5, 'red']]],
  ];
  const wrong: string[] = [];
  for (const [name, probes] of cases) {
    const d = getTransitionDef(`gl:${name}`)!;
    const { px } = render(solid, d, 0.5);
    for (const [fx, fy, want] of probes) {
      const got = at(px, fx, fy);
      if (got !== want) wrong.push(`${name} @(${fx},${fy}) wanted ${want} got ${got}`);
    }
  }
  check('orientation_matches_the_library', wrong.length === 0, { wrong });
}

// ── 5. Determinism ───────────────────────────────────────────────────────────────
{
  const flaky: string[] = [];
  for (const d of defs) {
    if (main.gts.brokenReason(d.gl!.name)) continue;
    const a = render(main, d, 0.37).px;
    const b = render(main, d, 0.37).px;
    if (!same(a, b)) flaky.push(d.gl!.name);
  }
  check('draws_are_deterministic', flaky.length === 0, { flaky });
}

// ── 6. Aspect ratios and resolutions ─────────────────────────────────────────────
{
  const sizes: [number, number, string][] = [[256, 144, '16:9'], [144, 256, '9:16'], [192, 192, '1:1'], [336, 144, '21:9'], [96, 54, 'tiny']];
  const glErrors: string[] = [];
  const blank: string[] = [];
  for (const [w, h, label] of sizes) {
    const r = rig(w, h);
    for (const d of defs) {
      if (r.gts.brokenReason(d.gl!.name)) continue;
      const { px, glError, ok } = render(r, d, 0.5);
      if (!ok || glError !== 0) glErrors.push(`${d.gl!.name}@${label} err=${glError} ok=${ok}`);
      let allSame = true;
      for (let i = 4; i < px.length && allSame; i += 4) if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) allSame = false;
      if (allSame) blank.push(`${d.gl!.name}@${label}`);
    }
  }
  check('no_gl_errors_at_any_aspect', glErrors.length === 0, { errors: glErrors.slice(0, 10), sizes: sizes.map((s) => s[2]) });
  info('flat_frames_at_midpoint', { count: blank.length, sample: blank.slice(0, 12) });
  // A shader that is a single flat colour at ONE progress can be perfectly correct (a circle crop is
  // fully its background colour at exactly 0.5). One that is flat at EVERY progress is broken.
  const isFlat = (px: Uint8Array): boolean => {
    for (let i = 4; i < px.length; i += 4) if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) return false;
    return true;
  };
  const alwaysFlat: string[] = [];
  const midpointOnly = new Set(blank.map((b) => b.split('@')[0]!));
  for (const name of midpointOnly) {
    const d = getTransitionDef(`gl:${name}`)!;
    if ([0.1, 0.25, 0.4, 0.6, 0.75, 0.9].every((pg) => isFlat(render(main, d, pg).px))) alwaysFlat.push(name);
  }
  check('no_shader_is_flat_at_every_progress', alwaysFlat.length === 0, { flatAtMidpoint: [...midpointOnly], alwaysFlat });
}

// ── 7. A broken shader is handled once, quietly ──────────────────────────────────
{
  const r = rig(64, 36);
  const fake: TransitionDefinition = { type: 'gl:broken-test', label: 'Broken', render: 'gl:broken-test', params: [], hidden: true, gl: { name: 'broken-test', bindings: [] } };
  const reports: string[] = [];
  r.gts.onBroken = (n, why) => reports.push(`${n}: ${why}`);
  const before = r.gts.compileAttempts;
  let threw = false;
  const outcomes: boolean[] = [];
  try {
    for (let i = 0; i < 12; i++) outcomes.push(render(r, fake, 0.5, {}, false, 'vec4 transition(vec2 uv) { return thisDoesNotExist(uv); }').ok);
  } catch {
    threw = true;
  }
  check('broken_shader_does_not_throw', !threw);
  check('broken_shader_reports_failure_every_frame_but_never_draws', outcomes.every((o) => o === false), { outcomes });
  check('broken_shader_compiled_once', r.gts.compileAttempts - before === 1, { attempts: r.gts.compileAttempts - before });
  check('broken_shader_reported_once', reports.length === 1 && reports[0]!.length > 0, { reports });
  const missing: TransitionDefinition = { ...fake, type: 'gl:nope', gl: { name: 'does-not-exist', bindings: [] } };
  const m1 = render(r, missing, 0.5).ok;
  const m2 = render(r, missing, 0.5).ok;
  check('unknown_shader_name_is_handled', m1 === false && m2 === false && r.gts.brokenReason('does-not-exist') !== undefined && reports.length === 2, { reports });
  const good = render(r, getTransitionDef('gl:wipeUp')!, 0.5);
  check('context_is_healthy_after_failures', good.ok && good.glError === 0);
  // Endpoint forcing must still work for a broken shader: the neighbouring clips stay visible.
  const edge = render(r, fake, 0);
  check('broken_shader_endpoints_still_show_the_clips', edge.ok === true && maxDiffToImage(edge.px, r.fromPx, 64, 36) <= 1);
}

// ── 8. Parameters ────────────────────────────────────────────────────────────────
{
  const bad: string[] = [];
  const unresponsive: string[] = [];
  const parametrised = defs.filter((d) => d.gl!.bindings.length > 0 && !main.gts.brokenReason(d.gl!.name));
  for (const d of parametrised) {
    const dflt: Record<string, number> = {};
    for (const p of d.params) dflt[p.key] = p.default;
    const none = render(main, d, 0.5, {}).px; // nothing given: shader falls back to its own defaults
    const explicit = render(main, d, 0.5, dflt).px;
    if (!same(none, explicit)) bad.push(d.gl!.name);
    // does moving a parameter to its far end change the picture at all?
    let responded = false;
    for (const pg of [0.3, 0.5, 0.7]) {
      const base = render(main, d, pg, dflt).px;
      for (const p of d.params) {
        for (const v of [p.min, p.max]) {
          if (v === p.default) continue;
          if (!same(render(main, d, pg, { ...dflt, [p.key]: v }).px, base)) responded = true;
        }
      }
    }
    if (!responded) unresponsive.push(d.gl!.name);
  }
  check('missing_params_fall_back_to_defaults', bad.length === 0, { bad });
  info('params_that_change_nothing_at_0.3_0.5_0.7', { parametrised: parametrised.length, count: unresponsive.length, sample: unresponsive.slice(0, 15) });
  // Spot-check three specific shaders respond, so "unresponsive" cannot hide a binding bug.
  const resp = (name: string, key: string, v: number): boolean => {
    const d = getTransitionDef(`gl:${name}`)!;
    return !same(render(main, d, 0.5, {}).px, render(main, d, 0.5, { [key]: v }).px);
  };
  const cc = getTransitionDef('gl:CircleCrop')!;
  check('vec4_colour_param_binds', resp('CircleCrop', 'bgcolor.r', 1) && cc.params.some((p) => p.key === 'bgcolor.r'));
  check('vec2_param_binds', resp('Directional', 'direction.x', 1));
  check('float_param_binds', resp('cube', 'persp', 0.1));
  const rl = getTransitionDef('gl:Rolls')!;
  check('bool_param_binds', rl.params.some((p) => p.key === 'RotDown') && resp('Rolls', 'RotDown', 1));
  const gf = getTransitionDef('gl:GridFlip')!;
  check('ivec2_param_binds', gf.params.some((p) => p.key === 'size.x') && resp('GridFlip', 'size.x', 9));
}

// ── 8b. Texture shaders: every built-in map draws, differs, and is stable ────────
{
  const bad: string[] = [];
  const outputs = new Map<string, Uint8Array[]>();
  for (const name of ['luma', 'displacement']) {
    const d = getTransitionDef(`gl:${name}`)!;
    const key = d.params.find((p) => p.key.endsWith('.map'))!.key;
    const imgs: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) {
      const a = render(main, d, 0.5, { [key]: i });
      const b = render(main, d, 0.5, { [key]: i });
      if (!a.ok || a.glError !== 0) bad.push(`${name}[${i}] failed (ok=${a.ok} err=${a.glError})`);
      if (!same(a.px, b.px)) bad.push(`${name}[${i}] is not deterministic`);
      imgs.push(a.px);
    }
    outputs.set(name, imgs);
  }
  check('texture_shaders_draw_with_every_map', bad.length === 0, { bad });
  const distinct = (xs: Uint8Array[]) => new Set(xs.map((p) => p.reduce((h, v, i) => (i % 97 === 0 ? (h * 31 + v) | 0 : h), 7))).size;
  check('different_maps_give_different_pictures', distinct(outputs.get('luma')!) >= 6 && distinct(outputs.get('displacement')!) >= 4,
    { luma: distinct(outputs.get('luma')!), displacement: distinct(outputs.get('displacement')!) });
  const lumaLeft = render(main, getTransitionDef('gl:luma')!, 0.5, { 'luma.map': 0 }).px;
  // map 0 is dark on the LEFT: the incoming clip must have arrived there first (to = cool, from = warm)
  const at = (px: Uint8Array, fx: number) => {
    const x = Math.floor(fx * (W - 1));
    const y = Math.floor(0.5 * (H - 1));
    const i = (y * W + x) * 4;
    return px[i + 2]! > px[i]!; // bluer than red = the incoming clip
  };
  check('luma_left_to_right_map_reveals_the_left_first', at(lumaLeft, 0.1) && !at(lumaLeft, 0.9), { left: at(lumaLeft, 0.1), right: at(lumaLeft, 0.9) });
  check('texture_shader_endpoints_are_exact', (() => {
    const d = getTransitionDef('gl:displacement')!;
    return maxDiffToImage(render(main, d, 0).px, main.fromPx, W, H) <= 1 && maxDiffToImage(render(main, d, 1).px, main.toPx, W, H) <= 1;
  })());
}

// ── 9. Cost ─────────────────────────────────────────────────────────────────────
{
  const w = 1280;
  const h = 720;
  const r = rig(w, h);
  const t0 = performance.now();
  const costs: { name: string; ms: number }[] = [];
  let partial = false;
  for (const d of defs) {
    if (performance.now() - t0 > 25000) { partial = true; break; }
    if (r.gts.brokenReason(d.gl!.name)) continue;
    render(r, d, 0.5); // warm: compile + first upload
    const gl = r.ctx.gl;
    gl.finish();
    const s = performance.now();
    for (let i = 0; i < 3; i++) render(r, d, 0.3 + i * 0.2);
    gl.finish();
    costs.push({ name: d.gl!.name, ms: +((performance.now() - s) / 3).toFixed(2) });
  }
  costs.sort((a, b) => b.ms - a.ms);
  const sorted = [...costs].map((c) => c.ms).sort((a, b) => a - b);
  info('render_cost_720p_ms', {
    measured: costs.length,
    partial,
    median: sorted[Math.floor(sorted.length / 2)],
    slowest: costs.slice(0, 10),
    renderer: String(r.ctx.gl.getParameter(r.ctx.gl.RENDERER)),
  });
}

console.log('__RESULT__' + JSON.stringify({ ...results, ok: failures === 0, failures }));
