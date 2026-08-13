/**
 * Electron host for the browser-shelf harness.
 *
 * Differs from main.cjs in two ways, both because this harness is about what the user SEES:
 * the window is shown at a real editor size rather than hidden at 400x300, and a `__SHOT__`
 * line from the page triggers `capturePage()` into `.verify/shots/`. Screenshots are the point
 * — a layout can satisfy every state assertion in the harness and still be unusable, and the
 * only way to find that out is to look at it.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SHOTS = path.join(__dirname, 'shots');
let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  process.stdout.write(msg + '\n', () => process.exit(code));
};

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration.call?.(app);

app.whenReady().then(() => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 900,
    backgroundColor: '#101114',
    webPreferences: { offscreen: false },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('__SHOT__')) {
      const name = message.slice('__SHOT__'.length).replace(/[^a-z0-9-]/gi, '') || 'shot';
      win.webContents
        .capturePage()
        .then((img) => {
          fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
          process.stdout.write(`[shot] ${name}.png\n`);
        })
        .catch((e) => process.stdout.write('[shot] failed: ' + e + '\n'));
      return;
    }
    if (message.startsWith('__RESULT__')) {
      const payload = message.slice('__RESULT__'.length);
      try {
        const parsed = JSON.parse(payload);
        finish(parsed.ok ? 0 : 1, 'RESULT ' + JSON.stringify(parsed, null, 2));
      } catch {
        finish(1, 'UNPARSEABLE: ' + payload);
      }
      return;
    }
    process.stdout.write('[page] ' + message + '\n');
  });

  win.webContents.on('did-finish-load', () => process.stdout.write('[host] loaded\n'));
  win.webContents.on('did-fail-load', (_e, code, desc) => finish(1, `[host] LOAD FAILED ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => finish(1, '[host] RENDERER GONE ' + JSON.stringify(d)));

  win.loadFile(path.join(__dirname, 'browsers.html')).catch((e) => finish(1, '[host] loadFile threw: ' + e));
  setTimeout(() => finish(1, '[host] TIMEOUT — no result within 60s'), 60000);
});
