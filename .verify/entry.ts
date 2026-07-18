/**
 * Render-graph harness — proves the photo render graph composites correctly, on real pixels.
 *
 * Two things are pinned here.
 *
 * **Orientation.** The quad's `v` and the upload's UNPACK_FLIP_Y_WEBGL must agree, or each
 * effect pass flips the frame — upside down at odd counts, self-cancelling at even ones. So the
 * 1-effect and 3-effect cases are the whole point; testing 0 and 2 alone would pass while
 * broken. It now drives PhotoRenderer rather than the old `Compositor.renderStill`, and that
 * still pins the video path: both renderers share one GLContext and one effect chain, which is
 * precisely why that plumbing was extracted into `packages/engine/src/gl`.
 *
 * **Compositing.** Blend modes, group isolation, clipping masks and adjustment layers are all
 * arithmetic on pixels, and all of them are the kind of thing that looks plausible while being
 * subtly wrong. Every case below asserts an exact expected colour worked out by hand from the
 * W3C compositing formula, not merely "it changed".
 *
 * Test images are vertically asymmetric (red top / blue bottom) so a flip is unambiguous rather
 * than a judgement call about a photo looking "about right".
 */

import { PhotoRenderer, type PhotoRenderContext } from '@opencut/engine';
import { instantiateEffect, registerBuiltins, type MediaAsset, type MediaId } from '@opencut/core';
import {
  IDENTITY_TRANSFORM,
  type BlendMode,
  type Layer,
  type LayerId,
  type PhotoDocument,
} from '@opencut/photo';

window.addEventListener('error', (e) =>
  console.log('__RESULT__' + JSON.stringify({ ok: false, error: String(e.message) })),
);
window.addEventListener('unhandledrejection', (e) =>
  console.log('__RESULT__' + JSON.stringify({ ok: false, error: 'rejection: ' + String(e.reason) })),
);

registerBuiltins();

const SIZE = 8;

// ── Test fixtures ────────────────────────────────────────────────────────────

const frames = new Map<string, HTMLImageElement>();
let mediaSeq = 0;

/** Register a bitmap as a MediaAsset the graph can resolve, mirroring the store's contract. */
function asset(img: HTMLImageElement): MediaAsset {
  const id = `m${mediaSeq++}` as MediaId;
  frames.set(id, img);
  return {
    id,
    kind: 'image',
    name: id,
    src: id,
    duration: 0,
    width: SIZE,
    height: SIZE,
    hasAudio: false,
    fileSize: 0,
    importedAt: 0,
  };
}

function paint(draw: (ctx: CanvasRenderingContext2D) => void): Promise<HTMLImageElement> {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  draw(c.getContext('2d')!);
  const img = new Image();
  return new Promise((res, rej) => {
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('test image failed to decode'));
    img.src = c.toDataURL();
  });
}

/** RED on top, BLUE on bottom — the orientation probe. */
const redBlue = () =>
  paint((ctx) => {
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, SIZE, SIZE / 2);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, SIZE / 2, SIZE, SIZE / 2);
  });

const solid = (hex: string) =>
  paint((ctx) => {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, SIZE, SIZE);
  });

/** Opaque white on the LEFT half, fully transparent on the right — the clipping-mask probe. */
const halfAlpha = () =>
  paint((ctx) => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE / 2, SIZE);
  });

/**
 * A half-transparent fill — the soft-alpha probe.
 *
 * Every other fixture here is fully opaque, and that is exactly why none of them could reach
 * the `ab < 1` paths where two real compositing bugs were hiding.
 */
const translucent = (hex: string, alpha: number) =>
  paint((ctx) => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, SIZE, SIZE);
  });

let layerSeq = 0;
function layer(over: Partial<Layer> = {}): Layer {
  return {
    kind: 'image',
    id: `l${layerSeq++}` as LayerId,
    name: 'layer',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    clipped: false,
    transform: { ...IDENTITY_TRANSFORM },
    effects: [],
    ...over,
  } as Layer;
}

function makeDoc(
  layers: Layer[],
  media: MediaAsset[],
  background = '#000000',
  width = SIZE,
  height = SIZE,
): PhotoDocument {
  return {
    schemaVersion: 2,
    id: 'doc' as PhotoDocument['id'],
    name: 'harness',
    createdAt: 0,
    modifiedAt: 0,
    width,
    height,
    background,
    layers,
    media,
  };
}

const contextFor = (doc: PhotoDocument): PhotoRenderContext => ({
  doc,
  getMedia: (id) => doc.media.find((m) => m.id === id),
  getFrame: (id) => frames.get(id) ?? null,
});

// ── Reading pixels back ──────────────────────────────────────────────────────

/** Read the composited canvas through a 2D context, which is top-down like the DOM. */
function readback(canvas: HTMLCanvasElement, w = SIZE, h = SIZE) {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return (x: number, y: number): [number, number, number] => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
}

/** Classify by dominant channel so a brightness pass can't confuse an orientation verdict. */
function hue([r, , b]: [number, number, number]): string {
  if (r > b + 30) return 'red';
  if (b > r + 30) return 'blue';
  return `other(${r},${b})`;
}

/** 8-bit channels through a GPU round-trip; ±3 absorbs rounding without hiding a real error. */
const near = (got: [number, number, number], want: [number, number, number]) =>
  got.every((c, i) => Math.abs(c - want[i]!) <= 3);

// ── Cases ────────────────────────────────────────────────────────────────────

async function main() {
  const results: Record<string, unknown> = {};
  const failures: string[] = [];
  const check = (name: string, pass: boolean, detail: unknown) => {
    results[name] = { pass, ...(detail as object) };
    if (!pass) failures.push(name);
  };

  try {
    const canvas = document.createElement('canvas');
    const renderer = new PhotoRenderer(canvas);
    const draw = (doc: PhotoDocument) => {
      renderer.render(contextFor(doc));
      return readback(canvas, doc.width, doc.height);
    };

    // ── 1. Orientation at every effect count ────────────────────────────────
    //
    // `brightness` defaults to 0 => colorAdjust is an identity pass, so any colour change would
    // be the chain misbehaving rather than the effect doing its job.
    const rb = asset(await redBlue());
    for (const n of [0, 1, 2, 3]) {
      const effects = Array.from({ length: n }, () => instantiateEffect('brightness'));
      const px = draw(makeDoc([layer({ mediaId: rb.id, effects })], [rb], '#00ff00'));
      const top = hue(px(SIZE / 2, 1));
      const bottom = hue(px(SIZE / 2, SIZE - 2));
      check(`orientation_${n}fx`, top === 'red' && bottom === 'blue', { top, bottom });
    }

    // ── 2. Blend modes ──────────────────────────────────────────────────────
    //
    // Backdrop red (1,0,0) under source grey (0.502). Expected values are B(Cb,Cs) worked out
    // by hand, which is the point: an implementation that merely "looks blended" fails these.
    const red = asset(await solid('#ff0000'));
    const grey = asset(await solid('#808080'));
    const blendCases: Array<[BlendMode, [number, number, number]]> = [
      ['normal', [128, 128, 128]],
      ['multiply', [128, 0, 0]], // r: 1*.502    g,b: 0*.502
      ['screen', [255, 128, 128]], // r: 1+.502-.502   g,b: 0+.502-0
      ['difference', [127, 128, 128]], // |1-.502| , |0-.502|
      ['darken', [128, 0, 0]],
      ['lighten', [255, 128, 128]],
    ];
    for (const [mode, want] of blendCases) {
      const px = draw(
        makeDoc([layer({ mediaId: red.id }), layer({ mediaId: grey.id, blendMode: mode })], [red, grey]),
      );
      const got = px(SIZE / 2, SIZE / 2);
      check(`blend_${mode}`, near(got, want), { got, want });
    }

    // ── 3. Layer opacity ────────────────────────────────────────────────────
    // White at 50% over red → (255,128,128).
    const white = asset(await solid('#ffffff'));
    {
      const px = draw(
        makeDoc([layer({ mediaId: red.id }), layer({ mediaId: white.id, opacity: 0.5 })], [red, white]),
      );
      check('opacity_50', near(px(4, 4), [255, 128, 128]), { got: px(4, 4) });
    }

    // ── 4. Group isolation ──────────────────────────────────────────────────
    //
    // A group at 50% must cross-fade its FLATTENED contents. Two stacked opaque layers inside
    // (blue under white) must read as 50% white over the red backdrop — NOT as each child faded
    // separately, which would let the blue show through and give a purple cast.
    const blue = asset(await solid('#0000ff'));
    {
      const group = layer({
        kind: 'group',
        opacity: 0.5,
        children: [layer({ mediaId: blue.id }), layer({ mediaId: white.id })],
        collapsed: false,
      });
      const px = draw(makeDoc([layer({ mediaId: red.id }), group], [red, white, blue]));
      check('group_opacity_flattens', near(px(4, 4), [255, 128, 128]), { got: px(4, 4) });
    }

    // ── 5. Clipping mask ────────────────────────────────────────────────────
    //
    // Base is opaque-left / transparent-right; a blue layer clipped to it must appear ONLY on
    // the left. The right half is the assertion that matters — without clipping it would be
    // blue too, so this case fails loudly on a no-op implementation.
    {
      const mask = asset(await halfAlpha());
      const px = draw(
        makeDoc(
          [layer({ mediaId: mask.id }), layer({ mediaId: blue.id, clipped: true })],
          [mask, blue],
          '#00ff00',
        ),
      );
      const left = px(1, 4);
      const right = px(SIZE - 2, 4);
      check('clipping_mask', near(left, [0, 0, 255]) && near(right, [0, 255, 0]), { left, right });
    }

    // ── 6. Adjustment layer reads the backdrop ──────────────────────────────
    //
    // Brightness +0.5 above a mid-grey layer must lift the BACKDROP, proving the adjustment
    // reads what is composited beneath it rather than pixels of its own (it has none).
    const brightAdj = (opacity = 1) => {
      const a = layer({ kind: 'adjustment', opacity, adjustment: instantiateEffect('brightness') });
      if (a.kind === 'adjustment') a.adjustment.params['brightness'] = { static: 0.5, keyframes: [] };
      return a;
    };
    {
      const before = draw(makeDoc([layer({ mediaId: grey.id })], [grey]))(4, 4);
      const after = draw(makeDoc([layer({ mediaId: grey.id }), brightAdj()], [grey]))(4, 4);
      check('adjustment_lifts_backdrop', after[0] > before[0] + 40, { before, after });
    }

    // ── 7. Adjustment opacity means strength ────────────────────────────────
    {
      const base = draw(makeDoc([layer({ mediaId: grey.id })], [grey]))(4, 4);
      const full = draw(makeDoc([layer({ mediaId: grey.id }), brightAdj(1)], [grey]))(4, 4);
      const half = draw(makeDoc([layer({ mediaId: grey.id }), brightAdj(0.5)], [grey]))(4, 4);
      const mid = (base[0] + full[0]) / 2;
      check('adjustment_opacity_is_strength', Math.abs(half[0] - mid) <= 4, { base, half, full, mid });
    }

    // ── 8. Hidden layers draw nothing ───────────────────────────────────────
    {
      const px = draw(
        makeDoc([layer({ mediaId: red.id }), layer({ mediaId: white.id, visible: false })], [red, white]),
      );
      check('hidden_layer_skipped', near(px(4, 4), [255, 0, 0]), { got: px(4, 4) });
    }

    // ── 9. Transform is honored ─────────────────────────────────────────────
    //
    // Scaling the top layer to 25% must leave the backdrop showing at the edges. The old
    // renderStill ignored transform entirely, so this case is what proves it is now live.
    {
      const scaled = layer({
        mediaId: white.id,
        transform: { ...IDENTITY_TRANSFORM, scaleX: 0.25, scaleY: 0.25 },
      });
      const px = draw(makeDoc([layer({ mediaId: red.id }), scaled], [red, white]));
      const centre = px(4, 4);
      const corner = px(0, 0);
      check('transform_scale', near(centre, [255, 255, 255]) && near(corner, [255, 0, 0]), {
        centre,
        corner,
      });
    }

    // ── 10. Blending against a TRANSPARENT backdrop ─────────────────────────
    //
    // The `(1 - ab)` term in `Cr = (1-ab)·Cs + ab·B(Cb,Cs)`, which hand-rolled blend shaders
    // routinely drop. Every case above blends onto the opaque document background, where ab=1
    // and the term vanishes — so none of them can catch its absence.
    //
    // A Multiply layer alone inside a group blends against the group's transparent backdrop.
    // It must come out as itself (nothing beneath it to multiply with). Drop the term and
    // B(0, white) = 0 makes it black.
    {
      const group = layer({
        kind: 'group',
        children: [layer({ mediaId: white.id, blendMode: 'multiply' })],
        collapsed: false,
      });
      const px = draw(makeDoc([layer({ mediaId: red.id }), group], [red, white]));
      check('blend_over_transparent_backdrop', near(px(4, 4), [255, 255, 255]), { got: px(4, 4) });
    }

    // ── 11. Out-of-range blend results are clamped BEFORE compositing ───────
    //
    // Linear Burn, Linear Dodge, Linear Light and Subtract all range outside [0,1] by design.
    // The spec clamps B(Cb,Cs) before the alpha composite; clamping only at the end is
    // invisible at opacity 1 (co is just B, and saturates the same) and wrong below it.
    //
    // Grey 0.502 backdrop, dark 0.25 source, Linear Burn at 50%:
    //   B = 0.502 + 0.25 - 1 = -0.248  → clamped to 0
    //   co = 0.5·0 + 0.5·0.502 = 0.251 → 64
    // Unclamped, B = -0.248 drags the backdrop's share down: co = 0.127 → 32. Twice as dark.
    {
      const dark = asset(await solid('#404040')); // 0.25
      const px = draw(
        makeDoc(
          [layer({ mediaId: grey.id }), layer({ mediaId: dark.id, blendMode: 'linearBurn', opacity: 0.5 })],
          [grey, dark],
        ),
      );
      check('blend_clamped_before_composite', near(px(4, 4), [64, 64, 64]), { got: px(4, 4) });
    }

    // ── 12. An adjustment layer adds no coverage ────────────────────────────
    //
    // The adjusted copy IS the backdrop, so compositing it source-over doubles the coverage:
    // as == ab gives ao = ab + ab(1-ab) = 2ab - ab². Invisible on an opaque backdrop, which is
    // where cases 6 and 7 both sit — so only a soft-alpha backdrop can catch it, and inside a
    // group is the only place one occurs.
    //
    // Group holds [grey 0.502 @ alpha 0.5, Brightness +0.5]. Correct: the adjustment lifts the
    // colour to white and leaves alpha at 0.5, so over green the group reads (128, 255, 128).
    // Source-over instead yields alpha 0.75 and a ⅔-applied adjustment → about (159, 223, 159).
    {
      const softGrey = asset(await translucent('#808080', 0.5));
      const group = layer({
        kind: 'group',
        children: [layer({ mediaId: softGrey.id }), brightAdj()],
        collapsed: false,
      });
      const px = draw(makeDoc([group], [softGrey], '#00ff00'));
      check('adjustment_preserves_backdrop_alpha', near(px(4, 4), [128, 255, 128]), { got: px(4, 4) });
    }

    // ── 13. Rotation on a non-square canvas ─────────────────────────────────
    //
    // Clip space is -1..1 on both axes, so one clip unit is W/2 px across but H/2 px down.
    // Rotating there rotates in a squashed space, which shears. Every case above uses a square
    // canvas, where the two scales coincide and the bug cannot appear.
    //
    // 16×8 canvas, 8×8 white square (fit → x ±0.5, y ±1 = 8×8 px, centred, x ∈ [4,12)).
    // Rotated 90° it must still be an 8×8 square, so x=1 stays background. Rotate in clip space
    // instead and it smears to the full 16 px width, turning x=1 white.
    {
      const rotated = layer({
        mediaId: white.id,
        transform: { ...IDENTITY_TRANSFORM, rotation: 90 },
      });
      const px = draw(makeDoc([rotated], [white], '#00ff00', 16, 8));
      const edge = px(1, 4);
      const centre = px(8, 4);
      check('rotation_square_on_wide_canvas', near(edge, [0, 255, 0]) && near(centre, [255, 255, 255]), {
        edge,
        centre,
      });
    }

    // ── 14. The pool stays balanced ─────────────────────────────────────────
    //
    // render() throws when a pass leaks a buffer. Re-rendering a deep document many times is
    // what would expose a leak, since a single frame can leak and still look correct.
    {
      const nested = layer({
        kind: 'group',
        children: [
          layer({ mediaId: white.id, blendMode: 'multiply' }),
          layer({ mediaId: red.id, clipped: true }),
        ],
        collapsed: false,
      });
      const doc = makeDoc([layer({ mediaId: red.id }), nested, brightAdj()], [red, white]);
      let threw: string | null = null;
      try {
        for (let i = 0; i < 25; i++) renderer.render(contextFor(doc));
      } catch (e) {
        threw = String(e);
      }
      check('fbo_pool_balanced_over_25_frames', threw === null, { threw });
    }

    results.ok = failures.length === 0;
    if (failures.length) results.failed = failures;
  } catch (e) {
    results.error = String(e);
    results.stack = e instanceof Error ? e.stack : undefined;
    results.ok = false;
  }
  console.log('__RESULT__' + JSON.stringify(results));
}

void main();
