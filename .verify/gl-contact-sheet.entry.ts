/**
 * Contact sheet of the Featured GL transitions, rendered by the REAL adapter (GlTransitions) on a
 * real WebGL2 context, at 25%, 50% and 75% progress.
 *
 *   npm run verify:glsheet   ->  .verify/shots/gl-transitions-contact-sheet.png
 *
 * Review tooling only: it changes no transition code and asserts nothing. It also prints a few
 * simple measurements per transition (is a frame flat? did anything visibly happen?) so a person
 * looking at the sheet has numbers to go with what they see.
 */

import { GLContext, GlTransitions } from '@opencut/engine';
import { getTransitionDef, registerBuiltins, GL_TRANSITIONS } from '@opencut/core';

registerBuiltins();

const RW = 448; // render size (16:9); drawn smaller on the sheet for antialiasing
const RH = 252;
const FW = 224; // frame size on the sheet
const FH = 126;
const PROGRESS = [0.25, 0.5, 0.75];

/** Two images that are different in colour, subject and layout, each marked so direction is obvious. */
function scene(kind: 'from' | 'to'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = RW;
  c.height = RH;
  const g = c.getContext('2d')!;
  if (kind === 'from') {
    // warm sunset over mountains
    const sky = g.createLinearGradient(0, 0, 0, RH);
    sky.addColorStop(0, '#2b1055');
    sky.addColorStop(0.45, '#d4476b');
    sky.addColorStop(0.75, '#ff9a3c');
    sky.addColorStop(1, '#ffd166');
    g.fillStyle = sky;
    g.fillRect(0, 0, RW, RH);
    g.fillStyle = '#fff3c4';
    g.beginPath();
    g.arc(RW * 0.68, RH * 0.55, 34, 0, Math.PI * 2);
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
    g.fillStyle = '#ffffff';
    g.font = 'bold 54px Segoe UI, Arial, sans-serif';
    g.textBaseline = 'top';
    g.fillText('A', 14, 8);
  } else {
    // cool night city over water
    const sky = g.createLinearGradient(0, 0, 0, RH);
    sky.addColorStop(0, '#031d44');
    sky.addColorStop(0.6, '#0a4f7a');
    sky.addColorStop(1, '#13c4b4');
    g.fillStyle = sky;
    g.fillRect(0, 0, RW, RH);
    g.fillStyle = '#e8f6ff';
    g.beginPath();
    g.arc(RW * 0.25, RH * 0.28, 22, 0, Math.PI * 2);
    g.fill();
    const rects = [[0.05, 0.62, 0.08], [0.15, 0.48, 0.07], [0.25, 0.58, 0.09], [0.4, 0.4, 0.08], [0.52, 0.55, 0.07], [0.62, 0.35, 0.1], [0.76, 0.52, 0.08], [0.87, 0.45, 0.09]];
    for (const [x, y, w] of rects) {
      g.fillStyle = '#061426';
      g.fillRect(RW * x!, RH * y!, RW * w!, RH * (0.82 - y!));
      g.fillStyle = '#ffd166';
      for (let r = 0; r < 5; r++) for (let q = 0; q < 2; q++) g.fillRect(RW * x! + 6 + q * (RW * w! * 0.45), RH * y! + 8 + r * 12, 4, 5);
    }
    g.fillStyle = '#0b3a5c';
    g.fillRect(0, RH * 0.82, RW, RH * 0.18);
    g.fillStyle = '#ffffff';
    g.font = 'bold 54px Segoe UI, Arial, sans-serif';
    g.textBaseline = 'bottom';
    g.fillText('B', RW - 54, RH - 6);
  }
  return c;
}

const canvas = document.createElement('canvas');
canvas.width = RW;
canvas.height = RH;
const ctx = new GLContext(canvas);
const gts = new GlTransitions(ctx);
const fromImg = scene('from');
const toImg = scene('to');
const fromTex = ctx.createTexture();
const toTex = ctx.createTexture();
ctx.uploadFrame(fromTex, fromImg);
ctx.uploadFrame(toTex, toImg);
const target = ctx.createFbo(RW, RH);
const fromPx = fromImg.getContext('2d')!.getImageData(0, 0, RW, RH).data;
const toPx = toImg.getContext('2d')!.getImageData(0, 0, RW, RH).data;

/** Render one frame and return it as a top-down canvas plus a few numbers about it. */
function frame(name: string, progress: number) {
  const def = getTransitionDef(`gl:${name}`)!;
  const { gl } = ctx;
  ctx.bindTarget(target, RW, RH);
  ctx.clear(0, 0, 0, 0);
  ctx.disableBlend();
  const ok = gts.draw(def, { from: fromTex, to: toTex, progress, ratio: RW / RH, values: {} });
  const raw = new Uint8Array(RW * RH * 4);
  gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = document.createElement('canvas');
  out.width = RW;
  out.height = RH;
  const og = out.getContext('2d')!;
  const img = og.createImageData(RW, RH);
  let flat = true;
  let dFrom = 0;
  let dTo = 0;
  let transparent = 0;
  for (let y = 0; y < RH; y++) {
    for (let x = 0; x < RW; x++) {
      const s = ((RH - 1 - y) * RW + x) * 4; // GL rows are bottom-up
      const d = (y * RW + x) * 4;
      const a = raw[s + 3]! / 255;
      // composite over a dark checker-free backdrop so transparent areas read as "empty", not white
      img.data[d] = Math.round(raw[s]! * a + 18 * (1 - a));
      img.data[d + 1] = Math.round(raw[s + 1]! * a + 20 * (1 - a));
      img.data[d + 2] = Math.round(raw[s + 2]! * a + 26 * (1 - a));
      img.data[d + 3] = 255;
      if (raw[s + 3]! < 250) transparent++;
      if (flat && (raw[s] !== raw[0] || raw[s + 1] !== raw[1] || raw[s + 2] !== raw[2])) flat = false;
      dFrom += Math.abs(raw[s]! - fromPx[d]!) + Math.abs(raw[s + 1]! - fromPx[d + 1]!) + Math.abs(raw[s + 2]! - fromPx[d + 2]!);
      dTo += Math.abs(raw[s]! - toPx[d]!) + Math.abs(raw[s + 1]! - toPx[d + 1]!) + Math.abs(raw[s + 2]! - toPx[d + 2]!);
    }
  }
  og.putImageData(img, 0, 0);
  const n = RW * RH * 3;
  return { canvas: out, ok, flat, diffFromImageA: +(dFrom / n).toFixed(1), diffFromImageB: +(dTo / n).toFixed(1), transparentPct: +((transparent / (RW * RH)) * 100).toFixed(1) };
}

const featured = GL_TRANSITIONS.filter((m) => m.featured).sort((a, b) => a.label.localeCompare(b.label));

// ── layout ───────────────────────────────────────────────────────────────────────
const COLS = 3;
const GAP = 8; // between frames
const TILE_W = FW * 3 + GAP * 2;
const TILE_H = FH + 58; // frame + title + caption
const PAD = 26;
const HEAD = 96;
const rows = Math.ceil(featured.length / COLS);
const SW = PAD * 2 + COLS * TILE_W + (COLS - 1) * 30;
const SH = HEAD + rows * (TILE_H + 22) + PAD;
const sheet = document.createElement('canvas');
sheet.width = SW;
sheet.height = SH;
const g = sheet.getContext('2d')!;
g.fillStyle = '#0f1115';
g.fillRect(0, 0, SW, SH);
g.fillStyle = '#f2f4f8';
g.font = '600 30px Segoe UI, Arial, sans-serif';
g.textBaseline = 'top';
g.fillText('Nova Cut — Featured GL transitions', PAD, 20);
g.fillStyle = '#9aa3b5';
g.font = '15px Segoe UI, Arial, sans-serif';
g.fillText(`${featured.length} transitions rendered by Nova Cut's GL adapter at 25%, 50% and 75% progress, default parameters. Image A (sunset) is the outgoing clip, image B (night city) the incoming one.`, PAD, 62);

const metrics: Record<string, unknown>[] = [];
featured.forEach((m, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x0 = PAD + col * (TILE_W + 30);
  const y0 = HEAD + row * (TILE_H + 22);
  g.fillStyle = '#e9edf5';
  g.font = '600 17px Segoe UI, Arial, sans-serif';
  g.textBaseline = 'top';
  g.fillText(m.label, x0, y0);
  g.fillStyle = '#7d869a';
  g.font = '12px Segoe UI, Arial, sans-serif';
  g.fillText(`${m.category}  ·  ${m.author}  ·  ${m.license}`, x0, y0 + 22);
  const info: Record<string, unknown> = { name: m.name, label: m.label, frames: [] };
  PROGRESS.forEach((p, k) => {
    const f = frame(m.name, p);
    const fx = x0 + k * (FW + GAP);
    const fy = y0 + 42;
    g.imageSmoothingQuality = 'high';
    g.drawImage(f.canvas, fx, fy, FW, FH);
    g.strokeStyle = f.ok ? '#2a2f3a' : '#ff4d4d';
    g.lineWidth = 1;
    g.strokeRect(fx + 0.5, fy + 0.5, FW - 1, FH - 1);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(fx, fy, 38, 17);
    g.fillStyle = '#ffffff';
    g.font = '600 11px Segoe UI, Arial, sans-serif';
    g.fillText(`${Math.round(p * 100)}%`, fx + 6, fy + 3);
    (info.frames as unknown[]).push({ p, ok: f.ok, flat: f.flat, diffA: f.diffFromImageA, diffB: f.diffFromImageB, transparentPct: f.transparentPct });
  });
  metrics.push(info);
});

(window as unknown as Record<string, unknown>).__sheetPng = sheet.toDataURL('image/png');
(window as unknown as Record<string, unknown>).__metrics = metrics;
(window as unknown as Record<string, unknown>).__sheetSize = [SW, SH];
console.log('__DONE__');
