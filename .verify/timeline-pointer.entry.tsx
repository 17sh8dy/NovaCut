/**
 * Timeline pointer-interaction harness — real Chromium, real PointerEvents, real components.
 *
 * These are pointer-semantics bugs (capture, `buttons`, bubbling between a handle and its
 * parent), so they are asserted against the browser's own event model rather than a simulated
 * one: jsdom fakes precisely the parts that were broken, and would have passed either way.
 *
 * What is asserted is the clip MODEL after each gesture — start / duration / sourceIn / sourceOut
 * — not pixels, because "the clip looks shorter" is not the bug. The bug is whether the trimmed
 * portion actually leaves the clip's playback window.
 *
 *   npm run verify:pointer
 */

import { createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider, createAppStore } from '@opencut/ui';
import { PlaybackProvider } from '../packages/ui/src/state/playbackContext.js';
import { Timeline } from '../packages/ui/src/panels/Timeline.js';
import { Slider } from '../packages/ui/src/components/primitives/index.js';
import { Inspector } from '../packages/ui/src/panels/Inspector.js';
// The real stylesheets: the handles are 8px absolutely-positioned strips and the clip is
// absolutely positioned from an inline `left`. Without CSS every rect collapses to zero and the
// harness would be dispatching pointer events at coordinates no element occupies.
// EVERY stylesheet the app loads, in the app's order (see EditorApp.tsx), plus photo.css which
// the Photo workspace pulls in. Loading only a subset was a real hole: these files share class
// names, so a rule from one can win in the shipped bundle while the harness — never having
// loaded it — measures a layout the user never sees.
import '../packages/ui/src/theme/global.css';
import '../packages/ui/src/components/primitives/primitives.css';
import '../packages/ui/src/components/animated/animated.css';
import '../packages/ui/src/panels/panels.css';
import '../packages/ui/src/panels/timeline.css';
import '../packages/ui/src/panels/dialog.css';
import '../packages/ui/src/panels/photo.css';
import {
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  TICKS_PER_SECOND,
  type PlatformBridge,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const results: Record<string, unknown> = {};
let failures = 0;

const check = (name: string, pass: boolean, detail?: Record<string, unknown>) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

/*
 * Wait for real animation FRAMES, not milliseconds.
 *
 * Drag updates are coalesced onto requestAnimationFrame, so the thing a test must wait for is a
 * frame — and a headless window composites far slower than a visible one (measured here at
 * roughly 7fps). Sleeping a fixed 40ms therefore raced the very mechanism under test: the
 * pointerup landed first, cancelled the pending frame, and every drag reported "nothing moved".
 * Waiting on the mechanism instead is correct at any frame rate.
 */
const nextFrame = () =>
  new Promise<void>((r) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      r();
    };
    requestAnimationFrame(done);
    setTimeout(done, 250); // a stalled compositor must fail a test, never hang the suite
  });
const settle = async (n = 2) => {
  for (let i = 0; i < n; i++) await nextFrame();
};
const bridge = new Proxy({}, { get: () => async () => undefined }) as unknown as PlatformBridge;

const media = {
  id: 'm1',
  name: 'test.mp4',
  kind: 'video' as const,
  path: '/tmp/test.mp4',
  duration: 30 * S,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  // A real thumbnail, so the clip actually renders the <img> that used to hijack the gesture.
  thumbnail:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
};

const store = createAppStore(bridge);

/** px -> ticks at the timeline's CURRENT scale, so these tests survive a change of default zoom. */
const pxTicks = (px: number) => (px / store.getState().pixelsPerSecond) * S;

/** Reset to one 10s clip starting at 2s. Alt is held during gestures, so snapping is bypassed. */
function reset() {
  captured = null;
  const s = store.getState();
  s.newProject('Harness');
  s.dispatch(addMedia([media as never]));
  s.dispatch(addTrack('video'));
  const track = store.getState().sequence().tracks.find((t) => t.kind === 'video')!;
  const base = createClipFromMedia(media as never, 2 * S);
  s.dispatch(addClip(track.id, { ...base, id: 'c1', duration: 10 * S, sourceIn: 0, sourceOut: 10 * S } as never));
  store.getState().selectClip(null);
}

/** Same as `reset`, but with a second video track for the clip to be dragged onto. */
function resetTwoTracks() {
  captured = null;
  const s = store.getState();
  s.newProject('Harness');
  s.dispatch(addMedia([media as never]));
  s.dispatch(addTrack('video'));
  s.dispatch(addTrack('video'));
  const tracks = store.getState().sequence().tracks.filter((t) => t.kind === 'video');
  const base = createClipFromMedia(media as never, 2 * S);
  s.dispatch(addClip(tracks[0]!.id, { ...base, id: 'c1', duration: 10 * S, sourceIn: 0, sourceOut: 10 * S } as never));
  store.getState().selectClip(null);
  return tracks;
}

const clip = () =>
  store
    .getState()
    .sequence()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === 'c1')!;

/*
 * Synthetic pointers cannot be "captured" — setPointerCapture throws NotFoundError for a
 * pointerId the browser never issued. So capture is EMULATED rather than discarded, because
 * discarding it would quietly rig the comparison: an implementation that relies on capture
 * would stop receiving events for a reason the browser never imposed on it.
 *
 * The emulation reproduces the one property that matters here — a captured element receives the
 * pointer wherever it goes — plus the rule that makes cross-track dragging hard: capture dies
 * with the element. When React unmounts a captured clip, `isConnected` goes false and the
 * pointer reverts to normal hit-testing, exactly as Chromium does.
 */
let captured: Element | null = null;
Element.prototype.setPointerCapture = function (this: Element) {
  captured = this;
};
Element.prototype.releasePointerCapture = function () {
  captured = null;
};
const captureTarget = (): Element | null => {
  if (captured && !captured.isConnected) captured = null; // removed from the DOM: capture is gone
  return captured;
};

type PtOpts = { buttons?: number; button?: number; alt?: boolean };
function pointer(el: EventTarget, type: string, x: number, y: number, o: PtOpts = {}) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      button: o.button ?? 0,
      buttons: o.buttons ?? 1,
      altKey: o.alt ?? true, // Alt bypasses snapping, so deltas stay exact arithmetic
    }),
  );
}

/*
 * Dispatch at a POINT, on whatever element is really under it — which is what a browser does.
 * Aiming events at `window` directly would be a rigged test: it hands a window-listening
 * implementation its events while starving an element-listening one, so it would "pass" the
 * refactor for the wrong reason. Targeting the element and letting the event bubble is the
 * path a real pointer takes, and it is fair to both designs.
 */
function pointerAt(type: string, x: number, y: number, o: PtOpts = {}) {
  pointer(captureTarget() ?? document.elementFromPoint(x, y) ?? window, type, x, y, o);
}

function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const clipEl = () => document.querySelector('.oc-clip')!;
const handle = (which: 'in' | 'out') => document.querySelector('.oc-clip__handle--' + which)!;

/** Model ticks -> viewport px, the same conversion the Timeline renders with. */
const toPxNow = (t: number) => (t / S) * store.getState().pixelsPerSecond;

/** The lane element currently holding clip c1. */
const laneOfClip = () => {
  const track = store
    .getState()
    .sequence()
    .tracks.find((t) => t.clips.some((x) => x.id === 'c1'))!;
  return document.querySelector('[data-track-id="' + track.id + '"]')!;
};

/**
 * Drive a HELD drag through a series of X offsets, sampling after each one.
 *
 * This is the interaction the suite was missing: not "does one move change the model" but "does
 * the clip stay under the cursor across a whole gesture, and does what is DRAWN agree with what
 * is STORED at every sample". A clip that lags the cursor, or a DOM position that trails the
 * model by a frame, is invisible to a model-only assertion — and is exactly what a user sees.
 */
async function dragThrough(opts: {
  grabOffsetPx?: number; // where on the clip to press, from its left edge; default centre
  offsets: number[];
  alt: boolean;
}) {
  const rect = clipEl().getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const grabX =
    opts.grabOffsetPx === undefined ? rect.left + rect.width / 2 : rect.left + opts.grabOffsetPx;

  const origStart = clip().start;
  const origDuration = clip().duration;
  pointerAt('pointerdown', grabX, y, { alt: opts.alt });

  const samples: {
    dx: number;
    latencyPx: number;
    trackingErrorPx: number;
    domVsModelPx: number;
  }[] = [];

  for (const dx of opts.offsets) {
    pointerAt('pointermove', grabX + dx, y, { alt: opts.alt });

    /*
     * Sampled IMMEDIATELY, before yielding to a frame. This is the measurement that "feels
     * attached to the cursor" actually reduces to: the model must already reflect the pointer by
     * the time the event handler returns. Only reading after a frame — as this harness first did
     * — would score a full frame of deferred work as a pass, which is precisely how a laggy drag
     * slipped through a green suite.
     */
    const immediate = clip().start;

    await settle();
    const c = clip();
    const laneRect = laneOfClip().getBoundingClientRect();
    const domLeft = clipEl().getBoundingClientRect().left;
    samples.push({
      dx,
      latencyPx: (immediate - (origStart + pxTicks(dx))) / pxTicks(1),
      trackingErrorPx: (c.start - (origStart + pxTicks(dx))) / pxTicks(1),
      domVsModelPx: domLeft - (laneRect.left + toPxNow(c.start)),
    });
  }

  const lastDx = opts.offsets[opts.offsets.length - 1]!;
  pointerAt('pointerup', grabX + lastDx, y, { buttons: 0, alt: opts.alt });
  await settle();
  const afterRelease = clip().start;

  // Now move with NO button held — nothing may change.
  for (let i = 1; i <= 5; i++) pointerAt('pointermove', grabX + 400 + i * 40, y, { buttons: 0 });
  await settle();

  return {
    samples,
    worstLatency: Math.max(...samples.map((x) => Math.abs(x.latencyPx))),
    worstTracking: Math.max(...samples.map((x) => Math.abs(x.trackingErrorPx))),
    worstDom: Math.max(...samples.map((x) => Math.abs(x.domVsModelPx))),
    durationUnchanged: clip().duration === origDuration,
    movedAfterRelease: clip().start !== afterRelease,
  };
}

async function run() {
  // -- 1. Hover with no button held must not move anything -------------------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const c = centerOf(clipEl());
    for (let i = 0; i < 8; i++) pointer(clipEl(), 'pointermove', c.x + i * 12, c.y, { buttons: 0 });
    await settle();
    const after = clip();
    check('hover_does_not_move_clip', after.start === before.start && after.duration === before.duration, {
      start_s: after.start / S,
      was_s: before.start / S,
    });
  }

  // -- 2. A cancelled drag must not leave the clip glued to the cursor -------
  //    The reported bug: pointercancel delivers no pointerup, so the gesture stayed armed and
  //    the next bare hover kept moving the clip.
  {
    reset();
    await settle();
    const c = centerOf(clipEl());
    pointer(clipEl(), 'pointerdown', c.x, c.y);
    pointer(clipEl(), 'pointermove', c.x + 40, c.y);
    await settle();
    pointer(clipEl(), 'pointercancel', c.x + 40, c.y, { buttons: 0 });
    await settle();
    const afterCancel = { ...clip() };
    for (let i = 1; i <= 8; i++) pointer(clipEl(), 'pointermove', c.x + 40 + i * 25, c.y, { buttons: 0 });
    await settle();
    check('cancelled_drag_does_not_follow_hover', clip().start === afterCancel.start, {
      start_after_cancel_s: afterCancel.start / S,
      start_after_hover_s: clip().start / S,
    });
  }

  // -- 3. A click selects without moving ------------------------------------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const c = centerOf(clipEl());
    pointer(clipEl(), 'pointerdown', c.x, c.y);
    pointer(clipEl(), 'pointermove', c.x + 1, c.y); // hand jitter, under the threshold
    pointer(clipEl(), 'pointerup', c.x + 1, c.y, { buttons: 0 });
    await settle();
    check(
      'click_selects_without_moving',
      clip().start === before.start && store.getState().selectedClipIds.includes('c1' as never),
      { start_s: clip().start / S, selected: store.getState().selectedClipIds },
    );
  }

  // -- 4. Press + drag the body moves the whole clip, duration untouched -----
  {
    reset();
    await settle();
    const before = { ...clip() };
    const c = centerOf(clipEl());
    pointer(clipEl(), 'pointerdown', c.x, c.y);
    pointer(clipEl(), 'pointermove', c.x + 120, c.y);
    await settle();
    pointer(clipEl(), 'pointerup', c.x + 120, c.y, { buttons: 0 });
    await settle();
    const after = clip();
    const movedPx = (after.start - before.start) / pxTicks(1);
    check('drag_body_moves_clip', Math.abs(movedPx - 120) < 3 && after.duration === before.duration, {
      moved_px: movedPx,
      expected_px: 120,
      duration_unchanged: after.duration === before.duration,
    });
  }

  // -- 5. Trim the RIGHT edge inward: shorter clip, sourceOut pulled in ------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hOut = centerOf(handle('out'));
    pointer(handle('out'), 'pointerdown', hOut.x, hOut.y);
    pointer(handle('out'), 'pointermove', hOut.x - 120, hOut.y);
    await settle();
    pointer(handle('out'), 'pointerup', hOut.x - 120, hOut.y, { buttons: 0 });
    await settle();
    const after = clip();
    const shrunkPx = (before.duration - after.duration) / pxTicks(1);
    check(
      'trim_right_shortens_and_moves_sourceOut',
      Math.abs(shrunkPx - 120) < 3 &&
        after.start === before.start &&
        after.sourceOut === after.sourceIn + after.duration &&
        after.sourceOut < before.sourceOut,
      {
        shrunk_px: shrunkPx,
        expected_px: 120,
        start_unchanged: after.start === before.start,
        sourceOut_s: after.sourceOut / S,
        window_matches_duration: after.sourceOut - after.sourceIn === after.duration,
      },
    );
  }

  // -- 6. Trim the LEFT edge inward: start + sourceIn advance together -------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hIn = centerOf(handle('in'));
    pointer(handle('in'), 'pointerdown', hIn.x, hIn.y);
    pointer(handle('in'), 'pointermove', hIn.x + 120, hIn.y);
    await settle();
    pointer(handle('in'), 'pointerup', hIn.x + 120, hIn.y, { buttons: 0 });
    await settle();
    const after = clip();
    const movedPx = (after.start - before.start) / pxTicks(1);
    const shrunkPx = (before.duration - after.duration) / pxTicks(1);
    check(
      'trim_left_removes_beginning',
      Math.abs(movedPx - 120) < 3 &&
        Math.abs(shrunkPx - 120) < 3 &&
        after.sourceIn > before.sourceIn &&
        after.sourceOut - after.sourceIn === after.duration,
      {
        moved_px: movedPx,
        shrunk_px: shrunkPx,
        expected_px: 120,
        sourceIn_s: after.sourceIn / S,
        window_matches_duration: after.sourceOut - after.sourceIn === after.duration,
      },
    );
  }

  // -- 7. Trim applies ONCE per pointermove, not twice ----------------------
  //    The handles used to carry their own move handler AND bubble into the body's, so one
  //    event ran the trim twice and the edge tore away at double the cursor's speed.
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hOut = centerOf(handle('out'));
    pointer(handle('out'), 'pointerdown', hOut.x, hOut.y);
    pointer(handle('out'), 'pointermove', hOut.x - 60, hOut.y); // ONE event
    await settle();
    const shrunkPx = (before.duration - clip().duration) / pxTicks(1);
    pointer(handle('out'), 'pointerup', hOut.x - 60, hOut.y, { buttons: 0 });
    check('trim_is_not_double_applied', Math.abs(shrunkPx - 60) < 3, {
      shrunk_px: shrunkPx,
      expected_px: 60,
      would_be_if_doubled: 120,
    });
  }

  // -- 8. Undo restores the trimmed portion ---------------------------------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hOut = centerOf(handle('out'));
    pointer(handle('out'), 'pointerdown', hOut.x, hOut.y);
    pointer(handle('out'), 'pointermove', hOut.x - 90, hOut.y);
    await settle();
    pointer(handle('out'), 'pointerup', hOut.x - 90, hOut.y, { buttons: 0 });
    await settle();
    const trimmed = clip().duration;
    store.getState().undo();
    await settle();
    const restored = clip();
    check(
      'undo_restores_trim',
      trimmed < before.duration &&
        restored.duration === before.duration &&
        restored.sourceOut === before.sourceOut,
      { trimmed_s: trimmed / S, restored_s: restored.duration / S, original_s: before.duration / S },
    );
  }

  // -- 9. Right-click does not arm a drag -----------------------------------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const c = centerOf(clipEl());
    pointer(clipEl(), 'pointerdown', c.x, c.y, { button: 2, buttons: 2 });
    pointer(clipEl(), 'pointermove', c.x + 80, c.y, { buttons: 2 });
    await settle();
    check('right_click_does_not_drag', clip().start === before.start, {
      start_s: clip().start / S,
      was_s: before.start / S,
    });
  }

  // -- 10. A drag survives the clip crossing to another track ---------------
  //    The clip is relocated in the model, so React unmounts it from the old lane and mounts a
  //    NEW element in the new one. The gesture must not notice. Each stage is asserted
  //    separately so a failure says which half broke.
  {
    const tracks = resetTwoTracks();
    await settle();
    const trackOf = () =>
      store.getState().sequence().tracks.find((t) => t.clips.some((c) => c.id === 'c1'))!.id;

    const startTrack = trackOf();
    const targetLane = document.querySelector(`[data-track-id="${tracks[1]!.id}"]`)!;
    const laneRect = targetLane.getBoundingClientRect();
    const targetY = laneRect.top + laneRect.height / 2;

    const nodeBefore = clipEl();
    const c = centerOf(clipEl());
    // (1) start the drag, (2) move vertically onto the other track
    pointer(clipEl(), 'pointerdown', c.x, c.y);
    pointerAt('pointermove', c.x + 20, targetY);
    await settle();

    const crossed = trackOf() !== startTrack;
    // (3) the component really was torn down and rebuilt — otherwise this test proves nothing
    const nodeAfter = clipEl();
    const remounted = nodeAfter !== nodeBefore;
    const startAfterCross = clip().start;

    // (4) keep dragging WITHOUT releasing
    pointerAt('pointermove', c.x + 160, targetY);
    await settle();
    const keptDragging = clip().start > startAfterCross;
    const movedPx = (clip().start - startAfterCross) / pxTicks(1);

    // (5) release ends the drag
    pointerAt('pointerup', c.x + 160, targetY, { buttons: 0 });
    await settle();
    const startAtRelease = clip().start;

    // (6) hovering afterwards with no button held must not move it
    for (let i = 1; i <= 6; i++) pointerAt('pointermove', c.x + 160 + i * 30, targetY, { buttons: 0 });
    await settle();
    const stillAfterRelease = clip().start === startAtRelease;

    check('drag_survives_cross_track_remount', crossed && remounted && keptDragging && stillAfterRelease, {
      crossed_to_new_track: crossed,
      component_remounted: remounted,
      kept_dragging_after_remount: keptDragging,
      moved_after_remount_px: movedPx,
      still_after_release: stillAfterRelease,
      start_at_release_s: startAtRelease / S,
      start_after_hover_s: clip().start / S,
    });
  }

  // -- 11. Trimming never changes track, even with the cursor over another lane
  {
    const tracks = resetTwoTracks();
    await settle();
    const trackOf = () =>
      store.getState().sequence().tracks.find((t) => t.clips.some((c) => c.id === 'c1'))!.id;
    const before = { ...clip() };
    const startTrack = trackOf();
    const laneRect = document.querySelector(`[data-track-id="${tracks[1]!.id}"]`)!.getBoundingClientRect();
    const hOut = centerOf(handle('out'));

    pointer(handle('out'), 'pointerdown', hOut.x, hOut.y);
    pointerAt('pointermove', hOut.x - 100, laneRect.top + laneRect.height / 2);
    await settle();
    pointerAt('pointerup', hOut.x - 100, laneRect.top + laneRect.height / 2, { buttons: 0 });
    await settle();

    const after = clip();
    const shrunkPx = (before.duration - after.duration) / pxTicks(1);
    check(
      'trim_ignores_vertical_movement',
      trackOf() === startTrack && Math.abs(shrunkPx - 100) < 3 && after.sourceOut - after.sourceIn === after.duration,
      { track_unchanged: trackOf() === startTrack, shrunk_px: shrunkPx, expected_px: 100 },
    );
  }

  // -- 12. Left edge: drag in, then back out again, restoring the head --------
  //    "Dragging the left edge back to the left should restore that portion when possible."
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hIn = centerOf(handle('in'));
    pointer(handle('in'), 'pointerdown', hIn.x, hIn.y);
    pointerAt('pointermove', hIn.x + 120, hIn.y); // remove 120px of head
    await settle();
    const trimmed = { ...clip() };
    pointerAt('pointermove', hIn.x + 40, hIn.y); // give 80px of it back, same gesture
    await settle();
    const restored = { ...clip() };
    pointerAt('pointerup', hIn.x + 40, hIn.y, { buttons: 0 });
    await settle();
    const gaveBackPx = (trimmed.duration - restored.duration) / pxTicks(1) * -1;
    check(
      'trim_left_restores_head_within_gesture',
      trimmed.sourceIn > before.sourceIn &&
        restored.sourceIn < trimmed.sourceIn &&
        Math.abs(gaveBackPx - 80) < 3 &&
        restored.sourceOut - restored.sourceIn === restored.duration,
      {
        sourceIn_trimmed_s: trimmed.sourceIn / S,
        sourceIn_restored_s: restored.sourceIn / S,
        gave_back_px: gaveBackPx,
        expected_px: 80,
      },
    );
  }

  // -- 13. Left edge on an ALREADY trimmed clip, in a second gesture ---------
  {
    reset();
    await settle();
    const hIn = centerOf(handle('in'));
    pointer(handle('in'), 'pointerdown', hIn.x, hIn.y);
    pointerAt('pointermove', hIn.x + 120, hIn.y);
    await settle();
    pointerAt('pointerup', hIn.x + 120, hIn.y, { buttons: 0 });
    await settle();
    const first = { ...clip() };

    // Second gesture: grab the handle where it now is and pull left.
    const hIn2 = centerOf(handle('in'));
    pointer(handle('in'), 'pointerdown', hIn2.x, hIn2.y);
    pointerAt('pointermove', hIn2.x - 60, hIn2.y);
    await settle();
    pointerAt('pointerup', hIn2.x - 60, hIn2.y, { buttons: 0 });
    await settle();
    const second = clip();
    check(
      'trim_left_second_gesture_restores',
      first.sourceIn > 0 &&
        second.sourceIn < first.sourceIn &&
        second.duration > first.duration &&
        second.sourceOut - second.sourceIn === second.duration,
      {
        sourceIn_after_first_s: first.sourceIn / S,
        sourceIn_after_second_s: second.sourceIn / S,
        duration_after_first_s: first.duration / S,
        duration_after_second_s: second.duration / S,
      },
    );
  }

  // -- 14. Left edge cannot be pulled back past the media's own start --------
  {
    reset();
    await settle();
    const before = { ...clip() };
    const hIn = centerOf(handle('in'));
    pointer(handle('in'), 'pointerdown', hIn.x, hIn.y);
    pointerAt('pointermove', hIn.x - 400, hIn.y); // way past sourceIn 0
    await settle();
    pointerAt('pointerup', hIn.x - 400, hIn.y, { buttons: 0 });
    await settle();
    const after = clip();
    check(
      'trim_left_clamps_at_media_start',
      after.sourceIn >= 0 && after.start >= 0 && after.sourceOut - after.sourceIn === after.duration,
      {
        sourceIn_s: after.sourceIn / S,
        start_s: after.start / S,
        duration_s: after.duration / S,
        was_start_s: before.start / S,
      },
    );
  }

  // -- 15. The VERY edge of the clip trims, on both sides ---------------------
  //    Pressing 2px inside each edge — where the kind stripe used to sit as a 3px border
  //    OUTSIDE the left handle, so the left edge started a move while the right edge trimmed.
  //    Asserted through the model: a trim changes duration and leaves `start` alone (right) or
  //    moves start and sourceIn together (left); a move changes start with duration untouched.
  {
    reset();
    await settle();
    const before = { ...clip() };
    const rect = clipEl().getBoundingClientRect();
    const y = rect.top + rect.height / 2;

    // 2px inside the LEFT edge
    pointerAt('pointerdown', rect.left + 2, y);
    pointerAt('pointermove', rect.left + 2 + 90, y);
    await settle();
    pointerAt('pointerup', rect.left + 2 + 90, y, { buttons: 0 });
    await settle();
    const afterLeft = { ...clip() };
    const leftTrimmed = afterLeft.duration < before.duration && afterLeft.sourceIn > before.sourceIn;

    reset();
    await settle();
    const before2 = { ...clip() };
    const rect2 = clipEl().getBoundingClientRect();
    const y2 = rect2.top + rect2.height / 2;

    // 2px inside the RIGHT edge
    pointerAt('pointerdown', rect2.right - 2, y2);
    pointerAt('pointermove', rect2.right - 2 - 90, y2);
    await settle();
    pointerAt('pointerup', rect2.right - 2 - 90, y2, { buttons: 0 });
    await settle();
    const afterRight = clip();
    const rightTrimmed =
      afterRight.duration < before2.duration &&
      afterRight.start === before2.start &&
      afterRight.sourceOut < before2.sourceOut;

    check('both_edges_trim_at_the_very_edge', leftTrimmed && rightTrimmed, {
      left_trimmed: leftTrimmed,
      left_moved_instead: afterLeft.duration === before.duration && afterLeft.start !== before.start,
      left_sourceIn_s: afterLeft.sourceIn / S,
      right_trimmed: rightTrimmed,
      right_sourceOut_s: afterRight.sourceOut / S,
    });
  }

  // -- 16. Default zoom shows more of the timeline --------------------------
  //    A view setting only: the clip's width must follow the scale exactly, and its DURATION
  //    must be untouched by it.
  {
    reset();
    await settle();
    const pps = store.getState().pixelsPerSecond;
    const width = clipEl().getBoundingClientRect().width;
    const secs = clip().duration / S;
    check('timeline_default_zoom_is_wider', pps === 30 && Math.abs(width - secs * pps) < 4, {
      pixels_per_second: pps,
      clip_seconds: secs,
      clip_width_px: width,
      expected_width_px: secs * pps,
    });
  }

  // -- 17. Slider endpoints are fully visible inside the panel --------------
  //    The thumb is centred on its value, so at 0% and 100% half of it used to sit outside the
  //    track — and under the panel edge. Asserted geometrically: at both extremes the thumb's
  //    box must lie inside its container's box.
  {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:0; top:0; width:240px;';
    document.body.appendChild(host);
    const root = createRoot(host);

    const measure = async (value: number) => {
      root.render(h(Slider, { value, min: 0, max: 1, step: 0.01, unit: '%', onChange: () => {} }));
      await settle(2);
      const thumb = host.querySelector('.oc-slider__thumb')!.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      return { insideLeft: thumb.left >= box.left - 0.5, insideRight: thumb.right <= box.right + 0.5, thumb, box };
    };

    const atMin = await measure(0);
    const atMax = await measure(1);
    /*
     * The track must actually SPAN the panel. A slider whose track collapses toward its content
     * width shows only a stub of its range wherever the thumb sits, which to the user is
     * indistinguishable from a clipped control — and an overflow check cannot see it, because a
     * collapsed control overflows nothing.
     */
    const trackWidths = [...host.querySelectorAll('.oc-slider__track')].map(
      (t) => t.getBoundingClientRect().width / host.clientWidth,
    );
    const narrowest = trackWidths.length ? Math.min(...trackWidths) : 0;

    root.unmount();
    host.remove();

    check(
      'slider_endpoints_fit_inside_panel',
      atMin.insideLeft && atMin.insideRight && atMax.insideLeft && atMax.insideRight,
      {
        at_0_thumb_left: atMin.thumb.left,
        at_0_panel_left: atMin.box.left,
        at_100_thumb_right: atMax.thumb.right,
        at_100_panel_right: atMax.box.right,
        at_100_overhang_px: atMax.thumb.right - atMax.box.right,
      },
    );
  }

  // -- 18. The clip follows the cursor for a WHOLE gesture -------------------
  {
    reset();
    await settle();
    const r = await dragThrough({ offsets: [10, 45, 90, 150, 220, 300, 260, 180, 60], alt: true });
    check(
      'clip_follows_cursor_through_gesture',
      r.worstLatency < 2 && r.worstTracking < 2 && r.worstDom < 2 && r.durationUnchanged && !r.movedAfterRelease,
      {
        steps: r.samples.length,
        worst_latency_px: r.worstLatency,
        worst_tracking_error_px: r.worstTracking,
        worst_dom_vs_model_px: r.worstDom,
        duration_unchanged: r.durationUnchanged,
        moved_after_release: r.movedAfterRelease,
      },
    );
  }

  // -- 19. A FAST flick tracks just as exactly as a slow drag ----------------
  {
    reset();
    await settle();
    const r = await dragThrough({ offsets: [400, 40, 520, 120, 600], alt: true });
    check(
      'fast_drag_tracks_cursor',
      r.worstLatency < 2 && r.worstTracking < 2 && r.worstDom < 2 && !r.movedAfterRelease,
      {
      worst_latency_px: r.worstLatency,
      worst_tracking_error_px: r.worstTracking,
      worst_dom_vs_model_px: r.worstDom,
      moved_after_release: r.movedAfterRelease,
      },
    );
  }

  // -- 20. Pressing the BODY near an edge moves, and never trims -------------
  {
    reset();
    await settle();
    const nearLeft = await dragThrough({ grabOffsetPx: 20, offsets: [60, 140], alt: true });
    reset();
    await settle();
    const width = clipEl().getBoundingClientRect().width;
    // Rightwards: dragging left from 2s would run into the timeline's zero clamp, which is
    // correct behaviour but would show up here as a tracking error and mask the real assertion.
    const nearRight = await dragThrough({ grabOffsetPx: width - 20, offsets: [60, 140], alt: true });
    check(
      'body_near_edges_moves_without_trimming',
      nearLeft.durationUnchanged &&
        nearRight.durationUnchanged &&
        nearLeft.worstTracking < 2 &&
        nearRight.worstTracking < 2,
      {
        near_left_duration_unchanged: nearLeft.durationUnchanged,
        near_right_duration_unchanged: nearRight.durationUnchanged,
        near_left_tracking_px: nearLeft.worstTracking,
        near_right_tracking_px: nearRight.worstTracking,
      },
    );
  }

  // -- 21. Snapping still engages, and the DOM still agrees with the model ---
  {
    reset();
    await settle();
    const track = store.getState().sequence().tracks.find((t) => t.kind === 'video')!;
    const base = createClipFromMedia(media as never, 20 * S);
    store
      .getState()
      .dispatch(addClip(track.id, { ...base, id: 'c2', duration: 5 * S, sourceIn: 0, sourceOut: 5 * S } as never));
    await settle();

    const neighbour = store.getState().sequence().tracks.flatMap((t) => t.clips).find((c) => c.id === 'c2')!;
    const target = neighbour.start; // the dragged clip's trailing edge should land here
    const origStart = clip().start;
    // Aim the trailing edge a few px short of the neighbour, inside the snap threshold.
    const wantStart = target - clip().duration - pxTicks(4);
    const dx = ((wantStart - origStart) / S) * store.getState().pixelsPerSecond;

    const rect = clipEl().getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const grabX = rect.left + rect.width / 2;
    pointerAt('pointerdown', grabX, y, { alt: false });
    pointerAt('pointermove', grabX + dx, y, { alt: false });
    await settle();
    const snappedStart = clip().start;
    const laneRect = laneOfClip().getBoundingClientRect();
    const domVsModel = clipEl().getBoundingClientRect().left - (laneRect.left + toPxNow(snappedStart));
    pointerAt('pointerup', grabX + dx, y, { buttons: 0, alt: false });
    await settle();

    const trailingEdge = snappedStart + clip().duration;
    check(
      'snapping_engages_and_dom_stays_in_sync',
      Math.abs(trailingEdge - target) < pxTicks(1) && Math.abs(domVsModel) < 2,
      {
        trailing_edge_s: trailingEdge / S,
        snap_target_s: target / S,
        off_by_px: (trailingEdge - target) / pxTicks(1),
        dom_vs_model_px: domVsModel,
      },
    );
  }

  // -- 22. Alt bypasses snapping: the cursor wins over the magnet ------------
  {
    reset();
    await settle();
    const track = store.getState().sequence().tracks.find((t) => t.kind === 'video')!;
    const base = createClipFromMedia(media as never, 20 * S);
    store
      .getState()
      .dispatch(addClip(track.id, { ...base, id: 'c2', duration: 5 * S, sourceIn: 0, sourceOut: 5 * S } as never));
    await settle();

    const neighbour = store.getState().sequence().tracks.flatMap((t) => t.clips).find((c) => c.id === 'c2')!;
    const origStart = clip().start;
    const wantStart = neighbour.start - clip().duration - pxTicks(4);
    const dx = ((wantStart - origStart) / S) * store.getState().pixelsPerSecond;

    const rect = clipEl().getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const grabX = rect.left + rect.width / 2;
    pointerAt('pointerdown', grabX, y, { alt: true });
    pointerAt('pointermove', grabX + dx, y, { alt: true }); // Alt held: no magnet
    await settle();
    const start = clip().start;
    pointerAt('pointerup', grabX + dx, y, { buttons: 0, alt: true });
    await settle();

    const errPx = (start - wantStart) / pxTicks(1);
    check('alt_bypasses_snapping', Math.abs(errPx) < 2, {
      landed_s: start / S,
      wanted_s: wantStart / S,
      error_px: errPx,
    });
  }

  // -- 23. The Inspector's Transform tab fits WITHOUT scrolling --------------
  //    Measured at the panel's real size: the editor splits the top row [1, 2.4, 1] with a 240px
  //    minimum, and the vertical split gives that row 3/5 of the height. Anything taller than the
  //    body means the user has to scroll to reach Opacity, which is the complaint.
  {
    reset();
    await settle();
    store.getState().selectClip('c1' as never);
    store.getState().setInspectorTab('transform' as never);
    await settle();

    const host = document.createElement('div');
    host.style.cssText =
      'position:absolute; left:0; top:0; width:432px; height:470px; display:flex; flex-direction:column; overflow:auto;';
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(h(StoreProvider, { store, children: h(Inspector, null) } as never));
    await settle(3);

    /*
     * The element that actually scrolls is the Inspector's own tab body, not the panel: the root
     * fills its container and hands the overflow to the div holding the active tab. Measuring the
     * panel therefore always reports "fits" no matter how tall the content is — the scrollbar the
     * user sees is one level down.
     */
    const tabs = host.querySelector('.oc-inspector__tabs')!;
    const body = tabs.nextElementSibling as HTMLElement;
    const scrollH = body.scrollHeight;
    const clientH = body.clientHeight;
    const scrollW = body.scrollWidth;
    const clientW = body.clientWidth;
    const naturalH = scrollH;

    // Every slider thumb must also sit inside the panel horizontally.
    const thumbs = [...host.querySelectorAll('.oc-slider__thumb')].map((t) => t.getBoundingClientRect());
    const box = host.getBoundingClientRect();
    const worstOverhang = thumbs.length
      ? Math.max(...thumbs.map((t) => Math.max(box.left - t.left, t.right - box.right)))
      : 0;

    /*
     * The track must actually SPAN the panel. A slider whose track collapses toward its content
     * width shows only a stub of its range wherever the thumb sits, which to the user is
     * indistinguishable from a clipped control — and an overflow check cannot see it, because a
     * collapsed control overflows nothing.
     */
    const trackWidths = [...host.querySelectorAll('.oc-slider__track')].map(
      (t) => t.getBoundingClientRect().width / host.clientWidth,
    );
    const narrowest = trackWidths.length ? Math.min(...trackWidths) : 0;
    const fieldAlign = getComputedStyle(host.querySelector('.oc-field')!).alignItems;

    root.unmount();
    host.remove();

    check(
      'inspector_transform_fits_without_scrolling',
      scrollH <= clientH + 1 && scrollW <= clientW + 1 && worstOverhang <= 0.5 && narrowest > 0.8,
      {
        narrowest_track_as_fraction_of_panel: Number(narrowest.toFixed(3)),
        field_align_items: fieldAlign,
        natural_content_height_px: naturalH,
        content_height_px: scrollH,
        panel_height_px: clientH,
        vertical_overflow_px: scrollH - clientH,
        horizontal_overflow_px: scrollW - clientW,
        sliders_found: thumbs.length,
        worst_thumb_overhang_px: worstOverhang,
      },
    );
  }

  // -- 24. Nothing in a clip may start a NATIVE drag ------------------------
  //    `<img>` is draggable by default and the thumbnail covers the clip's whole body, so a
  //    press-and-move handed the gesture to HTML5 drag-and-drop: the browser lifted a ghost of
  //    the thumbnail, showed a no-drop cursor, and fired pointercancel, which ended our drag and
  //    left the clip stuck while the ghost followed the mouse.
  //
  //    Synthetic pointer events cannot start a native drag, so no amount of dispatching would
  //    have caught this — the harness is blind to it by construction. The invariant is asserted
  //    directly instead: the clip must refuse dragstart, and its decoration must be inert.
  {
    reset();
    await settle();
    store.getState().setPreference?.('timelineThumbnails', true as never);
    await settle();

    const el = clipEl() as HTMLElement;

    // A real dragstart must be prevented by the clip itself.
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    const dragRefused = ev.defaultPrevented;

    // Any image inside a clip must be non-draggable AND inert to pointers.
    const imgs = [...el.querySelectorAll('img')];
    const badImg = imgs.find(
      (i) => i.draggable !== false || getComputedStyle(i).pointerEvents !== 'none',
    );

    check('clip_cannot_start_a_native_drag', dragRefused && !badImg, {
      dragstart_prevented: dragRefused,
      images_in_clip: imgs.length,
      offending_image: badImg ? badImg.className : null,
    });
  }

  console.log('__RESULT__' + JSON.stringify({ ...results, ok: failures === 0, failures }));
}

function Harness() {
  useEffect(() => {
    void (async () => {
      try {
        await run();
      } catch (err) {
        console.log(
          '__RESULT__' +
            JSON.stringify({ ok: false, failures: 1, completed: results, error: String((err as Error)?.message ?? err) }),
        );
      }
    })();
  }, []);
  return h(StoreProvider, { store, children: h(PlaybackProvider, { children: h(Timeline, null) }) } as never);
}

createRoot(document.getElementById('root')!).render(h(Harness, null));
