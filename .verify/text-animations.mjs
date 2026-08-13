/**
 * Text animation invariants — a behaviour check for the three-slot animation lane.
 *
 * Animation bugs are the ones that testing-by-looking is worst at. A reveal that ends at 97%
 * opacity, an exit that starts a frame early, a loop whose first and last frame disagree — all
 * of them look fine in a screenshot and wrong only in motion, at speed, once. So the properties
 * that make an animation correct are asserted here directly, over the whole catalog.
 *
 * What is checked, and why each one is a real failure mode:
 *
 *   1. Catalog shape — 25 in / 25 out / 25 loop, unique types, every param sane.
 *   2. Entrances RESOLVE. At progress 1 an `in` animation must be the identity: full opacity,
 *      no offset, unit scale, no rotation, fully revealed. Anything else means the title never
 *      quite arrives and sits permanently askew for the rest of the clip.
 *   3. Exits START from rest, for the same reason in the other direction: at progress 0 the
 *      title must be untouched, or it visibly jumps the instant the exit window opens.
 *   4. Loops CLOSE — the wrap from the end of one cycle to the start of the next is no bigger a
 *      jump than the animation already makes internally, or it ticks once per cycle forever.
 *   5. Purity — `apply` called twice with the same input gives the same answer, which is what
 *      lets the preview and the export agree.
 *   6. The resolver's budget: in + out longer than the clip must be scaled to fit, never
 *      overlapped, or a trimmed title spends its whole life semi-transparent.
 *   7. Unknown types degrade to neutral instead of throwing.
 *
 * Needs no GPU and no Electron.
 *
 *   npm run verify:textanim
 */

import {
  NEUTRAL_TEXT_ANIMATION,
  allTextAnimations,
  defaultParams,
  hasTextAnimation,
  registerBuiltins,
  resolveTextAnimation,
  textAnimationsByKind,
} from '@opencut/core';

registerBuiltins();

const results = {};
let failures = 0;
const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

const run = (def, progress) =>
  def.apply({ content: 'Hello World', progress, params: defaultParams(def.params) });

/** How far an output is from doing nothing at all. */
const drift = (o) =>
  Math.abs((o.opacity ?? 1) - 1) +
  Math.abs(o.dx ?? 0) +
  Math.abs(o.dy ?? 0) +
  Math.abs((o.scaleX ?? 1) - 1) +
  Math.abs((o.scaleY ?? 1) - 1) +
  Math.abs(o.rotate ?? 0) / 360 +
  Math.abs((o.reveal ?? 1) - 1);

const style = (slots) => ({ content: 'Hello World', ...slots });

// ── 1. Catalog shape ────────────────────────────────────────────────────────
{
  const all = allTextAnimations();
  const kinds = { in: textAnimationsByKind('in'), out: textAnimationsByKind('out'), loop: textAnimationsByKind('loop') };
  const types = all.map((a) => a.type);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  const badParams = all.flatMap((a) =>
    a.params
      .filter((p) => !(p.min <= p.default && p.default <= p.max) || p.step <= 0)
      .map((p) => `${a.type}.${p.key}`),
  );
  const badDuration = all.filter((a) => !(a.duration > 0)).map((a) => a.type);

  check('catalog_shape',
    kinds.in.length >= 25 && kinds.out.length >= 25 && kinds.loop.length >= 25 &&
    dupes.length === 0 && badParams.length === 0 && badDuration.length === 0,
    { in: kinds.in.length, out: kinds.out.length, loop: kinds.loop.length, total: all.length,
      duplicate_types: dupes, params_out_of_range: badParams, non_positive_duration: badDuration });
}

// ── 2. Entrances resolve to the identity ────────────────────────────────────
{
  const bad = textAnimationsByKind('in')
    .map((d) => ({ type: d.type, drift: drift(run(d, 1)) }))
    .filter((r) => r.drift > 0.02);
  check('entrances_settle_at_rest', bad.length === 0, { offenders: bad });
}

// ── 3. Exits begin from rest ────────────────────────────────────────────────
{
  const bad = textAnimationsByKind('out')
    .map((d) => ({ type: d.type, drift: drift(run(d, 0)) }))
    .filter((r) => r.drift > 0.02);
  check('exits_start_at_rest', bad.length === 0, { offenders: bad });
}

// ── 4. Loops close on themselves ────────────────────────────────────────────
//
// Naively this is "output at phase 0 must equal output at phase 1". That is the right property
// for a smooth loop and the WRONG one for a deliberately stepped one: `shake`, `jitter` and
// `blink` jump on every step by design, so a jump at the wrap is indistinguishable from any
// other and failing them would only teach us to add an allowlist — which is how a check stops
// catching things.
//
// The property that actually holds for all of them: the seam may not be a BIGGER jump than the
// animation already makes internally. A smooth loop's internal jumps are ~0, so a real seam bug
// still fails loudly; a stepped loop is judged against its own step size.
{
  const bad = [];
  const SAMPLES = 240;
  const dist = (a, b) =>
    Math.abs((a.opacity ?? 1) - (b.opacity ?? 1)) +
    Math.abs((a.dx ?? 0) - (b.dx ?? 0)) +
    Math.abs((a.dy ?? 0) - (b.dy ?? 0)) +
    Math.abs((a.scaleX ?? 1) - (b.scaleX ?? 1)) +
    Math.abs((a.scaleY ?? 1) - (b.scaleY ?? 1)) +
    Math.abs((a.reveal ?? 1) - (b.reveal ?? 1)) +
    // Compared modulo a full turn: `spin-loop` ends one revolution from where it began, which
    // is the same pose on screen.
    Math.min(Math.abs((a.rotate ?? 0) - (b.rotate ?? 0)) % 360, 360 - (Math.abs((a.rotate ?? 0) - (b.rotate ?? 0)) % 360)) / 90;

  for (const d of textAnimationsByKind('loop')) {
    let worstInternal = 0;
    let prev = run(d, 0);
    for (let i = 1; i < SAMPLES; i++) {
      const cur = run(d, i / SAMPLES);
      worstInternal = Math.max(worstInternal, dist(prev, cur));
      prev = cur;
    }
    // The seam: the last sampled frame of one cycle against the first frame of the next.
    const seam = dist(prev, run(d, 0));
    if (seam > worstInternal * 1.05 + 0.01) {
      bad.push({ type: d.type, seam: +seam.toFixed(4), worst_internal_step: +worstInternal.toFixed(4) });
    }
  }
  check('loops_close_seamlessly', bad.length === 0, { offenders: bad });
}

// ── 5. apply() is pure ──────────────────────────────────────────────────────
{
  const bad = allTextAnimations()
    .filter((d) => JSON.stringify(run(d, 0.37)) !== JSON.stringify(run(d, 0.37)))
    .map((d) => d.type);
  check('apply_is_deterministic', bad.length === 0, { offenders: bad });
}

// ── 6. The in/out budget never overlaps ─────────────────────────────────────
{
  // A 0.6s clip carrying a 1s fade-in and a 1s fade-out: both must be squeezed into 0.3s each.
  const s = style({
    animateIn: { type: 'fade-in', params: {}, duration: 1 },
    animateOut: { type: 'fade-out', params: {}, duration: 1 },
  });
  const clip = 0.6;
  const mid = resolveTextAnimation(s, clip / 2, clip);
  const start = resolveTextAnimation(s, 0, clip);
  const end = resolveTextAnimation(s, clip, clip);
  // At the midpoint the entrance has just finished and the exit has not started, so the title
  // must be at FULL opacity — the failure this guards is it never exceeding ~0.25.
  check('trimmed_clip_still_reaches_full_opacity', Math.abs(mid.opacity - 1) < 0.02, {
    clip_seconds: clip,
    opacity_at_midpoint: mid.opacity,
    opacity_at_start: start.opacity,
    opacity_at_end: end.opacity,
  });
}

// ── 7. Slots compose, and unknown types are survivable ──────────────────────
{
  const composed = style({
    animateIn: { type: 'fade-in', params: {}, duration: 0.5 },
    animateLoop: { type: 'pulse', params: { amount: 0.2 }, duration: 1 },
  });
  // Half a second in: the fade is done, the pulse is at phase 0.5 (its peak).
  const r = resolveTextAnimation(composed, 0.5, 4);
  const pulsing = Math.abs(r.scaleX - 1) > 0.01 && Math.abs(r.opacity - 1) < 0.02;

  const unknown = style({ animateIn: { type: 'no-such-animation', params: {}, duration: 0.5 } });
  let survived = true;
  let neutral = false;
  try {
    const u = resolveTextAnimation(unknown, 0.1, 2);
    neutral = u.opacity === 1 && u.reveal === 1 && u.dx === 0 && u.scaleX === 1;
  } catch {
    survived = false;
  }

  check('slots_compose_and_unknown_is_neutral', pulsing && survived && neutral, {
    loop_scale_at_peak: r.scaleX,
    opacity_after_entrance: r.opacity,
    unknown_type_survived: survived,
    unknown_type_neutral: neutral,
    has_animation_detects_slots: hasTextAnimation(composed) && !hasTextAnimation({ content: 'x' }),
    neutral_is_identity: NEUTRAL_TEXT_ANIMATION.opacity === 1 && NEUTRAL_TEXT_ANIMATION.reveal === 1,
  });
}

// ── 8. Reveal never leaves the 0..1 range ───────────────────────────────────
{
  const bad = [];
  for (const d of allTextAnimations()) {
    for (let i = 0; i <= 20; i++) {
      const r = run(d, i / 20).reveal;
      if (r !== undefined && (r < 0 || r > 1 || Number.isNaN(r))) bad.push({ type: d.type, at: i / 20, reveal: r });
    }
  }
  check('reveal_stays_in_range', bad.length === 0, { offenders: bad.slice(0, 8) });
}

results.ok = failures === 0;
results.failures = failures;
console.log(JSON.stringify(results, null, 2));
process.exit(failures ? 1 : 0);
