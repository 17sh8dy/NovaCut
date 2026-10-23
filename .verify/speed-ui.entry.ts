/**
 * Playback-speed probe for the WHOLE editor: the real EditorApp (every panel, every subscriber)
 * playing a real clip at 1x..3x, measured from the page's own point of view.
 *
 *   npm run verify:speedui -- <video>
 *
 * The engine alone is fine at every speed (speed-engine.entry.ts), so any slowdown has to come from
 * what the rest of the app does on each tick. This mounts all of it and reports:
 *   - rafFps: animation frames the page actually got per second
 *   - uniqueFps: distinct pictures shown in the preview canvas per second
 *   - longTasksMs: total main-thread time spent in tasks over 50 ms
 *   - maxGapMs: the worst gap between two animation frames
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, createAppStore } from '@opencut/ui';
import { addClip, addMedia, addTrack, createClipFromMedia, seconds, updateClip, type PlatformBridge, type MediaAsset } from '@opencut/core';

const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '';
const START = Number(params.get('start') ?? '20');
const MODE = params.get('mode') ?? 'transport'; // 'transport' = the preview's speed menu; 'clip' = the clip's own Speed setting
const SPEEDS = ((params.get('speeds') || null) ?? (MODE === 'clip' ? '1,1.5,2,4,8' : '1,1.5,2')).split(',').map(Number);
const SECS = Number(params.get('secs') ?? '4');
const row = (o: unknown) => console.log('__ROW__' + JSON.stringify(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bridge: PlatformBridge = {
  platform: 'desktop',
  openProjectDialog: async () => null,
  saveProject: async () => null,
  loadProject: async () => {
    throw new Error('unused');
  },
  recentProjects: async () => [],
  importDialog: async () => [],
  probeMedia: async () => {
    throw new Error('unused');
  },
  generateThumbnail: async () => '',
  resolveMediaUrl: (src) => src,
  resolveDroppedFile: () => null,
  chooseExportPath: async () => null,
  createEncoder: async () => {
    throw new Error('unused');
  },
  notify: () => {},
};

// Count writes to currentTime (seeks) per element kind.
const seeks = { audio: 0, video: 0 };
const ctDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
  get: ctDesc.get,
  set(this: HTMLMediaElement, v: number) {
    if (this instanceof HTMLVideoElement) seeks.video++;
    else seeks.audio++;
    ctDesc.set!.call(this, v);
  },
});

async function main() {
  for (const key of Object.keys(localStorage)) if (key.startsWith('oc.')) localStorage.removeItem(key);
  document.documentElement.style.cssText = 'width:100%;height:100%';
  document.body.style.cssText = 'margin:0;width:1440px;height:900px;overflow:hidden';
  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%';
  document.body.appendChild(host);

  const store = createAppStore(bridge);
  const s = () => store.getState();
  s().setView('editor');
  createRoot(host).render(createElement(EditorApp, { store }));
  await sleep(600);
  for (const b of [...document.querySelectorAll('button')]) if ((b.textContent || '').includes('Discard')) b.click();

  const media = { id: 'm', kind: 'video', name: 'clip.mp4', src: SRC, duration: seconds(60), width: 1920, height: 1080, fps: 60, hasAudio: true, fileSize: 1, importedAt: 0 } as unknown as MediaAsset;
  s().dispatch(addMedia([media]));
  s().dispatch(addTrack('video'));
  const trackId = s().sequence().tracks.find((t) => t.kind === 'video')!.id;
  s().dispatch(addClip(trackId, { ...createClipFromMedia(media, 0), id: 'A', start: 0, duration: seconds(60), sourceOut: seconds(60) }));
  await sleep(500);

  const canvas = document.querySelector<HTMLCanvasElement>('.oc-preview canvas')!;
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 18;
  const pg = probe.getContext('2d', { willReadFrequently: true })!;

  const speedSelect = () =>
    [...document.querySelectorAll<HTMLSelectElement>('select')].find((el) => [...el.options].some((o) => o.value === '1.5'));
  const setSpeed = (v: number) => {
    const el = speedSelect();
    if (!el) throw new Error('no speed select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, String(v));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const space = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));

  let longTaskMs = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTaskMs += e.duration;
  }).observe({ entryTypes: ['longtask'] });

  for (const v of SPEEDS) {
    s().setPlayhead(seconds(START));
    if (MODE === 'clip') {
      const seqId = s().sequence().id;
      s().dispatch({ label: 'Set Speed', apply: (p) => updateClip(p, seqId, 'A' as never, (c) => ({ ...c, speed: { ...c.speed, rate: v } })) });
    } else setSpeed(v);
    await sleep(900);
    space(); // play
    await sleep(900); // warm-up
    let frames = 0;
    let unique = 0;
    let last = '';
    let maxGap = 0;
    let prev = performance.now();
    longTaskMs = 0;
    seeks.audio = 0;
    seeks.video = 0;
    const stop = performance.now() + SECS * 1000;
    const t0 = performance.now();
    const p0 = s().playhead;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - prev);
        prev = now;
        frames++;
        pg.drawImage(canvas, 0, 0, 32, 18);
        const d = pg.getImageData(0, 0, 32, 18).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 17) h = (h * 31 + d[i]!) | 0;
        const k = String(h);
        if (k !== last) unique++;
        last = k;
        if (now < stop) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const wall = (performance.now() - t0) / 1000;
    const advanced = (s().playhead - p0) / 705600000 / wall;
    space(); // pause
    row({
      speed: v,
      rafFps: +(frames / wall).toFixed(1),
      uniqueFps: +(unique / wall).toFixed(1),
      longTasksMs: Math.round(longTaskMs),
      maxGapMs: Math.round(maxGap),
      audioSeeks: seeks.audio,
      videoSeeks: seeks.video,
      timelineSecPerWallSec: +advanced.toFixed(2),
    });
    await sleep(600);
  }
  console.log('__RESULT__' + JSON.stringify({ ok: true }));
}
main().catch((e) => console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e), stack: (e as Error)?.stack })));
