/**
 * The shared effect chain.
 *
 * One function, used by both renderers: the video compositor runs a clip's effects through it,
 * the photo render graph runs a layer's. That sharing is not tidiness — it is the reason a
 * filter written for the video editor shows up in the photo editor with zero work. Both
 * products consume core's EffectInstance and core's registry, so the chain has nothing
 * product-specific left in it.
 *
 * Reads from a texture and writes to an FBO, never both ends of the same FBO. The input is
 * always a plain texture (never an FBO attachment being written this pass), which is what
 * keeps the ping-pong honest.
 */

import { getEffectDef, sample, type EffectDefinition, type EffectInstance, type Ticks } from '@opencut/core';
import { EFFECT_FRAGMENTS, COLOR_ADJUST_KEYS, VERTEX_SHADER } from '../compositor/shaders.js';
import type { Fbo, GLContext } from './glContext.js';
import { IDENTITY3 } from './glContext.js';
import type { FboPool } from './fboPool.js';

/**
 * The chain's result.
 *
 * `owned` is the buffer holding the output, or null when the chain was a pass-through and
 * `tex` is the caller's own input. Callers MUST release `owned` when done and MUST NOT release
 * anything when it is null — returning the input texture untouched is the no-effects fast path,
 * and freeing it would hand a live source texture back to the pool.
 */
export interface ChainResult {
  tex: WebGLTexture;
  owned: Fbo | null;
}

/** True when this chain would do any work — lets callers skip acquiring buffers entirely. */
export const hasEnabledEffects = (effects: readonly EffectInstance[]): boolean =>
  effects.some((fx) => fx.enabled && getEffectDef(fx.type));

/**
 * Run `effects` over `input`, bottom-up, returning the texture holding the result.
 *
 * Effects are sampled at `localTicks`; for a still that is always 0, where AnimatedValue params
 * with no keyframes read straight through to their static value — which is why the photo
 * editor can reuse a type built for keyframed video without ever writing a keyframe.
 */
export function runEffectChain(
  gl: GLContext,
  pool: FboPool,
  input: WebGLTexture,
  effects: readonly EffectInstance[],
  width: number,
  height: number,
  timeSeconds: number,
  localTicks: Ticks,
): ChainResult {
  const active = effects.filter((fx) => fx.enabled && getEffectDef(fx.type));
  if (active.length === 0) return { tex: input, owned: null };

  // A single effect never needs a second buffer: it reads the caller's texture and writes ours.
  let front = pool.acquire(width, height);
  let back = active.length > 1 ? pool.acquire(width, height) : null;

  let current = input;
  let owned = front; // the buffer holding the latest result, tracked rather than re-derived

  for (const fx of active) {
    const def = getEffectDef(fx.type)!;
    applyEffect(gl, def, fx, current, front, width, height, timeSeconds, localTicks);
    current = front.tex;
    owned = front;
    if (back) {
      const next = back;
      back = front;
      front = next;
    }
  }

  // After the last swap `front` is the buffer we WOULD have written next — nobody's output.
  if (back && front !== owned) pool.release(front);
  return { tex: owned.tex, owned };
}

/** One effect pass: bind constants and params as `u_<key>`, draw a full-target quad. */
function applyEffect(
  gl: GLContext,
  def: EffectDefinition,
  fx: EffectInstance,
  inputTex: WebGLTexture,
  output: Fbo,
  width: number,
  height: number,
  timeSeconds: number,
  localTicks: Ticks,
): void {
  const renderKey = def.render;
  const source = EFFECT_FRAGMENTS[renderKey] ?? EFFECT_FRAGMENTS['passthrough']!;
  const prog = gl.getProgram(renderKey, VERTEX_SHADER, source);

  gl.bindTarget(output, width, height);
  gl.disableBlend();
  gl.useProgram(prog);

  gl.setUniform2f(prog, 'u_texel', 1 / width, 1 / height);
  gl.setUniform1f(prog, 'u_time', timeSeconds);
  gl.setUniform1f(prog, 'u_opacity', 1);
  gl.setUniformMat3(prog, 'u_model', IDENTITY3);

  /*
   * Definition constants first, instance params second.
   *
   * The order is the contract: a param with the same key as a constant OVERRIDES it. That is
   * what lets the thirty filters share one shader — each binds its whole grade from the
   * definition and exposes only `intensity` as a param — while leaving the door open for a
   * definition to publish one of its constants as an editable dial later without the shader or
   * this binder changing at all.
   *
   * Constants are also why the program cache is safe here. Programs are keyed by render key and
   * shared across every effect that uses them, so a uniform that one effect writes and the next
   * leaves alone keeps the PREVIOUS effect's value. Because each filter writes the complete set
   * every pass, there is nothing for a sibling to leak into it.
   */
  for (const [key, val] of Object.entries(def.constants ?? {})) {
    gl.setUniform1f(prog, `u_${key}`, val);
  }

  // Bind every param as u_<key>. Zero-fill the color-adjust family so its shared shader
  // ignores channels this particular effect doesn't expose.
  const seen = new Set<string>();
  for (const [key, val] of Object.entries(fx.params)) {
    gl.setUniform1f(prog, `u_${key}`, sample(val, localTicks));
    seen.add(key);
  }
  if (renderKey === 'colorAdjust') {
    for (const key of COLOR_ADJUST_KEYS) {
      if (!seen.has(key)) gl.setUniform1f(prog, `u_${key}`, 0);
    }
  }

  gl.bindTexture(prog, 'u_texture', inputTex, 0);
  gl.drawQuad();
}
