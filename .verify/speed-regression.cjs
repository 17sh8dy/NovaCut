/**
 * Playback-speed regression test.
 *
 *   npm run verify:speed
 *
 * The bug it guards: a clip played at its own Speed setting above about 2x turned the preview into a
 * slideshow (about 1 distinct picture a second). Two things caused it: the audio element could not
 * hold its clock above 2x, so the drift check re-seeked it hundreds of times a second, and those
 * seeks on the same file starved the video; and the video's own drift correction had a fixed
 * threshold that a slow seek could never get under above 2x, so it re-seeked forever.
 *
 * It builds a 60 s 1080p60 H.264 clip (noisy, ~45 Mbps, a keyframe every 5 s, like a screen recording) with an audio track (with the FFmpeg bundled in this repo, so
 * no footage of anyone's is needed), mounts the whole editor on it, plays at 1x..8x clip speed and
 * checks what a viewer would see. Needs a display (a window is shown, without stealing focus).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'apps', 'desktop', 'resources', 'ffmpeg', 'ffmpeg.exe');
const FIXTURE = path.join(__dirname, 'shots', 'speed-fixture.mp4');

if (!fs.existsSync(FIXTURE)) {
  if (!fs.existsSync(FFMPEG)) {
    console.error('bundled FFmpeg not found at ' + FFMPEG + ' (run npm run ffmpeg:fetch)');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  console.log('building the test clip (once)...');
  const r = spawnSync(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60,noise=alls=22:allf=t',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '60', '-c:v', 'libopenh264', '-b:v', '45M', '-g', '300', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-shortest', FIXTURE,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('could not build the test clip');
    process.exit(2);
  }
}

const SPEEDS = [1, 2, 3, 4, 8];
const electron = require('electron');
const run = spawnSync(electron, [path.join(__dirname, 'speed-ui-host.cjs'), FIXTURE, '--protocol'], {
  encoding: 'utf8',
  env: { ...process.env, SPEED_MODE: 'clip', SPEEDS: SPEEDS.join(','), START: '12' },
  timeout: 240000,
});
const rows = (run.stdout || '')
  .split('\n')
  .filter((l) => l.startsWith('{"speed"'))
  .map((l) => JSON.parse(l));

let failures = 0;
const check = (name, pass, detail) => {
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!pass) failures++;
};

check('measured every speed', rows.length === SPEEDS.length, `${rows.length}/${SPEEDS.length} rows` + (rows.length ? '' : '\n' + (run.stdout || '').slice(-600)));
for (const r of rows) {
  const tag = `${r.speed}x`;
  // The bug left ~1-5 distinct pictures a second. A healthy run shows tens to hundreds.
  check(`${tag}: preview is not a slideshow`, r.uniqueFps >= 40, `uniqueFps=${r.uniqueFps}`);
  check(`${tag}: audio is not re-seeked in a storm`, r.audioSeeks <= 4, `audioSeeks=${r.audioSeeks}`);
  check(`${tag}: video is not re-seeked in a storm`, r.videoSeeks <= 30, `videoSeeks=${r.videoSeeks}`);
  check(`${tag}: the timeline advances at the right speed`, r.timelineSecPerWallSec > 0.9 && r.timelineSecPerWallSec < 1.1, `timeline s per s=${r.timelineSecPerWallSec}`);
}
console.log(failures === 0 ? '\nOK' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
