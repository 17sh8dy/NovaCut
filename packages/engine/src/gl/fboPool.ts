/**
 * FboPool — recycled render targets.
 *
 * The video compositor gets by with a fixed ping/pong pair because its graph is flat: one
 * clip, one effect chain, one composite. A photo layer tree is not flat. Rendering a group
 * needs a buffer for the group's isolated backdrop *while* its children are still rendering
 * into buffers of their own, and that nesting is unbounded — so the target count is a property
 * of the user's document, not of the code.
 *
 * Hence acquire/release rather than two fields. Buffers are recycled by size, so a document
 * that opens ten groups allocates as many targets as its deepest nesting requires, not as many
 * as it has groups, and steady-state re-render allocates nothing at all.
 *
 * Correctness contract: **an acquired Fbo's contents are undefined**. It is a recycled buffer
 * that almost certainly holds another layer's pixels. Every caller clears or fully overwrites
 * it before sampling. Callers must also release in reverse order of acquisition (they nest),
 * which the render graph gets for free from the call stack.
 */

import type { Fbo, GLContext } from './glContext.js';
import { dlog } from '../debug.js';

export class FboPool {
  /** Free buffers keyed by `${width}x${height}`. */
  private free = new Map<string, Fbo[]>();
  private live = new Set<Fbo>();
  private allocated = 0;

  constructor(private gl: GLContext) {}

  /**
   * Borrow a target of exactly this size. Never returns a buffer that is already checked out.
   * Sizes are exact rather than "big enough": sampling a partially-written oversized target
   * would read stale pixels in the margin, and the UV maths would need a scale factor
   * threaded through every pass to compensate.
   */
  acquire(width: number, height: number): Fbo {
    const key = `${width}x${height}`;
    const bucket = this.free.get(key);
    const reused = bucket?.pop();
    if (reused) {
      this.live.add(reused);
      return reused;
    }
    const created = this.gl.createFbo(width, height);
    this.allocated++;
    dlog('gl', 'FboPool allocated a new target', { size: key, totalAllocated: this.allocated });
    this.live.add(created);
    return created;
  }

  /** Return a target to the pool. Releasing a buffer twice is a no-op, not a corruption. */
  release(target: Fbo): void {
    if (!this.live.delete(target)) return;
    const key = `${target.width}x${target.height}`;
    let bucket = this.free.get(key);
    if (!bucket) this.free.set(key, (bucket = []));
    bucket.push(target);
  }

  /**
   * Free every buffer of a size that is no longer in play — call after a canvas resize, or the
   * pool keeps the old resolution's targets alive forever. Buffers still checked out are left
   * alone; they return to a bucket on release and are collected by the next sweep.
   */
  evictOtherSizes(width: number, height: number): void {
    const keep = `${width}x${height}`;
    for (const [key, bucket] of this.free) {
      if (key === keep) continue;
      for (const target of bucket) {
        this.gl.deleteFbo(target);
        this.allocated--;
      }
      this.free.delete(key);
    }
  }

  /** True when every borrowed target has come back. The render graph asserts this per frame. */
  get balanced(): boolean {
    return this.live.size === 0;
  }

  /**
   * Force every checked-out buffer back into the pool.
   *
   * The recovery path, not a routine one. If a render throws part-way through, its buffers are
   * still checked out and nothing will ever release them — so the NEXT frame would fail the
   * balance check and report a leak, burying the actual error under a misleading one, forever.
   * Callers reclaim in a `finally` so one bad frame cannot poison every frame after it.
   */
  reclaimAll(): void {
    for (const target of [...this.live]) this.release(target);
  }

  dispose(): void {
    for (const bucket of this.free.values()) for (const t of bucket) this.gl.deleteFbo(t);
    for (const t of this.live) this.gl.deleteFbo(t);
    this.free.clear();
    this.live.clear();
    this.allocated = 0;
  }
}
