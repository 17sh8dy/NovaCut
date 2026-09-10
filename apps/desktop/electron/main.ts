/**
 * Electron main process. Creates the editor window, registers a custom `novacut://`
 * protocol for streaming local media under a strict CSP, and wires up all IPC handlers.
 *
 * Beyond that, this file is where "a web page in a frame" becomes an application: one instance
 * at a time, a window that remembers where it was, a menu, a guard against quitting on unsaved
 * work, .novacut files that open by double-click, and links that leave for the real browser
 * instead of hijacking the editor.
 */

import { app, BrowserWindow, dialog, nativeTheme, protocol, shell } from 'electron';
import { join, extname, resolve as resolvePath } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { registerHandlers, disposeHandlers } from './handlers.js';
import { buildMenu } from './menu.js';
import { loadWindowState, trackWindowState } from './window-state.js';
import { readStartupPrefs } from './settings-host.js';
import { CH } from './ipc-types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** Renderer console forwarding is a debugging aid, not a feature: opt in with OPENCUT_TRACE=1. */
const TRACE = process.env['OPENCUT_TRACE'] === '1' || !app.isPackaged;

/**
 * The window icon used when running from source. __dirname is out/main at runtime, so this
 * climbs back to apps/desktop/build — the directory electron-builder.yml already points every
 * platform's `icon:` key at, rather than a second copy that could drift out of sync with it.
 */
const DEV_ICON = join(__dirname, '../../build/icon.ico');

/**
 * Serve a local media file over the custom protocol, **with real HTTP Range support**.
 *
 * This is what makes seeking work, and it has to be done by hand. Electron's `net.fetch`
 * silently IGNORES a Range header on a `file://` URL: it answers `200` with the whole body.
 * Chromium reads a `200` reply to a ranged request as "this server cannot do ranges" and
 * permanently downgrades the element to a non-seekable stream — every `video.currentTime = t`
 * then snaps back to 0. The symptom is not an error anywhere; it is a preview frozen on the
 * first frame while the timecode happily advances, and audio that never leaves 0:00.
 *
 * So we read the file ourselves and answer `206 Partial Content` with a correct
 * `Content-Range`. `Accept-Ranges: bytes` on the full response is what tells the element it
 * may seek at all. `Access-Control-Allow-Origin` keeps decoded frames un-tainted so they can
 * be uploaded to a WebGL texture and so Web Audio's MediaElementSource produces sound.
 */
async function serveMedia(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const encoded = url.pathname.replace(/^\/+/, '') || url.hostname;
  const filePath = decodeURIComponent(encoded);
  try {
    const size = (await stat(filePath)).size;
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const headers = new Headers({
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      // Must be present on the 200 too — it is the advertisement that seeking is possible.
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    // `bytes=START-[END]`. Only the single-range form matters here; multipart ranges are
    // not something a media element asks for.
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    let status = 200;
    let start = 0;
    let end = size - 1;

    if (match) {
      const [, rawStart, rawEnd] = match;
      if (rawStart === '') {
        // Suffix form `bytes=-N`: the LAST n bytes. MP4 files with the moov atom at the end
        // are opened exactly this way, so getting it wrong breaks those files specifically.
        const n = Number(rawEnd);
        if (!Number.isFinite(n) || n <= 0) return rangeNotSatisfiable(size, headers);
        start = Math.max(0, size - n);
      } else {
        start = Number(rawStart);
        if (rawEnd !== '') end = Math.min(Number(rawEnd), size - 1);
      }
      if (!Number.isFinite(start) || start >= size || start > end) return rangeNotSatisfiable(size, headers);
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }

    headers.set('Content-Length', String(end - start + 1));

    if (TRACE) {
      // Scrubbing fires a range request per seek; this is a firehose, hence the trace gate.
      console.log(`[oc:serve] status=${status} type=${type} range=${request.headers.get('Range') ?? 'none'} bytes=${start}-${end}/${size} path=${filePath}`);
    }

    // A HEAD probe wants the headers only — streaming a body for it wastes the read.
    if (request.method === 'HEAD') return new Response(null, { status, headers });

    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end }),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status, headers });
  } catch (err) {
    console.error('[opencut] media serve failed:', filePath, err);
    return new Response(String(err), { status: 404 });
  }
}

/** 416 must carry the real size so the element can re-ask for a valid range. */
function rangeNotSatisfiable(size: number, headers: Headers): Response {
  headers.set('Content-Range', `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

// The renderer references media as novacut://media/<encoded-abs-path>. Declaring the scheme
// as privileged lets <video>/<img> stream it and support range requests (seeking).
protocol.registerSchemesAsPrivileged([
  { scheme: 'novacut', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

// ── Single instance ──────────────────────────────────────────────────────────
// Two copies of an editor over one project is a data-loss bug waiting to happen (last writer
// wins, silently). A second launch focuses the running window and hands it the file instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/** The .novacut file a launch was asked to open, if any (double-click / "Open with"). */
function projectFromArgv(argv: string[]): string | null {
  // argv[0] is the executable; in dev, argv[1] is the app directory. Scan for the extension
  // rather than a fixed index, which is what makes this work in both.
  const hit = argv.slice(1).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.novacut'));
  return hit ? resolvePath(hit) : null;
}

/** A project path captured before the window existed, replayed once the renderer is ready. */
let pendingOpen: string | null = null;
let mainWindow: BrowserWindow | null = null;

function openProjectInWindow(path: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingOpen = path;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send(CH.openProjectPath, path);
}

app.on('second-instance', (_e, argv) => {
  const path = projectFromArgv(argv);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  if (path) openProjectInWindow(path);
});

// macOS delivers "Open with" through an event rather than argv, and can fire it before ready.
app.on('open-file', (event, path) => {
  event.preventDefault();
  openProjectInWindow(path);
});

// ── Quit guard ───────────────────────────────────────────────────────────────
/**
 * Mirrors the renderer's dirty flag. Kept in main because the confirmation has to happen inside
 * the window's `close` event — an async round-trip to ask the renderer would return long after
 * the window was gone.
 */
let unsaved = { dirty: false, name: 'Untitled Project' };
/** Set once the user has answered the guard, so the follow-up close isn't intercepted again. */
let allowClose = false;

/**
 * The window's pre-render background — the colour on screen between the frame appearing and the
 * renderer's first paint. It must match the theme the renderer is ABOUT to draw, or every launch
 * opens with a flash of the opposite one.
 *
 * The preference lives in the renderer's localStorage, which main cannot read, so it arrives via
 * startup-prefs.json one launch late — the same mechanism, and the same reason, as the GPU flag.
 * 'system' is resolved against Electron's own nativeTheme, which is live and needs no file.
 *
 * The two literals are --surface-0 from tokens.css. They are duplicated here because main has no
 * access to the stylesheet; if those surfaces change, change them here too.
 */
function windowBackground(): string {
  const { theme } = readStartupPrefs();
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
  return dark ? '#0f1115' : '#ffffff';
}

function createWindow(): void {
  const state = loadWindowState();
  const win = new BrowserWindow({
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width ?? 1560,
    height: state.height ?? 960,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: windowBackground(),
    show: false,
    /*
     * A packaged Windows/macOS build takes its taskbar and dock icon from the executable itself,
     * which electron-builder stamps from build/icon.ico / .icns. Nothing does that in dev, so
     * without this the running app wears Electron's default atom — the one icon guaranteed not to
     * be ours. Point it at the same committed .ico the installer uses, so what we look at all day
     * is what ships. `icon` is ignored where it is not needed, and a missing file would throw, so
     * the path is only passed when it actually resolves.
     */
    ...(existsSync(DEV_ICON) ? { icon: DEV_ICON } : {}),
    /*
     * The app draws its own title bar, so the native one is hidden. On macOS the traffic lights
     * are simply inset over it; on Windows and Linux the app draws its own minimise / maximise /
     * close buttons (see the UI's WindowControls) and drives them over IPC.
     *
     * `titleBarOverlay` — the API that would let the OS paint real controls onto our bar — is
     * deliberately NOT used: with it set, in either its boolean or object form, `ready-to-show`
     * never fires on this Electron/Windows build and the window is created but never displayed.
     * A blank launch is a far worse bug than hand-drawn buttons, so the buttons are hand-drawn.
     */
    titleBarStyle: 'hidden',
    webPreferences: {
      // electron-vite emits the preload as .mjs for this ESM package. Referencing .js
      // silently fails to load it, leaving window.opencut undefined in the renderer.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node built-ins for the bridge
      // A background throttle would stall the export loop and the playback clock the moment the
      // window lost focus, which for a render that takes minutes is not a tradeoff worth making.
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  trackWindowState(win);
  if (state.maximized) win.maximize();

  /*
   * Show once, from whichever signal arrives first.
   *
   * `ready-to-show` is the right event — it fires after the first paint, so there is no white
   * flash — but it is not guaranteed: some window configurations never emit it, and when that
   * happens a `show: false` window stays invisible forever with the renderer running behind it.
   * `did-finish-load` is the backstop. An app that fails to appear is unrecoverable for a user,
   * so this one path gets a belt and braces.
   */
  let shown = false;
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    if (pendingOpen) {
      win.webContents.send(CH.openProjectPath, pendingOpen);
      pendingOpen = null;
    }
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);

  // Keep the renderer's maximise/restore button in sync with the real window state — including
  // when the change came from a double-click on the drag region or a Windows snap gesture.
  const pushWindowState = (): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.windowState, { maximized: win.isMaximized() });
  };
  win.on('maximize', pushWindowState);
  win.on('unmaximize', pushWindowState);
  win.webContents.on('did-finish-load', pushWindowState);

  // Renderer `[oc:*]` pipeline traces, forwarded to the terminal for debugging. Handles both
  // the legacy positional signature and the newer single-details object.
  if (TRACE) {
    win.webContents.on('console-message', (...a: unknown[]) => {
      const first = a[0] as { message?: string } | undefined;
      const msg = typeof a[2] === 'string' ? a[2] : typeof first?.message === 'string' ? first.message : '';
      if (msg.startsWith('[oc:')) console.log(msg);
    });
  }

  // Nothing in this app should ever navigate the editor away or spawn a chrome-less popup;
  // both are how a single stray link turns an editor into a browser with the user's project
  // still unsaved behind it. External URLs go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return; // HMR full reloads
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  // A crashed renderer otherwise leaves a white window with no explanation and no way back.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Nova Cut stopped responding',
        message: 'The editor crashed.',
        detail: `Reason: ${details.reason}. Reloading restores the last autosaved session.`,
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
      })
      .then(({ response }) => (response === 0 ? win.reload() : app.quit()));
  });

  // Unsaved work: ask before the window goes. `allowClose` is what lets the answer through on
  // the second pass, since choosing Save/Discard re-issues the close.
  win.on('close', (event) => {
    if (allowClose || !unsaved.dirty) return;
    event.preventDefault();
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsaved changes',
      message: `Save changes to “${unsaved.name}” before closing?`,
      detail: 'Your changes will be lost if you don’t save them.',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return; // Cancel
    if (response === 1) {
      allowClose = true;
      win.close();
      return;
    }
    // Save: hand it to the renderer, which answers on `saveComplete` (see registerHandlers'
    // onSaveComplete hook). If the user cancels the save dialog the app simply stays open — the
    // right outcome, and the reason this isn't a fire-and-forget close.
    win.webContents.send(CH.menuCommand, 'saveAndClose');
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  // electron-vite exposes the dev server URL here; production loads the built file.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  /*
   * F12 for DevTools, and ONLY F12.
   *
   * Ctrl+Shift+I used to be handled here too — but the View menu's `toggleDevTools` role already
   * registers exactly that accelerator, so both fired on one press: open, then immediately shut.
   * The window looked like it was ignoring the shortcut. One binding per key, always.
   */
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

if (gotLock) {
  /*
   * GPU acceleration, decided before anything else happens.
   *
   * `disableHardwareAcceleration()` is only legal before the app is ready, which is why this
   * preference is read from a file main wrote on a previous run rather than from the renderer —
   * and why the Settings row is labelled "Restart required" instead of pretending otherwise.
   */
  if (!readStartupPrefs().gpuAcceleration) {
    app.disableHardwareAcceleration();
    console.log('[opencut] GPU acceleration disabled by preference');
  }

  // Windows uses this to group taskbar windows and to attribute notifications; without it,
  // toasts are credited to "electron.app.Electron" and the taskbar icon can detach on pin.
  app.setAppUserModelId('com.novacut.editor');

  app.whenReady().then(() => {
    // Serve local media (novacut://media/<encoded abs path>) with CORS + Range support.
    protocol.handle('novacut', serveMedia);

    // `??=`, not `=`: on macOS an "Open with" delivered through the `open-file` event can land
    // before the app is ready, and overwriting it here would drop the file the user double-clicked.
    pendingOpen ??= projectFromArgv(process.argv);
    registerHandlers({
      // The renderer is the only thing that knows whether the project has unsaved edits, and the
      // close handler above is the only thing that can act on it — this is the wire between them.
      onDirtyChanged: (dirty, name) => {
        unsaved = { dirty, name };
        mainWindow?.setDocumentEdited(dirty);
      },
      // The renderer finished (or skipped) the save the quit guard asked for.
      onSaveComplete: (saved) => {
        if (!saved) return; // save dialog cancelled — stay open
        allowClose = true;
        mainWindow?.close();
      },
    });
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Any ffmpeg child still running would otherwise outlive the app as an orphan process holding
// a half-written output file open.
app.on('before-quit', () => {
  allowClose = true;
  void disposeHandlers();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
