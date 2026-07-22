/**
 * Layer geometry for the UI.
 *
 * The one thing the canvas overlay must never get wrong: where a layer actually is. The math
 * itself lives in `@opencut/photo`'s `geometry.ts` — shared with the renderer precisely so the
 * handles land on the pixels the GPU drew. What this file adds is the piece the domain layer
 * cannot supply: a layer's NATURAL size.
 *
 * An image's natural size comes from its MediaAsset; a text or shape layer's comes from
 * measuring it, which needs a font stack and therefore a browser. `@opencut/photo` is a
 * zero-DOM package by design, so it takes the size as an argument and this resolves it.
 */

import { vectorNaturalSize } from '@opencut/engine';
import {
  boundsOf,
  fitModeOf,
  hitTestBox,
  isGroupLayer,
  isVectorLayer,
  layerCorners,
  layerMatrix,
  type Layer,
  type LayerId,
  type PhotoDocument,
  type Point,
  type Rect,
  type Size,
} from '@opencut/photo';

/**
 * A layer's source size, before its own transform.
 *
 * Groups report the canvas: they flatten into a canvas-sized buffer before being placed, which
 * is exactly what the render graph does, so their selection box is the canvas box scaled by
 * their transform. Adjustment layers have no pixels and report nothing.
 */
export function naturalSizeOf(layer: Layer, doc: PhotoDocument): Size {
  if (isVectorLayer(layer)) return vectorNaturalSize(layer);
  if (isGroupLayer(layer)) return { width: doc.width, height: doc.height };
  if (layer.kind === 'image' && layer.mediaId) {
    const media = doc.media.find((m) => m.id === layer.mediaId);
    if (media) return { width: media.width, height: media.height };
  }
  return { width: 0, height: 0 };
}

/** The layer's four corners in canvas pixels, clockwise from top-left. */
export const cornersOf = (layer: Layer, doc: PhotoDocument) =>
  layerCorners(layer.transform, naturalSizeOf(layer, doc), { width: doc.width, height: doc.height }, fitModeOf(layer));

/** The axis-aligned box around a layer, in canvas pixels. */
export const boxOf = (layer: Layer, doc: PhotoDocument): Rect => boundsOf(cornersOf(layer, doc));

/** The layer's local→canvas matrix, for drawing an overlay in its own rotated frame. */
export const matrixOf = (layer: Layer, doc: PhotoDocument) =>
  layerMatrix(layer.transform, naturalSizeOf(layer, doc), { width: doc.width, height: doc.height }, fitModeOf(layer));

/**
 * The topmost layer under `point`, or null.
 *
 * Walks the tree in REVERSE document order, because the document stores bottom-to-top and the
 * user always means the layer they can see. Locked and hidden layers are skipped — that is what
 * locking a layer is *for*, and a lock that still swallowed clicks would be worse than none.
 *
 * Hit-testing descends into groups but returns the GROUP, not the child: clicking a photo
 * inside a folder selects the folder, which is what every design tool does and what makes a
 * grouped badge draggable as a unit. Double-click-to-enter is the escape hatch the canvas adds.
 */
export function hitTest(point: Point, doc: PhotoDocument): Layer | null {
  const canvas = { width: doc.width, height: doc.height };
  const visit = (layers: readonly Layer[]): Layer | null => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      if (!layer.visible || layer.locked) continue;
      if (layer.kind === 'adjustment') continue; // no pixels to hit
      if (isGroupLayer(layer)) {
        // A group's own box is the whole canvas, so testing it directly would make every click
        // anywhere hit the topmost group. Test its CHILDREN and report the group.
        if (visit(layer.children)) return layer;
        continue;
      }
      if (hitTestBox(point, layer.transform, naturalSizeOf(layer, doc), canvas, fitModeOf(layer))) {
        return layer;
      }
    }
    return null;
  };
  return visit(doc.layers);
}

/** As `hitTest`, but descends into groups and returns the leaf — what double-click uses. */
export function hitTestDeep(point: Point, doc: PhotoDocument): Layer | null {
  const canvas = { width: doc.width, height: doc.height };
  const visit = (layers: readonly Layer[]): Layer | null => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      if (!layer.visible || layer.locked || layer.kind === 'adjustment') continue;
      if (isGroupLayer(layer)) {
        const inner = visit(layer.children);
        if (inner) return inner;
        continue;
      }
      if (hitTestBox(point, layer.transform, naturalSizeOf(layer, doc), canvas, fitModeOf(layer))) {
        return layer;
      }
    }
    return null;
  };
  return visit(doc.layers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapping
// ─────────────────────────────────────────────────────────────────────────────

/** A line the canvas draws while a drag is snapped to it. */
export interface SnapGuide {
  axis: 'x' | 'y';
  /** Canvas-pixel position of the line. */
  at: number;
  /** What it aligned to, for the overlay's styling — the canvas reads differently to a peer. */
  kind: 'canvas' | 'layer';
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Nudge a proposed move so the dragged box lines up with the canvas or with other layers.
 *
 * Candidates are the three interesting positions on each axis — the two edges and the centre —
 * for the canvas and for every other visible root layer. The first candidate within `tolerance`
 * wins per axis, and the tolerance is in SCREEN pixels converted by the caller: a 6px magnet at
 * 25% zoom must be a 24-canvas-pixel magnet, or snapping stops working the moment a user zooms
 * out to see their whole 4K wallpaper.
 *
 * Returns adjusted deltas plus the guides to draw. It never *prevents* a move — an unsnappable
 * drag returns the deltas it was given.
 */
export function snapMove(
  box: Rect,
  proposed: { dx: number; dy: number },
  doc: PhotoDocument,
  excludeIds: ReadonlySet<LayerId>,
  tolerance: number,
): SnapResult {
  const moved: Rect = { ...box, x: box.x + proposed.dx, y: box.y + proposed.dy };

  const xTargets: { at: number; kind: SnapGuide['kind'] }[] = [
    { at: 0, kind: 'canvas' },
    { at: doc.width / 2, kind: 'canvas' },
    { at: doc.width, kind: 'canvas' },
  ];
  const yTargets: { at: number; kind: SnapGuide['kind'] }[] = [
    { at: 0, kind: 'canvas' },
    { at: doc.height / 2, kind: 'canvas' },
    { at: doc.height, kind: 'canvas' },
  ];

  for (const layer of doc.layers) {
    if (!layer.visible || excludeIds.has(layer.id) || layer.kind === 'adjustment') continue;
    const r = boxOf(layer, doc);
    xTargets.push({ at: r.x, kind: 'layer' }, { at: r.x + r.width / 2, kind: 'layer' }, { at: r.x + r.width, kind: 'layer' });
    yTargets.push({ at: r.y, kind: 'layer' }, { at: r.y + r.height / 2, kind: 'layer' }, { at: r.y + r.height, kind: 'layer' });
  }

  const x = bestSnap([moved.x, moved.x + moved.width / 2, moved.x + moved.width], xTargets, tolerance);
  const y = bestSnap([moved.y, moved.y + moved.height / 2, moved.y + moved.height], yTargets, tolerance);

  const guides: SnapGuide[] = [];
  if (x) guides.push({ axis: 'x', at: x.at, kind: x.kind });
  if (y) guides.push({ axis: 'y', at: y.at, kind: y.kind });

  return {
    dx: proposed.dx + (x?.delta ?? 0),
    dy: proposed.dy + (y?.delta ?? 0),
    guides,
  };
}

/** The smallest correction that brings any of `edges` onto any target, within tolerance. */
function bestSnap(
  edges: readonly number[],
  targets: readonly { at: number; kind: SnapGuide['kind'] }[],
  tolerance: number,
): { delta: number; at: number; kind: SnapGuide['kind'] } | null {
  let best: { delta: number; at: number; kind: SnapGuide['kind'] } | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const delta = target.at - edge;
      if (Math.abs(delta) > tolerance) continue;
      // Prefer the canvas over a peer at equal distance: aligning to the frame is almost always
      // the intent, and it keeps the guide stable instead of flickering between two ties.
      if (!best || Math.abs(delta) < Math.abs(best.delta) - 0.001 ||
        (Math.abs(delta) < Math.abs(best.delta) + 0.001 && target.kind === 'canvas' && best.kind === 'layer')) {
        best = { delta, at: target.at, kind: target.kind };
      }
    }
  }
  return best;
}
