/**
 * The paint engine — replaying a layer's op list into pixels.
 *
 * A raster layer stores operations, not a buffer (see `@opencut/photo`'s `paintOps.ts` for the
 * reasoning). This is where those become paint. Everything is a 2D canvas, for the same reason
 * the vector rasterizer is: the browser already has an antialiased rasterizer with correct
 * compositing modes, and reimplementing one in GLSL would be a worse version of it.
 *
 * ## The three things a brush has to get right
 *
 * **Stamping, not lines.** A stroke is a soft round stamp laid down at a fixed *distance*
 * interval along the path — not `lineTo` with a round cap. A polyline cannot vary width or
 * opacity along its length, so pressure would have nothing to modulate; and it produces a hard
 * join at every point, which is visible the moment hardness drops below 1.
 *
 * **Opacity is not flow.** Each stamp deposits `flow`; the stroke as a whole is capped at
 * `opacity`. That requires the stroke to be rendered into its OWN buffer at flow, then
 * composited once at opacity. Painting stamps straight onto the layer would make a 20% brush
 * reach 100% after five overlapping stamps, which is the single most common way a brush feels
 * wrong.
 *
 * **Smoothing has to be causal.** The stroke is drawn while the user is still drawing it, so a
 * filter that needs future points cannot be used. This pulls the stamp position toward the
 * cursor with an exponential lag, which is the standard trick and is what makes a fast arc read
 * as a curve rather than a seismograph.
 *
 * ## Incremental replay
 *
 * The full list is replayed on any change EXCEPT the common one: an append. `PaintCache` keeps
 * the canvas and the op ids that produced it, so extending a stroke redraws only the new
 * portion. Without that, a 300-op layer would replay 300 ops on every pointermove.
 */

import {
  paintSignature,
  stampInterval,
  type BrushSettings,
  type Fill,
  type PaintOp,
  type StrokeOp,
  type StrokePoint,
} from '@opencut/photo';
import { rasterizeCoverage, type Size } from './coverage.js';

export type { Size };

function newSurface(size: Size): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width));
  canvas.height = Math.max(1, Math.round(size.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? { canvas, ctx } : null;
}

/**
 * Replay a whole op list into a fresh canvas. Null when the list is empty.
 *
 * Null rather than a blank canvas so the render graph can skip a layer that has nothing on it
 * — an empty paint layer is the normal state right after "New Paint Layer", and uploading a
 * transparent 4K texture for it every frame would be pure waste.
 */
export function replayPaintOps(ops: readonly PaintOp[], size: Size): HTMLCanvasElement | null {
  if (ops.length === 0) return null;
  const surface = newSurface(size);
  if (!surface) return null;
  for (const op of ops) applyOp(surface.ctx, surface.canvas, op, size);
  return surface.canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ops
// ─────────────────────────────────────────────────────────────────────────────

function applyOp(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  op: PaintOp,
  size: Size,
): void {
  switch (op.kind) {
    case 'stroke':
      drawStroke(ctx, canvas, op, size);
      return;
    case 'bucket':
      drawBucket(ctx, canvas, op, size);
      return;
    case 'gradient':
      drawGradientOp(ctx, canvas, op, size);
      return;
    case 'clear':
      clearRegion(ctx, canvas, op, size);
      return;
  }
}

/**
 * One stroke: stamps into a scratch buffer, clipped, then composited once.
 *
 * The eraser takes the same path and differs only in the final composite — `destination-out`
 * instead of `source-over`. That is worth doing rather than special-casing the stamp loop:
 * hardness, spacing, pressure and smoothing then behave identically for both, which is what
 * makes an eraser feel like the brush it is undoing.
 */
function drawStroke(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  op: StrokeOp,
  size: Size,
): void {
  if (op.points.length === 0) return;
  const scratch = newSurface(size);
  if (!scratch) return;

  stampAlong(scratch.ctx, op.brush, op.points);
  applyClip(scratch.ctx, op, size);

  ctx.save();
  ctx.globalAlpha = clamp01(op.brush.opacity);
  ctx.globalCompositeOperation = op.brush.kind === 'eraser' ? 'destination-out' : 'source-over';
  ctx.drawImage(scratch.canvas, 0, 0);
  ctx.restore();
  void canvas;
}

/**
 * Lay stamps along the path at a fixed distance interval.
 *
 * The loop walks *distance*, not points: pointer events arrive at whatever rate the hardware
 * manages, so spacing the stamps by event would make a fast stroke dotted and a slow one solid.
 * Interpolating along each segment is what decouples the stroke's look from the input rate.
 */
function stampAlong(
  ctx: CanvasRenderingContext2D,
  brush: BrushSettings,
  points: readonly StrokePoint[],
): void {
  const interval = stampInterval(brush);
  const smoothing = clamp01(brush.smoothing);
  // Exponential lag. At smoothing 0 the stamp is exactly at the cursor; at 1 it trails heavily.
  // Squared because the useful range is bunched at the low end — a linear factor spends most of
  // its travel in territory that feels like lag rather than smoothing.
  const lag = smoothing * smoothing * 0.85;

  let cursor: StrokePoint = { ...points[0]! };
  let carry = 0;
  stamp(ctx, brush, cursor);

  for (let i = 1; i < points.length; i++) {
    const target = points[i]!;
    // Pull the virtual cursor toward the real point, then stamp along the path it travelled.
    const next: StrokePoint = {
      x: cursor.x + (target.x - cursor.x) * (1 - lag),
      y: cursor.y + (target.y - cursor.y) * (1 - lag),
      p: cursor.p + (target.p - cursor.p) * (1 - lag),
    };

    const dx = next.x - cursor.x;
    const dy = next.y - cursor.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) {
      cursor = next;
      continue;
    }
    let travelled = interval - carry;
    while (travelled <= dist) {
      const t = travelled / dist;
      stamp(ctx, brush, {
        x: cursor.x + dx * t,
        y: cursor.y + dy * t,
        p: cursor.p + (next.p - cursor.p) * t,
      });
      travelled += interval;
    }
    // Carry the leftover distance into the next segment, so spacing stays uniform across
    // segment boundaries instead of resetting at every pointer event.
    carry = dist - (travelled - interval);
    cursor = next;
  }
}

/** One stamp: a radial falloff disc, or a hard disc for the pencil. */
function stamp(ctx: CanvasRenderingContext2D, brush: BrushSettings, at: StrokePoint): void {
  const pressure = brush.dynamics.size ? 0.25 + at.p * 0.75 : 1;
  const radius = (brush.size * pressure) / 2;
  if (radius <= 0.05) return;

  const alpha = clamp01(brush.flow) * (brush.dynamics.opacity ? clamp01(at.p) : 1);
  if (alpha <= 0) return;

  ctx.save();
  // Stamps ACCUMULATE with 'lighter' on the alpha channel so overlapping stamps within one
  // stroke build toward solid. Plain source-over would also work but composites colour on every
  // stamp, which visibly darkens a soft brush along its own centreline.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;

  if (brush.kind === 'pencil' || brush.hardness >= 0.999) {
    ctx.fillStyle = paintColor(brush);
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Hardness sets where the falloff STARTS, not how steep it is: a hardness of 0.6 means the
  // inner 60% is solid and the outer 40% ramps out. That is the control users expect, and it
  // keeps hardness 1 identical to the hard-disc branch above.
  const inner = Math.max(0, Math.min(0.98, brush.hardness)) * radius;
  const gradient = ctx.createRadialGradient(at.x, at.y, inner, at.x, at.y, radius);
  const color = paintColor(brush);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, transparentOf(color));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The eraser paints WHITE into its scratch buffer, not its colour.
 *
 * The buffer is composited with `destination-out`, which reads only alpha — but a gradient
 * stop needs some colour, and using the brush's (often transparent-ish) colour would make the
 * falloff wrong. Opaque white is the neutral choice.
 */
const paintColor = (brush: BrushSettings): string =>
  brush.kind === 'eraser' ? '#ffffff' : brush.color;

/** The same colour at zero alpha, for the outer stop of a falloff. */
function transparentOf(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) return `#${hex[1]}00`;
  const short = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (short) {
    const h = short[1]!;
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}00`;
  }
  // Any other CSS colour (rgb(), a named colour): fall back to fully transparent black, which
  // is correct for the alpha ramp even though the hue of the invisible end differs.
  return 'rgba(0,0,0,0)';
}

/**
 * Flood fill against the layer's own accumulated pixels.
 *
 * Sampling the layer rather than the composite is stated in the model and is what keeps a paint
 * layer self-contained: an op list must replay to the same pixels regardless of what is
 * underneath it, or undoing a change two layers down would silently repaint this one.
 */
function drawBucket(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  op: Extract<PaintOp, { kind: 'bucket' }>,
  size: Size,
): void {
  const w = canvas.width;
  const h = canvas.height;
  const image = ctx.getImageData(0, 0, w, h);
  const mask = floodFillMask(image, op.x, op.y, op.tolerance, op.contiguous);

  const scratch = newSurface(size);
  if (!scratch) return;
  // Build the fill as a coverage bitmap, then paint the colour through it. Setting RGB per
  // pixel here instead would skip the browser's colour parsing and force this code to
  // reimplement it for every CSS colour form.
  const out = scratch.ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.data[i * 4 + 3] = 255;
  scratch.ctx.putImageData(out, 0, 0);
  scratch.ctx.globalCompositeOperation = 'source-in';
  scratch.ctx.fillStyle = op.color;
  scratch.ctx.fillRect(0, 0, w, h);
  scratch.ctx.globalCompositeOperation = 'source-over';

  applyClip(scratch.ctx, op, size);
  ctx.drawImage(scratch.canvas, 0, 0);
}

/**
 * A local copy of the scanline flood fill.
 *
 * `trace.ts` has one too, and they are NOT the same function despite the shared shape: that one
 * feeds the wand and returns a mask to be traced into geometry, this one feeds a fill and works
 * on the paint surface. Sharing them would mean one module importing the other purely for a
 * loop, and would couple the wand's sampling rules to the bucket's.
 */
function floodFillMask(
  image: ImageData,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous: boolean,
): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return out;

  const o0 = (sy * width + sx) * 4;
  const seed = [data[o0]!, data[o0 + 1]!, data[o0 + 2]!, data[o0 + 3]!];
  const maxDist = tolerance * 255;
  const threshold = maxDist * maxDist * 4;
  const matches = (i: number): boolean => {
    const o = i * 4;
    const dr = data[o]! - seed[0]!;
    const dg = data[o + 1]! - seed[1]!;
    const db = data[o + 2]! - seed[2]!;
    const da = data[o + 3]! - seed[3]!;
    return dr * dr + dg * dg + db * db + da * da <= threshold;
  };

  if (!contiguous) {
    for (let i = 0; i < out.length; i++) if (matches(i)) out[i] = 1;
    return out;
  }

  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * width;
    let left = x;
    while (left >= 0 && !out[row + left] && matches(row + left)) left--;
    left++;
    let right = x;
    while (right < width && !out[row + right] && matches(row + right)) right++;
    right--;
    if (left > right) continue;
    for (let i = left; i <= right; i++) out[row + i] = 1;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inSpan = false;
      for (let i = left; i <= right; i++) {
        const hit = !out[nrow + i] && matches(nrow + i);
        if (hit && !inSpan) {
          stack.push(i, ny);
          inSpan = true;
        } else if (!hit) inSpan = false;
      }
    }
  }
  return out;
}

function drawGradientOp(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  op: Extract<PaintOp, { kind: 'gradient' }>,
  size: Size,
): void {
  const scratch = newSurface(size);
  if (!scratch) return;
  const gradient =
    op.shape === 'radial'
      ? scratch.ctx.createRadialGradient(
          op.from.x, op.from.y, 0,
          op.from.x, op.from.y, Math.max(1, Math.hypot(op.to.x - op.from.x, op.to.y - op.from.y)),
        )
      : scratch.ctx.createLinearGradient(op.from.x, op.from.y, op.to.x, op.to.y);
  for (const stop of stopsOf(op.fill)) {
    try {
      gradient.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
    } catch {
      /* an unparseable colour is skipped rather than taking down the whole render */
    }
  }
  scratch.ctx.fillStyle = gradient;
  scratch.ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyClip(scratch.ctx, op, size);
  ctx.drawImage(scratch.canvas, 0, 0);
}

/** A `Fill` reduced to stops. A solid fill becomes a flat two-stop ramp. */
const stopsOf = (fill: Fill): { offset: number; color: string }[] =>
  fill.kind === 'solid'
    ? [{ offset: 0, color: fill.color }, { offset: 1, color: fill.color }]
    : [...fill.stops].sort((a, b) => a.offset - b.offset);

/** Erase inside the clip — or everything, when there is no clip. */
function clearRegion(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  op: Extract<PaintOp, { kind: 'clear' }>,
  size: Size,
): void {
  if (!op.clip || op.clip.length === 0) {
    if (op.clipInverted) return; // an inverted empty clip is "everything", already handled below
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const scratch = newSurface(size);
  if (!scratch) return;
  scratch.ctx.fillStyle = '#fff';
  scratch.ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyClip(scratch.ctx, op, size);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(scratch.canvas, 0, 0);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clip a scratch buffer to the selection the op was made under.
 *
 * `destination-in` against the selection's coverage, not `ctx.clip()`. The clip path would give
 * a hard, aliased boundary and throw the feather away entirely — which is the whole reason a
 * feathered selection exists.
 *
 * The coverage comes from the same `rasterizeCoverage` the selection overlay uses, so a clipped
 * stroke and the marching ants it was drawn inside can never disagree about where the boundary
 * is.
 */
function applyClip(
  ctx: CanvasRenderingContext2D,
  op: PaintOp,
  size: Size,
): void {
  const regions = op.clip;
  const inverted = op.clipInverted ?? false;
  if ((!regions || regions.length === 0) && !inverted) return;
  const coverage = rasterizeCoverage(
    regions ?? [],
    op.clipFeather ?? 0,
    op.clipExpand ?? 0,
    inverted,
    size,
  );
  // Null means "everything is covered" — nothing to clip against.
  if (!coverage) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(coverage, 0, 0);
  ctx.restore();
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rasterized paint surfaces, keyed by surface, with a real incremental path.
 *
 * The fast path is the whole reason this class exists. While a stroke is being drawn the op
 * list changes on every pointermove, and the change is always the same shape: the LAST op grew,
 * everything before it is untouched. So the cache keeps a `base` canvas holding ops[0..n-2] —
 * which by definition does not change during a stroke — and each frame copies it and applies
 * only the final op.
 *
 * That turns a 300-op layer from 300 replays per pointermove into one canvas blit plus one
 * stroke. Any other change (an undo, a deleted op, a reorder) fails the id check and falls back
 * to a full replay, which is correct but O(ops) — and rare, because it corresponds to a
 * deliberate user action rather than to moving the mouse.
 */
export class PaintCache {
  private entries = new Map<string, Entry>();

  get(key: string, ops: readonly PaintOp[], size: Size): HTMLCanvasElement | null {
    if (ops.length === 0) {
      this.entries.delete(key);
      return null;
    }
    const sizeKey = `${Math.round(size.width)}x${Math.round(size.height)}`;
    const headIds = ops.slice(0, -1).map((o) => o.id);
    const last = ops[ops.length - 1]!;
    const tail = paintSignature([last]);
    const hit = this.entries.get(key);

    if (hit && hit.sizeKey === sizeKey && sameIds(hit.headIds, headIds)) {
      // Nothing changed at all — including the op still being drawn.
      if (hit.tail === tail && hit.out) return hit.out;

      const out = newSurface(size);
      if (!out) return null;
      if (hit.base) out.ctx.drawImage(hit.base, 0, 0);
      applyOp(out.ctx, out.canvas, last, size);
      hit.tail = tail;
      hit.out = out.canvas;
      return out.canvas;
    }

    // Miss: rebuild both the base and the output. Two replays, on an action the user took
    // deliberately — never on a pointermove.
    const base = headIds.length > 0 ? replayPaintOps(ops.slice(0, -1), size) : null;
    const out = newSurface(size);
    if (!out) return null;
    if (base) out.ctx.drawImage(base, 0, 0);
    applyOp(out.ctx, out.canvas, last, size);
    this.entries.set(key, { headIds, tail, base, out: out.canvas, sizeKey });
    return out.canvas;
  }

  /** Drop entries for surfaces that no longer exist, so a deleted layer frees its canvases. */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!liveKeys.has(key)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

interface Entry {
  /** Ids of every op EXCEPT the last — the part that stays fixed during a stroke. */
  headIds: string[];
  /** Signature of the last op, which is what changes as the stroke grows. */
  tail: string;
  /** ops[0..n-2] rendered. Null when there is only one op. */
  base: HTMLCanvasElement | null;
  /** The full result, returned as-is when nothing changed. */
  out: HTMLCanvasElement | null;
  sizeKey: string;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);
