/**
 * Layer masks, rasterized and cached.
 *
 * The same pattern as `VectorRasterCache` and `PaintCache`, and for the same reason: the render
 * graph redraws on every pointermove of an unrelated slider, and rasterizing a canvas-sized
 * mask — regions, feather, expand, plus a full paint replay — is far too expensive to redo
 * when nothing about it changed.
 *
 * Masks are rasterized at CANVAS size rather than at the layer's, because a mask is authored
 * against the composition the user is looking at: painting over where a layer *appears* has to
 * hide what appears there, even when that layer is scaled or rotated. So the canvas size is
 * part of the cache key, and changing the canvas invalidates every mask.
 */

import type { Layer } from '@opencut/photo';
import { maskSignature, rasterizeMask } from './maskRaster.js';
import type { CoverageCanvas } from './coverage.js';

export class MaskCache {
  private entries = new Map<string, { signature: string; canvas: CoverageCanvas | null }>();
  private width = 0;
  private height = 0;

  /** Canvas size is part of every key; changing it drops the lot. */
  setCanvasSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.entries.clear();
  }

  /** The layer's mask coverage, or null when it has none or the mask provably does nothing. */
  get(layer: Layer): CoverageCanvas | null {
    if (!layer.mask) {
      this.entries.delete(layer.id);
      return null;
    }
    const signature = maskSignature(layer.mask);
    const hit = this.entries.get(layer.id);
    if (hit && hit.signature === signature) return hit.canvas;
    const canvas = rasterizeMask(layer.mask, { width: this.width, height: this.height });
    this.entries.set(layer.id, { signature, canvas });
    return canvas;
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!liveIds.has(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
