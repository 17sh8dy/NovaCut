/**
 * Electron main process. Creates the editor window, registers a custom `opencut://`
 * protocol for streaming local media under a strict CSP, and wires up all IPC handlers.
 */

import { app, BrowserWindow, protocol, net } from 'electron';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHandlers } from './handlers.js';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/**
 * Serve a local media file over the custom protocol.
 *
 * We let Electron's `net.fetch` do the actual file streaming (it handles Range requests
 * so <video> can seek, and its ReadableStream is one Electron's Response accepts), then
 * re-wrap the response to inject `Access-Control-Allow-Origin`. That CORS header is what
 * keeps the decoded frames un-tainted so they can be uploaded to a WebGL texture and so
 * Web Audio's MediaElementSource produces sound — without it, video is black and audio
 * is silent even though the file loads.
 */
async function serveMedia(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const encoded = url.pathname.replace(/^\/+/, '') || url.hostname;
  const filePath = decodeURIComponent(encoded);
  try {
    // Forward only Range (so <video> seeking works); other renderer headers can upset
    // a file:// fetch.
    const range = request.headers.get('Range');
    const upstream = await net.fetch(
      pathToFileURL(filePath).toString(),
      range ? { headers: { Range: range } } : {},
    );
    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    }
    console.log(
      `[oc:serve] status=${upstream.status} type=${headers.get('Content-Type')} range=${request.headers.get('Range') ?? 'none'} path=${filePath}`,
    );
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (err) {
    console.error('[opencut] media serve failed:', filePath, err);
    return new Response(String(err), { status: 404 });
  }
}

// The renderer references media as opencut://media/<encoded-abs-path>. Declaring the scheme
// as privileged lets <video>/<img> stream it and support range requests (seeking).
protocol.registerSchemesAsPrivileged([
  { scheme: 'opencut', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0a0b0e',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // electron-vite emits the preload as .mjs for this ESM package. Referencing .js
      // silently fails to load it, leaving window.opencut undefined in the renderer.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node built-ins for the bridge
    },
  });

  win.once('ready-to-show', () => win.show());

  // DEBUG: forward the renderer's `[oc:*]` pipeline traces to the terminal so they show up
  // in the dev server output. Handles both the legacy positional signature and the newer
  // single-details object.
  win.webContents.on('console-message', (...a: unknown[]) => {
    const first = a[0] as { message?: string } | undefined;
    const msg = typeof a[2] === 'string' ? a[2] : typeof first?.message === 'string' ? first.message : '';
    if (msg.startsWith('[oc:')) console.log(msg);
  });

  // electron-vite exposes the dev server URL here; production loads the built file.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  // Allow opening DevTools in any build for diagnostics (Ctrl+Shift+I / F12).
  win.webContents.on('before-input-event', (_e, input) => {
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  // Serve local media (opencut://media/<encoded abs path>) with CORS + Range support.
  protocol.handle('opencut', serveMedia);

  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
