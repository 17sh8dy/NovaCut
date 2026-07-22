/**
 * Pure read-only queries over the domain model. No mutation happens here — commands do
 * that. Keeping reads separate keeps selectors cheap and side-effect-free.
 */

import type { ClipId, MediaId, SequenceId, TrackId } from './ids.js';
import type { Ticks } from './time.js';
import type { Clip, MediaAsset, Project, Sequence, Track, Transition } from './types.js';

export function getActiveSequence(project: Project): Sequence {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId);
  if (!seq) throw new Error(`Active sequence ${project.activeSequenceId} not found`);
  return seq;
}

export function findSequence(project: Project, id: SequenceId): Sequence | undefined {
  return project.sequences.find((s) => s.id === id);
}

export function findTrack(sequence: Sequence, id: TrackId): Track | undefined {
  return sequence.tracks.find((t) => t.id === id);
}

export function findClip(sequence: Sequence, id: ClipId): { track: Track; clip: Clip } | undefined {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return undefined;
}

export function findMedia(project: Project, id: MediaId): MediaAsset | undefined {
  return project.media.find((m) => m.id === id);
}

export const clipEnd = (clip: Clip): Ticks => clip.start + clip.duration;

/** True if a clip covers the given timeline time. */
export function clipCoversTime(clip: Clip, time: Ticks): boolean {
  return time >= clip.start && time < clipEnd(clip);
}

/** The clip on a track under a given time, if any. */
export function clipAtTime(track: Track, time: Ticks): Clip | undefined {
  return track.clips.find((c) => clipCoversTime(c, time));
}

/** Recompute a sequence's total duration from its clips. */
export function computeSequenceDuration(sequence: Sequence): Ticks {
  let max = 0;
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

/**
 * Would placing `clip` (identified by id, ignored in the overlap test) at [start, start+dur)
 * on `track` overlap an existing clip? Used to validate moves/trims.
 */
export function hasOverlap(track: Track, start: Ticks, duration: Ticks, ignoreClipId?: ClipId): boolean {
  const end = start + duration;
  return track.clips.some(
    (c) => c.id !== ignoreClipId && start < c.start + c.duration && end > c.start,
  );
}

/**
 * Candidate snap targets on the timeline: every clip edge and the playhead. Returned
 * sorted; the UI snaps a dragged edge to the nearest within a pixel threshold.
 */
export function snapTargets(sequence: Sequence, excludeClipId?: ClipId): Ticks[] {
  const targets = new Set<Ticks>([0, sequence.playhead]);
  if (sequence.inPoint != null) targets.add(sequence.inPoint);
  if (sequence.outPoint != null) targets.add(sequence.outPoint);
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      targets.add(clip.start);
      targets.add(clip.start + clip.duration);
    }
  }
  return [...targets].sort((a, b) => a - b);
}

/** Visual tracks, topmost first — the order the compositor draws (top over bottom). */
export function videoTracksTopDown(sequence: Sequence): Track[] {
  return sequence.tracks.filter((t) => t.kind === 'video').reverse();
}

export function audioTracks(sequence: Sequence): Track[] {
  return sequence.tracks.filter((t) => t.kind === 'audio');
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/** A transition resolved against the playhead: both clips, and how far through it is. */
export interface ActiveTransition {
  transition: Transition;
  from: Clip;
  to: Clip;
  /** 0 = fully the outgoing clip, 1 = fully the incoming one. */
  progress: number;
}

/**
 * The window a transition occupies on the timeline.
 *
 * Centred on the cut, taking half its duration from each side. That is the convention every
 * NLE uses for a "centred" transition, and it is the only one that works on BUTT-JOINED clips
 * — which is what this timeline produces, since it has no ripple-overlap edit. The alternative
 * (the transition living entirely inside one clip) would silently shorten that clip.
 *
 * The half-width is clamped to a third of the SHORTER clip, so a two-second transition dropped
 * between two one-second clips cannot swallow either of them whole. Clamping rather than
 * refusing means a drop always does something, and the timeline shows the width it actually got.
 */
export function transitionWindow(
  transition: Transition,
  from: Clip,
  to: Clip,
): { start: Ticks; end: Ticks; cut: Ticks } {
  // Butt-joined is the normal case (from.end === to.start); `min` also does the right thing if
  // the clips ever overlap, by putting the cut where the incoming clip starts.
  const cut = Math.min(clipEnd(from), to.start) as Ticks;
  const half = Math.max(
    1,
    Math.min(transition.duration / 2, from.duration / 3, to.duration / 3),
  );
  return { start: (cut - half) as Ticks, end: (cut + half) as Ticks, cut };
}

/**
 * The transition under the playhead on this track, or undefined.
 *
 * Returns the clips too: the caller needs BOTH, and both are outside their own time window for
 * part of the transition — which is exactly why this cannot be expressed as two `clipAtTime`
 * lookups.
 */
export function transitionAtTime(track: Track, time: Ticks): ActiveTransition | undefined {
  for (const transition of track.transitions) {
    const from = track.clips.find((c) => c.id === transition.fromClipId);
    const to = track.clips.find((c) => c.id === transition.toClipId);
    // A transition whose clips were deleted or disabled is inert rather than an error: commands
    // clean these up, but a document can always be loaded mid-way through someone else's edit.
    if (!from || !to || !from.enabled || !to.enabled) continue;
    const { start, end } = transitionWindow(transition, from, to);
    if (time < start || time >= end) continue;
    const span = Math.max(1, end - start);
    return { transition, from, to, progress: Math.min(1, Math.max(0, (time - start) / span)) };
  }
  return undefined;
}

/**
 * Every transition on a track that has both of its clips, paired with its window.
 *
 * The timeline draws from this, so a transition pointing at a deleted clip simply does not
 * appear — the same rule `transitionAtTime` applies, in one place.
 */
export function resolvedTransitions(
  track: Track,
): { transition: Transition; from: Clip; to: Clip; start: Ticks; end: Ticks; cut: Ticks }[] {
  const out: { transition: Transition; from: Clip; to: Clip; start: Ticks; end: Ticks; cut: Ticks }[] = [];
  for (const transition of track.transitions) {
    const from = track.clips.find((c) => c.id === transition.fromClipId);
    const to = track.clips.find((c) => c.id === transition.toClipId);
    if (!from || !to) continue;
    out.push({ transition, from, to, ...transitionWindow(transition, from, to) });
  }
  return out;
}

/**
 * The clip that follows `clip` on the same track, if the two are adjacent enough to join.
 *
 * "Adjacent enough" is a small tolerance rather than exact equality: clip edges come from drags
 * and trims that land on tick boundaries, and a one-tick gap is invisible to the user but would
 * make an exact test refuse a transition they can plainly see is a cut.
 */
export function nextClipOnTrack(track: Track, clip: Clip, toleranceTicks = 2): Clip | undefined {
  const end = clipEnd(clip);
  let best: Clip | undefined;
  for (const other of track.clips) {
    if (other.id === clip.id) continue;
    if (other.start + toleranceTicks < end) continue;              // starts before this one ends
    if (!best || other.start < best.start) best = other;           // the soonest one after it
  }
  if (!best) return undefined;
  return best.start - end <= toleranceTicks ? best : undefined;    // adjacent, not just later
}
