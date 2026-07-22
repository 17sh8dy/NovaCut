/**
 * The photo domain model.
 *
 * A PhotoDocument is what a Sequence is to video, with time removed: a fixed-size canvas and
 * a bottom-to-top TREE of layers, each with its own transform, blend mode and effect chain.
 * Removing time is the entire simplification — no ticks, no keyframes, no playhead, no trim.
 *
 * Three invariants this file exists to protect:
 *
 *   • **It declares only what the renderer honors.** Core learned this the hard way:
 *     Clip.blendMode, Transform.crop and Transform.anchorX/Y are all declared, defaulted and
 *     then ignored by the compositor, so the model promises capabilities the product doesn't
 *     have. Every field below has a live path through the photo render graph. When a field is
 *     tempting but unbacked it stays OUT until its renderer lands with it — see the notes on
 *     fillOpacity and masks at the bottom, which is where the next slices attach.
 *
 *   • **It stores no pixels.** Layers reference a MediaAsset by id, exactly as Clip.mediaId
 *     does; decoded bitmaps live outside the document in the engine's FrameSourcePool. History
 *     retains up to 200 whole document states, which is cheap for plain JSON and ruinous for
 *     anything holding image buffers. This is also what keeps every edit non-destructive: the
 *     document is a *description* of how to composite the originals, never the result.
 *
 *   • **Nothing here is destructive.** There is no "apply" that bakes pixels. A crop is a
 *     transform, an adjustment is a layer, a filter is an entry in `effects`. Rasterizing is
 *     an explicit user act that must produce a new MediaAsset, never a silent overwrite.
 */

import type { EffectInstance, MediaAsset, MediaId } from '@opencut/core';
import type { BlendMode } from './blend.js';
import type { FitMode } from './geometry.js';
import type { LayerId, PhotoDocumentId } from './ids.js';
import type { Fill, Glow, Shadow, Stroke } from './paint.js';
import type { ShapeKind, ShapeParams } from './shapes.js';
import type { TextStyle } from './text.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A layer's placement on the canvas.
 *
 * Plain numbers, not core's AnimatedValue: a still has no time to animate over. (Layer.opacity
 * has always made this same call; this is the same reasoning applied to the rest.)
 *
 * `x`/`y` are pixel offsets from the canvas centre, +y down, matching core's Transform
 * convention so the two products' inspectors read the same way. Scale is a multiplier, not a
 * size, so it composes cleanly through nested groups.
 */
export interface Transform2D {
  x: number;
  y: number;
  scaleX: number; // 1 = 100%
  scaleY: number;
  rotation: number; // degrees, clockwise
  /**
   * Pivot for rotation and scale, 0..1 within the layer's own bounds (0.5,0.5 = centre).
   * Unlike core's anchorX/anchorY — declared and ignored — the render graph builds this into
   * the model matrix. Free Transform's draggable pivot writes here.
   */
  anchorX: number;
  anchorY: number;
  flipH: boolean;
  flipV: boolean;
}

export const IDENTITY_TRANSFORM: Readonly<Transform2D> = Object.freeze({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  flipH: false,
  flipV: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

export type LayerKind = 'image' | 'group' | 'adjustment' | 'text' | 'shape';

/** Photoshop's layer colour labels, for organising a deep stack. Purely cosmetic. */
export type ColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

/** Fields every layer kind carries. Not exported as a usable type — see `Layer`. */
interface LayerBase {
  id: LayerId;
  name: string;
  visible: boolean;
  /** Locked layers are skipped by hit-testing and selection in the UI. */
  locked: boolean;
  /** 0..1. Applied to the layer's composite, after its effects. */
  opacity: number;
  blendMode: BlendMode;
  /**
   * Clip to the layer beneath: this layer is masked by the alpha of the nearest unclipped
   * layer below it in the same parent, and the whole run composites as one unit using that
   * base layer's blend mode. Photoshop's Alt-click-between-layers.
   *
   * A clipped layer at the bottom of its parent has no base and is simply skipped, which is
   * also what Photoshop does.
   */
  clipped: boolean;
  colorLabel?: ColorLabel;
  transform: Transform2D;
  /**
   * core's EffectInstance verbatim — not a photo-specific variant. That is what makes the two
   * products share one filter rack: `instantiateEffect()` builds these, the shared effect
   * chain consumes them, and every filter added for video shows up here for free. The cost is
   * that each param carries a `keyframes: []` a still will never fill; `sample()` returns the
   * static value when that array is empty, so it stays inert.
   *
   * Applied bottom-up to the layer's own pixels, BEFORE opacity and blending.
   */
  effects: EffectInstance[];
}

/** A still. The only layer kind that owns pixels. */
export interface ImageLayer extends LayerBase {
  kind: 'image';
  /** The still this layer draws. Absent while a layer is being created. */
  mediaId?: MediaId;
}

/**
 * A folder. Renders its children into an isolated buffer, then composites that buffer as one
 * unit with its own transform/opacity/blend — which is precisely why a group is not just a UI
 * affordance: `opacity: 0.5` on a group cross-fades the *flattened* group, not each child.
 */
export interface GroupLayer extends LayerBase {
  kind: 'group';
  /** Ordered bottom-to-top, same convention as `PhotoDocument.layers`. */
  children: Layer[];
  /** UI-only: whether the folder is twisted open in the layers panel. */
  collapsed: boolean;
}

/**
 * A non-destructive colour adjustment applied to everything composited beneath it.
 *
 * This is the pivot the whole "every edit stays editable" promise turns on. A Curves layer is
 * not pixels; it is an EffectInstance that re-runs against the live backdrop each frame, so
 * its params stay draggable forever and reordering it re-renders rather than re-decodes.
 *
 * Scope follows the layer tree: inside a group it affects only that group's backdrop (PS's
 * "pass through" is deliberately not modelled — it needs a backdrop-sharing render path, and
 * declaring it before that exists would be exactly the fiction this file guards against).
 * With `clipped: true` it affects only the layer directly below.
 */
export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment';
  /** The adjustment's parameters. Its `type` keys into core's effect registry. */
  adjustment: EffectInstance;
}

/**
 * Live type. Its glyphs are rasterized into the render graph every draw, so the content and
 * every style field stay editable forever — the whole point of not "committing" text.
 *
 * The style is FLAT (one look for the whole layer). Per-character runs are a real feature and
 * a much larger one — see the header of `text.ts` for why declaring them early would be the
 * exact fiction this model guards against.
 */
export interface TextLayer extends LayerBase {
  kind: 'text';
  content: string;
  style: TextStyle;
  /**
   * Wrap width in canvas pixels, or null to size to the longest line.
   *
   * Null is the default because a headline is written, not laid out: the box should follow the
   * words. Dragging a side handle sets a width and switches the layer to wrapping, which is
   * the same gesture every design tool uses to mean exactly that.
   */
  boxWidth: number | null;
}

/**
 * A vector shape. Its geometry is a pure function of `shape` + `size` + `params` (see
 * `shapes.ts`), so it re-rasterizes crisply at any scale rather than resampling like a bitmap.
 *
 * Size lives here in pixels, separate from `transform.scale`, and the distinction is load
 * bearing: `width`/`height` change the *geometry* (a wider rounded rect keeps its corner
 * radius), while scale changes the *rendering* (a scaled rounded rect stretches its corners).
 * Collapsing them would make corner radius, stroke width and star points all silently
 * scale-dependent.
 */
export interface ShapeLayer extends LayerBase {
  kind: 'shape';
  shape: ShapeKind;
  width: number;
  height: number;
  params: ShapeParams;
  fill: Fill;
  stroke: Stroke | null;
  shadow: Shadow | null;
  glow: Glow | null;
}

export type Layer = ImageLayer | GroupLayer | AdjustmentLayer | TextLayer | ShapeLayer;

/** Type guards. Prefer these to `kind ===` at call sites so narrowing stays in one place. */
export const isImageLayer = (l: Layer): l is ImageLayer => l.kind === 'image';
export const isGroupLayer = (l: Layer): l is GroupLayer => l.kind === 'group';
export const isAdjustmentLayer = (l: Layer): l is AdjustmentLayer => l.kind === 'adjustment';
export const isTextLayer = (l: Layer): l is TextLayer => l.kind === 'text';
export const isShapeLayer = (l: Layer): l is ShapeLayer => l.kind === 'shape';
/** Layers whose pixels are drawn rather than sampled — the ones the vector rasterizer owns. */
export const isVectorLayer = (l: Layer): l is TextLayer | ShapeLayer =>
  l.kind === 'text' || l.kind === 'shape';

/**
 * How a layer's source maps onto the canvas.
 *
 * Bitmaps aspect-fit (an imported photo fills the frame it was imported into); everything
 * drawn is placed pixel-exact, because a shape's `width` in the inspector has to be the width
 * it actually occupies. Groups are already canvas-sized when they flatten, so either mode is
 * identity for them — `contain` is chosen for consistency with the layer they wrap.
 */
export const fitModeOf = (l: Layer): FitMode => (isVectorLayer(l) ? 'exact' : 'contain');

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export interface PhotoDocument {
  /** Bumped when the on-disk schema changes; migrations key off this. */
  schemaVersion: number;
  id: PhotoDocumentId;
  name: string;
  createdAt: number;
  modifiedAt: number;
  /** Canvas size in pixels. Set from the first imported image so it renders 1:1. */
  width: number;
  height: number;
  /** Background behind all layers, as hex. */
  background: string;
  /** Ordered bottom-to-top; the last layer is the topmost, matching core's Track convention. */
  layers: Layer[];
  /** Imported stills. Metadata only — the bytes stay on disk, resolved via the bridge. */
  media: MediaAsset[];
}

/**
 * Current on-disk schema version. Increment + add a migration when PhotoDocument changes.
 * Independent of core's SCHEMA_VERSION: the two formats version on their own timelines.
 *
 *   1 — flat layer list; visible/locked/opacity/effects only.
 *   2 — layer tree (groups), transform, blend modes, clipping, adjustment layers.
 *   3 — vector layers: text and shapes, with fills/strokes/shadows/glows.
 */
export const PHOTO_SCHEMA_VERSION = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Deliberately not modelled yet — the next slices attach here
// ─────────────────────────────────────────────────────────────────────────────
//
// Each of these is absent for the same reason: the renderer cannot honor it today, and this
// model does not promise what the product cannot do.
//
//   • Layer masks — need a raster surface the user can paint into, which is the paint engine
//     slice. A mask sourced only from an imported file would be a half-feature.
//   • fillOpacity — differs from `opacity` ONLY in how layer styles and eight special blend
//     modes respond to it. With no layer styles, it would be an exact duplicate of `opacity`
//     wearing a second name. It lands with Effects (drop shadow, stroke, …).
//   • Smart Objects — a layer whose source is another PhotoDocument. Needs the render graph to
//     recurse into a nested document + an invalidation path; the graph is already recursive
//     for groups, so this is a small step once nested documents serialize.
//   • Per-character text runs — need a run model AND an in-canvas caret/selection to edit
//     them. `TextStyle` is deliberately flat until both exist; see the header of `text.ts`.
//   • Selections — a document-level region that constrains where edits land. Needs a raster
//     mask surface (the same one masks need) plus a marching-ants overlay.
//
// Landed since this list was written: text and shape layers (schema 3), via the vector
// rasterizer in `engine/src/photo/vectorRaster.ts`.
