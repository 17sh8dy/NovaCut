/**
 * Easing curves.
 *
 * Every curve maps 0→0 and 1→1; what differs is the path between, and that path is most of
 * what separates an animation that feels designed from one that feels like a linear tween.
 * They live in core rather than in the animation catalog because keyframe interpolation, the
 * text lane and any future motion preset should all bend time by the same set of curves.
 *
 * Only `elastic` and `back` leave the 0..1 range — they overshoot on purpose, which is exactly
 * what makes a "pop" read as a pop. Consumers that cannot tolerate overshoot (a reveal
 * fraction, an opacity) must clamp; the ones that can (position, scale) should not.
 */

export type EasingFn = (t: number) => number;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export const linear: EasingFn = (t) => clamp01(t);

export const easeInQuad: EasingFn = (t) => { const x = clamp01(t); return x * x; };
export const easeOutQuad: EasingFn = (t) => { const x = clamp01(t); return x * (2 - x); };

export const easeInCubic: EasingFn = (t) => { const x = clamp01(t); return x * x * x; };
export const easeOutCubic: EasingFn = (t) => { const x = clamp01(t) - 1; return x * x * x + 1; };
export const easeInOutCubic: EasingFn = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOutQuart: EasingFn = (t) => 1 - Math.pow(1 - clamp01(t), 4);
export const easeInQuart: EasingFn = (t) => Math.pow(clamp01(t), 4);

/** The workhorse for entrances: almost all of the distance is covered immediately. */
export const easeOutExpo: EasingFn = (t) => {
  const x = clamp01(t);
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
};
export const easeInExpo: EasingFn = (t) => {
  const x = clamp01(t);
  return x <= 0 ? 0 : Math.pow(2, 10 * x - 10);
};

export const easeOutCirc: EasingFn = (t) => Math.sqrt(1 - Math.pow(clamp01(t) - 1, 2));
export const easeInCirc: EasingFn = (t) => 1 - Math.sqrt(1 - Math.pow(clamp01(t), 2));

/** Overshoots past 1 before settling — the "pop". */
export const easeOutBack: EasingFn = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};
export const easeInBack: EasingFn = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t);
  return c3 * x * x * x - c1 * x * x;
};

/** Overshoots repeatedly with a decaying wobble. */
export const easeOutElastic: EasingFn = (t) => {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
};

/** Settles with successive smaller hops, like something dropped on a hard floor. */
export const easeOutBounce: EasingFn = (t) => {
  let x = clamp01(t);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

export const easeInBounce: EasingFn = (t) => 1 - easeOutBounce(1 - clamp01(t));

/**
 * A 0→1→0 hump, for anything that should return to where it started.
 *
 * Loop animations need this shape constantly and it is easy to get subtly wrong: using
 * `sin(phase * PI)` looks right but its derivative is non-zero at the wrap point, so a
 * "breathing" title visibly ticks once per cycle. A raised cosine is smooth across the seam.
 */
export const pingPong: EasingFn = (t) => (1 - Math.cos(clamp01(t) * Math.PI * 2)) / 2;

/** A full sine cycle over the phase, -1..1, smooth across the wrap. For swaying and drifting. */
export const wave = (phase: number): number => Math.sin(phase * Math.PI * 2);

/**
 * Deterministic pseudo-random in 0..1.
 *
 * Shake and jitter need noise that is the SAME on every playthrough and — critically — the same
 * in the preview and in the export, which render the identical timeline on different clocks. A
 * hash of the time index gives that; `Math.random()` would make every export of the same
 * project produce different pixels.
 */
export const hashNoise = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
