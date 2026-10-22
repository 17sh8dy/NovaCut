/**
 * Rasterises the Nova Mark SVGs into PNGs, an .ico and a preview sheet.
 *
 *   electron assets/brand/nova-mark/render.cjs      (run build.mjs first)
 *
 * Same technique as scripts/make-icons.cjs: an offscreen Electron window draws each SVG into a
 * canvas, which keeps real transparency. This script writes ONLY inside this folder; it does not
 * touch the app's icons. Sizes 32 and below use the `-small` drawing.
 */

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const HERE = __dirname;
const SVG = join(HERE, 'svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SMALL_MAX = 32;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildICO(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    const dim = img.size >= 256 ? 0 : img.size;
    dir.writeUInt8(dim, e); dir.writeUInt8(dim, e + 1);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body></body>'));

  const draw = async (svgText, w, h) => {
    const b64 = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svgText)}); });
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.clearRect(0, 0, ${w}, ${h});
      g.drawImage(img, 0, 0, ${w}, ${h});
      return c.toDataURL('image/png').slice('data:image/png;base64,'.length);
    })()`);
    return Buffer.from(b64, 'base64');
  };

  const { variants, glyphAspect } = JSON.parse(readFileSync(join(HERE, 'variants.json'), 'utf8'));
  let count = 0;

  for (const v of variants) {
    const full = readFileSync(join(SVG, `nova-mark-${v}.svg`), 'utf8');
    const small = readFileSync(join(SVG, `nova-mark-${v}-small.svg`), 'utf8');
    const dir = join(HERE, 'png', v);
    mkdirSync(dir, { recursive: true });
    const frames = {};
    for (const s of SIZES) {
      frames[s] = await draw(s <= SMALL_MAX ? small : full, s, s);
      writeFileSync(join(dir, `nova-mark-${v}-${s}.png`), frames[s]);
      count++;
    }
    if (v === 'default') {
      mkdirSync(join(HERE, 'ico'), { recursive: true });
      writeFileSync(
        join(HERE, 'ico', 'nova-mark.ico'),
        buildICO(ICO_SIZES.map((size) => ({ size, data: frames[size] }))),
      );
    }
  }

  // Glyph-only PNGs (transparent), 3:3.4 box.
  for (const f of readdirSync(SVG).filter((n) => n.startsWith('nova-glyph-'))) {
    const dir = join(HERE, 'png', 'glyph');
    mkdirSync(dir, { recursive: true });
    for (const h of [128, 256, 512]) {
      const w = Math.round(h * glyphAspect);
      writeFileSync(join(dir, f.replace('.svg', `-${h}.png`)), await draw(readFileSync(join(SVG, f), 'utf8'), w, h));
      count++;
    }
  }

  // One preview sheet: every variant, every size, on a neutral grey so transparency is honest.
  const cell = 150;
  const sheetW = 40 + SIZES.length * cell, sheetH = 40 + variants.length * cell;
  const imgs = [];
  for (const v of variants) for (const s of SIZES) {
    imgs.push({ v, s, b64: readFileSync(join(HERE, 'png', v, `nova-mark-${v}-${s}.png`)).toString('base64') });
  }
  const sheet = await win.webContents.executeJavaScript(`(async () => {
    const c = document.createElement('canvas'); c.width = ${sheetW}; c.height = ${sheetH};
    const g = c.getContext('2d'); g.fillStyle = '#6b7280'; g.fillRect(0, 0, c.width, c.height);
    const items = ${JSON.stringify(imgs)};
    const vs = ${JSON.stringify(variants)}; const ss = ${JSON.stringify(SIZES)};
    for (const it of items) {
      const img = new Image(); await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + it.b64; });
      const col = ss.indexOf(it.s), row = vs.indexOf(it.v);
      const px = Math.min(it.s, 128);
      const x = 20 + col * ${cell} + (${cell} - px) / 2, y = 20 + row * ${cell} + (${cell} - px) / 2;
      g.drawImage(img, x, y, px, px);
    }
    return c.toDataURL('image/png').slice('data:image/png;base64,'.length);
  })()`);
  writeFileSync(join(HERE, 'preview-sheet.png'), Buffer.from(sheet, 'base64'));

  console.log('rendered', count, 'pngs + ico + preview-sheet.png');
  win.destroy();
  app.quit();
});
