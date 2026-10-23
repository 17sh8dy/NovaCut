/**
 * Timeline freedom: clips and media are never forced to override one another, a clip can be moved
 * (alone or as a group) and placed on another track or a brand-new one, and a title can be put
 * anywhere in the frame.
 *
 *   npm run verify:freedom
 *
 * Drives the real app store and the real commands in node. The pointer gestures that call them are
 * covered by verify:freedomui.
 */

import { createAppStore } from '@opencut/ui';
import {
  addClip,
  addMedia,
  addTrack,
  chooseTrackForSpan,
  clipQuad,
  createClipFromMedia,
  createTextClip,
  getActiveSequence,
  moveClip,
  moveClips,
  placeClipSmart,
  quadContains,
  setClipPosition,
  settleClips,
  toggleTrackFlag,
  trackKindFor,
  addTransition,
  TICKS_PER_SECOND,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;
const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const stubBridge = new Proxy({}, { get: () => async () => undefined });
const video = { id: 'v1', name: 'a.mp4', kind: 'video', path: '/tmp/a.mp4', duration: 120 * S, width: 1920, height: 1080, fps: 30, hasAudio: true };
const music = { id: 'a1', name: 'song.mp3', kind: 'audio', path: '/tmp/song.mp3', duration: 120 * S, width: 0, height: 0, hasAudio: true };

/** spec: { v: [[ [id,start,dur], ... ], ...per video track], a: [[...], ...per audio track] } */
function fixture(spec) {
  const store = createAppStore(stubBridge);
  const s = store.getState();
  s.dispatch(addMedia([video, music]));
  const wantV = spec.v?.length ?? 0;
  const wantA = spec.a?.length ?? 0;
  const have = (k) => store.getState().sequence().tracks.filter((t) => t.kind === k).length;
  while (have('video') < wantV) s.dispatch(addTrack('video'));
  while (have('audio') < wantA) s.dispatch(addTrack('audio'));
  const tr = (k) => store.getState().sequence().tracks.filter((t) => t.kind === k);
  const ids = { v: tr('video').map((t) => t.id), a: tr('audio').map((t) => t.id) };
  for (const [kind, lists] of [['v', spec.v ?? []], ['a', spec.a ?? []]]) {
    lists.forEach((clips, i) => {
      for (const [id, start, dur] of clips) {
        const m = kind === 'a' ? music : video;
        store.getState().dispatch(addClip(ids[kind][i], { ...createClipFromMedia(m, start * S), id, start: start * S, duration: dur * S, sourceOut: dur * S }));
      }
    });
  }
  return { store, ids };
}
const seq = (st) => st.getState().sequence();
const trackOf = (st, clipId) => seq(st).tracks.find((t) => t.clips.some((c) => c.id === clipId));
const clip = (st, id) => seq(st).tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const snap = (st) => JSON.stringify(st.getState().project);
const noOverlap = (st) =>
  seq(st).tracks.every((t) => {
    const c = [...t.clips].sort((a, b) => a.start - b.start);
    return c.every((x, i) => i === 0 || c[i - 1].start + c[i - 1].duration <= x.start);
  });

// ═══ 1. Choosing a track ═════════════════════════════════════════════════════
{
  const { store, ids } = fixture({ v: [[['A', 0, 10]], [['B', 0, 10]], []] });
  const sq = seq(store);
  check('free_preferred_track_wins', chooseTrackForSpan(sq, 'video', 20 * S, 25 * S, { prefer: ids.v[0] })?.id === ids.v[0]);
  check('busy_preferred_goes_to_nearest_free', chooseTrackForSpan(sq, 'video', 2 * S, 5 * S, { prefer: ids.v[0] })?.id === ids.v[2], { got: chooseTrackForSpan(sq, 'video', 2 * S, 5 * S, { prefer: ids.v[0] })?.name });
  check('nothing_free_returns_undefined', chooseTrackForSpan(fixture({ v: [[['A', 0, 10]]] }).store.getState().sequence(), 'video', S, 2 * S, {}) === undefined);
  check('locked_tracks_are_never_chosen', (() => {
    const f = fixture({ v: [[['A', 0, 10]], []] });
    f.store.getState().dispatch(toggleTrackFlag(f.ids.v[1], 'locked'));
    return chooseTrackForSpan(seq(f.store), 'video', 2 * S, 5 * S, { prefer: f.ids.v[0] }) === undefined;
  })());
  check('kinds_are_not_mixed', chooseTrackForSpan(fixture({ v: [[]], a: [[]] }).store.getState().sequence(), 'audio', 0, S, {})?.kind === 'audio');
  check('track_kind_for_clips', trackKindFor({ kind: 'audio' }) === 'audio' && trackKindFor({ kind: 'text' }) === 'video' && trackKindFor({ kind: 'image' }) === 'video');
}

// ═══ 2. Settling a dragged clip ══════════════════════════════════════════════
{
  const { store, ids } = fixture({ v: [[['A', 0, 10], ['B', 20, 10]], []] });
  const before = store.getState().project;
  store.getState().dispatch(settleClips(['A']));
  check('clear_clip_is_left_where_it_is', store.getState().project === before);
}
{
  // drop B on top of A (same track): it must not override A, it goes to the free track
  const { store, ids } = fixture({ v: [[['A', 0, 10], ['B', 20, 10]], []] });
  store.getState().dispatch(moveClip('B', 4 * S, undefined, true)); // live drag: overlaps A for now
  check('during_a_drag_the_clip_may_float_over_another', trackOf(store, 'B').id === ids.v[0] && clip(store, 'B').start === 4 * S);
  store.getState().dispatch(settleClips(['B']));
  check('on_release_it_moves_to_the_free_track', trackOf(store, 'B').id === ids.v[1] && clip(store, 'B').start === 4 * S, { track: trackOf(store, 'B').name });
  check('the_clip_it_would_have_covered_is_untouched', trackOf(store, 'A').id === ids.v[0] && clip(store, 'A').start === 0 && clip(store, 'A').duration === 10 * S);
  check('nothing_overlaps_afterwards', noOverlap(store));
  store.getState().undo();
  check('one_undo_undoes_the_whole_drag_and_settle', trackOf(store, 'B').id === ids.v[0] && clip(store, 'B').start === 20 * S, { start: clip(store, 'B').start / S });
  store.getState().redo();
  check('redo_replays_it', trackOf(store, 'B').id === ids.v[1] && clip(store, 'B').start === 4 * S);
}
{
  // no free track: a NEW one is made, of the right kind, in one undo step
  const { store, ids } = fixture({ v: [[['A', 0, 10], ['B', 20, 10]]] });
  store.getState().dispatch(moveClip('B', 4 * S, undefined, true));
  store.getState().dispatch(settleClips(['B']));
  const vids = seq(store).tracks.filter((t) => t.kind === 'video');
  check('a_new_video_track_is_created_when_none_is_free', vids.length === 2 && trackOf(store, 'B').id === vids[1].id && trackOf(store, 'B').id !== ids.v[0], { tracks: vids.length });
  check('new_track_sits_with_the_video_tracks', seq(store).tracks.map((t) => t.kind).join(',') === 'video,video,audio');
  store.getState().undo();
  check('undo_removes_the_new_track_too', seq(store).tracks.filter((t) => t.kind === 'video').length === 1 && trackOf(store, 'B').id === ids.v[0]);
}
{
  // audio overlap makes an AUDIO track, below the existing audio
  const { store, ids } = fixture({ v: [[]], a: [[['M1', 0, 10], ['M2', 20, 10]]] });
  store.getState().dispatch(moveClip('M2', 3 * S, undefined, true));
  store.getState().dispatch(settleClips(['M2']));
  const auds = seq(store).tracks.filter((t) => t.kind === 'audio');
  check('audio_overlap_makes_an_audio_track', auds.length === 2 && trackOf(store, 'M2').kind === 'audio' && trackOf(store, 'M2').id === auds[1].id);
  check('video_tracks_stay_above_audio', seq(store).tracks.map((t) => t.kind).join(',') === 'video,audio,audio');
}
{
  // the "new track" drop zone forces a new track even when nothing overlaps
  const { store, ids } = fixture({ v: [[['A', 0, 10]]] });
  store.getState().dispatch(settleClips(['A'], { newTrack: 'video' }));
  check('drop_zone_forces_a_new_track', seq(store).tracks.filter((t) => t.kind === 'video').length === 2 && trackOf(store, 'A').id !== ids.v[0]);
  check('old_track_is_left_empty_not_deleted', seq(store).tracks.find((t) => t.id === ids.v[0]).clips.length === 0);
  // a mismatched zone does nothing
  const f2 = fixture({ v: [[['A', 0, 10]]] });
  const prev = f2.store.getState().project;
  f2.store.getState().dispatch(settleClips(['A'], { newTrack: 'audio' }));
  check('a_video_clip_on_the_audio_zone_stays_put', f2.store.getState().project === prev);
}
{
  // locked source: nothing moves
  const { store, ids } = fixture({ v: [[['A', 0, 10], ['B', 20, 10]], []] });
  store.getState().dispatch(moveClip('B', 4 * S, undefined, true));
  store.getState().dispatch(toggleTrackFlag(ids.v[0], 'locked'));
  const prev = store.getState().project;
  store.getState().dispatch(settleClips(['B']));
  check('a_locked_track_keeps_its_clips', store.getState().project === prev);
}
{
  // leaving a track takes its transitions along (they cannot join clips on different tracks)
  const { store, ids } = fixture({ v: [[['A', 0, 5], ['B', 5, 5], ['C', 20, 5]], []] });
  store.getState().dispatch(addTransition(ids.v[0], 'A', 'B', 'cross-dissolve', S));
  store.getState().dispatch(moveClip('B', 20 * S, undefined, true)); // now overlaps C
  store.getState().dispatch(settleClips(['B']));
  check('settling_drops_transitions_that_no_longer_join_anything', seq(store).tracks.every((t) => t.transitions.length === 0));
}

// ═══ 3. Moving a group ═══════════════════════════════════════════════════════
{
  const { store, ids } = fixture({ v: [[['A', 2, 3], ['B', 8, 3]], [['C', 5, 3]]] });
  store.getState().dispatch(moveClips(['A', 'B', 'C'], 4 * S));
  check('group_moves_together', clip(store, 'A').start === 6 * S && clip(store, 'B').start === 12 * S && clip(store, 'C').start === 9 * S);
  check('group_keeps_relative_spacing', clip(store, 'B').start - clip(store, 'A').start === 6 * S);
  check('group_stays_on_its_own_tracks', trackOf(store, 'A').id === ids.v[0] && trackOf(store, 'C').id === ids.v[1]);
  store.getState().undo();
  check('group_move_is_one_undo_step', clip(store, 'A').start === 2 * S && clip(store, 'C').start === 5 * S);
  store.getState().dispatch(moveClips(['A', 'B', 'C'], -50 * S));
  check('group_stops_at_zero_as_a_whole', clip(store, 'A').start === 0 && clip(store, 'B').start === 6 * S && clip(store, 'C').start === 3 * S, { a: clip(store, 'A').start / S, b: clip(store, 'B').start / S });
  const prev = store.getState().project;
  store.getState().dispatch(moveClips(['A', 'B'], 0));
  check('zero_move_is_a_noop', store.getState().project === prev);
  store.getState().dispatch(toggleTrackFlag(ids.v[1], 'locked'));
  const p2 = store.getState().project;
  store.getState().dispatch(moveClips(['A', 'C'], 2 * S));
  check('a_locked_track_in_the_group_blocks_the_move', store.getState().project === p2);
}
{
  // a group that lands on a stationary clip: members move to a free track, the rest keep their place
  const { store, ids } = fixture({ v: [[['A', 0, 4], ['B', 5, 4], ['Z', 20, 2]], []] });
  store.getState().dispatch(moveClips(['A', 'B'], 18 * S)); // A -> 18..22 (hits Z), B -> 23..27
  store.getState().dispatch(settleClips(['A', 'B']));
  check('only_the_clip_in_the_way_leaves', trackOf(store, 'A').id === ids.v[1] && trackOf(store, 'B').id === ids.v[0], { a: trackOf(store, 'A').name, b: trackOf(store, 'B').name });
  check('group_settle_leaves_nothing_overlapping', noOverlap(store));
}

// ═══ 4. Adding NEW clips: never on top of something ═════════════════════════
{
  const { store, ids } = fixture({ v: [[['A', 0, 10]], []] });
  const c = { ...createClipFromMedia(video, 2 * S), id: 'N', start: 2 * S, duration: 4 * S, sourceOut: 4 * S };
  store.getState().dispatch(placeClipSmart(c, ids.v[0]));
  check('new_clip_avoids_the_occupied_track', trackOf(store, 'N').id === ids.v[1]);
  const free = { ...createClipFromMedia(video, 30 * S), id: 'F', start: 30 * S, duration: 4 * S, sourceOut: 4 * S };
  store.getState().dispatch(placeClipSmart(free, ids.v[0]));
  check('new_clip_uses_its_preferred_track_when_free', trackOf(store, 'F').id === ids.v[0]);
  const none = fixture({ v: [], a: [] });
  none.store.getState().dispatch(placeClipSmart({ ...createClipFromMedia(music, 0), id: 'X', start: 0, duration: 4 * S, sourceOut: 4 * S }));
  check('audio_lands_on_the_audio_track', seq(none.store).tracks.filter((t) => t.kind === 'audio')[0].clips.some((c) => c.id === 'X'));
}
{
  // store.addMediaToTimeline: wrong-kind lane is routed, occupied span is avoided
  const { store, ids } = fixture({ v: [[['A', 0, 10]], []], a: [[]] });
  store.getState().addMediaToTimeline(music, ids.v[0], 2 * S); // audio "dropped" on a VIDEO lane
  const placed = seq(store).tracks.flatMap((t) => t.clips).find((c) => c.kind === 'audio');
  check('audio_dropped_on_a_video_lane_goes_to_an_audio_track', !!placed && trackOf(store, placed.id).kind === 'audio');
  store.getState().addMediaToTimeline(video, ids.v[0], 2 * S); // video dropped on top of A
  const vclips = seq(store).tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
  check('video_dropped_on_occupied_time_does_not_override', vclips.length === 2 && noOverlap(store) && clip(store, 'A').start === 0);
  const empty = fixture({ v: [], a: [] });
  empty.store.getState().addMediaToTimeline(video);
  check('adding_media_with_no_tracks_makes_one', seq(empty.store).tracks.flatMap((t) => t.clips).length === 1);
}
{
  // double-click style add (no position): appended after what is there
  const { store, ids } = fixture({ v: [[['A', 0, 10]]] });
  store.getState().addMediaToTimeline(video);
  const added = seq(store).tracks[0].clips.find((c) => c.id !== 'A');
  check('add_without_a_position_appends', !!added && added.start === 10 * S && seq(store).tracks.filter((t) => t.kind === 'video').length === 1);
}

// ═══ 5. Moving text: position + geometry ════════════════════════════════════
{
  const { store, ids } = fixture({ v: [[]] });
  const t = createTextClip(0, 'Title');
  store.getState().dispatch(addClip(ids.v[0], t));
  store.getState().dispatch(setClipPosition(t.id, 120, -80, 0));
  check('text_position_is_set', clip(store, t.id).transform.x.static === 120 && clip(store, t.id).transform.y.static === -80);
  for (let i = 0; i < 20; i++) store.getState().dispatch(setClipPosition(t.id, i * 10, i * 5, 0));
  store.getState().undo();
  check('a_whole_text_drag_is_one_undo_step', clip(store, t.id).transform.x.static === 0 && clip(store, t.id).transform.y.static === 0);
  store.getState().redo();
  const prev = store.getState().project;
  store.getState().dispatch(setClipPosition(t.id, 190, 95, 0));
  check('same_position_is_a_noop', store.getState().project === prev);

  // an animated position is keyframed at the playhead instead of overwritten
  const k = createTextClip(2 * S, 'Animated');
  k.transform = { ...k.transform, x: { static: 0, keyframes: [{ id: 'k1', time: 0, value: 0, interpolation: 'linear' }] } };
  store.getState().dispatch(addClip(ids.v[0], { ...k, id: 'K', start: 2 * S }));
  store.getState().dispatch(setClipPosition('K', 300, 10, 3 * S));
  const kx = clip(store, 'K').transform.x;
  check('animated_position_gets_a_keyframe_at_the_playhead', kx.keyframes.length === 2 && kx.keyframes.some((f) => f.time === 1 * S && f.value === 300), { kfs: kx.keyframes.map((f) => [f.time / S, f.value]) });
  check('animated_axis_stays_static_on_the_other_axis', clip(store, 'K').transform.y.static === 10);

  // a locked track refuses the move
  store.getState().dispatch(toggleTrackFlag(ids.v[0], 'locked'));
  const p2 = store.getState().project;
  store.getState().dispatch(setClipPosition(t.id, 0, 0, 0));
  check('locked_track_refuses_a_text_move', store.getState().project === p2);
}
{
  const frame = { width: 1920, height: 1080 };
  const raster = { width: 400, height: 100 };
  const q = clipQuad(frame, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, raster);
  check('quad_is_centred_in_the_frame', q.cx === 960 && q.cy === 540 && q.halfW === 200 && q.halfH === 50);
  check('inside_and_outside', quadContains(q, 960, 540) && quadContains(q, 1159, 589) && !quadContains(q, 1161, 540) && !quadContains(q, 960, 592));
  const moved = clipQuad(frame, { x: 300, y: -200, scaleX: 1, scaleY: 1, rotation: 0 }, raster);
  check('position_moves_the_quad_y_down', moved.cx === 1260 && moved.cy === 340 && quadContains(moved, 1260, 340) && !quadContains(moved, 960, 540));
  const scaled = clipQuad(frame, { x: 0, y: 0, scaleX: 2, scaleY: 0.5, rotation: 0 }, raster);
  check('scale_resizes_the_hit_area', scaled.halfW === 400 && scaled.halfH === 25 && quadContains(scaled, 960 + 390, 540) && !quadContains(scaled, 960, 540 + 30));
  // rotated 90 degrees CCW: the 400x100 box becomes 100 wide, 400 tall on screen
  const rot = clipQuad(frame, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90 }, raster);
  check('rotation_turns_the_hit_area', quadContains(rot, 960, 540 - 180) && quadContains(rot, 960, 540 + 180) && !quadContains(rot, 960 + 150, 540) && !quadContains(rot, 960 - 150, 540));
  const r45 = clipQuad(frame, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 45 }, raster);
  check('rotation_45_follows_the_diagonal', quadContains(r45, 960 + 100, 540 - 100) && !quadContains(r45, 960 + 100, 540 + 100), { upRight: quadContains(r45, 1060, 440), downRight: quadContains(r45, 1060, 640) });
}

console.log(JSON.stringify({ ...results, ok: failures === 0, failures, total: Object.keys(results).length }, null, 2));
process.exit(failures === 0 ? 0 : 1);
