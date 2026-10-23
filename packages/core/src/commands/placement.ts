/**
 * Placing clips on the timeline without one clip silently replacing another.
 *
 * The compositor draws at most ONE clip per track per frame (it `find`s the first), so two clips
 * that overlap on a track are not "layered": one of them is simply not drawn while they overlap.
 * Dropping or dragging a clip onto occupied time therefore used to mean overriding what was there.
 * Everything here avoids that by giving the clip another place to live: the nearest free track of
 * the same kind, or a brand-new track when there is none. All of it is pure (Project in, Project
 * out) and each public command is ONE undo step, including the creation of a track.
 *
 * Kinds: audio clips live on audio tracks; everything else (video, image, text, ...) lives on video
 * tracks, matching how the compositor and the audio graph read them.
 */

import { newTrackId, type ClipId, type TrackId } from '../model/ids.js';
import { getActiveSequence } from '../model/queries.js';
import type { Ticks } from '../model/time.js';
import type { Clip, Sequence, Track, TrackKind } from '../model/types.js';
import type { Command } from './history.js';
import { updateSequence } from './mutations.js';

/** Which kind of track a clip belongs on. */
export const trackKindFor = (clip: Pick<Clip, 'kind'>): TrackKind => (clip.kind === 'audio' ? 'audio' : 'video');

const spanOverlaps = (track: Track, start: number, end: number, ignore?: ClipId): boolean =>
  track.clips.some((c) => c.id !== ignore && start < c.start + c.duration && end > c.start);

/**
 * The track a clip covering [start, end) should be on: `prefer` if it is free, otherwise the nearest
 * free unlocked track of the same kind (the one stacked above wins a tie for video, so an overlay
 * lands on top). Returns undefined when every track of that kind is busy or locked.
 */
export function chooseTrackForSpan(
  seq: Sequence,
  kind: TrackKind,
  start: number,
  end: number,
  opts: { prefer?: TrackId; ignoreClipId?: ClipId } = {},
): Track | undefined {
  const candidates = seq.tracks.filter((t) => t.kind === kind && !t.locked && !spanOverlaps(t, start, end, opts.ignoreClipId));
  if (candidates.length === 0) return undefined;
  const at = (t: Track) => seq.tracks.indexOf(t);
  const prefer = opts.prefer ? seq.tracks.findIndex((t) => t.id === opts.prefer) : -1;
  if (prefer < 0) return kind === 'video' ? candidates[candidates.length - 1] : candidates[0];
  return [...candidates].sort((a, b) => {
    const da = Math.abs(at(a) - prefer);
    const db = Math.abs(at(b) - prefer);
    if (da !== db) return da - db;
    return kind === 'video' ? at(b) - at(a) : at(a) - at(b);
  })[0];
}

/** A new empty track, named the way the rest of the app names them (V2, A3, ...). */
function newTrack(seq: Sequence, kind: TrackKind): Track {
  const count = seq.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    id: newTrackId(),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${count}`,
    clips: [],
    transitions: [],
    muted: false,
    hidden: false,
    locked: false,
    solo: false,
    height: kind === 'video' ? 72 : 56,
  };
}

/** Take a clip off whatever track holds it, along with the transitions that joined it to a neighbour. */
function detach(seq: Sequence, clipId: ClipId): Sequence {
  return {
    ...seq,
    tracks: seq.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.id !== clipId),
      transitions: t.transitions.filter((tr) => tr.fromClipId !== clipId && tr.toClipId !== clipId),
    })),
  };
}

/** Put a clip on a track, keeping the track sorted by start time. */
function attach(seq: Sequence, trackId: TrackId, clip: Clip): Sequence {
  return { ...seq, tracks: seq.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t)) };
}

/** Add `track` to the sequence in its group (video above audio, newest last), without touching the rest. */
function withTrack(seq: Sequence, track: Track): Sequence {
  const videos = seq.tracks.filter((t) => t.kind === 'video');
  const audios = seq.tracks.filter((t) => t.kind === 'audio');
  return { ...seq, tracks: track.kind === 'video' ? [...videos, track, ...audios] : [...videos, ...audios, track] };
}

/**
 * Add a NEW clip, preferring `preferTrackId`, otherwise the nearest free track of its kind, and
 * only then a new track. One undo step.
 */
export function placeClipSmart(clip: Clip, preferTrackId?: TrackId): Command {
  return {
    label: 'Add Clip',
    apply: (project) =>
      updateSequence(project, getActiveSequence(project).id, (seq) => {
        const kind = trackKindFor(clip);
        const end = clip.start + clip.duration;
        const chosen = chooseTrackForSpan(seq, kind, clip.start, end, { prefer: preferTrackId });
        if (chosen) {
          return { ...seq, tracks: seq.tracks.map((t) => (t.id === chosen.id ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t)) };
        }
        const track = { ...newTrack(seq, kind), clips: [clip] };
        return withTrack(seq, track);
      }),
  };
}

/**
 * Make sure each of `clipIds` is not covering another clip on its track, by moving it to another
 * track of its kind (or a new one) if it is. Clips that sit clear are left exactly where they are.
 *
 * `hint.newTrack` forces a single clip onto a brand-new track of that kind (the "drop here for a new
 * track" zone); it is ignored if the kind does not match the clip. Coalesced with the drag that
 * produced it (`move:<id>` for one clip), so a drag plus its settling is one undo step.
 */
export function settleClips(clipIds: readonly ClipId[], hint: { newTrack?: TrackKind } = {}): Command {
  return {
    label: clipIds.length > 1 ? 'Move Clips' : 'Move Clip',
    coalesceKey: clipIds.length === 1 ? `move:${clipIds[0]}` : `move:group:${clipIds.join(',')}`,
    apply: (project) => {
      const original = getActiveSequence(project);
      let seq = original;
      let changed = false;
      const group = new Set(clipIds);
      for (const id of clipIds) {
        const cur = seq.tracks.find((t) => t.clips.some((c) => c.id === id));
        const clip = cur?.clips.find((c) => c.id === id);
        if (!cur || !clip || cur.locked) continue;
        const kind = trackKindFor(clip);
        const end = clip.start + clip.duration;

        let destId: TrackId | undefined;
        if (hint.newTrack && clipIds.length === 1) {
          if (hint.newTrack !== kind) continue; // a video clip dropped on the "new audio track" zone stays put
        } else {
          // A group travelling together keeps its own layout, so only clips OUTSIDE it count as in the way.
          const inTheWay = cur.clips.some((c) => !group.has(c.id) && clip.start < c.start + c.duration && end > c.start);
          if (!inTheWay) continue;
          destId = chooseTrackForSpan(seq, kind, clip.start, end, { prefer: cur.id, ignoreClipId: id })?.id;
          if (destId === cur.id) continue;
        }

        let working = detach(seq, id);
        if (!destId) {
          const created = newTrack(working, kind);
          working = withTrack(working, created);
          destId = created.id;
        }
        seq = attach(working, destId, clip);
        changed = true;
      }
      return changed ? updateSequence(project, original.id, () => seq) : project;
    },
  };
}

/**
 * Shift several clips by the same amount, as one move — what dragging a multi-selection does.
 * Everything stays on its own track; the group is stopped at time zero as a whole rather than
 * squashing against it, so relative positions never change. Refuses (no-op) if any clip is on a
 * locked track. Returns the same project when nothing moves.
 */
export function moveClips(clipIds: readonly ClipId[], deltaTicks: Ticks): Command {
  return {
    label: 'Move Clips',
    coalesceKey: `move:group:${clipIds.join(',')}`,
    apply: (project) => {
      const seq = getActiveSequence(project);
      const ids = new Set(clipIds);
      const clips = seq.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => ({ c, locked: t.locked })));
      if (clips.length === 0 || clips.some((x) => x.locked)) return project;
      const minStart = Math.min(...clips.map((x) => x.c.start));
      const delta = Math.max(deltaTicks, -minStart);
      if (delta === 0) return project;
      return updateSequence(project, seq.id, (s) => ({
        ...s,
        tracks: s.tracks.map((t) =>
          t.clips.some((c) => ids.has(c.id))
            ? { ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, start: (c.start + delta) as Ticks } : c)).sort((a, b) => a.start - b.start) }
            : t,
        ),
      }));
    },
  };
}
