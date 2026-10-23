/**
 * GL transition EXPORT check: runs the real OfflineExporter on a real two-clip project that has a
 * GL transition on the cut, captures every frame it would hand to FFmpeg, and inspects them.
 *
 *   npm run verify:glexport
 *
 * What it proves, on actual exported pixels:
 *   - the clip before the transition's window exports as that clip, and after it as the next one
 *   - the first frame of the window is exactly the outgoing clip (no pop where it meets the cut)
 *   - mid-transition the picture is split the way the shader says, and the right way UP
 *   - the transition progresses frame by frame and ends on the incoming clip
 *   - the frame count is exact, and nothing is blank
 *   - what the exporter writes is what the preview compositor draws for the same moment
 *   - a classic (non-GL) transition exports as before
 *
 * Runs in a window that is shown (without taking focus): a hidden Electron window stops servicing
 * requestAnimationFrame, which the exporter awaits between frames.
 */

import { Compositor, FrameSourcePool, OfflineExporter } from '@opencut/engine';
import {
  History,
  addClip,
  addMedia,
  addTrack,
  addTransition,
  createClipFromMedia,
  createProject,
  registerBuiltins,
  seconds,
  getActiveSequence,
  type MediaAsset,
  type Project,
} from '@opencut/core';

registerBuiltins();

const results: Record<string, unknown> = {};
let failures = 0;
const check = (name: string, pass: boolean, detail?: Record<string, unknown>) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

window.addEventListener('error', (e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e.message) })));
window.addEventListener('unhandledrejection', (e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: 'rejection: ' + String(e.reason) })));

const W = 96;
const H = 54;
const FPS = 10;

function solid(hex: string): string {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 36;
  const g = c.getContext('2d')!;
  g.fillStyle = hex;
  g.fillRect(0, 0, 64, 36);
  return c.toDataURL('image/png');
}

const asset = (id: string, src: string): MediaAsset =>
  ({ id, kind: 'image', name: id, src, duration: 0, width: 64, height: 36, hasAudio: false, fileSize: 0, importedAt: 0 }) as unknown as MediaAsset;

/** Two 2-second image clips butted together, with `type` on the cut. */
function buildProject(type: string): Project {
  const red = asset('red', solid('#ff0000'));
  const blue = asset('blue', solid('#0000ff'));
  const h = new History(createProject());
  h.dispatch(addMedia([red, blue]));
  h.dispatch(addTrack('video'));
  const trackId = getActiveSequence(h.current).tracks.find((t) => t.kind === 'video')!.id;
  h.dispatch(addClip(trackId, { ...createClipFromMedia(red, 0), id: 'A', start: 0, duration: seconds(2), sourceOut: seconds(2) }));
  h.dispatch(addClip(trackId, { ...createClipFromMedia(blue, seconds(2)), id: 'B', start: seconds(2), duration: seconds(2), sourceOut: seconds(2) }));
  h.dispatch(addTransition(trackId, 'A', 'B', type, seconds(1)));
  const p = h.current;
  return { ...p, sequences: p.sequences.map((s) => ({ ...s, width: W, height: H, fps: FPS })) } as Project;
}

/**
 * Export the whole project through the real exporter; returns every frame as RGBA in the order the
 * exporter hands it over: BOTTOM-UP (GL readback order). The desktop encoder adds `vflip` for that
 * reason (apps/desktop/electron/ffmpeg.ts), so row 0 here is the bottom of the final picture.
 * `topDown` below turns a frame into what the viewer sees.
 */
async function exportFrames(project: Project): Promise<Uint8Array[]> {
  const sequence = getActiveSequence(project);
  const frames: Uint8Array[] = [];
  const encoder = {
    width: W,
    height: H,
    async writeFrame(rgba: Uint8Array): Promise<void> {
      frames.push(new Uint8Array(rgba)); // the exporter reuses its buffers, so copy
    },
    async finish(): Promise<void> {},
    async abort(): Promise<void> {},
  };
  const exporter = new OfflineExporter(project, sequence, (src) => src, W, H);
  await exporter.run(encoder as never, FPS, () => {}, { start: 0, end: sequence.duration });
  return frames;
}

/** What the viewer sees: the exporter's bottom-up rows reversed (the vflip FFmpeg applies). */
function topDown(f: Uint8Array): Uint8Array {
  const out = new Uint8Array(f.length);
  const row = W * 4;
  for (let y = 0; y < H; y++) out.set(f.subarray(y * row, (y + 1) * row), (H - 1 - y) * row);
  return out;
}
const px = (f: Uint8Array, x: number, y: number): [number, number, number] => {
  const i = (y * W + x) * 4;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const isRed = (c: [number, number, number]) => c[0] > 235 && c[1] < 20 && c[2] < 20;
const isBlue = (c: [number, number, number]) => c[2] > 235 && c[0] < 20 && c[1] < 20;
/** Fraction of pixels that are mostly blue (rather than red), a coarse "how far along" measure. */
const blueShare = (f: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < f.length; i += 4) if (f[i + 2]! > f[i]!) n++;
  return n / (f.length / 4);
};
const allSame = (f: Uint8Array, test: (c: [number, number, number]) => boolean): boolean => {
  for (let i = 0; i < f.length; i += 4) if (!test([f[i]!, f[i + 1]!, f[i + 2]!])) return false;
  return true;
};

async function main() {
  // ── GL: wipeLeft (the incoming clip arrives from the right) ──────────────────────
  const left = await exportFrames(buildProject('gl:wipeLeft'));
  check('export_has_the_exact_frame_count', left.length === 40, { got: left.length });
  check('clip_before_the_window_exports_as_that_clip', allSame(left[0]!, isRed) && allSame(left[14]!, isRed));
  check('window_starts_on_the_exact_outgoing_frame', allSame(left[15]!, isRed));
  const mid = left[20]!;
  check('midpoint_is_split_left_red_right_blue', isRed(px(mid, 8, 27)) && isBlue(px(mid, W - 8, 27)), { l: px(mid, 8, 27), r: px(mid, W - 8, 27) });
  const shares = left.slice(15, 26).map(blueShare);
  check('transition_progresses_monotonically', shares.every((s, i) => i === 0 || s >= shares[i - 1]! - 0.001) && shares[0]! < 0.05 && shares[shares.length - 1]! > 0.95, { shares: shares.map((s) => +s.toFixed(2)) });
  check('clip_after_the_window_exports_as_that_clip', allSame(left[25]!, isBlue) && allSame(left[39]!, isBlue));
  check('no_exported_frame_is_blank', left.every((f) => f.some((v, i) => i % 4 !== 3 && v > 40)));
  check('alpha_is_opaque_in_every_frame', left.every((f) => { for (let i = 3; i < f.length; i += 4) if (f[i] !== 255) return false; return true; }));

  // ── GL: wipeUp (vertical, so an upside-down export would be caught) ───────────────
  const up = await exportFrames(buildProject('gl:wipeUp'));
  const m2 = topDown(up[20]!);
  check('export_is_upright_wipeUp_bottom_blue_top_red', isRed(px(m2, W / 2, 6)) && isBlue(px(m2, W / 2, H - 6)), { top: px(m2, W / 2, 6), bottom: px(m2, W / 2, H - 6) });

  // ── Preview vs export: the same moment, drawn by the preview compositor ──────────
  {
    const project = buildProject('gl:wipeLeft');
    const sequence = getActiveSequence(project);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const pool = new FrameSourcePool((s) => s);
    const compositor = new Compositor(canvas, pool);
    compositor.resize(W, H);
    const getMedia = (id: string) => project.media.find((m) => m.id === id);
    const worst: number[] = [];
    const upProject = buildProject('gl:wipeUp');
    const upSequence = getActiveSequence(upProject);
    for (const f of [15, 17, 20, 23, 25]) {
      for (const [seq2, exported] of [[sequence, left], [upSequence, up]] as const) {
        const ctx = { sequence: seq2, time: seconds(f / FPS), getMedia };
        compositor.prepare(ctx);
        await pool.whenAllReady(3000);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        compositor.render(ctx);
        const c2 = document.createElement('canvas');
        c2.width = W;
        c2.height = H;
        const g = c2.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(canvas, 0, 0);
        const preview = g.getImageData(0, 0, W, H).data; // top-down, as drawn
        const exp = topDown(exported[f]!);
        let maxd = 0;
        for (let i = 0; i < preview.length; i += 4) for (let k = 0; k < 3; k++) maxd = Math.max(maxd, Math.abs(preview[i + k]! - exp[i + k]!));
        worst.push(maxd);
      }
    }
    compositor.dispose();
    pool.disposeAll();
    check('preview_and_export_draw_the_same_pixels_both_orientations', worst.length === 10 && worst.every((d) => d <= 2), { worstPerFrame: worst });
  }

  // ── A classic transition still exports as before ─────────────────────────────────
  const wipe = await exportFrames(buildProject('wipe'));
  check('classic_transition_still_exports', wipe.length === 40 && allSame(wipe[0]!, isRed) && allSame(wipe[39]!, isBlue) && blueShare(wipe[20]!) > 0.2 && blueShare(wipe[20]!) < 0.8, { share: +blueShare(wipe[20]!).toFixed(2) });

  console.log('__RESULT__' + JSON.stringify({ ...results, ok: failures === 0, failures }));
}
main().catch((e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e), stack: (e as Error)?.stack })));
