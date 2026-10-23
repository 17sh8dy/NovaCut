// Host for the engine speed probe. Serves the clip through a COPY of the app's own `novacut://`
// range handler (apps/desktop/electron/main.ts serveMedia) when run with --protocol, so the
// measurement includes the real delivery path; otherwise through file://.
const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

let done = false;
const finish = (code, msg) => { if (done) return; done = true; process.stdout.write(msg + '\n', () => process.exit(code)); };
app.on('window-all-closed', () => {});

protocol.registerSchemesAsPrivileged([
  { scheme: 'novacut', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

async function serveMedia(request) {
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, '') || url.hostname);
  const size = (await stat(filePath)).size;
  const headers = new Headers({ 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  let status = 200, start = 0, end = size - 1;
  if (m) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  global.__reqs = (global.__reqs || 0) + 1;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })), { status, headers });
}

app.whenReady().then(() => {
  const video = process.argv[2];
  const useProtocol = process.argv.includes('--protocol');
  if (!video) return finish(1, 'usage: electron speed-engine-host.cjs <video> [--protocol]');
  if (useProtocol) protocol.handle('novacut', serveMedia);
  const src = useProtocol ? 'novacut://media/' + encodeURIComponent(video.split(String.fromCharCode(92)).join('/')) : pathToFileURL(video).href;
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false, webSecurity: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.showInactive();
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.startsWith('__ROW__')) process.stdout.write(m.slice(7) + '\n');
    else if (m.startsWith('__RESULT__')) { const r = JSON.parse(m.slice(10)); finish(r.ok ? 0 : 1, r.ok ? `done (protocol requests served: ${global.__reqs || 0})` : 'FAILED ' + m); }
  });
  win.webContents.on('render-process-gone', (_e, d) => finish(1, 'RENDERER GONE ' + JSON.stringify(d)));
  win.loadFile(path.join(__dirname, 'speed-ui.html'), { query: { src, mode: process.env.SPEED_MODE || 'transport', speeds: process.env.SPEEDS || '', start: process.env.START || '20' } }).catch((e) => finish(1, 'load failed ' + e));
  setTimeout(() => finish(1, 'TIMEOUT'), 150000);
});
