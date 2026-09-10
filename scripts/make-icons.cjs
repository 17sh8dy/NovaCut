/**
 * Builds every application icon from the vector sources.
 *
 *   npm run icon        (→ electron scripts/make-icons.cjs)
 *
 * SOURCE OF TRUTH: `assets/NovaCut.svg` and `assets/NovaCut-small.svg`. Nothing else is
 * authored; everything below is a derivation. Change the logo there and re-run — never hand-edit
 * an output, or the taskbar icon and the in-app mark drift apart with nothing to say which one
 * is right.
 *
 * Outputs
 *   apps/desktop/build/icon.png       1024²   electron-builder's generic source
 *   apps/desktop/build/icon.ico               Windows: 16→256, multi-image
 *   apps/desktop/build/icon.icns              macOS: the full iconutil type set
 *   apps/desktop/build/icons/NxN.png          Linux: the png set electron-builder expects
 *   packages/ui/src/assets/logo.svg           the full vector, for the renderer to bundle
 *   packages/ui/src/assets/logo-small.svg     the small-size vector, ditto
 *
 * ── WHY THERE ARE TWO SOURCES ────────────────────────────────────────────────
 *
 * The mark is two translucent overlapping frames, a play triangle and four corner brackets.
 * That reads beautifully at 128px and collapses into a blue smudge at 16px: the 0.25/0.35
 * opacities converge on the background, the 12px bracket strokes fall below one pixel, and the
 * triangle merges with the frame behind it. Rendered and compared before this was written — at
 * 16px the full artwork carries almost no information.
 *
 * So the small sizes get their own drawing (`NovaCut-small.svg`): one frame at full opacity, a
 * knocked-out triangle, no brackets, no rotation. Same idea, same colour, two shapes instead of
 * seven. This is ordinary practice for an icon set and the reason .ico is a multi-image format
 * in the first place — an icon is not one drawing scaled, it is a family drawn per size.
 *
 * SMALL_MAX is the cut. It is deliberately generous: 32px is where the brackets start landing on
 * whole pixels, and anything at or below it takes the simplified art.
 *
 * HOW THE VECTOR IS RASTERISED: an offscreen Electron window draws the SVG into a <canvas> at
 * each size. Chromium is already here and is a better SVG rasteriser than anything that could be
 * added as a dependency. Going through a canvas — rather than capturing the window — is what
 * guarantees a real alpha channel instead of a window background composited behind the art.
 * PNG encoding is left to `canvas.toDataURL`, which also keeps the IPC payload to a data URL
 * rather than the ~4M-element pixel array a 1024² frame would otherwise have to cross as JSON.
 */

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');

const ROOT = join(__dirname, '..');
const SVG = join(ROOT, 'assets', 'NovaCut.svg');
const SVG_SMALL = join(ROOT, 'assets', 'NovaCut-small.svg');
const BUILD = join(ROOT, 'apps', 'desktop', 'build');
const ICONS = join(BUILD, 'icons');
const UI_ASSET = join(ROOT, 'packages', 'ui', 'src', 'assets', 'logo.svg');
const UI_ASSET_SMALL = join(ROOT, 'packages', 'ui', 'src', 'assets', 'logo-small.svg');

/** Every size anything downstream asks for. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** At or below this, use the simplified drawing. See the header for why. */
const SMALL_MAX = 32;
/**
 * Windows shell sizes. ≤64 ship as uncompressed DIBs, which every Windows version can draw;
 * 128 and 256 ship as PNG, which is how large icons have been stored since Vista.
 */
const ICO = [
  { size: 16, png: false }, { size: 24, png: false }, { size: 32, png: false },
  { size: 48, png: false }, { size: 64, png: false },
  { size: 128, png: true }, { size: 256, png: true },
];
/** Raw pixels are only needed for the DIB entries above — never for a 1024² frame. */
const NEEDS_RGBA = new Set(ICO.filter((e) => !e.png).map((e) => e.size));
/** macOS: the exact type set `iconutil` emits for a full .iconset. */
const ICNS = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024],
];

// ── ICO ───────────────────────────────────────────────────────────────────────
/**
 * A 32-bit DIB icon image: BITMAPINFOHEADER, then BGRA rows BOTTOM-UP, then the 1-bit AND mask.
 * The mask is vestigial for 32-bit icons but the format still requires it, and the header's
 * height field is doubled to cover both — omit either and Windows renders garbage.
 */
function dibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour data + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

function buildICO(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    const dim = img.size >= 256 ? 0 : img.size; // 0 means 256 in this format
    dir.writeUInt8(dim, e); dir.writeUInt8(dim, e + 1);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

// ── ICNS ──────────────────────────────────────────────────────────────────────
function buildICNS(entries) {
  const blocks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + blocks.reduce((s, b) => s + b.length, 0), 4);
  return Buffer.concat([head, ...blocks]);
}

// ── Rasterise ─────────────────────────────────────────────────────────────────
/**
 * Draw every size, taking each from whichever source suits it.
 *
 * Both SVGs are decoded up front into `__img.full` / `__img.small`, then each size picks one.
 * The choice is made HERE rather than by the caller so that there is exactly one place in the
 * build that knows which drawing a given pixel size gets — every output below (ico, icns, the
 * Linux set, the generic png) then inherits that decision for free and cannot disagree with the
 * others about what a 32px Nova Cut icon looks like.
 */
async function rasterise(full, small) {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body></body>'));

  // Decode once, then draw at each size. Sizes are fetched one at a time so no single IPC
  // response has to carry a whole large frame.
  await win.webContents.executeJavaScript(`window.__ready = (async () => {
    const load = (svg) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('the SVG failed to decode'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    window.__img = {
      full: await load(${JSON.stringify(full)}),
      small: await load(${JSON.stringify(small)}),
    };
    return true;
  })()`);

  const frames = {};
  for (const size of SIZES) {
    const variant = size <= SMALL_MAX ? 'small' : 'full';
    const res = await win.webContents.executeJavaScript(`(async () => {
      await window.__ready;
      const size = ${size};
      const img = window.__img[${JSON.stringify(variant)}];
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, size, size);              // start fully transparent, never white
      g.drawImage(img, 0, 0, size, size);
      const out = { png: c.toDataURL('image/png').slice('data:image/png;base64,'.length) };
      if (${NEEDS_RGBA.has(size)}) out.rgba = Array.from(g.getImageData(0, 0, size, size).data);
      // Corner alpha, so the caller can prove the canvas stayed transparent.
      out.cornerAlpha = g.getImageData(0, 0, 1, 1).data[3];
      return out;
    })()`);
    frames[size] = {
      png: Buffer.from(res.png, 'base64'),
      rgba: res.rgba ? Buffer.from(res.rgba) : null,
      cornerAlpha: res.cornerAlpha,
    };
  }
  win.destroy();
  return frames;
}

app.whenReady().then(async () => {
  const svg = readFileSync(SVG, 'utf8');
  const svgSmall = readFileSync(SVG_SMALL, 'utf8');
  const frames = await rasterise(svg, svgSmall);

  // A transparent canvas is a hard requirement, so assert it rather than trust it.
  const opaque = SIZES.filter((s) => frames[s].cornerAlpha !== 0);
  if (opaque.length) throw new Error(`opaque background at sizes: ${opaque.join(', ')}`);

  rmSync(ICONS, { recursive: true, force: true });
  mkdirSync(ICONS, { recursive: true });
  mkdirSync(dirname(UI_ASSET), { recursive: true });

  for (const size of SIZES) writeFileSync(join(ICONS, `${size}x${size}.png`), frames[size].png);
  writeFileSync(join(BUILD, 'icon.png'), frames[1024].png);

  writeFileSync(join(BUILD, 'icon.ico'), buildICO(
    ICO.map(({ size, png }) => ({ size, data: png ? frames[size].png : dibEntry(frames[size].rgba, size) })),
  ));
  writeFileSync(join(BUILD, 'icon.icns'), buildICNS(ICNS.map(([type, size]) => [type, frames[size].png])));

  // The renderer bundles the vectors, not rasters: the Home hero (88px), the About mark (56px)
  // and the title-bar mark (22px) are all different sizes, and scalable files beat PNGs that can
  // fall out of step. Both go across, because the same size threshold applies in the UI: the
  // title bar is well under SMALL_MAX and gets the simplified drawing for the same reason the
  // 16px taskbar icon does.
  writeFileSync(UI_ASSET, svg);
  writeFileSync(UI_ASSET_SMALL, svgSmall);

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  const smalls = SIZES.filter((s) => s <= SMALL_MAX);
  const fulls = SIZES.filter((s) => s > SMALL_MAX);
  console.log(`source   assets/NovaCut.svg (${svg.length} B) · assets/NovaCut-small.svg (${svgSmall.length} B)`);
  console.log(`variant  small → ${smalls.join(', ')}   ·   full → ${fulls.join(', ')}`);
  console.log(`png      ${SIZES.join(', ')} → build/icons/  ·  build/icon.png ${kb(frames[1024].png.length)}`);
  console.log(`ico      ${ICO.map((i) => i.size).join(', ')} → build/icon.ico`);
  console.log(`icns     ${ICNS.length} entries → build/icon.icns`);
  console.log(`ui       → packages/ui/src/assets/logo.svg + logo-small.svg`);
  console.log(`alpha    every size has a transparent corner ✓`);
  app.quit();
});
