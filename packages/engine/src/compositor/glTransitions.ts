/**
 * The GL Transitions adapter: turns any shader from the generated catalog into something the
 * compositor can draw, without a hand-written implementation per transition.
 *
 * A GL Transition (see https://github.com/gl-transitions/gl-transitions) is a GLSL function
 * `vec4 transition(vec2 uv)` that reads two images through `getFromColor` / `getToColor` and a
 * `progress` from 0 to 1. The package's `glsl3/` sources are already GLSL ES 3.00, so nothing is
 * rewritten: `glTransitionFragment` wraps one in the host header below, and `GlTransitions.draw`
 * binds the textures, `progress`, `ratio` and the shader's own parameters.
 *
 * ── Three guarantees ────────────────────────────────────────────────────────────────
 *
 * 1. EXACT ENDPOINTS. At progress 0 the result is the outgoing frame and at 1 the incoming frame,
 *    pixel for pixel, whatever the shader does there. Many library shaders are a few pixels off at
 *    the extremes, and the extremes are exactly where a transition meets the plain clip it
 *    borders. They are forced through the same hard-cut program the compositor already uses
 *    rather than trusted, so no shader is excluded for being imperfect there (the regression
 *    harness measures how far each one drifts just inside the window, to keep that honest).
 *
 * 2. A BROKEN SHADER NEVER REACHES THE RENDER LOOP AS AN ERROR. A compile or link failure is caught,
 *    the shader is disabled for the rest of the session, it is reported ONCE (a log line and the
 *    `onBroken` hook), and `draw` returns false so the compositor falls back to a cross dissolve.
 *    `GLContext.getProgram` does not cache a failure, so without this a bad shader would recompile
 *    and re-log on every frame of every playback.
 *
 * 3. SAME PIXELS IN PREVIEW AND EXPORT. There is no time uniform and no per-session state: the
 *    output depends only on the two textures, the progress, the aspect ratio and the parameters,
 *    and both the preview and the exporter reach this code through Compositor.renderTransition.
 */

import { type GlParamBinding, type TransitionDefinition } from '@opencut/core';
import { IDENTITY3, type GLContext, type Program } from '../gl/glContext.js';
import { dlog } from '../debug.js';
import { VERTEX_SHADER } from './shaders.js';
import { getTransitionFragment } from './transitions.js';
import { GL_TRANSITION_SOURCES } from './glTransitions.generated.js';
import { paintMap } from './glMaps.js';

/** The host header every library shader expects around it (the package README's contract). */
export function glTransitionFragment(source: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 _fragColor;
uniform sampler2D from, to;
uniform float progress, ratio;
vec4 getFromColor(vec2 uv) { return texture(from, uv); }
vec4 getToColor(vec2 uv) { return texture(to, uv); }
${source}
void main() { _fragColor = transition(v_uv); }`;
}

export interface GlDrawArgs {
  from: WebGLTexture;
  to: WebGLTexture;
  progress: number;
  /** Width / height of the render target. Shaders use it to keep circles round. */
  ratio: number;
  /** The transition instance's flat numeric params; anything missing falls back to the shader default. */
  values: Record<string, number>;
  /** Skip the endpoint forcing. For the regression harness only. */
  rawEndpoints?: boolean;
}

export class GlTransitions {
  private programs = new Map<string, Program>();
  private broken = new Map<string, string>();
  /** The greyscale map textures texture shaders read, made on first use, one per map index. */
  private maps = new Map<number, WebGLTexture>();
  /** How many times a compile was actually attempted. The harness asserts a failure is not retried. */
  compileAttempts = 0;
  /** Called once per shader that fails, with the first line of the compiler's message. */
  onBroken?: (name: string, reason: string) => void;

  constructor(private ctx: GLContext) {}

  /** Why a shader is disabled, or undefined if it is fine (or not tried yet). */
  brokenReason(name: string): string | undefined {
    return this.broken.get(name);
  }

  /**
   * Compile a shader (once). Returns null on success, or the reason it cannot be used.
   * Never throws.
   */
  compile(name: string, sourceOverride?: string): string | null {
    const known = this.broken.get(name);
    if (known) return known;
    if (this.programs.has(name)) return null;
    const source = sourceOverride ?? GL_TRANSITION_SOURCES[name];
    if (!source) return this.disable(name, 'no shader source for this transition');
    this.compileAttempts++;
    try {
      const prog = this.ctx.getProgram(`__gl:${name}`, VERTEX_SHADER, glTransitionFragment(source));
      this.programs.set(name, prog);
      return null;
    } catch (err) {
      const first =
        String(err instanceof Error ? err.message : err)
          .split('\n')
          .find((l) => l.trim()) ?? 'compile error';
      return this.disable(name, first.trim());
    }
  }

  private disable(name: string, reason: string): string {
    this.broken.set(name, reason);
    dlog('render', 'GL transition disabled for this session', { name, reason });
    try {
      this.onBroken?.(name, reason);
    } catch {
      /* a listener must never break rendering */
    }
    return reason;
  }

  /**
   * Draw `def` over the bound target. Returns false (having drawn nothing) if the shader is
   * unusable, so the caller can fall back; true once something has been drawn.
   */
  draw(def: TransitionDefinition, a: GlDrawArgs, sourceOverride?: string): boolean {
    const gl = def.gl;
    if (!gl) return false;

    if (!a.rawEndpoints && (a.progress <= 0 || a.progress >= 1)) {
      this.drawHardCut(a.progress <= 0 ? 0 : 1, a.from, a.to);
      return true;
    }
    if (this.compile(gl.name, sourceOverride)) return false;

    const prog = this.programs.get(gl.name)!;
    const ctx = this.ctx;
    // Map textures are made BEFORE anything is bound. Uploading one binds it to whichever texture unit
    // is active, which would silently replace the clip bound there; created first, the upload happens
    // while nothing of this draw is bound yet (the first use of a map drew the wrong picture before).
    const maps = gl.bindings
      .filter((b) => b.type === 'sampler2D')
      .map((b) => ({ uniform: b.uniform, tex: this.mapTexture(Math.round(a.values[b.keys[0]!] ?? b.defaults[0] ?? 0)) }));
    ctx.useProgram(prog);
    ctx.setUniformMat3(prog, 'u_model', IDENTITY3);
    ctx.setUniform1f(prog, 'progress', Math.min(1, Math.max(0, a.progress)));
    ctx.setUniform1f(prog, 'ratio', a.ratio);
    for (const b of gl.bindings) this.bind(prog, b, a.values);
    ctx.bindTexture(prog, 'from', a.from, 0);
    ctx.bindTexture(prog, 'to', a.to, 1);
    // Extra texture inputs (units 0 and 1 are the two clips), each fed the map its parameter names.
    let unit = 2;
    for (const m of maps) ctx.bindTexture(prog, m.uniform, m.tex, unit++);
    ctx.drawQuad();
    return true;
  }

  /** The texture for map `index`, painted and uploaded the first time it is asked for. */
  private mapTexture(index: number): WebGLTexture {
    let tex = this.maps.get(index);
    if (!tex) {
      tex = this.ctx.createTexture();
      this.ctx.uploadFrame(tex, paintMap(index));
      this.maps.set(index, tex);
    }
    return tex;
  }

  /** `progress` 0 draws `from`, 1 draws `to`, through the compositor's own hard-cut program. */
  private drawHardCut(progress: 0 | 1, from: WebGLTexture, to: WebGLTexture): void {
    const ctx = this.ctx;
    const prog = ctx.getProgram('__transition:cut', VERTEX_SHADER, getTransitionFragment('cut'));
    ctx.useProgram(prog);
    ctx.setUniformMat3(prog, 'u_model', IDENTITY3);
    ctx.setUniform1f(prog, 'u_progress', progress);
    ctx.bindTexture(prog, 'u_from', from, 0);
    ctx.bindTexture(prog, 'u_to', to, 1);
    ctx.drawQuad();
  }

  private bind(prog: Program, b: GlParamBinding, values: Record<string, number>): void {
    const v = b.keys.map((k, i) => {
      const x = values[k];
      return typeof x === 'number' && Number.isFinite(x) ? x : (b.defaults[i] ?? 0);
    });
    const c = this.ctx;
    switch (b.type) {
      case 'float':
        return c.setUniform1f(prog, b.uniform, v[0]!);
      case 'int':
      case 'bool':
        return c.setUniform1i(prog, b.uniform, Math.round(v[0]!));
      case 'vec2':
        return c.setUniform2f(prog, b.uniform, v[0]!, v[1]!);
      case 'vec3':
        return c.setUniform3f(prog, b.uniform, v[0]!, v[1]!, v[2]!);
      case 'vec4':
        return c.setUniform4f(prog, b.uniform, v[0]!, v[1]!, v[2]!, v[3]!);
      case 'ivec2':
        return c.setUniform2i(prog, b.uniform, Math.round(v[0]!), Math.round(v[1]!));
      case 'ivec3':
        return c.setUniform3i(prog, b.uniform, Math.round(v[0]!), Math.round(v[1]!), Math.round(v[2]!));
      case 'sampler2D':
        return; // bound as a texture in draw(), not as a value
      case 'ivec4':
        return c.setUniform4i(prog, b.uniform, Math.round(v[0]!), Math.round(v[1]!), Math.round(v[2]!), Math.round(v[3]!));
    }
  }
}
