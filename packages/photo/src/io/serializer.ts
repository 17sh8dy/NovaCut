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

import { PHOTO_SCHEMA_VERSION, type PhotoDocument } from '../model/types.js';

export interface PhotoDocumentFile {
  schemaVersion: number;
  document: PhotoDocument;
}

/**
 * Migration functions keyed by the version they upgrade FROM. Add as the schema grows.
 * Example: `1: (d) => ({ ...d, layers: d.layers.map(addTransform), schemaVersion: 2 })`
 */
const migrations: Record<number, (doc: PhotoDocument) => PhotoDocument> = {};

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
