/**
 * Versioned photo document IO.
 *
 * A `.opencutphoto` file is JSON: `{ schemaVersion, document }`. Loading walks the migration
 * chain from the file's version up to the current one, so old files keep opening as the model
 * grows. The document holds metadata and layer structure only — image bytes stay on disk and
 * are re-resolved through the PlatformBridge on load, which is what keeps project files small.
 *
 * Deliberately independent of core's project serializer rather than a shared generic: the two
 * formats version on their own timelines, and the migration loop is ~15 lines. A shared
 * `createSerializer<T>()` would be the move if a third document type ever appears.
 */

import type { EffectInstance, MediaId } from '@opencut/core';
import type { LayerId } from '../model/ids.js';
import { IDENTITY_TRANSFORM, PHOTO_SCHEMA_VERSION, type ImageLayer, type PhotoDocument } from '../model/types.js';

export interface PhotoDocumentFile {
  schemaVersion: number;
  document: PhotoDocument;
}

/**
 * A v1 layer: a flat list entry with no transform, blend mode, clipping or kind discriminator.
 * Typed loosely on purpose — this describes bytes on disk, not a model we still believe in.
 */
interface LayerV1 {
  id: string;
  name: string;
  mediaId?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  effects?: unknown[];
}

/**
 * Migration functions keyed by the version they upgrade FROM.
 *
 * Each one takes the PREVIOUS shape and returns the next, so the chain in
 * `deserializePhotoDocument` can walk any old file up to current. They are cast at the
 * boundary rather than typed against the live model: a migration's input type is frozen
 * history, and letting it drift with the current model is how migrations quietly stop
 * migrating (the compiler starts "helping" by agreeing the old shape is the new shape).
 */
const migrations: Record<number, (doc: PhotoDocument) => PhotoDocument> = {
  /**
   * 1 → 2: flat list of image layers ⇒ layer tree with transform + blend.
   *
   * Every v1 layer was an aspect-fitted image at full opacity with no blend mode, which is
   * exactly what the identity transform and 'normal' render to — so a migrated document is
   * pixel-identical to what v1 drew. That equivalence is the whole reason this migration is
   * safe to run silently on open.
   */
  1: (doc) => {
    const v1 = doc as unknown as { layers?: LayerV1[] };
    const layers: ImageLayer[] = (v1.layers ?? []).map((l) => ({
      kind: 'image',
      id: l.id as LayerId,
      name: l.name ?? 'Layer',
      ...(l.mediaId ? { mediaId: l.mediaId as MediaId } : {}),
      visible: l.visible ?? true,
      locked: l.locked ?? false,
      opacity: l.opacity ?? 1,
      blendMode: 'normal', // v1 had no blend mode; 'normal' is what it actually rendered
      clipped: false,
      transform: { ...IDENTITY_TRANSFORM },
      effects: (l.effects ?? []) as EffectInstance[],
    }));
    return { ...doc, layers, schemaVersion: 2 };
  },
};

export function serializePhotoDocument(document: PhotoDocument): string {
  const file: PhotoDocumentFile = {
    schemaVersion: PHOTO_SCHEMA_VERSION,
    document: { ...document, schemaVersion: PHOTO_SCHEMA_VERSION, modifiedAt: Date.now() },
  };
  return JSON.stringify(file, null, 2);
}

export function deserializePhotoDocument(json: string): PhotoDocument {
  const parsed = JSON.parse(json) as PhotoDocumentFile | PhotoDocument;
  // Tolerate both the wrapped file and a bare document, as core's loader does.
  let document = 'document' in parsed ? parsed.document : parsed;
  let version = ('schemaVersion' in parsed ? parsed.schemaVersion : document.schemaVersion) ?? 1;

  while (version < PHOTO_SCHEMA_VERSION) {
    const migrate = migrations[version];
    if (!migrate) throw new Error(`No migration from photo schema version ${version}`);
    document = migrate(document);
    version++;
  }
  return { ...document, schemaVersion: PHOTO_SCHEMA_VERSION };
}
