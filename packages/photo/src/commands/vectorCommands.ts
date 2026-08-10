/**
 * Commands for the drawn layers — text and shapes — plus the canvas-level operations that
 * only make sense once a document has more than one layer (align, distribute, canvas presets,
 * crop).
 *
 * Split out of `photoCommands.ts` rather than appended to it because that file was already the
 * whole editor's command surface and these are a self-contained family: everything here is
 * about layers whose pixels the app *draws*, and about arranging them.
 *
 * Same two rules as its sibling, and for the same reasons:
 *   • **Never throw** — `apply` runs inside History.dispatch, where a throw is a UI crash.
 *   • **Never bake pixels** — a shape stays geometry, text stays text, forever.
 */

import type { Command } from '@opencut/core';
import { cloneFill, createShapeLayer, createTextLayer } from '../model/factory.js';
import {
  applyMat, baseSize, boundsOf, layerCorners, layerMatrix,
  type Point, type Rect, type Size,
} from '../model/geometry.js';
import type { LayerId } from '../model/ids.js';
import type { Fill, Glow, Shadow, Stroke } from '../model/paint.js';
import type { Selection, SelectionRegion } from '../model/selection.js';
import type { ShapeKind, ShapeParams } from '../model/shapes.js';
import type { TextStyle } from '../model/text.js';
import { findLayer, flattenLayers } from '../model/tree.js';
import type { Layer, PhotoDocument, ShapeLayer, TextLayer, Transform2D } from '../model/types.js';
import { fitModeOf, isShapeLayer, isTextLayer } from '../model/types.js';
import { addLayer, updateLayer } from './mutations.js';

type PhotoCommand = Command<PhotoDocument>;

// ─────────────────────────────────────────────────────────────────────────────
// Creating drawn layers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a text layer, sized for THIS canvas.
 *
 * The preset's font size is authored against a 1280px-wide thumbnail and scaled by the
 * canvas's width here. Without that, the same preset lands as a readable headline on a
 * thumbnail and as an illegible speck on a 4K wallpaper — the single most common way a
 * preset library stops being useful the moment canvas sizes vary.
 */
export function addTextLayer(
  content = 'Your text',
  style: Partial<TextStyle> = {},
  at?: { x: number; y: number },
): PhotoCommand {
  return {
    label: 'Add Text',
    apply: (doc) => {
      const layer = createTextLayer(content, { ...style, fontSize: scaleForCanvas(style.fontSize ?? 96, doc) });
      return addLayer(doc, at ? { ...layer, transform: { ...layer.transform, ...at } } : layer);
    },
  };
}

export function addShapeLayer(
  shape: ShapeKind,
  opts: {
    name?: string;
    width?: number;
    height?: number;
    fill?: Fill;
    stroke?: Stroke | null;
    shadow?: Shadow | null;
    glow?: Glow | null;
    params?: Partial<ShapeParams>;
    at?: { x: number; y: number };
  } = {},
): PhotoCommand {
  return {
    label: 'Add Shape',
    apply: (doc) => {
      const k = canvasScale(doc);
      const width = (opts.width ?? 400) * k;
      const height = (opts.height ?? 260) * k;
      const layer = createShapeLayer(shape, width, height, {
        ...opts,
        // Stroke and shadow are in pixels too, so they scale with everything else — a preset
        // whose 10px outline stayed 10px on a 4K canvas would read as a hairline.
        stroke: opts.stroke ? { ...opts.stroke, width: opts.stroke.width * k } : opts.stroke ?? null,
        shadow: opts.shadow
          ? { ...opts.shadow, blur: opts.shadow.blur * k, offsetX: opts.shadow.offsetX * k, offsetY: opts.shadow.offsetY * k }
          : opts.shadow ?? null,
        glow: opts.glow ? { ...opts.glow, blur: opts.glow.blur * k } : opts.glow ?? null,
        params: scaleParams(opts.params, k),
      });
      return addLayer(doc, opts.at ? { ...layer, transform: { ...layer.transform, ...opts.at } } : layer);
    },
  };
}

/** Presets are authored against a 1280px-wide canvas; everything else scales from there. */
const PRESET_CANVAS_WIDTH = 1280;
const canvasScale = (doc: PhotoDocument): number =>
  Math.max(0.15, Math.min(6, doc.width / PRESET_CANVAS_WIDTH));
const scaleForCanvas = (size: number, doc: PhotoDocument): number =>
  Math.round(size * canvasScale(doc));

/** Only the pixel-valued shape params scale; counts and ratios are unitless. */
function scaleParams(params: Partial<ShapeParams> | undefined, k: number): Partial<ShapeParams> | undefined {
  if (!params) return params;
  return params.cornerRadius === undefined ? params : { ...params, cornerRadius: params.cornerRadius * k };
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace a text layer's content. Coalesced per layer so typing is ONE undo step, not one per
 * keystroke — the difference between an undo stack that is useful and one that is a keylogger.
 *
 * The layer's name follows the text while the user has not renamed it by hand, which is what
 * every design tool does and what makes a layers panel of five text layers legible.
 */
export function setTextContent(layerId: LayerId, content: string): PhotoCommand {
  return {
    label: 'Edit Text',
    coalesceKey: `text:${layerId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!isTextLayer(l) || l.content === content) return l;
        const autoNamed = l.name === autoName(l.content);
        return { ...l, content, ...(autoNamed ? { name: autoName(content) } : {}) };
      }),
  };
}

const autoName = (content: string): string => {
  const line = content.split('\n')[0]?.trim() ?? '';
  if (!line) return 'Text';
  return line.length > 28 ? `${line.slice(0, 28)}…` : line;
};

/**
 * Patch a text layer's style.
 *
 * `coalesceKey` keys on the CHANGED FIELDS, not just the layer: dragging font size then
 * dragging letter spacing should be two undo steps, while dragging font size for three
 * seconds should be one. Keying on the layer alone would merge every consecutive style edit
 * into a single unwindable blob.
 */
export function setTextStyle(layerId: LayerId, patch: Partial<TextStyle>): PhotoCommand {
  const keys = Object.keys(patch).sort().join(',');
  return {
    label: 'Text Style',
    coalesceKey: `textstyle:${layerId}:${keys}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!isTextLayer(l)) return l;
        const next: TextStyle = { ...l.style, ...patch };
        if (shallowSameStyle(next, l.style)) return l;
        return { ...l, style: next };
      }),
  };
}

/** Set (or clear, with null) the wrap width. Null means "size to the longest line". */
export function setTextBoxWidth(layerId: LayerId, boxWidth: number | null): PhotoCommand {
  const w = boxWidth === null ? null : Math.max(16, Math.round(boxWidth));
  return {
    label: 'Text Box Width',
    coalesceKey: `textbox:${layerId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => (!isTextLayer(l) || l.boxWidth === w ? l : { ...l, boxWidth: w })),
  };
}

/** Apply a whole preset look, keeping the layer's own size and position. */
export function applyTextPreset(layerId: LayerId, style: Partial<TextStyle>): PhotoCommand {
  return {
    label: 'Text Preset',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!isTextLayer(l)) return l;
        const merged: TextStyle = { ...l.style, ...style };
        return {
          ...l,
          style: {
            ...merged,
            // Deep-copy anything the preset supplied: a preset object is shared across every
            // layer that ever used it, and a later inspector edit must not reach back into it.
            fill: cloneFill(merged.fill),
            stroke: merged.stroke ? { ...merged.stroke } : null,
            shadow: merged.shadow ? { ...merged.shadow } : null,
            glow: merged.glow ? { ...merged.glow } : null,
          },
        };
      }),
  };
}

/**
 * Field-by-field comparison, because History's junk-undo guard is a reference check.
 *
 * The nested objects (fill, stroke, …) are compared by reference on purpose: every command
 * that touches them replaces them wholesale, so an identical reference genuinely means
 * unchanged, and a deep compare would just be a slower way to reach the same answer.
 */
function shallowSameStyle(a: TextStyle, b: TextStyle): boolean {
  return (Object.keys(a) as (keyof TextStyle)[]).every((k) => a[k] === b[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing shapes
// ─────────────────────────────────────────────────────────────────────────────

export function setShapeKind(layerId: LayerId, shape: ShapeKind): PhotoCommand {
  return {
    label: 'Shape',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => (!isShapeLayer(l) || l.shape === shape ? l : { ...l, shape })),
  };
}

/** Resize a shape's geometry box (not its transform scale — see `ShapeLayer`'s doc). */
export function setShapeSize(layerId: LayerId, width: number, height: number): PhotoCommand {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return {
    label: 'Shape Size',
    coalesceKey: `shapesize:${layerId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) =>
        !isShapeLayer(l) || (l.width === w && l.height === h) ? l : { ...l, width: w, height: h },
      ),
  };
}

export function setShapeParams(layerId: LayerId, patch: Partial<ShapeParams>): PhotoCommand {
  const keys = Object.keys(patch).sort().join(',');
  return {
    label: 'Shape Options',
    coalesceKey: `shapeparams:${layerId}:${keys}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!isShapeLayer(l)) return l;
        const params = { ...l.params, ...patch };
        const same = (Object.keys(params) as (keyof ShapeParams)[]).every((k) => params[k] === l.params[k]);
        return same ? l : { ...l, params };
      }),
  };
}

/**
 * Patch the paint on a drawn layer — one command for both kinds.
 *
 * Text keeps its paint under `style`, shapes keep it at the top level, because a text stroke
 * is part of a *character style* while a shape stroke is a property of the shape. That is the
 * right modelling and it makes the inspector's paint section awkward, so this command absorbs
 * the difference in one place rather than every call site branching on the layer kind.
 */
export interface PaintPatch {
  fill?: Fill;
  stroke?: Stroke | null;
  shadow?: Shadow | null;
  glow?: Glow | null;
}

export function setLayerPaint(layerId: LayerId, patch: PaintPatch): PhotoCommand {
  const keys = Object.keys(patch).sort().join(',');
  return {
    label: 'Paint',
    coalesceKey: `paint:${layerId}:${keys}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (isTextLayer(l)) {
          const style = { ...l.style, ...patch };
          return sameKeys(patch, l.style) ? l : ({ ...l, style } as TextLayer);
        }
        if (isShapeLayer(l)) {
          return sameKeys(patch, l) ? l : ({ ...l, ...patch } as ShapeLayer);
        }
        return l;
      }),
  };
}

const sameKeys = (patch: PaintPatch, target: object): boolean =>
  (Object.keys(patch) as (keyof PaintPatch)[]).every(
    (k) => patch[k] === (target as Record<string, unknown>)[k],
  );

// ─────────────────────────────────────────────────────────────────────────────
// Canvas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Change the canvas size, keeping the composition centred.
 *
 * Layer positions are stored relative to the canvas CENTRE, so a pure resize already keeps
 * everything centred with no per-layer edit — which is exactly why that convention was chosen.
 * `scaleContent` additionally scales each layer so a composition built for a thumbnail fills a
 * banner; without it, switching preset leaves the artwork the wrong size in a bigger frame.
 */
export function applyCanvasSize(
  width: number,
  height: number,
  scaleContent = false,
): PhotoCommand {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return {
    label: 'Canvas Size',
    apply: (doc) => {
      if (doc.width === w && doc.height === h) return doc;
      if (!scaleContent) return { ...doc, width: w, height: h, modifiedAt: Date.now() };
      // One uniform factor, not two: scaling x and y independently would distort every layer
      // whenever the aspect ratio changes, which is most preset switches.
      const k = Math.min(w / doc.width, h / doc.height);
      const scaleLayer = (l: Layer): Layer => {
        const next: Layer = {
          ...l,
          transform: { ...l.transform, x: l.transform.x * k, y: l.transform.y * k },
        };
        if (next.kind === 'group') return { ...next, children: next.children.map(scaleLayer) };
        // Vector layers are placed pixel-exact, so their geometry must scale too; bitmaps are
        // aspect-fitted to the canvas and re-fit on their own.
        if (next.kind === 'shape') {
          return { ...next, width: next.width * k, height: next.height * k };
        }
        if (next.kind === 'text') {
          return {
            ...next,
            style: { ...next.style, fontSize: next.style.fontSize * k },
            boxWidth: next.boxWidth === null ? null : next.boxWidth * k,
          };
        }
        return next;
      };
      return { ...doc, width: w, height: h, layers: doc.layers.map(scaleLayer), modifiedAt: Date.now() };
    },
  };
}

/**
 * Crop to a rectangle in canvas pixels.
 *
 * Non-destructive, like everything else here: the canvas shrinks and every layer shifts by the
 * crop's offset from the old centre. Pixels outside the new frame are not deleted — widen the
 * canvas again and they come back, which is the behaviour that makes a mis-drag recoverable.
 */
export function cropCanvas(rect: Rect): PhotoCommand {
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    label: 'Crop',
    apply: (doc) => {
      if (x === 0 && y === 0 && w === doc.width && h === doc.height) return doc;
      const dx = doc.width / 2 - (x + w / 2);
      const dy = doc.height / 2 - (y + h / 2);
      const shift = (l: Layer): Layer => ({
        ...l,
        transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy },
      });
      return {
        ...doc,
        width: w,
        height: h,
        // Only ROOT layers shift: a child's transform is relative to its group, which has
        // already moved. Shifting descendants too would double the offset for every nesting
        // level, so a layer two groups deep would fly off the canvas.
        layers: doc.layers.map(shift),
        modifiedAt: Date.now(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment
// ─────────────────────────────────────────────────────────────────────────────

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/**
 * A resolver for a layer's natural (pre-transform) source size.
 *
 * Alignment needs to know how big a layer actually is, and for an image that lives in a
 * decoded bitmap the domain layer cannot see. Rather than reach for one — which would drag a
 * browser dependency into a zero-DOM package — the caller supplies the lookup. The UI already
 * has it, because it is the same function the selection box is drawn from.
 */
export type NaturalSizes = (layer: Layer) => Size;

/**
 * Align layers to the canvas, or to each other when more than one is selected.
 *
 * Aligning a multi-selection to the canvas is almost never what is meant — the user wants the
 * three badges lined up with each other, not all three stacked on the canvas's centreline —
 * so the target is the selection's own bounding box whenever there are two or more.
 */
export function alignLayers(
  layerIds: readonly LayerId[],
  edge: AlignEdge,
  natural: NaturalSizes,
): PhotoCommand {
  return {
    label: 'Align',
    apply: (doc) => {
      const layers = layerIds.map((id) => findLayer(doc.layers, id)).filter((l): l is Layer => !!l);
      if (layers.length === 0) return doc;
      const canvas: Size = { width: doc.width, height: doc.height };
      const rects = new Map<LayerId, Rect>(
        layers.map((l) => [
          l.id,
          boundsOf(layerCorners(l.transform, natural(l), canvas, fitModeOf(l))),
        ]),
      );
      const target: Rect =
        layers.length > 1
          ? unionRect([...rects.values()])
          : { x: 0, y: 0, width: doc.width, height: doc.height };

      let next = doc;
      for (const layer of layers) {
        const r = rects.get(layer.id)!;
        const [dx, dy] = alignDelta(r, target, edge);
        if (dx === 0 && dy === 0) continue;
        next = updateLayer(next, layer.id, (l) => ({
          ...l,
          transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy },
        }));
      }
      return next;
    },
  };
}

function alignDelta(r: Rect, t: Rect, edge: AlignEdge): [number, number] {
  switch (edge) {
    case 'left': return [t.x - r.x, 0];
    case 'right': return [t.x + t.width - (r.x + r.width), 0];
    case 'hcenter': return [t.x + t.width / 2 - (r.x + r.width / 2), 0];
    case 'top': return [0, t.y - r.y];
    case 'bottom': return [0, t.y + t.height - (r.y + r.height)];
    case 'vcenter': return [0, t.y + t.height / 2 - (r.y + r.height / 2)];
  }
}

/** Even out the gaps between three or more layers along one axis. */
export function distributeLayers(
  layerIds: readonly LayerId[],
  axis: 'horizontal' | 'vertical',
  natural: NaturalSizes,
): PhotoCommand {
  return {
    label: 'Distribute',
    apply: (doc) => {
      const layers = layerIds.map((id) => findLayer(doc.layers, id)).filter((l): l is Layer => !!l);
      if (layers.length < 3) return doc; // two layers have nothing between them to even out
      const canvas: Size = { width: doc.width, height: doc.height };
      const entries = layers
        .map((l) => ({ l, r: boundsOf(layerCorners(l.transform, natural(l), canvas, fitModeOf(l))) }))
        .sort((a, b) => (axis === 'horizontal' ? a.r.x - b.r.x : a.r.y - b.r.y));

      const first = entries[0]!.r;
      const last = entries[entries.length - 1]!.r;
      const span = axis === 'horizontal'
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
      const used = entries.reduce((n, e) => n + (axis === 'horizontal' ? e.r.width : e.r.height), 0);
      const gap = (span - used) / (entries.length - 1);

      let cursor = axis === 'horizontal' ? first.x : first.y;
      let next = doc;
      for (const e of entries) {
        const at = axis === 'horizontal' ? e.r.x : e.r.y;
        const delta = cursor - at;
        if (delta !== 0) {
          next = updateLayer(next, e.l.id, (l) => ({
            ...l,
            transform:
              axis === 'horizontal'
                ? { ...l.transform, x: l.transform.x + delta }
                : { ...l.transform, y: l.transform.y + delta },
          }));
        }
        cursor += (axis === 'horizontal' ? e.r.width : e.r.height) + gap;
      }
      return next;
    },
  };
}

const unionRect = (rects: readonly Rect[]): Rect =>
  boundsOf(rects.flatMap((r) => [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
  ]));

/**
 * Fit the canvas to everything drawn on it, with optional padding.
 *
 * The "trim" a creator reaches for after building a sticker or a logo on an oversized canvas.
 */
export function trimCanvasToContent(natural: NaturalSizes, padding = 0): PhotoCommand {
  return {
    label: 'Trim to Content',
    apply: (doc) => {
      const canvas: Size = { width: doc.width, height: doc.height };
      const visible = flattenLayers(doc.layers).filter((l) => l.visible && l.kind !== 'adjustment');
      if (visible.length === 0) return doc;
      const rect = unionRect(
        visible.map((l) => boundsOf(layerCorners(l.transform, natural(l), canvas, fitModeOf(l)))),
      );
      return cropCanvas({
        x: rect.x - padding,
        y: rect.y - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      }).apply(doc);
    },
  };
}

/** The drawn size of a layer at 100%, for the inspector's readouts. */
export const drawnSize = (layer: Layer, natural: Size, canvas: Size): Size =>
  baseSize(natural, canvas, fitModeOf(layer));

// ─────────────────────────────────────────────────────────────────────────────
// Canvas orientation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ROTATING AND FLIPPING THE WHOLE CANVAS ───────────────────────────────────
 *
 * Distinct from rotating a LAYER (the ring outside the corner handles, and Transform →
 * Rotation): that turns one object inside a fixed frame; this turns the frame and everything in
 * it. Both exist because both get asked for, and conflating them is how a "rotate" feature ends
 * up rotating the wrong thing.
 *
 * This is a rigid map of the whole composition, so the only way to build it that stays correct
 * is to state the canvas-space map Q once and re-solve every layer against it — not to hand-edit
 * x/y/rotation per layer and hope. Two consequences fall out of `layerMatrix`, and both matter:
 *
 *   • A LEAF layer sits directly in canvas space, so the map composes on the OUTSIDE:
 *     `Lin' = Q · Lin`. For a quarter turn that is rotation += 90; for a mirror it is
 *     rotation → −rotation with one flip flag toggled, because `S(-1,1)·R(θ) = R(-θ)·S(-1,1)`.
 *
 *   • A GROUP flattens its children into a CANVAS-SIZED buffer, so those children live in canvas
 *     space too and are turned by the recursion below. Its own transform is therefore CONJUGATED,
 *     `Lin' = Q · Lin · Q⁻¹` — which for a quarter turn leaves its rotation alone and instead
 *     swaps scaleX with scaleY and flipH with flipV. Composing on the outside like a leaf would
 *     turn a group's contents twice.
 *
 * `contain` layers (imported bitmaps) are aspect-fitted to the canvas, so a quarter turn changes
 * the frame they fit into and would silently resize them. Their scale is compensated by the ratio
 * of old base size to new, which is what keeps the turn rigid.
 *
 * Positions are not written directly either: each layer's local origin is mapped through Q and
 * the position is then solved so the new matrix puts it exactly there. That is what makes the
 * result correct for a non-centre `anchorX/anchorY` rather than merely correct for the default.
 */

/** A canvas-space map, expressed as the fields `layerMatrix` composes. */
interface CanvasMap {
  label: string;
  /** The new canvas size, given the old one. */
  size: (canvas: Size) => Size;
  /** A point in OLD canvas pixels (top-left origin) → NEW canvas pixels. */
  point: (p: Point, canvas: Size) => Point;
  /** A leaf layer's new orientation fields — the map composed on the outside. */
  leaf: (t: Transform2D) => Pick<Transform2D, 'rotation' | 'flipH' | 'flipV'>;
  /** A group's new fields — the map conjugated, because its children moved too. */
  group: (t: Transform2D) => Pick<Transform2D, 'rotation' | 'scaleX' | 'scaleY' | 'flipH' | 'flipV'>;
}

/** Quarter turns clockwise: 1 = 90° right, 2 = 180°, 3 = 90° left. */
export type QuarterTurns = 1 | 2 | 3;

const QUARTER: Record<QuarterTurns, CanvasMap> = {
  1: {
    label: 'Rotate Canvas 90° Right',
    size: (c) => ({ width: c.height, height: c.width }),
    point: (p, c) => ({ x: c.height - p.y, y: p.x }),
    leaf: (t) => ({ rotation: normalizeTurn(t.rotation + 90), flipH: t.flipH, flipV: t.flipV }),
    group: (t) => ({ rotation: t.rotation, scaleX: t.scaleY, scaleY: t.scaleX, flipH: t.flipV, flipV: t.flipH }),
  },
  2: {
    label: 'Rotate Canvas 180°',
    size: (c) => c,
    point: (p, c) => ({ x: c.width - p.x, y: c.height - p.y }),
    leaf: (t) => ({ rotation: normalizeTurn(t.rotation + 180), flipH: t.flipH, flipV: t.flipV }),
    // A half turn commutes with everything `layerMatrix` composes, so a group keeps every field
    // and only its position moves.
    group: (t) => ({ rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY, flipH: t.flipH, flipV: t.flipV }),
  },
  3: {
    label: 'Rotate Canvas 90° Left',
    size: (c) => ({ width: c.height, height: c.width }),
    point: (p, c) => ({ x: p.y, y: c.width - p.x }),
    leaf: (t) => ({ rotation: normalizeTurn(t.rotation - 90), flipH: t.flipH, flipV: t.flipV }),
    group: (t) => ({ rotation: t.rotation, scaleX: t.scaleY, scaleY: t.scaleX, flipH: t.flipV, flipV: t.flipH }),
  },
};

const MIRROR: Record<'h' | 'v', CanvasMap> = {
  h: {
    label: 'Flip Canvas Horizontal',
    size: (c) => c,
    point: (p, c) => ({ x: c.width - p.x, y: p.y }),
    leaf: (t) => ({ rotation: normalizeTurn(-t.rotation), flipH: !t.flipH, flipV: t.flipV }),
    // No flag toggle for a group: conjugating a ±1 diagonal by another leaves it unchanged, and
    // the mirroring the user sees comes from its children having been mirrored.
    group: (t) => ({
      rotation: normalizeTurn(-t.rotation),
      scaleX: t.scaleX, scaleY: t.scaleY, flipH: t.flipH, flipV: t.flipV,
    }),
  },
  v: {
    label: 'Flip Canvas Vertical',
    size: (c) => c,
    point: (p, c) => ({ x: p.x, y: c.height - p.y }),
    leaf: (t) => ({ rotation: normalizeTurn(-t.rotation), flipH: t.flipH, flipV: !t.flipV }),
    group: (t) => ({
      rotation: normalizeTurn(-t.rotation),
      scaleX: t.scaleX, scaleY: t.scaleY, flipH: t.flipH, flipV: t.flipV,
    }),
  },
};

/** Keep degrees inside the −180..180 the Rotation slider shows, so turns can't walk off it. */
function normalizeTurn(deg: number): number {
  const d = (((deg + 180) % 360) + 360) % 360 - 180;
  // −180 and +180 are the same angle; prefer the positive end so four right turns read
  // 90 → 180 → −90 → 0 rather than parking on a negative half turn.
  if (d === -180) return 180;
  return Object.is(d, -0) ? 0 : d;
}

/**
 * Rotate the entire canvas by quarter turns, clockwise.
 *
 * `natural` is required for the same reason `alignLayers` requires it: a bitmap's drawn size
 * lives in a decoded image that this package deliberately cannot see, and a quarter turn changes
 * the frame that size is fitted into.
 */
export function rotateCanvas(turns: QuarterTurns, natural: NaturalSizes): PhotoCommand {
  return canvasMapCommand(QUARTER[turns], natural);
}

/** Mirror the entire canvas. */
export function flipCanvas(axis: 'h' | 'v', natural: NaturalSizes): PhotoCommand {
  return canvasMapCommand(MIRROR[axis], natural);
}

const ORIGIN: Point = { x: 0, y: 0 };

function canvasMapCommand(map: CanvasMap, natural: NaturalSizes): PhotoCommand {
  return {
    label: map.label,
    apply: (doc) => {
      const oldCanvas: Size = { width: doc.width, height: doc.height };
      const newCanvas = map.size(oldCanvas);

      const move = (layer: Layer): Layer => {
        const fit = fitModeOf(layer);
        const isGroup = layer.kind === 'group';
        const t = layer.transform;
        // A group's flattened buffer IS canvas-sized, so its natural size follows the new canvas
        // once its children have moved. Asking the caller would hand back the old one.
        const naturalBefore: Size = isGroup ? oldCanvas : natural(layer);
        const naturalAfter: Size = isGroup ? newCanvas : naturalBefore;

        // Leaves only. A group's scale swap already accounts for its base size following the
        // canvas, and compensating on top of that would undo it.
        const k = isGroup || fit !== 'contain'
          ? { x: 1, y: 1 }
          : baseRatio(naturalBefore, oldCanvas, newCanvas);
        const oriented: Transform2D = isGroup
          ? { ...t, ...map.group(t) }
          : { ...t, ...map.leaf(t), scaleX: t.scaleX * k.x, scaleY: t.scaleY * k.y };

        // Pin the layer's local origin to wherever the canvas map sends it. Writing x/y directly
        // would be right only for a centred anchor; solving is right for any anchor.
        const from = applyMat(layerMatrix(t, naturalBefore, oldCanvas, fit), ORIGIN);
        const to = map.point(from, oldCanvas);
        const at = applyMat(layerMatrix({ ...oriented, x: 0, y: 0 }, naturalAfter, newCanvas, fit), ORIGIN);
        const moved = {
          ...layer,
          transform: { ...oriented, x: to.x - at.x, y: to.y - at.y },
        } as Layer;

        return moved.kind === 'group' ? { ...moved, children: moved.children.map(move) } : moved;
      };

      return {
        ...doc,
        width: Math.round(newCanvas.width),
        height: Math.round(newCanvas.height),
        layers: doc.layers.map(move),
        selection: doc.selection ? mapSelection(doc.selection, map, oldCanvas) : null,
        modifiedAt: Date.now(),
      };
    },
  };
}

/**
 * How much a `contain` layer's base size changes when the canvas does.
 *
 * Both sizes are aspect-fits of the same source, so the two ratios are in fact one scalar. They
 * are returned per-axis because scaleX/scaleY are what get multiplied, and an axis-wise value
 * stays obviously correct if `baseSize` ever stops preserving aspect.
 */
function baseRatio(natural: Size, oldCanvas: Size, newCanvas: Size): { x: number; y: number } {
  const before = baseSize(natural, oldCanvas, 'contain');
  const after = baseSize(natural, newCanvas, 'contain');
  return {
    x: after.width ? before.width / after.width : 1,
    y: after.height ? before.height / after.height : 1,
  };
}

/**
 * Carry the marquee through the turn.
 *
 * A selection is geometry in canvas pixels, so it maps like everything else — and it has to, or
 * rotating the canvas would leave the next edit clipped to a region of the OLD frame while the
 * ants marched somewhere else entirely. Rect and ellipse are axis-aligned, so their two corners
 * are mapped and re-normalised; a path's points map directly.
 */
function mapSelection(selection: Selection, map: CanvasMap, canvas: Size): Selection {
  const region = (r: SelectionRegion): SelectionRegion => {
    if (r.kind === 'path') {
      return { ...r, contours: r.contours.map((c) => c.map((p) => map.point(p, canvas))) };
    }
    const a = map.point({ x: r.x, y: r.y }, canvas);
    const b = map.point({ x: r.x + r.width, y: r.y + r.height }, canvas);
    return {
      ...r,
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  };
  return { ...selection, regions: selection.regions.map(region) };
}
