/**
 * The built-in text animation catalog: 25 entrances, 25 exits, 25 loops.
 *
 * Every entry is a pure `apply` returning what the compositor should do this frame — see
 * `TextAnimationOutput`. There is no engine code here and no engine code is needed to add
 * more: a new animation is one object in one of the three arrays below.
 *
 * ## Two conventions worth knowing before editing
 *
 * **Sign.** `dy` is positive DOWNWARD, matching `Transform.y` and the screen, so an animation
 * that enters from below starts at a positive `dy` and relaxes to 0. `dx` is positive rightward.
 * Offsets are in fractions of the text's own size, so `dx: -1` is "one text-width to the left"
 * regardless of resolution or font size.
 *
 * **Direction of the clock.** `in` animations get progress 0 (nothing yet) → 1 (arrived).
 * `out` animations get 0 (still resting) → 1 (gone). Both therefore read forwards, which is why
 * a fade-in returns `opacity: p` and a fade-out returns `opacity: 1 - p`.
 *
 * ## Why some of these return `passes`
 *
 * Anything that changes PIXELS rather than placement — blur, glitch, a wipe's soft edge — is
 * expressed as an ordinary effect from the main registry with resolved params, which the
 * compositor appends to the chain it is already running for the clip. That keeps this file free
 * of shader knowledge and means these animations get any future effect for free.
 */

import {
  registerTextAnimation,
  type EffectParamDef,
  type TextAnimationDefinition,
  type TextAnimationOutput,
} from './registry.js';
import {
  easeInBack,
  easeInCubic,
  easeInExpo,
  easeInQuad,
  easeInQuart,
  easeOutBack,
  easeOutBounce,
  easeOutCirc,
  easeOutCubic,
  easeOutElastic,
  easeOutExpo,
  easeOutQuad,
  hashNoise,
  pingPong,
  wave,
} from './easing.js';

const p = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  step = 0.01,
  unit?: string,
): EffectParamDef => ({ key, label, min, max, default: def, step, ...(unit ? { unit } : {}) });

/** Travel distance, in multiples of the text's own size. */
const DISTANCE = (def = 1.2) => p('distance', 'Distance', 0, 8, def, 0.05);
/** Generic strength dial, 0 = no effect at all. */
const AMOUNT = (def = 1) => p('amount', 'Amount', 0, 2, def, 0.01);
const SOFTNESS = (def = 0.08) => p('softness', 'Edge Softness', 0.001, 0.5, def, 0.001);

/** `text-reveal` shader modes. Mirrors the switch in the fragment; keep the two in step. */
const MASK_WIPE = 0;
const MASK_IRIS = 1;
const MASK_BLINDS = 2;
const MASK_DISSOLVE = 3;

/** A masked reveal pass. `shown` is 0 (fully hidden) → 1 (fully visible). */
const maskPass = (
  mode: number,
  shown: number,
  softness: number,
  angle = 0,
  count = 8,
): TextAnimationOutput['passes'] => [
  { type: 'text-reveal', params: { mode, progress: shown, softness, angle, count } },
];

// ─────────────────────────────────────────────────────────────────────────────
// Entrances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four straight slides differ only in their axis and sign, so they are generated rather
 * than copied. Writing them out four times is four chances to typo a sign — and a slide with an
 * inverted sign doesn't crash, it just enters from the wrong side, which is the kind of bug
 * that ships.
 */
const slideIn = (
  type: string,
  label: string,
  axis: 'dx' | 'dy',
  sign: number,
): TextAnimationDefinition => ({
  type,
  label,
  kind: 'in',
  duration: 0.6,
  params: [DISTANCE()],
  apply: ({ progress, params }) => {
    const travel = sign * params.distance! * (1 - easeOutExpo(progress));
    // Fading over the first third only: a slide that fades across its whole travel reads as a
    // fade, and the movement stops registering.
    const opacity = easeOutQuad(Math.min(1, progress * 3));
    return axis === 'dx' ? { dx: travel, opacity } : { dy: travel, opacity };
  },
});

const wipeIn = (
  type: string,
  label: string,
  mode: number,
  angle: number,
  duration = 0.7,
): TextAnimationDefinition => ({
  type,
  label,
  kind: 'in',
  duration,
  params: [SOFTNESS()],
  apply: ({ progress, params }) => ({
    passes: maskPass(mode, easeOutQuad(progress), params.softness!, angle),
  }),
});

const IN: TextAnimationDefinition[] = [
  {
    type: 'fade-in', label: 'Fade In', kind: 'in', duration: 0.5, params: [],
    apply: ({ progress }) => ({ opacity: easeOutQuad(progress) }),
  },
  slideIn('slide-in-left', 'Slide In Left', 'dx', -1),
  slideIn('slide-in-right', 'Slide In Right', 'dx', 1),
  slideIn('slide-in-up', 'Slide In Up', 'dy', 1),
  slideIn('slide-in-down', 'Slide In Down', 'dy', -1),
  {
    type: 'scale-in', label: 'Scale In', kind: 'in', duration: 0.5,
    params: [p('from', 'From Scale', 0, 1, 0.6, 0.01)],
    apply: ({ progress, params }) => {
      const s = params.from! + (1 - params.from!) * easeOutCubic(progress);
      return { scaleX: s, scaleY: s, opacity: easeOutQuad(progress) };
    },
  },
  {
    type: 'zoom-in', label: 'Zoom In', kind: 'in', duration: 0.6,
    params: [p('from', 'From Scale', 0, 1, 0.15, 0.01)],
    apply: ({ progress, params }) => {
      const s = params.from! + (1 - params.from!) * easeOutExpo(progress);
      return { scaleX: s, scaleY: s, opacity: easeOutQuad(Math.min(1, progress * 2)) };
    },
  },
  {
    type: 'zoom-back-in', label: 'Zoom Back In', kind: 'in', duration: 0.6,
    params: [p('from', 'From Scale', 1, 6, 2.4, 0.05)],
    apply: ({ progress, params }) => {
      const s = params.from! + (1 - params.from!) * easeOutExpo(progress);
      return { scaleX: s, scaleY: s, opacity: easeOutQuad(Math.min(1, progress * 2)) };
    },
  },
  {
    type: 'pop-in', label: 'Pop In', kind: 'in', duration: 0.45, params: [],
    apply: ({ progress }) => {
      // easeOutBack overshoots past 1 and settles back — the entire point of a "pop".
      const s = easeOutBack(progress);
      return { scaleX: s, scaleY: s, opacity: easeOutQuad(Math.min(1, progress * 3)) };
    },
  },
  {
    type: 'blur-in', label: 'Blur In', kind: 'in', duration: 0.6,
    params: [p('radius', 'Blur', 0, 100, 28, 1, 'px')],
    apply: ({ progress, params }) => {
      const r = params.radius! * (1 - easeOutQuad(progress));
      return {
        opacity: easeOutQuad(progress),
        // Below a quarter-pixel the pass is invisible but still costs a full-screen draw, so it
        // is dropped once the reveal has effectively finished.
        ...(r > 0.25 ? { passes: [{ type: 'blur', params: { radius: r } }] } : null),
      };
    },
  },
  {
    type: 'typewriter', label: 'Typewriter', kind: 'in', duration: 1.2,
    params: [p('cursor', 'Hold At End', 0, 1, 0, 0.01)],
    // Linear on purpose: a typist's rhythm is even, and easing it makes the last few characters
    // appear to stall. `cursor` trims the tail so the text can finish early and rest.
    apply: ({ progress, params }) => ({
      reveal: Math.min(1, progress / Math.max(0.05, 1 - params.cursor! * 0.5)),
    }),
  },
  {
    type: 'bounce-in', label: 'Bounce In', kind: 'in', duration: 0.8,
    params: [DISTANCE(1.5)],
    apply: ({ progress, params }) => ({
      dy: -params.distance! * (1 - easeOutBounce(progress)),
      opacity: easeOutQuad(Math.min(1, progress * 4)),
    }),
  },
  {
    type: 'rotate-in', label: 'Rotate In', kind: 'in', duration: 0.6,
    params: [p('angle', 'Angle', -360, 360, -90, 1, '°')],
    apply: ({ progress, params }) => {
      const e = easeOutCubic(progress);
      return { rotate: params.angle! * (1 - e), scaleX: 0.7 + 0.3 * e, scaleY: 0.7 + 0.3 * e, opacity: e };
    },
  },
  {
    // A real 3D flip needs a perspective divide the composite matrix doesn't carry. Collapsing
    // the axis to zero and springing back is the standard 2D stand-in and reads correctly at
    // speed, which is the only speed a flip is ever seen at.
    type: 'flip-in-x', label: 'Flip In (Horizontal Axis)', kind: 'in', duration: 0.55, params: [],
    apply: ({ progress }) => ({ scaleY: easeOutCubic(progress), opacity: easeOutQuad(Math.min(1, progress * 3)) }),
  },
  {
    type: 'flip-in-y', label: 'Flip In (Vertical Axis)', kind: 'in', duration: 0.55, params: [],
    apply: ({ progress }) => ({ scaleX: easeOutCubic(progress), opacity: easeOutQuad(Math.min(1, progress * 3)) }),
  },
  wipeIn('wipe-in', 'Wipe In', MASK_WIPE, 0),
  wipeIn('wipe-in-up', 'Wipe In Up', MASK_WIPE, 90),
  wipeIn('iris-in', 'Iris In', MASK_IRIS, 0),
  {
    ...wipeIn('blinds-in', 'Blinds In', MASK_BLINDS, 0),
    params: [SOFTNESS(0.04), p('count', 'Bands', 2, 32, 8, 1)],
    apply: ({ progress, params }) => ({
      passes: maskPass(MASK_BLINDS, easeOutQuad(progress), params.softness!, 0, params.count!),
    }),
  },
  {
    ...wipeIn('dissolve-in', 'Dissolve In', MASK_DISSOLVE, 0),
    apply: ({ progress, params }) => ({
      passes: maskPass(MASK_DISSOLVE, progress, params.softness!, 0),
    }),
  },
  {
    type: 'glitch-in', label: 'Glitch In', kind: 'in', duration: 0.6,
    params: [AMOUNT(0.8)],
    apply: ({ progress, params }) => {
      const a = params.amount! * (1 - easeInQuart(progress));
      return {
        opacity: easeOutQuad(Math.min(1, progress * 2)),
        ...(a > 0.01 ? { passes: [{ type: 'glitch-fx', params: { amount: a, speed: 2.5 } }] } : null),
      };
    },
  },
  {
    type: 'drop-in', label: 'Drop In', kind: 'in', duration: 0.9,
    params: [DISTANCE(2)],
    apply: ({ progress, params }) => {
      const e = easeOutBounce(progress);
      // Squashing on impact and springing back is what sells weight; without it a bouncing
      // title reads as a rigid object teleporting between rest positions.
      const squash = 1 - 0.18 * Math.max(0, Math.sin(progress * Math.PI * 3)) * (1 - progress);
      return {
        dy: -params.distance! * (1 - e),
        scaleY: squash,
        scaleX: 2 - squash,
        opacity: easeOutQuad(Math.min(1, progress * 5)),
      };
    },
  },
  {
    type: 'spin-in', label: 'Spin In', kind: 'in', duration: 0.7,
    params: [p('turns', 'Turns', 0.25, 4, 1, 0.25)],
    apply: ({ progress, params }) => {
      const e = easeOutExpo(progress);
      return { rotate: -360 * params.turns! * (1 - e), scaleX: e, scaleY: e, opacity: easeOutQuad(Math.min(1, progress * 2)) };
    },
  },
  {
    type: 'swing-in', label: 'Swing In', kind: 'in', duration: 0.9,
    params: [p('angle', 'Angle', -90, 90, 25, 1, '°')],
    apply: ({ progress, params }) => ({
      rotate: params.angle! * (1 - easeOutElastic(progress)),
      opacity: easeOutQuad(Math.min(1, progress * 4)),
    }),
  },
  {
    type: 'slam-in', label: 'Slam In', kind: 'in', duration: 0.5,
    params: [p('from', 'From Scale', 1, 8, 3.5, 0.1)],
    apply: ({ progress, params }) => {
      const e = easeOutExpo(progress);
      const s = params.from! + (1 - params.from!) * e;
      const r = 40 * (1 - e);
      return {
        scaleX: s, scaleY: s,
        opacity: easeOutQuad(Math.min(1, progress * 3)),
        ...(r > 0.25 ? { passes: [{ type: 'blur', params: { radius: r } }] } : null),
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Exits
// ─────────────────────────────────────────────────────────────────────────────

const slideOut = (
  type: string,
  label: string,
  axis: 'dx' | 'dy',
  sign: number,
): TextAnimationDefinition => ({
  type,
  label,
  kind: 'out',
  duration: 0.5,
  params: [DISTANCE()],
  apply: ({ progress, params }) => {
    // easeIn on the way out, mirroring easeOut on the way in: things should leave by
    // accelerating away, not by decelerating into the edge of the screen.
    const travel = sign * params.distance! * easeInCubic(progress);
    const opacity = 1 - easeInQuart(progress);
    return axis === 'dx' ? { dx: travel, opacity } : { dy: travel, opacity };
  },
});

const wipeOut = (
  type: string,
  label: string,
  mode: number,
  angle: number,
): TextAnimationDefinition => ({
  type,
  label,
  kind: 'out',
  duration: 0.6,
  params: [SOFTNESS()],
  apply: ({ progress, params }) => ({
    // `shown` counts DOWN — the same shader pass, driven backwards.
    passes: maskPass(mode, 1 - easeInQuart(progress), params.softness!, angle),
  }),
});

const OUT: TextAnimationDefinition[] = [
  {
    type: 'fade-out', label: 'Fade Out', kind: 'out', duration: 0.5, params: [],
    apply: ({ progress }) => ({ opacity: 1 - easeInCubic(progress) }),
  },
  slideOut('slide-out-left', 'Slide Out Left', 'dx', -1),
  slideOut('slide-out-right', 'Slide Out Right', 'dx', 1),
  slideOut('slide-out-up', 'Slide Out Up', 'dy', -1),
  slideOut('slide-out-down', 'Slide Out Down', 'dy', 1),
  {
    type: 'scale-out', label: 'Scale Out', kind: 'out', duration: 0.45,
    params: [p('to', 'To Scale', 0, 1, 0.6, 0.01)],
    apply: ({ progress, params }) => {
      const s = 1 + (params.to! - 1) * easeInCubic(progress);
      return { scaleX: s, scaleY: s, opacity: 1 - easeInQuart(progress) };
    },
  },
  {
    type: 'zoom-out', label: 'Zoom Out', kind: 'out', duration: 0.55,
    params: [p('to', 'To Scale', 0, 1, 0.1, 0.01)],
    apply: ({ progress, params }) => {
      const s = 1 + (params.to! - 1) * easeInExpo(progress);
      return { scaleX: s, scaleY: s, opacity: 1 - easeInCubic(progress) };
    },
  },
  {
    type: 'zoom-forward-out', label: 'Zoom Forward Out', kind: 'out', duration: 0.55,
    params: [p('to', 'To Scale', 1, 6, 2.6, 0.05)],
    apply: ({ progress, params }) => {
      const s = 1 + (params.to! - 1) * easeInExpo(progress);
      return { scaleX: s, scaleY: s, opacity: 1 - easeInQuart(progress) };
    },
  },
  {
    type: 'pop-out', label: 'Pop Out', kind: 'out', duration: 0.4, params: [],
    apply: ({ progress }) => {
      // Anticipation: it swells slightly before collapsing, the mirror of the pop-in overshoot.
      const s = 1 - easeInBack(progress);
      return { scaleX: s, scaleY: s, opacity: 1 - easeInQuart(progress) };
    },
  },
  {
    type: 'blur-out', label: 'Blur Out', kind: 'out', duration: 0.5,
    params: [p('radius', 'Blur', 0, 100, 28, 1, 'px')],
    apply: ({ progress, params }) => {
      const r = params.radius! * easeInQuad(progress);
      return {
        opacity: 1 - easeInCubic(progress),
        ...(r > 0.25 ? { passes: [{ type: 'blur', params: { radius: r } }] } : null),
      };
    },
  },
  {
    type: 'typewriter-out', label: 'Typewriter Out', kind: 'out', duration: 0.9, params: [],
    apply: ({ progress }) => ({ reveal: 1 - progress }),
  },
  {
    type: 'bounce-out', label: 'Bounce Out', kind: 'out', duration: 0.7,
    params: [DISTANCE(1.5)],
    apply: ({ progress, params }) => ({
      dy: params.distance! * easeInCubic(progress),
      opacity: 1 - easeInQuart(progress),
    }),
  },
  {
    type: 'rotate-out', label: 'Rotate Out', kind: 'out', duration: 0.55,
    params: [p('angle', 'Angle', -360, 360, 90, 1, '°')],
    apply: ({ progress, params }) => {
      const e = easeInCubic(progress);
      return { rotate: params.angle! * e, scaleX: 1 - 0.3 * e, scaleY: 1 - 0.3 * e, opacity: 1 - e };
    },
  },
  {
    type: 'flip-out-x', label: 'Flip Out (Horizontal Axis)', kind: 'out', duration: 0.5, params: [],
    apply: ({ progress }) => ({ scaleY: 1 - easeInCubic(progress), opacity: 1 - easeInQuart(progress) }),
  },
  {
    type: 'flip-out-y', label: 'Flip Out (Vertical Axis)', kind: 'out', duration: 0.5, params: [],
    apply: ({ progress }) => ({ scaleX: 1 - easeInCubic(progress), opacity: 1 - easeInQuart(progress) }),
  },
  wipeOut('wipe-out', 'Wipe Out', MASK_WIPE, 0),
  wipeOut('wipe-out-up', 'Wipe Out Up', MASK_WIPE, 90),
  wipeOut('iris-out', 'Iris Out', MASK_IRIS, 0),
  {
    ...wipeOut('blinds-out', 'Blinds Out', MASK_BLINDS, 0),
    params: [SOFTNESS(0.04), p('count', 'Bands', 2, 32, 8, 1)],
    apply: ({ progress, params }) => ({
      passes: maskPass(MASK_BLINDS, 1 - easeInQuart(progress), params.softness!, 0, params.count!),
    }),
  },
  {
    ...wipeOut('dissolve-out', 'Dissolve Out', MASK_DISSOLVE, 0),
    apply: ({ progress, params }) => ({
      passes: maskPass(MASK_DISSOLVE, 1 - progress, params.softness!, 0),
    }),
  },
  {
    type: 'glitch-out', label: 'Glitch Out', kind: 'out', duration: 0.55,
    params: [AMOUNT(0.9)],
    apply: ({ progress, params }) => {
      const a = params.amount! * easeInQuad(progress);
      return {
        opacity: 1 - easeInQuart(progress),
        ...(a > 0.01 ? { passes: [{ type: 'glitch-fx', params: { amount: a, speed: 3 } }] } : null),
      };
    },
  },
  {
    type: 'drop-out', label: 'Drop Out', kind: 'out', duration: 0.7,
    params: [DISTANCE(2.5)],
    apply: ({ progress, params }) => ({
      // Gravity is quadratic, so a falling title should be too — easeIn on distance with a late
      // fade, so it is still legible for most of the fall.
      dy: params.distance! * easeInQuad(progress),
      rotate: 12 * easeInQuad(progress),
      opacity: 1 - easeInQuart(progress),
    }),
  },
  {
    type: 'spin-out', label: 'Spin Out', kind: 'out', duration: 0.6,
    params: [p('turns', 'Turns', 0.25, 4, 1, 0.25)],
    apply: ({ progress, params }) => {
      const e = easeInExpo(progress);
      return { rotate: 360 * params.turns! * e, scaleX: 1 - e, scaleY: 1 - e, opacity: 1 - easeInCubic(progress) };
    },
  },
  {
    type: 'swing-out', label: 'Swing Out', kind: 'out', duration: 0.6,
    params: [p('angle', 'Angle', -90, 90, 35, 1, '°')],
    apply: ({ progress, params }) => ({
      rotate: params.angle! * easeInBack(progress),
      opacity: 1 - easeInQuart(progress),
    }),
  },
  {
    type: 'slam-out', label: 'Slam Out', kind: 'out', duration: 0.4,
    params: [p('to', 'To Scale', 1, 8, 3, 0.1)],
    apply: ({ progress, params }) => {
      const e = easeInExpo(progress);
      const s = 1 + (params.to! - 1) * e;
      const r = 45 * e;
      return {
        scaleX: s, scaleY: s,
        opacity: 1 - easeInCubic(progress),
        ...(r > 0.25 ? { passes: [{ type: 'blur', params: { radius: r } }] } : null),
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Loops
//
// A loop's `progress` is a PHASE that wraps 0 → 1 → 0 forever, so every one of these must
// return the same value at 0 and at 1. Anything that doesn't will jump once per cycle — the
// single most common bug in a looping animation, and the reason `pingPong` and `wave` exist
// rather than each entry rolling its own sine.
// ─────────────────────────────────────────────────────────────────────────────

const SPEED = (def = 1) => p('speed', 'Cycles', 1, 8, def, 1);

const LOOP: TextAnimationDefinition[] = [
  {
    type: 'pulse', label: 'Pulse', kind: 'loop', duration: 1.2,
    params: [p('amount', 'Amount', 0, 1, 0.12, 0.01)],
    apply: ({ progress, params }) => {
      const s = 1 + params.amount! * pingPong(progress);
      return { scaleX: s, scaleY: s };
    },
  },
  {
    type: 'float', label: 'Floating', kind: 'loop', duration: 3,
    params: [p('amount', 'Amount', 0, 1, 0.12, 0.01)],
    apply: ({ progress, params }) => ({ dy: params.amount! * wave(progress) }),
  },
  {
    type: 'shake', label: 'Shake', kind: 'loop', duration: 0.5,
    params: [p('amount', 'Amount', 0, 1, 0.08, 0.005), p('steps', 'Steps', 4, 40, 14, 1)],
    apply: ({ progress, params }) => {
      // Quantising the phase into steps is what makes it read as a shake rather than a wobble:
      // real shake is discontinuous. hashNoise keeps it identical in preview and export.
      const i = Math.floor(progress * params.steps!);
      return {
        dx: params.amount! * (hashNoise(i) * 2 - 1),
        dy: params.amount! * (hashNoise(i + 91.7) * 2 - 1),
      };
    },
  },
  {
    type: 'bounce-loop', label: 'Bounce', kind: 'loop', duration: 1.1,
    params: [p('amount', 'Amount', 0, 1.5, 0.35, 0.01)],
    apply: ({ progress, params }) => {
      // Up on the first half with a decelerating arc, down on the second with easeOutBounce
      // reversed — a ball's trajectory rather than a sine.
      const up = progress < 0.5 ? easeOutCirc(progress * 2) : 1 - easeOutBounce((progress - 0.5) * 2);
      return { dy: -params.amount! * up };
    },
  },
  {
    type: 'sway', label: 'Sway', kind: 'loop', duration: 2.6,
    params: [p('amount', 'Amount', 0, 1, 0.15, 0.01)],
    apply: ({ progress, params }) => ({ dx: params.amount! * wave(progress) }),
  },
  {
    type: 'wiggle', label: 'Wiggle', kind: 'loop', duration: 0.9,
    params: [p('angle', 'Angle', 0, 45, 5, 0.5, '°')],
    apply: ({ progress, params }) => ({ rotate: params.angle! * wave(progress) }),
  },
  {
    type: 'glow-pulse', label: 'Glow Pulse', kind: 'loop', duration: 1.6,
    params: [p('intensity', 'Intensity', 0, 3, 1.1, 0.05), p('radius', 'Radius', 1, 80, 22, 1, 'px')],
    apply: ({ progress, params }) => ({
      passes: [{
        type: 'bloom',
        params: { threshold: 0.45, intensity: params.intensity! * (0.35 + 0.65 * pingPong(progress)), radius: params.radius! },
      }],
    }),
  },
  {
    type: 'breathe', label: 'Breathing', kind: 'loop', duration: 4,
    params: [p('amount', 'Amount', 0, 0.5, 0.05, 0.005)],
    apply: ({ progress, params }) => {
      const s = 1 + params.amount! * pingPong(progress);
      return { scaleX: s, scaleY: s, opacity: 0.88 + 0.12 * pingPong(progress) };
    },
  },
  {
    type: 'typewriter-loop', label: 'Typewriter Loop', kind: 'loop', duration: 3,
    params: [p('hold', 'Hold', 0, 0.8, 0.35, 0.01)],
    apply: ({ progress, params }) => {
      // type over the first (1-hold)/2, rest, then untype — so the cycle closes on an empty
      // string at both ends and the wrap is seamless.
      const type = (1 - params.hold!) / 2;
      if (progress < type) return { reveal: progress / type };
      if (progress < type + params.hold!) return { reveal: 1 };
      return { reveal: Math.max(0, 1 - (progress - type - params.hold!) / type) };
    },
  },
  {
    type: 'heartbeat', label: 'Heartbeat', kind: 'loop', duration: 1.4,
    params: [p('amount', 'Amount', 0, 1, 0.18, 0.01)],
    apply: ({ progress, params }) => {
      // Two thumps close together then a rest — the actual rhythm, not one sine per beat.
      const thump = (t: number) => Math.max(0, Math.sin(t * Math.PI));
      const beat = thump(Math.min(1, progress / 0.18)) * 1 + thump(Math.min(1, Math.max(0, progress - 0.24) / 0.18)) * 0.7;
      const s = 1 + params.amount! * Math.min(1, beat);
      return { scaleX: s, scaleY: s };
    },
  },
  {
    type: 'blink', label: 'Blink', kind: 'loop', duration: 1,
    params: [p('duty', 'On Time', 0.1, 0.95, 0.6, 0.01)],
    apply: ({ progress, params }) => ({ opacity: progress < params.duty! ? 1 : 0 }),
  },
  {
    type: 'spin-loop', label: 'Spin', kind: 'loop', duration: 4,
    params: [SPEED(1)],
    apply: ({ progress, params }) => ({ rotate: 360 * params.speed! * progress }),
  },
  {
    type: 'pendulum', label: 'Pendulum', kind: 'loop', duration: 2.4,
    params: [p('angle', 'Angle', 0, 60, 12, 0.5, '°')],
    apply: ({ progress, params }) => ({ rotate: params.angle! * wave(progress) }),
  },
  {
    type: 'jitter', label: 'Jitter', kind: 'loop', duration: 0.25,
    params: [p('amount', 'Amount', 0, 0.5, 0.02, 0.002), p('steps', 'Steps', 2, 24, 6, 1)],
    apply: ({ progress, params }) => {
      const i = Math.floor(progress * params.steps!);
      return {
        dx: params.amount! * (hashNoise(i * 3.7) * 2 - 1),
        dy: params.amount! * (hashNoise(i * 3.7 + 11.3) * 2 - 1),
        rotate: params.amount! * 12 * (hashNoise(i * 3.7 + 27.1) * 2 - 1),
      };
    },
  },
  {
    type: 'vibrate', label: 'Vibrate', kind: 'loop', duration: 0.14,
    params: [p('amount', 'Amount', 0, 0.3, 0.015, 0.001)],
    apply: ({ progress, params }) => ({ dx: params.amount! * wave(progress) }),
  },
  {
    type: 'drift', label: 'Drift', kind: 'loop', duration: 6,
    params: [p('amount', 'Amount', 0, 1, 0.1, 0.01)],
    // A circle rather than a line, so it never retraces its own path and never appears to stop.
    apply: ({ progress, params }) => ({
      dx: params.amount! * Math.cos(progress * Math.PI * 2),
      dy: params.amount! * Math.sin(progress * Math.PI * 2),
    }),
  },
  {
    type: 'hue-cycle', label: 'Hue Cycle', kind: 'loop', duration: 4,
    params: [p('range', 'Range', 0, 180, 180, 1, '°')],
    apply: ({ progress, params }) => ({
      passes: [{ type: 'color-mixer', params: { hue: params.range! * wave(progress) } }],
    }),
  },
  {
    type: 'blur-pulse', label: 'Blur Pulse', kind: 'loop', duration: 2,
    params: [p('radius', 'Blur', 0, 60, 10, 0.5, 'px')],
    apply: ({ progress, params }) => {
      const r = params.radius! * pingPong(progress);
      return r > 0.25 ? { passes: [{ type: 'blur', params: { radius: r } }] } : {};
    },
  },
  {
    type: 'glitch-loop', label: 'Glitch', kind: 'loop', duration: 1.5,
    params: [AMOUNT(0.4), p('duty', 'Burst Length', 0.05, 1, 0.3, 0.01)],
    apply: ({ progress, params }) => {
      // Bursty, not constant: a glitch that never stops stops reading as a glitch.
      if (progress > params.duty!) return {};
      return { passes: [{ type: 'glitch-fx', params: { amount: params.amount!, speed: 3 } }] };
    },
  },
  {
    type: 'rgb-shift', label: 'RGB Shift', kind: 'loop', duration: 1.8,
    params: [p('amount', 'Amount', 0, 30, 5, 0.5, 'px')],
    apply: ({ progress, params }) => ({
      passes: [{ type: 'chromatic-aberration', params: { amount: params.amount! * pingPong(progress), angle: 0 } }],
    }),
  },
  {
    type: 'squash-stretch', label: 'Squash & Stretch', kind: 'loop', duration: 1.1,
    params: [p('amount', 'Amount', 0, 0.6, 0.14, 0.01)],
    // Volume-preserving: what one axis gains the other loses, which is what makes it read as a
    // deforming object rather than as two unrelated scales.
    apply: ({ progress, params }) => {
      const k = params.amount! * wave(progress);
      return { scaleX: 1 + k, scaleY: 1 - k };
    },
  },
  {
    type: 'tilt', label: 'Tilt', kind: 'loop', duration: 3.2,
    params: [p('angle', 'Angle', 0, 30, 4, 0.5, '°')],
    apply: ({ progress, params }) => ({ rotate: params.angle! * (pingPong(progress) * 2 - 1) }),
  },
  {
    type: 'zoom-loop', label: 'Zoom Loop', kind: 'loop', duration: 5,
    params: [p('amount', 'Amount', 0, 1, 0.2, 0.01)],
    apply: ({ progress, params }) => {
      const s = 1 + params.amount! * pingPong(progress);
      return { scaleX: s, scaleY: s };
    },
  },
  {
    type: 'wave-flow', label: 'Wave', kind: 'loop', duration: 2.2,
    params: [p('amount', 'Amount', 0, 1, 0.1, 0.01), p('angle', 'Tilt', 0, 30, 6, 0.5, '°')],
    // Position and rotation a quarter-cycle apart, so it banks into the motion like a flag.
    apply: ({ progress, params }) => ({
      dy: params.amount! * wave(progress),
      rotate: params.angle! * wave(progress + 0.25),
    }),
  },
  {
    type: 'flicker', label: 'Neon Flicker', kind: 'loop', duration: 1.6,
    params: [p('amount', 'Amount', 0, 1, 0.6, 0.01), p('steps', 'Steps', 4, 60, 24, 1)],
    apply: ({ progress, params }) => {
      const i = Math.floor(progress * params.steps!);
      const n = hashNoise(i * 5.13);
      // Mostly on, occasionally dipping — a failing tube, not a strobe.
      const dip = n > 0.82 ? 1 - params.amount! * (0.4 + 0.6 * hashNoise(i * 1.7)) : 1;
      return { opacity: dip };
    },
  },
];

export const TEXT_ANIMATIONS: TextAnimationDefinition[] = [...IN, ...OUT, ...LOOP];

let registered = false;

/** Register the built-in text animations. Idempotent, like `registerBuiltins`. */
export function registerTextAnimations(): void {
  if (registered) return;
  registered = true;
  for (const a of TEXT_ANIMATIONS) registerTextAnimation(a);
}
