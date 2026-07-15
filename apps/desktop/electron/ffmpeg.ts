/**
 * Native FFmpeg integration (main process).
 *
 * Provides media probing, thumbnail extraction, and a streaming RGBA→video encoder. The
 * binaries are resolved from PATH (override with OPENCUT_FFMPEG / OPENCUT_FFPROBE). All
 * functions degrade gracefully: if ffmpeg isn't installed, callers get sensible fallbacks
 * rather than a crash, and the app remains usable for editing.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import type { ProbeResult, ExportJobDTO } from './ipc-types.js';

const FFMPEG = process.env.OPENCUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.OPENCUT_FFPROBE || 'ffprobe';

/** Run a command to completion, capturing stdout. Rejects on non-zero exit. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

export async function ffprobeMedia(src: string): Promise<ProbeResult> {
  const json = await run(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    src,
  ]);
  const data = JSON.parse(json) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split('/').map(Number);
    if (n && d) fps = n / d;
  }
  return {
    duration: parseFloat(data.format?.duration ?? '0') || 0,
    width: video?.width ?? 1920,
    height: video?.height ?? 1080,
    ...(fps ? { fps } : {}),
    hasAudio,
  };
}

/** Extract a single JPEG frame and return it as a data URL for the library thumbnail. */
export async function ffmpegThumbnail(src: string, atSeconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        '-ss', String(atSeconds),
        '-i', src,
        '-frames:v', '1',
        '-vf', 'scale=320:-1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) return reject(new Error('thumbnail failed'));
      resolve(`data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`);
    });
  });
}

/** Map our codec keys to ffmpeg encoders, choosing hardware variants when requested. */
function videoEncoder(codec: string, hardware: boolean): string {
  switch (codec) {
    case 'h264':
      return hardware ? 'h264_nvenc' : 'libx264';
    case 'h265':
      return hardware ? 'hevc_nvenc' : 'libx265';
    case 'vp9':
      return 'libvpx-vp9';
    case 'av1':
      return 'libsvtav1';
    case 'prores':
      return 'prores_ks';
    case 'gif':
      return 'gif';
    default:
      return 'libx264';
  }
}

/**
 * A live encoder: ffmpeg reads raw RGBA frames from stdin and writes the encoded file.
 * We vflip because WebGL readPixels is bottom-up. Backpressure is honored via drain.
 */
export class FfmpegEncoder {
  private child: ReturnType<typeof spawn>;
  private closed: Promise<void>;
  /** Raw input frame size (what the compositor produces = the sequence resolution). */
  readonly width: number;
  readonly height: number;
  private audioPath?: string;

  /**
   * @param inWidth/inHeight   size of the raw RGBA frames written to stdin (sequence resolution)
   * @param outWidth/outHeight target output size; ffmpeg scales when it differs from the input
   * @param audioPath          optional WAV file to mux as the audio track
   */
  constructor(
    job: ExportJobDTO,
    inWidth: number,
    inHeight: number,
    outWidth: number,
    outHeight: number,
    audioPath?: string,
  ) {
    this.width = inWidth;
    this.height = inHeight;
    this.audioPath = audioPath;
    const s = job.settings;
    const bitrate = s.bitrateMbps ? `${s.bitrateMbps}M` : '8M';
    const isGif = s.container === 'gif';

    const args = [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${inWidth}x${inHeight}`,
      '-framerate', String(s.fps),
      '-i', 'pipe:0',
    ];
    // Optional audio input (WAV). GIF has no audio track.
    const hasAudio = !!audioPath && !isGif;
    if (hasAudio) args.push('-i', audioPath!);

    // WebGL readPixels is bottom-up (vflip); scale only when the output size differs.
    const filters = ['vflip'];
    if (inWidth !== outWidth || inHeight !== outHeight) filters.push(`scale=${outWidth}:${outHeight}:flags=lanczos`);
    args.push('-vf', filters.join(','));

    if (isGif) {
      args.push('-loop', '0');
    } else {
      args.push(
        '-c:v', videoEncoder(s.videoCodec, s.hardwareAcceleration),
        '-b:v', bitrate,
        '-pix_fmt', 'yuv420p',
      );
      if (hasAudio) {
        args.push('-c:a', 'aac', '-b:a', `${s.audioBitrateKbps || 192}k`, '-map', '0:v:0', '-map', '1:a:0', '-shortest');
      }
    }
    args.push(job.outputPath);

    this.child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    this.child.stderr?.on('data', (d) => (stderr += d.toString()));
    this.closed = once(this.child, 'close').then(([code]) => {
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`);
    });
    // Surface spawn errors (e.g. ffmpeg missing) on the close promise.
    this.child.on('error', () => {});
  }

  writeFrame(frame: Buffer): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new Error('encoder closed'));
    return new Promise((resolve, reject) => {
      const ok = stdin.write(frame, (err) => err && reject(err));
      if (ok) resolve();
      else stdin.once('drain', resolve); // honor backpressure
    });
  }

  async finish(): Promise<void> {
    this.child.stdin?.end();
    try {
      await this.closed;
    } finally {
      await this.cleanup();
    }
  }

  async abort(): Promise<void> {
    try {
      this.child.stdin?.destroy();
      this.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.audioPath) {
      await unlink(this.audioPath).catch(() => {});
      this.audioPath = undefined;
    }
  }
}
