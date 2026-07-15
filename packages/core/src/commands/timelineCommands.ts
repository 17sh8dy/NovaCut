/**
 * Timeline editing operations, expressed as Commands.
 *
 * Each factory returns a Command whose `apply` is a pure Project→Project transform built
 * from the mutation helpers. The History turns them into undo steps. Nothing here touches
 * UI or platform APIs.
 */

import { newClipId, newTrackId, type ClipId, type SequenceId, type TrackId } from '../model/ids.js';
import { getActiveSequence } from '../model/queries.js';
import { clampTicks, type Ticks } from '../model/time.js';
import type { Clip, MediaAsset, Track } from '../model/types.js';
import type { Command } from './history.js';
import { insertClip, removeClip, updateClip, updateSequence, updateTrack } from './mutations.js';

const activeSeqId = (p: { activeSequenceId: SequenceId }) => p.activeSequenceId;

/** Move a clip to a new start (and optionally a new track). */
export function moveClip(
  clipId: ClipId,
  toStart: Ticks,
  toTrackId?: TrackId,
  coalesce = true,
): Command {
  return {
    label: 'Move Clip',
    coalesceKey: coalesce ? `move:${clipId}` : undefined,
    apply: (project) => {
      const seq = getActiveSequence(project);
      const source = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (!source) return project;
      const clip = source.clips.find((c) => c.id === clipId)!;
      const start = Math.max(0, toStart);
      if (!toTrackId || toTrackId === source.id) {
        return updateClip(project, seq.id, clipId, (c) => ({ ...c, start }));
      }
      // Cross-track move: remove from source, add to target.
      const target = seq.tracks.find((t) => t.id === toTrackId);
      if (!target || target.kind !== source.kind) return project;
      const removed = removeClip(project, seq.id, clipId);
      return insertClip(removed, seq.id, toTrackId, { ...clip, start });
    },
  };
}

/**
 * Trim a clip's head or tail, adjusting source-in/out so content stays anchored.
 *
 * Never produces a negative/zero length (clamped to `minLen`) and, for time-based media,
 * never trims past the available source: the head can't go before source 0, and the tail
 * can't extend beyond the media's duration. Still images (source duration 0) can extend
 * freely since they have no fixed source length.
 */
export function trimClip(clipId: ClipId, edge: 'in' | 'out', deltaTicks: Ticks): Command {
  return {
    label: 'Trim Clip',
    coalesceKey: `trim:${clipId}:${edge}`,
    apply: (project) => {
      const seq = getActiveSequence(project);
      return updateClip(project, seq.id, clipId, (c) => {
        const minLen = 1;
        const media = c.mediaId ? project.media.find((m) => m.id === c.mediaId) : undefined;
        const sourceLimit = media && media.duration > 0 ? media.duration : Infinity;
        if (edge === 'in') {
          // Dragging the head: start and sourceIn move together, duration shrinks/grows.
          // The head can't move earlier than the media's own start (sourceIn >= 0).
          const minStart = c.start - c.sourceIn; // where sourceIn would hit 0
          const newStart = clampTicks(c.start + deltaTicks, Math.max(0, minStart), c.start + c.duration - minLen);
          const applied = newStart - c.start;
          return {
            ...c,
            start: newStart,
            duration: c.duration - applied,
            sourceIn: Math.max(0, c.sourceIn + applied),
          };
        }
        // Dragging the tail: duration and sourceOut move together, capped at the media length.
        const maxDuration = sourceLimit === Infinity ? Infinity : sourceLimit - c.sourceIn;
        const newDuration = Math.min(maxDuration, Math.max(minLen, c.duration + deltaTicks));
        return { ...c, duration: newDuration, sourceOut: c.sourceIn + newDuration };
      });
    },
  };
}

/** Split the clip under `time` into two abutting clips. */
export function splitClip(clipId: ClipId, time: Ticks): Command {
  return {
    label: 'Split Clip',
    apply: (project) => {
      const seq = getActiveSequence(project);
      const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (!track) return project;
      const clip = track.clips.find((c) => c.id === clipId)!;
      if (time <= clip.start || time >= clip.start + clip.duration) return project;

      const leftDuration = time - clip.start;
      const left: Clip = { ...clip, duration: leftDuration, sourceOut: clip.sourceIn + leftDuration };
      const right: Clip = {
        ...clip,
        id: newClipId(),
        start: time,
        duration: clip.duration - leftDuration,
        sourceIn: clip.sourceIn + leftDuration,
        // Deep-copy mutable sub-objects so edits to one half don't leak into the other.
        transform: structuredClone(clip.transform),
        effects: structuredClone(clip.effects),
      };
      return updateTrack(project, seq.id, track.id, (t) => ({
        ...t,
        clips: [...t.clips.filter((c) => c.id !== clipId), left, right].sort((a, b) => a.start - b.start),
      }));
    },
  };
}

/** One clip to split, paired with the id to give its right-hand half. */
export interface SplitSpec {
  clipId: ClipId;
  /** Pre-allocated id for the new right clip (so the caller can select it afterward). */
  rightId: ClipId;
}

/**
 * Split one or more clips at a single timeline `time`, as ONE undo step.
 *
 * For each spec whose clip the time strictly bisects: the left half keeps the original id and
 * trims its tail; the right half is a fresh clip (spec.rightId) offset into the source. Mutable
 * sub-objects (transform/effects/speed/audio/text) are deep-copied so later edits to one half
 * don't leak into the other. Transitions anchored to the *tail* of a split clip follow the right
 * half; head-anchored transitions stay with the left. A clip's embedded audio rides along with
 * it, so audio/video stay linked automatically (they're the same clip).
 */
export function splitClipsAt(specs: SplitSpec[], time: Ticks): Command {
  return {
    label: specs.length > 1 ? `Split ${specs.length} Clips` : 'Split Clip',
    apply: (project) => {
      const seq = getActiveSequence(project);
      let next = project;
      for (const { clipId, rightId } of specs) {
        const track = getActiveSequence(next).tracks.find((t) => t.clips.some((c) => c.id === clipId));
        if (!track) continue;
        const clip = track.clips.find((c) => c.id === clipId)!;
        if (time <= clip.start || time >= clip.start + clip.duration) continue; // playhead not inside

        const leftDuration = time - clip.start;
        const left: Clip = { ...clip, duration: leftDuration, sourceOut: clip.sourceIn + leftDuration };
        const right: Clip = {
          ...clip,
          id: rightId,
          start: time,
          duration: clip.duration - leftDuration,
          sourceIn: clip.sourceIn + leftDuration,
          transform: structuredClone(clip.transform),
          effects: structuredClone(clip.effects),
          speed: structuredClone(clip.speed),
          ...(clip.audio ? { audio: structuredClone(clip.audio) } : {}),
          ...(clip.text ? { text: structuredClone(clip.text) } : {}),
        };
        next = updateTrack(next, seq.id, track.id, (t) => ({
          ...t,
          clips: [...t.clips.filter((c) => c.id !== clipId), left, right].sort((a, b) => a.start - b.start),
          // A transition on the clip's tail now belongs to the right half; its head to the left.
          transitions: t.transitions.map((tr) =>
            tr.fromClipId === clipId ? { ...tr, fromClipId: rightId } : tr,
          ),
        }));
      }
      return next;
    },
  };
}

export function deleteClip(clipId: ClipId): Command {
  return {
    label: 'Delete Clip',
    apply: (project) => removeClip(project, activeSeqId(project), clipId),
  };
}

/**
 * Ripple-delete: remove the clip and pull everything after it on the same track left by
 * the clip's duration, closing the gap.
 */
export function rippleDeleteClip(clipId: ClipId): Command {
  return {
    label: 'Ripple Delete',
    apply: (project) => {
      const seq = getActiveSequence(project);
      const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (!track) return project;
      const clip = track.clips.find((c) => c.id === clipId)!;
      const gap = clip.duration;
      const gapStart = clip.start;
      return updateTrack(project, seq.id, track.id, (t) => ({
        ...t,
        clips: t.clips
          .filter((c) => c.id !== clipId)
          .map((c) => (c.start >= gapStart ? { ...c, start: c.start - gap } : c)),
      }));
    },
  };
}

export function duplicateClip(clipId: ClipId): Command {
  return {
    label: 'Duplicate Clip',
    apply: (project) => {
      const seq = getActiveSequence(project);
      const found = seq.tracks
        .flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })))
        .find((x) => x.clip.id === clipId);
      if (!found) return project;
      const copy: Clip = {
        ...structuredClone(found.clip),
        id: newClipId(),
        start: found.clip.start + found.clip.duration,
      };
      return insertClip(project, seq.id, found.track.id, copy);
    },
  };
}

/** Add a clip built elsewhere (e.g. from a dropped media asset) to a track. */
export function addClip(trackId: TrackId, clip: Clip): Command {
  return {
    label: 'Add Clip',
    apply: (project) => insertClip(project, activeSeqId(project), trackId, clip),
  };
}

/**
 * Register imported media assets on the project. This MUST go through the History like every
 * other project change: media added by directly mutating the store's project (bypassing
 * History) is silently discarded the next time any command runs, because dispatch() rebuilds
 * the project from History's snapshot — leaving timeline clips pointing at missing media.
 */
export function addMedia(assets: MediaAsset[]): Command {
  return {
    label: assets.length > 1 ? `Import ${assets.length} Media` : 'Import Media',
    apply: (project) =>
      assets.length === 0 ? project : { ...project, media: [...project.media, ...assets] },
  };
}

export function setPlayhead(time: Ticks): Command {
  return {
    label: 'Seek',
    coalesceKey: 'seek', // scrubbing is never an undo step of its own
    apply: (project) =>
      updateSequence(project, activeSeqId(project), (s) => ({
        ...s,
        playhead: Math.max(0, time),
      })),
  };
}

// ── Track operations ─────────────────────────────────────────────────────────

type TrackFlag = 'muted' | 'hidden' | 'locked' | 'solo';

export function toggleTrackFlag(trackId: TrackId, flag: TrackFlag): Command {
  return {
    label: `Toggle ${flag}`,
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (t) => ({ ...t, [flag]: !t[flag] })),
  };
}

export function renameTrack(trackId: TrackId, name: string): Command {
  return {
    label: 'Rename Track',
    apply: (project) => updateTrack(project, activeSeqId(project), trackId, (t) => ({ ...t, name })),
  };
}

export function addTrack(kind: Track['kind']): Command {
  return {
    label: 'Add Track',
    apply: (project) =>
      updateSequence(project, activeSeqId(project), (seq) => {
        const count = seq.tracks.filter((t) => t.kind === kind).length + 1;
        const prefix = kind === 'video' ? 'V' : 'A';
        const track: Track = {
          id: newTrackId(),
          kind,
          name: `${prefix}${count}`,
          clips: [],
          transitions: [],
          muted: false,
          hidden: false,
          locked: false,
          solo: false,
          height: kind === 'video' ? 72 : 56,
        };
        // Video tracks stack above; audio below. Insert to preserve that grouping.
        const videos = seq.tracks.filter((t) => t.kind === 'video');
        const audios = seq.tracks.filter((t) => t.kind === 'audio');
        const tracks = kind === 'video' ? [...videos, track, ...audios] : [...videos, ...audios, track];
        return { ...seq, tracks };
      }),
  };
}
