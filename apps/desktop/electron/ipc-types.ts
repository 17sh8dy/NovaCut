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

/** The object exposed on `window.opencut` by the preload script. */
export interface OpenCutApi {
  platform: 'desktop';
  openProject(): Promise<{ path: string; json: string } | null>;
  saveProject(json: string, path?: string): Promise<{ path: string } | null>;
  loadProject(path: string): Promise<string>;
  recentProjects(): Promise<RecentProjectDTO[]>;
  importFiles(): Promise<ImportedFileDTO[]>;
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
} as const;
