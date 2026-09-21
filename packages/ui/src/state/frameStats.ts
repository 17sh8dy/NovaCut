/**
 * Preview frame statistics, for the FPS overlay (Settings > Experimental).
 *
 * The playback engine calls `recordFrame` around every compositor render, so what is reported is
 * frames the preview actually drew — not how often the browser ticked. Paused, nothing renders and
 * the rate correctly falls to zero.
 */

const WINDOW_MS = 1000;
const stamps: number[] = [];
const durations: number[] = [];

/** Record one rendered frame that took `durationMs` to draw. */
export function recordFrame(durationMs: number): void {
  const now = performance.now();
  stamps.push(now);
  durations.push(durationMs);
  while (stamps.length && now - stamps[0]! > WINDOW_MS) {
    stamps.shift();
    durations.shift();
  }
}

export interface FrameSnapshot {
  /** Frames drawn in the last second. */
  fps: number;
  /** Mean draw time of those frames, in ms (0 when none). */
  avgMs: number;
}

export function frameSnapshot(): FrameSnapshot {
  const now = performance.now();
  while (stamps.length && now - stamps[0]! > WINDOW_MS) {
    stamps.shift();
    durations.shift();
  }
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  return { fps: stamps.length, avgMs: avg };
}
