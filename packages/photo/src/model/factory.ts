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
import {
  IDENTITY_TRANSFORM,
  PHOTO_SCHEMA_VERSION,
  type AdjustmentLayer,
  type GroupLayer,
  type ImageLayer,
  type Layer,
  type PhotoDocument,
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
 * Build a document. When `media` is given the canvas takes the image's exact pixel size, so
 * the render is 1:1 with no resampling and no aspect-fit — the natural default for a photo,
 * where video instead fits media into a fixed frame.
 */
export function createPhotoDocument(name = 'Untitled', media?: MediaAsset): PhotoDocument {
  const now = Date.now();
  return {
    schemaVersion: PHOTO_SCHEMA_VERSION,
    id: newPhotoDocumentId(),
    name,
    createdAt: now,
    modifiedAt: now,
    width: media?.width || DEFAULT_WIDTH,
    height: media?.height || DEFAULT_HEIGHT,
    background: '#000000',
    layers: media ? [createImageLayer(media.name || 'Background', media)] : [],
    media: media ? [media] : [],
  };
}
