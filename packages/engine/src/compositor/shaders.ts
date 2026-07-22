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

  /**
   * Gaussian-weighted 25-tap blur.
   *
   * The previous 9-tap BOX blur was visibly wrong at any real radius: a box kernel's flat
   * weights leave hard concentric banding, so a "blurred" background read as a stack of
   * stepped copies rather than as defocus. This spreads 5×5 taps across the radius with true
   * Gaussian weights, which is both smoother and — because the taps are spread rather than
   * adjacent — usable up to a 100px radius from a single pass.
   */
  blur: frag(/* glsl */ `
    uniform float u_radius;
    void main() {
      float r = max(0.0, u_radius);
      if (r < 0.01) { fragColor = texture(u_texture, v_uv); return; }
      // sigma chosen so the outermost tap sits at ~2σ, where the Gaussian has all but died.
      float sigma = max(0.5, r * 0.5);
      vec4 sum = vec4(0.0);
      float wsum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 off = vec2(float(x), float(y)) * r * 0.5;
          float w = exp(-dot(off, off) / (2.0 * sigma * sigma));
          sum += texture(u_texture, v_uv + off * u_texel) * w;
          wsum += w;
        }
      }
      fragColor = sum / max(wsum, 1e-4);
    }`),

  /**
   * Edge-preserving denoise (a small bilateral filter).
   *
   * A plain blur removes noise and detail equally, which is why "noise reduction" implemented
   * as a blur always reads as mush. Weighting each tap by how close it is in COLOUR as well as
   * in space keeps edges intact: taps across a boundary contribute almost nothing, so the
   * boundary survives while flat areas average out.
   */
  denoise: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_radius;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      if (u_amount < 0.001) { fragColor = c; return; }
      float r = max(0.5, u_radius);
      // Larger amount ⇒ looser colour tolerance ⇒ more aggressive smoothing.
      float sigmaC = mix(0.02, 0.30, clamp(u_amount, 0.0, 1.0));
      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 off = vec2(float(x), float(y)) * r;
          vec3 s = texture(u_texture, v_uv + off * u_texel).rgb;
          float ds = dot(off, off);
          float dc = dot(s - c.rgb, s - c.rgb);
          float w = exp(-ds / 18.0) * exp(-dc / (2.0 * sigmaC * sigmaC));
          sum += s * w;
          wsum += w;
        }
      }
      fragColor = vec4(mix(c.rgb, sum / max(wsum, 1e-4), clamp(u_amount, 0.0, 1.0)), c.a);
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

  /**
   * The whole tonal + colour engine, in one pass.
   *
   * Every `color`- and `light`-category effect renders through this shader and simply leaves
   * the uniforms it doesn't expose at zero (the binder zero-fills them — see COLOR_ADJUST_KEYS).
   * One shader rather than fourteen is not just less code: stacking Exposure + Highlights +
   * Vibrance as three separate passes would quantise to 8 bits between each one, and banding
   * in a sky is exactly where that shows. Here they compose in float and quantise once.
   *
   * The order is Lightroom's, and it is not arbitrary — tonal work happens in scene-referred
   * linear-ish space before saturation, or boosting exposure would also boost saturation and
   * every bright colour would clip to a flat primary.
   */
  colorAdjust: frag(/* glsl */ `
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_exposure;
    uniform float u_saturation;
    uniform float u_hue;
    uniform float u_tint;
    uniform float u_temperature;
    uniform float u_highlights;
    uniform float u_shadows;
    uniform float u_whites;
    uniform float u_blacks;
    uniform float u_vibrance;
    uniform float u_gamma;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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

      // ── Tonal zones ──
      // Each control owns a soft luminance band and lifts/crushes only inside it. The bands
      // overlap deliberately: hard cutoffs would leave a visible seam where one control's
      // influence ends and the next begins.
      float l = dot(clamp(col, 0.0, 4.0), LUMA);
      if (abs(u_highlights) > 0.001) {
        float m = smoothstep(0.45, 1.0, l);
        col += u_highlights * m * (u_highlights > 0.0 ? (1.0 - col) : col) * 0.9;
      }
      if (abs(u_shadows) > 0.001) {
        float m = 1.0 - smoothstep(0.0, 0.55, l);
        col += u_shadows * m * (u_shadows > 0.0 ? (1.0 - col) : col) * 0.9;
      }
      if (abs(u_whites) > 0.001) {
        float m = smoothstep(0.7, 1.15, l);
        col += u_whites * m * 0.5;
      }
      if (abs(u_blacks) > 0.001) {
        float m = 1.0 - smoothstep(-0.1, 0.3, l);
        col += u_blacks * m * 0.5;
      }

      col = (col - 0.5) * (1.0 + u_contrast) + 0.5;

      // Gamma is applied on non-negative values only; pow() of a negative is undefined, and a
      // pixel can be negative here after a hard Blacks crush.
      if (abs(u_gamma) > 0.001) {
        float g = clamp(1.0 - u_gamma * 0.8, 0.05, 5.0);
        col = pow(max(col, 0.0), vec3(g));
      }

      col.r += u_temperature * 0.15; col.b -= u_temperature * 0.15;   // warm/cool
      col.g += u_tint * 0.15;                                          // green/magenta

      // ── Vibrance, then saturation ──
      // Vibrance weights its boost by how UNsaturated a pixel already is, so skin and skies
      // gain without the already-vivid parts of the frame clipping into poster paint. That
      // weighting is the entire difference between the two controls.
      if (abs(u_vibrance) > 0.001) {
        float mx = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float sat = mx - mn;
        float g = dot(col, LUMA);
        col = mix(vec3(g), col, 1.0 + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
      }
      float g2 = dot(col, LUMA);
      col = mix(vec3(g2), col, 1.0 + u_saturation);

      if (abs(u_hue) > 0.001) col = hueShift(col, u_hue);
      fragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`),

  // ── Layer styles ─────────────────────────────────────────────────────────
  // These read the layer's ALPHA, not its colour: they decorate the silhouette. Because the
  // photo graph rasterises every layer into a canvas-sized buffer before its effects run, a
  // shadow or outline has room to spread past the artwork instead of being clipped to it.

  /**
   * Drop shadow, cast from the layer's own alpha and composited BEHIND it.
   *
   * Sampling alpha at an offset and blurring it is the whole trick. The `over` at the end is
   * source-over with the layer as source, which is what puts the shadow behind rather than on
   * top — getting that backwards produces a dark haze over the artwork instead of under it.
   */
  dropShadow: frag(/* glsl */ `
    uniform float u_distance;
    uniform float u_angle;
    uniform float u_softness;
    uniform float u_strength;
    uniform float u_color;
    vec3 unpackColor(float v) {
      float r = floor(v / 65536.0);
      float g = floor(mod(v, 65536.0) / 256.0);
      float b = mod(v, 256.0);
      return vec3(r, g, b) / 255.0;
    }
    void main() {
      vec4 src = texture(u_texture, v_uv);
      float a = radians(u_angle);
      vec2 off = vec2(cos(a), -sin(a)) * u_distance * u_texel;
      float r = max(0.5, u_softness);
      float shadowA = 0.0;
      float wsum = 0.0;
      for (int x = -3; x <= 3; x++) {
        for (int y = -3; y <= 3; y++) {
          vec2 d = vec2(float(x), float(y)) * r * 0.4;
          float w = exp(-dot(d, d) / (2.0 * r * r * 0.36 + 1e-4));
          shadowA += texture(u_texture, v_uv - off + d * u_texel).a * w;
          wsum += w;
        }
      }
      shadowA = clamp(shadowA / max(wsum, 1e-4), 0.0, 1.0) * clamp(u_strength, 0.0, 1.0);
      vec4 shadow = vec4(unpackColor(u_color), shadowA);
      float outA = src.a + shadow.a * (1.0 - src.a);
      vec3 outRGB = outA <= 0.0 ? vec3(0.0)
        : (src.rgb * src.a + shadow.rgb * shadow.a * (1.0 - src.a)) / outA;
      fragColor = vec4(outRGB, outA);
    }`),

  /**
   * A solid outline hugging the layer's silhouette.
   *
   * The classic "sticker" border, and the one creators reach for to lift a cut-out subject off
   * a busy background. Built by taking the max alpha in a disc of radius `width`: any pixel
   * within `width` of opaque artwork becomes outline, which is a dilation, which is exactly
   * what an outside stroke is.
   */
  outline: frag(/* glsl */ `
    uniform float u_width;
    uniform float u_color;
    uniform float u_strength;
    vec3 unpackColor(float v) {
      float r = floor(v / 65536.0);
      float g = floor(mod(v, 65536.0) / 256.0);
      float b = mod(v, 256.0);
      return vec3(r, g, b) / 255.0;
    }
    void main() {
      vec4 src = texture(u_texture, v_uv);
      float w = max(0.0, u_width);
      if (w < 0.01) { fragColor = src; return; }
      float dil = 0.0;
      // 16 directions × 3 rings. A square kernel would give the outline square corners; a
      // radial sample set keeps it round, which is what a stroke looks like.
      for (int i = 0; i < 16; i++) {
        float a = float(i) * 0.3926991;
        vec2 dir = vec2(cos(a), sin(a));
        dil = max(dil, texture(u_texture, v_uv + dir * w * u_texel).a);
        dil = max(dil, texture(u_texture, v_uv + dir * w * 0.66 * u_texel).a);
        dil = max(dil, texture(u_texture, v_uv + dir * w * 0.33 * u_texel).a);
      }
      float ringA = clamp(dil, 0.0, 1.0) * clamp(u_strength, 0.0, 1.0);
      vec4 ring = vec4(unpackColor(u_color), ringA);
      float outA = src.a + ring.a * (1.0 - src.a);
      vec3 outRGB = outA <= 0.0 ? vec3(0.0)
        : (src.rgb * src.a + ring.rgb * ring.a * (1.0 - src.a)) / outA;
      fragColor = vec4(outRGB, outA);
    }`),

  /** Flood the layer with one colour, keeping its alpha. A silhouette in one slider. */
  colorOverlay: frag(/* glsl */ `
    uniform float u_color;
    uniform float u_amount;
    vec3 unpackColor(float v) {
      float r = floor(v / 65536.0);
      float g = floor(mod(v, 65536.0) / 256.0);
      float b = mod(v, 256.0);
      return vec3(r, g, b) / 255.0;
    }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      fragColor = vec4(mix(c.rgb, unpackColor(u_color), clamp(u_amount, 0.0, 1.0)), c.a);
    }`),

  /** A two-stop gradient laid over the layer, masked by its alpha. */
  gradientOverlay: frag(/* glsl */ `
    uniform float u_color;
    uniform float u_color2;
    uniform float u_angle;
    uniform float u_amount;
    vec3 unpackColor(float v) {
      float r = floor(v / 65536.0);
      float g = floor(mod(v, 65536.0) / 256.0);
      float b = mod(v, 256.0);
      return vec3(r, g, b) / 255.0;
    }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float a = radians(u_angle);
      vec2 dir = vec2(cos(a), sin(a));
      // Project onto the gradient axis and renormalise: the diagonal of a unit square is
      // longer than its side, so without this a 45° gradient would clip at both ends.
      float t = dot(v_uv - 0.5, dir) / (abs(dir.x) + abs(dir.y)) + 0.5;
      vec3 grad = mix(unpackColor(u_color), unpackColor(u_color2), clamp(t, 0.0, 1.0));
      fragColor = vec4(mix(c.rgb, grad, clamp(u_amount, 0.0, 1.0)), c.a);
    }`),

  /** Wide, soft light bleeding out of the bright areas. Glow's bigger, softer sibling. */
  bloom: frag(/* glsl */ `
    uniform float u_threshold;
    uniform float u_intensity;
    uniform float u_radius;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 16; i++) {
        float a = float(i) * 0.3926991;
        vec2 dir = vec2(cos(a), sin(a));
        for (int ring = 1; ring <= 3; ring++) {
          float rr = float(ring) / 3.0;
          vec3 s = texture(u_texture, v_uv + dir * u_radius * rr * u_texel).rgb;
          float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
          float w = smoothstep(u_threshold, 1.0, l) * (1.0 - rr * 0.6);
          sum += s * w;
          wsum += w;
        }
      }
      vec3 b = wsum > 0.0 ? sum / 48.0 : vec3(0.0);
      fragColor = vec4(c.rgb + b * u_intensity, c.a);
    }`),

  /** Map luminance onto a two-colour ramp — the poster look, in one pass. */
  duotone: frag(/* glsl */ `
    uniform float u_color;
    uniform float u_color2;
    uniform float u_amount;
    vec3 unpackColor(float v) {
      float r = floor(v / 65536.0);
      float g = floor(mod(v, 65536.0) / 256.0);
      float b = mod(v, 256.0);
      return vec3(r, g, b) / 255.0;
    }
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 duo = mix(unpackColor(u_color), unpackColor(u_color2), l);
      fragColor = vec4(mix(c.rgb, duo, clamp(u_amount, 0.0, 1.0)), c.a);
    }`),

  posterize: frag(/* glsl */ `
    uniform float u_levels;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float n = max(2.0, floor(u_levels));
      fragColor = vec4(floor(c.rgb * n) / (n - 1.0), c.a);
    }`),

  threshold: frag(/* glsl */ `
    uniform float u_level;
    uniform float u_softness;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      float s = max(0.001, u_softness);
      float v = smoothstep(u_level - s, u_level + s, l);
      fragColor = vec4(vec3(v), c.a);
    }`),

  invert: frag(/* glsl */ `
    uniform float u_amount;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      fragColor = vec4(mix(c.rgb, 1.0 - c.rgb, clamp(u_amount, 0.0, 1.0)), c.a);
    }`),

  /**
   * Local contrast (clarity) — unsharp masking at a large radius.
   *
   * Sharpen at radius 1 crisps edges; the same operation at radius 20 adds the "punch" a
   * thumbnail wants without the crunchy halos of a hard sharpen.
   */
  clarity: frag(/* glsl */ `
    uniform float u_amount;
    uniform float u_radius;
    void main() {
      vec4 c = texture(u_texture, v_uv);
      float r = max(1.0, u_radius);
      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 off = vec2(float(x), float(y)) * r * 0.5;
          float w = exp(-dot(off, off) / (2.0 * r * r * 0.25 + 1e-4));
          sum += texture(u_texture, v_uv + off * u_texel).rgb * w;
          wsum += w;
        }
      }
      vec3 lowFreq = sum / max(wsum, 1e-4);
      fragColor = vec4(clamp(c.rgb + (c.rgb - lowFreq) * u_amount, 0.0, 1.0), c.a);
    }`),
};

/**
 * Every uniform key the shared `colorAdjust` shader reads; the binder zero-fills the ones a
 * given effect does not expose.
 *
 * This list MUST stay in sync with the uniforms declared in that shader. A key present in the
 * shader but missing here is the dangerous direction: WebGL leaves an unwritten uniform at
 * zero on first use but at its LAST value on reuse, and the program is cached across layers —
 * so a stale Vibrance from the previous layer would leak into the next one's Exposure pass.
 */
export const COLOR_ADJUST_KEYS = [
  'brightness', 'contrast', 'exposure', 'saturation', 'hue', 'tint', 'temperature',
  'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'gamma',
];
