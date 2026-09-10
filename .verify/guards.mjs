/**
 * Guards against losing work, and the edits that act on a whole selection.
 *
 * Three claims, all found broken during the 1.0.0 sweep and all cheap to keep honest because
 * none of them needs a GPU or a click:
 *
 *   1. An action that REPLACES the open project asks about unsaved work first, and a "Save" that
 *      does not reach disk stops the action rather than proceeding.
 *   2. Delete / Ripple Delete / Duplicate act on every selected clip, as one undo step.
 *   3. Play at the end of the timeline rewinds instead of doing nothing.
 *
 * `createAppStore` takes a bridge and touches no DOM; PlaybackClock needs only a stubbed rAF.
 *
 *   npm run verify:guards
 */

import { createAppStore } from '@opencut/ui';
import {
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  deleteClips,
  duplicateClips,
  rippleDeleteClips,
  TICKS_PER_SECOND,
} from '@opencut/core';
import { PlaybackClock } from '@opencut/engine';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;

const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

/**
 * A bridge whose answers the test controls.
 *
 * `confirmDiscard` and `saveProject` are the two the guard actually consults, and every call is
 * counted — "was the question asked at all" is half of what is being asserted here, since a
 * guard that silently proceeds looks identical to one that asked and was told yes.
 */
function makeBridge({ answer = 'discard', saveResult = { path: '/tmp/p.novacut' } } = {}) {
  const calls = { confirmDiscard: 0, saveProject: 0 };
  return {
    calls,
    platform: 'desktop',
    async confirmDiscard() {
      calls.confirmDiscard++;
      return answer;
    },
    async saveProject() {
      calls.saveProject++;
      if (saveResult instanceof Error) throw saveResult;
      return saveResult;
    },
    notify() {},
    revealFile() {},
    resolveMediaUrl: (s) => s,
  };
}

const mediaAsset = (id, dur = 10) => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  src: `/tmp/${id}.mp4`,
  duration: dur * S,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  importedAt: 1,
});

const clips = (store) => store.getState().sequence().tracks.flatMap((t) => t.clips);

/** Three 2s clips laid end to end on one video track: c0 at 0s, c1 at 2s, c2 at 4s. */
function fixture(bridge = makeBridge()) {
  const store = createAppStore(bridge);
  const s = store.getState();
  const m = mediaAsset('m1');
  s.dispatch(addMedia([m]));
  s.dispatch(addTrack('video'));
  const track = store.getState().sequence().tracks.find((t) => t.kind === 'video');
  for (let i = 0; i < 3; i++) {
    const base = createClipFromMedia(m, i * 2 * S);
    s.dispatch(addClip(track.id, { ...base, id: `c${i}`, start: i * 2 * S, duration: 2 * S }));
  }
  return store;
}

// ══ 1. The unsaved-work guard ═══════════════════════════════════════════════

// 1a. Nothing unsaved: proceed without asking. A prompt on a clean project is noise, and noise
//     is what teaches people to dismiss the prompt that matters.
{
  const bridge = makeBridge();
  const store = createAppStore(bridge);
  const ok = await store.getState().guardUnsaved();
  check('clean_project_is_not_questioned', ok === true && bridge.calls.confirmDiscard === 0, {
    proceeded: ok,
    asked: bridge.calls.confirmDiscard,
  });
}

// 1b. Cancel means STOP. This is the case that used to lose work outright: there was no question.
{
  const bridge = makeBridge({ answer: 'cancel' });
  const store = fixture(bridge);
  const ok = await store.getState().guardUnsaved();
  check('cancel_blocks_the_action', ok === false && bridge.calls.confirmDiscard === 1, {
    dirty: store.getState().dirty,
    proceeded: ok,
    asked: bridge.calls.confirmDiscard,
  });
}

// 1c. Discard means proceed, and must NOT write anything.
{
  const bridge = makeBridge({ answer: 'discard' });
  const store = fixture(bridge);
  const ok = await store.getState().guardUnsaved();
  check('discard_proceeds_without_saving', ok === true && bridge.calls.saveProject === 0, {
    proceeded: ok,
    saved: bridge.calls.saveProject,
  });
}

// 1d. Save means write, THEN proceed.
{
  const bridge = makeBridge({ answer: 'save' });
  const store = fixture(bridge);
  const ok = await store.getState().guardUnsaved();
  check(
    'save_writes_then_proceeds',
    ok === true && bridge.calls.saveProject === 1 && !store.getState().dirty,
    { proceeded: ok, saved: bridge.calls.saveProject, dirty: store.getState().dirty },
  );
}

// 1e. A save that FAILS must not proceed — the whole point of asking. A rejected write leaves
//     `dirty` set, and proceeding on it discards the work the user chose to keep.
{
  const bridge = makeBridge({ answer: 'save', saveResult: new Error('EPERM: locked') });
  const store = fixture(bridge);
  const ok = await store.getState().guardUnsaved();
  check('failed_save_blocks_the_action', ok === false && store.getState().dirty === true, {
    proceeded: ok,
    dirty: store.getState().dirty,
  });
}

// 1f. A CANCELLED save dialog (the bridge answers null) is not a save either.
{
  const bridge = makeBridge({ answer: 'save', saveResult: null });
  const store = fixture(bridge);
  const ok = await store.getState().guardUnsaved();
  check(
    'cancelled_save_dialog_blocks_the_action',
    ok === false && store.getState().dirty === true,
    { proceeded: ok, dirty: store.getState().dirty },
  );
}

// 1g. A project swap clears the transition selection: its ids belong to the project that is
//     going away, and carrying them over showed "Transition gone" on a brand-new project.
{
  const store = fixture();
  store.getState().selectTransition({ trackId: 't1', id: 'tr1' });
  store.getState().newProject();
  const afterNew = store.getState().selectedTransition;
  store.getState().selectTransition({ trackId: 't1', id: 'tr1' });
  store.getState().loadProjectData(store.getState().project, null);
  check(
    'project_swap_clears_transition_selection',
    afterNew === null && store.getState().selectedTransition === null,
    { after_new: afterNew, after_load: store.getState().selectedTransition },
  );
}

// ══ 2. Edits act on the WHOLE selection ═════════════════════════════════════

// 2a. Delete removes every selected clip, in ONE undo step.
{
  const store = fixture();
  store.getState().dispatch(deleteClips(['c0', 'c2']));
  const left = clips(store).map((c) => c.id);
  store.getState().undo();
  const restored = clips(store).map((c) => c.id).sort();
  check(
    'delete_removes_whole_selection_in_one_step',
    left.length === 1 && left[0] === 'c1' && restored.length === 3,
    { remaining: left, after_single_undo: restored },
  );
}

// 2b. Ripple delete closes the gap left by ALL of them. Removing c0 and c1 (2s each) must pull
//     c2 from 4s back to 0s — summing the gaps, not applying one of them.
{
  const store = fixture();
  store.getState().dispatch(rippleDeleteClips(['c0', 'c1']));
  const left = clips(store);
  check(
    'ripple_delete_closes_every_gap',
    left.length === 1 && left[0].id === 'c2' && left[0].start === 0,
    { remaining: left.map((c) => ({ id: c.id, start_s: c.start / S })) },
  );
}

// 2c. Ripple-deleting a multi-selection lands the survivors exactly where doing them one at a
//     time would. Two separate ripple deletes are the reference implementation.
{
  const together = fixture();
  together.getState().dispatch(rippleDeleteClips(['c0', 'c1']));
  const oneByOne = fixture();
  oneByOne.getState().dispatch(rippleDeleteClips(['c0']));
  oneByOne.getState().dispatch(rippleDeleteClips(['c1']));
  const a = clips(together).map((c) => [c.id, c.start]);
  const b = clips(oneByOne).map((c) => [c.id, c.start]);
  check('ripple_multi_matches_ripple_one_at_a_time', JSON.stringify(a) === JSON.stringify(b), {
    together: a,
    one_at_a_time: b,
  });
}

// 2d. Duplicate copies every selected clip, and each copy is independent (no shared transform).
{
  const store = fixture();
  store.getState().dispatch(duplicateClips(['c0', 'c1']));
  const all = clips(store);
  const copies = all.filter((c) => !['c0', 'c1', 'c2'].includes(c.id));
  const uniqueIds = new Set(all.map((c) => c.id)).size === all.length;
  const shares = copies.some((c) => all.some((o) => o !== c && o.transform === c.transform));
  store.getState().undo();
  check(
    'duplicate_copies_whole_selection_in_one_step',
    copies.length === 2 && uniqueIds && !shares && clips(store).length === 3,
    {
      total_after: all.length,
      copies: copies.length,
      unique_ids: uniqueIds,
      shares_transform_object: shares,
      after_single_undo: clips(store).length,
    },
  );
}

// 2e. The singular commands still behave — they delegate to the plural ones now, and the point
//     of the delegation is that there is one implementation rather than two that drift.
{
  const store = fixture();
  store.getState().dispatch(deleteClips(['c1']));
  check(
    'single_clip_delete_still_works',
    clips(store).map((c) => c.id).join(',') === 'c0,c2',
    { remaining: clips(store).map((c) => c.id) },
  );
}

// ══ 3. Play at the end of the timeline rewinds ══════════════════════════════

// The clock is rAF-driven; node has no rAF, and the assertion is about where play() LEAVES the
// position, not about it advancing. A stub that never calls back isolates exactly that.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// 3a. Parked at the end, Play returns to the start rather than stopping dead.
{
  const clock = new PlaybackClock({ fps: 30, duration: 10 * S });
  clock.seek(10 * S);
  const atEnd = clock.currentTime;
  clock.play();
  check('play_at_end_rewinds', atEnd === 10 * S && clock.currentTime === 0 && clock.isPlaying, {
    before_s: atEnd / S,
    after_s: clock.currentTime / S,
    playing: clock.isPlaying,
  });
}

// 3b. Play in the MIDDLE must not rewind — the fix has to be confined to the end.
{
  const clock = new PlaybackClock({ fps: 30, duration: 10 * S });
  clock.seek(4 * S);
  clock.play();
  check('play_in_middle_does_not_rewind', clock.currentTime === 4 * S, {
    position_s: clock.currentTime / S,
  });
}

// 3c. With a loop range, "the beginning" is the beginning of the range.
{
  const clock = new PlaybackClock({
    fps: 30,
    duration: 10 * S,
    loop: true,
    loopStart: 2 * S,
    loopEnd: 8 * S,
  });
  clock.seek(10 * S);
  clock.play();
  check('play_at_end_rewinds_to_loop_start', clock.currentTime === 2 * S, {
    position_s: clock.currentTime / S,
  });
}

// 3d. An empty timeline has nowhere to rewind to, and must not end up reporting a position that
//     does not exist.
{
  const clock = new PlaybackClock({ fps: 30, duration: 0 });
  clock.play();
  check('empty_timeline_play_is_harmless', clock.currentTime === 0, {
    position_s: clock.currentTime / S,
  });
}

console.log(JSON.stringify({ ...results, ok: failures === 0, failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
