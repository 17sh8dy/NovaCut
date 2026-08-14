/**
 * Split-at-playhead behaviour — drives the real app store, not a re-implementation.
 *
 * The claim under test is CapCut's: after a Split, the playhead sits on the first frame of the
 * newly created section, the new section is what's selected, and doing it again at the same
 * displayed frame does the same thing. That is only meaningful if the cut lands on a frame at
 * all, so the snap is checked too.
 *
 * `createAppStore` takes a bridge and touches no DOM, so the whole thing runs in node — which
 * is the point, because a check that needs a GPU and a click does not get run.
 *
 *   npm run verify:split
 */

import { createAppStore } from '@opencut/ui';
import {
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  clipAtTime,
  TICKS_PER_SECOND,
  ticksPerFrame,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;

const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

/** A bridge that answers nothing — split touches none of it. */
const stubBridge = new Proxy({}, { get: () => async () => undefined });

/** One 10s clip on one video track, in a store, at 30fps. */
function fixture() {
  const store = createAppStore(stubBridge);
  const media = {
    id: 'm1', name: 'test.mp4', kind: 'video', path: '/tmp/test.mp4',
    duration: 10 * S, width: 1920, height: 1080, fps: 30, hasAudio: true,
  };
  const s = store.getState();
  s.dispatch(addMedia([media]));
  s.dispatch(addTrack('video'));
  const track = store.getState().sequence().tracks.find((t) => t.kind === 'video');
  s.dispatch(addClip(track.id, { ...createClipFromMedia(media, 0), id: 'c1' }));
  return store;
}

const seq = (store) => store.getState().sequence();
const clips = (store) => seq(store).tracks.flatMap((t) => t.clips);
const fps = (store) => seq(store).fps;

// ── 1. Playhead lands on the start of the new section ───────────────────────
{
  const store = fixture();
  store.getState().setPlayhead(4 * S);
  store.getState().splitAtPlayhead();

  const st = store.getState();
  const newId = st.selectedClipIds[0];
  const created = clips(store).find((c) => c.id === newId);
  check('playhead_is_at_new_section_start', created && st.playhead === created.start, {
    playhead_s: st.playhead / S,
    new_clip_start_s: created?.start / S,
    selected: st.selectedClipIds,
  });
}

// ── 2. The preview resolves the boundary to the NEW clip, not the old one ───
{
  const store = fixture();
  store.getState().setPlayhead(4 * S);
  store.getState().splitAtPlayhead();

  const st = store.getState();
  const track = seq(store).tracks.find((t) => t.kind === 'video');
  const under = clipAtTime(track, st.playhead);
  check('preview_shows_new_clip_not_old', under?.id === st.selectedClipIds[0], {
    clip_under_playhead: under?.id,
    selected: st.selectedClipIds[0],
  });
}

// ── 3. A sub-frame playhead cuts on a frame, and moves less than one frame ──
{
  const store = fixture();
  const tpf = ticksPerFrame(fps(store));
  const offBy = Math.floor(tpf * 0.37); // mid-frame, where a scrub habitually lands
  const before = 4 * S + offBy;
  store.getState().setPlayhead(before);
  store.getState().splitAtPlayhead();

  const st = store.getState();
  const onFrame = st.playhead % tpf === 0;
  const moved = Math.abs(st.playhead - before);
  check('subframe_cut_snaps_to_frame', onFrame && moved < tpf, {
    playhead_before_frames: before / tpf,
    playhead_after_frames: st.playhead / tpf,
    moved_frames: moved / tpf,
    on_frame: onFrame,
  });
}

// ── 4. Repeated cuts at the same displayed frame are idempotent ─────────────
{
  const store = fixture();
  const tpf = ticksPerFrame(fps(store));
  store.getState().setPlayhead(4 * S + Math.floor(tpf * 0.37));
  store.getState().splitAtPlayhead();
  const afterFirst = store.getState().playhead;
  const countFirst = clips(store).length;

  // Same frame again: the playhead is now exactly on a clip boundary, so there is nothing
  // to bisect — a second press must not carve a zero-length sliver.
  store.getState().splitAtPlayhead();
  check('repeat_cut_is_stable', store.getState().playhead === afterFirst && clips(store).length === countFirst, {
    clips_after_first: countFirst,
    clips_after_second: clips(store).length,
    playhead_moved: store.getState().playhead !== afterFirst,
  });
}

// ── 5. No sliver clips, ever ────────────────────────────────────────────────
{
  const store = fixture();
  const tpf = ticksPerFrame(fps(store));
  // Land a third of a frame inside the clip's tail — the classic sliver-maker.
  store.getState().setPlayhead(10 * S - Math.floor(tpf * 0.33));
  store.getState().splitAtPlayhead();
  const shortest = Math.min(...clips(store).map((c) => c.duration));
  check('no_subframe_sliver_clips', shortest >= tpf, {
    clips: clips(store).length,
    shortest_frames: shortest / tpf,
  });
}

// ── 6. Undo restores the clips and keeps history intact ─────────────────────
{
  const store = fixture();
  store.getState().setPlayhead(4 * S);
  const beforeCount = clips(store).length;
  store.getState().splitAtPlayhead();
  const afterCount = clips(store).length;

  store.getState().undo();
  const undone = clips(store).length;
  store.getState().redo();
  const redone = clips(store).length;

  check('undo_redo_unaffected', beforeCount === 1 && afterCount === 2 && undone === 1 && redone === 2, {
    before: beforeCount, after: afterCount, undone, redone,
  });
}

// ── 7. A normal scrub is NOT snapped or nudged ──────────────────────────────
{
  const store = fixture();
  const tpf = ticksPerFrame(fps(store));
  const mid = 4 * S + Math.floor(tpf * 0.37);
  store.getState().setPlayhead(mid);
  check('plain_scrub_is_untouched', store.getState().playhead === mid, {
    requested: mid, actual: store.getState().playhead,
  });
}

console.log(JSON.stringify({ ...results, ok: failures === 0, failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
