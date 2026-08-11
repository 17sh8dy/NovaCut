// Electron host for the export profiler. Same shape as .verify/main.cjs, with a longer
// budget (a real export takes tens of seconds) and media paths passed through the query.
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
  const show = process.argv.includes('--show');
  const win = new BrowserWindow({ show, width: 400, height: 300 });
  win.webContents.on('console-message', (_e, _l, message) => {
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
  win.webContents.on('did-fail-load', (_e, c, d) => finish(1, `[host] LOAD FAILED ${c} ${d}`));
  win.webContents.on('render-process-gone', (_e, d) => finish(1, '[host] RENDERER GONE ' + JSON.stringify(d)));

  const q = process.argv.slice(2).find((a) => a.startsWith('query=')) || '';
  const page = process.argv.slice(2).find((a) => a.endsWith('.html')) || 'export-profile.html';
  win.loadFile(path.join(__dirname, page), { search: q.slice('query='.length) })
     .catch((e) => finish(1, '[host] loadFile threw: ' + e));

  setTimeout(() => finish(1, '[host] TIMEOUT'), 600000);
});
