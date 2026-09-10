/**
 * Export settings model, presets, and estimators.
 *
 * The export *engine* lives in the platform bridge (native ffmpeg on desktop). This file
 * is the shared, UI-facing description of what an export IS, plus cheap estimators so the
 * Export dialog can show file-size / render-time predictions before committing.
 */

import type { SequenceId } from '../model/ids.js';

export type Resolution = '480p' | '720p' | '1080p' | '1440p' | '4K' | '8K';
export type Container = 'mp4' | 'mov' | 'avi' | 'mkv' | 'gif';
export type VideoCodec = 'h264' | 'h265' | 'vp9' | 'av1' | 'prores' | 'gif';
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export const RESOLUTIONS: Record<Resolution, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4K': { width: 3840, height: 2160 },
  '8K': { width: 7680, height: 4320 },
};

export const FRAME_RATES = [24, 25, 30, 50, 60, 120, 144, 240] as const;

/** Codecs valid for each container. Keeps the UI from offering impossible combos. */
export const CONTAINER_CODECS: Record<Container, VideoCodec[]> = {
  mp4: ['h264', 'h265', 'av1'],
  mov: ['h264', 'h265', 'prores'],
  mkv: ['h264', 'h265', 'vp9', 'av1'],
  avi: ['h264'],
  gif: ['gif'],
};

export interface ExportSettings {
  resolution: Resolution;
  fps: number;
  quality: QualityPreset;
  container: Container;
  videoCodec: VideoCodec;
  /** Target video bitrate in Mbps. If undefined, derived from quality + resolution. */
  bitrateMbps?: number;
  audioBitrateKbps: number;
  audioSampleRate: number;
  hardwareAcceleration: boolean;
  /** Export only the sequence's in/out range when true. */
  useInOutRange: boolean;
}

export interface ExportJob {
  id: string;
  sequenceId: SequenceId;
  filename: string;
  outputPath: string;
  settings: ExportSettings;
  createdAt: number;
}

export type ExportStatus = 'queued' | 'rendering' | 'paused' | 'done' | 'canceled' | 'error';

export interface ExportProgress {
  jobId: string;
  status: ExportStatus;
  /** 0..1 */
  progress: number;
  /** Seconds remaining, best estimate. */
  etaSeconds?: number;
  renderedFrames?: number;
  totalFrames?: number;
  message?: string;
}

/** Sensible default bitrate (Mbps) per quality tier, scaled by pixel count. */
export function defaultBitrateMbps(res: Resolution, quality: QualityPreset, fps: number): number {
  const { width, height } = RESOLUTIONS[res];
  const megapixels = (width * height) / 1_000_000;
  const qualityFactor = { low: 2, medium: 4, high: 8, ultra: 14 }[quality];
  const fpsFactor = fps > 30 ? fps / 30 : 1;
  return Math.max(1, Math.round(megapixels * qualityFactor * fpsFactor));
}

export function defaultExportSettings(fps = 30): ExportSettings {
  return {
    resolution: '1080p',
    fps,
    quality: 'high',
    container: 'mp4',
    videoCodec: 'h264',
    audioBitrateKbps: 320,
    audioSampleRate: 48000,
    hardwareAcceleration: true,
    useInOutRange: false,
  };
}

/**
 * Expand a filename pattern into an actual filename.
 *
 * Tokens: {project} {date} {time} {resolution} {fps}. An unknown token is left verbatim, so a
 * typo produces a visibly wrong name rather than silently falling back to something the user
 * then has to reverse-engineer.
 *
 * The result is sanitised, because the project name is user text and routinely contains `:` or
 * `/` — characters a filesystem either rejects outright or, worse on Windows, reinterprets as a
 * path. Returns a bare name with no extension; the caller appends the container.
 */
export function formatExportFilename(
  pattern: string,
  ctx: { project: string; resolution: string; fps: number; at?: Date },
): string {
  const at = ctx.at ?? new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    project: ctx.project,
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}${pad(at.getMinutes())}`,
    resolution: ctx.resolution,
    fps: String(ctx.fps),
  };
  const expanded = (pattern || '{project}').replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in tokens ? tokens[key]! : whole,
  );
  return safeFilename(expanded, 'export');
}

/**
 * Reduce a display name to something every mainstream filesystem will accept.
 *
 * Shared by the export filename pattern and the Save Project dialog's suggested name, because
 * a project called "Nova Cut Video File at 1.42 PM" has to survive being offered as a filename
 * in both places, and two copies of these rules would drift the first time one was tightened.
 *
 * Spaces become underscores rather than being stripped: a filename with no word boundaries at
 * all is materially harder to read than one with underscores.
 */
export function safeFilename(name: string, fallback = 'untitled'): string {
  const safe = name
    .replace(/[\\/:*?"<>|]/g, '-') // characters no mainstream filesystem accepts
    .replace(/\s+/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_\s]+$/g, '') // a leading dot hides the file; a trailing one breaks Windows
    .slice(0, 120);
  return safe || fallback;
}

/** Estimated output size in bytes for a given duration (seconds). */
export function estimateFileSize(settings: ExportSettings, durationSeconds: number): number {
  const videoMbps =
    settings.bitrateMbps ?? defaultBitrateMbps(settings.resolution, settings.quality, settings.fps);
  const videoBytes = (videoMbps * 1_000_000 * durationSeconds) / 8;
  const audioBytes = (settings.audioBitrateKbps * 1000 * durationSeconds) / 8;
  return Math.round(videoBytes + audioBytes);
}

/**
 * Rough render-time estimate (seconds). Assumes a per-megapixel-per-frame cost, faster
 * with hardware acceleration. Real ETA comes from the engine mid-render; this is the
 * pre-flight guess shown in the dialog.
 */
export function estimateRenderTime(settings: ExportSettings, durationSeconds: number): number {
  const { width, height } = RESOLUTIONS[settings.resolution];
  const megapixels = (width * height) / 1_000_000;
  const frames = durationSeconds * settings.fps;
  const perFrameMs = megapixels * (settings.hardwareAcceleration ? 1.2 : 4.5);
  return Math.round((frames * perFrameMs) / 1000);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
