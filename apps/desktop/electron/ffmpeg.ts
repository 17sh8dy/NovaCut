/**
 * Native FFmpeg integration (main process).
 *
 * Provides media probing, thumbnail extraction, and a streaming RGBA→video encoder. All
 * functions degrade gracefully: if ffmpeg isn't installed, callers get sensible fallbacks
 * rather than a crash, and the app remains usable for editing.
 *
 * BINARY RESOLUTION, in order: the OPENCUT_FFMPEG / OPENCUT_FFPROBE environment overrides, then
 * `resources/ffmpeg/` inside the installed app, then PATH. The middle entry is what makes the
 * packaged app self-sufficient without bloating the installer for everyone: drop the two
 * executables in that folder and export works with no system-wide install, and nothing changes
 * for users who already have ffmpeg on PATH.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { ProbeResult, ExportJobDTO } from './ipc-types.js';

function resolveBinary(envKey: 'OPENCUT_FFMPEG' | 'OPENCUT_FFPROBE', name: string): string {
  const override = process.env[envKey];
  if (override) return override;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  // `resourcesPath` only exists in a packaged app; in dev this simply falls through to PATH.
  const bundled = app.isPackaged ? join(process.resourcesPath, 'ffmpeg', exe) : '';
  if (bundled && existsSync(bundled)) return bundled;
  return name; // let the OS resolve it from PATH
}

const FFMPEG = resolveBinary('OPENCUT_FFMPEG', 'ffmpeg');
const FFPROBE = resolveBinary('OPENCUT_FFPROBE', 'ffprobe');

/** The resolved ffmpeg path, so About reports the version of the binary actually in use. */
export const ffmpegBinary = (): string => FFMPEG;

/**
 * Encoder thread cap, from the Performance preference. 0 means "let ffmpeg decide", which is its
 * own default and what most people want — the setting exists for leaving headroom on a machine
 * doing something else at the same time.
 */
let encoderThreads = 0;
export function setEncoderThreads(n: number): void {
  encoderThreads = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** ENOENT from a spawn means "not installed", which deserves a sentence a user can act on. */
function describeSpawnFailure(err: unknown): Error {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      'FFmpeg was not found. Install it and make sure `ffmpeg` is on your PATH, or set the ' +
        'OPENCUT_FFMPEG environment variable to its full path.',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Run a command to completion, capturing stdout. Rejects on non-zero exit. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(describeSpawnFailure(e)));
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
    child.on('error', (e) => reject(describeSpawnFailure(e)));
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
  /**
   * The reason the encoder is no longer usable, once it isn't.
   *
   * This exists because of a specific hang: a paused stdin resolves the pending write on
   * `drain`, but a dead ffmpeg never drains, so an export against a missing binary or a
   * rejected codec sat on an un-settled promise forever with the progress bar frozen. Every
   * waiter is now failed explicitly the moment the process goes away.
   */
  private dead: Error | null = null;
  private waiters: ((err: Error) => void)[] = [];
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

    /*
     * ── COLOUR: STATE THE MATRIX, AND TAG WHAT WAS WRITTEN ───────────────────────────────
     *
     * The compositor hands over full-range RGBA. Turning that into YUV needs a matrix, and this
     * used to specify neither the matrix nor the tags — so swscale picked a default, the file
     * was written with every colour field `unknown`, and each player then guessed for itself.
     * Measured against SMPTE bars through the real export path: white came back pixel-identical
     * while saturated colours were out by up to 29/255. Untouched neutrals with rotated chroma
     * is the signature of a matrix mismatch, and it is why the same export could look right in
     * one player and wrong in another.
     *
     * Both halves are needed and they must agree:
     *   out_color_matrix / out_range  tell swscale how to CONVERT
     *   -colorspace / -color_*        tell the container what was WRITTEN
     * Doing only the second is worse than doing neither: correctly-tagged wrong pixels.
     *
     * BT.709 limited-range for everything, including 480p and 576p. The old SD convention is
     * BT.601, but a mixed rule means an export's colour depends on its resolution, and every
     * modern delivery target expects 709. What matters most is that the file says what it is.
     */
    const COLOUR = { matrix: 'bt709', range: 'tv' };

    // WebGL readPixels is bottom-up, hence vflip. The scale step also carries the colour
    // conversion, so it runs even at native size — swscale skips the resample when the
    // dimensions match and does only the pixel-format work, which has to happen regardless.
    const filters = ['vflip'];
    const resizing = inWidth !== outWidth || inHeight !== outHeight;
    if (isGif) {
      // GIF is paletted RGB: no YUV conversion to direct, so only resize when asked.
      if (resizing) filters.push(`scale=${outWidth}:${outHeight}:flags=lanczos`);
    } else {
      filters.push(
        `scale=${outWidth}:${outHeight}:flags=lanczos` +
          `:out_color_matrix=${COLOUR.matrix}:out_range=${COLOUR.range}`,
        /*
         * `setparams` stamps the colour properties onto the frames themselves.
         *
         * The `-color_*` output options alone are not enough, and this was measured rather than
         * assumed: with only those flags the file came out `color_space=bt709` and
         * `color_range=tv` but `color_transfer=unknown` and `color_primaries=unknown` — half
         * described, which still leaves a player guessing about the other half. Frames arriving
         * from rawvideo carry no colour properties, and the encoder takes primaries and transfer
         * from the frame. Stamping them here fills in all four.
         */
        `setparams=colorspace=${COLOUR.matrix}:color_primaries=${COLOUR.matrix}` +
          `:color_trc=${COLOUR.matrix}:range=${COLOUR.range}`,
      );
    }
    args.push('-vf', filters.join(','));

    if (isGif) {
      args.push('-loop', '0');
    } else {
      args.push(
        '-c:v', videoEncoder(s.videoCodec, s.hardwareAcceleration),
        '-b:v', bitrate,
        '-pix_fmt', 'yuv420p',
        // Tag the stream to match the conversion above.
        '-colorspace', COLOUR.matrix,
        '-color_primaries', COLOUR.matrix,
        '-color_trc', COLOUR.matrix,
        '-color_range', COLOUR.range,
      );
      if (hasAudio) {
        args.push('-c:a', 'aac', '-b:a', `${s.audioBitrateKbps || 192}k`, '-map', '0:v:0', '-map', '1:a:0', '-shortest');
      }
    }
    // Before the output, after the codec: ffmpeg applies -threads to the encoder it precedes.
    if (encoderThreads > 0) args.push('-threads', String(encoderThreads));
    args.push(job.outputPath);

    this.child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    let spawnError: Error | null = null;
    this.child.stderr?.on('data', (d) => (stderr += d.toString()));
    // A failed spawn emits 'error' and then 'close' with a null code; capture the cause first so
    // the close handler reports "FFmpeg was not found" instead of "ffmpeg exited null".
    this.child.on('error', (e) => {
      spawnError = describeSpawnFailure(e);
      this.fail(spawnError);
    });
    this.closed = once(this.child, 'close').then(([code]) => {
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`);
    });
    // stdin closing under us (ffmpeg rejected the arguments and quit) must fail pending writes
    // rather than leave them waiting on a 'drain' that can no longer come.
    this.child.stdin?.on('error', (e) => this.fail(describeSpawnFailure(e)));
    this.child.on('close', (code) => {
      if (code !== 0) this.fail(spawnError ?? new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  }

  /** Mark the encoder unusable and settle everything currently waiting on it. */
  private fail(err: Error): void {
    this.dead ??= err;
    const pending = this.waiters;
    this.waiters = [];
    for (const reject of pending) reject(this.dead);
  }

  writeFrame(frame: Buffer): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new Error('encoder closed'));
    return new Promise((resolve, reject) => {
      const ok = stdin.write(frame, (err) => err && reject(describeSpawnFailure(err)));
      if (ok) return resolve();
      // Backpressure: wait for drain, but register with `waiters` too so a death in the meantime
      // rejects instead of hanging.
      const onDrain = (): void => {
        this.waiters = this.waiters.filter((w) => w !== onFail);
        resolve();
      };
      const onFail = (err: Error): void => {
        stdin.off('drain', onDrain);
        reject(err);
      };
      this.waiters.push(onFail);
      stdin.once('drain', onDrain);
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
