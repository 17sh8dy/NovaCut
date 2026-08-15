/**
 * usePlaybackEngine — bridges the React UI to the rendering engine.
 *
 * Owns the Compositor, AudioEngine, FrameSourcePool, and PlaybackClock instances and keeps
 * them in lockstep with the store: the clock advances the playhead during playback; every
 * playhead change (play or scrub) re-renders the current frame and reconciles audio. The
 * engine is created once and reconfigured as the sequence changes — never rebuilt per edit.
 */

import { useEffect, useRef } from 'react';
import { AudioEngine, Compositor, FrameSourcePool, PlaybackClock, dlog, dthrottle } from '@opencut/engine';
import { findMedia, type Ticks } from '@opencut/core';
import { useAppStore } from './context.js';

export interface PlaybackEngine {
  attach: (canvas: HTMLCanvasElement) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  seek: (t: Ticks) => void;
  step: (frames: number) => void;
  setSpeed: (s: number) => void;
}

export function usePlaybackEngine(): PlaybackEngine {
  const store = useAppStore();
  const compositor = useRef<Compositor | null>(null);
  const audio = useRef<AudioEngine | null>(null);
  const pool = useRef<FrameSourcePool | null>(null);
  const clock = useRef<PlaybackClock | null>(null);
  const engineApi = useRef<PlaybackEngine | null>(null);

  /** Render the frame at `time` and reconcile audio. Cheap; safe to call every tick. */
  const renderAt = (time: Ticks) => {
    const state = store.getState();
    const seq = state.sequence();
    dthrottle('renderAt', 400, 'engine', () => [
      'renderAt',
      {
        time,
        hasCompositor: !!compositor.current,
        hasAudio: !!audio.current,
        tracks: seq.tracks.length,
        clips: seq.tracks.reduce((n, t) => n + t.clips.length, 0),
        mediaCount: state.project.media.length,
      },
    ]);
    const speed = state.playbackSpeed;
    compositor.current?.render({
      sequence: seq,
      time,
      getMedia: (id) => findMedia(state.project, id as never),
      playing: clock.current?.isPlaying ?? false,
      speed,
    });
    audio.current?.update(seq, time, (id) => findMedia(state.project, id as never), speed);
  };

  /**
   * (Re)construct the non-visual engine pieces if they're missing. Idempotent, so it's
   * safe to call from render and from every effect/API entry point. This is what lets the
   * engine survive React StrictMode's dev mount→unmount→mount cycle: the unmount disposes
   * everything (see the teardown effect) and nulls the refs; the next call rebuilds them.
   * Without this, remount reuses a disposed compositor (black preview) and a closed
   * AudioContext (no audio).
   */
  const ensureCore = () => {
    const bridge = store.getState().bridge;
    if (!pool.current || !audio.current || !clock.current) {
      dlog('engine', 'ensureCore rebuild', {
        pool: !!pool.current,
        audio: !!audio.current,
        clock: !!clock.current,
        compositor: !!compositor.current,
      });
    }
    if (!pool.current) {
      const p = new FrameSourcePool((src) => bridge.resolveMediaUrl(src));
      // When a video/image finishes decoding (or a scrub settles) while paused, redraw the
      // current frame so it appears instead of staying black.
      p.onFrameReady = () => {
        if (!clock.current?.isPlaying) renderAt(store.getState().playhead);
      };
      pool.current = p;
    }
    if (!audio.current) audio.current = new AudioEngine((src) => bridge.resolveMediaUrl(src));
    if (!clock.current) {
      const seq = store.getState().sequence();
      clock.current = new PlaybackClock({ fps: seq.fps, duration: seq.duration, loop: store.getState().loop });
    }
  };
  ensureCore();

  // Build the imperative API once.
  if (!engineApi.current) {
    engineApi.current = {
      attach: (canvas) => {
        ensureCore();
        dlog('engine', 'attach(canvas)', {
          alreadyAttached: !!compositor.current,
          canvasW: canvas.width,
          canvasH: canvas.height,
          clientW: canvas.clientWidth,
          clientH: canvas.clientHeight,
        });
        if (compositor.current) return;
        compositor.current = new Compositor(canvas, pool.current!);
        renderAt(store.getState().playhead);
      },
      play: () => {
        ensureCore();
        void audio.current?.play();
        clock.current?.play();
      },
      pause: () => {
        audio.current?.pause();
        clock.current?.pause();
      },
      toggle: () => clock.current?.toggle(),
      stop: () => clock.current?.stop(),
      seek: (t) => clock.current?.seek(t),
      step: (frames) => clock.current?.step(frames),
      setSpeed: (s) => clock.current?.setSpeed(s),
    };
  }

  // Wire clock → store, and store → render.
  useEffect(() => {
    ensureCore(); // StrictMode remount may have disposed the clock; rebuild before wiring.
    const c = clock.current!;
    const offTick = c.onTick((t) => {
      store.getState().setPlayhead(t);
      renderAt(t);
    });
    // Keep audio in lockstep with the clock however playback was toggled. The transport's
    // play button calls clock.toggle() (not engine.play()), so without this the AudioContext
    // never resumes and the mixer never starts — silent playback even though time advances.
    const offState = c.onStateChange((playing) => {
      store.getState().setPlaying(playing);
      if (playing) void audio.current?.play();
      else audio.current?.pause();
    });

    // Re-render when the project or playhead changes while paused (e.g. scrubbing, edits).
    let lastPlayhead = store.getState().playhead;
    let lastProject = store.getState().project;
    /*
     * Media list identity, so decoders can be released when an asset leaves the library.
     * Compared by reference: every command produces a new project, and `media` is only a new
     * array when the library itself changed — so this stays a pointer compare on the vast
     * majority of ticks, where the edit was to a clip and not to the media.
     */
    let lastMedia = store.getState().project.media;
    const unsub = store.subscribe((s) => {
      c.configure({ fps: s.sequence().fps, duration: s.sequence().duration, loop: s.loop });
      if (s.project.media !== lastMedia) {
        lastMedia = s.project.media;
        const dropped = pool.current?.pruneTo(lastMedia.map((m) => m.id)) ?? 0;
        if (dropped > 0) dlog('engine', 'pruned frame sources for removed media', { dropped });
      }
      if (!c.isPlaying && (s.playhead !== lastPlayhead || s.project !== lastProject)) {
        lastPlayhead = s.playhead;
        lastProject = s.project;
        if (c.currentTime !== s.playhead) c.seek(s.playhead);
        renderAt(s.playhead);
      }
    });

    return () => {
      offTick();
      offState();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tear down the engine on unmount. Null every ref so a later mount (StrictMode's dev
  // remount, or a real remount) rebuilds via ensureCore() instead of reusing disposed
  // WebGL/audio resources — the latter is what left the preview black and silent.
  useEffect(() => {
    return () => {
      dlog('engine', 'TEARDOWN — disposing engine (StrictMode remount will rebuild)');
      compositor.current?.dispose();
      compositor.current = null;
      audio.current?.dispose();
      audio.current = null;
      pool.current?.disposeAll();
      pool.current = null;
      clock.current = null;
    };
  }, []);

  return engineApi.current;
}
