/**
 * PlatformBridge — the single seam between the platform-agnostic app and the host.
 *
 * The desktop app implements this over Electron IPC; a future web app implements it over
 * the File System Access API + ffmpeg.wasm; mobile over native modules. The UI only ever
 * sees this interface, so porting is "implement the bridge," not "rewrite the app."
 */

import type { Project } from '../model/types.js';
import type { ExportJob } from '../export/presets.js';

/**
 * A sink for composited RGBA frames. The shared OfflineExporter renders frames and pushes
 * them here; each platform implements the actual encode (native ffmpeg / ffmpeg.wasm /
 * native encoder). This is the seam that keeps frame *production* shared and frame
 * *encoding* platform-specific.
 */
export interface FrameEncoder {
  readonly width: number;
  readonly height: number;
  /** Write one RGBA frame (length = width*height*4). Resolves when the sink drains. */
  writeFrame(rgba: Uint8Array): Promise<void>;
  /** Flush and finalize the output file. */
  finish(): Promise<void>;
  /** Abort and clean up a partial file. */
  abort(): Promise<void>;
}

export interface ImportedFile {
  /** Resolvable source (absolute path on desktop, handle key on web). */
  src: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * What an editor is willing to import.
 *
 * The two workspaces want genuinely different things — the video editor takes footage and
 * audio, the photo editor takes stills — and the file picker should say so rather than
 * offering everything and rejecting half of it afterwards. Filtering at the DIALOG is the
 * difference between "these are your options" and "wrong, try again".
 */
export type ImportKind = 'video' | 'audio' | 'image';

/**
 * Is this file a still (or an animated GIF)?
 *
 * Lives here, next to the import contract, because it is the rule that DECIDES A WORKSPACE:
 * Home routes a chosen file to the Photo Editor or the Video Editor on this answer alone, and
 * the Media Library uses the same test to refuse stills. Two copies of it drifting apart would
 * mean a file the launcher sends to the timeline that the timeline then rejects.
 *
 * Extension as well as MIME: a drag-and-drop never goes near a picker, and hosts report an empty
 * or wrong `type` often enough that trusting it alone loses real files.
 *
 * GIFs count as stills even though they move — they are the Photo Editor's territory, and a GIF
 * on a video timeline decodes as a single frame through the <img> path anyway.
 */
export function isStillFile(mime: string, name: string): boolean {
  const lower = name.toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?|gif|avif|heic)$/.test(lower);
}

export interface RecentProject {
  path: string;
  name: string;
  modifiedAt: number;
}

export interface PlatformBridge {
  readonly platform: 'desktop' | 'web' | 'mobile';

  // ── Project persistence ──
  openProjectDialog(): Promise<{ path: string; project: Project } | null>;
  saveProject(project: Project, path?: string): Promise<{ path: string } | null>;
  loadProject(path: string): Promise<Project>;
  recentProjects(): Promise<RecentProject[]>;

  // ── Media import ──
  /**
   * Open the host's file picker. `kinds` narrows the filter; omitted means everything.
   *
   * Optional so existing callers keep working, and so a host that cannot filter (a web
   * implementation behind a plain `<input type=file>`) may ignore it — callers must still
   * validate what comes back, because a user can always type a filename past any filter.
   */
  importDialog(kinds?: readonly ImportKind[]): Promise<ImportedFile[]>;
  /** Probe a media file for duration/dimensions/fps/audio. */
  probeMedia(src: string): Promise<{
    duration: number; // seconds
    width: number;
    height: number;
    fps?: number;
    hasAudio: boolean;
  }>;
  /** Generate (and cache) a thumbnail; returns a URL/data-URL usable in <img>. */
  generateThumbnail(src: string, atSeconds?: number): Promise<string>;
  /** Resolve a stored src into something the renderer can load (may add a protocol). */
  resolveMediaUrl(src: string): string;
  /**
   * Resolve a drag-and-dropped browser File to a durable source the app can re-open and
   * probe (an absolute path on desktop). Returns null when only an in-memory handle is
   * available (e.g. web), in which case the caller falls back to an object URL.
   */
  resolveDroppedFile(file: File): string | null;

  // ── Export ──
  chooseExportPath(defaultName: string): Promise<string | null>;
  /**
   * Open an encoder that writes to the job's output path with its settings. The caller
   * (OfflineExporter) pushes composited frames and calls finish(). Frame production is
   * shared; only the encoder is platform-specific.
   *
   * `source` describes the raw frames the compositor produces (the sequence resolution); the
   * encoder scales them to the job's export resolution. `audioWav` is an optional pre-rendered
   * audio mix (16-bit WAV) to mux into the output.
   */
  createEncoder(
    job: ExportJob,
    source: { width: number; height: number; audioWav?: ArrayBuffer | null },
  ): Promise<FrameEncoder>;

  // ── Misc host services ──
  /**
   * Ask about unsaved work before an action that throws it away, and say what to do.
   *
   * The window's close handler has guarded this since the shell was built, but it guards
   * exactly one exit. New Project, Open Project and picking a recent replace the open project
   * just as completely, from six call sites, with no prompt at all — so an edit could be lost
   * to Ctrl+N with nothing to undo it and no recovery offer, because a deliberate New is a
   * clean shutdown and crash recovery never runs.
   *
   * Three answers, not two, and the same three the close guard offers: 'save' means write
   * first and proceed only if that succeeded, which is the answer people actually want and
   * which a plain confirm() cannot express. Callers must treat 'cancel' — and a failed save —
   * as "do not proceed".
   *
   * Optional: a host with no native dialogs omits it and the caller falls back to a confirm().
   * Never called when there is nothing unsaved.
   */
  confirmDiscard?(projectName: string): Promise<'save' | 'discard' | 'cancel'>;
  notify(title: string, body: string): void;
  /**
   * Show a file in the host's file manager, selected, in whatever folder it actually landed in.
   *
   * Deliberately takes the FILE and not a directory. The export dialog defaults to the export
   * folder from Settings but the user can save anywhere, and opening the configured folder when
   * the file is somewhere else would point them at the wrong place with total confidence.
   * Revealing the file is right in both cases and needs no preference to stay right.
   *
   * A no-op on hosts with no file manager, which is why it returns nothing and cannot fail.
   */
  revealFile(path: string): void;

  // ── Window chrome (desktop only) ──
  /**
   * Pop the host's native application menu at a point in the window.
   *
   * Optional, and absent everywhere but the desktop shell: the desktop window is frameless so
   * that the app can draw its own title bar, and a frameless window gets no native menu bar —
   * so the in-app File/Edit/View/Help buttons have to ask the host to open the real menu. A host
   * without one simply doesn't implement this, and the UI hides the buttons.
   */
  popupMenu?(id: WindowMenuId, x: number, y: number): void;
  /** Open a URL in the user's browser, rather than navigating the app away from itself. */
  openExternal?(url: string): void;
  /**
   * Minimise / maximise / close the host window.
   *
   * Present only where the app draws its own title bar — which on the desktop it must, since the
   * native one is hidden so the workspace can start at the very top of the window. A host that
   * leaves its own chrome in place omits this, and the UI draws no buttons.
   */
  windowAction?(action: WindowAction): void;
  /** Subscribe to host window state, so a maximise button can show the right icon. */
  onWindowState?(handler: (state: { maximized: boolean }) => void): () => void;

  // ── Settings support (desktop only) ──
  /** Pick a directory, for the "default project / export folder" settings. */
  chooseDirectory?(): Promise<string | null>;
  /** Versions, GPU and paths, for About and the Performance/Privacy panes. */
  systemInfo?(): Promise<SystemInfo>;
  /** Real on-disk byte totals for the Storage pane. Measured, never estimated. */
  storageUsage?(projectDir: string): Promise<StorageUsage>;
  /** Delete regenerable caches. Resolves with the number of bytes freed. */
  clearCache?(): Promise<number>;
  /** Forget the recent-projects list without touching the files themselves. */
  clearRecentProjects?(): Promise<void>;
  /** Reveal the app's data directory in the OS file browser. */
  openDataFolder?(): Promise<void>;
  /** Start Open Cut when the user signs in. */
  setLaunchOnStartup?(enabled: boolean): Promise<void>;
  /** Zoom the whole window, for the interface-scale setting. */
  setZoomFactor?(factor: number): void;
  /** Mirror the preferences the host acts on (folders, recents cap, encoder threads, GPU). */
  setHostPrefs?(prefs: HostPrefs): void;
}

export interface HostPrefs {
  maxRecentProjects: number;
  defaultProjectDir: string;
  exportDir: string;
  cpuThreads: number;
  gpuAcceleration: boolean;
  /**
   * Appearance. The host needs it only to choose the window's background colour, which is
   * painted before the renderer has drawn anything — so it must be known one launch ahead of the
   * renderer that owns the preference.
   */
  theme: 'system' | 'light' | 'dark';
}

export interface SystemInfo {
  appVersion: string;
  platform: string;
  electron: string;
  chrome: string;
  node: string;
  /** Renderer/adapter description, or '' when it can't be determined. */
  gpu: string;
  /** ffmpeg's reported version, or '' when it isn't installed. */
  ffmpeg: string;
  dataDir: string;
}

export interface StorageUsage {
  dataDir: string;
  buckets: {
    cache: number;
    projects: number;
    autosaves: number;
    logs: number;
  };
}

/** The top-level menus a host may expose through `PlatformBridge.popupMenu`. */
export type WindowMenuId = 'file' | 'edit' | 'view' | 'help';

/** What `PlatformBridge.windowAction` accepts. */
export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';
