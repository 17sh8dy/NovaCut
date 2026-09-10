/**
 * Host services the Settings window needs: real numbers and real side effects.
 *
 * The Storage pane is the reason this file is careful. A storage report that estimates is worse
 * than none at all — the figure it shows is the one a user acts on ("I'll clear that 14 GB"), so
 * every byte here comes from walking the actual directories. Where a total can't be measured the
 * answer is 0 and the pane says so, rather than a plausible-looking guess.
 */

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { readdir, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { StorageUsageDTO, SystemInfoDTO } from './ipc-types.js';

/**
 * Chromium's own caches, which `session.clearCache()` owns and can regenerate.
 *
 * There is deliberately no "generated thumbnails" bucket. Thumbnails are ffmpeg-produced data
 * URLs held inside the MediaAsset, so they are serialised into the .novacut file and into the
 * recovery snapshots — they have no separate home on disk. A thumbnails row would either read
 * zero forever or double-count bytes already reported under Projects and Autosaves.
 */
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage'];

/**
 * Total bytes under a directory.
 *
 * Errors are swallowed per-entry rather than per-call: a cache directory is being written to
 * while we walk it, so a file vanishing mid-scan is normal and must not zero the whole bucket.
 */
async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0; // absent directory is a legitimate zero
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await stat(full)).size;
    } catch {
      /* raced with a writer or a permission wall — skip this entry, keep the total */
    }
  }
  return total;
}

async function sumDirs(root: string, names: string[]): Promise<number> {
  const sizes = await Promise.all(names.map((n) => dirSize(join(root, n))));
  return sizes.reduce((a, b) => a + b, 0);
}

/** Bytes of `.novacut` files in a directory (non-recursive — projects aren't nested). */
async function projectsSize(dir: string): Promise<number> {
  if (!dir) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.novacut')) continue;
    try {
      total += (await stat(join(dir, e.name))).size;
    } catch { /* skip */ }
  }
  return total;
}

/** ffmpeg's version line, or '' when it isn't installed. Never rejects. */
function ffmpegVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(bin, ['-version'], { windowsHide: true });
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', () => finish(''));
      child.on('close', () => finish((out.split('\n')[0] ?? '').replace('ffmpeg version ', '').trim()));
      // A hung probe must not hold the Settings window open forever.
      setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(''); }, 4000);
    } catch {
      finish('');
    }
  });
}

let cachedGpu: string | null = null;
async function gpuDescription(): Promise<string> {
  if (cachedGpu !== null) return cachedGpu;
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number; deviceId?: number; deviceString?: string }[] };
    const device = info.gpuDevice?.find((d) => d.deviceString) ?? info.gpuDevice?.[0];
    cachedGpu = device?.deviceString || (device ? `Vendor 0x${(device.vendorId ?? 0).toString(16)}` : '');
  } catch {
    cachedGpu = '';
  }
  return cachedGpu;
}

export async function systemInfo(ffmpegBin: string): Promise<SystemInfoDTO> {
  const [gpu, ffmpeg] = await Promise.all([gpuDescription(), ffmpegVersion(ffmpegBin)]);
  return {
    appVersion: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    gpu,
    ffmpeg,
    dataDir: app.getPath('userData'),
  };
}

export async function storageUsage(projectDir: string): Promise<StorageUsageDTO> {
  const root = app.getPath('userData');
  // Loose files at the root: preferences, recent-projects.json, window-state.json.
  const looseFiles = async (): Promise<number> => {
    let total = 0;
    try {
      for (const e of await readdir(root, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        try { total += (await stat(join(root, e.name))).size; } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return total;
  };
  const [cache, projects, autosaves, logDirs, loose] = await Promise.all([
    sumDirs(root, CACHE_DIRS),
    projectsSize(projectDir || app.getPath('documents')),
    // Recovery snapshots are written to localStorage, which Chromium keeps here.
    sumDirs(root, ['Local Storage', 'Session Storage']),
    sumDirs(root, ['logs']),
    looseFiles(),
  ]);
  return { dataDir: root, buckets: { cache, projects, autosaves, logs: logDirs + loose } };
}

/** Clear regenerable caches. Returns bytes freed, measured before and after. */
export async function clearCache(): Promise<number> {
  const root = app.getPath('userData');
  const before = await sumDirs(root, CACHE_DIRS);
  await session.defaultSession.clearCache().catch(() => {});
  await session.defaultSession.clearCodeCaches({ urls: [] }).catch(() => {});
  const after = await sumDirs(root, CACHE_DIRS);
  return Math.max(0, before - after);
}

export async function chooseDirectory(win: BrowserWindow | null): Promise<string | null> {
  const opts = { title: 'Choose folder', properties: ['openDirectory', 'createDirectory'] as const };
  const res = win
    ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
    : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] });
  return res.canceled ? null : res.filePaths[0] ?? null;
}

export async function openDataFolder(): Promise<void> {
  await shell.openPath(app.getPath('userData'));
}

/**
 * The handful of preferences main must know BEFORE `app.whenReady()`.
 *
 * GPU acceleration is the whole reason this file exists: `app.disableHardwareAcceleration()` has
 * to be called before the app is ready, which is long before a renderer exists to tell us
 * anything. localStorage is not readable from main, so the renderer mirrors the value here and
 * main reads the file on the next launch — which is exactly why the setting is labelled
 * "Restart required" rather than pretending to take effect immediately.
 */
const STARTUP_FILE = 'startup-prefs.json';

export interface StartupPrefs {
  gpuAcceleration: boolean;
  /** Appearance, for the window's pre-render background colour. */
  theme: 'system' | 'light' | 'dark';
}

export function readStartupPrefs(): StartupPrefs {
  try {
    const raw = readFileSync(join(app.getPath('userData'), STARTUP_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StartupPrefs>;
    // Default ON: a corrupt or partial file must never leave someone stuck in software rendering
    // with no way back other than editing JSON they do not know exists.
    const theme = parsed.theme;
    return {
      gpuAcceleration: parsed.gpuAcceleration !== false,
      theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    };
  } catch {
    return { gpuAcceleration: true, theme: 'system' };
  }
}

export function writeStartupPrefs(prefs: StartupPrefs): void {
  try {
    writeFileSync(join(app.getPath('userData'), STARTUP_FILE), JSON.stringify(prefs), 'utf8');
  } catch {
    /* best-effort: losing this only means the next launch uses the previous value */
  }
}

/**
 * Launch-on-sign-in.
 *
 * `openAtLogin` alone is wrong for a packaged Windows build: without `path`, Electron registers
 * whatever executable is running, which in development is `electron.exe` from node_modules —
 * pointing the user's startup entry at a binary that will not exist tomorrow.
 */
export function setLaunchOnStartup(enabled: boolean): void {
  if (!app.isPackaged) return; // never register a dev binary
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [] });
}
