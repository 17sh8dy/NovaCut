/**
 * Blend-mode GLSL — all 27 Photoshop modes.
 *
 * ## One program, not 27
 *
 * The mode arrives as a uniform int and the shader switches on it. That looks like the slow
 * choice and isn't: a uniform is coherent across every invocation in a draw call, so the
 * branch never diverges within a warp — the GPU takes one side, uniformly, every time. The
 * alternative (27 lazily-compiled specialisations) buys a few dead instructions back in
 * exchange for shader-cache pressure and a compile hitch the first time a user opens the
 * dropdown, which is precisely when they are least willing to wait.
 *
 * ## Mode IDs are derived, never written twice
 *
 * `BLEND_MODE_ID` and the `#define`s below are both generated from the photo model's
 * `BLEND_MODES` array, so a mode's integer is its index in that array by construction. Adding
 * a mode to the union and the menu automatically renumbers both sides together. Hand-written
 * constants on two sides of a language boundary are exactly the kind of thing that drifts once
 * and then silently renders Multiply as Color Burn.
 *
 * ## Alpha
 *
 * The maths is the W3C Compositing and Blending Level 1 general formula, which is what
 * Photoshop implements:
 *
 *     Cr = (1 - ab)·Cs + ab·B(Cb, Cs)     ← blend, weighted by how opaque the backdrop is
 *     ao = as + ab·(1 - as)
 *     co = as·Cr + ab·(1 - as)·Cb          ← premultiplied
 *     Co = co / ao                         ← back to unpremultiplied
 *
 * The `(1 - ab)` term is the part hand-rolled blend shaders usually drop, and dropping it is
 * why they blend correctly against an opaque photo and produce dark fringes against anything
 * with soft alpha — the blend function is only meaningful where there IS a backdrop to blend
 * with. This context is created with `premultipliedAlpha: false`, so every texture in and out
 * of here is unpremultiplied; the premultiplied form exists only inside the formula.
 */

import { BLEND_MODES, type BlendMode } from '@opencut/photo';

/** A mode's integer, derived from its position in the model's canonical listing. */
export const BLEND_MODE_ID: Record<BlendMode, number> = Object.fromEntries(
  BLEND_MODES.map((m, i) => [m, i]),
) as Record<BlendMode, number>;

/** `colorBurn` → `M_COLOR_BURN`. The GLSL side of the same derivation. */
const glslName = (mode: BlendMode) => `M_${mode.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

const DEFINES = BLEND_MODES.map((m, i) => `#define ${glslName(m)} ${i}`).join('\n');

/**
 * Vertex shader for the blend pass. Always fullscreen, always identity.
 *
 * The layer's transform is deliberately NOT here. It is applied earlier, by the graph's
 * "place" pass, which rasterises the layer into a canvas-sized buffer. By the time we blend,
 * source and backdrop are the same size in the same space, so one UV serves both.
 *
 * That ordering is forced, not stylistic. Blending has to write EVERY texel of its output —
 * it renders into a recycled pool buffer whose contents are undefined, so any texel the quad
 * misses would keep another layer's stale pixels. A transformed (rotated, scaled, offset) quad
 * covers only part of the target by definition. Fullscreen is the only shape that can't leak.
 */
export const BLEND_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // -1..1 clip space
layout(location = 1) in vec2 a_uv;    // 0..1
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Fragment shader for the place pass: draw a layer's source through its model matrix into a
 * canvas-sized, transparent-cleared buffer. Pairs with the effect chain's VERTEX_SHADER, which
 * already applies `u_model`.
 */
export const PLACE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_texture;
void main() { fragColor = texture(u_texture, v_uv); }`;

export const BLEND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

${DEFINES}

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_src;        // the layer: placed, then through its effect chain
uniform sampler2D u_backdrop;   // everything composited beneath it
uniform sampler2D u_clipMask;   // alpha of the clipping base; unread when u_useClipMask is 0
uniform int   u_mode;
uniform float u_opacity;        // 0..1
uniform int   u_useClipMask;    // 0/1 — a bool uniform would still cost a branch, so be explicit
uniform int   u_preserveAlpha;  // 0/1 — see the adjustment branch in main()
uniform float u_seed;           // decorrelates dissolve between layers

// ── helpers ─────────────────────────────────────────────────────────────────

float hash12(vec2 p) {
  // Cheap, stable per-pixel noise. Must depend only on position (+ seed) so dissolve does not
  // shimmer between redraws of an unchanged document — a time-based hash would make a static
  // canvas crawl.
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

// ── separable modes, one channel at a time ──────────────────────────────────

float blendChannel(int mode, float cb, float cs) {
  if (mode == M_MULTIPLY)     return cb * cs;
  if (mode == M_SCREEN)       return cb + cs - cb * cs;
  if (mode == M_DARKEN)       return min(cb, cs);
  if (mode == M_LIGHTEN)      return max(cb, cs);
  if (mode == M_LINEAR_BURN)  return cb + cs - 1.0;
  if (mode == M_LINEAR_DODGE) return cb + cs;
  if (mode == M_DIFFERENCE)   return abs(cb - cs);
  if (mode == M_EXCLUSION)    return cb + cs - 2.0 * cb * cs;
  if (mode == M_SUBTRACT)     return cb - cs;
  if (mode == M_DIVIDE)       return cs <= 0.0 ? 1.0 : min(1.0, cb / cs);

  if (mode == M_COLOR_BURN) {
    if (cb >= 1.0) return 1.0;
    if (cs <= 0.0) return 0.0;
    return 1.0 - min(1.0, (1.0 - cb) / cs);
  }
  if (mode == M_COLOR_DODGE) {
    if (cb <= 0.0) return 0.0;
    if (cs >= 1.0) return 1.0;
    return min(1.0, cb / (1.0 - cs));
  }
  if (mode == M_HARD_LIGHT) {
    return cs <= 0.5 ? cb * (2.0 * cs)
                     : cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0);
  }
  if (mode == M_OVERLAY) {
    // Hard Light with the operands swapped — that identity is the definition, not a shortcut.
    return cb <= 0.5 ? cs * (2.0 * cb)
                     : cs + (2.0 * cb - 1.0) - cs * (2.0 * cb - 1.0);
  }
  if (mode == M_SOFT_LIGHT) {
    if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (mode == M_VIVID_LIGHT) {
    if (cs <= 0.5) {
      float d = 2.0 * cs;
      if (cb >= 1.0) return 1.0;
      if (d <= 0.0) return 0.0;
      return 1.0 - min(1.0, (1.0 - cb) / d);
    }
    float d = 2.0 * (cs - 0.5);
    if (cb <= 0.0) return 0.0;
    if (d >= 1.0) return 1.0;
    return min(1.0, cb / (1.0 - d));
  }
  if (mode == M_LINEAR_LIGHT) return cb + 2.0 * cs - 1.0;
  if (mode == M_PIN_LIGHT) {
    return cs <= 0.5 ? min(cb, 2.0 * cs) : max(cb, 2.0 * cs - 1.0);
  }
  // Hard Mix: Photoshop adds the two channels and thresholds at 100%.
  if (mode == M_HARD_MIX) return step(1.0, cb + cs);

  return cs; // M_NORMAL, M_DISSOLVE
}

// ── the blend function B(Cb, Cs) ────────────────────────────────────────────

vec3 blendRgb(int mode, vec3 cb, vec3 cs) {
  // Non-separable modes need the whole colour at once; they cannot be done channelwise.
  if (mode == M_HUE)         return setLum(setSat(cs, sat(cb)), lum(cb));
  if (mode == M_SATURATION)  return setLum(setSat(cb, sat(cs)), lum(cb));
  if (mode == M_COLOR)       return setLum(cs, lum(cb));
  if (mode == M_LUMINOSITY)  return setLum(cb, lum(cs));
  if (mode == M_DARKER_COLOR)  return lum(cs) < lum(cb) ? cs : cb;
  if (mode == M_LIGHTER_COLOR) return lum(cs) > lum(cb) ? cs : cb;
  return vec3(
    blendChannel(mode, cb.r, cs.r),
    blendChannel(mode, cb.g, cs.g),
    blendChannel(mode, cb.b, cs.b)
  );
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec4 bd  = texture(u_backdrop, v_uv);

  vec3 cs = src.rgb;
  vec3 cb = bd.rgb;
  float ab = bd.a;

  // ── Adjustment layers: recolour in place, add no coverage ──────────────────
  //
  // An adjustment layer has no pixels of its own — u_src here IS the backdrop, run through
  // the adjustment's effect. Compositing that source-OVER the backdrop double-counts coverage:
  // as == ab, so ao = ab + ab(1-ab) = 2ab - ab², and a half-covered edge would come out 75%
  // opaque with the adjustment only ⅔ applied. Both wrong, and both invisible on an opaque
  // backdrop (ab == 1), which is why this needs saying rather than testing by eye.
  //
  // The correct model is a lerp, not a composite: keep the backdrop's alpha exactly, and mix
  // toward the blended-adjusted colour by opacity. At opacity 1 / Normal that IS the adjusted
  // copy — the claim source-over only satisfies when ab happens to be 1.
  if (u_preserveAlpha == 1) {
    float f = u_opacity;
    if (u_useClipMask == 1) f *= texture(u_clipMask, v_uv).a;
    vec3 cr = clamp(blendRgb(u_mode, cb, cs), 0.0, 1.0);
    fragColor = vec4(mix(cb, cr, f), ab);
    return;
  }

  float as = src.a * u_opacity;
  // Clipping is coverage, not colour: multiplying the source's alpha by the base layer's is
  // the whole of it, which is why a clipping mask costs one texture read and no extra pass.
  if (u_useClipMask == 1) as *= texture(u_clipMask, v_uv).a;

  // Dissolve is not a colour operation — it makes coverage stochastic, then blends Normal.
  if (u_mode == M_DISSOLVE) as = step(hash12(gl_FragCoord.xy + u_seed), as);

  // B(Cb,Cs) must be clamped to [0,1] BEFORE compositing, not after. Linear Burn, Linear
  // Dodge, Linear Light and Subtract all range outside it by design, and the spec defines the
  // blend result as a colour. Clamping only at the end is invisible at opacity 1 (where co is
  // just B, and saturates identically) but wrong the moment the layer is partly transparent:
  // co = as·B + ab·(1-as)·Cb mixes the out-of-range B into the backdrop's share, so a
  // half-opacity Linear Burn comes out roughly twice as dark as it should.
  vec3 blended = clamp(blendRgb(u_mode, cb, cs), 0.0, 1.0);

  // Cr = (1-ab)·Cs + ab·B(Cb,Cs). Weighting by ab is what keeps soft-alpha backdrops clean.
  vec3 cr = mix(cs, blended, ab);

  float ao = as + ab * (1.0 - as);
  vec3 co  = as * cr + ab * (1.0 - as) * cb;   // premultiplied

  // Unpremultiply. Guard the divide: ao == 0 means fully transparent, where colour is
  // meaningless — returning NaN here would poison every later pass that samples this texel.
  fragColor = ao > 0.0 ? vec4(clamp(co / ao, 0.0, 1.0), ao) : vec4(0.0);
}`;

/**
 * Multiply a layer's alpha by a coverage mask.
 *
 * One line of arithmetic and its own pass, rather than folding `u_mask` into the place shader.
 * The mask has to land AFTER the effect chain — masking a blurred layer must hide the blurred
 * result, not the sharp source — and `place` runs before the chain. Two passes is the honest
 * cost of getting that order right.
 *
 * Colour is passed through untouched. These textures are unpremultiplied (see GLContext), so
 * scaling alpha alone is the whole operation; premultiplied colour would have to be scaled too.
 */
export const MASK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform sampler2D u_mask;
void main() {
  vec4 c = texture(u_texture, v_uv);
  fragColor = vec4(c.rgb, c.a * texture(u_mask, v_uv).a);
}`;
