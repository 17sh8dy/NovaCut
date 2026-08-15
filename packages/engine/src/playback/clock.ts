/**
 * PlaybackClock — a rAF-driven transport that advances a playhead in ticks.
 *
 * It owns *time*, not rendering. Consumers subscribe to `onTick(ticks)` and draw/seek.
 * Supports variable speed, looping over an in/out range, and frame stepping. Keeping this
 * separate from the compositor means the same clock drives preview, audio, and export.
 */

import { TICKS_PER_SECOND, type Ticks } from '@opencut/core';
import { dlog, dthrottle } from '../debug.js';

export interface ClockOptions {
  fps: number;
  /** Total timeline length; playback stops (or loops) here. */
  duration: Ticks;
  loop?: boolean;
  loopStart?: Ticks;
  loopEnd?: Ticks;
}

export class PlaybackClock {
  private playing = false;
  private position: Ticks = 0;
  private speed = 1;
  private rafId = 0;
  private lastTs = 0;
  private opts: ClockOptions;
  private tickListeners = new Set<(t: Ticks) => void>();
  private stateListeners = new Set<(playing: boolean) => void>();

  constructor(opts: ClockOptions) {
    this.opts = opts;
  }

  configure(opts: Partial<ClockOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  onTick(fn: (t: Ticks) => void): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  onStateChange(fn: (playing: boolean) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTime(): Ticks {
    return this.position;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  seek(t: Ticks): void {
    this.position = Math.max(0, Math.min(t, this.opts.duration));
    this.emitTick();
  }

  play(): void {
    if (this.playing) return;
    /*
     * Pressing Play at the end of the timeline REWINDS rather than doing nothing.
     *
     * Playback stops by parking the position exactly on `duration`, so the next play() used to
     * advance past the end on its very first frame, emit one tick and pause again — the button
     * flickered to Pause and back and the picture never moved. Watching a cut to the end and
     * pressing Play again is the most ordinary thing an editor does, and it read as a dead
     * transport.
     *
     * Back to the loop start rather than a hard zero: with a loop range set, "the beginning" is
     * the beginning of that range, which is where a wrap would have put it anyway.
     */
    const from = this.opts.loopStart ?? 0;
    if (this.position >= this.opts.duration && this.opts.duration > from) {
      this.position = from;
      this.emitTick();
    }
    this.playing = true;
    this.lastTs = 0;
    dlog('clock', 'play', { position: this.position, duration: this.opts.duration, fps: this.opts.fps, speed: this.speed });
    this.emitState();
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    dlog('clock', 'pause', { position: this.position });
    this.emitState();
  }

  stop(): void {
    this.pause();
    this.seek(0);
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  /** Advance by whole frames (negative to step back). Pauses first for precise stepping. */
  step(frames: number): void {
    this.pause();
    const ticksPerFrame = TICKS_PER_SECOND / this.opts.fps;
    this.seek(this.position + Math.round(frames * ticksPerFrame));
  }

  private frame = (ts: number): void => {
    if (!this.playing) return;
    if (this.lastTs === 0) this.lastTs = ts;
    const deltaMs = ts - this.lastTs;
    this.lastTs = ts;

    const advance = Math.round((deltaMs / 1000) * TICKS_PER_SECOND * this.speed);
    let next = this.position + advance;

    const loopEnd = this.opts.loopEnd ?? this.opts.duration;
    const loopStart = this.opts.loopStart ?? 0;

    if (next >= this.opts.duration && !this.opts.loop) {
      this.position = this.opts.duration;
      this.emitTick();
      this.pause();
      return;
    }
    if (this.opts.loop && next >= loopEnd) {
      // Wrap back to the loop start, preserving overshoot for smooth looping.
      next = loopStart + ((next - loopStart) % Math.max(1, loopEnd - loopStart));
    }
    this.position = next;
    this.emitTick();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private emitTick(): void {
    dthrottle('tick', 500, 'clock', () => [
      'playback time',
      { position: this.position, seconds: Number((this.position / TICKS_PER_SECOND).toFixed(3)), playing: this.playing },
    ]);
    for (const l of this.tickListeners) l(this.position);
  }

  private emitState(): void {
    for (const l of this.stateListeners) l(this.playing);
  }
}
