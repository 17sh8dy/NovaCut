/**
 * The photo editor's three dialogs: new canvas, canvas size, and export.
 *
 * Kept together because they are the same idea from three angles — choosing a pixel size — and
 * they share the preset list that makes that choice a click instead of arithmetic.
 */

import { useMemo, useState } from 'react';
import { Check, Download, Ratio } from 'lucide-react';
import {
  CANVAS_PRESETS,
  CANVAS_PRESET_GROUPS,
  applyCanvasSize,
  type CanvasPreset,
} from '@opencut/photo';
import { Button, Modal, Slider } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import type { ExportFormat, PhotoEngine } from '../../state/usePhotoEngine.js';
import { ColorField, Field, Row, Toggle } from './controls.js';
import { useAppStore } from '../../state/context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Preset grid, shared by both size dialogs
// ─────────────────────────────────────────────────────────────────────────────

function PresetGrid({
  selected,
  onPick,
}: {
  selected: { width: number; height: number };
  onPick: (preset: CanvasPreset) => void;
}) {
  return (
    <div className="oc-presetgrid">
      {CANVAS_PRESET_GROUPS.map((group) => (
        <div key={group}>
          <div className="oc-presetgrid__group">{group}</div>
          <div className="oc-presetgrid__items">
            {CANVAS_PRESETS.filter((p) => p.group === group).map((preset) => {
              const active = preset.width === selected.width && preset.height === selected.height;
              return (
                <button
                  key={preset.id}
                  className="oc-presetcard"
                  data-active={active}
                  onClick={() => onPick(preset)}
                >
                  {/* The thumbnail is the preset's real aspect ratio, clamped to the card, so
                      "portrait vs landscape vs ultrawide" is legible without reading numbers. */}
                  <span className="oc-presetcard__ratio">
                    <span
                      style={{
                        aspectRatio: `${preset.width} / ${preset.height}`,
                        maxWidth: '100%',
                        maxHeight: '100%',
                      }}
                    />
                  </span>
                  <span className="oc-presetcard__label">{preset.label}</span>
                  <span className="oc-presetcard__dims">
                    {preset.width} × {preset.height}
                    {preset.hint ? ` · ${preset.hint}` : ''}
                  </span>
                  {active && <Check size={14} className="oc-presetcard__check" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// New canvas
// ─────────────────────────────────────────────────────────────────────────────

export function NewCanvasDialog() {
  const store = usePhotoStore();
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [name, setName] = useState('Untitled');

  const create = () => {
    store.getState().newDocument(name.trim() || 'Untitled', size);
    store.getState().setDialog(null);
  };

  return (
    <Modal
      title="New Canvas"
      maxWidth={760}
      onClose={() => store.getState().setDialog(null)}
      footer={
        <>
          <Button onClick={() => store.getState().setDialog(null)}>Cancel</Button>
          <Button variant="primary" onClick={create}>Create</Button>
        </>
      }
    >
      <Row>
        <Field label="Name">
          <input className="oc-text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="W">
          <input className="oc-num" type="number" value={size.width}
            onChange={(e) => setSize({ ...size, width: clampDim(e.target.value) })} />
        </Field>
        <Field label="H">
          <input className="oc-num" type="number" value={size.height}
            onChange={(e) => setSize({ ...size, height: clampDim(e.target.value) })} />
        </Field>
      </Row>
      <PresetGrid selected={size} onPick={(p) => setSize({ width: p.width, height: p.height })} />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas size
// ─────────────────────────────────────────────────────────────────────────────

export function CanvasSizeDialog() {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const [size, setSize] = useState({ width: doc.width, height: doc.height });
  const [scaleContent, setScaleContent] = useState(true);

  return (
    <Modal
      title="Canvas Size"
      maxWidth={760}
      onClose={() => store.getState().setDialog(null)}
      footer={
        <>
          <Button onClick={() => store.getState().setDialog(null)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              store.getState().dispatch(applyCanvasSize(size.width, size.height, scaleContent));
              store.getState().setViewport({ autoFit: true });
              store.getState().setDialog(null);
            }}
          >
            Resize
          </Button>
        </>
      }
    >
      <Row>
        <Field label="W">
          <input className="oc-num" type="number" value={size.width}
            onChange={(e) => setSize({ ...size, width: clampDim(e.target.value) })} />
        </Field>
        <Field label="H">
          <input className="oc-num" type="number" value={size.height}
            onChange={(e) => setSize({ ...size, height: clampDim(e.target.value) })} />
        </Field>
      </Row>
      {/*
        Scaling content is ON by default because switching preset — thumbnail to banner, say —
        is overwhelmingly the reason anyone opens this. Leaving it off would drop a composition
        built for 1280px into the corner of a 2560px frame every time.
      */}
      <Toggle label="Scale layers to fit the new canvas" checked={scaleContent} onChange={setScaleContent} />
      <PresetGrid selected={size} onPick={(p) => setSize({ width: p.width, height: p.height })} />
    </Modal>
  );
}

const clampDim = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 1;
  // 16384 is the smallest MAX_TEXTURE_SIZE worth targeting; beyond it the render silently
  // clamps and the user gets an export that is not the size they asked for.
  return Math.max(1, Math.min(16384, n));
};

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

const FORMATS: { value: ExportFormat; label: string; ext: string; lossy: boolean; alpha: boolean }[] = [
  { value: 'png', label: 'PNG', ext: 'png', lossy: false, alpha: true },
  { value: 'jpeg', label: 'JPG', ext: 'jpg', lossy: true, alpha: false },
  { value: 'webp', label: 'WebP', ext: 'webp', lossy: true, alpha: true },
];

const SCALES = [0.5, 1, 1.5, 2, 3, 4];

export function ExportPhotoDialog({ engine }: { engine: PhotoEngine }) {
  const store = usePhotoStore();
  const app = useAppStore();
  const doc = usePhoto((s) => s.doc);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState(0.92);
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(true);
  const [matte, setMatte] = useState('#ffffff');
  const [busy, setBusy] = useState(false);

  const spec = FORMATS.find((f) => f.value === format)!;
  // JPEG has no alpha channel at all, so "transparent" would silently mean "composited onto
  // black". Forcing the matte on is the honest behaviour; greying the toggle explains why.
  const canBeTransparent = spec.alpha;
  const effectiveTransparent = transparent && canBeTransparent;

  const out = useMemo(
    () => ({ width: Math.round(doc.width * scale), height: Math.round(doc.height * scale) }),
    [doc.width, doc.height, scale],
  );

  const run = async () => {
    setBusy(true);
    try {
      const blob = await engine.exportImage({
        format,
        quality,
        scale,
        transparent: effectiveTransparent,
        matte,
      });
      if (!blob) {
        app.getState().notify('Export failed', 'error', 'The canvas could not be encoded.');
        return;
      }
      // A download rather than a native save dialog: the bridge's file APIs are built around
      // the video encoder's streaming contract, and a still is a single blob. An anchor
      // download works identically on desktop and web, which is also the point of the bridge.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitize(doc.name)}${scale === 1 ? '' : `@${scale}x`}.${spec.ext}`;
      a.click();
      URL.revokeObjectURL(url);
      app.getState().notify('Exported', 'success', `${a.download} · ${formatBytes(blob.size)}`);
      store.getState().setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export"
      maxWidth={520}
      onClose={() => store.getState().setDialog(null)}
      footer={
        <>
          <Button onClick={() => store.getState().setDialog(null)}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            <Download size={15} /> {busy ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <Field label="Format">
        <div className="oc-segmented">
          {FORMATS.map((f) => (
            <button key={f.value} data-active={format === f.value} onClick={() => setFormat(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Scale">
        <div className="oc-segmented">
          {SCALES.map((s) => (
            <button key={s} data-active={scale === s} onClick={() => setScale(s)}>
              {s}×
            </button>
          ))}
        </div>
      </Field>

      <p className="oc-hint">
        <Ratio size={12} /> Output {out.width} × {out.height} px
      </p>

      {spec.lossy && (
        <Slider label="Quality" value={quality} min={0.3} max={1} step={0.01} onChange={setQuality} />
      )}

      <Toggle
        label={canBeTransparent ? 'Transparent background' : 'Transparent background (JPG has no alpha)'}
        checked={effectiveTransparent}
        onChange={(v) => canBeTransparent && setTransparent(v)}
      />
      {!effectiveTransparent && (
        <Field label="Background">
          <ColorField value={matte} onChange={setMatte} />
        </Field>
      )}

      {/*
        No metadata to strip: the canvas is composited from scratch by the renderer and encoded
        by `toBlob`, which writes no EXIF, no GPS and no source-file provenance. Saying so is
        more useful than a checkbox that does nothing.
      */}
      <p className="oc-hint">Exports carry no EXIF or location metadata.</p>
    </Modal>
  );
}

const sanitize = (name: string): string => name.replace(/[^\w\-. ]+/g, '').trim() || 'photo';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
