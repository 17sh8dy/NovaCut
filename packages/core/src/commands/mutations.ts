/**
 * Immutable update helpers.
 *
 * Every function returns a NEW Project with only the touched objects re-referenced
 * (structural sharing), so React/Zustand re-render exactly the changed panels and the
 * history stack stays memory-cheap. Commands are built from these primitives.
 */

import type { ClipId, SequenceId, TrackId } from '../model/ids.js';
import { computeSequenceDuration } from '../model/queries.js';
import type { Clip, Project, Sequence, Track } from '../model/types.js';

export function updateSequence(
  project: Project,
  sequenceId: SequenceId,
  fn: (seq: Sequence) => Sequence,
): Project {
  let changed = false;
  const sequences = project.sequences.map((s) => {
    if (s.id !== sequenceId) return s;
    changed = true;
    const next = fn(s);
    // Keep the cached duration honest after any structural change.
    return { ...next, duration: computeSequenceDuration(next) };
  });
  if (!changed) return project;
  return { ...project, sequences, modifiedAt: Date.now() };
}

export function updateTrack(
  project: Project,
  sequenceId: SequenceId,
  trackId: TrackId,
  fn: (track: Track) => Track,
): Project {
  return updateSequence(project, sequenceId, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  }));
}

/** Update a clip wherever it lives in the sequence (track-agnostic lookup). */
export function updateClip(
  project: Project,
  sequenceId: SequenceId,
  clipId: ClipId,
  fn: (clip: Clip) => Clip,
): Project {
  return updateSequence(project, sequenceId, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) => {
      if (!t.clips.some((c) => c.id === clipId)) return t;
      return { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) };
    }),
  }));
}

/** Insert a clip into a track, keeping clips sorted by start time. */
export function insertClip(
  project: Project,
  sequenceId: SequenceId,
  trackId: TrackId,
  clip: Clip,
): Project {
  return updateTrack(project, sequenceId, trackId, (t) => {
    const clips = [...t.clips, clip].sort((a, b) => a.start - b.start);
    return { ...t, clips };
  });
}

export function removeClip(project: Project, sequenceId: SequenceId, clipId: ClipId): Project {
  return updateSequence(project, sequenceId, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })),
  }));
}
