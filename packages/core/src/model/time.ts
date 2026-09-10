/**
 * Time utilities.
 *
 * Nova Cut stores all timeline positions and durations as **ticks**, an integer unit,
 * to avoid floating-point drift when clips are split, trimmed, and snapped thousands of
 * times. We use a high, highly-divisible tick rate so common frame rates (24/25/30/50/60/
 * 120/144/240) and audio sample boundaries all land on whole ticks.
 *
 * Nothing here depends on a specific project frame rate; conversion helpers take the fps
 * they need. This keeps the unit system independent of any one sequence's settings.
 */

/** Ticks per second. 705600000 = LCM-friendly for film/broadcast rates and 48k/44.1k audio. */
export const TICKS_PER_SECOND = 705600000;

/** A duration or position on the timeline, in ticks. Always an integer. */
export type Ticks = number;

export const seconds = (s: number): Ticks => Math.round(s * TICKS_PER_SECOND);
export const toSeconds = (t: Ticks): number => t / TICKS_PER_SECOND;

/** Ticks per single frame at a given frame rate. */
export const ticksPerFrame = (fps: number): number => TICKS_PER_SECOND / fps;

/** Snap a tick value to the nearest whole frame boundary for the given fps. */
export function snapToFrame(t: Ticks, fps: number): Ticks {
  const tpf = ticksPerFrame(fps);
  return Math.round(t / tpf) * tpf;
}

export const framesToTicks = (frames: number, fps: number): Ticks =>
  Math.round(frames * ticksPerFrame(fps));

export const ticksToFrames = (t: Ticks, fps: number): number => t / ticksPerFrame(fps);

/**
 * Format ticks as SMPTE-style timecode `HH:MM:SS:FF`. Drop-frame is intentionally not
 * implemented yet; the signature is stable so we can add it without call-site churn.
 */
export function formatTimecode(t: Ticks, fps: number): string {
  const totalFrames = Math.max(0, Math.round(ticksToFrames(t, fps)));
  const fpsInt = Math.round(fps);
  const frames = totalFrames % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const seconds_ = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds_)}:${pad(frames)}`;
}

/** Human-friendly clock, e.g. `1:04.3`, for readouts where frames add noise. */
export function formatClock(t: Ticks): string {
  const total = toSeconds(t);
  const minutes = Math.floor(total / 60);
  const secs = total - minutes * 60;
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`;
}

export const clampTicks = (t: Ticks, min: Ticks, max: Ticks): Ticks =>
  Math.min(max, Math.max(min, t));
