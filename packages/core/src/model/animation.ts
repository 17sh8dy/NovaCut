/**
 * Keyframe sampling. Given an AnimatedValue and a time (relative to the clip), return the
 * interpolated scalar. This is called per-frame per-param by the compositor, so it stays
 * allocation-free and cheap.
 */

import type { AnimatedValue, Keyframe } from './types.js';
import type { Ticks } from './time.js';

function ease(kind: Keyframe['interpolation'], t: number): number {
  switch (kind) {
    case 'hold':
      return 0;
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return t * (2 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'linear':
    default:
      return t;
  }
}

/** Cubic bezier easing solved for y given x, used when interpolation === 'bezier'. */
function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number, x: number): number {
  // Newton-Raphson to invert x(t), then evaluate y(t). Good enough for animation curves.
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-5) break;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  return ((ay * t + by) * t + cy) * t;
}

export function sample(value: AnimatedValue, timeInClip: Ticks): number {
  const kfs = value.keyframes;
  if (kfs.length === 0) return value.static;
  if (kfs.length === 1) return kfs[0]!.value;

  const first = kfs[0]!;
  if (timeInClip <= first.time) return first.value;
  const last = kfs[kfs.length - 1]!;
  if (timeInClip >= last.time) return last.value;

  // Locate the bracketing pair. Keyframes are kept sorted by time on insertion.
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid]!.time <= timeInClip) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo]!;
  const b = kfs[hi]!;
  const span = b.time - a.time;
  const raw = span === 0 ? 0 : (timeInClip - a.time) / span;

  let f: number;
  if (a.interpolation === 'bezier' && a.bezier) {
    f = cubicBezier(a.bezier.outX, a.bezier.outY, a.bezier.inX, a.bezier.inY, raw);
  } else {
    f = ease(a.interpolation, raw);
  }
  return a.value + (b.value - a.value) * f;
}

/** Insert a keyframe keeping the array sorted by time; replaces any at the same time. */
export function upsertKeyframe(value: AnimatedValue, kf: Keyframe): AnimatedValue {
  const keyframes = value.keyframes.filter((k) => k.time !== kf.time);
  const idx = keyframes.findIndex((k) => k.time > kf.time);
  if (idx === -1) keyframes.push(kf);
  else keyframes.splice(idx, 0, kf);
  return { ...value, keyframes };
}
