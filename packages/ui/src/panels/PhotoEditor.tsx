/**
 * PhotoEditor — the photo workspace.
 *
 * Layers on the left, the GPU canvas in the middle, the filter rack on the right. Everything
 * it draws with is shared: the primitives and theme come from the design system, the filters
 * come from core's effect registry, and the canvas is the same WebGL2 compositor the video
 * editor uses. What is photo-specific is only the document it edits.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  ImagePlus,
  Layers as LayersIcon,
  Lock,
  Redo2,
  Trash2,
  Undo2,
  Unlock,
  Wand2,
} from 'lucide-react';
import { allEffects, getEffectDef, type EffectInstance } from '@opencut/core';
import {
  addLayerEffect,
  deleteLayer,
  deleteLayerEffect,
  setEffectEnabled,
  setEffectParam,
  setLayerLocked,
  setLayerOpacity,
  setLayerVisible,
  type Layer,
} from '@opencut/photo';
import { Button, EmptyState, IconButton, Panel, ResizablePanels, Slider } from '../components/primitives/index.js';
import { useAppStore } from '../state/context.js';
import { usePhoto, usePhotoStore } from '../state/photoContext.js';
import { usePhotoEngine, type PhotoEngine } from '../state/usePhotoEngine.js';
import './photo.css';

export function PhotoEditor() {
  const engine = usePhotoEngine();
  return (
    <div className="app-shell">
      <PhotoTitleBar engine={engine} />
      <div className="oc-workspace">
        <ResizablePanels direction="horizontal" initial={[1, 3, 1.2]} min={[220, 360, 260]}>
          <Panel title="Layers">
            <LayersPanel />
          </Panel>
          <Panel title="Canvas">
            <PhotoCanvas engine={engine} />
          </Panel>
          <Panel title="Filters">
            <FilterRack />
          </Panel>
        </ResizablePanels>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Title bar
// ─────────────────────────────────────────────────────────────────────────────

function PhotoTitleBar({ engine }: { engine: PhotoEngine }) {
  const app = useAppStore();
  const store = usePhotoStore();
  const name = usePhoto((s) => s.doc.name);
  const importing = usePhoto((s) => s.importing);
  // Subscribing to `doc` is what re-evaluates the undo/redo buttons: History's canUndo/canRedo
  // are plain getters that React cannot observe, but every edit, undo and redo replaces `doc`,
  // so reading the getters during a doc-driven render keeps them honest.
  const doc = usePhoto((s) => s.doc);
  const canUndo = store.getState().history.canUndo;
  const canRedo = store.getState().history.canRedo;

  const exportPng = async () => {
    const blob = await engine.toPng();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || 'photo'}.png`;
    a.click();
    URL.revokeObjectURL(url);
    app.getState().notify('Exported PNG', 'success', a.download);
  };

  return (
    <div className="oc-titlebar oc-photobar">
      <button className="oc-btn" onClick={() => app.getState().setView('home')} title="Back to Home">
        <ArrowLeft size={16} /> Home
      </button>
      <span className="oc-photobar__name">{name}</span>
      <div className="oc-photobar__spacer" />
      <IconButton onClick={() => store.getState().undo()} disabled={!canUndo} title="Undo">
        <Undo2 size={16} />
      </IconButton>
      <IconButton onClick={() => store.getState().redo()} disabled={!canRedo} title="Redo">
        <Redo2 size={16} />
      </IconButton>
      <Button onClick={() => void store.getState().importImages()} disabled={importing}>
        <ImagePlus size={16} /> {importing ? 'Importing…' : 'Add Image'}
      </Button>
      <Button variant="primary" onClick={() => void exportPng()} disabled={doc.layers.length === 0}>
        <Download size={16} /> Export PNG
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas
// ─────────────────────────────────────────────────────────────────────────────

function PhotoCanvas({ engine }: { engine: PhotoEngine }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const store = usePhotoStore();
  const layerCount = usePhoto((s) => s.doc.layers.length);

  useEffect(() => {
    if (ref.current) engine.attach(ref.current);
  }, [engine]);

  // The canvas stays mounted even with no layers, merely hidden.
  //
  // It must never unmount: attach() binds the compositor to this exact element and is a
  // no-op afterwards, so swapping the canvas out for an empty state would leave the engine
  // holding a detached element — nothing would ever draw. Rendering it conditionally is
  // also why the attach effect saw a null ref and never fired at all.
  //
  // The backing store is the document's pixel size; CSS scales it to fit the panel, so the
  // render stays full-resolution no matter how the window is sized.
  return (
    <div className={`oc-photo-canvas${layerCount === 0 ? ' oc-photo-canvas--empty' : ''}`}>
      <canvas ref={ref} className="oc-photo-canvas__el" hidden={layerCount === 0} />
      {layerCount === 0 && (
        <>
          <EmptyState
            icon={<ImagePlus size={26} />}
            title="No image yet"
            hint="Add an image to start editing."
          />
          <Button variant="primary" onClick={() => void store.getState().importImages()}>
            <ImagePlus size={16} /> Add Image
          </Button>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

function LayersPanel() {
  const store = usePhotoStore();
  const layers = usePhoto((s) => s.doc.layers);
  const selectedId = usePhoto((s) => s.selectedLayerId);

  if (layers.length === 0) {
    return <EmptyState icon={<LayersIcon size={22} />} title="No layers" hint="Add an image to begin." />;
  }

  // Rendered top-first so the list reads the way the image stacks; the model stores
  // bottom-to-top, matching core's Track convention.
  return (
    <div className="oc-layers">
      {[...layers].reverse().map((layer) => (
        <LayerRow
          key={layer.id}
          layer={layer}
          selected={layer.id === selectedId}
          onSelect={() => store.getState().selectLayer(layer.id)}
        />
      ))}
    </div>
  );
}

function LayerRow({ layer, selected, onSelect }: { layer: Layer; selected: boolean; onSelect: () => void }) {
  const store = usePhotoStore();

  return (
    <div className={`oc-layer${selected ? ' oc-layer--selected' : ''}`} onClick={onSelect}>
      <div className="oc-layer__head">
        <IconButton
          title={layer.visible ? 'Hide layer' : 'Show layer'}
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(setLayerVisible(layer.id, !layer.visible));
          }}
        >
          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
        <span className="oc-layer__name" title={layer.name}>
          {layer.name}
        </span>
        <IconButton
          title={layer.locked ? 'Unlock layer' : 'Lock layer'}
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(setLayerLocked(layer.id, !layer.locked));
          }}
        >
          {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </IconButton>
        <IconButton
          title="Delete layer"
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(deleteLayer(layer.id));
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      <Slider
        label="Opacity"
        value={layer.opacity}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => store.getState().dispatch(setLayerOpacity(layer.id, v))}
      />
      {layer.effects.length > 0 && (
        <div className="oc-layer__meta">
          {layer.effects.length} filter{layer.effects.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

function FilterRack() {
  const store = usePhotoStore();
  const layer = usePhoto((s) => s.selectedLayer());
  const [picking, setPicking] = useState(false);

  if (!layer) {
    return <EmptyState icon={<Wand2 size={22} />} title="No layer selected" hint="Pick a layer to filter it." />;
  }

  return (
    <div className="oc-rack">
      <Button onClick={() => setPicking((v) => !v)}>
        <Wand2 size={15} /> Add Filter
      </Button>

      {picking && (
        <div className="oc-rack__picker">
          {allEffects().map((def) => (
            <button
              key={def.type}
              className="oc-rack__pick"
              onClick={() => {
                store.getState().dispatch(addLayerEffect(layer.id, def.type));
                setPicking(false);
              }}
            >
              <span>{def.label}</span>
              <span className="oc-rack__cat">{def.category}</span>
            </button>
          ))}
        </div>
      )}

      {layer.effects.length === 0 ? (
        <EmptyState icon={<Wand2 size={22} />} title="No filters" hint="Filters apply bottom-up." />
      ) : (
        layer.effects.map((fx) => <EffectCard key={fx.id} layerId={layer.id} fx={fx} />)
      )}
    </div>
  );
}

function EffectCard({ layerId, fx }: { layerId: Layer['id']; fx: EffectInstance }) {
  const store = usePhotoStore();
  const def = getEffectDef(fx.type);
  if (!def) return null;

  return (
    <div className={`oc-fx${fx.enabled ? '' : ' oc-fx--off'}`}>
      <div className="oc-fx__head">
        <IconButton
          title={fx.enabled ? 'Disable' : 'Enable'}
          onClick={() => store.getState().dispatch(setEffectEnabled(layerId, fx.id, !fx.enabled))}
        >
          {fx.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <span className="oc-fx__name">{def.label}</span>
        <IconButton
          title="Remove filter"
          onClick={() => store.getState().dispatch(deleteLayerEffect(layerId, fx.id))}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {def.params.map((p) => (
        <Slider
          key={p.key}
          label={p.label}
          value={fx.params[p.key]?.static ?? p.default}
          min={p.min}
          max={p.max}
          step={p.step}
          unit={p.unit}
          onChange={(v) => store.getState().dispatch(setEffectParam(layerId, fx.id, p.key, v))}
        />
      ))}
    </div>
  );
}
