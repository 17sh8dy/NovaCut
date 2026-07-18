/**
 * PhotoEditor — the photo workspace.
 *
 * Layers on the left, the GPU canvas in the middle, the inspector on the right. Everything it
 * draws with is shared: the primitives and theme come from the design system, the filters come
 * from core's effect registry, and the canvas is the engine's photo render graph. What is
 * photo-specific is only the document it edits.
 *
 * The layers panel renders the document's TREE, not a list, and renders it top-first — the
 * model stores bottom-to-top (matching core's Track convention) but every layers panel in every
 * editor reads top-down, because that is the order the pixels stack.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Download,
  Eye,
  EyeOff,
  FlipHorizontal,
  FlipVertical,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Layers as LayersIcon,
  Lock,
  Move,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Unlock,
  Wand2,
} from 'lucide-react';
import { allEffects, getEffectDef, type EffectInstance } from '@opencut/core';
import {
  BLEND_GROUPS,
  BLEND_LABELS,
  addAdjustmentLayer,
  addLayerEffect,
  deleteLayer,
  deleteLayerEffect,
  duplicateLayer,
  flipLayer,
  isAdjustmentLayer,
  isGroupLayer,
  resetLayerTransform,
  setAdjustmentParam,
  setEffectEnabled,
  setEffectParam,
  setGroupCollapsed,
  setLayerBlendMode,
  setLayerClipped,
  setLayerLocked,
  setLayerOpacity,
  setLayerTransform,
  setLayerVisible,
  ungroup,
  type BlendMode,
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
        <ResizablePanels direction="horizontal" initial={[1, 3, 1.2]} min={[240, 360, 280]}>
          <Panel title="Layers">
            <LayersPanel />
          </Panel>
          <Panel title="Canvas">
            <PhotoCanvas engine={engine} />
          </Panel>
          <Panel title="Inspector">
            <Inspector />
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
  // It must never unmount: attach() binds the renderer to this exact element and is a no-op
  // afterwards, so swapping the canvas out for an empty state would leave the engine holding a
  // detached element — nothing would ever draw. Rendering it conditionally is also why the
  // attach effect saw a null ref and never fired at all.
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
  const [picking, setPicking] = useState(false);

  return (
    <div className="oc-layers">
      <div className="oc-layers__tools">
        <Button onClick={() => setPicking((v) => !v)} disabled={layers.length === 0}>
          <SlidersHorizontal size={15} /> Adjustment
        </Button>
      </div>

      {/*
        Adjustment layers are offered from the LAYERS panel, not the filter rack, because that
        is what they are: a layer that re-colours everything beneath it. Putting them with the
        filters would imply they belong to the selected layer, which is the one thing they
        specifically do not do.
      */}
      {picking && (
        <div className="oc-rack__picker">
          {allEffects()
            .filter((def) => def.category === 'color' || def.category === 'stylize')
            .map((def) => (
              <button
                key={def.type}
                className="oc-rack__pick"
                onClick={() => {
                  store.getState().dispatch(addAdjustmentLayer(def.type));
                  setPicking(false);
                }}
              >
                <span>{def.label}</span>
                <span className="oc-rack__cat">{def.category}</span>
              </button>
            ))}
        </div>
      )}

      {layers.length === 0 ? (
        <EmptyState icon={<LayersIcon size={22} />} title="No layers" hint="Add an image to begin." />
      ) : (
        <LayerList layers={layers} selectedId={selectedId} depth={0} />
      )}
    </div>
  );
}

/** Recursive: renders one sibling list top-first, descending into open groups. */
function LayerList({
  layers,
  selectedId,
  depth,
}: {
  layers: readonly Layer[];
  selectedId: string | null;
  depth: number;
}) {
  return (
    <>
      {[...layers].reverse().map((layer) => (
        <div key={layer.id}>
          <LayerRow layer={layer} selected={layer.id === selectedId} depth={depth} />
          {isGroupLayer(layer) && !layer.collapsed && layer.children.length > 0 && (
            <LayerList layers={layer.children} selectedId={selectedId} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}

function LayerRow({ layer, selected, depth }: { layer: Layer; selected: boolean; depth: number }) {
  const store = usePhotoStore();

  const icon = isGroupLayer(layer) ? (
    layer.collapsed ? <Folder size={14} /> : <FolderOpen size={14} />
  ) : isAdjustmentLayer(layer) ? (
    <SlidersHorizontal size={14} />
  ) : (
    <ImageIcon size={14} />
  );

  return (
    <div
      className={`oc-layer${selected ? ' oc-layer--selected' : ''}${layer.clipped ? ' oc-layer--clipped' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => store.getState().selectLayer(layer.id)}
    >
      <div className="oc-layer__head">
        {isGroupLayer(layer) ? (
          <IconButton
            title={layer.collapsed ? 'Expand group' : 'Collapse group'}
            onClick={(e) => {
              e.stopPropagation();
              store.getState().dispatch(setGroupCollapsed(layer.id, !layer.collapsed));
            }}
          >
            {layer.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </IconButton>
        ) : (
          <span className="oc-layer__twisty" />
        )}
        <IconButton
          title={layer.visible ? 'Hide layer' : 'Show layer'}
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(setLayerVisible(layer.id, !layer.visible));
          }}
        >
          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
        {/* The clip arrow is how Photoshop signals "masked by the layer below" — a right-angle
            elbow pointing down at the base. Keeping the same glyph means no one has to learn it. */}
        {layer.clipped && <CornerDownRight size={13} className="oc-layer__clipmark" />}
        <span className="oc-layer__icon">{icon}</span>
        <span className="oc-layer__name" title={layer.name}>
          {layer.name}
        </span>
        {isGroupLayer(layer) && (
          <IconButton
            title="Ungroup"
            onClick={(e) => {
              e.stopPropagation();
              store.getState().dispatch(ungroup(layer.id));
            }}
          >
            <FolderOpen size={14} />
          </IconButton>
        )}
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
      {selected && (
        <div className="oc-layer__controls">
          <BlendModeSelect layer={layer} />
          <Slider
            label="Opacity"
            value={layer.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => store.getState().dispatch(setLayerOpacity(layer.id, v))}
          />
          <label className="oc-layer__check">
            <input
              type="checkbox"
              checked={layer.clipped}
              onChange={(e) => store.getState().dispatch(setLayerClipped(layer.id, e.target.checked))}
            />
            Clip to layer below
          </label>
        </div>
      )}
      {layer.effects.length > 0 && (
        <div className="oc-layer__meta">
          {layer.effects.length} filter{layer.effects.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function BlendModeSelect({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  return (
    <select
      className="oc-select"
      value={layer.blendMode}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => store.getState().dispatch(setLayerBlendMode(layer.id, e.target.value as BlendMode))}
    >
      {/* BLEND_GROUPS is the model's canonical listing, in Photoshop's own menu order. Rendering
          it verbatim — separators and all — is what keeps a 27-item dropdown navigable. */}
      {BLEND_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.modes.map((mode) => (
            <option key={mode} value={mode}>
              {BLEND_LABELS[mode]}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspector — transform, adjustment params, filter rack
// ─────────────────────────────────────────────────────────────────────────────

function Inspector() {
  const layer = usePhoto((s) => s.selectedLayer());
  if (!layer) {
    return <EmptyState icon={<Wand2 size={22} />} title="No layer selected" hint="Pick a layer to edit it." />;
  }
  return (
    <div className="oc-rack">
      <TransformSection layer={layer} />
      {isAdjustmentLayer(layer) && <AdjustmentSection layer={layer} />}
      <FilterRack layer={layer} />
    </div>
  );
}

function TransformSection({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  const t = layer.transform;
  const doc = usePhoto((s) => s.doc);
  const set = (patch: Parameters<typeof setLayerTransform>[1]) =>
    store.getState().dispatch(setLayerTransform(layer.id, patch));

  return (
    <div className="oc-section">
      <div className="oc-section__head">
        <Move size={14} /> <span>Transform</span>
        <div className="oc-section__spacer" />
        <IconButton title="Reset transform" onClick={() => store.getState().dispatch(resetLayerTransform(layer.id))}>
          <RotateCcw size={13} />
        </IconButton>
        <IconButton title="Flip horizontal" onClick={() => store.getState().dispatch(flipLayer(layer.id, 'h'))}>
          <FlipHorizontal size={13} />
        </IconButton>
        <IconButton title="Flip vertical" onClick={() => store.getState().dispatch(flipLayer(layer.id, 'v'))}>
          <FlipVertical size={13} />
        </IconButton>
      </div>
      {/* Ranges are the canvas's own dimensions, so a layer can always be dragged fully off
          either edge but no further — an unbounded slider is unusable at photo resolutions. */}
      <Slider label="X" value={t.x} min={-doc.width} max={doc.width} step={1} unit="px"
        onChange={(v) => set({ x: v })} />
      <Slider label="Y" value={t.y} min={-doc.height} max={doc.height} step={1} unit="px"
        onChange={(v) => set({ y: v })} />
      <Slider label="Scale X" value={t.scaleX} min={0.05} max={4} step={0.01}
        onChange={(v) => set({ scaleX: v })} />
      <Slider label="Scale Y" value={t.scaleY} min={0.05} max={4} step={0.01}
        onChange={(v) => set({ scaleY: v })} />
      <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={0.5} unit="°"
        onChange={(v) => set({ rotation: v })} />
    </div>
  );
}

/** An adjustment layer's params live on `layer.adjustment`, not in the per-layer filter stack. */
function AdjustmentSection({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  if (!isAdjustmentLayer(layer)) return null;
  const def = getEffectDef(layer.adjustment.type);
  // A document can outlive the registry entry that made it (an unloaded plugin, a removed
  // built-in). Say so instead of rendering an empty panel.
  if (!def) {
    return (
      <div className="oc-section">
        <div className="oc-section__head">
          <SlidersHorizontal size={14} /> <span>Adjustment</span>
        </div>
        <div className="oc-layer__meta">Unknown adjustment “{layer.adjustment.type}” — not installed.</div>
      </div>
    );
  }

  return (
    <div className="oc-section">
      <div className="oc-section__head">
        <SlidersHorizontal size={14} /> <span>{def.label}</span>
      </div>
      {def.params.map((p) => (
        <Slider
          key={p.key}
          label={p.label}
          value={layer.adjustment.params[p.key]?.static ?? p.default}
          min={p.min}
          max={p.max}
          step={p.step}
          unit={p.unit}
          onChange={(v) => store.getState().dispatch(setAdjustmentParam(layer.id, p.key, v))}
        />
      ))}
    </div>
  );
}

function FilterRack({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  const [picking, setPicking] = useState(false);

  // An adjustment layer's whole purpose IS its effect; a second stack on top of it would be a
  // confusing duplicate of the layer beneath it.
  if (isAdjustmentLayer(layer)) return null;

  return (
    <div className="oc-section">
      <div className="oc-section__head">
        <Wand2 size={14} /> <span>Filters</span>
        <div className="oc-section__spacer" />
        <IconButton title="Duplicate layer" onClick={() => store.getState().dispatch(duplicateLayer(layer.id))}>
          <ImagePlus size={13} />
        </IconButton>
      </div>

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
