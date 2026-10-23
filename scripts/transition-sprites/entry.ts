/**
 * Renders the Transitions browser's thumbnail strips: seven REAL frames of every registered
 * transition, from the same shaders the editor and the exporter use, packed into one atlas.
 *
 *   npm run gl-transition-sprites
 *
 * Page side of the generator: it draws into a canvas and hands the finished WebP plus the
 * type -> row index to host.cjs, which writes them into packages/ui. Nothing here is hand-drawn,
 * so a transition that changes (or a new one) gets a correct thumbnail by re-running this.
 */

import { GLContext, GlTransitions, TRANSITION_VERTEX_SHADER, getTransitionFragment } from '@opencut/engine';
import { allTransitions, registerBuiltins, type TransitionDefinition } from '@opencut/core';

registerBuiltins();

const FRAMES = [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88];
const REST = 3; // the resting thumbnail is the middle frame
const RW = 320; // render size
const RH = 180;
const FW = 160; // frame size in the atlas
const FH = 90;
const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Two visibly different scenes, each marked so direction and "which clip is which" are obvious. */
function scene(kind: 'from' | 'to'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = RW;
  c.height = RH;
  const g = c.getContext('2d')!;
  if (kind === 'from') {
    const sky = g.createLinearGradient(0, 0, 0, RH);
    sky.addColorStop(0, '#2b1055');
    sky.addColorStop(0.45, '#d4476b');
    sky.addColorStop(0.75, '#ff9a3c');
    sky.addColorStop(1, '#ffd166');
    g.fillStyle = sky;
    g.fillRect(0, 0, RW, RH);
    g.fillStyle = '#fff3c4';
    g.beginPath();
    g.arc(RW * 0.68, RH * 0.55, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a1c3d';
    g.beginPath();
    g.moveTo(0, RH);
    g.lineTo(0, RH * 0.72);
    g.lineTo(RW * 0.18, RH * 0.5);
    g.lineTo(RW * 0.34, RH * 0.7);
    g.lineTo(RW * 0.52, RH * 0.45);
    g.lineTo(RW * 0.78, RH * 0.78);
    g.lineTo(RW, RH * 0.6);
    g.lineTo(RW, RH);
    g.fill();
  } else {
    const sky = g.createLinearGradient(0, 0, 0, RH);
    sky.addColorStop(0, '#031d44');
    sky.addColorStop(0.6, '#0a4f7a');
    sky.addColorStop(1, '#13c4b4');
    g.fillStyle = sky;
    g.fillRect(0, 0, RW, RH);
    g.fillStyle = '#e8f6ff';
    g.beginPath();
    g.arc(RW * 0.25, RH * 0.28, 16, 0, Math.PI * 2);
    g.fill();
    const rects = [[0.05, 0.62, 0.08], [0.15, 0.48, 0.07], [0.25, 0.58, 0.09], [0.4, 0.4, 0.08], [0.52, 0.55, 0.07], [0.62, 0.35, 0.1], [0.76, 0.52, 0.08], [0.87, 0.45, 0.09]];
    for (const [x, y, w] of rects) {
      g.fillStyle = '#061426';
      g.fillRect(RW * x!, RH * y!, RW * w!, RH * (0.82 - y!));
      g.fillStyle = '#ffd166';
      for (let r = 0; r < 4; r++) for (let q = 0; q < 2; q++) g.fillRect(RW * x! + 5 + q * (RW * w! * 0.45), RH * y! + 7 + r * 10, 3, 4);
    }
    g.fillStyle = '#0b3a5c';
    g.fillRect(0, RH * 0.82, RW, RH * 0.18);
  }
  return c;
}

const canvas = document.createElement('canvas');
canvas.width = RW;
canvas.height = RH;
const ctx = new GLContext(canvas);
const gts = new GlTransitions(ctx);
const fromTex = ctx.createTexture();
const toTex = ctx.createTexture();
ctx.uploadFrame(fromTex, scene('from'));
ctx.uploadFrame(toTex, scene('to'));
const target = ctx.createFbo(RW, RH);

/** Draw one frame of any transition, the way Compositor.renderTransition does. */
function draw(def: TransitionDefinition, progress: number): boolean {
  ctx.bindTarget(target, RW, RH);
  ctx.clear(0, 0, 0, 0);
  ctx.disableBlend();
  if (def.gl) return gts.draw(def, { from: fromTex, to: toTex, progress, ratio: RW / RH, values: {} });
  const prog = ctx.getProgram(`__transition:${def.render}`, TRANSITION_VERTEX_SHADER, getTransitionFragment(def.render));
  ctx.useProgram(prog);
  ctx.setUniformMat3(prog, 'u_model', IDENTITY);
  ctx.setUniform1f(prog, 'u_progress', progress);
  ctx.setUniform2f(prog, 'u_texel', 1 / RW, 1 / RH);
  for (const p of def.params) ctx.setUniform1f(prog, `u_${p.key}`, p.default);
  ctx.bindTexture(prog, 'u_from', fromTex, 0);
  ctx.bindTexture(prog, 'u_to', toTex, 1);
  ctx.drawQuad();
  return true;
}

const defs = allTransitions().slice().sort((a, b) => a.type.localeCompare(b.type));
const atlas = document.createElement('canvas');
atlas.width = FRAMES.length * FW;
atlas.height = defs.length * FH;
const ag = atlas.getContext('2d')!;
ag.fillStyle = '#16181d';
ag.fillRect(0, 0, atlas.width, atlas.height);

const scratch = document.createElement('canvas');
scratch.width = RW;
scratch.height = RH;
const sg = scratch.getContext('2d')!;
const px = new Uint8Array(RW * RH * 4);
const failed: string[] = [];
const rows: Record<string, number> = {};
/** Per transition, the frame that shows the most (a flat black or white frame is a useless thumbnail). */
const rests: Record<string, number> = {};

/** How much is going on in a frame: the variance of its pixels. Flat frames score ~0. */
function busyness(rgba: Uint8Array): number {
  let n = 0;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4 * 11) {
    n++;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c]!;
      sum[c]! += v;
      sq[c]! += v * v;
    }
  }
  return [0, 1, 2].reduce((t, c) => t + (sq[c]! / n - (sum[c]! / n) ** 2), 0);
}

defs.forEach((def, row) => {
  rows[def.type] = row;
  let best = REST;
  let bestScore = -1;
  FRAMES.forEach((p, col) => {
    const ok = draw(def, p);
    if (!ok) failed.push(`${def.type}@${p}`);
    ctx.gl.readPixels(0, 0, RW, RH, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, px);
    // Prefer the middle on a tie, and never the two outermost frames (they look like a plain clip).
    const score = busyness(px) * (col === 0 || col === FRAMES.length - 1 ? 0.5 : 1) * (col === REST ? 1.15 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = col;
    }
    const img = sg.createImageData(RW, RH);
    for (let y = 0; y < RH; y++) {
      for (let x = 0; x < RW; x++) {
        const s = ((RH - 1 - y) * RW + x) * 4; // GL rows are bottom-up
        const d = (y * RW + x) * 4;
        const a = px[s + 3]! / 255;
        // over the thumbnail's own backdrop, so a transparent area reads as empty, not white
        img.data[d] = Math.round(px[s]! * a + 22 * (1 - a));
        img.data[d + 1] = Math.round(px[s + 1]! * a + 24 * (1 - a));
        img.data[d + 2] = Math.round(px[s + 2]! * a + 29 * (1 - a));
        img.data[d + 3] = 255;
      }
    }
    sg.putImageData(img, 0, 0);
    ag.imageSmoothingQuality = 'high';
    ag.drawImage(scratch, col * FW, row * FH, FW, FH);
  });
  rests[def.type] = best;
});

const w = window as unknown as Record<string, unknown>;
w.__atlas = atlas.toDataURL('image/webp', 0.78);
w.__meta = { frames: FRAMES.length, rest: REST, rows, rests, count: defs.length, frameW: FW, frameH: FH, failed };
console.log('__DONE__');
