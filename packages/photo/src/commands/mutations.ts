/**
 * Immutable update helpers.
 *
 * Every function returns a NEW PhotoDocument with only the touched objects re-referenced
 * (structural sharing), so React re-renders exactly the changed panels and the history stack
 * stays memory-cheap. Commands are built from these primitives.
 *
 * Each helper returns the input document UNCHANGED when the edit is a no-op. That is not a
 * micro-optimization: History.dispatch's only guard against pushing a junk undo step is a
 * `next === prev` reference check, so a helper that always spreads a fresh object would make
 * every no-op edit cost an undo press.
 */

import type { EffectInstanceId, MediaAsset } from '@opencut/core';
import type { LayerId } from '../model/ids.js';
import type { Layer, PhotoDocument } from '../model/types.js';

/** Re-stamp the document as modified. The single place `modifiedAt` is written. */
const touch = (doc: PhotoDocument, layers: Layer[]): PhotoDocument => ({
  ...doc,
  layers,
  modifiedAt: Date.now(),
});

export function updateLayer(
  doc: PhotoDocument,
  layerId: LayerId,
  fn: (layer: Layer) => Layer,
): PhotoDocument {
  let changed = false;
  const layers = doc.layers.map((l) => {
    if (l.id !== layerId) return l;
    const next = fn(l);
    if (next === l) return l;
    changed = true;
    return next;
  });
  if (!changed) return doc;
  return touch(doc, layers);
}

export function addLayer(doc: PhotoDocument, layer: Layer): PhotoDocument {
  return touch(doc, [...doc.layers, layer]);
}

export function removeLayer(doc: PhotoDocument, layerId: LayerId): PhotoDocument {
  const layers = doc.layers.filter((l) => l.id !== layerId);
  if (layers.length === doc.layers.length) return doc;
  return touch(doc, layers);
}

/**
 * Move a layer to a new index in the stack (0 = bottom). Out-of-range targets clamp, and a
 * move that lands where it started is a no-op.
 */
export function reorderLayer(doc: PhotoDocument, layerId: LayerId, toIndex: number): PhotoDocument {
  const from = doc.layers.findIndex((l) => l.id === layerId);
  if (from === -1) return doc;
  const to = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
  if (to === from) return doc;
  const layers = [...doc.layers];
  const [moved] = layers.splice(from, 1);
  layers.splice(to, 0, moved!);
  return touch(doc, layers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Effects on a layer
// ─────────────────────────────────────────────────────────────────────────────

export function addEffect(
  doc: PhotoDocument,
  layerId: LayerId,
  effect: Layer['effects'][number],
): PhotoDocument {
  return updateLayer(doc, layerId, (l) => ({ ...l, effects: [...l.effects, effect] }));
}

export function removeEffect(
  doc: PhotoDocument,
  layerId: LayerId,
  effectId: EffectInstanceId,
): PhotoDocument {
  return updateLayer(doc, layerId, (l) => {
    const effects = l.effects.filter((e) => e.id !== effectId);
    if (effects.length === l.effects.length) return l;
    return { ...l, effects };
  });
}

export function updateEffect(
  doc: PhotoDocument,
  layerId: LayerId,
  effectId: EffectInstanceId,
  fn: (effect: Layer['effects'][number]) => Layer['effects'][number],
): PhotoDocument {
  return updateLayer(doc, layerId, (l) => {
    let changed = false;
    const effects = l.effects.map((e) => {
      if (e.id !== effectId) return e;
      const next = fn(e);
      if (next === e) return e;
      changed = true;
      return next;
    });
    if (!changed) return l;
    return { ...l, effects };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Media
// ─────────────────────────────────────────────────────────────────────────────

export function addMedia(doc: PhotoDocument, media: MediaAsset): PhotoDocument {
  if (doc.media.some((m) => m.id === media.id)) return doc;
  return { ...doc, media: [...doc.media, media], modifiedAt: Date.now() };
}
