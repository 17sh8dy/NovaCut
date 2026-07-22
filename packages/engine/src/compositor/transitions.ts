/**
 * Transition shader framework.
 *
 * A transition blends TWO clips — the outgoing `from` and the incoming `to` — across a
 * normalized progress. Unlike an effect (one input texture) a transition takes two, so it
 * cannot ride the single-input `EFFECT_FRAGMENTS` path. It gets its own fragment family here,
 * keyed by the same `render` string a TransitionDefinition names in the core registry.
 *
 * Contract — every transition fragment receives:
 *   sampler2D u_from      — outgoing clip, already composited to a texture
 *   sampler2D u_to        — incoming clip, already composited to a texture
 *   float     u_progress  — 0.0 (fully `from`) .. 1.0 (fully `to`)
 *   vec2      u_texel     — 1.0 / resolution, for directional and blur transitions
 *   float     u_<paramKey> — one uniform per param in the TransitionDefinition
 *
 * `v_uv` (0..1) comes from the shared fullscreen-quad VERTEX_SHADER, reused so transitions live
 * in exactly the same clip/UV space as effects — no new coordinate system, no flip risk.
 *
 * ## Two rules every fragment here follows
 *
 * **Ease, do not lerp.** A transition driven by raw linear progress reads as mechanical, and it
 * is the biggest single difference between one that looks designed and one that looks like a
 * slider. Everything below runs progress through `ease()` unless the effect specifically wants
 * linear time — a wipe's edge position, a flash's decay.
 *
 * **Sample outside the frame as transparent, not clamped.** `CLAMP_TO_EDGE` on the source
 * textures means a UV of 1.2 returns the last column of pixels, so a slide would smear its
 * right edge across the screen. `outside()` returns transparent for out-of-range UVs, which is
 * what "the clip is no longer there" actually looks like.
 */

import { VERTEX_SHADER } from './shaders.js';

/**
 * Shared helpers injected into every transition fragment.
 *
 * Duplicating these into each shader is how they drift; a slide that eases differently from a
 * push is a bug nobody files and everybody feels.
 */
const TRANSITION_PRELUDE = /* glsl */ `
// Smootherstep: zero first AND second derivative at both ends, so a transition starts and
// stops without a visible velocity step. Plain smoothstep still lands with a slight jerk.
float ease(float t) {
  t = clamp(t, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Sample with out-of-range UVs treated as empty. See this file's header.
vec4 outside(sampler2D tex, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(tex, uv);
}

// Source-over of a on top of b. Used wherever one clip must sit ON TOP of the other rather
// than mix with it — a slide, a page turn — where mix() would ghost the two together.
vec4 over(vec4 a, vec4 b) {
  float ao = a.a + b.a * (1.0 - a.a);
  if (ao <= 0.0) return vec4(0.0);
  return vec4((a.rgb * a.a + b.rgb * b.a * (1.0 - a.a)) / ao, ao);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 rotate2(vec2 uv, float angle) {
  float c = cos(angle), s = sin(angle);
  uv -= 0.5;
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  return uv + 0.5;
}

// A directional unit vector from an angle in degrees. 0 = right, 90 = down.
vec2 dirFrom(float degrees) {
  float a = radians(degrees);
  return vec2(cos(a), sin(a));
}

// Box blur along one axis, used by the blur and whip transitions.
vec4 blurDir(sampler2D tex, vec2 uv, vec2 dir, float amount, vec2 texel) {
  if (amount < 0.01) return texture(tex, uv);
  vec4 sum = vec4(0.0);
  for (int i = -6; i <= 6; i++) {
    sum += texture(tex, uv + dir * texel * amount * float(i));
  }
  return sum / 13.0;
}
`;

/** Wrap a fragment body with the shared transition header, uniforms and helpers. */
const transitionFrag = (body: string) => /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform vec2 u_texel;
${TRANSITION_PRELUDE}
${body}`;

/**
 * The transition catalog, keyed by `render`.
 *
 * `cut` stays as the fallback for any registry entry with no shader: a hard switch at the
 * midpoint, which is exactly what the timeline does with no transition at all — so an unknown
 * key degrades to "no transition" rather than to a black frame.
 */
export const TRANSITION_FRAGMENTS: Record<string, string> = {
  cut: transitionFrag(/* glsl */ `
    void main() {
      fragColor = u_progress < 0.5 ? texture(u_from, v_uv) : texture(u_to, v_uv);
    }`),

  /** Crossfade. The one every editor needs, and the baseline everything else is judged against. */
  dissolve: transitionFrag(/* glsl */ `
    void main() {
      fragColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), ease(u_progress));
    }`),

  /**
   * Fade through a colour (black by default).
   *
   * Two half-length ramps rather than one crossfade: out to the colour, then in from it. That
   * dip to solid is the whole point — it reads as a beat of silence, which a crossfade does not.
   */
  fade: transitionFrag(/* glsl */ `
    uniform float u_color;
    void main() {
      vec3 mid = vec3(clamp(u_color, 0.0, 1.0));
      float t = ease(u_progress);
      vec4 a = texture(u_from, v_uv);
      vec4 b = texture(u_to, v_uv);
      if (t < 0.5) {
        fragColor = vec4(mix(a.rgb, mid, t * 2.0), a.a);
      } else {
        fragColor = vec4(mix(mid, b.rgb, (t - 0.5) * 2.0), b.a);
      }
    }`),

  /** The incoming clip slides in over the outgoing one, which stays put. */
  slide: transitionFrag(/* glsl */ `
    uniform float u_angle;
    void main() {
      float t = ease(u_progress);
      vec2 dir = dirFrom(u_angle);
      vec4 a = texture(u_from, v_uv);
      vec4 b = outside(u_to, v_uv + dir * (1.0 - t));
      fragColor = over(b, a);
    }`),

  /** Both clips move together, as if on one strip of film. */
  push: transitionFrag(/* glsl */ `
    uniform float u_angle;
    void main() {
      float t = ease(u_progress);
      vec2 dir = dirFrom(u_angle);
      vec4 a = outside(u_from, v_uv - dir * t);
      vec4 b = outside(u_to, v_uv + dir * (1.0 - t));
      fragColor = a.a > b.a ? a : b;
    }`),

  /**
   * A hard edge sweeps across, revealing the incoming clip.
   *
   * Linear progress on purpose: a wipe's edge is a physical object moving at a speed, and
   * easing makes it appear to hesitate in the middle of the screen.
   */
  wipe: transitionFrag(/* glsl */ `
    uniform float u_angle;
    uniform float u_softness;
    void main() {
      vec2 dir = dirFrom(u_angle);
      // Project onto the sweep axis and renormalise, so the edge crosses the whole frame at
      // any angle instead of clipping early on the diagonals.
      float span = abs(dir.x) + abs(dir.y);
      float pos = dot(v_uv - 0.5, dir) / span + 0.5;
      float soft = max(0.001, u_softness);
      float k = smoothstep(u_progress - soft, u_progress + soft, pos);
      fragColor = mix(texture(u_to, v_uv), texture(u_from, v_uv), k);
    }`),

  /** An iris opening from the centre. The classic circle reveal. */
  circle: transitionFrag(/* glsl */ `
    uniform float u_softness;
    void main() {
      // Aspect-correct the distance or the "circle" is an ellipse on any non-square frame.
      vec2 d = (v_uv - 0.5) * vec2(u_texel.y / u_texel.x, 1.0);
      float dist = length(d) * 1.20;
      float r = ease(u_progress) * 1.05;
      float soft = max(0.001, u_softness);
      float k = smoothstep(r - soft, r + soft, dist);
      fragColor = mix(texture(u_to, v_uv), texture(u_from, v_uv), k);
    }`),

  /**
   * Punch zoom — the outgoing clip rushes at the camera while the incoming one falls back.
   *
   * A CapCut staple. What sells it is that BOTH clips move: zooming only one reads as a scale
   * animation, while opposing motion reads as a camera cut.
   */
  zoom: transitionFrag(/* glsl */ `
    uniform float u_scale;
    void main() {
      float t = ease(u_progress);
      float k = max(1.0, u_scale);
      vec2 fromUv = (v_uv - 0.5) / mix(1.0, k, t) + 0.5;      // 1 → k, rushes past
      vec2 toUv = (v_uv - 0.5) / mix(1.0 / k, 1.0, t) + 0.5;  // k → 1, settles in
      fragColor = mix(outside(u_from, fromUv), outside(u_to, toUv), t);
    }`),

  /** Spin + zoom. Reads as a whip-around rather than a rotation because the scale dips. */
  spin: transitionFrag(/* glsl */ `
    uniform float u_turns;
    void main() {
      float t = ease(u_progress);
      float angle = u_turns * 6.2831853;
      // Push the frame outward at the midpoint so the corners never expose empty frame while
      // the picture is at 45 degrees.
      float dip = 1.0 + 0.9 * sin(t * 3.14159265);
      vec2 fromUv = rotate2((v_uv - 0.5) * dip + 0.5, angle * t);
      vec2 toUv = rotate2((v_uv - 0.5) * dip + 0.5, -angle * (1.0 - t));
      fragColor = mix(outside(u_from, fromUv), outside(u_to, toUv), t);
    }`),

  /**
   * Defocus through the cut.
   *
   * Blur ramps up to the midpoint and back down, so the clips exchange while BOTH are soft —
   * which is what hides the join. Blurring only on the way out shows the swap.
   */
  blurTransition: transitionFrag(/* glsl */ `
    uniform float u_amount;
    void main() {
      float t = ease(u_progress);
      float amount = u_amount * sin(t * 3.14159265); // 0 → peak → 0
      vec4 a = mix(
        blurDir(u_from, v_uv, vec2(1.0, 0.0), amount, u_texel),
        blurDir(u_from, v_uv, vec2(0.0, 1.0), amount, u_texel), 0.5);
      vec4 b = mix(
        blurDir(u_to, v_uv, vec2(1.0, 0.0), amount, u_texel),
        blurDir(u_to, v_uv, vec2(0.0, 1.0), amount, u_texel), 0.5);
      fragColor = mix(a, b, t);
    }`),

  /**
   * A blown-out flash at the cut.
   *
   * `pow(sin, 3)` rather than a plain sine: a symmetric bump reads as a slow pulse, and a
   * camera flash is an impact.
   */
  flash: transitionFrag(/* glsl */ `
    uniform float u_color;
    void main() {
      float t = clamp(u_progress, 0.0, 1.0);
      float peak = pow(sin(t * 3.14159265), 3.0);
      vec4 base = mix(texture(u_from, v_uv), texture(u_to, v_uv), step(0.5, t));
      fragColor = vec4(mix(base.rgb, vec3(clamp(u_color, 0.0, 1.0)), peak), base.a);
    }`),

  /** Whip pan: a hard directional smear that swaps clips at the blur's peak. */
  whip: transitionFrag(/* glsl */ `
    uniform float u_angle;
    void main() {
      float t = clamp(u_progress, 0.0, 1.0);
      vec2 dir = dirFrom(u_angle);
      float peak = sin(t * 3.14159265);
      // Offset as well as smear — a whip pan travels, it does not just blur in place.
      vec2 shift = dir * peak * 0.35;
      vec4 a = blurDir(u_from, v_uv + shift, dir, peak * 120.0, u_texel);
      vec4 b = blurDir(u_to, v_uv - shift, dir, peak * 120.0, u_texel);
      fragColor = mix(a, b, smoothstep(0.35, 0.65, t));
    }`),

  /**
   * Digital glitch: RGB split, torn horizontal bands, and a hard swap inside the noise.
   *
   * The tearing is quantised into bands rather than applied per pixel, which is what makes it
   * read as a signal fault instead of as sandpaper.
   */
  glitchTransition: transitionFrag(/* glsl */ `
    uniform float u_intensity;
    void main() {
      float t = clamp(u_progress, 0.0, 1.0);
      float peak = sin(t * 3.14159265) * clamp(u_intensity, 0.0, 1.0);
      float band = floor(v_uv.y * 24.0);
      float jitter = (hash12(vec2(band, floor(t * 30.0))) - 0.5) * peak * 0.35;
      vec2 uv = v_uv + vec2(jitter, 0.0);
      float split = peak * 0.02;
      vec4 a = vec4(outside(u_from, uv + vec2(split, 0.0)).r, outside(u_from, uv).g,
                    outside(u_from, uv - vec2(split, 0.0)).b, outside(u_from, uv).a);
      vec4 b = vec4(outside(u_to, uv + vec2(split, 0.0)).r, outside(u_to, uv).g,
                    outside(u_to, uv - vec2(split, 0.0)).b, outside(u_to, uv).a);
      vec4 c = mix(a, b, step(0.5 + jitter * 0.6, t));
      // A bright scan bar riding the peak sells the "signal" reading.
      float bar = smoothstep(0.98, 1.0, hash12(vec2(band, 7.0))) * peak;
      fragColor = vec4(c.rgb + bar * 0.6, c.a);
    }`),

  /**
   * A card flip. `u_axis` picks horizontal (0) or vertical (1).
   *
   * Perspective is FAKED, and that is worth stating: a real 3D flip needs a projection matrix
   * and a second geometry pass. This squeezes the face toward its axis and darkens it as it
   * turns away, which is the part of a flip the eye actually reads. At transition speed the
   * difference is invisible; on a very slow flip it is not.
   */
  flip3d: transitionFrag(/* glsl */ `
    uniform float u_axis;
    void main() {
      float t = ease(u_progress);
      bool vertical = u_axis > 0.5;
      float turn = t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;  // 0 → 1 → 0
      float squeeze = max(0.02, 1.0 - turn);
      vec2 uv = v_uv - 0.5;
      uv = vertical ? vec2(uv.x, uv.y / squeeze) : vec2(uv.x / squeeze, uv.y);
      uv += 0.5;
      vec4 c = t < 0.5 ? outside(u_from, uv) : outside(u_to, uv);
      fragColor = vec4(c.rgb * mix(1.0, 0.45, turn), c.a);
    }`),

  /**
   * A cube rotating between two faces.
   *
   * Same honest approximation as `flip3d`: two panels sliding with a perspective-ish squeeze
   * and a shading gradient, rather than a genuinely rotated cube.
   */
  cube: transitionFrag(/* glsl */ `
    uniform float u_axis;
    void main() {
      float t = ease(u_progress);
      bool vertical = u_axis > 0.5;
      vec2 dir = vertical ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
      float sFrom = mix(1.0, 0.55, t);
      float sTo = mix(0.55, 1.0, t);
      vec2 fromScale = vertical ? vec2(1.0, sFrom) : vec2(sFrom, 1.0);
      vec2 toScale = vertical ? vec2(1.0, sTo) : vec2(sTo, 1.0);
      vec4 a = outside(u_from, (v_uv - 0.5 + dir * t) / fromScale + 0.5);
      vec4 b = outside(u_to, (v_uv - 0.5 - dir * (1.0 - t)) / toScale + 0.5);
      a.rgb *= mix(1.0, 0.5, t);
      b.rgb *= mix(0.5, 1.0, t);
      fragColor = a.a > b.a ? a : b;
    }`),

  /**
   * A page peeling off the top-right corner.
   *
   * The curl is a straight diagonal edge with a bright rim and a shadow cast ahead of it — not
   * a simulated cylinder, which would need a real curl parameterisation. The rim plus the
   * shadow is what makes paper read as paper.
   */
  pageTurn: transitionFrag(/* glsl */ `
    void main() {
      float t = ease(u_progress);
      float d = (v_uv.x + (1.0 - v_uv.y)) * 0.5;  // diagonal fold coordinate
      float fold = 1.0 - t;
      if (d > fold) {
        vec4 b = texture(u_to, v_uv);
        float shadow = smoothstep(0.0, 0.12, d - fold);
        fragColor = vec4(b.rgb * mix(0.45, 1.0, shadow), b.a);
        return;
      }
      vec4 a = texture(u_from, v_uv);
      float rim = smoothstep(0.07, 0.0, fold - d);  // paper catching the light at the fold
      fragColor = vec4(mix(a.rgb, vec3(1.0), rim * 0.55), a.a);
    }`),

  /**
   * Luma burn — the outgoing clip dissolves brightest-first, like film burning through.
   *
   * Keyed on the frame's own luminance plus noise, so the dissolve follows the picture instead
   * of being a uniform fade. The glowing front is what makes it read as heat rather than as a
   * threshold.
   */
  burn: transitionFrag(/* glsl */ `
    uniform float u_softness;
    void main() {
      float t = ease(u_progress);
      vec4 a = texture(u_from, v_uv);
      vec4 b = texture(u_to, v_uv);
      float luma = dot(a.rgb, vec3(0.2126, 0.7152, 0.0722));
      float noise = hash12(floor(v_uv / max(u_texel * 3.0, vec2(0.002))));
      float key = mix(luma, noise, 0.35);
      float soft = max(0.01, u_softness);
      float k = smoothstep(t - soft, t + soft, key);
      float edge = max(0.0, 1.0 - abs(key - t) / soft) * step(abs(key - t), soft);
      vec3 ember = vec3(1.0, 0.55, 0.15) * edge * 0.9;
      fragColor = vec4(mix(b.rgb, a.rgb, k) + ember, mix(b.a, a.a, k));
    }`),

  /** Both clips break into growing blocks and swap in the chunkiest frame. */
  pixelize: transitionFrag(/* glsl */ `
    uniform float u_size;
    void main() {
      float t = clamp(u_progress, 0.0, 1.0);
      float cells = mix(1.0, max(2.0, u_size), sin(t * 3.14159265));
      // Quantise in PIXELS, not UV, so the blocks stay square on a non-square frame.
      vec2 grid = u_texel * cells;
      vec2 uv = grid.x > 0.0 ? (floor(v_uv / grid) + 0.5) * grid : v_uv;
      fragColor = mix(texture(u_from, uv), texture(u_to, uv), smoothstep(0.4, 0.6, t));
    }`),

  /**
   * Impact shake — the frame jolts and the cut lands inside the jolt.
   *
   * The decay envelope matters more than the amplitude: a shake that fades reads as an impact,
   * while a constant one reads as a broken tripod.
   */
  shakeTransition: transitionFrag(/* glsl */ `
    uniform float u_amount;
    void main() {
      float t = clamp(u_progress, 0.0, 1.0);
      float env = sin(t * 3.14159265);
      float phase = floor(t * 22.0);
      vec2 jolt = vec2(hash12(vec2(phase, 1.0)) - 0.5, hash12(vec2(phase, 9.0)) - 0.5);
      jolt *= env * env * u_amount * u_texel * 40.0;
      fragColor = mix(outside(u_from, v_uv + jolt), outside(u_to, v_uv + jolt),
                      smoothstep(0.42, 0.58, t));
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
