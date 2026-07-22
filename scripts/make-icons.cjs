/**
 * Builds every application icon from the one vector source.
 *
 *   npm run icon        (→ electron scripts/make-icons.cjs)
 *
 * SOURCE OF TRUTH: `assets/OpenCut.svg`. Nothing else is authored; everything below is a
 * derivation. Change the logo there and re-run — never hand-edit an output, or the taskbar icon
 * and the in-app mark drift apart with nothing to say which one is right.
 *
 * Outputs
 *   apps/desktop/build/icon.png     1024²   electron-builder's generic source
 *   apps/desktop/build/icon.ico             Windows: 16→256, multi-image
 *   apps/desktop/build/icon.icns            macOS: the full iconutil type set
 *   apps/desktop/build/icons/NxN.png        Linux: the png set electron-builder expects
 *   packages/ui/src/assets/logo.svg         the vector itself, for the renderer to bundle
 *
 * HOW THE VECTOR IS RASTERISED: an offscreen Electron window draws the SVG into a <canvas> at
 * each size. Chromium is already here and is a better SVG rasteriser than anything that could be
 * added as a dependency. Going through a canvas — rather than capturing the window — is what
 * guarantees a real alpha channel instead of a window background composited behind the art.
 * PNG encoding is left to `canvas.toDataURL`, which also keeps the IPC payload to a data URL
 * rather than the ~4M-element pixel array a 1024² frame would otherwise have to cross as JSON.
 *
 * WHY THE GEOMETRY IS WHAT IT IS — the SVG was traced from `assets/logo-reference.png` by
 * measurement, not by eye. Three deliberate corrections were made, all alignment, not design:
 *   - the wedge apex sat at (0.5042, 0.4907) of the body; it is now exactly the centre
 *   - the wedge's upper edge met the top at 0.83787 of the width while the corner arc begins at
 *     0.82431; it now terminates exactly on that junction, so the cut reads as intentional
 *   - the four corner radii measured 37.7 / 38.2 / 40.7 / 41.5 px on a 225px body; all four are
 *     now 145 on an 824px body (0.17569, the measured average)
 */

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');

const ROOT = join(__dirname, '..');
const SVG = join(ROOT, 'assets', 'OpenCut.svg');
const BUILD = join(ROOT, 'apps', 'desktop', 'build');
const ICONS = join(BUILD, 'icons');
const UI_ASSET = join(ROOT, 'packages', 'ui', 'src', 'assets', 'logo.svg');

/** Every size anything downstream asks for. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
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
async function rasterise(svg) {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body></body>'));

  // Decode once, then draw at each size. Sizes are fetched one at a time so no single IPC
  // response has to carry a whole large frame.
  await win.webContents.executeJavaScript(`window.__ready = (async () => {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    window.__img = new Image();
    await new Promise((res, rej) => {
      window.__img.onload = res;
      window.__img.onerror = () => rej(new Error('the SVG failed to decode'));
      window.__img.src = url;
    });
    return true;
  })()`);

  const frames = {};
  for (const size of SIZES) {
    const res = await win.webContents.executeJavaScript(`(async () => {
      await window.__ready;
      const size = ${size};
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, size, size);              // start fully transparent, never white
      g.drawImage(window.__img, 0, 0, size, size);
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
  const frames = await rasterise(svg);

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

  // The renderer bundles the vector, not a raster: the title-bar mark and the Home hero are
  // different sizes, and one scalable file beats two PNGs that can fall out of step.
  writeFileSync(UI_ASSET, svg);

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  console.log(`source   assets/OpenCut.svg (${svg.length} bytes)`);
  console.log(`png      ${SIZES.join(', ')} → build/icons/  ·  build/icon.png ${kb(frames[1024].png.length)}`);
  console.log(`ico      ${ICO.map((i) => i.size).join(', ')} → build/icon.ico`);
  console.log(`icns     ${ICNS.length} entries → build/icon.icns`);
  console.log(`ui       → packages/ui/src/assets/logo.svg`);
  console.log(`alpha    every size has a transparent corner ✓`);
  app.quit();
});
