/**
 * Playback-speed probe: how fast can a <video> element actually decode and present a given clip at
 * 1x .. 4x in THIS Electron, and what does it do when asked for more than it can sustain?
 *
 *   npm run verify:speed -- <path-to-video>     (defaults to ?src= in the page URL)
 *
 * Measures, per speed, over a few seconds of playback: the rate the media clock really advanced
 * (1.0 means it kept up), the presented frames per second (requestVideoFrameCallback), dropped
 * frames reported by the element, and how many seeks the element was asked to do.
 */

const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '';
const SPEEDS = (params.get('speeds') || '1,1.5,2,3,4').split(',').map(Number);
const SECS = 4;

const log = (o: unknown) => console.log('__ROW__' + JSON.stringify(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(speed: number, startAt: number) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = SRC;
  v.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px';
  document.body.appendChild(v);
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () => rej(new Error('video error ' + v.error?.code + ' ' + v.error?.message));
  });
  let seeks = 0;
  v.addEventListener('seeking', () => seeks++);
  v.currentTime = startAt;
  await new Promise((r) => (v.onseeked = () => r(null)));
  seeks = 0;
  v.playbackRate = speed;
  let presented = 0;
  const rvfc = (v as any).requestVideoFrameCallback?.bind(v);
  const loop = () => {
    presented++;
    rvfc(loop);
  };
  rvfc?.(loop);
  const t0 = performance.now();
  const c0 = v.currentTime;
  await v.play();
  await sleep(SECS * 1000);
  const wall = (performance.now() - t0) / 1000;
  const advanced = v.currentTime - c0;
  const q = v.getVideoPlaybackQuality?.();
  v.pause();
  const row = {
    speed,
    mediaRate: +(advanced / wall).toFixed(2), // 1x-equivalent: advanced media seconds per wall second
    wantedRate: speed,
    keptUp: +(advanced / wall / speed).toFixed(2),
    presentedFps: +(presented / wall).toFixed(1),
    droppedFrames: q?.droppedVideoFrames ?? null,
    totalFrames: q?.totalVideoFrames ?? null,
    seeks,
    size: `${v.videoWidth}x${v.videoHeight}`,
  };
  v.remove();
  return row;
}

async function main() {
  try {
    const rows = [];
    for (const s of SPEEDS) {
      const row = await probe(s, 2);
      log(row);
      rows.push(row);
    }
    console.log('__RESULT__' + JSON.stringify({ ok: true, rows }));
  } catch (e) {
    console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e) }));
  }
}
main();
