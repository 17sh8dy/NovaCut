/**
 * Small inspector controls shared across the photo panels.
 *
 * These are photo-specific and deliberately not promoted into the design system: a colour
 * swatch that knows about `Fill` unions and a paint section that knows about strokes and glows
 * are vocabulary of this editor, not of the app. When the video side grows a colour picker,
 * *that* is the moment to lift the primitive — not before, on the guess that it will.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DEFAULT_GLOW,
  DEFAULT_SHADOW,
  DEFAULT_STROKE,
  normalizeHex,
  SOLID,
  type Fill,
  type Glow,
  type Shadow,
  type Stroke,
} from '@opencut/photo';
import { IconButton, Slider } from '../../components/primitives/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/** A collapsible titled block. Collapsed state is local — it is a glance, not a preference. */
export function Section({
  title,
  icon,
  actions,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`oc-sect${open ? '' : ' oc-sect--closed'}`}>
      <header className="oc-sect__head">
        <button className="oc-sect__toggle" onClick={() => setOpen((v) => !v)} title={open ? 'Collapse' : 'Expand'}>
          <ChevronDown size={14} className="oc-sect__chev" />
          {icon}
          <span>{title}</span>
        </button>
        {actions && <div className="oc-sect__actions">{actions}</div>}
      </header>
      {open && <div className="oc-sect__body">{children}</div>}
    </section>
  );
}

/** A labelled row. The label column is fixed so stacked rows line up down the panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="oc-field">
      <span className="oc-field__label">{label}</span>
      <div className="oc-field__control">{children}</div>
    </label>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="oc-row">{children}</div>;
}

/** A switch that also carries the label, for optional decorations (stroke, shadow, glow). */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="oc-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="oc-toggle__track" aria-hidden />
      <span className="oc-toggle__label">{label}</span>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A colour swatch with a hex field.
 *
 * The native picker handles the actual choosing — it is the OS one, it has an eyedropper on
 * every platform that matters, and reimplementing a colour wheel would be a worse version of
 * something the user already knows. The hex field exists because designers paste hex codes far
 * more often than they pick colours by eye.
 *
 * The text field keeps its own draft state while focused: rewriting the input from the model on
 * every keystroke would make `#ff` unparseable-then-normalized-to-black under the user's cursor
 * before they finish typing.
 */
export function ColorField({
  value,
  onChange,
  title,
}: {
  value: string;
  onChange: (hex: string) => void;
  title?: string;
}) {
  const hex = normalizeHex(value, '#000000');
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft === null) return;
    // A model change from elsewhere (a preset, an undo) must win over a stale draft.
    if (document.activeElement !== inputRef.current) setDraft(null);
  }, [value, draft]);

  return (
    <div className="oc-color" title={title}>
      <input
        className="oc-color__swatch"
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        ref={inputRef}
        className="oc-color__hex"
        value={draft ?? hex}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = normalizeHex(e.target.value, '');
          if (next) onChange(next);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill
// ─────────────────────────────────────────────────────────────────────────────

const FILL_KINDS: { value: Fill['kind']; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
];

/**
 * Edit a `Fill`.
 *
 * Switching kind CONVERTS rather than resets: solid → gradient seeds the ramp from the solid
 * colour, gradient → solid keeps the first stop. Anyone who has lost a carefully picked colour
 * to a radio button knows why.
 */
export function FillEditor({ value, onChange }: { value: Fill; onChange: (f: Fill) => void }) {
  const setKind = (kind: Fill['kind']) => {
    if (kind === value.kind) return;
    if (kind === 'solid') {
      onChange(SOLID(value.kind === 'solid' ? value.color : value.stops[0]?.color ?? '#ffffff'));
      return;
    }
    const stops =
      value.kind === 'solid'
        ? [{ offset: 0, color: value.color }, { offset: 1, color: shade(value.color) }]
        : value.stops;
    onChange(kind === 'linear' ? { kind: 'linear', angle: 90, stops } : { kind: 'radial', radius: 1, stops });
  };

  return (
    <div className="oc-fill">
      <div className="oc-segmented oc-segmented--sm">
        {FILL_KINDS.map((k) => (
          <button key={k.value} data-active={value.kind === k.value} onClick={() => setKind(k.value)}>
            {k.label}
          </button>
        ))}
      </div>

      {value.kind === 'solid' ? (
        <ColorField value={value.color} onChange={(color) => onChange({ kind: 'solid', color })} />
      ) : (
        <>
          {value.stops.map((stop, i) => (
            <Row key={i}>
              <ColorField
                value={stop.color}
                onChange={(color) =>
                  onChange({ ...value, stops: value.stops.map((s, j) => (j === i ? { ...s, color } : s)) })
                }
              />
              <input
                className="oc-num"
                type="number"
                min={0}
                max={100}
                value={Math.round(stop.offset * 100)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    stops: value.stops.map((s, j) =>
                      j === i ? { ...s, offset: clamp01(Number(e.target.value) / 100) } : s,
                    ),
                  })
                }
              />
            </Row>
          ))}
          {value.kind === 'linear' ? (
            <Slider
              label="Angle"
              value={value.angle}
              min={0}
              max={360}
              step={1}
              unit="°"
              onChange={(angle) => onChange({ ...value, angle })}
            />
          ) : (
            <Slider
              label="Spread"
              value={value.radius}
              min={0.1}
              max={2}
              step={0.01}
              onChange={(radius) => onChange({ ...value, radius })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** A darker partner colour, so a one-click gradient starts out looking like a gradient. */
function shade(hex: string): string {
  const h = normalizeHex(hex, '#ffffff').slice(1);
  const n = parseInt(h, 16);
  const dim = (v: number) => Math.max(0, Math.round(v * 0.55));
  const r = dim((n >> 16) & 255);
  const g = dim((n >> 8) & 255);
  const b = dim(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

// ─────────────────────────────────────────────────────────────────────────────
// Stroke / shadow / glow
// ─────────────────────────────────────────────────────────────────────────────

const ALIGNS: Stroke['align'][] = ['inside', 'center', 'outside'];

export function StrokeEditor({
  value,
  onChange,
  allowInside = true,
}: {
  value: Stroke | null;
  onChange: (s: Stroke | null) => void;
  /** Text has no clip path, so an inside stroke would silently render centred. Hide it. */
  allowInside?: boolean;
}) {
  return (
    <>
      <Toggle label="Stroke" checked={!!value} onChange={(on) => onChange(on ? { ...DEFAULT_STROKE } : null)} />
      {value && (
        <>
          <Row>
            <ColorField value={value.color} onChange={(color) => onChange({ ...value, color })} />
            <div className="oc-segmented oc-segmented--sm">
              {ALIGNS.filter((a) => allowInside || a !== 'inside').map((a) => (
                <button key={a} data-active={value.align === a} onClick={() => onChange({ ...value, align: a })}>
                  {a[0]!.toUpperCase() + a.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Slider
            label="Width"
            value={value.width}
            min={0}
            max={160}
            step={0.5}
            unit="px"
            onChange={(width) => onChange({ ...value, width })}
          />
        </>
      )}
    </>
  );
}

export function ShadowEditor({ value, onChange }: { value: Shadow | null; onChange: (s: Shadow | null) => void }) {
  return (
    <>
      <Toggle label="Shadow" checked={!!value} onChange={(on) => onChange(on ? { ...DEFAULT_SHADOW } : null)} />
      {value && (
        <>
          <ColorField value={value.color} onChange={(color) => onChange({ ...value, color })} />
          <Slider label="Blur" value={value.blur} min={0} max={200} step={1} unit="px"
            onChange={(blur) => onChange({ ...value, blur })} />
          <Slider label="Offset X" value={value.offsetX} min={-200} max={200} step={1} unit="px"
            onChange={(offsetX) => onChange({ ...value, offsetX })} />
          <Slider label="Offset Y" value={value.offsetY} min={-200} max={200} step={1} unit="px"
            onChange={(offsetY) => onChange({ ...value, offsetY })} />
          <Slider label="Opacity" value={value.opacity} min={0} max={1} step={0.01}
            onChange={(opacity) => onChange({ ...value, opacity })} />
        </>
      )}
    </>
  );
}

export function GlowEditor({ value, onChange }: { value: Glow | null; onChange: (g: Glow | null) => void }) {
  return (
    <>
      <Toggle label="Glow" checked={!!value} onChange={(on) => onChange(on ? { ...DEFAULT_GLOW } : null)} />
      {value && (
        <>
          <ColorField value={value.color} onChange={(color) => onChange({ ...value, color })} />
          <Slider label="Size" value={value.blur} min={0} max={200} step={1} unit="px"
            onChange={(blur) => onChange({ ...value, blur })} />
          <Slider label="Intensity" value={value.intensity} min={0} max={1} step={0.01}
            onChange={(intensity) => onChange({ ...value, intensity })} />
        </>
      )}
    </>
  );
}

/** A compact icon button row, for alignment and ordering clusters. */
export function ButtonGroup({ children }: { children: ReactNode }) {
  return <div className="oc-bgroup">{children}</div>;
}

export { IconButton };
