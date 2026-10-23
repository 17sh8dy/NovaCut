/**
 * Playback-speed probe for the REAL engine (clock + compositor + audio), on a real clip.
 *
 *   npm run verify:speedengine -- <video>
 *
 * speed.entry.ts shows the bare <video> element keeps up at any speed on this footage. This one
 * runs Nova Cut's own playback stack at 1x..4x and measures what the USER sees:
 *   - uniqueFps: distinct pictures actually shown per second (what "choppy" means)
 *   - audioSeeks / videoSeeks: how many times the engine wrote an element's currentTime
 *   - renderMs: the cost of one tick
 * A healthy run shows uniqueFps near the display rate and almost no seeks.
 */

import { AudioEngine, Compositor, FrameSourcePool, PlaybackClock } from '@opencut/engine';
import {
  History,
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  createProject,
  getActiveSequence,
  registerBuiltins,
  seconds,
  findMedia,
  TICKS_PER_SECOND,
  type MediaAsset,
  type Ticks,
} from '@opencut/core';

registerBuiltins();
const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '';
const SPEEDS = (params.get('speeds') ?? '1,1.5,2,3').split(',').map(Number);
const SECS = Number(params.get('secs') ?? '4');
const row = (o: unknown) => console.log('__ROW__' + JSON.stringify(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Count writes to currentTime per element kind.
const counts = { audio: 0, video: 0 };
const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
  get: desc.get,
  set(this: HTMLMediaElement, v: number) {
    if (this instanceof HTMLVideoElement) counts.video++;
    else counts.audio++;
    desc.set!.call(this, v);
  },
});

async function main() {
  const media = { id: 'm', kind: 'video', name: 'clip', src: SRC, duration: seconds(60), width: 1920, height: 1080, fps: 60, hasAudio: true, fileSize: 0, importedAt: 0 } as unknown as MediaAsset;
  const h = new History(createProject());
  h.dispatch(addMedia([media]));
  h.dispatch(addTrack('video'));
  const trackId = getActiveSequence(h.current).tracks.find((t) => t.kind === 'video')!.id;
  h.dispatch(addClip(trackId, { ...createClipFromMedia(media, 0), id: 'A', start: 0, duration: seconds(60), sourceOut: seconds(60) }));
  const project = h.current;
  const seq = getActiveSequence(project);

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px';
  document.body.appendChild(canvas);
  const pool = new FrameSourcePool((s) => s);
  const compositor = new Compositor(canvas, pool);
  const audio = new AudioEngine((s) => s);
  const clock = new PlaybackClock({ fps: 60, duration: seq.duration, loop: false });
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 18;
  const pg = probe.getContext('2d', { willReadFrequently: true })!;

  let speed = 1;
  let ticks = 0;
  let unique = 0;
  let lastHash = '';
  const renderMs: number[] = [];
  const getMedia = (id: string) => findMedia(project, id as never);

  clock.onTick((t: Ticks) => {
    ticks++;
    const t0 = performance.now();
    compositor.render({ sequence: seq, time: t, getMedia, playing: clock.isPlaying, speed });
    audio.update(seq, t, getMedia, speed);
    renderMs.push(performance.now() - t0);
    pg.drawImage(canvas, 0, 0, 32, 18);
    const d = pg.getImageData(0, 0, 32, 18).data;
    let hsh = 0;
    for (let i = 0; i < d.length; i += 17) hsh = (hsh * 31 + d[i]!) | 0;
    const key = String(hsh);
    if (key !== lastHash) unique++;
    lastHash = key;
  });

  for (const s of SPEEDS) {
    speed = s;
    clock.setSpeed(s);
    clock.seek(seconds(20));
    // let the seek settle and the media elements load before measuring
    compositor.render({ sequence: seq, time: seconds(20), getMedia, playing: false, speed: s });
    await sleep(1200);
    void audio.play();
    clock.play();
    await sleep(800); // warm-up: not measured
    ticks = 0;
    unique = 0;
    renderMs.length = 0;
    counts.audio = 0;
    counts.video = 0;
    const t0 = performance.now();
    const p0 = clock.position;
    await sleep(SECS * 1000);
    const wall = (performance.now() - t0) / 1000;
    const advanced = (clock.position - p0) / TICKS_PER_SECOND / wall;
    clock.pause();
    audio.pause();
    renderMs.sort((a, b) => a - b);
    row({
      speed: s,
      ticksPerSec: +(ticks / wall).toFixed(1),
      uniqueFps: +(unique / wall).toFixed(1),
      audioSeeks: counts.audio,
      videoSeeks: counts.video,
      renderMsAvg: +(renderMs.reduce((a, b) => a + b, 0) / Math.max(1, renderMs.length)).toFixed(2),
      renderMsP95: +(renderMs[Math.floor(renderMs.length * 0.95)] ?? 0).toFixed(2),
      timelineSecPerWallSec: +advanced.toFixed(2),
    });
    await sleep(500);
  }
  console.log('__RESULT__' + JSON.stringify({ ok: true }));
}
main().catch((e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e), stack: (e as Error)?.stack })));
