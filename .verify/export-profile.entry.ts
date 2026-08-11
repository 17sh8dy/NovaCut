/**
 * Export profiler — runs the REAL OfflineExporter over REAL decoded media and reports where the
 * time goes, phase by phase.
 *
 * The encoder is a stand-in that only counts bytes, on purpose: this isolates the RENDER side of
 * the export (decode + composite + readback) from FFmpeg's own encode throughput, which is
 * measured separately. Mixing them makes every number uninterpretable.
 *
 * Three scenes, because they stress different things:
 *   plain       one clip, no effects          — the floor
 *   transition  two clips + a cross dissolve  — both sources decoding, two extra FBO passes
 *   effects     one clip with an effect chain — GPU-bound
 */

import { Compositor, FrameSourcePool, OfflineExporter } from '@opencut/engine';
import {
  History,
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  createProject,
  instantiateEffect,
  registerBuiltins,
  seconds,
  type Clip,
  type MediaAsset,
  type Project,
  type Sequence,
} from '@opencut/core';

registerBuiltins();

const params = new URLSearchParams(location.search);
const CLIP_A = params.get('a') ?? '';
const CLIP_B = params.get('b') ?? '';
const SECONDS = Number(params.get('secs') ?? '5');
const FPS = Number(params.get('fps') ?? '30');

const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function mediaAsset(id: string, name: string, src: string, durationSec: number): MediaAsset {
  return {
    id,
    kind: 'video',
    name,
    src,
    duration: seconds(durationSec),
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fileSize: 0,
    importedAt: Date.now(),
  } as unknown as MediaAsset;
}

/** A FrameEncoder that only measures. Counts bytes so a dropped frame cannot go unnoticed. */
function countingEncoder(width: number, height: number) {
  let bytes = 0;
  let frames = 0;
  return {
    width,
    height,
    async writeFrame(rgba: Uint8Array): Promise<void> {
      bytes += rgba.byteLength;
      frames++;
    },
    async finish(): Promise<void> {},
    async abort(): Promise<void> {},
    stats: () => ({ bytes, frames }),
  };
}

/**
 * Reproduces what the desktop bridge does to a frame on its way to main: an exact-sized copy,
 * then a structured clone across the IPC boundary. Comparing against the counting encoder
 * prices the transport by itself.
 */
function ipcShapedEncoder(width: number, height: number) {
  let frames = 0;
  let sink = 0;
  return {
    width,
    height,
    async writeFrame(rgba: Uint8Array): Promise<void> {
      const buf = rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
      const cloned = structuredClone(buf as ArrayBuffer);
      sink += new Uint8Array(cloned as ArrayBuffer)[0] ?? 0; // keep it from being elided
      frames++;
    },
    async finish(): Promise<void> {},
    async abort(): Promise<void> {},
    stats: () => ({ frames, sink }),
  };
}

type SceneKind = 'plain' | 'transition' | 'effects';
type Scene = { project: Project; sequence: Sequence };

const activeSeq = (p: Project): Sequence =>
  p.sequences.find((s) => s.id === p.activeSequenceId) ?? p.sequences[0]!;

function buildScene(kind: SceneKind): Scene {
  const a = mediaAsset('m_a', 'clipA.mp4', CLIP_A, 10);
  const h = new History(createProject('Perf'));
  h.dispatch(addMedia([a]));
  h.dispatch(addTrack('video'));
  const trackId = activeSeq(h.current).tracks.find((t) => t.kind === 'video')!.id;

  if (kind === 'transition') {
    const b = mediaAsset('m_b', 'clipB.mp4', CLIP_B, 8);
    h.dispatch(addMedia([b]));
    const half = seconds(SECONDS / 2);
    const c1: Clip = { ...createClipFromMedia(a, seconds(0)), id: 'c1' as Clip['id'], duration: half, sourceOut: half };
    const c2: Clip = {
      ...createClipFromMedia(b, half),
      id: 'c2' as Clip['id'],
      duration: half,
      sourceOut: half,
    };
    h.dispatch(addClip(trackId, c1));
    h.dispatch(addClip(trackId, c2));
    // Transitions live on the TRACK, joining two clips by id.
    const p = h.current;
    const seq = activeSeq(p);
    const withTransition: Project = {
      ...p,
      sequences: p.sequences.map((s) =>
        s.id !== seq.id
          ? s
          : {
              ...s,
              tracks: s.tracks.map((t) =>
                t.id !== trackId
                  ? t
                  : {
                      ...t,
                      transitions: [
                        {
                          id: 'tr1',
                          type: 'cross-dissolve',
                          fromClipId: 'c1' as Clip['id'],
                          toClipId: 'c2' as Clip['id'],
                          duration: seconds(1),
                          params: {},
                        },
                      ],
                    },
              ),
            },
      ),
    };
    return { project: withTransition, sequence: activeSeq(withTransition) };
  }

  const dur = seconds(SECONDS);
  let clip: Clip = { ...createClipFromMedia(a, seconds(0)), id: 'c1' as Clip['id'], duration: dur, sourceOut: dur };
  if (kind === 'effects') {
    clip = {
      ...clip,
      effects: ['brightness', 'saturation', 'blur'].map((t) => instantiateEffect(t)),
    };
  }
  h.dispatch(addClip(trackId, clip));
  return { project: h.current, sequence: activeSeq(h.current) };
}

async function runScene(kind: SceneKind, encoderKind: 'counting' | 'ipc') {
  const { project, sequence } = buildScene(kind);
  const resolveUrl = (src: string) => src;
  const exporter = new OfflineExporter(project, sequence, resolveUrl, sequence.width, sequence.height);
  const enc =
    encoderKind === 'ipc'
      ? ipcShapedEncoder(sequence.width, sequence.height)
      : countingEncoder(sequence.width, sequence.height);

  const t0 = performance.now();
  await exporter.run(enc as never, FPS, () => {}, { start: seconds(0), end: seconds(SECONDS) });
  const wall = performance.now() - t0;
  const p = exporter.profile;
  const pct = (v: number) => +((v / Math.max(1, p.totalMs)) * 100).toFixed(1);
  return {
    scene: kind,
    encoder: encoderKind,
    wallMs: Math.round(wall),
    frames: p.frames,
    msPerFrame: +(wall / Math.max(1, p.frames)).toFixed(2),
    phasesMs: {
      prepare: Math.round(p.prepare),
      awaitDecode: Math.round(p.awaitDecode),
      render: Math.round(p.render),
      readback: Math.round(p.readback),
      encode: Math.round(p.encode),
    },
    phasePct: {
      prepare: pct(p.prepare),
      awaitDecode: pct(p.awaitDecode),
      render: pct(p.render),
      readback: pct(p.readback),
      encode: pct(p.encode),
    },
    encoderStats: enc.stats(),
  };
}

/** Order-sensitive checksum of a frame, cheap enough to run on every pixel of every frame. */
function checksum(px: Uint8Array): number {
  let h = 2166136261 >>> 0;
  // Stride over pixels rather than bytes: 8 MB per frame through a JS loop would dominate the
  // very measurement this file exists to make. Every 97th pixel still catches a shifted frame.
  for (let i = 0; i < px.length; i += 97 * 4) {
    h ^= px[i]!;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= px[i + 1]!;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= px[i + 2]!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mean of the RGB channels, sampled. Near-zero means a black frame — the old export defect. */
function meanLuma(px: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 97 * 4) {
    sum += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * Prove the pipelined exporter emits exactly the frames a plain synchronous loop would.
 *
 * The reference below is deliberately dumb: seek, wait, render, read, one frame at a time with
 * nothing overlapped. If the fast path ever disagrees with it, the optimisation changed the
 * output — which is the one thing it is not allowed to do.
 */
async function exportChecksums(kind: SceneKind): Promise<{ sums: number[]; lumas: number[] }> {
  const { project, sequence } = buildScene(kind);
  const sums: number[] = [];
  const lumas: number[] = [];
  const recorder = {
    width: sequence.width,
    height: sequence.height,
    async writeFrame(rgba: Uint8Array): Promise<void> {
      sums.push(checksum(rgba));
      lumas.push(meanLuma(rgba));
    },
    async finish(): Promise<void> {},
    async abort(): Promise<void> {},
  };
  const exporter = new OfflineExporter(project, sequence, (src: string) => src, sequence.width, sequence.height);
  await exporter.run(recorder as never, FPS, () => {}, { start: seconds(0), end: seconds(SECONDS) });
  return { sums, lumas };
}

/**
 * Is the exporter even deterministic? Two identical runs, compared.
 *
 * This has to be answered before any comparison against a reference means anything: frames come
 * off a <video> element whose seek and present timing is not under our control, so a handful of
 * frames differing between two runs would make a reference mismatch evidence of nothing.
 */
async function verifySelfConsistency(kind: SceneKind) {
  const a = await exportChecksums(kind);
  const b = await exportChecksums(kind);
  const diffs: number[] = [];
  for (let i = 0; i < Math.min(a.sums.length, b.sums.length); i++) {
    if (a.sums[i] !== b.sums[i]) diffs.push(i);
  }
  return {
    scene: kind,
    frames: a.sums.length,
    sameFrameCount: a.sums.length === b.sums.length,
    differingFrames: diffs.length,
    firstDiffs: diffs.slice(0, 8),
    blackFrames: a.lumas.filter((l) => l < 3).length,
  };
}

async function verifyEquivalence(kind: SceneKind) {
  const { project, sequence } = buildScene(kind);
  const resolveUrl = (src: string) => src;

  // ── the real exporter ──
  const got: number[] = [];
  const lumas: number[] = [];
  const recorder = {
    width: sequence.width,
    height: sequence.height,
    async writeFrame(rgba: Uint8Array): Promise<void> {
      got.push(checksum(rgba));
      lumas.push(meanLuma(rgba));
    },
    async finish(): Promise<void> {},
    async abort(): Promise<void> {},
  };
  const exporter = new OfflineExporter(project, sequence, resolveUrl, sequence.width, sequence.height);
  await exporter.run(recorder as never, FPS, () => {}, { start: seconds(0), end: seconds(SECONDS) });

  // ── the reference: synchronous, unpipelined ──
  const canvas = document.createElement('canvas');
  canvas.width = sequence.width;
  canvas.height = sequence.height;
  const pool = new FrameSourcePool(resolveUrl);
  const comp = new Compositor(canvas, pool);
  comp.resize(sequence.width, sequence.height);
  const want: number[] = [];
  const total = got.length;
  const getMedia = (id: string) => project.media.find((m) => m.id === id);
  for (let f = 0; f < total; f++) {
    const time = (f / FPS) * 705600000;
    const ctx = { sequence, time, getMedia } as never;
    comp.render(ctx);
    await pool.whenAllReady(2000);
    await new Promise<void>((r) => {
      requestAnimationFrame(() => requestAnimationFrame(() => r()));
      setTimeout(r, 40);
    });
    comp.render(ctx);
    want.push(checksum(comp.readPixels()));
  }
  comp.dispose();
  pool.disposeAll();

  const mismatches: number[] = [];
  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    if (got[i] !== want[i]) mismatches.push(i);
  }
  const black = lumas.filter((l) => l < 3).length;
  return {
    scene: kind,
    framesEmitted: got.length,
    referenceFrames: want.length,
    frameCountMatches: got.length === want.length,
    mismatchedFrames: mismatches.length,
    firstMismatches: mismatches.slice(0, 8),
    blackFrames: black,
    pass: got.length === want.length && mismatches.length === 0 && black === 0,
  };
}

async function main() {
  const results: unknown[] = [];
  try {
    for (const scene of ['plain', 'transition', 'effects'] as const) {
      results.push(await runScene(scene, 'counting'));
      log(`done ${scene}`);
    }
    results.push(await runScene('plain', 'ipc'));
    log('done plain/ipc');

    const selfConsistency = [];
    for (const scene of ['plain', 'transition', 'effects'] as const) {
      selfConsistency.push(await verifySelfConsistency(scene));
      log(`self-consistency ${scene}`);
    }
    const equivalence = [];
    for (const scene of ['plain', 'transition', 'effects'] as const) {
      equivalence.push(await verifyEquivalence(scene));
      log(`equivalence ${scene}`);
    }
    const ok = equivalence.every((e) => e.pass);
    console.log('__RESULT__' + JSON.stringify({ ok, results, selfConsistency, equivalence }));
  } catch (err) {
    console.log(
      '__RESULT__' + JSON.stringify({ ok: false, error: String(err), stack: String((err as Error)?.stack), results }),
    );
  }
}

void main();
