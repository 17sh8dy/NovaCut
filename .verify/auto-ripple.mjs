/**
 * Auto Ripple regression tests: split, ripple delete, ripple trim, multi-track and locked-track
 * behaviour, undo/redo, source timing and repeated operations.
 *
 * Drives the real app store (`createAppStore`) and the real commands, in node, with no DOM and no
 * GPU — a check that needs a window does not get run.
 *
 *   npm run verify:ripple
 *
 * THE RULES UNDER TEST (see `trimClip` / `rippleDeleteClips` in core/src/commands/timelineCommands.ts):
 *   - Splitting never removes footage or changes the sequence length.
 *   - A ripple edit touches ONLY the edited clip's own track. Other tracks are not moved, so
 *     nothing on them can be overlapped or knocked out of sync.
 *   - A locked track refuses a ripple edit completely: nothing on it is deleted or shifted.
 *   - Clips after the edit move by exactly the amount the edited clip's end moved; gaps that
 *     already existed stay the size they were; order, source timing, effects, transforms and
 *     keyframes are untouched (only `start` changes).
 *   - Every operation is one undo step that restores the exact previous project.
 */

import { createAppStore } from '@opencut/ui';
import {
  addClip,
  addTransition,
  deleteClips,
  moveClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  rippleDeleteClips,
  splitClipsAt,
  toggleTrackFlag,
  trimClip,
  TICKS_PER_SECOND,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;
const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

// preferences are written through localStorage; give node a stand-in so persistence is testable
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const stubBridge = new Proxy({}, { get: () => async () => undefined });

const media = {
  id: 'm1', name: 'long.mp4', kind: 'video', path: '/tmp/long.mp4',
  duration: 60 * S, width: 1920, height: 1080, fps: 30, hasAudio: true,
};

/**
 * Build a store with the given clips. spec: { v1: [[id, startSec, durSec, sourceInSec?]], v2: [...], a1: [...] }
 * Clips carry a keyframe and an effect so "untouched except start" is a real assertion.
 */
function fixture(spec) {
  const store = createAppStore(stubBridge);
  const s = store.getState();
  s.dispatch(addMedia([media]));
  s.dispatch(addTrack('video'));
  s.dispatch(addTrack('video'));
  s.dispatch(addTrack('audio'));
  const tracks = store.getState().sequence().tracks;
  const ids = {
    v1: tracks.filter((t) => t.kind === 'video')[0].id,
    v2: tracks.filter((t) => t.kind === 'video')[1].id,
    a1: tracks.find((t) => t.kind === 'audio').id,
  };
  for (const key of ['v1', 'v2', 'a1']) {
    for (const [id, start, dur, srcIn = 0] of spec[key] ?? []) {
      const base = createClipFromMedia(media, start * S);
      store.getState().dispatch(
        addClip(ids[key], {
          ...base,
          id,
          start: start * S,
          duration: dur * S,
          sourceIn: srcIn * S,
          sourceOut: (srcIn + dur) * S,
          transform: {
            ...base.transform,
            x: { static: 0, keyframes: [{ id: `k-${id}`, time: Math.floor(dur * S / 2), value: 5, interpolation: 'linear' }] },
          },
          effects: [{ id: `e-${id}`, type: 'blur', enabled: true, params: { radius: 3 } }],
        }),
      );
    }
  }
  return { store, ids };
}

const seq = (st) => st.getState().sequence();
const track = (st, id) => seq(st).tracks.find((t) => t.id === id);
const clip = (st, id) => seq(st).tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const starts = (st, tid) => track(st, tid).clips.map((c) => [c.id, c.start / S]);
const snapshot = (st) => JSON.stringify(st.getState().project);
const sameButStart = (a, b) => JSON.stringify({ ...a, start: 0 }) === JSON.stringify({ ...b, start: 0 });
const noOverlap = (st) =>
  seq(st).tracks.every((t) => {
    const c = [...t.clips].sort((x, y) => x.start - y.start);
    return c.every((x, i) => i === 0 || c[i - 1].start + c[i - 1].duration <= x.start);
  });
const durationHonest = (st) => {
  const q = seq(st);
  const end = Math.max(0, ...q.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  return q.duration === end;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═══ 1. SPLITTING ═══════════════════════════════════════════════════════════
{
  const { store, ids } = fixture({ v1: [['A', 0, 10, 5], ['B', 10, 4]] });
  const before = seq(store);
  store.getState().dispatch(splitClipsAt([{ clipId: 'A', rightId: 'A2' }], 4 * S));
  const a = clip(store, 'A'), a2 = clip(store, 'A2');
  check('split_makes_two_independent_clips', !!a && !!a2 && a.id !== a2.id);
  check('split_pieces_are_adjacent', a.start === 0 && a.start + a.duration === a2.start && a2.start === 4 * S);
  check('split_keeps_total_footage', a.duration + a2.duration === 10 * S);
  check('split_keeps_sequence_duration', seq(store).duration === before.duration);
  check('split_source_in_out_correct',
    a.sourceIn === 5 * S && a.sourceOut === 9 * S && a2.sourceIn === 9 * S && a2.sourceOut === 15 * S,
    { left: [a.sourceIn / S, a.sourceOut / S], right: [a2.sourceIn / S, a2.sourceOut / S] });
  check('split_does_not_move_following_clips', clip(store, 'B').start === 10 * S);
  check('split_halves_do_not_share_state', a.effects !== a2.effects && a.transform !== a2.transform);
  store.getState().undo();
  check('split_undo_restores_one_clip', track(store, ids.v1).clips.length === 2 && clip(store, 'A').duration === 10 * S);
  // splitting at an edge or outside does nothing
  const prev = store.getState().project;
  store.getState().dispatch(splitClipsAt([{ clipId: 'A', rightId: 'Ax' }], 0));
  check('split_at_clip_edge_is_a_noop', store.getState().project === prev || eq(store.getState().sequence().tracks[0].clips.length, 2));
}

// ═══ 2. RIPPLE DELETE: beginning / middle / end ══════════════════════════════
const delSpec = () => ({ v1: [['A', 0, 2, 3], ['B', 2, 3, 10], ['C', 5, 4, 20]] });
{
  const { store, ids } = fixture(delSpec());
  const orig = { B: clip(store, 'B'), C: clip(store, 'C') };
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('ripple_delete_first_closes_gap', eq(starts(store, ids.v1), [['B', 0], ['C', 3]]), { got: starts(store, ids.v1) });
  check('ripple_delete_preserves_everything_but_start',
    sameButStart(clip(store, 'B'), orig.B) && sameButStart(clip(store, 'C'), orig.C));
  check('ripple_delete_keeps_keyframes_and_effects',
    eq(clip(store, 'C').transform.x.keyframes, orig.C.transform.x.keyframes) && eq(clip(store, 'C').effects, orig.C.effects));
  check('ripple_delete_never_stretches',
    clip(store, 'B').duration === 3 * S && clip(store, 'B').sourceIn === 10 * S && clip(store, 'B').sourceOut === 13 * S);
  check('ripple_delete_sequence_shrinks_by_clip', seq(store).duration === 7 * S);
}
{
  const { store, ids } = fixture(delSpec());
  store.getState().dispatch(rippleDeleteClips(['B']));
  check('ripple_delete_middle', eq(starts(store, ids.v1), [['A', 0], ['C', 2]]), { got: starts(store, ids.v1) });
}
{
  const { store, ids } = fixture(delSpec());
  store.getState().dispatch(rippleDeleteClips(['C']));
  check('ripple_delete_last_moves_nothing', eq(starts(store, ids.v1), [['A', 0], ['B', 2]]), { got: starts(store, ids.v1) });
}
{
  const { store, ids } = fixture(delSpec());
  store.getState().dispatch(rippleDeleteClips(['A', 'C']));
  check('ripple_delete_multi_select_same_track', eq(starts(store, ids.v1), [['B', 0]]), { got: starts(store, ids.v1) });
}

// ═══ 3. AUTO RIPPLE TOGGLE drives Delete ═════════════════════════════════════
{
  const { store, ids } = fixture(delSpec());
  const s = () => store.getState();
  check('auto_ripple_starts_off_by_default', s().rippleEnabled === false);
  s().selectClip('A');
  s().removeClips(['A']);
  check('delete_with_ripple_off_leaves_gap', eq(starts(store, ids.v1), [['B', 2], ['C', 5]]), { got: starts(store, ids.v1) });
  check('delete_clears_selection', s().selectedClipIds.length === 0);
  s().undo();
  s().toggleRipple();
  check('toggle_turns_on', s().rippleEnabled === true);
  check('toggle_is_persisted', s().preferences.rippleByDefault === true && mem.get('oc.preferences.v1')?.includes('"rippleByDefault":true'));
  s().removeClips(['A']);
  check('delete_with_ripple_on_closes_gap', eq(starts(store, ids.v1), [['B', 0], ['C', 3]]), { got: starts(store, ids.v1) });
  s().toggleRipple();
  check('toggle_turns_off_again', s().rippleEnabled === false && s().preferences.rippleByDefault === false);
}

// ═══ 4. RIPPLE TRIM ══════════════════════════════════════════════════════════
const trimSpec = () => ({ v1: [['A', 0, 4, 5], ['B', 4, 4, 20], ['C', 10, 2, 30]] }); // gap 8..10 before C
{
  // tail, shorten
  const { store, ids } = fixture(trimSpec());
  const origB = clip(store, 'B');
  store.getState().dispatch(trimClip('A', 'out', -1 * S, { ripple: true }));
  const a = clip(store, 'A');
  check('ripple_trim_tail_shorten_closes_gap', eq(starts(store, ids.v1), [['A', 0], ['B', 3], ['C', 9]]), { got: starts(store, ids.v1) });
  check('ripple_trim_tail_source_timing', a.sourceIn === 5 * S && a.sourceOut === 8 * S && a.duration === 3 * S);
  check('ripple_trim_tail_followers_untouched_but_start', sameButStart(clip(store, 'B'), origB));
  check('ripple_trim_preserves_existing_gap', clip(store, 'C').start - (clip(store, 'B').start + clip(store, 'B').duration) === 2 * S);
}
{
  // tail, lengthen: followers make room, nothing overlaps
  const { store, ids } = fixture(trimSpec());
  store.getState().dispatch(trimClip('A', 'out', 2 * S, { ripple: true }));
  check('ripple_trim_tail_lengthen_pushes_followers', eq(starts(store, ids.v1), [['A', 0], ['B', 6], ['C', 12]]), { got: starts(store, ids.v1) });
  check('ripple_trim_lengthen_no_overlap', noOverlap(store));
}
{
  // head, shorten: start stays, footage behind the head is cut, followers close up
  const { store, ids } = fixture(trimSpec());
  store.getState().dispatch(trimClip('B', 'in', 1 * S, { ripple: true }));
  const b = clip(store, 'B');
  check('ripple_trim_head_shorten_keeps_start', b.start === 4 * S && b.duration === 3 * S, { start: b.start / S, dur: b.duration / S });
  check('ripple_trim_head_source_timing', b.sourceIn === 21 * S && b.sourceOut === 24 * S);
  check('ripple_trim_head_closes_gap', eq(starts(store, ids.v1), [['A', 0], ['B', 4], ['C', 9]]), { got: starts(store, ids.v1) });
}
{
  // head, extend (restores footage from before the head)
  const { store, ids } = fixture(trimSpec());
  store.getState().dispatch(trimClip('B', 'in', -2 * S, { ripple: true }));
  const b = clip(store, 'B');
  check('ripple_trim_head_extend_uses_earlier_footage', b.sourceIn === 18 * S && b.duration === 6 * S && b.start === 4 * S);
  check('ripple_trim_head_extend_pushes_followers', clip(store, 'C').start === 12 * S && noOverlap(store));
}
{
  // head can never reveal footage before the start of the file
  const { store } = fixture({ v1: [['A', 0, 4, 0], ['B', 4, 4, 0]] });
  const before = store.getState().project;
  store.getState().dispatch(trimClip('A', 'in', -1 * S, { ripple: true }));
  check('ripple_trim_head_clamped_at_source_start', store.getState().project === before);
  // tail can never run past the end of the file
  const { store: st2 } = fixture({ v1: [['A', 0, 4, 55], ['B', 4, 4, 0]] });
  st2.getState().dispatch(trimClip('A', 'out', 10 * S, { ripple: true }));
  check('ripple_trim_tail_clamped_at_source_end', clip(st2, 'A').sourceOut === 60 * S && clip(st2, 'B').start === 5 * S,
    { out: clip(st2, 'A').sourceOut / S, bStart: clip(st2, 'B').start / S });
  // never below one tick
  const { store: st3 } = fixture({ v1: [['A', 0, 4], ['B', 4, 4]] });
  st3.getState().dispatch(trimClip('A', 'out', -100 * S, { ripple: true }));
  check('ripple_trim_never_zero_length', clip(st3, 'A').duration >= 1 && clip(st3, 'B').start === clip(st3, 'A').duration);
}
{
  // plain (non-ripple) trim is unchanged: the neighbour does not move
  const { store, ids } = fixture(trimSpec());
  store.getState().dispatch(trimClip('A', 'out', -1 * S));
  check('plain_trim_leaves_neighbours_alone', eq(starts(store, ids.v1), [['A', 0], ['B', 4], ['C', 10]]), { got: starts(store, ids.v1) });
}
{
  // a mouse drag is many incremental dispatches; one undo must undo all of them
  const { store, ids } = fixture(trimSpec());
  const before = snapshot(store);
  for (let i = 0; i < 6; i++) store.getState().dispatch(trimClip('A', 'out', -0.25 * S, { ripple: true }));
  check('ripple_drag_accumulates', clip(store, 'A').duration === 2.5 * S && clip(store, 'B').start === 2.5 * S);
  store.getState().undo();
  check('ripple_drag_is_one_undo_step', snapshot(store) === before || eq(starts(store, ids.v1), [['A', 0], ['B', 4], ['C', 10]]));
}

{
  // The mouse head-trim in clipDrag.ts keeps the clip's start fixed, so each event sends
  // (total dragged - already applied), where "already applied" is how far sourceIn has moved.
  // Replaying that formula must land exactly where one single trim of the same distance does.
  const drag = fixture(trimSpec());
  const origSourceIn = clip(drag.store, 'B').sourceIn;
  for (const total of [0.25, 0.5, 1.0, 0.75, 1.5]) {
    const applied = clip(drag.store, 'B').sourceIn - origSourceIn;
    drag.store.getState().dispatch(trimClip('B', 'in', total * S - applied, { ripple: true }));
  }
  const once = fixture(trimSpec());
  once.store.getState().dispatch(trimClip('B', 'in', 1.5 * S, { ripple: true }));
  check('ripple_head_drag_math_matches_single_trim', snapshot(drag.store).replace(/"modifiedAt":\d+/, '') === snapshot(once.store).replace(/"modifiedAt":\d+/, '') || (
    clip(drag.store, 'B').sourceIn === clip(once.store, 'B').sourceIn &&
    clip(drag.store, 'B').duration === clip(once.store, 'B').duration &&
    clip(drag.store, 'C').start === clip(once.store, 'C').start));
}

// ═══ 5. EXISTING GAPS ════════════════════════════════════════════════════════
{
  const { store, ids } = fixture({ v1: [['A', 0, 2], ['B', 2, 2], ['C', 6, 2]] }); // gap 4..6
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('gap_after_deleted_clip_survives', eq(starts(store, ids.v1), [['B', 0], ['C', 4]]), { got: starts(store, ids.v1) });
}
{
  const { store, ids } = fixture({ v1: [['A', 0, 2], ['B', 4, 2], ['C', 6, 2]] }); // gap 2..4 right after A
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('gap_between_deleted_and_next_survives', eq(starts(store, ids.v1), [['B', 2], ['C', 4]]), { got: starts(store, ids.v1) });
}

// ═══ 6. MULTI-TRACK ═════════════════════════════════════════════════════════
const multiSpec = () => ({
  v1: [['A', 0, 4], ['B', 4, 4]],
  v2: [['X', 2, 6]],
  a1: [['M', 0, 20]],
});
{
  const { store, ids } = fixture(multiSpec());
  const v2Before = track(store, ids.v2), a1Before = track(store, ids.a1);
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('ripple_delete_moves_only_its_own_track', eq(starts(store, ids.v1), [['B', 0]]));
  check('other_tracks_are_not_moved', track(store, ids.v2) === v2Before && track(store, ids.a1) === a1Before);
  store.getState().undo();
  store.getState().dispatch(trimClip('A', 'out', -2 * S, { ripple: true }));
  check('ripple_trim_moves_only_its_own_track', track(store, ids.v2) === v2Before && track(store, ids.a1) === a1Before && clip(store, 'B').start === 2 * S);
  check('multitrack_never_overlaps', noOverlap(store) && durationHonest(store));
}
{
  // one selection spanning two tracks: each closes independently
  const { store, ids } = fixture({ v1: [['A', 0, 2], ['B', 2, 2]], v2: [['X', 0, 3], ['Y', 3, 3]] });
  store.getState().dispatch(rippleDeleteClips(['A', 'X']));
  check('multi_select_across_tracks', eq(starts(store, ids.v1), [['B', 0]]) && eq(starts(store, ids.v2), [['Y', 0]]),
    { v1: starts(store, ids.v1), v2: starts(store, ids.v2) });
}

// ═══ 7. LOCKED TRACKS ════════════════════════════════════════════════════════
{
  const { store, ids } = fixture(multiSpec());
  store.getState().dispatch(toggleTrackFlag(ids.v1, 'locked'));
  const before = store.getState().project;
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('locked_track_refuses_ripple_delete', store.getState().project === before && clip(store, 'A') && clip(store, 'B').start === 4 * S);
  store.getState().dispatch(trimClip('A', 'out', -1 * S, { ripple: true }));
  check('locked_track_refuses_ripple_trim', store.getState().project === before);
  store.getState().dispatch(trimClip('A', 'in', 1 * S, { ripple: true }));
  check('locked_track_refuses_ripple_head_trim', store.getState().project === before);
  store.getState().dispatch(toggleTrackFlag(ids.v1, 'locked'));
  store.getState().dispatch(rippleDeleteClips(['A']));
  check('unlocking_allows_it_again', eq(starts(store, ids.v1), [['B', 0]]));
}
{
  // a locked track in the selection is skipped; the unlocked one still ripples
  const { store, ids } = fixture({ v1: [['A', 0, 2], ['B', 2, 2]], v2: [['X', 0, 3], ['Y', 3, 3]] });
  store.getState().dispatch(toggleTrackFlag(ids.v2, 'locked'));
  store.getState().dispatch(rippleDeleteClips(['A', 'X']));
  check('locked_track_skipped_in_multi_select', eq(starts(store, ids.v1), [['B', 0]]) && eq(starts(store, ids.v2), [['X', 0], ['Y', 3]]),
    { v1: starts(store, ids.v1), v2: starts(store, ids.v2) });
}

// ═══ 8. UNDO / REDO ═════════════════════════════════════════════════════════
{
  const { store } = fixture(multiSpec());
  const s = store.getState();
  const original = snapshot(store);
  s.dispatch(rippleDeleteClips(['A']));
  const after = snapshot(store);
  check('ripple_delete_changed_something', after !== original);
  store.getState().undo();
  check('undo_restores_exact_state', snapshot(store) === original);
  store.getState().redo();
  check('redo_reproduces_the_operation', snapshot(store) === after);
  store.getState().undo();
  store.getState().dispatch(trimClip('A', 'in', 1 * S, { ripple: true }));
  const afterTrim = snapshot(store);
  store.getState().undo();
  check('undo_ripple_trim_exact', snapshot(store) === original);
  store.getState().redo();
  check('redo_ripple_trim_exact', snapshot(store) === afterTrim);
}

// ═══ 9. REPEATED OPERATIONS ═════════════════════════════════════════════════
{
  const { store, ids } = fixture({ v1: [['A', 0, 2], ['B', 2, 2], ['C', 4, 2], ['D', 6, 2], ['E', 8, 2]] });
  const original = snapshot(store);
  let ok = true;
  for (const id of ['B', 'D', 'A']) {
    store.getState().dispatch(rippleDeleteClips([id]));
    ok = ok && noOverlap(store) && durationHonest(store);
  }
  check('repeated_deletes_stay_consistent', ok && eq(starts(store, ids.v1), [['C', 0], ['E', 2]]), { got: starts(store, ids.v1) });
  store.getState().dispatch(trimClip('C', 'out', -1 * S, { ripple: true }));
  store.getState().dispatch(trimClip('C', 'in', 0.5 * S, { ripple: true }));
  check('repeated_trims_stay_consistent', noOverlap(store) && durationHonest(store) && clip(store, 'E').start === 0.5 * S,
    { eStart: clip(store, 'E').start / S });
  for (let i = 0; i < 5; i++) store.getState().undo();
  check('five_undos_return_to_original', snapshot(store) === original);
  for (let i = 0; i < 5; i++) store.getState().redo();
  check('five_redos_replay', eq(starts(store, ids.v1), [['C', 0], ['E', 0.5]]), { got: starts(store, ids.v1) });
}
{
  // a trim that changes nothing must not create an undo step
  const { store } = fixture({ v1: [['A', 0, 4, 0], ['B', 4, 4]] });
  const before = store.getState().project;
  store.getState().dispatch(trimClip('A', 'in', 0, { ripple: true }));
  store.getState().dispatch(trimClip('A', 'out', 0, { ripple: true }));
  check('noop_ripple_trim_returns_same_project', store.getState().project === before);
}

// ═══ 10. TRANSITIONS DO NOT OUTLIVE THEIR CLIPS ══════════════════════════════
{
  const mk = () => {
    const f = fixture({ v1: [['A', 0, 2], ['B', 2, 2], ['C', 4, 2]], v2: [] });
    f.store.getState().dispatch(addTransition(f.ids.v1, 'A', 'B', 'cross-dissolve', 0.5 * S));
    f.store.getState().dispatch(addTransition(f.ids.v1, 'B', 'C', 'cross-dissolve', 0.5 * S));
    return f;
  };
  const trs = (f) => track(f.store, f.ids.v1).transitions.map((t) => `${t.fromClipId}>${t.toClipId}`);
  {
    const f = mk();
    check('transitions_exist_before_delete', eq(trs(f), ['A>B', 'B>C']), { got: trs(f) });
    f.store.getState().dispatch(deleteClips(['B']));
    check('plain_delete_drops_both_transitions_of_the_clip', trs(f).length === 0, { got: trs(f) });
    f.store.getState().undo();
    check('undo_brings_the_transitions_back', eq(trs(f), ['A>B', 'B>C']), { got: trs(f) });
  }
  {
    const f = mk();
    f.store.getState().dispatch(rippleDeleteClips(['C']));
    check('ripple_delete_drops_only_that_clips_transitions', eq(trs(f), ['A>B']), { got: trs(f) });
    f.store.getState().dispatch(rippleDeleteClips(['A']));
    check('ripple_delete_drops_the_rest', trs(f).length === 0, { got: trs(f) });
  }
  {
    const f = mk();
    f.store.getState().dispatch(rippleDeleteClips(['B']));
    check('ripple_delete_middle_leaves_no_orphans', trs(f).length === 0 && eq(starts(f.store, f.ids.v1), [['A', 0], ['C', 2]]),
      { got: trs(f), starts: starts(f.store, f.ids.v1) });
  }
  {
    const f = mk();
    f.store.getState().dispatch(deleteClips(['A']));
    check('deleting_an_end_clip_keeps_the_other_transition', eq(trs(f), ['B>C']), { got: trs(f) });
  }
  {
    const f = mk();
    f.store.getState().dispatch(moveClip('B', 2 * S, ids_v2(f), false));
    check('moving_a_clip_to_another_track_drops_its_transitions', trs(f).length === 0, { got: trs(f) });
  }
}
function ids_v2(f) { return f.ids.v2; }

console.log(JSON.stringify({ ...results, ok: failures === 0, failures, total: Object.keys(results).length }, null, 2));
process.exit(failures === 0 ? 0 : 1);
