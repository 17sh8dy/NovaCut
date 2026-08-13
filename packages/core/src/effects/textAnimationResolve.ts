/**
 * Resolving a text clip's three animation slots into one frame's worth of instructions.
 *
 * This is the only place that knows how `animateIn`, `animateOut` and `animateLoop` combine,
 * and it is deliberately pure: `(style, localSeconds, clipSeconds) → numbers`. The compositor
 * calls it once per text clip per frame and applies the result; nothing here touches GL, the
 * DOM, or the clock. That makes the whole lane testable without a renderer, which matters
 * because timing bugs in a reveal are invisible in a screenshot and obvious only in motion.
 */

import type { TextAnimation, TextStyle } from '../model/types.js';
import { getTextAnimation, type TextAnimationOutput, type TextAnimationPass } from './registry.js';

/** One frame's resolved animation state. Every field is already composed and clamped. */
export interface ResolvedTextAnimation {
  /** Fraction of the string to paint, 0..1. */
  reveal: number;
  opacity: number;
  /** Offsets in fractions of the text's own rendered size. */
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** Degrees. */
  rotate: number;
  passes: TextAnimationPass[];
}

/** The identity state: what a clip with no animations resolves to. */
export const NEUTRAL_TEXT_ANIMATION: ResolvedTextAnimation = Object.freeze({
  reveal: 1,
  opacity: 1,
  dx: 0,
  dy: 0,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  passes: [],
});

/** True when a style has any slot filled — lets the engine skip this whole path. */
export const hasTextAnimation = (style: TextStyle | undefined): boolean =>
  !!style && (!!style.animateIn || !!style.animateOut || !!style.animateLoop);

/**
 * Fold one animation's output into the running state.
 *
 * The operators are chosen so that stacking slots behaves the way a user reading the three
 * labels would predict: opacities and scales MULTIPLY (fading to 50% while pulsing to 50%
 * gives 25%, not 0%), offsets and rotations ADD (a loop's sway rides on top of wherever the
 * entrance has moved the text to), reveal takes the MINIMUM (any slot still hiding characters
 * wins — a title that is typing on cannot simultaneously be fully typed), and passes
 * concatenate.
 */
function fold(into: ResolvedTextAnimation, out: TextAnimationOutput): void {
  if (out.reveal !== undefined) into.reveal = Math.min(into.reveal, clamp01(out.reveal));
  if (out.opacity !== undefined) into.opacity *= out.opacity;
  if (out.dx !== undefined) into.dx += out.dx;
  if (out.dy !== undefined) into.dy += out.dy;
  if (out.scaleX !== undefined) into.scaleX *= out.scaleX;
  if (out.scaleY !== undefined) into.scaleY *= out.scaleY;
  if (out.rotate !== undefined) into.rotate += out.rotate;
  if (out.passes) into.passes.push(...out.passes);
}

/** Run one slot's definition, merging the instance's params over the definition's defaults. */
function evaluate(
  slot: TextAnimation,
  content: string,
  progress: number,
  into: ResolvedTextAnimation,
): void {
  const def = getTextAnimation(slot.type);
  // An unknown type is what a project saved by a newer build (or a removed plugin) looks like.
  // Rendering it as "no animation" keeps the rest of the clip — its text, style and effects —
  // intact, which is a far better outcome than refusing to draw the clip at all.
  if (!def) return;
  const params: Record<string, number> = {};
  for (const p of def.params) params[p.key] = slot.params[p.key] ?? p.default;
  fold(into, def.apply({ content, progress, params }));
}

/**
 * Compose the slots for one frame.
 *
 * `localSeconds` is time since the clip's head; `clipSeconds` is its full length. Both in
 * seconds, matching `TextAnimation.duration`.
 */
export function resolveTextAnimation(
  style: TextStyle,
  localSeconds: number,
  clipSeconds: number,
): ResolvedTextAnimation {
  const state: ResolvedTextAnimation = {
    reveal: 1,
    opacity: 1,
    dx: 0,
    dy: 0,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    passes: [],
  };
  const content = style.content ?? '';

  /*
   * Entrance and exit are budgeted against the clip BEFORE either runs.
   *
   * On a clip shorter than its own choreography — trim a 3s title to 0.6s with a 1s fade in and
   * a 1s fade out — the naive arithmetic overlaps the two windows, and since opacities multiply
   * the title would spend its whole life partly transparent and never once reach full strength.
   * Scaling both durations by the same factor to fit preserves their ratio, so a trimmed title
   * plays the same choreography faster instead of playing it wrong. This is why a user can drag
   * a title's edge without having to go and re-tune its animation.
   */
  const inWant = style.animateIn ? Math.max(0, style.animateIn.duration) : 0;
  const outWant = style.animateOut ? Math.max(0, style.animateOut.duration) : 0;
  const want = inWant + outWant;
  const fit = want > clipSeconds && want > 0 ? clipSeconds / want : 1;
  const inDur = inWant * fit;
  const outDur = outWant * fit;

  if (style.animateIn && inDur > 0) {
    evaluate(style.animateIn, content, clamp01(localSeconds / inDur), state);
  }

  if (style.animateOut && outDur > 0) {
    // 0 while the title is still resting, ramping to 1 exactly at the clip's tail.
    const start = clipSeconds - outDur;
    evaluate(style.animateOut, content, clamp01((localSeconds - start) / outDur), state);
  }

  if (style.animateLoop) {
    const period = Math.max(0.05, style.animateLoop.duration);
    // `% 1` on a positive quotient wraps the phase; the max() guards a scrub to negative time.
    const phase = (Math.max(0, localSeconds) / period) % 1;
    evaluate(style.animateLoop, content, phase, state);
  }

  return state;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
