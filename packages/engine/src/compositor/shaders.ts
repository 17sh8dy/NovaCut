/**
 * GLSL shader library.
 *
 * Each effect definition in the core registry names a `render` key; this file maps that
 * key to a fragment shader. Uniforms are named `u_<paramKey>` to exactly match the effect
 * definition's params, so the compositor binds them generically — add an effect by adding
 * a definition + a shader here, with zero binding code.
 *
 * Common uniforms available to every effect shader:
 *   sampler2D u_texture   — the clip's current pixels
 *   vec2      u_texel     — 1.0 / resolution (one texel step)
 *   float     u_time      — clip-local time in seconds (for animated noise/shake)
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // -1..1 clip space
layout(location = 1) in vec2 a_uv;    // 0..1
uniform mat3 u_model;                 // transform for composite pass (identity for effects)
out vec2 v_uv;
void main() {
  vec3 p = u_model * vec3(a_pos, 1.0);
  v_uv = a_uv;
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

/** Wraps a fragment body with the shared header/uniforms. */
const frag = (body: string) => /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform vec2 u_texel;
uniform float u_time;
uniform float u_opacity;
${body}`;

/** Final composite: sample + apply opacity. Used to draw a processed clip to the canvas. */
export const COMPOSITE_FRAGMENT = frag(/* glsl */ `
void main() {
  vec4 c = texture(u_texture, v_uv);
  fragColor = vec4(c.rgb, c.a * u_opacity);
}`);

export const EFFECT_FRAGMENTS: Record<string, string> = {
  passthrough: frag(`void main(){ fragColor = texture(u_texture, v_uv); }`),

  blur: frag(/* glsl */ `
    uniform float u_radius;
    void main() {
      // 9-tap box blur scaled by radius. Cheap; a separable Gaussian is the upgrade path.
      vec4 sum = vec4(0.0);
      float r = u_radius;
      for (int x = -1; x <= 1; x++)
        for (int y = -1; y <= 1; y++)
          sum += texture(u_texture, v_uv + vec2(float(x), float(y)) * u_texel * r);
      fragColor = sum / 9.0;
    }`),

  pixelate: frag(/* glsl */ `
    uniform float u_size;
    void main() {
      vec2 cell = u_texel * max(1.0, u_size);
      vec2 uv = (floor(v_uv / cell) + 0.5) * cell;
      fragColor = texture(u_texture, uv);
    }`),

  vignette: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_softness;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec2 d = v_uv - 0.5;
      float dist = length(d) * 1.41421356;
      float v = smoothstep(0.8, 0.8 - max(0.001, u_softness), dist);
      c.rgb *= mix(1.0, v, u_amount);
      fragColor = c;
    }`),

  chromatic: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_angle;
    void main() {
      float a = radians(u_angle);
      vec2 dir = vec2(cos(a), sin(a)) * u_texel * u_amount;
      float r = texture(u_texture, v_uv + dir).r;
      float g = texture(u_texture, v_uv).g;
      float b = texture(u_texture, v_uv - dir).b;
      float al = texture(u_texture, v_uv).a;
      fragColor = vec4(r, g, b, al);
    }`),

  grain: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_size;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float n = hash(floor(v_uv / (u_texel * max(0.5, u_size) * 2.0)) + u_time);
      c.rgb += (n - 0.5) * u_amount;
      fragColor = c;
    }`),

  noise: frag(/* glsl */ `
    uniform float u_amount;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float n = hash(v_uv * 1000.0 + u_time);
      fragColor = vec4(mix(c.rgb, vec3(n), u_amount), c.a);
    }`),

  mirror: frag(/* glsl */ `
    uniform float u_axis;
    void main() {
      vec2 uv = v_uv;
      if (u_axis < 0.5) uv.x = uv.x < 0.5 ? uv.x : 1.0 - uv.x;
      else uv.y = uv.y < 0.5 ? uv.y : 1.0 - uv.y;
      fragColor = texture(u_texture, uv);
    }`),

  sharpen: frag(/* glsl */ `
    uniform float u_amount;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec4 blur = (
        texture(u_texture, v_uv + vec2(u_texel.x, 0.0)) +
        texture(u_texture, v_uv - vec2(u_texel.x, 0.0)) +
        texture(u_texture, v_uv + vec2(0.0, u_texel.y)) +
        texture(u_texture, v_uv - vec2(0.0, u_texel.y))) * 0.25;
      fragColor = vec4(c.rgb + (c.rgb - blur.rgb) * u_amount, c.a);
    }`),

  blackWhite: frag(/* glsl */ `
    uniform float u_amount;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      fragColor = vec4(mix(c.rgb, vec3(g), u_amount), c.a);
    }`),

  vintage: frag(/* glsl */ `
    uniform float u_amount;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec3 sepia = vec3(
        dot(c.rgb, vec3(0.393, 0.769, 0.189)),
        dot(c.rgb, vec3(0.349, 0.686, 0.168)),
        dot(c.rgb, vec3(0.272, 0.534, 0.131)));
      vec2 d = v_uv - 0.5;
      float vig = smoothstep(0.9, 0.4, length(d));
      fragColor = vec4(mix(c.rgb, sepia * vig, u_amount), c.a);
    }`),

  glow: frag(/* glsl */ `
    uniform float u_threshold;
    uniform float u_intensity;
    uniform float u_radius;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec3 bloom = vec3(0.0);
      for (int x = -2; x <= 2; x++)
        for (int y = -2; y <= 2; y++) {
          vec3 s = texture(u_texture, v_uv + vec2(float(x), float(y)) * u_texel * u_radius).rgb;
          float l = dot(s, vec3(0.299, 0.587, 0.114));
          if (l > u_threshold) bloom += s;
        }
      bloom /= 25.0;
      fragColor = vec4(c.rgb + bloom * u_intensity, c.a);
    }`),

  motionBlur: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_angle;
    void main() {
      float a = radians(u_angle);
      vec2 dir = vec2(cos(a), sin(a)) * u_texel * u_amount;
      vec4 sum = vec4(0.0);
      for (int i = -4; i <= 4; i++) sum += texture(u_texture, v_uv + dir * float(i));
      fragColor = sum / 9.0;
    }`),

  lensDistort: frag(/* glsl */ `
    uniform float u_k1;
    uniform float u_scale;
    void main() {
      vec2 uv = (v_uv - 0.5) / u_scale;
      float r2 = dot(uv, uv);
      uv *= 1.0 + u_k1 * r2;
      uv += 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { fragColor = vec4(0.0); return; }
      fragColor = texture(u_texture, uv);
    }`),

  // colorAdjust handles brightness/contrast/exposure/saturation/hue/tint/temperature.
  // Only the uniforms present in a given effect's params are non-zero; the rest default 0.
  colorAdjust: frag(/* glsl */ `
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_exposure;
    uniform float u_saturation;
    uniform float u_hue;
    uniform float u_tint;
    uniform float u_temperature;
    vec3 hueShift(vec3 col, float deg) {
      float a = radians(deg);
      float c = cos(a), s = sin(a);
      mat3 m = mat3(
        0.299 + 0.701*c + 0.168*s, 0.587 - 0.587*c + 0.330*s, 0.114 - 0.114*c - 0.497*s,
        0.299 - 0.299*c - 0.328*s, 0.587 + 0.413*c + 0.035*s, 0.114 - 0.114*c + 0.292*s,
        0.299 - 0.300*c + 1.250*s, 0.587 - 0.588*c - 1.050*s, 0.114 + 0.886*c - 0.203*s);
      return clamp(m * col, 0.0, 1.0);
    }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec3 col = c.rgb;
      col *= pow(2.0, u_exposure);
      col += u_brightness;
      col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
      col.r += u_temperature * 0.15; col.b -= u_temperature * 0.15;   // warm/cool
      col.g += u_tint * 0.15;                                          // green/magenta
      float g = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(g), col, 1.0 + u_saturation);
      if (abs(u_hue) > 0.001) col = hueShift(col, u_hue);
      fragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`),
};

/** Every uniform key a colorAdjust-style shader might read; the binder zero-fills missing. */
export const COLOR_ADJUST_KEYS = [
  'brightness', 'contrast', 'exposure', 'saturation', 'hue', 'tint', 'temperature',
];
