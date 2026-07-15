/**
 * Orientation harness — proves the compositor renders upright at EVERY effect count.
 *
 * The bug this pins: the quad's v and the upload's UNPACK_FLIP_Y_WEBGL must agree, or each
 * effect pass flips the frame — upside down at odd counts, self-cancelling at even ones. So a
 * 1-effect case is the whole point; testing 0 and 2 alone would have passed while broken.
 *
 * Test image is RED on top, BLUE on bottom — vertically asymmetric, so a flip is unambiguous.
 */

import { Compositor, FrameSourcePool } from '@opencut/engine';
import { instantiateEffect, registerBuiltins } from '@opencut/core';

window.addEventListener('error', (e) =>
  console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e.message) })),
);
window.addEventListener('unhandledrejection', (e) =>
  console.log('__RESULT__' + JSON.stringify({ ok: false, error: 'rejection: ' + String(e.reason) })),
);

registerBuiltins();

const SIZE = 8;

function makeTestImage(): Promise<HTMLImageElement> {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, SIZE, SIZE / 2); // TOP half red
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, SIZE / 2, SIZE, SIZE / 2); // BOTTOM half blue
  const url = c.toDataURL();
  const img = new Image();
  return new Promise((res, rej) => {
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('test image failed to decode'));
    img.src = url;
  });
}

/** Read the composited canvas back through a 2D context, which is top-down like the DOM. */
function sample(canvas: HTMLCanvasElement): { top: string; bottom: string } {
  const out = document.createElement('canvas');
  out.width = SIZE;
  out.height = SIZE;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  const px = (y: number) => {
    const d = ctx.getImageData(SIZE / 2, y, 1, 1).data;
    // Classify by dominant channel so a brightness/colour pass can't confuse the verdict.
    if (d[0]! > d[2]! + 30) return 'red';
    if (d[2]! > d[0]! + 30) return 'blue';
    return `other(${d[0]},${d[1]},${d[2]})`;
  };
  return { top: px(1), bottom: px(SIZE - 2) };
}

async function main() {
  const results: Record<string, unknown> = {};
  try {
    const img = await makeTestImage();
    const canvas = document.createElement('canvas');
    const pool = new FrameSourcePool((src) => src);
    const compositor = new Compositor(canvas, pool);

    // `brightness` defaults to 0 => colorAdjust is an identity pass, so any colour change
    // would be the chain misbehaving rather than the effect doing its job.
    for (const n of [0, 1, 2, 3]) {
      const effects = Array.from({ length: n }, () => instantiateEffect('brightness'));
      compositor.renderStill({
        width: SIZE,
        height: SIZE,
        background: '#00ff00',
        layers: [{ frame: img, width: SIZE, height: SIZE, effects, opacity: 1 }],
      });
      const { top, bottom } = sample(canvas);
      results[`effects_${n}`] = { top, bottom, upright: top === 'red' && bottom === 'blue' };
    }

    // renderClip and renderStill share the upload + chain, so this pins the video path's
    // orientation too. Driving render() as well would need a full Sequence stub for no
    // extra coverage of the thing under test.
    results.ok = [0, 1, 2, 3].every((n) => (results[`effects_${n}`] as { upright: boolean }).upright);
  } catch (e) {
    results.error = String(e);
    results.ok = false;
  }
  console.log('__RESULT__' + JSON.stringify(results));
}

void main();
