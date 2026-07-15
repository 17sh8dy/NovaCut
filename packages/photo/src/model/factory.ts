/**
 * Factory helpers — the *only* sanctioned way to construct photo domain objects, so defaults
 * stay consistent everywhere. UI code never hand-builds a Layer; it calls these.
 */

import type { MediaAsset } from '@opencut/core';
import { newLayerId, newPhotoDocumentId } from './ids.js';
import { PHOTO_SCHEMA_VERSION, type Layer, type PhotoDocument } from './types.js';

/** A4-ish default canvas for an empty document, replaced the moment an image is imported. */
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

export function createLayer(name: string, media?: MediaAsset): Layer {
  return {
    id: newLayerId(),
    kind: 'image',
    name,
    ...(media ? { mediaId: media.id } : {}),
    visible: true,
    locked: false,
    opacity: 1,
    effects: [],
  };
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
    layers: media ? [createLayer(media.name || 'Background', media)] : [],
    media: media ? [media] : [],
  };
}
