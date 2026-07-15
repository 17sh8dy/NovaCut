/**
 * Transition shader framework.
 *
 * A transition blends TWO clips — the outgoing `from` and the incoming `to` — across a
 * normalized progress. Unlike an effect (one input texture), a transition takes two, so it
 * can't ride the single-input `EFFECT_FRAGMENTS` path. It gets its own fragment family here,
 * keyed by the same `render` string a TransitionDefinition names in the core registry.
 *
 * The compositor consumes this via an ADDITIVE branch (see EFFECTS_FRAMEWORK.md): when the
 * playhead is inside a transition window it renders `from` and `to` to two textures, then
 * runs `TRANSITION_FRAGMENTS[render]` to blend them. When a transition names a `render` key
 * with no shader registered here, the compositor falls back to `cut` (a hard switch at the
 * midpoint) — identical to today's no-transition behavior, so nothing regresses.
 *
 * Contract — every transition fragment receives:
 *   sampler2D u_from      — outgoing clip, already composited to a texture
 *   sampler2D u_to        — incoming clip, already composited to a texture
 *   float     u_progress  — 0.0 (fully `from`) .. 1.0 (fully `to`)
 *   vec2      u_texel     — 1.0 / resolution (one texel step), for directional/blur transitions
 *   float     u_<paramKey> — one uniform per param in the TransitionDefinition
 *
 * v_uv (0..1) comes from the shared fullscreen-quad VERTEX_SHADER, reused so transitions live
 * in the exact same clip/UV space as effects — no new coordinate system, no flip risk.
 */

import { VERTEX_SHADER } from './shaders.js';

/** Wrap a fragment body with the shared transition header/uniforms. */
const transitionFrag = (body: string) => /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform vec2 u_texel;
${body}`;

/**
 * The transition fragment catalog, keyed by `render`. Batch 1 adds `dissolve` (crossfade) and
 * the roadmap fills in the rest (fade, slide, push, zoom, wipe, glitch, …). `cut` is the base
 * fallback: a hard switch, which is exactly what OpenCut does today with no transition.
 */
export const TRANSITION_FRAGMENTS: Record<string, string> = {
  cut: transitionFrag(/* glsl */ `
    void main() {
      vec4 a = texture(u_from, v_uv);
      vec4 b = texture(u_to, v_uv);
      fragColor = u_progress < 0.5 ? a : b;
    }`),
};

/** The shared vertex shader for transition programs (same quad as effects). */
export const TRANSITION_VERTEX_SHADER = VERTEX_SHADER;

/** Resolve a transition fragment by `render` key, falling back to a hard cut. */
export const getTransitionFragment = (render: string): string =>
  TRANSITION_FRAGMENTS[render] ?? TRANSITION_FRAGMENTS['cut']!;

/** True when a real (non-fallback) blend shader exists for this `render` key. */
export const hasTransitionFragment = (render: string): boolean =>
  render in TRANSITION_FRAGMENTS && render !== 'cut';
