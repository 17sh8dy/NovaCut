/**
 * Layer-tree traversal.
 *
 * The moment layers nest, "find the layer" and "replace the layer" stop being `Array.find` and
 * `Array.map` — every mutation and every renderer walk needs the same recursion. Centralising
 * it here is what keeps `mutations.ts` free of hand-rolled tree surgery, where an off-by-one
 * in a splice silently drops a subtree.
 *
 * Everything here is pure and immutable. `mapLayer`/`removeLayerFrom` return the input array
 * BY REFERENCE when nothing matched, which is load-bearing rather than a micro-optimization:
 * History.dispatch's only guard against pushing a junk undo step is a `next === prev`
 * reference check, so a no-op that rebuilt the tree would cost the user an undo press.
 */

import type { LayerId } from './ids.js';
import type { Layer } from './types.js';
import { isGroupLayer } from './types.js';

/** Depth-first, bottom-to-top (document order). Groups are yielded before their children. */
export function* walkLayers(layers: readonly Layer[]): Generator<Layer> {
  for (const layer of layers) {
    yield layer;
    if (isGroupLayer(layer)) yield* walkLayers(layer.children);
  }
}

/** Every layer in the tree, flattened. Convenience over `walkLayers` for counts and lookups. */
export const flattenLayers = (layers: readonly Layer[]): Layer[] => [...walkLayers(layers)];

/** Find a layer anywhere in the tree. */
export function findLayer(layers: readonly Layer[], id: LayerId): Layer | undefined {
  for (const layer of walkLayers(layers)) if (layer.id === id) return layer;
  return undefined;
}

/**
 * The chain of groups containing `id`, outermost first. Empty when the layer is at the root or
 * absent. The UI uses this to auto-expand folders when selecting a nested layer.
 */
export function ancestorsOf(layers: readonly Layer[], id: LayerId): Layer[] {
  const path: Layer[] = [];
  const visit = (nodes: readonly Layer[]): boolean => {
    for (const node of nodes) {
      if (node.id === id) return true;
      if (isGroupLayer(node)) {
        path.push(node);
        if (visit(node.children)) return true;
        path.pop();
      }
    }
    return false;
  };
  visit(layers);
  return path;
}

/** The group directly containing `id`, or undefined when it sits at the document root. */
export const parentOf = (layers: readonly Layer[], id: LayerId): Layer | undefined =>
  ancestorsOf(layers, id).at(-1);

/**
 * Rebuild the tree with `fn` applied to the layer matching `id`.
 *
 * Returns `layers` by reference when the id is absent OR when `fn` returns its input
 * unchanged — the no-op contract described in this file's header. Note the recursion has to
 * check the group's own id BEFORE descending, so `fn` can replace a whole group wholesale.
 */
export function mapLayer(
  layers: readonly Layer[],
  id: LayerId,
  fn: (layer: Layer) => Layer,
): Layer[] {
  let changed = false;
  const next = layers.map((layer) => {
    if (layer.id === id) {
      const updated = fn(layer);
      if (updated === layer) return layer;
      changed = true;
      return updated;
    }
    if (isGroupLayer(layer)) {
      const children = mapLayer(layer.children, id, fn);
      if (children === layer.children) return layer;
      changed = true;
      return { ...layer, children };
    }
    return layer;
  });
  return changed ? next : (layers as Layer[]);
}

/** Remove a layer (and, if it is a group, its whole subtree) from anywhere in the tree. */
export function removeLayerFrom(layers: readonly Layer[], id: LayerId): Layer[] {
  let changed = false;
  const next: Layer[] = [];
  for (const layer of layers) {
    if (layer.id === id) {
      changed = true;
      continue;
    }
    if (isGroupLayer(layer)) {
      const children = removeLayerFrom(layer.children, id);
      if (children !== layer.children) {
        changed = true;
        next.push({ ...layer, children });
        continue;
      }
    }
    next.push(layer);
  }
  return changed ? next : (layers as Layer[]);
}

/**
 * Insert `layer` into the group `parentId` (or the document root when null) at `index`.
 * Out-of-range indices clamp; `index` counts from the bottom, matching document order.
 */
export function insertLayerInto(
  layers: readonly Layer[],
  layer: Layer,
  parentId: LayerId | null,
  index: number,
): Layer[] {
  if (parentId === null) {
    const next = [...layers];
    next.splice(clamp(index, 0, next.length), 0, layer);
    return next;
  }
  return mapLayer(layers, parentId, (parent) => {
    if (!isGroupLayer(parent)) return parent;
    const children = [...parent.children];
    children.splice(clamp(index, 0, children.length), 0, layer);
    return { ...parent, children };
  });
}

/**
 * True when `ancestorId` is `id` or contains it.
 *
 * The guard that makes reparenting safe: dropping a group into its own child would splice a
 * subtree into itself, and every later walk would recurse until the stack blew. Callers must
 * check this BEFORE removing the dragged layer, since removal destroys the evidence.
 */
export function isAncestor(layers: readonly Layer[], ancestorId: LayerId, id: LayerId): boolean {
  if (ancestorId === id) return true;
  const group = findLayer(layers, ancestorId);
  if (!group || !isGroupLayer(group)) return false;
  for (const child of walkLayers(group.children)) if (child.id === id) return true;
  return false;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
