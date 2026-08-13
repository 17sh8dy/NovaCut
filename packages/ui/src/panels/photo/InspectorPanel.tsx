/**
 * InspectorPanel — everything about the selected layer.
 *
 * Contextual by layer kind, not a fixed stack of sections that are empty most of the time: a
 * text layer shows type controls, a shape shows geometry, an adjustment shows its own params.
 * Only Transform, Blend and the filter rack are universal, because only those apply to every
 * kind.
 *
 * Ordering is by how often a control is reached for, not by how the model is structured. For a
 * thumbnail that means the text content and its stroke sit above the transform, which is the
 * reverse of what a model-shaped panel would produce.
 */

import { useMemo, useState } from 'react';
import {
  AlignCenter,
  Brush,
  Eraser,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  Blend,
  Droplet,
  FlipHorizontal,
  FlipVertical,
  FlipVertical2,
  Frame,
  Move,
  Search,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Star,
  Type,
  Wand2,
  Eye,
  EyeOff,
  Trash2,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import {
  allTools,
  getEffectDef,
  packColor,
  unpackColor,
  type EffectInstance,
  type EffectParamDef,
} from '@opencut/core';
import {
  BLEND_GROUPS,
  BLEND_LABELS,
  CURATED_FONTS,
  FONT_GROUPS,
  SHAPE_KINDS,
  SHAPE_LABELS,
  TEXT_PRESETS,
  addLayerEffect,
  alignLayers,
  clearPaint,
  applyTextPreset,
  deleteLayerEffect,
  flipCanvas,
  flipLayer,
  isAdjustmentLayer,
  isShapeLayer,
  isTextLayer,
  moveLayerEffect,
  resetLayerTransform,
  rotateCanvas,
  setAdjustmentParam,
  setEffectEnabled,
  setEffectParam,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerPaint,
  setLayerTransform,
  setShapeKind,
  setShapeParams,
  setShapeSize,
  setTextBoxWidth,
  setTextStyle,
  type BlendMode,
  type Layer,
  type ShapeKind,
} from '@opencut/photo';
import { Button, EmptyState, IconButton, Slider } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import {
  ButtonGroup,
  ColorField,
  Field,
  FillEditor,
  GlowEditor,
  Row,
  Section,
  ShadowEditor,
  StrokeEditor,
  Toggle,
} from './controls.js';
import { naturalSizeOf } from './layerGeometry.js';
import { BrushSection, MaskSection, SelectionSection } from './PaintSections.js';

export function InspectorPanel() {
  const layer = usePhoto((s) => s.selectedLayer());
  const selectionCount = usePhoto((s) => s.selection.length);

  if (!layer) {
    return (
      <div className="oc-inspector">
        {/* The brush, the selection and the canvas belong to the DOCUMENT, not to a layer, so
            they stay reachable even with nothing selected — which is exactly when a user is most
            likely to be building a selection or squaring up the frame. */}
        <BrushSection />
        <SelectionSection />
        <CanvasSection />
        <EmptyState icon={<Wand2 size={22} />} title="No layer selected" hint="Pick a layer to edit it." />
      </div>
    );
  }

  return (
    <div className="oc-inspector">
      <BrushSection />
      {selectionCount > 1 && <AlignSection />}
      {isTextLayer(layer) && <TextSections layer={layer} />}
      {isShapeLayer(layer) && <ShapeSections layer={layer} />}
      {isAdjustmentLayer(layer) && <AdjustmentSection layer={layer} />}
      {layer.kind === 'raster' && <PaintLayerSection layer={layer} />}
      <SelectionSection />
      <MaskSection layer={layer} />
      <TransformSection layer={layer} />
      <CanvasSection />
      <BlendSection layer={layer} />
      {!isAdjustmentLayer(layer) && <FilterRack layer={layer} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas orientation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rotate and flip the whole canvas.
 *
 * It sits directly under Transform, and that adjacency is the point: Transform turns the
 * SELECTED LAYER inside a fixed frame, this turns the FRAME and everything in it. Those are the
 * two things a person means by "rotate", they are one row apart, and each says which it is —
 * which is cheaper than explaining the difference after someone has rotated the wrong one.
 *
 * Collapsed by default when a layer is selected would hide it; it stays open because the reason
 * this section exists at all is that canvas rotation was previously unreachable.
 */
function CanvasSection() {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const natural = (l: Layer) => naturalSizeOf(l, doc);
  const turn = (turns: 1 | 2 | 3) => store.getState().dispatch(rotateCanvas(turns, natural));
  const mirror = (axis: 'h' | 'v') => store.getState().dispatch(flipCanvas(axis, natural));

  return (
    <Section title="Canvas" icon={<Frame size={14} />}>
      <p className="oc-hint">
        {doc.width} × {doc.height} px — rotating turns the frame and everything on it.
      </p>
      <ButtonGroup>
        {/* No accelerators: Ctrl+[ / Ctrl+] already reorder layers, and Photoshop leaves canvas
            rotation unbound for the same reason — it is a once-per-document action. */}
        <IconButton title="Rotate canvas 90° left" onClick={() => turn(3)}>
          <RotateCcw size={15} />
        </IconButton>
        <IconButton title="Rotate canvas 90° right" onClick={() => turn(1)}>
          <RotateCw size={15} />
        </IconButton>
        <IconButton title="Rotate canvas 180°" onClick={() => turn(2)}>
          <FlipVertical2 size={15} />
        </IconButton>
        <IconButton title="Flip canvas horizontal" onClick={() => mirror('h')}>
          <FlipHorizontal size={15} />
        </IconButton>
        <IconButton title="Flip canvas vertical" onClick={() => mirror('v')}>
          <FlipVertical size={15} />
        </IconButton>
      </ButtonGroup>
    </Section>
  );
}

/**
 * A paint layer's own section: what is on it, and how to take it back off.
 *
 * The op count is not decoration — a paint layer's cost is its op list, and "clear" being one
 * step rather than N undos is the difference between experimenting and committing.
 */
function PaintLayerSection({ layer }: { layer: Extract<Layer, { kind: 'raster' }> }) {
  const store = usePhotoStore();
  return (
    <Section title="Paint" icon={<Brush size={14} />}>
      <p className="oc-hint">
        {layer.ops.length} step{layer.ops.length === 1 ? '' : 's'} · {layer.width} × {layer.height}
      </p>
      <Button disabled={layer.ops.length === 0} onClick={() => store.getState().dispatch(clearPaint(layer.id, 'layer'))}>
        <Eraser size={15} /> Clear Layer
      </Button>
      <p className="oc-hint">Every stroke stays a separate, undoable step.</p>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment (multi-selection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alignment only appears with more than one layer selected, because with one layer it means
 * something different — align to the canvas — and a control that silently changes meaning is
 * worse than two controls. The single-layer version lives on the transform section.
 */
function AlignSection() {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const selection = usePhoto((s) => s.selection);
  const align = (edge: Parameters<typeof alignLayers>[1]) =>
    store.getState().dispatch(alignLayers(selection, edge, (l) => naturalSizeOf(l, doc)));

  return (
    <Section title={`${selection.length} layers`} icon={<AlignHorizontalJustifyCenter size={14} />}>
      <ButtonGroup>
        <IconButton title="Align left" onClick={() => align('left')}><AlignLeft size={15} /></IconButton>
        <IconButton title="Align centre" onClick={() => align('hcenter')}><AlignHorizontalJustifyCenter size={15} /></IconButton>
        <IconButton title="Align right" onClick={() => align('right')}><AlignRight size={15} /></IconButton>
        <IconButton title="Align top" onClick={() => align('top')}><AlignLeft size={15} style={{ transform: 'rotate(90deg)' }} /></IconButton>
        <IconButton title="Align middle" onClick={() => align('vcenter')}><AlignVerticalJustifyCenter size={15} /></IconButton>
        <IconButton title="Align bottom" onClick={() => align('bottom')}><AlignRight size={15} style={{ transform: 'rotate(90deg)' }} /></IconButton>
      </ButtonGroup>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

function TextSections({ layer }: { layer: Extract<Layer, { kind: 'text' }> }) {
  const store = usePhotoStore();
  const style = layer.style;
  const set = (patch: Parameters<typeof setTextStyle>[1]) =>
    store.getState().dispatch(setTextStyle(layer.id, patch));
  const paint = (patch: Parameters<typeof setLayerPaint>[1]) =>
    store.getState().dispatch(setLayerPaint(layer.id, patch));

  return (
    <>
      <Section title="Presets" icon={<Sparkles size={14} />} defaultOpen>
        <div className="oc-presets">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="oc-preset"
              title={preset.label}
              onClick={() => store.getState().dispatch(applyTextPreset(layer.id, preset.style))}
            >
              <span
                className="oc-preset__sample"
                style={{
                  fontFamily: preset.style.fontFamily,
                  fontWeight: preset.style.fontWeight,
                  fontStyle: preset.style.italic ? 'italic' : undefined,
                  textTransform: preset.style.transform === 'uppercase' ? 'uppercase' : undefined,
                }}
              >
                {preset.sample ?? 'Aa'}
              </span>
              <span className="oc-preset__label">{preset.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Type" icon={<Type size={14} />}>
        <FontPicker value={style.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
        <Row>
          <select
            className="oc-select"
            value={style.fontWeight}
            onChange={(e) => set({ fontWeight: Number(e.target.value) })}
          >
            {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
              <option key={w} value={w}>{WEIGHT_LABELS[w] ?? w}</option>
            ))}
          </select>
          <div className="oc-segmented oc-segmented--sm">
            <button data-active={style.align === 'left'} onClick={() => set({ align: 'left' })} title="Align left">
              <AlignLeft size={14} />
            </button>
            <button data-active={style.align === 'center'} onClick={() => set({ align: 'center' })} title="Align centre">
              <AlignCenter size={14} />
            </button>
            <button data-active={style.align === 'right'} onClick={() => set({ align: 'right' })} title="Align right">
              <AlignRight size={14} />
            </button>
          </div>
        </Row>
        <Slider label="Size" value={style.fontSize} min={8} max={900} step={1} unit="px"
          onChange={(fontSize) => set({ fontSize })} />
        <Slider label="Letter Spacing" value={style.letterSpacing} min={-40} max={120} step={0.5} unit="px"
          onChange={(letterSpacing) => set({ letterSpacing })} />
        <Slider label="Line Height" value={style.lineHeight} min={0.6} max={3} step={0.01}
          onChange={(lineHeight) => set({ lineHeight })} />
        <Row>
          <Toggle label="Italic" checked={style.italic} onChange={(italic) => set({ italic })} />
          <Toggle
            label="UPPER"
            checked={style.transform === 'uppercase'}
            onChange={(on) => set({ transform: on ? 'uppercase' : 'none' })}
          />
        </Row>
        {/* Wrapping is opt-in: a headline should follow its words until the user says otherwise,
            which is exactly what a null box width means. */}
        <Toggle
          label="Wrap to width"
          checked={layer.boxWidth !== null}
          onChange={(on) => store.getState().dispatch(setTextBoxWidth(layer.id, on ? 600 : null))}
        />
        {layer.boxWidth !== null && (
          <Slider label="Box Width" value={layer.boxWidth} min={40} max={4000} step={1} unit="px"
            onChange={(w) => store.getState().dispatch(setTextBoxWidth(layer.id, w))} />
        )}
      </Section>

      <Section title="Paint" icon={<Droplet size={14} />}>
        <Field label="Fill">
          <FillEditor value={style.fill} onChange={(fill) => paint({ fill })} />
        </Field>
        <StrokeEditor value={style.stroke} onChange={(stroke) => paint({ stroke })} allowInside={false} />
        <ShadowEditor value={style.shadow} onChange={(shadow) => paint({ shadow })} />
        <GlowEditor value={style.glow} onChange={(glow) => paint({ glow })} />
      </Section>

      <Section title="Warp" icon={<Star size={14} />} defaultOpen={false}>
        <Slider label="Curve" value={style.curve} min={-100} max={100} step={1}
          onChange={(curve) => set({ curve })} />
        <Slider label="Slant" value={style.skew} min={-45} max={45} step={0.5} unit="°"
          onChange={(skew) => set({ skew })} />
        <p className="oc-hint">Curve applies to single-line text.</p>
      </Section>
    </>
  );
}

const WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black',
};

/**
 * Font picker with search and favourites.
 *
 * Favourites live in local storage rather than the document: which fonts a person reaches for
 * is a property of the person, not of the file, and a shared file that reordered someone else's
 * font list would be actively hostile.
 *
 * The list is virtual-free on purpose — the curated set is ~90 families and the installed set is
 * filtered by the search box before it renders, so the DOM never holds more than a screenful
 * plus change. Adding virtualisation here would be complexity paid for nothing.
 */
function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites());
  const [system, setSystem] = useState<string[]>([]);

  // Ask the platform what is actually installed, once, when the picker first opens. It is a
  // permission-gated call in browsers and a no-op where unsupported, so the curated list has to
  // stand on its own — which is why it is curated rather than aspirational.
  const loadSystem = async () => {
    if (system.length > 0) return;
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
      if (!q) return;
      const fonts = await q();
      setSystem([...new Set(fonts.map((f) => f.family))]);
    } catch {
      /* denied or unsupported — the curated list is the fallback, by design */
    }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...new Set([...CURATED_FONTS, ...system])];
    const match = (f: string) => !q || f.toLowerCase().includes(q);
    const out: { label: string; families: string[] }[] = [];
    const favs = favorites.filter(match);
    if (favs.length) out.push({ label: 'Favourites', families: favs });
    for (const g of FONT_GROUPS) {
      const families = g.families.filter(match);
      if (families.length) out.push({ label: g.label, families: [...families] });
    }
    const installed = all
      .filter((f) => !CURATED_FONTS.includes(f) && match(f))
      .sort((a, b) => a.localeCompare(b));
    if (installed.length) out.push({ label: 'Installed', families: installed });
    return out;
  }, [query, favorites, system]);

  const toggleFavorite = (family: string) => {
    const next = favorites.includes(family) ? favorites.filter((f) => f !== family) : [...favorites, family];
    setFavorites(next);
    writeFavorites(next);
  };

  return (
    <div className="oc-fontpicker">
      <button
        className="oc-fontpicker__current"
        style={{ fontFamily: value }}
        onClick={() => {
          setOpen((v) => !v);
          void loadSystem();
        }}
      >
        {value}
      </button>
      {open && (
        <div className="oc-fontpicker__pop">
          <div className="oc-fontpicker__search">
            <Search size={14} />
            <input
              autoFocus
              placeholder="Search fonts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="oc-fontpicker__list">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="oc-fontpicker__group">{g.label}</div>
                {g.families.map((family) => (
                  <div key={`${g.label}:${family}`} className="oc-fontpicker__row">
                    <button
                      className="oc-fontpicker__pick"
                      style={{ fontFamily: family }}
                      data-active={family === value}
                      onClick={() => {
                        onChange(family);
                        setOpen(false);
                      }}
                    >
                      {family}
                    </button>
                    <button
                      className="oc-fontpicker__star"
                      data-active={favorites.includes(family)}
                      title={favorites.includes(family) ? 'Remove favourite' : 'Add favourite'}
                      onClick={() => toggleFavorite(family)}
                    >
                      <Star size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="oc-hint">No fonts match “{query}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const FAV_KEY = 'opencut.photo.fontFavorites';
function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function writeFavorites(list: string[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    /* non-fatal; favourites are a convenience */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

function ShapeSections({ layer }: { layer: Extract<Layer, { kind: 'shape' }> }) {
  const store = usePhotoStore();
  const paint = (patch: Parameters<typeof setLayerPaint>[1]) =>
    store.getState().dispatch(setLayerPaint(layer.id, patch));

  // Which knobs mean anything depends on the shape. Showing a "Points" slider on a rectangle
  // is not harmless — it teaches the user that the panel does not know what it is editing.
  const usesCorner = layer.shape === 'rounded-rectangle' || layer.shape === 'speech-bubble' || layer.shape === 'callout';
  const usesPoints = layer.shape === 'star' || layer.shape === 'polygon';
  const usesThickness = layer.shape === 'arrow' || layer.shape === 'chevron';
  const usesTail = layer.shape === 'speech-bubble' || layer.shape === 'callout';

  return (
    <>
      <Section title="Shape" icon={<Shapes size={14} />}>
        <select
          className="oc-select"
          value={layer.shape}
          onChange={(e) => store.getState().dispatch(setShapeKind(layer.id, e.target.value as ShapeKind))}
        >
          {SHAPE_KINDS.map((k) => (
            <option key={k} value={k}>{SHAPE_LABELS[k]}</option>
          ))}
        </select>
        <Row>
          <Field label="W">
            <input
              className="oc-num"
              type="number"
              value={Math.round(layer.width)}
              onChange={(e) => store.getState().dispatch(setShapeSize(layer.id, Number(e.target.value), layer.height))}
            />
          </Field>
          <Field label="H">
            <input
              className="oc-num"
              type="number"
              value={Math.round(layer.height)}
              onChange={(e) => store.getState().dispatch(setShapeSize(layer.id, layer.width, Number(e.target.value)))}
            />
          </Field>
        </Row>
        {usesCorner && (
          <Slider label="Corner Radius" value={layer.params.cornerRadius} min={0} max={400} step={1} unit="px"
            onChange={(cornerRadius) => store.getState().dispatch(setShapeParams(layer.id, { cornerRadius }))} />
        )}
        {usesPoints && (
          <>
            <Slider label="Points" value={layer.params.points} min={3} max={24} step={1}
              onChange={(points) => store.getState().dispatch(setShapeParams(layer.id, { points }))} />
            {layer.shape === 'star' && (
              <Slider label="Inner Radius" value={layer.params.innerRatio} min={0.05} max={1} step={0.01}
                onChange={(innerRatio) => store.getState().dispatch(setShapeParams(layer.id, { innerRatio }))} />
            )}
          </>
        )}
        {usesThickness && (
          <>
            <Slider label="Thickness" value={layer.params.thickness} min={0.05} max={1} step={0.01}
              onChange={(thickness) => store.getState().dispatch(setShapeParams(layer.id, { thickness }))} />
            {layer.shape === 'arrow' && (
              <Slider label="Head Size" value={layer.params.headSize} min={0.1} max={1.5} step={0.01}
                onChange={(headSize) => store.getState().dispatch(setShapeParams(layer.id, { headSize }))} />
            )}
          </>
        )}
        {usesTail && (
          <>
            <Slider label="Tail X" value={layer.params.tailX} min={-0.5} max={1.5} step={0.01}
              onChange={(tailX) => store.getState().dispatch(setShapeParams(layer.id, { tailX }))} />
            <Slider label="Tail Y" value={layer.params.tailY} min={-0.8} max={2.2} step={0.01}
              onChange={(tailY) => store.getState().dispatch(setShapeParams(layer.id, { tailY }))} />
          </>
        )}
      </Section>

      <Section title="Paint" icon={<Droplet size={14} />}>
        <Field label="Fill">
          <FillEditor value={layer.fill} onChange={(fill) => paint({ fill })} />
        </Field>
        <StrokeEditor value={layer.stroke} onChange={(stroke) => paint({ stroke })} />
        <ShadowEditor value={layer.shadow} onChange={(shadow) => paint({ shadow })} />
        <GlowEditor value={layer.glow} onChange={(glow) => paint({ glow })} />
      </Section>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform & blend
// ─────────────────────────────────────────────────────────────────────────────

function TransformSection({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const t = layer.transform;
  const set = (patch: Parameters<typeof setLayerTransform>[1]) =>
    store.getState().dispatch(setLayerTransform(layer.id, patch));
  const align = (edge: Parameters<typeof alignLayers>[1]) =>
    store.getState().dispatch(alignLayers([layer.id], edge, (l) => naturalSizeOf(l, doc)));

  return (
    <Section
      title="Transform"
      icon={<Move size={14} />}
      actions={
        <>
          <IconButton title="Reset transform" onClick={() => store.getState().dispatch(resetLayerTransform(layer.id))}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton title="Flip horizontal" onClick={() => store.getState().dispatch(flipLayer(layer.id, 'h'))}>
            <FlipHorizontal size={13} />
          </IconButton>
          <IconButton title="Flip vertical" onClick={() => store.getState().dispatch(flipLayer(layer.id, 'v'))}>
            <FlipVertical size={13} />
          </IconButton>
        </>
      }
    >
      <Row>
        <Field label="X">
          <input className="oc-num" type="number" value={Math.round(t.x)}
            onChange={(e) => set({ x: Number(e.target.value) })} />
        </Field>
        <Field label="Y">
          <input className="oc-num" type="number" value={Math.round(t.y)}
            onChange={(e) => set({ y: Number(e.target.value) })} />
        </Field>
      </Row>
      <Slider label="Scale X" value={t.scaleX} min={0.05} max={6} step={0.01}
        onChange={(scaleX) => set({ scaleX })} />
      <Slider label="Scale Y" value={t.scaleY} min={0.05} max={6} step={0.01}
        onChange={(scaleY) => set({ scaleY })} />
      <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={0.5} unit="°"
        onChange={(rotation) => set({ rotation })} />
      {/* Quarter turns, because the slider is for choosing an angle and these are for the two
          angles nobody wants to aim at. Snapped to the grid rather than added to the current
          value, so a layer nudged to 3° squares up instead of landing on 93°. */}
      <ButtonGroup>
        <IconButton title="Rotate layer 90° left" onClick={() => set({ rotation: quarterTurn(t.rotation, -1) })}>
          <RotateCcw size={15} />
        </IconButton>
        <IconButton title="Rotate layer 90° right" onClick={() => set({ rotation: quarterTurn(t.rotation, 1) })}>
          <RotateCw size={15} />
        </IconButton>
      </ButtonGroup>
      <ButtonGroup>
        <IconButton title="Centre horizontally on canvas" onClick={() => align('hcenter')}>
          <AlignHorizontalJustifyCenter size={15} />
        </IconButton>
        <IconButton title="Centre vertically on canvas" onClick={() => align('vcenter')}>
          <AlignVerticalJustifyCenter size={15} />
        </IconButton>
        <IconButton title="Align left edge" onClick={() => align('left')}><AlignLeft size={15} /></IconButton>
        <IconButton title="Align right edge" onClick={() => align('right')}><AlignRight size={15} /></IconButton>
      </ButtonGroup>
    </Section>
  );
}

/**
 * The next multiple of 90° in `dir`, kept inside the slider's −180..180.
 *
 * Snapping rather than adding: a layer sitting at 3° from a hand-drag should square up on the
 * first click, not travel to 93° and need a second one. From an exact multiple it advances a
 * full quarter turn, which is what makes repeated clicks spin it.
 */
function quarterTurn(deg: number, dir: 1 | -1): number {
  const step = dir > 0 ? Math.floor(deg / 90) + 1 : Math.ceil(deg / 90) - 1;
  const next = (((step * 90 + 180) % 360) + 360) % 360 - 180;
  return next === -180 ? 180 : next === 0 ? 0 : next;
}

function BlendSection({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  return (
    <Section title="Blend" icon={<Blend size={14} />}>
      <select
        className="oc-select"
        value={layer.blendMode}
        onChange={(e) => store.getState().dispatch(setLayerBlendMode(layer.id, e.target.value as BlendMode))}
      >
        {/* BLEND_GROUPS is the model's canonical listing, in Photoshop's own menu order.
            Rendering it verbatim — separators and all — is what keeps 27 items navigable. */}
        {BLEND_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.modes.map((mode) => (
              <option key={mode} value={mode}>{BLEND_LABELS[mode]}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <Slider label="Opacity" value={layer.opacity} min={0} max={1} step={0.01}
        onChange={(v) => store.getState().dispatch(setLayerOpacity(layer.id, v))} />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Adjustments & filters
// ─────────────────────────────────────────────────────────────────────────────

function AdjustmentSection({ layer }: { layer: Extract<Layer, { kind: 'adjustment' }> }) {
  const store = usePhotoStore();
  const def = getEffectDef(layer.adjustment.type);
  // A document can outlive the registry entry that made it (an unloaded plugin, a removed
  // built-in). Say so instead of rendering an empty panel.
  if (!def) {
    return (
      <Section title="Adjustment" icon={<SlidersHorizontal size={14} />}>
        <p className="oc-hint">Unknown adjustment “{layer.adjustment.type}” — not installed.</p>
      </Section>
    );
  }
  return (
    <Section title={def.label} icon={<SlidersHorizontal size={14} />}>
      {def.params.map((p) => (
        <ParamControl
          key={p.key}
          def={p}
          value={layer.adjustment.params[p.key]?.static ?? p.default}
          onChange={(v) => store.getState().dispatch(setAdjustmentParam(layer.id, p.key, v))}
        />
      ))}
    </Section>
  );
}

/**
 * One effect param.
 *
 * Colour params are numbers everywhere in the pipeline — packed into a float so they can ride
 * the same uniform path as everything else (see `packColor` in core). This is the only place
 * that unpacks them, which is exactly the boundary that design was drawn at.
 */
function ParamControl({
  def,
  value,
  onChange,
}: {
  def: EffectParamDef;
  value: number;
  onChange: (v: number) => void;
}) {
  if (def.kind === 'color') {
    return (
      <Field label={def.label}>
        <ColorField value={unpackColor(value)} onChange={(hex) => onChange(packColor(hex))} />
      </Field>
    );
  }
  return (
    <Slider
      label={def.label}
      value={value}
      min={def.min}
      max={def.max}
      step={def.step}
      unit={def.unit}
      onChange={onChange}
    />
  );
}

function FilterRack({ layer }: { layer: Layer }) {
  const store = usePhotoStore();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const effects = useMemo(() => {
    const q = query.trim().toLowerCase();
    // `allTools()`, not `allEffects()`: the latter now also carries the thirty one-click film
    // looks, which belong on their own shelf rather than buried in a picker of adjustment tools.
    return allTools()
      // `time` effects are meaningless on a still — a speed ramp has no frames to ramp. Hiding
      // them beats offering a filter that provably does nothing.
      .filter((d) => d.category !== 'time')
      .filter((d) => !q || d.label.toLowerCase().includes(q) || d.category.includes(q));
  }, [query]);

  return (
    <Section
      title="Effects"
      icon={<Wand2 size={14} />}
      actions={<span className="oc-sect__count">{layer.effects.length || ''}</span>}
    >
      <Button onClick={() => setPicking((v) => !v)}>
        <Wand2 size={15} /> Add Effect
      </Button>

      {picking && (
        <div className="oc-picker">
          <div className="oc-picker__search">
            <Search size={14} />
            <input autoFocus placeholder="Search effects" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="oc-picker__list">
            {effects.map((def) => (
              <button
                key={def.type}
                className="oc-picker__item"
                onClick={() => {
                  store.getState().dispatch(addLayerEffect(layer.id, def.type));
                  setPicking(false);
                  setQuery('');
                }}
              >
                <span>{def.label}</span>
                <span className="oc-picker__cat">{def.category}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {layer.effects.length === 0 ? (
        <p className="oc-hint">No effects. They apply bottom-up and stay editable.</p>
      ) : (
        layer.effects.map((fx, i) => (
          <EffectCard
            key={fx.id}
            layerId={layer.id}
            fx={fx}
            index={i}
            count={layer.effects.length}
          />
        ))
      )}
    </Section>
  );
}

function EffectCard({
  layerId,
  fx,
  index,
  count,
}: {
  layerId: Layer['id'];
  fx: EffectInstance;
  index: number;
  count: number;
}) {
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
          title="Move up"
          disabled={index === count - 1}
          onClick={() => store.getState().dispatch(moveLayerEffect(layerId, fx.id, index + 1))}
        >
          <ChevronUp size={14} />
        </IconButton>
        <IconButton
          title="Move down"
          disabled={index === 0}
          onClick={() => store.getState().dispatch(moveLayerEffect(layerId, fx.id, index - 1))}
        >
          <ChevronDown size={14} />
        </IconButton>
        <IconButton title="Remove" onClick={() => store.getState().dispatch(deleteLayerEffect(layerId, fx.id))}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {def.params.map((p) => (
        <ParamControl
          key={p.key}
          def={p}
          value={fx.params[p.key]?.static ?? p.default}
          onChange={(v) => store.getState().dispatch(setEffectParam(layerId, fx.id, p.key, v))}
        />
      ))}
    </div>
  );
}
