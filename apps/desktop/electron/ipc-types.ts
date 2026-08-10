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

  // ── Settings support ──
  chooseDirectory(): Promise<string | null>;
  systemInfo(): Promise<SystemInfoDTO>;
  /** `projectDir` is the user's configured project folder; '' falls back to Documents. */
  storageUsage(projectDir: string): Promise<StorageUsageDTO>;
  clearCache(): Promise<number>;
  clearRecentProjects(): Promise<void>;
  openDataFolder(): Promise<void>;
  setLaunchOnStartup(enabled: boolean): Promise<void>;
  setZoomFactor(factor: number): void;
  /** Mirror the few preferences main needs at IPC time (recents cap, project folder). */
  setHostPrefs(prefs: HostPrefsDTO): void;
}

/** What the app-drawn window buttons can ask the window to do. */
export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export interface SystemInfoDTO {
  appVersion: string;
  platform: string;
  electron: string;
  chrome: string;
  node: string;
  gpu: string;
  ffmpeg: string;
  dataDir: string;
}

/** The preferences main acts on. Mirrored from the renderer, which owns the real store. */
export interface HostPrefsDTO {
  maxRecentProjects: number;
  defaultProjectDir: string;
  exportDir: string;
  /** ffmpeg `-threads`; 0 lets ffmpeg decide. */
  cpuThreads: number;
  /** Applied on the NEXT launch — see main.ts. */
  gpuAcceleration: boolean;
  /**
   * Appearance. Main needs it only to pick the window's `backgroundColor`, which is painted
   * before the renderer has produced a single frame — get it wrong and every launch starts with
   * a flash of the opposite theme.
   */
  theme: 'system' | 'light' | 'dark';
}

export interface StorageUsageDTO {
  dataDir: string;
  buckets: { cache: number; projects: number; autosaves: number; logs: number };
}

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
  // Settings support
  chooseDirectory: 'settings:chooseDirectory',
  systemInfo: 'settings:systemInfo',
  storageUsage: 'settings:storageUsage',
  clearCache: 'settings:clearCache',
  clearRecentProjects: 'settings:clearRecent',
  openDataFolder: 'settings:openDataFolder',
  setLaunchOnStartup: 'settings:launchOnStartup',
  setZoomFactor: 'settings:zoomFactor',
  hostPrefs: 'settings:hostPrefs',
} as const;
