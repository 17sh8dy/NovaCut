import { useCallback, useRef } from 'react';

interface SliderProps {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  /** Called once when a drag begins/ends — used to coalesce undo history. */
  onCommitStart?: () => void;
  onCommitEnd?: () => void;
}

/** A pointer-driven slider with a numeric readout. Drag anywhere on the track. */
export function Slider({ label, value, min, max, step = 0.01, unit, onChange, onCommitStart, onCommitEnd }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = ((value - min) / (max - min)) * 100;

  const setFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const raw = (clientX - rect.left) / rect.width;
      const clamped = Math.min(1, Math.max(0, raw));
      let v = min + clamped * (max - min);
      v = Math.round(v / step) * step;
      onChange(Math.min(max, Math.max(min, v)));
    },
    [min, max, step, onChange],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onCommitStart?.();
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = () => onCommitEnd?.();

  const display = Number.isInteger(step) ? value.toFixed(0) : value.toFixed(2);

  return (
    <div className="oc-slider">
      {(label || unit !== undefined) && (
        <div className="oc-slider__top">
          {label && <span className="oc-slider__label">{label}</span>}
          <span className="oc-slider__value">
            {display}
            {unit ?? ''}
          </span>
        </div>
      )}
      <div
        ref={trackRef}
        className="oc-slider__track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="oc-slider__fill" style={{ width: `${pct}%` }} />
        <div className="oc-slider__thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}

/** Numeric input with drag-to-scrub (grab and slide horizontally). */
export function NumberField({ value, onChange, step = 1, min = -Infinity, max = Infinity, suffix }: NumberFieldProps) {
  const dragging = useRef<{ startX: number; startVal: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = { startX: e.clientX, startVal: value };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = (e.clientX - dragging.current.startX) * step;
    onChange(clamp(Math.round((dragging.current.startVal + delta) / step) * step, min, max));
  };
  const onPointerUp = () => (dragging.current = null);

  return (
    <label className="oc-number" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <input
        type="number"
        value={Number.isFinite(value) ? +value.toFixed(3) : 0}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value) || 0, min, max))}
      />
      {suffix && <span style={{ color: 'var(--text-tertiary)' }}>{suffix}</span>}
    </label>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
