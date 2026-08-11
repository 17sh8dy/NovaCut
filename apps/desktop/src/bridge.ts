/**
 * ElectronBridge — the desktop implementation of the core PlatformBridge.
 *
 * It maps the platform-agnostic bridge contract onto the typed `window.opencut` IPC API
 * from the preload. Swapping this file (for a web or mobile bridge) is all it takes to
 * retarget the entire editor — nothing above this layer knows the host.
 */

import {
  deserializeProject,
  RESOLUTIONS,
  safeFilename,
  serializeProject,
  type ExportJob,
  type FrameEncoder,
  type ImportedFile,
  type ImportKind,
  type PlatformBridge,
  type Project,
  type HostPrefs,
  type RecentProject,
  type StorageUsage,
  type SystemInfo,
  type WindowAction,
  type WindowMenuId,
} from '@opencut/core';

export class ElectronBridge implements PlatformBridge {
  readonly platform = 'desktop' as const;
  private api = window.opencut;

  async openProjectDialog(): Promise<{ path: string; project: Project } | null> {
    const res = await this.api.openProject();
    if (!res) return null;
    return { path: res.path, project: deserializeProject(res.json) };
  }

  async saveProject(project: Project, path?: string): Promise<{ path: string } | null> {
    // Suggest the project's own name as the filename. Main cannot compute this itself: the
    // workspace packages are aliased into the renderer bundle only, so the sanitiser lives here.
    return this.api.saveProject(serializeProject(project), path, safeFilename(project.name, 'Untitled'));
  }

  async loadProject(path: string): Promise<Project> {
    return deserializeProject(await this.api.loadProject(path));
  }

  recentProjects(): Promise<RecentProject[]> {
    return this.api.recentProjects();
  }

  async importDialog(kinds?: readonly ImportKind[]): Promise<ImportedFile[]> {
    return this.api.importFiles(kinds);
  }

  probeMedia(src: string) {
    return this.api.probeMedia(src);
  }

  generateThumbnail(src: string, atSeconds = 0): Promise<string> {
    return this.api.generateThumbnail(src, atSeconds);
  }

  resolveMediaUrl(src: string): string {
    return this.api.mediaUrl(src);
  }

  resolveDroppedFile(file: File): string | null {
    return this.api.getPathForFile(file);
  }

  chooseExportPath(defaultName: string): Promise<string | null> {
    return this.api.chooseExportPath(defaultName);
  }

  async createEncoder(
    job: ExportJob,
    source: { width: number; height: number; audioWav?: ArrayBuffer | null },
  ): Promise<FrameEncoder> {
    // Output resolution comes from the job; the compositor renders at `source` (sequence) size
    // and ffmpeg scales to the output. This keeps the raw-frame size and encoder in lockstep.
    const { width: outW, height: outH } = RESOLUTIONS[job.settings.resolution];
    const res = await this.api.encoderCreate(
      { id: job.id, filename: job.filename, outputPath: job.outputPath, settings: job.settings },
      source.width,
      source.height,
      outW,
      outH,
      source.audioWav ?? null,
    );
    if (!res.ok) throw new Error(res.error ?? 'Failed to start encoder (is FFmpeg installed?)');
    const api = this.api;
    return {
      width: source.width,
      height: source.height,
      async writeFrame(rgba: Uint8Array): Promise<void> {
        // Copy into an exact ArrayBuffer for structured-clone transfer to main.
        const buf = rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
        await api.encoderWrite(job.id, buf as ArrayBuffer);
      },
      finish: () => api.encoderFinish(job.id),
      abort: () => api.encoderAbort(job.id),
    };
  }

  notify(title: string, body: string): void {
    this.api.notify(title, body);
  }

  revealFile(path: string): void {
    this.api.revealFile(path);
  }

  popupMenu(id: WindowMenuId, x: number, y: number): void {
    this.api.popupMenu(id, x, y);
  }

  openExternal(url: string): void {
    this.api.openExternal(url);
  }

  windowAction(action: WindowAction): void {
    this.api.windowAction(action);
  }

  onWindowState(handler: (state: { maximized: boolean }) => void): () => void {
    return this.api.onWindowState(handler);
  }

  // ── Settings support ──
  chooseDirectory(): Promise<string | null> {
    return this.api.chooseDirectory();
  }

  systemInfo(): Promise<SystemInfo> {
    return this.api.systemInfo();
  }

  storageUsage(projectDir: string): Promise<StorageUsage> {
    return this.api.storageUsage(projectDir);
  }

  clearCache(): Promise<number> {
    return this.api.clearCache();
  }

  clearRecentProjects(): Promise<void> {
    return this.api.clearRecentProjects();
  }

  openDataFolder(): Promise<void> {
    return this.api.openDataFolder();
  }

  setLaunchOnStartup(enabled: boolean): Promise<void> {
    return this.api.setLaunchOnStartup(enabled);
  }

  setZoomFactor(factor: number): void {
    this.api.setZoomFactor(factor);
  }

  setHostPrefs(prefs: HostPrefs): void {
    this.api.setHostPrefs(prefs);
  }
}
