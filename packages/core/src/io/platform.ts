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
  notify(title: string, body: string): void;

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
}

/** The top-level menus a host may expose through `PlatformBridge.popupMenu`. */
export type WindowMenuId = 'file' | 'edit' | 'view' | 'help';

/** What `PlatformBridge.windowAction` accepts. */
export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';
