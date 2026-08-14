/**
 * The clip drag session — one gesture, owned outside React.
 *
 * A drag used to live in the `TimelineClip` that started it, which made the gesture only as
 * durable as that component. Dragging a clip onto another track relocates it in the model, so
 * React unmounts it from the old lane and mounts a fresh one in the new lane; the element that
 * held the pointer capture is destroyed mid-gesture, its `pointerup` is never delivered, and the
 * new component knows nothing about a drag being in progress. The clip stopped following the
 * cursor halfway through the very move the user was making.
 *
 * So the session lives here instead: module state plus window listeners. Nothing about it is
 * tied to a mounted component, and the events arrive at the window whether or not the clip is
 * still where it started. Remounting becomes what it should be — a rendering detail.
 *
 * Two rules keep this from decaying back into the stuck-drag bug it replaced:
 *
 *   1. EVERY exit ends the session. pointerup, pointercancel, lostpointercapture and losing the
 *      window all land on `endDrag`, and `pointermove` additionally checks `buttons` on the way
 *      in — so even an exit nobody anticipated is caught by the first move that follows it.
 *   2. NOTHING is captured from the component. The clip, the scale, the snap settings and the
 *      preferences are all read from the store per event, so a session can never act on a clip
 *      that has since changed underneath it — the stale-closure bug class simply has nowhere
 *      left to live.
 */

import {
  formatTimecode,
  moveClip,
  seconds,
  snapTargets,
  trimClip,
  type ClipId,
  type Ticks,
} from '@opencut/core';
import type { AppStore } from '../state/store.js';

export type ClipDragMode = 'move' | 'in' | 'out';

/**
 * How far the pointer must travel before a press becomes a drag. Small enough that a deliberate
 * drag feels immediate, large enough that the hand-jitter in an ordinary click never moves a clip
 * or trims a frame off it.
 */
const DRAG_THRESHOLD_PX = 3;

/** The shortest a clip may be trimmed to by dragging its tail. */
const MIN_TRIM_DURATION = seconds(0.05);

interface DragSession {
  store: AppStore;
  clipId: ClipId;
  mode: ClipDragMode;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where the clip was when the gesture started — every delta is measured from these. */
  origStart: Ticks;
  origDur: Ticks;
  /** False until the pointer clears the threshold: a press is a candidate for a drag, not one. */
  active: boolean;
  /** Live position/duration readout, drawn by whichever component currently renders this clip. */
  readout: string | null;
  /** Last vertical position hit-tested, and what it resolved to. See `apply`. */
  lastY: number;
  lastTrackId: string | null;
}

let session: DragSession | null = null;

/*
 * Moves are applied SYNCHRONOUSLY, on the event.
 *
 * They were briefly coalesced onto requestAnimationFrame, on the theory that a high-rate mouse
 * floods the handler. It does not: Chromium already aligns pointermove dispatch to the frame,
 * merging the raw samples in between (which is the whole reason `getCoalescedEvents` exists).
 * So there was no flood to spread out — the rAF only ever deferred the update to the NEXT
 * frame, adding a full frame of latency to a gesture whose entire job is to feel welded to the
 * cursor. Handling the event where it arrives puts the model change in the same frame the
 * browser already scheduled for it.
 *
 * The expensive part of a move is not the arithmetic, it is `elementFromPoint` forcing a layout
 * flush; `apply` skips that whenever the pointer has not changed lane, so a straight horizontal
 * drag — the common case — does no hit-testing at all.
 */

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Subscribe to session changes (for `useSyncExternalStore`). */
export function subscribeClipDrag(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The readout for one clip, or null when this clip is not the one being dragged. Returning a
 * primitive keeps `useSyncExternalStore` happy and means a drag only re-renders the clip it is
 * actually dragging, not every clip on the timeline.
 */
export function clipDragReadout(clipId: ClipId): string | null {
  return session && session.clipId === clipId ? session.readout : null;
}

/** True while `clipId` is mid-gesture — used to keep the drag cursor while the pointer is held. */
export function isClipDragging(clipId: ClipId): boolean {
  return session !== null && session.active && session.clipId === clipId;
}

/**
 * Arm a gesture on `clipId`. The caller has already decided this is a legitimate start (primary
 * button, track not locked) and handled selection; everything after this point is ours.
 */
export function beginClipDrag(opts: {
  store: AppStore;
  clipId: ClipId;
  mode: ClipDragMode;
  pointerId: number;
  clientX: number;
  clientY: number;
  origStart: Ticks;
  origDur: Ticks;
}): void {
  endDrag(); // a new press always supersedes whatever came before it
  session = {
    store: opts.store,
    clipId: opts.clipId,
    mode: opts.mode,
    pointerId: opts.pointerId,
    startX: opts.clientX,
    startY: opts.clientY,
    origStart: opts.origStart,
    origDur: opts.origDur,
    active: false,
    readout: null,
    lastY: opts.clientY,
    lastTrackId: null,
  };
  attach();
}

function attach(): void {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  // Capture is not used to drive the drag — that is precisely what broke across a remount — but
  // if anything else takes or drops it mid-gesture, treat it as the gesture ending.
  window.addEventListener('lostpointercapture', onPointerUp);
  // Alt-tabbing away swallows the release: without this the session would outlive the gesture.
  window.addEventListener('blur', endDrag);
}

function detach(): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  window.removeEventListener('lostpointercapture', onPointerUp);
  window.removeEventListener('blur', endDrag);
}

function onPointerUp(e: Event): void {
  // Ignore a second pointer finishing its own gesture while this one is still down.
  if (e instanceof PointerEvent && session && e.pointerId !== session.pointerId) return;
  endDrag();
}

/** End the gesture and put the timeline back in its resting state. Safe to call at any time. */
export function endDrag(): void {
  const d = session;
  if (!d) return;
  session = null;
  detach();
  d.store.getState().setSnapGuide(null); // hide the guide line when the drag ends
  emit();
}

function onPointerMove(e: PointerEvent): void {
  const d = session;
  if (!d) return;
  if (e.pointerId !== d.pointerId) return; // a different pointer; not this gesture

  /*
   * The hover guard. A live session says a gesture was armed, NOT that the button is still
   * down, and the two can disagree — that disagreement is how hovering used to drag a clip
   * across the timeline. `buttons` reads 0 the instant nothing is pressed, so a session that
   * outlived its gesture ends on the first stray move rather than acting on it.
   */
  if ((e.buttons & 1) === 0) return endDrag();

  if (!d.active) {
    if (
      Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX &&
      Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    d.active = true;
  }

  if (!apply(d, e)) endDrag(); // the clip was deleted under us
}

/**
 * The nearest magnetic snap target to `t`, or `t` itself when nothing is in range. Everything it
 * needs — the threshold preference, the live playhead, the other clips' edges — is read from the
 * store at the moment of the move, so changing snap strength in Settings mid-drag takes effect
 * immediately and a session can never snap against a stale timeline.
 */
function snapResult(
  d: DragSession,
  t: Ticks,
  disabled: boolean,
  toTicks: (px: number) => Ticks,
): { value: Ticks; guide: Ticks | null } {
  const s = d.store.getState();
  if (!s.snapEnabled || disabled) return { value: t, guide: null };
  const threshold = toTicks(s.preferences.snapStrength);
  let best = t;
  let bestDist = threshold;
  let guide: Ticks | null = null;
  for (const target of [s.playhead, ...snapTargets(s.sequence(), d.clipId)]) {
    const dist = Math.abs(target - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
      guide = target;
    }
  }
  return { value: best, guide };
}

function apply(d: DragSession, e: { clientX: number; clientY: number; altKey: boolean }): boolean {
  const state = d.store.getState();
  const seq = state.sequence();
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
  if (!clip) return false; // deleted mid-drag; there is nothing left to move

  const toTicks = (px: number): Ticks => seconds(px / state.pixelsPerSecond);
  const alt = e.altKey; // hold Alt to temporarily disable snapping
  const deltaTicks = toTicks(e.clientX - d.startX);

  if (d.mode === 'move') {
    /*
     * The target track is whatever lane is under the cursor. Reading it from the DOM rather than
     * from a captured lane id is what lets a drag cross tracks at all: the clip's own component
     * is remounted into the new lane by this very dispatch, and the next move simply asks the
     * document again.
     */
    let targetTrackId = d.lastTrackId;
    if (targetTrackId === null || Math.abs(e.clientY - d.lastY) >= 1) {
      const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-id]');
      targetTrackId = laneEl?.getAttribute('data-track-id') ?? null;
      d.lastY = e.clientY;
      d.lastTrackId = targetTrackId;
    }
    const raw = Math.max(0, d.origStart + deltaTicks);
    // Snap either the leading OR trailing edge — whichever lands closest to a target.
    const lead = snapResult(d, raw, alt, toTicks);
    const trail = snapResult(d, raw + clip.duration, alt, toTicks);
    let newStart = raw;
    let guide: Ticks | null = null;
    const leadDist = lead.guide != null ? Math.abs(lead.value - raw) : Infinity;
    const trailDist = trail.guide != null ? Math.abs(trail.value - (raw + clip.duration)) : Infinity;
    if (leadDist <= trailDist && lead.guide != null) {
      newStart = Math.max(0, lead.value);
      guide = lead.guide;
    } else if (trail.guide != null) {
      newStart = Math.max(0, trail.value - clip.duration);
      guide = trail.guide;
    }
    state.setSnapGuide(guide);
    state.dispatch(moveClip(d.clipId, newStart, (targetTrackId ?? undefined) as never, true));
    d.readout = formatTimecode(newStart, state.sequence().fps);
  } else if (d.mode === 'in') {
    const desired = snapResult(d, d.origStart + deltaTicks, alt, toTicks);
    state.setSnapGuide(desired.guide);
    state.dispatch(trimClip(d.clipId, 'in', desired.value - clip.start));
  } else {
    const desired = snapResult(d, d.origStart + d.origDur + deltaTicks, alt, toTicks);
    state.setSnapGuide(desired.guide);
    const newDur = Math.max(MIN_TRIM_DURATION, desired.value - clip.start);
    state.dispatch(trimClip(d.clipId, 'out', newDur - clip.duration));
  }

  // Show the resulting duration (trim) or start position (move) while dragging.
  if (d.mode !== 'move') {
    const after = d.store
      .getState()
      .sequence()
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === d.clipId);
    if (after) d.readout = formatTimecode(after.duration, d.store.getState().sequence().fps);
  }
  emit();
  return true;
}
