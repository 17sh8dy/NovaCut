/**
 * Painting and masking, as Commands.
 *
 * The interesting one here is `extendStroke`. Everything else is an ordinary append.
 *
 * ## A stroke is ONE undo step, built from hundreds of dispatches
 *
 * A brush stroke arrives as a pointermove every few milliseconds, and each of those has to be
 * on screen immediately — a brush that lags the cursor is not a brush. So every move dispatches
 * a command. Without care that is 400 undo steps for one line.
 *
 * `coalesceKey` already solves exactly this for slider drags, and it solves it here: every
 * dispatch for a given stroke carries `stroke:<id>`, so History replaces the top entry in place
 * instead of pushing. One stroke, one undo, and the intermediate states are never retained.
 *
 * The subtle part is that this makes the command NOT idempotent-by-value: it appends a point to
 * whatever the current document holds, and the current document already contains the points
 * from the previous dispatch (History replaced the *entry*, not the state). That is correct,
 * and it is why `extendStroke` takes the new points rather than the whole point list — sending
 * the full list each time would be O(n²) over a long stroke and would also make the undo entry
 * depend on how often pointermove happened to fire.
 *
 * Same two rules as every other command file:
 *   • **Never throw** — `apply` runs inside History.dispatch, where a throw is a UI crash.
 *   • **Never bake pixels** — ops describe paint; the rasterizer derives it.
 */

import type { Command } from '@opencut/core';
import { newId } from '@opencut/core';
import type { BrushSettings } from '../model/brush.js';
import { createMask, createRasterLayer } from '../model/factory.js';
import type { Point } from '../model/geometry.js';
import type { LayerId } from '../model/ids.js';
import type { Fill } from '../model/paint.js';
import type { BucketOp, ClearOp, GradientOp, PaintOp, PaintOpId, StrokeOp, StrokePoint } from '../model/paintOps.js';
import type { Selection } from '../model/selection.js';
import { hasSelection } from '../model/selection.js';
import { findLayer, parentOf } from '../model/tree.js';
import type { Layer, LayerMask, PhotoDocument } from '../model/types.js';
import { isGroupLayer, isRasterLayer } from '../model/types.js';
import { addLayer, moveLayerTo, updateLayer } from './mutations.js';

type PhotoCommand = Command<PhotoDocument>;

export const newPaintOpId = (): PaintOpId => newId('op');

/**
 * Where a paint op lands: the layer's own surface, or its mask.
 *
 * One enum rather than two parallel command sets, because every op supports both and the
 * difference is a single field lookup. Painting a mask is how the editor does local blur,
 * dodge, burn and erase-without-destroying, so it is not a niche path.
 */
export type PaintTarget = 'layer' | 'mask';

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add an empty paint layer above `aboveLayerId` (or at the top).
 *
 * This is what the brush does when the selected layer cannot be painted into. Creating a layer
 * rather than rasterizing the photo is the whole non-destructive promise, and it is also what
 * lets the user move the paint afterwards.
 */
export function addRasterLayer(aboveLayerId?: LayerId | null, name = 'Paint'): PhotoCommand {
  return {
    label: 'New Paint Layer',
    apply: (doc) => {
      const layer = createRasterLayer(doc.width, doc.height, name);
      if (!aboveLayerId) return addLayer(doc, layer);
      // Land it directly above the reference layer, inside whatever group that layer is in —
      // a paint layer that jumps to the document root every time is one the user has to
      // re-file after every stroke.
      const parent = parentOf(doc.layers, aboveLayerId);
      const parentId = parent?.id ?? null;
      const siblings = parent && isGroupLayer(parent) ? parent.children : doc.layers;
      const at = siblings.findIndex((l) => l.id === aboveLayerId);
      const withLayer = addLayer(doc, layer, parentId);
      if (at === -1) return withLayer;
      return moveLayerTo(withLayer, layer.id, parentId, at + 1);
    },
  };
}

export function addMask(layerId: LayerId, base: 'reveal' | 'hide' = 'reveal'): PhotoCommand {
  return {
    label: 'Add Layer Mask',
    apply: (doc) => updateLayer(doc, layerId, (l) => (l.mask ? l : { ...l, mask: createMask(base) })),
  };
}

export function removeMask(layerId: LayerId): PhotoCommand {
  return {
    label: 'Delete Layer Mask',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!l.mask) return l;
        const next = { ...l };
        delete next.mask;
        return next;
      }),
  };
}

export function setMask(layerId: LayerId, patch: Partial<LayerMask>): PhotoCommand {
  const keys = Object.keys(patch).sort().join(',');
  return {
    label: 'Layer Mask',
    coalesceKey: `mask:${layerId}:${keys}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (!l.mask) return l;
        const mask = { ...l.mask, ...patch };
        const same = (Object.keys(mask) as (keyof LayerMask)[]).every((k) => mask[k] === l.mask![k]);
        return same ? l : { ...l, mask };
      }),
  };
}

/**
 * Turn the current selection into a mask on `layerId`.
 *
 * The selection's regions are copied in wholesale, which is what makes this instant and exact:
 * both are geometry in canvas space, so there is nothing to rasterize and nothing to lose.
 * `hide` inverts the sense — "mask out the selection" rather than "keep only the selection".
 */
export function maskFromSelection(layerId: LayerId, mode: 'keep' | 'hide' = 'keep'): PhotoCommand {
  return {
    label: 'Mask From Selection',
    apply: (doc) => {
      if (!hasSelection(doc.selection)) return doc;
      const sel = doc.selection!;
      return updateLayer(doc, layerId, (l) => ({
        ...l,
        mask: {
          // Keeping the selection means everything OUTSIDE it is hidden, so the mask starts
          // hidden and the regions reveal. Hiding it is the exact mirror.
          enabled: true,
          inverted: mode === 'hide' ? !sel.inverted : sel.inverted,
          base: mode === 'keep' ? 'hide' : 'reveal',
          regions: sel.regions.map((r) => ({ ...r })),
          ops: [],
        },
      }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paint ops
// ─────────────────────────────────────────────────────────────────────────────

/** Read the op list of whichever surface the target names. */
const opsOf = (layer: Layer, target: PaintTarget): PaintOp[] | null =>
  target === 'mask' ? layer.mask?.ops ?? null : isRasterLayer(layer) ? layer.ops : null;

/** Write an op list back to whichever surface the target names. */
function withOps(layer: Layer, target: PaintTarget, ops: PaintOp[]): Layer {
  if (target === 'mask') return layer.mask ? { ...layer, mask: { ...layer.mask, ops } } : layer;
  return isRasterLayer(layer) ? { ...layer, ops } : layer;
}

/**
 * The clip fields alone — NOT `Partial<PaintOp>`.
 *
 * Spreading a `Partial<PaintOp>` into an op literal widens its `kind` back to the full union
 * and the discriminant stops discriminating, so every op below would fail to typecheck as
 * itself. Naming just the fields keeps the literal's own `kind` narrow.
 */
type ClipFields = Pick<PaintOp, 'clip' | 'clipFeather' | 'clipExpand' | 'clipInverted'>;

/** Snapshot the live selection onto an op, so the op stays clipped after a deselect. */
function clipOf(selection: Selection | null): ClipFields {
  if (!hasSelection(selection)) return {};
  const sel = selection!;
  return {
    clip: sel.regions.map((r) => ({ ...r })),
    clipFeather: sel.feather,
    clipExpand: sel.expand,
    clipInverted: sel.inverted,
  };
}

/**
 * Begin a stroke, or extend the one already in flight.
 *
 * Coalesced on the stroke id — see this file's header for why that is the whole trick. Points
 * are APPENDED, so each dispatch carries only what is new.
 */
export function extendStroke(
  layerId: LayerId,
  target: PaintTarget,
  strokeId: PaintOpId,
  brush: BrushSettings,
  points: readonly StrokePoint[],
): PhotoCommand {
  return {
    label: brush.kind === 'eraser' ? 'Erase' : 'Brush Stroke',
    coalesceKey: `stroke:${strokeId}`,
    apply: (doc) => {
      if (points.length === 0) return doc;
      return updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops) return l;
        const last = ops[ops.length - 1];
        if (last && last.id === strokeId && last.kind === 'stroke') {
          const merged: StrokeOp = { ...last, points: [...last.points, ...points] };
          return withOps(l, target, [...ops.slice(0, -1), merged]);
        }
        const op: StrokeOp = {
          kind: 'stroke',
          id: strokeId,
          brush: { ...brush, dynamics: { ...brush.dynamics } },
          points: [...points],
          ...clipOf(doc.selection),
        };
        return withOps(l, target, [...ops, op]);
      });
    },
  };
}

export function fillBucket(
  layerId: LayerId,
  target: PaintTarget,
  at: Point,
  color: string,
  opts: { tolerance?: number; contiguous?: boolean } = {},
): PhotoCommand {
  return {
    label: 'Fill',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops) return l;
        const op: BucketOp = {
          kind: 'bucket',
          id: newPaintOpId(),
          x: at.x,
          y: at.y,
          color,
          tolerance: opts.tolerance ?? 0.15,
          contiguous: opts.contiguous ?? true,
          ...clipOf(doc.selection),
        };
        return withOps(l, target, [...ops, op]);
      }),
  };
}

/**
 * Draw a gradient.
 *
 * Coalesced per gradient id so dragging the endpoints is live and still one undo step — a
 * gradient is dragged out over a second or two and every frame of that drag would otherwise
 * be an entry.
 */
export function drawGradient(
  layerId: LayerId,
  target: PaintTarget,
  gradientId: PaintOpId,
  from: Point,
  to: Point,
  fill: Fill,
  shape: 'linear' | 'radial' = 'linear',
): PhotoCommand {
  return {
    label: 'Gradient',
    coalesceKey: `gradient:${gradientId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops) return l;
        const op: GradientOp = {
          kind: 'gradient',
          id: gradientId,
          from: { ...from },
          to: { ...to },
          fill,
          shape,
          ...clipOf(doc.selection),
        };
        const last = ops[ops.length - 1];
        if (last && last.id === gradientId) return withOps(l, target, [...ops.slice(0, -1), op]);
        return withOps(l, target, [...ops, op]);
      }),
  };
}

/** Erase everything inside the selection — what Delete does when a marquee is up. */
export function clearSelection(layerId: LayerId, target: PaintTarget): PhotoCommand {
  return {
    label: 'Erase Selection',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops) return l;
        const op: ClearOp = { kind: 'clear', id: newPaintOpId(), ...clipOf(doc.selection) };
        return withOps(l, target, [...ops, op]);
      }),
  };
}

/** Drop every op from a surface. The "start over" that is one step rather than N undos. */
export function clearPaint(layerId: LayerId, target: PaintTarget): PhotoCommand {
  return {
    label: 'Clear Paint',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops || ops.length === 0) return l;
        return withOps(l, target, []);
      }),
  };
}

/** Remove one op from the middle of the list — the op list is editable, not just appendable. */
export function deletePaintOp(layerId: LayerId, target: PaintTarget, opId: PaintOpId): PhotoCommand {
  return {
    label: 'Delete Paint Step',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const ops = opsOf(l, target);
        if (!ops) return l;
        const next = ops.filter((o) => o.id !== opId);
        return next.length === ops.length ? l : withOps(l, target, next);
      }),
  };
}

/**
 * The layer a paint action should target, and whether one must be created first.
 *
 * Centralised because four call sites need the same three-way answer — paint into the selected
 * raster layer, paint into its mask, or make a new raster layer — and disagreeing about it is
 * how a brush ends up silently painting on the wrong layer.
 */
export function resolvePaintTarget(
  doc: PhotoDocument,
  selectedId: LayerId | null,
  maskMode: boolean,
): { layerId: LayerId; target: PaintTarget } | { needsNewLayer: true; aboveId: LayerId | null } {
  const layer = selectedId ? findLayer(doc.layers, selectedId) : undefined;
  if (!layer) return { needsNewLayer: true, aboveId: null };
  if (maskMode && layer.mask) return { layerId: layer.id, target: 'mask' };
  if (isRasterLayer(layer) && !maskMode) return { layerId: layer.id, target: 'layer' };
  return { needsNewLayer: true, aboveId: layer.id };
}
