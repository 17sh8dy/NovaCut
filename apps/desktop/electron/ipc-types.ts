/**
 * The IPC contract shared by the preload bridge (renderer side) and the main process
 * (Node side). Keeping it in one typed module means the renderer's PlatformBridge and the
 * main handlers can never silently drift apart.
 */

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps?: number;
  hasAudio: boolean;
}

export interface ImportedFileDTO {
  src: string;
  name: string;
  mime: string;
  size: number;
}

export interface RecentProjectDTO {
  path: string;
  name: string;
  modifiedAt: number;
}

export interface ExportJobDTO {
  id: string;
  filename: string;
  outputPath: string;
  settings: {
    resolution: string;
    fps: number;
    quality: string;
    container: string;
    videoCodec: string;
    bitrateMbps?: number;
    audioBitrateKbps: number;
    audioSampleRate: number;
    hardwareAcceleration: boolean;
  };
}

/**
 * Commands the application menu can send to the renderer.
 *
 * `saveAndClose` is the odd one out: it is not a user-visible command but the second half of the
 * unsaved-changes quit guard — main asks the renderer to save, the renderer answers with
 * `saveComplete`, and only then does the window close.
 */
export type MenuCommand =
  | 'new' | 'open' | 'save' | 'saveAs' | 'saveAndClose'
  | 'import' | 'export' | 'projectSettings' | 'preferences'
  | 'undo' | 'redo' | 'split' | 'duplicate' | 'delete'
  | 'home' | 'editor' | 'photo' | 'shortcuts';

/** Which top-level menu an in-app menu-bar button should pop open. */
export type MenuId = 'file' | 'edit' | 'view' | 'help';

/** The object exposed on `window.opencut` by the preload script. */
export interface OpenCutApi {
  platform: 'desktop';
  /** `process.platform`, so the UI can inset for macOS traffic lights. */
  os: NodeJS.Platform;
  openProject(): Promise<{ path: string; json: string } | null>;
  saveProject(json: string, path?: string): Promise<{ path: string } | null>;
  loadProject(path: string): Promise<string>;
  recentProjects(): Promise<RecentProjectDTO[]>;
  importFiles(kinds?: readonly string[]): Promise<ImportedFileDTO[]>;
  probeMedia(src: string): Promise<ProbeResult>;
  generateThumbnail(src: string, atSeconds: number): Promise<string>;
  mediaUrl(src: string): string;
  getPathForFile(file: File): string | null;
  chooseExportPath(defaultName: string): Promise<string | null>;
  // Encoder session: spawn ffmpeg, stream RGBA frames, finalize.
  // inWidth/inHeight = raw frame size (sequence res); outWidth/outHeight = scaled output size;
  // audioWav = optional muxed audio track.
  encoderCreate(
    job: ExportJobDTO,
    inWidth: number,
    inHeight: number,
    outWidth: number,
    outHeight: number,
    audioWav?: ArrayBuffer | null,
  ): Promise<{ ok: boolean; error?: string }>;
  encoderWrite(jobId: string, frame: ArrayBuffer): Promise<void>;
  encoderFinish(jobId: string): Promise<void>;
  encoderAbort(jobId: string): Promise<void>;
  notify(title: string, body: string): void;

  // ── Shell integration ──
  /** Subscribe to application-menu commands. Returns an unsubscribe function. */
  onMenuCommand(handler: (command: MenuCommand) => void): () => void;
  /** Subscribe to "open this .opencut file" (double-click, second instance). Returns unsubscribe. */
  onOpenProjectPath(handler: (path: string) => void): () => void;
  /** Tell main whether there are unsaved changes, so it can guard the quit. */
  setDirty(dirty: boolean, projectName: string): void;
  /** Answer a `saveAndClose` command: true if the project was written, false if cancelled. */
  saveComplete(saved: boolean): void;
  /** Open a top-level menu at a point in the window (the in-app menu bar). */
  popupMenu(id: MenuId, x: number, y: number): void;
  /** Open a URL in the user's real browser. */
  openExternal(url: string): void;
  /** Drive the window's own controls — the title bar is drawn by the app, not the OS. */
  windowAction(action: WindowAction): void;
  /** Subscribe to window state so the maximise button's icon matches reality. */
  onWindowState(handler: (state: { maximized: boolean }) => void): () => void;
}

/** What the app-drawn window buttons can ask the window to do. */
export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

declare global {
  interface Window {
    opencut: OpenCutApi;
  }
}

/** IPC channel names, centralized to avoid string typos across the boundary. */
export const CH = {
  openProject: 'project:open',
  saveProject: 'project:save',
  loadProject: 'project:load',
  recentProjects: 'project:recent',
  importFiles: 'media:import',
  probeMedia: 'media:probe',
  generateThumbnail: 'media:thumbnail',
  chooseExportPath: 'export:choosePath',
  encoderCreate: 'encoder:create',
  encoderWrite: 'encoder:write',
  encoderFinish: 'encoder:finish',
  encoderAbort: 'encoder:abort',
  notify: 'app:notify',
  // Shell integration (main → renderer for the first two, renderer → main for the rest).
  menuCommand: 'app:menuCommand',
  openProjectPath: 'app:openProjectPath',
  setDirty: 'app:setDirty',
  saveComplete: 'app:saveComplete',
  popupMenu: 'app:popupMenu',
  openExternal: 'app:openExternal',
  windowAction: 'app:windowAction',
  windowState: 'app:windowState',
} as const;
