// Host for the speed probe: loads the page with ?src=<video> and prints each measured row.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let done = false;
const finish = (code, msg) => { if (done) return; done = true; process.stdout.write(msg + '\n', () => process.exit(code)); };
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  const video = process.argv[2];
  if (!video) return finish(1, 'usage: electron speed-host.cjs <video>');
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false, webSecurity: false } });
  win.showInactive();
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.startsWith('__ROW__')) process.stdout.write(m.slice(7) + '\n');
    else if (m.startsWith('__RESULT__')) finish(JSON.parse(m.slice(10)).ok ? 0 : 1, m.slice(10).includes('"ok":false') ? 'FAILED ' + m : 'done');
  });
  win.webContents.on('render-process-gone', (_e, d) => finish(1, 'RENDERER GONE ' + JSON.stringify(d)));
  win.loadFile(path.join(__dirname, 'speed.html'), { query: { src: pathToFileURL(video).href, speeds: process.env.SPEEDS || '' } }).catch((e) => finish(1, 'load failed ' + e));
  setTimeout(() => finish(1, 'TIMEOUT'), 120000);
});
