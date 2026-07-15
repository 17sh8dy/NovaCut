import { useEffect, useMemo, useRef } from 'react';
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
import { formatTimecode, sample, type Clip, type Sequence } from '@opencut/core';
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
          <canvas ref={canvasRef} width={seq.width} height={seq.height} />
          <TextOverlay sequence={seq} time={playhead} />
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

/**
 * Text clips are composited as DOM over the canvas (crisp text, live editing) rather than
 * rasterized in WebGL. For export they're rendered to a canvas layer — the model is the
 * same, only the target differs.
 */
function TextOverlay({ sequence, time }: { sequence: Sequence; time: number }) {
  const active = useMemo(() => {
    const clips: Clip[] = [];
    for (const track of sequence.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      for (const c of track.clips) {
        if (c.kind === 'text' && c.enabled && time >= c.start && time < c.start + c.duration) clips.push(c);
      }
    }
    return clips;
  }, [sequence, time]);

  return (
    <div className="oc-preview__overlay">
      {active.map((clip) => {
        const t = clip.transform;
        const local = time - clip.start;
        const ts = clip.text!;
        const opacity = sample(t.opacity, local);
        const x = sample(t.x, local);
        const y = sample(t.y, local);
        const rot = sample(t.rotation, local);
        const scale = sample(t.scaleX, local);
        // Position as a percentage so the overlay scales with the responsive canvas.
        return (
          <div
            key={clip.id}
            style={{
              position: 'absolute',
              left: `calc(50% + ${(x / sequence.width) * 100}%)`,
              top: `calc(50% + ${(y / sequence.height) * 100}%)`,
              transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`,
              opacity,
              fontFamily: ts.fontFamily,
              // Scale font by canvas height ratio via cqh-like em using vh fallback.
              fontSize: `${(ts.fontSize / sequence.height) * 100}cqh`,
              fontWeight: ts.fontWeight,
              fontStyle: ts.italic ? 'italic' : 'normal',
              textDecoration: ts.underline ? 'underline' : 'none',
              textAlign: ts.align,
              letterSpacing: ts.letterSpacing,
              lineHeight: ts.lineHeight,
              color: ts.color,
              whiteSpace: 'pre-wrap',
              textShadow: ts.shadow ? `${ts.shadow.x}px ${ts.shadow.y}px ${ts.shadow.blur}px ${ts.shadow.color}` : undefined,
              WebkitTextStroke: ts.stroke ? `${ts.stroke.width}px ${ts.stroke.color}` : undefined,
            }}
          >
            {ts.content}
          </div>
        );
      })}
    </div>
  );
}
