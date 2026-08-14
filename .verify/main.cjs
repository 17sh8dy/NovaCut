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
  /*
   * Optional viewport size: `electron main.cjs page.html 1400 900`.
   *
   * It defaults to the original 400x300 so existing harnesses are untouched, but a harness that
   * hit-tests the page (elementFromPoint, which is viewport-clipped and returns null outside it)
   * needs a window big enough to contain the layout it is aiming at.
   */
  const win = new BrowserWindow({
    show: false,
    width: Number(process.argv[3]) || 400,
    height: Number(process.argv[4]) || 300,
    /*
     * `backgroundThrottling: false` for the same reason the real app sets it: a hidden or
     * occluded window otherwise has its timers and requestAnimationFrame throttled to a crawl or
     * suspended outright. The host runs headless (`show: false`), so any code that schedules work
     * on a frame — the timeline's drag coalescing, the playback clock — would simply never run,
     * and the harness would report "nothing moved" as a product bug rather than a host artefact.
     */
    webPreferences: { offscreen: false, backgroundThrottling: false },
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

  /*
   * A window that is never shown is never composited, and Chromium stops servicing
   * requestAnimationFrame for it — measured here at roughly 7fps before stalling entirely.
   * Any harness driving frame-scheduled UI would hang waiting for a frame that never comes.
   * `showInactive` composites at full rate WITHOUT taking focus, so a test run cannot steal
   * the keyboard from whatever the user is doing. Only harnesses that ask for a viewport size
   * get a window; the rest stay fully headless as before.
   */
  if (process.argv[3]) win.showInactive();

  win
    .loadFile(path.join(__dirname, process.argv[2] || 'run.html'))
    .catch((e) => finish(1, '[host] loadFile threw: ' + e));

  setTimeout(() => finish(1, '[host] TIMEOUT — no result within 90s'), 90000);
});
