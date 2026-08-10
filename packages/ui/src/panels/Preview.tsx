import { useEffect, useRef } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  Maximize2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  Square,
} from 'lucide-react';
import { formatTimecode } from '@opencut/core';
import { IconButton, Tooltip } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { usePlayback } from '../state/playbackContext.js';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** The preview: WebGL canvas + text overlay + full transport controls. */
export function Preview() {
  const store = useAppStore();
  const engine = usePlayback();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const seq = useStore((s) => s.sequence());
  const playhead = useStore((s) => s.playhead);
  const isPlaying = useStore((s) => s.isPlaying);
  const speed = useStore((s) => s.playbackSpeed);
  const loop = useStore((s) => s.loop);

  useEffect(() => {
    if (canvasRef.current) engine.attach(canvasRef.current);
  }, [engine]);

  const fullscreen = () => {
    void wrapRef.current?.requestFullscreen?.();
  };

  return (
    <div className="oc-preview">
      <div className="oc-preview__stage">
        <div
          ref={wrapRef}
          className="oc-preview__canvas-wrap"
          style={{ aspectRatio: `${seq.width} / ${seq.height}` }}
        >
          {/*
            Nothing is layered over the canvas any more. Text used to be a DOM overlay here,
            which looked right on screen and was invisible to the export — `readPixels` reads
            the WebGL canvas and never saw it. Text is now rasterized and composited by the
            Compositor like every other clip, so the preview and the exported file are the same
            pixels by construction.
          */}
          <canvas ref={canvasRef} width={seq.width} height={seq.height} />
        </div>
      </div>

      <div className="oc-transport">
        <span className="oc-transport__time">
          <b>{formatTimecode(playhead, seq.fps)}</b> / {formatTimecode(seq.duration, seq.fps)}
        </span>

        <div className="oc-transport__center">
          <Tooltip label="Go to start" shortcut="Home">
            <IconButton onClick={() => engine.seek(0)}>
              <SkipBack size={17} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Previous frame" shortcut="←">
            <IconButton onClick={() => engine.step(-1)}>
              <ChevronFirst size={18} />
            </IconButton>
          </Tooltip>
          <button className="oc-play-btn" onClick={() => engine.toggle()}>
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <Tooltip label="Next frame" shortcut="→">
            <IconButton onClick={() => engine.step(1)}>
              <ChevronLast size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Stop">
            <IconButton onClick={() => engine.stop()}>
              <Square size={15} />
            </IconButton>
          </Tooltip>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            value={speed}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              store.getState().setPlaybackSpeed(v);
              engine.setSpeed(v);
            }}
            style={{
              height: 28,
              background: 'var(--surface-3)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              padding: '0 6px',
              cursor: 'pointer',
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <Tooltip label="Loop playback">
            <IconButton active={loop} onClick={() => store.getState().toggleLoop()}>
              <Repeat size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Fullscreen">
            <IconButton onClick={fullscreen}>
              <Maximize2 size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

