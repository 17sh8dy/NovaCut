/**
 * ToolRail — the vertical tool strip, and the contextual options bar above the canvas.
 *
 * Only tools that actually work are here. The rail is grouped by what a tool *does* — move,
 * select, paint, create — rather than listed flat, because a flat strip of fourteen icons is a
 * lookup table and a grouped one is a menu you can learn.
 *
 * The options bar is the other half of the same idea: instead of a permanent panel of controls
 * that are irrelevant to whatever you are doing, it shows the two or three options that belong
 * to the active tool and nothing else.
 */

import {
  Brush,
  Crop,
  Droplet,
  Eraser,
  Hand,
  Grid3x3,
  Lasso,
  Magnet,
  Maximize2,
  MousePointer2,
  PaintBucket,
  PenTool,
  Ruler,
  Shapes,
  SquareDashed,
  Type,
  Wand,
  ZoomIn,
  ZoomOut,
  Circle,
  ArrowLeftRight,
} from 'lucide-react';
import { SHAPE_KINDS, SHAPE_LABELS, type ShapeKind } from '@opencut/photo';
import { IconButton, Slider } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import type { PhotoTool } from '../../state/photoStore.js';
import { ColorField } from './controls.js';

interface ToolDef {
  id: PhotoTool;
  icon: typeof MousePointer2;
  label: string;
  key: string;
}

/** Groups are rendered with a divider between them. Order is by frequency of use. */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'move', icon: MousePointer2, label: 'Move & Select', key: 'V' },
    { id: 'hand', icon: Hand, label: 'Pan', key: 'H' },
  ],
  [
    { id: 'select-rect', icon: SquareDashed, label: 'Rectangle Select', key: 'M' },
    { id: 'select-ellipse', icon: Circle, label: 'Ellipse Select', key: 'M' },
    { id: 'lasso', icon: Lasso, label: 'Lasso', key: 'L' },
    { id: 'polygon', icon: PenTool, label: 'Polygon Lasso', key: 'L' },
    { id: 'wand', icon: Wand, label: 'Magic Wand', key: 'W' },
  ],
  [
    { id: 'brush', icon: Brush, label: 'Brush', key: 'B' },
    { id: 'eraser', icon: Eraser, label: 'Eraser', key: 'E' },
    { id: 'bucket', icon: PaintBucket, label: 'Paint Bucket', key: 'G' },
    { id: 'gradient', icon: Droplet, label: 'Gradient', key: 'G' },
  ],
  [
    { id: 'text', icon: Type, label: 'Text', key: 'T' },
    { id: 'shape', icon: Shapes, label: 'Shape', key: 'R' },
    { id: 'crop', icon: Crop, label: 'Crop', key: 'C' },
  ],
];

export function ToolRail() {
  const store = usePhotoStore();
  const tool = usePhoto((s) => s.tool);
  const foreground = usePhoto((s) => s.foreground);
  const background = usePhoto((s) => s.background);

  return (
    <div className="oc-rail">
      {TOOL_GROUPS.map((group, i) => (
        <div key={i} className="oc-rail__group">
          {group.map((t) => (
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
      ))}

      {/*
        The colour pair, at the foot of the rail where every editor puts it. Two swatches plus a
        swap, because picking a colour and then wanting the one you had a moment ago is the most
        common colour interaction there is.
      */}
      <div className="oc-rail__colors">
        <input
          className="oc-rail__swatch oc-rail__swatch--fg"
          type="color"
          value={foreground}
          title="Foreground colour"
          onChange={(e) => store.getState().setForeground(e.target.value)}
        />
        <input
          className="oc-rail__swatch oc-rail__swatch--bg"
          type="color"
          value={background}
          title="Background colour"
          onChange={(e) => store.getState().setBackground(e.target.value)}
        />
        <button className="oc-rail__swap" title="Swap colours  (X)" onClick={() => store.getState().swapColors()}>
          <ArrowLeftRight size={11} />
        </button>
      </div>
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
  const brush = usePhoto((s) => s.brush);
  const sample = usePhoto((s) => s.sample);
  const maskMode = usePhoto((s) => s.maskMode);
  const hasMask = usePhoto((s) => !!s.selectedLayer()?.mask);
  const gradientShape = usePhoto((s) => s.gradientShape);

  const setZoom = (next: number) =>
    store.getState().setViewport({ zoom: clamp(next, 0.02, 32), autoFit: false });

  return (
    <div className="oc-options">
      <div className="oc-options__tool">
        {(tool === 'brush' || tool === 'eraser') && (
          <>
            <span className="oc-options__label">Size {Math.round(brush.size)}px</span>
            <div className="oc-options__slider">
              <Slider value={brush.size} min={1} max={600} step={1} unit="px"
                onChange={(size) => store.getState().setBrush({ size })} />
            </div>
            <span className="oc-options__label">Hardness {Math.round(brush.hardness * 100)}%</span>
            <div className="oc-options__slider">
              <Slider value={brush.hardness} min={0} max={1} step={0.01}
                onChange={(hardness) => store.getState().setBrush({ hardness })} />
            </div>
            <span className="oc-options__label">Opacity {Math.round(brush.opacity * 100)}%</span>
            <div className="oc-options__slider">
              <Slider value={brush.opacity} min={0.01} max={1} step={0.01}
                onChange={(opacity) => store.getState().setBrush({ opacity })} />
            </div>
            <MaskToggle maskMode={maskMode} hasMask={hasMask} />
          </>
        )}

        {tool === 'bucket' && (
          <>
            <span className="oc-options__label">Tolerance {Math.round(sample.tolerance * 100)}%</span>
            <div className="oc-options__slider">
              <Slider value={sample.tolerance} min={0} max={1} step={0.01}
                onChange={(tolerance) => store.getState().setSample({ tolerance })} />
            </div>
            <label className="oc-check">
              <input type="checkbox" checked={sample.contiguous}
                onChange={(e) => store.getState().setSample({ contiguous: e.target.checked })} />
              Contiguous
            </label>
            <MaskToggle maskMode={maskMode} hasMask={hasMask} />
          </>
        )}

        {tool === 'gradient' && (
          <>
            <div className="oc-segmented oc-segmented--sm">
              <button data-active={gradientShape === 'linear'} onClick={() => store.getState().setGradient({ shape: 'linear' })}>Linear</button>
              <button data-active={gradientShape === 'radial'} onClick={() => store.getState().setGradient({ shape: 'radial' })}>Radial</button>
            </div>
            <span className="oc-options__hint">Drag across the canvas</span>
            <MaskToggle maskMode={maskMode} hasMask={hasMask} />
          </>
        )}

        {tool === 'wand' && (
          <>
            <span className="oc-options__label">Tolerance {Math.round(sample.tolerance * 100)}%</span>
            <div className="oc-options__slider">
              <Slider value={sample.tolerance} min={0} max={1} step={0.01}
                onChange={(tolerance) => store.getState().setSample({ tolerance })} />
            </div>
            <label className="oc-check">
              <input type="checkbox" checked={sample.contiguous}
                onChange={(e) => store.getState().setSample({ contiguous: e.target.checked })} />
              Contiguous
            </label>
            <span className="oc-options__hint">Shift adds · Alt subtracts</span>
          </>
        )}

        {(tool === 'select-rect' || tool === 'select-ellipse') && (
          <span className="oc-options__hint">Drag a region · Shift adds · Alt subtracts · Shift+drag for a square</span>
        )}
        {tool === 'lasso' && <span className="oc-options__hint">Draw a freehand region · Shift adds · Alt subtracts</span>}
        {tool === 'polygon' && <span className="oc-options__hint">Click to add points · click the first point, or press Enter, to close</span>}

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
        <IconButton title="Fit to window  (Ctrl 0)" onClick={() => store.getState().fitToWindow()}>
          <Maximize2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * "Paint into the mask" — offered only when the selected layer HAS a mask.
 *
 * Showing it always and silently doing nothing would be the worst of both: the user would
 * think they were masking while painting pixels. Disabled with a tooltip that says where the
 * button is instead.
 */
function MaskToggle({ maskMode, hasMask }: { maskMode: boolean; hasMask: boolean }) {
  const store = usePhotoStore();
  return (
    <label
      className={`oc-check oc-check--accent${hasMask ? '' : ' oc-check--disabled'}`}
      title={hasMask ? 'Paint into the layer mask instead of its pixels' : 'Add a mask in the Inspector first'}
    >
      <input
        type="checkbox"
        checked={maskMode && hasMask}
        disabled={!hasMask}
        onChange={() => store.getState().toggleFlag('maskMode')}
      />
      Mask
    </label>
  );
}

/** Re-exported so the inspector's paint section can reuse the same swatch. */
export { ColorField };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
