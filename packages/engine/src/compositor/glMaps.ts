/**
 * The greyscale maps the texture shaders of the GL Transitions catalog read.
 *
 * Two library shaders take an extra image: `luma` reveals the incoming clip where the map is dark
 * first, and `displacement` warps both clips by the map's brightness. The gallery's own images carry
 * licences of their own, so these are drawn here instead: a handful of gradients and noise patterns,
 * which is what those two shaders actually need. Their order is the order of `GL_TRANSITION_MAPS`
 * (generated into the core package); a saved project stores an INDEX, so this list is append-only.
 *
 * Nothing here is random per run. The clouds use a fixed-seed value noise, so the same transition
 * looks the same in the preview, the export and a project reopened next year.
 */

import { GL_TRANSITION_MAPS } from '@opencut/core';

const SIZE = 256;

/** A small deterministic generator (mulberry32), so the "Clouds" map never changes between runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on a lattice, summed over a few octaves, 0..1. */
function clouds(x: number, y: number, lattice: Float32Array, n: number): number {
  let total = 0;
  let amp = 0.55;
  let freq = 3;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    const fx = x * freq;
    const fy = y * freq;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const v = (ix: number, iy: number) => lattice[(((iy % n) + n) % n) * n + (((ix % n) + n) % n)]!;
    const a = v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx;
    const b = v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx;
    total += (a * (1 - sy) + b * sy) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / norm;
}

/** The brightness (0..1) of map `name` at uv (x right, y DOWN, both 0..1). */
function valueAt(name: string, x: number, y: number, lattice: Float32Array, n: number): number {
  switch (name) {
    case 'Left to Right':
      return x;
    case 'Top to Bottom':
      return y;
    case 'Diagonal':
      return (x + y) / 2;
    case 'Center Out':
      return Math.min(1, Math.hypot(x - 0.5, y - 0.5) / 0.7071);
    case 'Clouds':
      return clouds(x, y, lattice, n);
    case 'Stripes':
      return 0.5 + 0.5 * Math.sin(x * Math.PI * 10);
    case 'Checkerboard':
      return (Math.floor(x * 8) + Math.floor(y * 8)) % 2 === 0 ? 0.15 + 0.7 * x : 0.55 + 0.4 * y;
    case 'Spiral': {
      const a = Math.atan2(y - 0.5, x - 0.5) / (Math.PI * 2) + 0.5;
      const r = Math.hypot(x - 0.5, y - 0.5) / 0.7071;
      return (a * 3 + r * 2) % 1;
    }
    default:
      return x;
  }
}

/** Draw map number `index` (clamped into range) onto a fresh canvas. */
export function paintMap(index: number): HTMLCanvasElement {
  const name = GL_TRANSITION_MAPS[Math.min(GL_TRANSITION_MAPS.length - 1, Math.max(0, Math.round(index)))]!;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(SIZE, SIZE);
  const n = 8;
  const rand = rng(1618);
  const lattice = new Float32Array(n * n);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const v = Math.round(Math.min(1, Math.max(0, valueAt(name, (px + 0.5) / SIZE, (py + 0.5) / SIZE, lattice, n))) * 255);
      const i = (py * SIZE + px) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
