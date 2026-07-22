/**
 * ToolRail — the vertical tool strip, and the contextual options bar above the canvas.
 *
 * Only tools that actually work are here. A rail padded out with greyed-out brush, lasso and
 * magic-wand icons would promise a paint engine and a selection model that do not exist yet;
 * five real tools is a better product than twelve advertisements.
 *
 * The options bar is the other half of the same idea: instead of a permanent panel of controls
 * that are irrelevant to whatever you are doing, the toolbar shows the two or three options
 * that belong to the active tool and nothing else.
 */

import {
  Crop,
  Grid3x3,
  Hand,
  Magnet,
  Maximize2,
  MousePointer2,
  Ruler,
  Shapes,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { SHAPE_KINDS, SHAPE_LABELS, type ShapeKind } from '@opencut/photo';
import { IconButton } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import type { PhotoTool } from '../../state/photoStore.js';

const TOOLS: { id: PhotoTool; icon: typeof MousePointer2; label: string; key: string }[] = [
  { id: 'move', icon: MousePointer2, label: 'Move & Select', key: 'V' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'shape', icon: Shapes, label: 'Shape', key: 'R' },
  { id: 'crop', icon: Crop, label: 'Crop', key: 'C' },
  { id: 'hand', icon: Hand, label: 'Pan', key: 'H' },
];

export function ToolRail() {
  const store = usePhotoStore();
  const tool = usePhoto((s) => s.tool);
  return (
    <div className="oc-rail">
      {TOOLS.map((t) => (
        <IconButton
          key={t.id}
          title={`${t.label}  (${t.key})`}
          active={tool === t.id}
          onClick={() => store.getState().setTool(t.id)}
        >
          <t.icon size={17} />
        </IconButton>
      ))}
    </div>
  );
}

/**
 * The bar between the toolbar and the canvas: tool options on the left, view controls right.
 */
export function OptionsBar() {
  const store = usePhotoStore();
  const tool = usePhoto((s) => s.tool);
  const shapeKind = usePhoto((s) => s.shapeKind);
  const zoom = usePhoto((s) => s.viewport.zoom);
  const showRulers = usePhoto((s) => s.showRulers);
  const snapping = usePhoto((s) => s.snapping);
  const showGuides = usePhoto((s) => s.showGuides);

  const setZoom = (next: number) =>
    store.getState().setViewport({ zoom: clamp(next, 0.02, 32), autoFit: false });

  return (
    <div className="oc-options">
      <div className="oc-options__tool">
        {tool === 'shape' && (
          <>
            <span className="oc-options__label">Shape</span>
            <select
              className="oc-select oc-select--inline"
              value={shapeKind}
              onChange={(e) => store.getState().setShapeKind(e.target.value as ShapeKind)}
            >
              {SHAPE_KINDS.map((k) => (
                <option key={k} value={k}>{SHAPE_LABELS[k]}</option>
              ))}
            </select>
            <span className="oc-options__hint">Drag on the canvas · Shift for a square</span>
          </>
        )}
        {tool === 'text' && <span className="oc-options__hint">Click the canvas to place text · Double-click any text to edit</span>}
        {tool === 'crop' && <span className="oc-options__hint">Drag a crop region · Shift for a square · release to apply</span>}
        {tool === 'move' && <span className="oc-options__hint">Shift-click to multi-select · Alt-click to reach inside a group</span>}
        {tool === 'hand' && <span className="oc-options__hint">Drag to pan · hold Space with any tool</span>}
      </div>

      <div className="oc-options__view">
        <IconButton title="Rulers" active={showRulers} onClick={() => store.getState().toggleFlag('showRulers')}>
          <Ruler size={15} />
        </IconButton>
        <IconButton title="Smart guides" active={showGuides} onClick={() => store.getState().toggleFlag('showGuides')}>
          <Grid3x3 size={15} />
        </IconButton>
        <IconButton title="Snapping" active={snapping} onClick={() => store.getState().toggleFlag('snapping')}>
          <Magnet size={15} />
        </IconButton>
        <span className="oc-options__sep" />
        <IconButton title="Zoom out  (Ctrl -)" onClick={() => setZoom(zoom / 1.25)}>
          <ZoomOut size={15} />
        </IconButton>
        <button className="oc-zoomlabel" title="Reset to 100%  (Ctrl 1)" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <IconButton title="Zoom in  (Ctrl +)" onClick={() => setZoom(zoom * 1.25)}>
          <ZoomIn size={15} />
        </IconButton>
        <IconButton title="Fit to window  (Ctrl 0)" onClick={() => store.getState().setViewport({ autoFit: true })}>
          <Maximize2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
