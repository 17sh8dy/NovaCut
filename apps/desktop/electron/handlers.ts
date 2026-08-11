/**
 * Main-process IPC handlers. Every capability the renderer needs from the OS is registered
 * here and nowhere else, so the trust boundary is easy to audit.
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  CH,
  type ExportJobDTO,
  type ImportedFileDTO,
  type MenuId,
  type RecentProjectDTO,
  type HostPrefsDTO,
  type WindowAction,
} from './ipc-types.js';
import { ffmpegThumbnail, ffprobeMedia, FfmpegEncoder, ffmpegBinary, setEncoderThreads } from './ffmpeg.js';
import { popupMenu } from './menu.js';
import {
  chooseDirectory, clearCache, openDataFolder, setLaunchOnStartup, storageUsage, systemInfo,
  writeStartupPrefs,
} from './settings-host.js';

/** Callbacks main provides so shell-level state (dirty flag, quit guard) stays in one place. */
export interface HandlerHooks {
  onDirtyChanged(dirty: boolean, projectName: string): void;
  onSaveComplete(saved: boolean): void;
}

/**
 * Extensions grouped by kind, so a caller can ask for only what it can use.
 *
 * The video editor asks for video + audio; the photo editor asks for images. Without the
 * split, the picker offers a PNG to the video editor and the editor has to refuse it after
 * the fact — which is a worse interaction than never showing it.
 */
const EXTS_BY_KIND = {
  video: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'],
  audio: ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'],
} as const;

const MEDIA_EXTS = [...EXTS_BY_KIND.video, ...EXTS_BY_KIND.audio, ...EXTS_BY_KIND.image];
/**
 * Dialog filters for the requested kinds.
 *
 * The "All Files" escape hatch is deliberately NOT offered when kinds are narrowed: it exists
 * so an unusual container can still be opened, and offering it beside a deliberate restriction
 * would just be a second door into the case the restriction is there to prevent.
 */
function buildFilters(kinds?: readonly string[]): { name: string; extensions: string[] }[] {
  if (!kinds || kinds.length === 0) {
    return [{ name: 'Media', extensions: MEDIA_EXTS }, { name: 'All Files', extensions: ['*'] }];
  }
  const wanted = kinds.filter((k): k is keyof typeof EXTS_BY_KIND => k in EXTS_BY_KIND);
  if (wanted.length === 0) return [{ name: 'Media', extensions: MEDIA_EXTS }];
  const exts = wanted.flatMap((k) => [...EXTS_BY_KIND[k]]);
  const label = wanted.length === 1
    ? { video: 'Video', audio: 'Audio', image: 'Images' }[wanted[0]!]
    : wanted.map((k) => ({ video: 'Video', audio: 'Audio', image: 'Images' }[k])).join(' & ');
  const filters = [{ name: label, extensions: exts }];
  // Sub-filters let the user narrow further inside the picker when more than one kind is on
  // offer, which is how every native picker behaves.
  if (wanted.length > 1) {
    for (const k of wanted) {
      filters.push({ name: { video: 'Video', audio: 'Audio', image: 'Images' }[k], extensions: [...EXTS_BY_KIND[k]] });
    }
  }
  return filters;
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

const encoders = new Map<string, FfmpegEncoder>();

function recentsPath(): string {
  return join(app.getPath('userData'), 'recent-projects.json');
}

async function readRecents(): Promise<RecentProjectDTO[]> {
  try {
    return JSON.parse(await readFile(recentsPath(), 'utf8')) as RecentProjectDTO[];
  } catch {
    return [];
  }
}

/**
 * Renderer-owned preferences main needs at IPC time.
 *
 * Mirrored here rather than read from localStorage, which main cannot see. Only the handful of
 * values that change main's behaviour live here — this is not a second copy of the settings.
 */
const hostPrefs = { maxRecentProjects: 12, defaultProjectDir: '', exportDir: '' };

async function pushRecent(path: string): Promise<void> {
  const list = await readRecents();
  const next = [
    { path, name: basename(path).replace(/\.opencut$/, ''), modifiedAt: Date.now() },
    ...list.filter((r) => r.path !== path),
  ].slice(0, Math.max(1, hostPrefs.maxRecentProjects));
  await writeFile(recentsPath(), JSON.stringify(next), 'utf8').catch(() => {});
}

export function registerHandlers(hooks: HandlerHooks): void {
  // ── Project persistence ──
  ipcMain.handle(CH.openProject, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open Project',
      ...(hostPrefs.defaultProjectDir ? { defaultPath: hostPrefs.defaultProjectDir } : {}),
      filters: [{ name: 'Open Cut Project', extensions: ['opencut'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const path = res.filePaths[0];
    const json = await readFile(path, 'utf8');
    await pushRecent(path);
    return { path, json };
  });

  ipcMain.handle(CH.saveProject, async (_e, json: string, path?: string, suggestedName?: string) => {
    let target = path;
    if (!target) {
      // The project's own name, so a first save offers "OpenCut Video File at 1.42 PM.opencut"
      // rather than proposing "Untitled" for every project the user has ever made.
      const file = `${suggestedName || 'Untitled'}.opencut`;
      const res = await dialog.showSaveDialog({
        title: 'Save Project',
        defaultPath: hostPrefs.defaultProjectDir ? join(hostPrefs.defaultProjectDir, file) : file,
        filters: [{ name: 'Open Cut Project', extensions: ['opencut'] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    await writeFile(target, json, 'utf8');
    await pushRecent(target);
    return { path: target };
  });

  ipcMain.handle(CH.loadProject, async (_e, path: string) => readFile(path, 'utf8'));
  ipcMain.handle(CH.recentProjects, () => readRecents());

  // ── Media import ──
  ipcMain.handle(CH.importFiles, async (_e, kinds?: readonly string[]): Promise<ImportedFileDTO[]> => {
    const res = await dialog.showOpenDialog({
      title: 'Import Media',
      filters: buildFilters(kinds),
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return [];
    const files = await Promise.all(
      res.filePaths.map(async (p) => {
        const ext = extname(p).slice(1).toLowerCase();
        const info = await stat(p).catch(() => ({ size: 0 }));
        return { src: p, name: basename(p), mime: MIME[ext] ?? 'application/octet-stream', size: info.size };
      }),
    );
    return files;
  });

  ipcMain.handle(CH.probeMedia, async (_e, src: string) => {
    try {
      return await ffprobeMedia(src);
    } catch {
      // ffprobe unavailable: return neutral defaults so import still works.
      return { duration: 0, width: 1920, height: 1080, hasAudio: true };
    }
  });

  ipcMain.handle(CH.generateThumbnail, async (_e, src: string, atSeconds: number) => {
    return ffmpegThumbnail(src, atSeconds || 0); // rejection handled by the renderer
  });

  // ── Export path + encoder session ──
  ipcMain.handle(CH.chooseExportPath, async (_e, defaultName: string) => {
    // Joined HERE rather than in the renderer, which has no business knowing the platform's path
    // separator. `defaultName` is always a bare filename.
    const defaultPath = hostPrefs.exportDir ? join(hostPrefs.exportDir, defaultName) : defaultName;
    const res = await dialog.showSaveDialog({ title: 'Export Video', defaultPath });
    return res.canceled ? null : res.filePath ?? null;
  });

  ipcMain.handle(
    CH.encoderCreate,
    async (
      _e,
      job: ExportJobDTO,
      inW: number,
      inH: number,
      outW: number,
      outH: number,
      audioWav?: ArrayBuffer | null,
    ) => {
      try {
        let audioPath: string | undefined;
        if (audioWav && audioWav.byteLength > 0) {
          audioPath = join(tmpdir(), `opencut-audio-${job.id}.wav`);
          await writeFile(audioPath, Buffer.from(audioWav));
        }
        encoders.set(job.id, new FfmpegEncoder(job, inW, inH, outW, outH, audioPath));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(CH.encoderWrite, async (_e, jobId: string, frame: ArrayBuffer) => {
    const enc = encoders.get(jobId);
    if (!enc) throw new Error('no such encoder');
    await enc.writeFrame(Buffer.from(frame));
  });

  ipcMain.handle(CH.encoderFinish, async (_e, jobId: string) => {
    const enc = encoders.get(jobId);
    if (!enc) throw new Error('no such encoder');
    try {
      await enc.finish();
    } finally {
      encoders.delete(jobId);
    }
  });

  ipcMain.handle(CH.encoderAbort, async (_e, jobId: string) => {
    const enc = encoders.get(jobId);
    if (enc) {
      await enc.abort();
      encoders.delete(jobId);
    }
  });

  // ── Misc ──
  ipcMain.on(CH.notify, (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });

  /*
   * Reveal a finished export in Explorer (Finder, Nautilus), with the file selected.
   *
   * Guarded by an existence check because showItemInFolder on a path that is not there opens a
   * window on nothing at all on Windows — a worse outcome than doing nothing, since it looks
   * like the export went somewhere unexpected. It also keeps a cancelled or failed export, which
   * never calls this, from being able to surprise anyone if that ever changes.
   */
  ipcMain.on(CH.revealFile, (_e, filePath: string) => {
    if (typeof filePath === 'string' && filePath && existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });

  // ── Shell integration ──
  ipcMain.on(CH.setDirty, (_e, dirty: boolean, projectName: string) => hooks.onDirtyChanged(dirty, projectName));
  ipcMain.on(CH.saveComplete, (_e, saved: boolean) => hooks.onSaveComplete(saved));

  ipcMain.on(CH.popupMenu, (e, id: MenuId, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) popupMenu(win, id, x, y);
  });

  // Only ever hand the OS an http(s) URL. `shell.openExternal` will happily run a `file:` path
  // or, on Windows, a registered protocol handler — so an unfiltered call is a way for anything
  // that can reach the renderer to launch a program.
  ipcMain.on(CH.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // ── Settings ──
  ipcMain.on(CH.hostPrefs, (_e, next: HostPrefsDTO) => {
    Object.assign(hostPrefs, next);
    setEncoderThreads(next.cpuThreads ?? 0);
    // Persisted for the NEXT launch: neither hardware acceleration nor the window's background
    // colour can be changed on a running window.
    writeStartupPrefs({
      gpuAcceleration: next.gpuAcceleration !== false,
      theme: next.theme ?? 'system',
    });
  });
  ipcMain.handle(CH.chooseDirectory, (e) => chooseDirectory(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle(CH.systemInfo, () => systemInfo(ffmpegBinary()));
  ipcMain.handle(CH.storageUsage, (_e, projectDir: string) => storageUsage(projectDir ?? ''));
  ipcMain.handle(CH.clearCache, () => clearCache());
  ipcMain.handle(CH.openDataFolder, () => openDataFolder());
  ipcMain.handle(CH.setLaunchOnStartup, (_e, enabled: boolean) => setLaunchOnStartup(!!enabled));
  ipcMain.handle(CH.clearRecentProjects, async () => {
    await writeFile(recentsPath(), '[]', 'utf8').catch(() => {});
  });
  ipcMain.on(CH.setZoomFactor, (e, factor: number) => {
    // Clamped in main, not just in the slider: a bad value here makes the window unusable and
    // the only way back is a settings file the user can't reach from inside the app.
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.webContents.setZoomFactor(Math.min(2, Math.max(0.5, factor)));
  });

  ipcMain.on(CH.windowAction, (e, action: WindowAction) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    // `close`, not `destroy`: the unsaved-changes guard lives on the close event, and a button
    // that bypassed it would be the one path in the app that can silently discard work.
    else if (action === 'close') win.close();
    else if (action === 'toggleMaximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  });
}

/**
 * Shut down anything that outlives the window.
 *
 * Only ffmpeg matters: a child process holding a half-written output file keeps running after
 * the app is gone, so the user is left with an orphan encoder and a corrupt export.
 */
export async function disposeHandlers(): Promise<void> {
  const running = [...encoders.values()];
  encoders.clear();
  await Promise.all(running.map((e) => e.abort().catch(() => {})));
}
