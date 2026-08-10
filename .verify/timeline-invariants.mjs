/**
 * Timeline command invariants — a model check, not a pixel check.
 *
 * Every command in `core/commands/timelineCommands.ts` claims to leave the project consistent.
 * That claim is falsifiable, so this asserts it directly rather than trusting that the UI looks
 * right afterwards.
 *
 * The invariants a clip must satisfy after ANY edit:
 *   1. duration > 0
 *   2. start >= 0
 *   3. sourceOut - sourceIn === duration   (the trimmed window matches the timeline length)
 *   4. sourceIn >= 0, and sourceOut <= the media's own duration
 *   5. clips on one track never overlap
 *
 * Invariant 3 is the load-bearing one. Source-trim and timeline-position are stored separately
 * precisely so non-destructive edits are possible; the moment they disagree, the preview and the
 * exporter are reading a different region of the media than the timeline says they are.
 *
 * Needs no Electron and no GPU, which is the point — a check that runs in a second gets run.
 *
 *   npm run verify:timeline
 */

import {
  createProject,
  createClipFromMedia,
  addTrack,
  addClip,
  addMedia,
  splitClip,
  trimClip,
  duplicateClip,
  History,
  TICKS_PER_SECOND,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;

const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

const activeSeq = (p) => p.sequences.find((s) => s.id === p.activeSequenceId) ?? p.sequences[0];
const allClips = (p) => activeSeq(p).tracks.flatMap((t) => t.clips);

/** Every invariant violation in the project, as readable strings. */
function violations(p, label) {
  const out = [];
  for (const t of activeSeq(p).tracks) {
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    sorted.forEach((c, i) => {
      const media = c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined;
      if (c.duration <= 0) out.push(`${label}: ${c.id} duration ${c.duration} <= 0`);
      if (c.start < 0) out.push(`${label}: ${c.id} start ${c.start} < 0`);

      const window = c.sourceOut - c.sourceIn;
      if (window !== c.duration) {
        out.push(
          `${label}: ${c.id} source window ${window} != duration ${c.duration} (drift ${(window - c.duration) / S}s)`
        );
      }
      if (c.sourceIn < 0) out.push(`${label}: ${c.id} sourceIn ${c.sourceIn} < 0`);
      if (media && media.duration > 0 && c.sourceOut > media.duration) {
        out.push(
          `${label}: ${c.id} sourceOut ${c.sourceOut / S}s > media duration ${media.duration / S}s`
        );
      }
      const next = sorted[i + 1];
      if (next && c.start + c.duration > next.start) out.push(`${label}: ${c.id} overlaps ${next.id}`);
    });
  }
  return out;
}

/** One 10s video clip on one video track, built with the project's own factories. */
function fixture() {
  const media = {
    id: 'm1',
    name: 'test.mp4',
    kind: 'video',
    path: '/tmp/test.mp4',
    duration: 10 * S,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
  };
  const h = new History(createProject('Test'));
  h.dispatch(addMedia([media]));
  h.dispatch(addTrack('video'));
  const track = activeSeq(h.current).tracks.find((t) => t.kind === 'video');
  const clip = { ...createClipFromMedia(media, 0), id: 'c1' };
  h.dispatch(addClip(track.id, clip));
  return { h, track, media };
}

const only = (p) => allClips(p)[0];
const secs = (t) => t / S;

// ── 1. The fixture itself is consistent ─────────────────────────────────────
{
  const { h } = fixture();
  const v = violations(h.current, 'fixture');
  check('fixture_is_consistent', v.length === 0, { violations: v });
}

// ── 2. Trim the TAIL ────────────────────────────────────────────────────────
{
  const { h } = fixture();
  const after = h.dispatch(trimClip('c1', 'out', -3 * S));
  const c = only(after);
  const v = violations(after, 'trim_out');
  check('trim_out_keeps_window', v.length === 0, {
    duration_s: secs(c.duration),
    sourceIn_s: secs(c.sourceIn),
    sourceOut_s: secs(c.sourceOut),
    violations: v,
  });
}

// ── 3. Trim the HEAD — the case most likely to desync sourceOut ─────────────
{
  const { h } = fixture();
  const after = h.dispatch(trimClip('c1', 'in', 3 * S));
  const c = only(after);
  const v = violations(after, 'trim_in');
  check('trim_in_keeps_window', v.length === 0, {
    start_s: secs(c.start),
    duration_s: secs(c.duration),
    sourceIn_s: secs(c.sourceIn),
    sourceOut_s: secs(c.sourceOut),
    expected_sourceOut_s: secs(c.sourceIn + c.duration),
    violations: v,
  });
}

// ── 4. Head trim, then tail trim ────────────────────────────────────────────
{
  const { h } = fixture();
  let after = h.dispatch(trimClip('c1', 'in', 3 * S));
  after = h.dispatch(trimClip('c1', 'out', -2 * S));
  const c = only(after);
  const v = violations(after, 'trim_in_then_out');
  check('trim_in_then_out', v.length === 0, {
    duration_s: secs(c.duration),
    sourceIn_s: secs(c.sourceIn),
    sourceOut_s: secs(c.sourceOut),
    violations: v,
  });
}

// ── 5. Split AFTER a head trim — does the right half read the right region? ─
{
  const { h } = fixture();
  let after = h.dispatch(trimClip('c1', 'in', 2 * S));
  after = h.dispatch(splitClip('c1', 5 * S));
  const cs = allClips(after).sort((a, b) => a.start - b.start);
  const v = violations(after, 'split_after_trim');
  check('split_after_head_trim', v.length === 0, {
    clips: cs.map((c) => ({
      start_s: secs(c.start),
      dur_s: secs(c.duration),
      in_s: secs(c.sourceIn),
      out_s: secs(c.sourceOut),
    })),
    violations: v,
  });
}

// ── 6. Plain split at the midpoint ──────────────────────────────────────────
{
  const { h } = fixture();
  const after = h.dispatch(splitClip('c1', 4 * S));
  const v = violations(after, 'split');
  check('split_midpoint', v.length === 0, { violations: v });
}

// ── 7. Undo restores the exact previous project ─────────────────────────────
{
  const { h } = fixture();
  const before = JSON.stringify(h.current);
  let after = h.dispatch(trimClip('c1', 'in', 3 * S));
  after = h.undo();
  check('undo_restores_exactly', JSON.stringify(after) === before, {
    note: 'undo of a head trim must restore byte-identical project state',
  });
}

// ── 8. Overtrimming the head ────────────────────────────────────────────────
{
  const { h } = fixture();
  const after = h.dispatch(trimClip('c1', 'in', 999 * S));
  const c = only(after);
  const v = violations(after, 'overtrim_in');
  check('overtrim_head_is_clamped', v.length === 0, {
    duration_s: secs(c.duration),
    sourceIn_s: secs(c.sourceIn),
    sourceOut_s: secs(c.sourceOut),
    violations: v,
  });
}

// ── 9. Overtrimming the tail past the media length ──────────────────────────
{
  const { h } = fixture();
  const after = h.dispatch(trimClip('c1', 'out', 999 * S));
  const c = only(after);
  const v = violations(after, 'overtrim_out');
  check('overtrim_tail_is_clamped', v.length === 0, {
    duration_s: secs(c.duration),
    sourceOut_s: secs(c.sourceOut),
    media_duration_s: 10,
    violations: v,
  });
}

// ── 10. Duplicate produces an independent clip ──────────────────────────────
{
  const { h } = fixture();
  const after = h.dispatch(duplicateClip('c1'));
  const cs = allClips(after);
  const sharesTransform = cs.length === 2 && cs[0].transform === cs[1].transform;
  const v = violations(after, 'dup');
  check('duplicate_is_independent', cs.length === 2 && !sharesTransform && v.length === 0, {
    count: cs.length,
    shares_transform_object: sharesTransform,
    violations: v,
  });
}

results.ok = failures === 0;
results.failures = failures;
console.log(JSON.stringify(results, null, 2));
process.exit(failures ? 1 : 0);
