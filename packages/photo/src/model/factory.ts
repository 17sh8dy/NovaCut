/**
 * Factory helpers — the *only* sanctioned way to construct photo domain objects, so defaults
 * stay consistent everywhere. UI code never hand-builds a Layer; it calls these.
 *
 * Each layer kind gets its own factory rather than one `createLayer(kind)` with optional
 * fields, so the discriminated union stays exhaustive at the construction site too: adding a
 * kind breaks the compile here, which is the earliest place it can usefully break.
 */

import { instantiateEffect, type EffectInstance, type MediaAsset } from '@opencut/core';
import { newLayerId, newPhotoDocumentId } from './ids.js';
import { DEFAULT_FILL, type Fill, type Glow, type Shadow, type Stroke } from './paint.js';
import { DEFAULT_SHAPE_PARAMS, type ShapeKind, type ShapeParams } from './shapes.js';
import { DEFAULT_TEXT_STYLE, type TextStyle } from './text.js';
import {
  IDENTITY_TRANSFORM,
  PHOTO_SCHEMA_VERSION,
  type AdjustmentLayer,
  type GroupLayer,
  type ImageLayer,
  type Layer,
  type LayerMask,
  type PhotoDocument,
  type RasterLayer,
  type ShapeLayer,
  type TextLayer,
} from './types.js';

/** Default canvas for an empty document, replaced the moment an image is imported. */
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

/** The fields every kind shares, defaulted identically. */
const base = (name: string) => ({
  id: newLayerId(),
  name,
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal' as const,
  clipped: false,
  transform: { ...IDENTITY_TRANSFORM },
  effects: [] as EffectInstance[],
});

export function createImageLayer(name: string, media?: MediaAsset): ImageLayer {
  return { ...base(name), kind: 'image', ...(media ? { mediaId: media.id } : {}) };
}

export function createGroupLayer(name = 'Group', children: Layer[] = []): GroupLayer {
  return { ...base(name), kind: 'group', children, collapsed: false };
}

/**
 * An adjustment layer wrapping a registry effect.
 *
 * `instantiateEffect` THROWS on an unknown key rather than returning undefined. Callers reach
 * this from inside History.dispatch, where a throw escapes as a UI crash, so every command
 * that builds one probes the registry with `getEffectDef` first and degrades to a no-op.
 */
export function createAdjustmentLayer(type: string, name?: string): AdjustmentLayer {
  const adjustment = instantiateEffect(type);
  return { ...base(name ?? type), kind: 'adjustment', adjustment };
}

/**
 * A live text layer.
 *
 * The style is DEEP-copied, not shared with the default: a preset object handed to two layers
 * that then both mutate it is the classic way one edit silently changes another layer.
 */
export function createTextLayer(content = 'Your text', style: Partial<TextStyle> = {}): TextLayer {
  const merged: TextStyle = { ...DEFAULT_TEXT_STYLE, ...style };
  return {
    ...base(firstLine(content) || 'Text'),
    kind: 'text',
    content,
    style: {
      ...merged,
      fill: cloneFill(merged.fill),
      stroke: merged.stroke ? { ...merged.stroke } : null,
      shadow: merged.shadow ? { ...merged.shadow } : null,
      glow: merged.glow ? { ...merged.glow } : null,
    },
    boxWidth: null,
  };
}

export function createShapeLayer(
  shape: ShapeKind,
  width: number,
  height: number,
  opts: {
    name?: string;
    fill?: Fill;
    stroke?: Stroke | null;
    shadow?: Shadow | null;
    glow?: Glow | null;
    params?: Partial<ShapeParams>;
  } = {},
): ShapeLayer {
  return {
    ...base(opts.name ?? 'Shape'),
    kind: 'shape',
    shape,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    params: { ...DEFAULT_SHAPE_PARAMS, ...opts.params },
    fill: cloneFill(opts.fill ?? DEFAULT_FILL),
    stroke: opts.stroke ? { ...opts.stroke } : null,
    shadow: opts.shadow ? { ...opts.shadow } : null,
    glow: opts.glow ? { ...opts.glow } : null,
  };
}

/**
 * An empty painted surface, sized to the canvas.
 *
 * Canvas-sized rather than "as big as the strokes" so a stroke's coordinates keep meaning the
 * same thing forever: the layer's own space IS the canvas's space at the moment it was made,
 * which is what lets a paint layer be moved and scaled like anything else without the strokes
 * shifting under it.
 */
export function createRasterLayer(width: number, height: number, name = 'Paint'): RasterLayer {
  return {
    ...base(name),
    kind: 'raster',
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    ops: [],
  };
}

/**
 * A fresh mask.
 *
 * `reveal` is the default because that is what "add a mask" means in every editor: the layer
 * keeps looking exactly as it did, and the user paints away what they want gone. Starting
 * hidden makes the layer vanish the moment the mask is added, which reads as a bug.
 */
export const createMask = (base: 'reveal' | 'hide' = 'reveal'): LayerMask => ({
  enabled: true,
  inverted: false,
  base,
  regions: [],
  ops: [],
});

/** Deep-copy a fill so gradient stops are never aliased between layers. */
export const cloneFill = (fill: Fill): Fill =>
  fill.kind === 'solid' ? { ...fill } : { ...fill, stops: fill.stops.map((s) => ({ ...s })) };

/** A layer's default name follows its first line, the way every design tool names text. */
const firstLine = (content: string): string => {
  const line = content.split('\n')[0]?.trim() ?? '';
  return line.length > 28 ? `${line.slice(0, 28)}…` : line;
};

/**
 * Build a document. When `media` is given the canvas takes the image's exact pixel size, so
 * the render is 1:1 with no resampling and no aspect-fit — the natural default for a photo,
 * where video instead fits media into a fixed frame.
 */
export function createPhotoDocument(
  name = 'Untitled',
  media?: MediaAsset,
  /** An explicit canvas size (a preset). Wins over the media's, which wins over the default. */
  size?: { width: number; height: number },
): PhotoDocument {
  const now = Date.now();
  return {
    schemaVersion: PHOTO_SCHEMA_VERSION,
    id: newPhotoDocumentId(),
    name,
    createdAt: now,
    modifiedAt: now,
    width: size?.width || media?.width || DEFAULT_WIDTH,
    height: size?.height || media?.height || DEFAULT_HEIGHT,
    // Transparent, not black: a thumbnail or sticker that is exported straight to PNG should
    // keep its transparency, and a user who wants a solid backdrop can add one in a click.
    // (A black default silently baked an opaque frame into every export.)
    background: '#00000000',
    layers: media ? [createImageLayer(media.name || 'Background', media)] : [],
    media: media ? [media] : [],
    selection: null,
  };
}
