/**
 * Timeline editing operations, expressed as Commands.
 *
 * Each factory returns a Command whose `apply` is a pure Project→Project transform built
 * from the mutation helpers. The History turns them into undo steps. Nothing here touches
 * UI or platform APIs.
 */

import { newClipId, newId, newTrackId, type ClipId, type MediaId, type SequenceId, type TrackId } from '../model/ids.js';
import { getActiveSequence } from '../model/queries.js';
import { clampTicks, type Ticks } from '../model/time.js';
import { getTransitionDef } from '../effects/registry.js';
import type { Clip, MediaAsset, Track, Transition } from '../model/types.js';
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

/**
 * Drop media assets from the project library.
 *
 * This removes them from OPEN CUT ONLY — nothing is deleted from disk. The library holds
 * references (`src` is a path the host reads on demand), so forgetting the reference is the
 * whole operation; the user's file is untouched and can be re-imported.
 *
 * Clips built from a removed asset go with it, across every sequence rather than just the
 * active one. Leaving them behind would strand clips whose `mediaId` resolves to nothing, which
 * is exactly the state that renders a black frame with silent audio and no way to tell why.
 */
export function removeMedia(ids: MediaId[]): Command {
  const doomed = new Set<string>(ids);
  return {
    label: ids.length > 1 ? `Remove ${ids.length} Media` : 'Remove Media',
    apply: (project) => {
      if (doomed.size === 0) return project;
      return {
        ...project,
        media: project.media.filter((m) => !doomed.has(m.id)),
        sequences: project.sequences.map((seq) => ({
          ...seq,
          tracks: seq.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => !(c.mediaId !== undefined && doomed.has(c.mediaId))),
          })),
        })),
      };
    },
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

/**
 * Place `clip` on the topmost visual track that is free for its whole span, creating a new track
 * above everything if none is.
 *
 * This exists for text, and it exists as ONE command rather than an add-track/add-clip pair for
 * two reasons. The compositor draws at most one clip per track per frame — `render()` does a
 * `find`, not a filter — so a title dropped onto the track that already holds the footage would
 * replace it rather than sit over it. And doing it as two dispatches would cost two undo steps
 * for what the user experienced as one action, which is the kind of history noise that makes
 * Ctrl+Z untrustworthy.
 *
 * Topmost-first because that is where an overlay belongs, and because reusing an empty upper
 * track keeps a project from growing a new track per caption.
 */
export function addClipOnFreeTrack(clip: Clip, kind: Track['kind'] = 'video'): Command {
  return {
    label: 'Add Clip',
    apply: (project) =>
      updateSequence(project, activeSeqId(project), (seq) => {
        const end = clip.start + clip.duration;
        const overlaps = (t: Track): boolean =>
          t.clips.some((c) => clip.start < c.start + c.duration && end > c.start);

        const sameKind = seq.tracks.filter((t) => t.kind === kind);
        // Topmost first: video tracks stack upward, so the LAST of them is the top one.
        const free = [...sameKind].reverse().find((t) => !t.locked && !overlaps(t));
        if (free) {
          return {
            ...seq,
            tracks: seq.tracks.map((t) => (t.id === free.id ? { ...t, clips: [...t.clips, clip] } : t)),
          };
        }

        const prefix = kind === 'video' ? 'V' : 'A';
        const track: Track = {
          id: newTrackId(),
          kind,
          name: `${prefix}${sameKind.length + 1}`,
          clips: [clip],
          transitions: [],
          muted: false,
          hidden: false,
          locked: false,
          solo: false,
          height: kind === 'video' ? 72 : 56,
        };
        const videos = seq.tracks.filter((t) => t.kind === 'video');
        const audios = seq.tracks.filter((t) => t.kind === 'audio');
        const tracks = kind === 'video' ? [...videos, track, ...audios] : [...videos, ...audios, track];
        return { ...seq, tracks };
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach a transition to the cut between two adjacent clips.
 *
 * The clips are NOT trimmed. A transition here is centred on the cut and borrows time from both
 * sides at render time (see `transitionWindow`), so adding one never changes the edit — which is
 * what makes it safe to try five of them in a row and undo back to where you started.
 *
 * Replaces any existing transition at the same cut rather than stacking a second one: two
 * transitions on one boundary have no defined meaning, and the renderer would silently pick
 * whichever came first.
 */
export function addTransition(
  trackId: TrackId,
  fromClipId: ClipId,
  toClipId: ClipId,
  type: string,
  duration: Ticks,
): Command {
  return {
    label: 'Add Transition',
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        const from = track.clips.find((c) => c.id === fromClipId);
        const to = track.clips.find((c) => c.id === toClipId);
        if (!from || !to) return track;
        const def = getTransitionDef(type);
        if (!def) return track; // unknown key: a no-op beats a transition that renders nothing
        const params: Record<string, number> = {};
        for (const p of def.params) params[p.key] = p.default;
        const transition: Transition = {
          id: newId('trn'),
          type,
          fromClipId,
          toClipId,
          duration,
          params,
        };
        const others = track.transitions.filter(
          (t) => !(t.fromClipId === fromClipId && t.toClipId === toClipId),
        );
        return { ...track, transitions: [...others, transition] };
      }),
  };
}

export function removeTransition(trackId: TrackId, transitionId: string): Command {
  return {
    label: 'Remove Transition',
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        const transitions = track.transitions.filter((t) => t.id !== transitionId);
        return transitions.length === track.transitions.length ? track : { ...track, transitions };
      }),
  };
}

/** Coalesced so dragging a transition's edge (or its slider) is one undo step. */
export function setTransitionDuration(
  trackId: TrackId,
  transitionId: string,
  duration: Ticks,
): Command {
  const clamped = Math.max(1, Math.round(duration)) as Ticks;
  return {
    label: 'Transition Duration',
    coalesceKey: `trn-dur:${transitionId}`,
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        let changed = false;
        const transitions = track.transitions.map((t) => {
          if (t.id !== transitionId || t.duration === clamped) return t;
          changed = true;
          return { ...t, duration: clamped };
        });
        return changed ? { ...track, transitions } : track;
      }),
  };
}

export function setTransitionParam(
  trackId: TrackId,
  transitionId: string,
  key: string,
  value: number,
): Command {
  return {
    label: 'Transition Setting',
    coalesceKey: `trn-param:${transitionId}:${key}`,
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        let changed = false;
        const transitions = track.transitions.map((t) => {
          if (t.id !== transitionId || t.params[key] === value) return t;
          changed = true;
          return { ...t, params: { ...t.params, [key]: value } };
        });
        return changed ? { ...track, transitions } : track;
      }),
  };
}

/** Swap a transition's type in place, re-seeding params from the new definition's defaults. */
export function setTransitionType(trackId: TrackId, transitionId: string, type: string): Command {
  return {
    label: 'Transition Type',
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        const def = getTransitionDef(type);
        if (!def) return track;
        let changed = false;
        const transitions = track.transitions.map((t) => {
          if (t.id !== transitionId || t.type === type) return t;
          changed = true;
          // Params are re-seeded rather than carried over: two transitions rarely share a param
          // name, and a leftover `turns` on a wipe would be dead weight in the document.
          const params: Record<string, number> = {};
          for (const p of def.params) params[p.key] = p.default;
          return { ...t, type, params };
        });
        return changed ? { ...track, transitions } : track;
      }),
  };
}

/**
 * Drop transitions whose clips are gone.
 *
 * Called by delete/split so the document does not accumulate orphans. The renderer already
 * ignores them, so this is hygiene rather than correctness — but an orphan that survives a
 * save and then matches a recycled id would stop being harmless.
 */
export function pruneTransitions(trackId: TrackId): Command {
  return {
    label: 'Prune Transitions',
    apply: (project) =>
      updateTrack(project, activeSeqId(project), trackId, (track) => {
        const ids = new Set(track.clips.map((c) => c.id));
        const transitions = track.transitions.filter(
          (t) => ids.has(t.fromClipId) && ids.has(t.toClipId),
        );
        return transitions.length === track.transitions.length ? track : { ...track, transitions };
      }),
  };
}
