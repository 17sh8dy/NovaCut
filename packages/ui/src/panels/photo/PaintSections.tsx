/**
 * Inspector sections for the paint slice: the brush, the layer mask, and the selection.
 *
 * Split out of `InspectorPanel` rather than appended to it because these three are conditional
 * on *what the user is doing* rather than on what kind of layer is selected — the brush section
 * appears with a paint tool active, the selection section only when something is selected — and
 * mixing that logic into the per-kind switch would make both harder to read.
 */

import {
  Brush as BrushIcon,
  Eye,
  EyeOff,
  Layers,
  SquareDashed,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  BRUSH_PRESETS,
  addMask,
  applyBrushPreset,
  clearPaint,
  deselect,
  invertSelection,
  maskFromSelection,
  removeMask,
  selectAllPixels,
  setMask,
  setSelectionModifier,
  hasSelection,
  type Layer,
} from '@opencut/photo';
import { Button, IconButton, Slider } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import { isPaintTool } from '../../state/photoStore.js';
import { ColorField, Field, Row, Section, Toggle } from './controls.js';

// ─────────────────────────────────────────────────────────────────────────────
// Brush
// ─────────────────────────────────────────────────────────────────────────────

export function BrushSection() {
  const store = usePhotoStore();
  const tool = usePhoto((s) => s.tool);
  const brush = usePhoto((s) => s.brush);
  const foreground = usePhoto((s) => s.foreground);
  const set = (patch: Partial<typeof brush>) => store.getState().setBrush(patch);

  if (!isPaintTool(tool)) return null;

  return (
    <Section title="Brush" icon={<BrushIcon size={14} />}>
      <div className="oc-brushpresets">
        {BRUSH_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="oc-brushpreset"
            title={preset.label}
            onClick={() => store.getState().setBrush(applyBrushPreset(brush, preset))}
          >
            {/*
              The dot previews the brush's actual size and hardness, clamped to the swatch. A
              label alone cannot distinguish "soft round" from "airbrush", which is the entire
              question a brush preset answers.
            */}
            <span
              className="oc-brushpreset__dot"
              style={{
                width: Math.max(4, Math.min(26, preset.settings.size / 4)),
                height: Math.max(4, Math.min(26, preset.settings.size / 4)),
                filter: `blur(${(1 - preset.settings.hardness) * 3}px)`,
                opacity: 0.35 + preset.settings.opacity * 0.65,
              }}
            />
            <span>{preset.label}</span>
          </button>
        ))}
      </div>

      <Field label="Colour">
        <ColorField value={foreground} onChange={(c) => store.getState().setForeground(c)} />
      </Field>

      <Slider label="Size" value={brush.size} min={1} max={600} step={1} unit="px"
        onChange={(size) => set({ size })} />
      <Slider label="Hardness" value={brush.hardness} min={0} max={1} step={0.01}
        onChange={(hardness) => set({ hardness })} />
      <Slider label="Opacity" value={brush.opacity} min={0.01} max={1} step={0.01}
        onChange={(opacity) => set({ opacity })} />
      <Slider label="Flow" value={brush.flow} min={0.01} max={1} step={0.01}
        onChange={(flow) => set({ flow })} />
      <p className="oc-hint">
        Flow is per stamp; opacity caps the whole stroke. Low flow builds up as it overlaps.
      </p>
      <Slider label="Spacing" value={brush.spacing} min={0.01} max={1} step={0.01}
        onChange={(spacing) => set({ spacing })} />
      <Slider label="Smoothing" value={brush.smoothing} min={0} max={1} step={0.01}
        onChange={(smoothing) => set({ smoothing })} />
      <Row>
        <Toggle label="Pressure → size" checked={brush.dynamics.size}
          onChange={(v) => set({ dynamics: { ...brush.dynamics, size: v } })} />
      </Row>
      <Row>
        <Toggle label="Pressure → opacity" checked={brush.dynamics.opacity}
          onChange={(v) => set({ dynamics: { ...brush.dynamics, opacity: v } })} />
      </Row>
      <p className="oc-hint">Pressure needs a pen; a mouse always paints at full.</p>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mask
// ─────────────────────────────────────────────────────────────────────────────

export function MaskSection({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  const selection = usePhoto((s) => s.doc.selection);
  const maskMode = usePhoto((s) => s.maskMode);
  const mask = layer.mask;

  return (
    <Section title="Mask" icon={<Layers size={14} />} defaultOpen={!!mask}>
      {!mask ? (
        <>
          <Row>
            <Button onClick={() => store.getState().dispatch(addMask(layer.id, 'reveal'))}>
              Add Mask
            </Button>
            <Button
              disabled={!hasSelection(selection)}
              onClick={() => store.getState().dispatch(maskFromSelection(layer.id, 'keep'))}
            >
              From Selection
            </Button>
          </Row>
          {/*
            The pitch for the feature, stated where someone would look for a blur brush. This is
            the non-destructive replacement for the dodge/burn/blur brushes that are deliberately
            absent — see the note at the foot of `paintOps.ts`.
          */}
          <p className="oc-hint">
            Add a Blur, Exposure or any adjustment as an effect, then paint its mask — that is
            local blur, dodge and burn, and every setting stays editable.
          </p>
        </>
      ) : (
        <>
          <Row>
            <IconButton
              title={mask.enabled ? 'Disable mask' : 'Enable mask'}
              active={mask.enabled}
              onClick={() => store.getState().dispatch(setMask(layer.id, { enabled: !mask.enabled }))}
            >
              {mask.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
            </IconButton>
            <Toggle
              label="Invert"
              checked={mask.inverted}
              onChange={(inverted) => store.getState().dispatch(setMask(layer.id, { inverted }))}
            />
            <IconButton title="Delete mask" onClick={() => store.getState().dispatch(removeMask(layer.id))}>
              <Trash2 size={14} />
            </IconButton>
          </Row>

          <Toggle
            label="Paint into mask"
            checked={maskMode}
            onChange={() => store.getState().toggleFlag('maskMode')}
          />

          <div className="oc-segmented oc-segmented--sm">
            <button
              data-active={mask.base === 'reveal'}
              onClick={() => store.getState().dispatch(setMask(layer.id, { base: 'reveal' }))}
            >
              Reveal all
            </button>
            <button
              data-active={mask.base === 'hide'}
              onClick={() => store.getState().dispatch(setMask(layer.id, { base: 'hide' }))}
            >
              Hide all
            </button>
          </div>

          <p className="oc-hint">
            {mask.base === 'reveal' ? 'Paint to hide.' : 'Paint to reveal.'} {mask.ops.length} brush step
            {mask.ops.length === 1 ? '' : 's'}.
          </p>

          <Row>
            <Button
              disabled={!hasSelection(selection)}
              onClick={() => store.getState().dispatch(maskFromSelection(layer.id, 'keep'))}
            >
              Replace From Selection
            </Button>
            <Button
              disabled={mask.ops.length === 0}
              onClick={() => store.getState().dispatch(clearPaint(layer.id, 'mask'))}
            >
              Clear Paint
            </Button>
          </Row>
        </>
      )}
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export function SelectionSection() {
  const store = usePhotoStore();
  const selection = usePhoto((s) => s.doc.selection);
  const active = hasSelection(selection);

  return (
    <Section title="Selection" icon={<SquareDashed size={14} />} defaultOpen={active}>
      <Row>
        <Button onClick={() => store.getState().dispatch(selectAllPixels())}>All</Button>
        <Button disabled={!active} onClick={() => store.getState().dispatch(deselect())}>Deselect</Button>
        <Button onClick={() => store.getState().dispatch(invertSelection())}>Invert</Button>
      </Row>

      {active ? (
        <>
          {/*
            Feather and expand modify the FINISHED mask rather than each region, which is why
            they live here and not on the tools: they apply to whatever combination of marquees,
            lassos and wand clicks the user built up.
          */}
          <Slider
            label="Feather"
            value={selection!.feather}
            min={0}
            max={200}
            step={1}
            unit="px"
            onChange={(feather) => store.getState().dispatch(setSelectionModifier({ feather }))}
          />
          <Slider
            label="Expand"
            value={selection!.expand}
            min={-100}
            max={100}
            step={1}
            unit="px"
            onChange={(expand) => store.getState().dispatch(setSelectionModifier({ expand }))}
          />
          <p className="oc-hint">
            <Wand2 size={12} /> {selection!.regions.length} region
            {selection!.regions.length === 1 ? '' : 's'}
            {selection!.inverted ? ' · inverted' : ''}
          </p>
        </>
      ) : (
        <p className="oc-hint">Nothing selected — edits apply everywhere.</p>
      )}
    </Section>
  );
}
