// Electron host for the GL contact sheet: runs the page hidden, then pulls the finished PNG and the
// per-transition measurements out of it and writes them to .verify/shots/.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  process.stdout.write(msg + '\n', () => process.exit(code));
};

app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: false, backgroundThrottling: false } });
  win.webContents.on('console-message', async (_e, _level, message) => {
    if (message !== '__DONE__') return;
    try {
      const png = await win.webContents.executeJavaScript('window.__sheetPng');
      const metrics = await win.webContents.executeJavaScript('window.__metrics');
      const size = await win.webContents.executeJavaScript('window.__sheetSize');
      const dir = path.join(__dirname, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'gl-transitions-contact-sheet.png');
      fs.writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(dir, 'gl-transitions-contact-sheet.json'), JSON.stringify(metrics, null, 2));
      finish(0, `SHEET ${out} ${size[0]}x${size[1]}`);
    } catch (e) {
      finish(1, 'failed to read the sheet: ' + e);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => finish(1, '[host] RENDERER GONE ' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc) => finish(1, `[host] LOAD FAILED ${code} ${desc}`));
  win.loadFile(path.join(__dirname, 'gl-contact-sheet.html')).catch((e) => finish(1, '[host] loadFile threw: ' + e));
  setTimeout(() => finish(1, '[host] TIMEOUT'), 80000);
});
