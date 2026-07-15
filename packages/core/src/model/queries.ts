/**
 * Pure read-only queries over the domain model. No mutation happens here — commands do
 * that. Keeping reads separate keeps selectors cheap and side-effect-free.
 */

import type { ClipId, MediaId, SequenceId, TrackId } from './ids.js';
import type { Ticks } from './time.js';
import type { Clip, MediaAsset, Project, Sequence, Track } from './types.js';

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
