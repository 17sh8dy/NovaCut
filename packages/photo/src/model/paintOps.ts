/**
 * Paint operations — what a painted surface is made of.
 *
 * A raster layer does not store pixels. It stores the ORDERED LIST OF OPERATIONS that produce
 * them: strokes, fills, gradients, erasures. The pixels are re-derived by replaying that list
 * (`engine/src/photo/paintRaster.ts`), exactly as the composite is re-derived from the layer
 * tree.
 *
 * ## Why not a pixel buffer
 *
 * Because of the invariant at the top of `types.ts`: History retains up to 200 whole document
 * states, and that is cheap for JSON and ruinous for image buffers. A tiled copy-on-write
 * raster with refcounted tiles would also work and is what a mature editor eventually needs —
 * but it is a memory manager, a GPU upload path and an eviction policy, and every one of those
 * is a place for a leak to hide. An op list gets undo, redo, serialization and structural
 * sharing from machinery that already exists and is already tested.
 *
 * The honest costs, since they are real:
 *
 *   • **Replay is O(ops).** Mitigated by caching the rasterized result per layer and, for the
 *     common append-only case, drawing only the new op onto the cached canvas. Undo past a
 *     stroke does force a full replay of that layer.
 *   • **Pixels cannot be imported into a paint layer.** Pasting a photo produces an image
 *     layer, which is the right answer anyway. What is genuinely not expressible is
 *     "rasterize this layer and keep painting on it", and that lands when a raster ref does.
 *   • **Ops that READ the surface** — smudge, blur brush — read only the layer's own accumulated
 *     pixels, never the backdrop beneath it. That is why they are not here: see the note at the
 *     bottom of this file for the non-destructive route that replaces them.
 *
 * ## Clipping
 *
 * Every op can carry a snapshot of the selection it was made under. Storing it per-op rather
 * than reading the document's live selection at replay time is what makes a stroke stay
 * clipped to the marquee it was painted in, even after the user deselects — which is the only
 * behaviour that is not astonishing.
 */

import type { BrushSettings } from './brush.js';
import type { Fill } from './paint.js';
import type { Point } from './geometry.js';
import type { SelectionRegion } from './selection.js';

/** A branded-enough id. Ops need identity so the UI can key rows and coalesce edits. */
export type PaintOpId = string;

interface OpBase {
  id: PaintOpId;
  /**
   * The selection in force when this op was made, as geometric regions. Absent means unclipped.
   * Feather and expand are baked in as a separate field so replay needs no Selection object.
   */
  clip?: SelectionRegion[];
  clipFeather?: number;
  clipExpand?: number;
  clipInverted?: boolean;
}

/** One point of a stroke. `p` is 0..1 pointer pressure; 0.5 for hardware without it. */
export interface StrokePoint {
  x: number;
  y: number;
  p: number;
}

export interface StrokeOp extends OpBase {
  kind: 'stroke';
  brush: BrushSettings;
  points: StrokePoint[];
}

/**
 * Flood fill from a seed point.
 *
 * Samples the layer's OWN accumulated pixels at replay time, not the composite — a paint layer
 * is its own world. On an empty layer that means the fill covers everything inside the clip,
 * which is predictable and is also exactly how "fill the selection" gets expressed.
 */
export interface BucketOp extends OpBase {
  kind: 'bucket';
  x: number;
  y: number;
  color: string;
  /** 0..1 — how far a pixel may differ from the seed and still be filled. */
  tolerance: number;
  /** False fills every matching pixel anywhere, not just the connected blob. */
  contiguous: boolean;
}

export interface GradientOp extends OpBase {
  kind: 'gradient';
  from: Point;
  to: Point;
  fill: Fill;
  shape: 'linear' | 'radial';
}

/** Erase everything inside the clip. What Delete does with an active selection. */
export interface ClearOp extends OpBase {
  kind: 'clear';
}

export type PaintOp = StrokeOp | BucketOp | GradientOp | ClearOp;

export const isStrokeOp = (op: PaintOp): op is StrokeOp => op.kind === 'stroke';

/** Human labels, for the history panel and the op list. */
export const PAINT_OP_LABELS: Record<PaintOp['kind'], string> = {
  stroke: 'Brush Stroke',
  bucket: 'Fill',
  gradient: 'Gradient',
  clear: 'Erase',
};

export const paintOpLabel = (op: PaintOp): string =>
  op.kind === 'stroke' && op.brush.kind === 'eraser' ? 'Erase' : PAINT_OP_LABELS[op.kind];

/**
 * A stable signature over everything that affects the rendered pixels.
 *
 * Used by the rasterizer's cache. Note it includes the op ids: two strokes with identical
 * geometry are still two strokes, and collapsing them would make undo skip one.
 */
export const paintSignature = (ops: readonly PaintOp[]): string => JSON.stringify(ops);

/**
 * The bounding box an op touches, or null when it covers the whole surface.
 *
 * The rasterizer uses this to redraw only the region an appended stroke dirtied instead of
 * replaying the whole list — which is what keeps a 300-stroke layer interactive.
 */
export function opBounds(op: PaintOp): { x: number; y: number; width: number; height: number } | null {
  if (op.kind === 'stroke') {
    if (op.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of op.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    // Pad by the full stamp radius — the stroke's extent is its path grown by the brush.
    const pad = op.brush.size / 2 + 2;
    return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
  }
  if (op.kind === 'gradient') return null; // a gradient covers the surface it is drawn across
  return null; // bucket and clear can reach anywhere
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliberately not modelled — and what replaces them
// ─────────────────────────────────────────────────────────────────────────────
//
// **Smudge, blur brush, sharpen brush, dodge and burn** are absent, and not because they are
// hard to draw. They are absent because on a paint layer they would have nothing to read: the
// pixels they are supposed to push around live in the layers BENEATH, and a paint op is
// replayed in isolation from the composite. An implementation that read only the paint layer's
// own alpha would smudge nothing on a fresh layer, which is a feature that appears to work and
// does not.
//
// The non-destructive route already exists and is better: add the corresponding ADJUSTMENT or
// EFFECT layer (Blur, Sharpen, Exposure for dodge/burn) and paint its MASK. That gives local,
// re-editable, re-orderable blur and dodge — with a brush — and every parameter stays live
// forever. The UI points at this explicitly rather than leaving the user to discover it.
//
// A true destructive smudge lands with a raster surface the ops can sample, which is the same
// prerequisite as "rasterize this layer".
