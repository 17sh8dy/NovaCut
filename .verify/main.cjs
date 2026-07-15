// Electron host for the orientation harness: loads the built page in a hidden window,
// captures the __RESULT__ line the page logs, prints it, and exits with a pass/fail code.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  process.stdout.write(msg + '\n', () => process.exit(code));
};

app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  process.stdout.write('[host] ready\n');
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { offscreen: false },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('__RESULT__')) {
      const payload = message.slice('__RESULT__'.length);
      try {
        const parsed = JSON.parse(payload);
        finish(parsed.ok ? 0 : 1, 'RESULT ' + JSON.stringify(parsed, null, 2));
      } catch {
        finish(1, 'UNPARSEABLE: ' + payload);
      }
    } else {
      process.stdout.write('[page] ' + message + '\n');
    }
  });

  win.webContents.on('did-finish-load', () => process.stdout.write('[host] loaded\n'));
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    finish(1, `[host] LOAD FAILED ${code} ${desc}`),
  );
  win.webContents.on('render-process-gone', (_e, d) =>
    finish(1, '[host] RENDERER GONE ' + JSON.stringify(d)),
  );

  win
    .loadFile(path.join(__dirname, process.argv[2] || 'run.html'))
    .catch((e) => finish(1, '[host] loadFile threw: ' + e));

  setTimeout(() => finish(1, '[host] TIMEOUT — no result within 25s'), 25000);
});
