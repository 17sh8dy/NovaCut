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
 * every no-op edit cost an undo press. The tree helpers in `model/tree.ts` preserve the same
 * contract, which is why nothing here does its own recursion.
 */

import type { EffectInstanceId, MediaAsset } from '@opencut/core';
import type { LayerId } from '../model/ids.js';
import {
  findLayer,
  insertLayerInto,
  isAncestor,
  mapLayer,
  parentOf,
  removeLayerFrom,
} from '../model/tree.js';
import type { Layer, PhotoDocument } from '../model/types.js';
import { isGroupLayer } from '../model/types.js';

/** Re-stamp the document as modified. The single place `modifiedAt` is written. */
const touch = (doc: PhotoDocument, layers: Layer[]): PhotoDocument =>
  layers === doc.layers ? doc : { ...doc, layers, modifiedAt: Date.now() };

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

/** Apply `fn` to one layer anywhere in the tree. */
export function updateLayer(
  doc: PhotoDocument,
  layerId: LayerId,
  fn: (layer: Layer) => Layer,
): PhotoDocument {
  return touch(doc, mapLayer(doc.layers, layerId, fn));
}

/**
 * Add a layer at the top of the stack (or of `parentId`'s children).
 *
 * An unknown or non-group `parentId` is rejected rather than ignored. insertLayerInto is built
 * on mapLayer, which returns the list BY REFERENCE when nothing matched — so without this check
 * a bad parent would make `touch` return the document unchanged and the layer would silently
 * vanish, with no error and nothing on screen to explain it.
 */
export function addLayer(doc: PhotoDocument, layer: Layer, parentId: LayerId | null = null): PhotoDocument {
  if (parentId === null) return touch(doc, [...doc.layers, layer]);
  const parent = findLayer(doc.layers, parentId);
  if (!parent || !isGroupLayer(parent)) return doc;
  return touch(doc, insertLayerInto(doc.layers, layer, parentId, Number.MAX_SAFE_INTEGER));
}

/** Remove a layer, and its whole subtree when it is a group. */
export function removeLayer(doc: PhotoDocument, layerId: LayerId): PhotoDocument {
  return touch(doc, removeLayerFrom(doc.layers, layerId));
}

/**
 * Move a layer to `toIndex` within `toParentId` (null = document root).
 *
 * The ancestor check runs BEFORE the removal, and must: dropping a group into its own
 * descendant would splice the subtree into itself, and every later walk would recurse until the
 * stack blew — but once the layer is removed, its former descendants are gone from the tree and
 * the check can no longer see the cycle it was meant to prevent.
 */
export function moveLayerTo(
  doc: PhotoDocument,
  layerId: LayerId,
  toParentId: LayerId | null,
  toIndex: number,
): PhotoDocument {
  if (toParentId !== null) {
    if (isAncestor(doc.layers, layerId, toParentId)) return doc;
    const target = findLayer(doc.layers, toParentId);
    if (!target || !isGroupLayer(target)) return doc; // unknown parent, or not a folder
  }

  const current = parentOf(doc.layers, layerId);
  const currentParentId = current?.id ?? null;
  const siblings = current && isGroupLayer(current) ? current.children : doc.layers;
  const fromIndex = siblings.findIndex((l) => l.id === layerId);
  if (fromIndex === -1) return doc; // not in the tree

  // Removing an earlier sibling shifts every later index down by one; a drop targeting an
  // index past the gap must compensate or it lands one slot short of where it was dropped.
  const adjusted = currentParentId === toParentId && toIndex > fromIndex ? toIndex - 1 : toIndex;

  // Detect a no-op AFTER adjusting and clamping, not before.
  //
  // `toIndex` is an index in the ORIGINAL sibling list, so within one parent BOTH `fromIndex`
  // and `fromIndex + 1` mean "leave it where it is" — dropping a layer just above itself is
  // the same position. insertLayerInto also clamps out-of-range indices, so an over-long
  // toIndex can land back on fromIndex too. Guarding only `fromIndex === toIndex` lets those
  // rebuild an identical tree in a fresh array, which defeats History.dispatch's
  // `next === prev` check and costs the user an undo press for a drag that did nothing.
  if (currentParentId === toParentId) {
    const landing = Math.max(0, Math.min(siblings.length - 1, adjusted));
    if (landing === fromIndex) return doc;
  }

  const moved = siblings[fromIndex]!;
  const without = removeLayerFrom(doc.layers, layerId);
  return touch(doc, insertLayerInto(without, moved, toParentId, adjusted));
}

/**
 * Wrap `layerIds` in a new group, inserted where the topmost of them sat.
 *
 * Only layers that are siblings can be grouped — Photoshop silently regroups across parents,
 * which reorders the user's stack in ways they didn't ask for. Cross-parent selections are
 * rejected here so the caller can decide.
 */
export function groupLayers(
  doc: PhotoDocument,
  layerIds: readonly LayerId[],
  group: Layer,
): PhotoDocument {
  if (layerIds.length === 0 || !isGroupLayer(group)) return doc;

  const parent = parentOf(doc.layers, layerIds[0]!);
  const parentId = parent?.id ?? null;
  for (const id of layerIds) {
    const p = parentOf(doc.layers, id);
    if ((p?.id ?? null) !== parentId) return doc;
  }

  const siblings = parent && isGroupLayer(parent) ? parent.children : doc.layers;
  const indices = layerIds
    .map((id) => siblings.findIndex((l) => l.id === id))
    .filter((i) => i !== -1);
  if (indices.length !== layerIds.length) return doc;

  // Keep the group's children in stack order, not selection order — the user's z-order is
  // information they built deliberately; the order they happened to click is not.
  const ordered = [...indices].sort((a, b) => a - b);
  const children = ordered.map((i) => siblings[i]!);
  const insertAt = ordered[ordered.length - 1]!;

  let layers = doc.layers;
  for (const id of layerIds) layers = removeLayerFrom(layers, id);
  // Every removed sibling below the insertion point shifts it down.
  const shift = ordered.filter((i) => i < insertAt).length;
  layers = insertLayerInto(layers, { ...group, children }, parentId, insertAt - shift);
  return touch(doc, layers);
}

/** Replace a group with its children in place, preserving their order. */
export function ungroupLayer(doc: PhotoDocument, groupId: LayerId): PhotoDocument {
  const group = findLayer(doc.layers, groupId);
  if (!group || !isGroupLayer(group)) return doc;

  const parent = parentOf(doc.layers, groupId);
  const parentId = parent?.id ?? null;
  const siblings = parent && isGroupLayer(parent) ? parent.children : doc.layers;
  const at = siblings.findIndex((l) => l.id === groupId);
  if (at === -1) return doc;

  let layers = removeLayerFrom(doc.layers, groupId);
  // Insert bottom-up at ascending indices: each child lands directly above the previous one,
  // which reproduces their original order in the parent.
  for (const [i, child] of group.children.entries()) {
    layers = insertLayerInto(layers, child, parentId, at + i);
  }
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
