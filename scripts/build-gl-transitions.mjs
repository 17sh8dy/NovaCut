/**
 * Builds Nova Cut's GL Transitions catalog from the pinned `gl-transitions` package.
 *
 *   npm run gl-transitions        (node scripts/build-gl-transitions.mjs)
 *
 * SOURCE OF TRUTH: the package in node_modules, pinned to an exact version in package.json.
 * Nothing below is authored by hand — every output is derived, and the outputs are CHECKED IN so
 * a build never depends on the network, and a change to the shaders shows up as a diff.
 *
 * Outputs
 *   packages/core/src/effects/glTransitions.generated.ts      metadata: label, author, licence,
 *                                                             category, flattened params, bindings
 *   packages/engine/src/compositor/glTransitions.generated.ts the GLSL ES 3.00 sources, verbatim
 *   licenses/gl-transitions.md                                third-party notices (MIT text, the
 *                                                             per-shader table, the BSD notices)
 *
 * The editor never reads node_modules at runtime and never loads the package: it uses the
 * generated modules, which are plain data.
 *
 * ── What is deliberately NOT done here ──────────────────────────────────────────────
 *   - No shader source is rewritten. The package's `glsl3/` files are already GLSL ES 3.00 and
 *     the engine wraps them in a host header (see engine/src/compositor/glTransitions.ts), so the
 *     licence header comments each file carries stay attached to the code they describe.
 *   - Shaders that need an extra texture (`luma`, `displacement`) get a procedural greyscale map,
 *     chosen by a whole-number parameter (see MAP_NAMES). Anything else that needs a texture is listed
 *     in GL_TRANSITIONS_UNSUPPORTED with the reason, so a gap is visible and testable.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'node_modules', 'gl-transitions');
const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pinned = rootPkg.devDependencies?.['gl-transitions'];
if (pinned !== pkgJson.version) {
  throw new Error(`gl-transitions is installed at ${pkgJson.version} but package.json pins ${pinned}. Run npm install.`);
}
const catalog = JSON.parse(readFileSync(join(PKG, 'gl-transitions.json'), 'utf8'));
const mitText = readFileSync(join(PKG, 'LICENSE'), 'utf8').trim();

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** "BowTieWithParameter" -> "Bow Tie With Parameter", "Drop_Zone_Flicker" -> "Drop Zone Flicker". */
const prettyName = (name) => {
  const spaced = name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return spaced.replace(/\b([a-z])/g, (m) => m.toUpperCase());
};

/**
 * Names the automatic tidy-up cannot get right. The package's names are file names: lowercase
 * compounds ("fadecolor"), underscores, a typo ("ZoomRigthWipe") and British spellings. These are
 * what a person reads in the browser, so they are written out by hand. A name that is not listed
 * here falls back to `prettyName`. Where a library name would collide with one of Nova Cut's own
 * ("Cube", "Dissolve", "Pixelize"), the library one is told apart by what makes it different.
 */
const LABELS = {
  angular: 'Angular Wipe', Box: 'Box Shrink', BowTieWithParameter: 'Bow Tie (Adjustable)',
  burn: 'Color Burn', burn0: 'Burn Away', cannabisleaf: 'Leaf Reveal', chessboard: 'Chessboard',
  circle: 'Circle Close & Open', circleopen: 'Circle Open', colorphase: 'Color Phase',
  ColourDistance: 'Color Distance', 'coord-from-in': 'Color Displace', CrazyParametricFun: 'Parametric Fun',
  crosshatch: 'Crosshatch', crosswarp: 'Cross Warp', cube: 'Cube Reflection',
  Directional: 'Directional Push', 'directional-easing': 'Directional Push (Eased)',
  DirectionalScaled: 'Directional Push (Scaled)', directionalwarp: 'Directional Warp',
  directionalwipe: 'Directional Wipe', dissolve: 'Glow Dissolve', DoomScreenTransition: 'Doom Screen Melt',
  doorway: 'Doorway', EdgeTransition: 'Glowing Edges', fade: 'Linear Fade', fadecolor: 'Fade Through Color',
  fadegrayscale: 'Fade Through Grayscale', flyeye: 'Fly Eye', fragment: 'Shatter', heart: 'Heart Reveal',
  hexagonalize: 'Hexagonalize', HSVfade: 'HSV Fade', LeftRight: 'Shrink & Slide Left',
  luminance_melt: 'Luminance Melt', mosaic_transition: 'Mosaic Blocks', Mosaic: 'Mosaic Pan',
  multiply_blend: 'Multiply Blend', old_tv_lost_signal: 'Lost TV Signal', Overexposure: 'Overexposure',
  parametric_glitch: 'Parametric Glitch', perlin: 'Perlin Noise', pixelize: 'Pixel Crossfade',
  polar_function: 'Flower Reveal', powerKaleido: 'Kaleidoscope Fold', Radial: 'Radial Wipe',
  randomNoisex: 'Random Pixels', randomsquares: 'Random Squares', Revolve_Left: 'Revolve Left',
  Rolls: 'Corner Roll', rotate_scale_fade: 'Rotate Scale Fade', rotateTransition: 'Spin Crossfade',
  'scale-in': 'Scale In', Slides: 'Edge Slides', squareswire: 'Squares Wire', static_wipe: 'Static Wipe',
  TopBottom: 'Shrink & Slide Up', TVStatic: 'TV Static', windowblinds: 'Window Blinds',
  windowslice: 'Window Slice', x_axis_translation: 'X-Axis Slide', zoomInOut: 'Zoom In & Out',
  ZoomRigthWipe: 'Zoom Right Wipe', Drop_Zone_Flicker: 'Drop Zone Flicker', undulatingBurnOut: 'Undulating Burn Out',
  kaleidoscope: 'Kaleidoscope', morph: 'Morph', swap: 'Swap', ripple: 'Ripple', pinwheel: 'Pinwheel',
};

/** Parameter names, by the shader's own uniform name. Anything else gets `prettyName`. */
const PARAM_LABELS = {
  a: 'Parameter A', b: 'Parameter B', z: 'Z Value', ampx: 'Horizontal Amplitude', ampy: 'Vertical Amplitude',
  backColor: 'Background Color', bgcolor: 'Background Color', blocksize: 'Block Size', colorPhase: 'Color Hold',
  dots: 'Dot Count', endx: 'End X', endy: 'End Y', floating: 'Float Height', persp: 'Perspective',
  unzoom: 'Zoom Out', grid_num: 'Grid Size', l_threshold: 'Luminance Threshold', mosaicNum: 'Mosaic Blocks',
  n_noise_pixels: 'Noise Pixels', offset: 'Hold at Ends', opening: 'Opens', rectIn: 'Shrink Inward',
  redCyan: 'Red/Cyan Split', rgbOffset: 'RGB Offset', seed: 'Random Seed', Seed: 'Random Seed',
  shadow_colour: 'Shadow Color', squaresMin: 'Minimum Squares', startingAngle: 'Start Angle',
  static_luminosity: 'Static Brightness', toStep: 'End Times', fromStep: 'Start Times',
  uHotClr: 'Hot Edge Color', uIntensity: 'Intensity', uLineWidth: 'Line Width', uPow: 'Power',
  uSpreadClr: 'Spread Color', u_max_static_span: 'Static Band Height', u_transitionUpToDown: 'Top to Bottom',
  zoom_quickness: 'Zoom Time', type: 'Corner', In: 'Slide In', RotDown: 'Roll Down', FadeInSecond: 'Fade In Second',
};

/** "RGB", "HSV" and "TV" are not words to be title-cased. */
const acronyms = (s) => s.replace(/\bRgb\b/g, 'RGB').replace(/\bHsv\b/g, 'HSV').replace(/\bTv\b/g, 'TV').replace(/\bColour\b/g, 'Color');

/** The smallest 1/2/5 x 10^n that is >= x. */
const niceCeil = (x) => {
  if (!(x > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * pow >= x - 1e-12) return m * pow;
  return 10 * pow;
};
/** A slider step that gives roughly 200 stops across `range`. */
const niceStep = (range) => {
  const raw = range / 200;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw - 1e-12) return Number((m * pow).toPrecision(6));
  return pow * 10;
};
const round = (n) => Number(Number(n).toPrecision(6));

/** A range for a float that the shader author did not annotate with `@range`. */
function inferRange(def) {
  if (def === 0) return [-1, 1];
  if (def > 0) return [0, niceCeil(def * 4)];
  const m = niceCeil(-def * 4);
  return [-m, m];
}

/**
 * Flatten one shader parameter into numeric params, because a transition instance stores
 * `params: Record<string, number>` and that shape must not change (it is what keeps every saved
 * project, and the keyframe/serialiser code, untouched).
 *   float, int, bool        -> one key, named as the uniform
 *   vecN / ivecN            -> `name.x .y .z .w`
 *   vec3 / vec4 + @color    -> `name.r .g .b .a`
 * `inferred` marks a range we guessed rather than read from an `@range` annotation.
 */
function flatten(name, p) {
  const short = acronyms(PARAM_LABELS[name] ?? prettyName(name));
  const isVec = /^i?vec([234])$/.exec(p.type);
  const n = isVec ? Number(isVec[1]) : 1;
  const comps = !isVec ? [''] : p.color ? ['.r', '.g', '.b', '.a'].slice(0, n) : ['.x', '.y', '.z', '.w'].slice(0, n);
  const defaults = Array.isArray(p.default) ? p.default.map(Number) : [typeof p.default === 'boolean' ? (p.default ? 1 : 0) : Number(p.default ?? 0)];
  while (defaults.length < n) defaults.push(0);

  // "Number of tiles (columns, rows)" and "(r, g, b, a)" name the components.
  const listed = /\(([^()]+)\)/.exec(p.description ?? '');
  const parts = listed ? listed[1].split(',').map((x) => x.trim()) : [];
  const componentLabels = isVec && parts.length === n && parts.every((x) => /^[a-z]+$/i.test(x)) ? parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)) : null;
  const params = comps.map((suffix, i) => {
    const d = defaults[i];
    let min;
    let max;
    let step;
    let inferred = false;
    if (p.type === 'bool') {
      [min, max, step] = [0, 1, 1];
    } else if (p.color) {
      [min, max, step] = [0, 1, 0.01];
    } else if (typeof p.min === 'number' && typeof p.max === 'number') {
      [min, max] = [p.min, p.max];
      step = typeof p.step === 'number' ? p.step : p.type.startsWith('i') || p.type === 'int' ? 1 : niceStep(max - min);
    } else if (p.type === 'int' || p.type.startsWith('ivec')) {
      [min, max, step] = [p.type.startsWith('ivec') ? 1 : 0, Math.max(8, Math.ceil(d * 4)), 1];
      inferred = true;
    } else {
      [min, max] = inferRange(d);
      step = niceStep(max - min);
      inferred = true;
    }
    if (d < min) min = d;
    if (d > max) max = d;
    const compLabel = suffix ? ` ${componentLabels?.[i] ?? suffix.slice(1).toUpperCase()}` : '';
    return {
      key: `${name}${suffix}`,
      label: `${short}${compLabel}`,
      min: round(min),
      max: round(max),
      default: round(d),
      step: round(step),
      ...(inferred ? { inferred: true } : {}),
      group: name,
    };
  });
  return {
    params,
    binding: {
      uniform: name,
      type: p.type,
      label: short,
      ...(p.description ? { description: p.description } : {}),
      ...(p.color ? { color: true } : {}),
      ...(componentLabels ? { componentLabels } : {}),
      keys: params.map((x) => x.key),
      defaults: defaults.map(round),
    },
  };
}

// Category by tag. Order matters: the FIRST category whose tag set intersects wins, so the
// specific ones sit above the general ones.
const CATEGORIES = [
  ['3D & Page', ['3d', 'cube', 'page', 'flip', 'fold', 'curl', 'cards', 'book']],
  ['Glitch & Distort', ['shatter', 'fragments', 'glitch', 'distort', 'displace', 'datamosh', 'warp', 'wave', 'ripple', 'water', 'melt', 'static', 'scanlines', 'flicker', 'chromatic', 'noise', 'retro']],
  ['Light & Colour', ['burn', 'fire', 'flash', 'glow', 'light', 'light-leak', 'hue', 'grayscale', 'film', 'psychedelic', 'color']],
  ['Pixel & Mosaic', ['pixelate', 'mosaic', 'grid', 'tiles', 'blocks', 'columns', 'pattern', 'lines', 'dots']],
  ['Shapes & Reveals', ['shape', 'circle', 'iris', 'heart', 'hexagon', 'star', 'squares', 'clock', 'radial', 'pinwheel', 'mask', 'box']],
  ['Zoom & Rotate', ['zoom', 'rotate', 'spin', 'swirl', 'kaleidoscope', 'lens', 'squeeze', 'polar', 'bounce']],
  ['Wipe & Slide', ['wipe', 'slide', 'push', 'directional', 'split', 'doors', 'blinds', 'roll', 'swap', 'stripes', 'horizontal', 'vertical']],
  ['Dissolve & Fade', ['fade', 'dissolve', 'blend', 'blur', 'luma']],
];
const categoryOf = (tags) => {
  const set = new Set(tags);
  for (const [name, list] of CATEGORIES) if (list.some((t) => set.has(t))) return name;
  return 'More';
};

// The front page of the browser. Hand-picked from what the gallery is known for; names that are
// missing from a future package version are reported rather than silently dropped.
const FEATURED = [
  'CrossZoom', 'cube', 'Dreamy', 'DreamyZoom', 'GlitchMemories', 'ripple', 'swap', 'PolkaDotsCurtain',
  'doorway', 'angular', 'burn', 'FilmBurn', 'CircleCrop', 'colorphase', 'directionalwipe', 'fadecolor',
  'fadegrayscale', 'InvertedPageCurl', 'kaleidoscope', 'LinearBlur', 'morph', 'pinwheel', 'Radial',
  'rotate_scale_fade', 'squareswire', 'squeeze', 'Swirl', 'undulatingBurnOut', 'windowblinds',
  'ZoomInCircles', 'StereoViewer', 'TVStatic', 'WaterDrop', 'crosswarp', 'directionalwarp', 'perlin',
];

/**
 * The greyscale maps the texture shaders (`luma`, `displacement`) read. Generated at run time by
 * packages/engine/src/compositor/glMaps.ts, in THIS order, so a saved parameter is an index into
 * this list. Procedural on purpose: the gallery's own map images carry their own licences, and a few
 * well-chosen gradients and noise cover what these two shaders are for. Append only; never reorder.
 */
const MAP_NAMES = ['Left to Right', 'Top to Bottom', 'Diagonal', 'Center Out', 'Clouds', 'Stripes', 'Checkerboard', 'Spiral'];
/** Per texture uniform: what it is called in the Inspector, and which map it starts on. */
const MAP_TEXTURES = {
  luma: { label: 'Mask Shape', def: 'Center Out' },
  displacementMap: { label: 'Displacement Pattern', def: 'Clouds' },
};

// ── build ───────────────────────────────────────────────────────────────────────────

const meta = [];
const sources = {};
const unsupported = [];
const names = new Set(catalog.map((t) => t.name));
const missingFeatured = FEATURED.filter((n) => !names.has(n));
if (missingFeatured.length) console.warn('featured names not in this package version:', missingFeatured.join(', '));

for (const t of catalog.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  const unknownTexture = (t.textures ?? []).find((x) => !MAP_TEXTURES[x]);
  if (unknownTexture) {
    unsupported.push({ name: t.name, reason: `needs a texture ("${unknownTexture}") the adapter has no map for`, textures: t.textures });
    continue;
  }
  const src = readFileSync(join(PKG, 'glsl3', `${t.name}.glsl`), 'utf8');
  sources[t.name] = src;
  const params = [];
  const bindings = [];
  for (const [pname, p] of Object.entries(t.params ?? {})) {
    const f = flatten(pname, p);
    params.push(...f.params);
    bindings.push(f.binding);
  }
  // Extra texture inputs: one whole-number parameter each, an index into MAP_NAMES.
  for (const tex of t.textures ?? []) {
    const info = MAP_TEXTURES[tex];
    const key = `${tex}.map`;
    params.push({ key, label: info.label, min: 0, max: MAP_NAMES.length - 1, default: MAP_NAMES.indexOf(info.def), step: 1, group: tex });
    bindings.push({ uniform: tex, type: 'sampler2D', label: info.label, keys: [key], defaults: [MAP_NAMES.indexOf(info.def)] });
  }
  meta.push({
    name: t.name,
    label: acronyms(LABELS[t.name] ?? prettyName(t.name)),
    author: t.author,
    license: t.license,
    description: t.description ?? '',
    tags: t.tags ?? [],
    category: categoryOf(t.tags ?? []),
    featured: FEATURED.includes(t.name),
    params,
    bindings,
  });
}

const banner = `// GENERATED by scripts/build-gl-transitions.mjs from gl-transitions@${pkgJson.version} (MIT).
// Do not edit by hand: change the generator or the pinned package and re-run \`npm run gl-transitions\`.
`;

const coreOut = join(ROOT, 'packages/core/src/effects/glTransitions.generated.ts');
writeFileSync(
  coreOut,
  `${banner}
import type { GlTransitionMeta } from './glTransitions.js';

export const GL_TRANSITIONS_VERSION = ${JSON.stringify(pkgJson.version)};

/** The procedural greyscale maps texture shaders can read, in index order (see glMaps.ts in the engine). */
export const GL_TRANSITION_MAPS: string[] = ${JSON.stringify(MAP_NAMES)};

export const GL_TRANSITIONS: GlTransitionMeta[] = ${JSON.stringify(meta, null, 2)};

/** Shaders in the package that are not registered yet, and why. */
export const GL_TRANSITIONS_UNSUPPORTED: { name: string; reason: string; textures: string[] }[] = ${JSON.stringify(unsupported, null, 2)};
`,
);

const engineOut = join(ROOT, 'packages/engine/src/compositor/glTransitions.generated.ts');
writeFileSync(
  engineOut,
  `${banner}
/**
 * GLSL ES 3.00 sources, verbatim from the package's glsl3/ folder (each file keeps its own
 * author / licence header comment). The host wrapper that turns one into a full fragment shader is
 * in glTransitions.ts.
 */
export const GL_TRANSITION_SOURCES: Record<string, string> = ${JSON.stringify(sources, null, 2)};
`,
);

// ── third-party notices ─────────────────────────────────────────────────────────────

/** The block comment holding a BSD licence, copied exactly as the author wrote it. */
const bsdBlock = (name) => {
  const src = readFileSync(join(PKG, 'glsl3', `${name}.glsl`), 'utf8');
  const m = /\/\*[\s\S]*?\*\//.exec(src);
  return m ? m[0] : null;
};
const nonMit = meta.filter((m) => m.license !== 'MIT');
const rows = meta.map((m) => `| ${m.name} | ${m.author.replace(/\|/g, '/')} | ${m.license} |`).join('\n');
const bsdNotes = nonMit
  .map((m) => {
    const block = bsdBlock(m.name);
    return `### ${m.name}  (${m.license}, ${m.author})\n\n${
      block
        ? '```\n' + block.replace(/^\/\*\n?/, '').replace(/\n?\*\/$/, '') + '\n```'
        : 'The author\'s terms, from the shader\'s own header comment, are: "Free for use and modification by anyone with credit". Credit: **' +
          m.author + '**.'
    }\n`;
  })
  .join('\n');

mkdirSync(join(ROOT, 'licenses'), { recursive: true });
const NOTICE = `# Third-party notice: GL Transitions

Nova Cut includes the transition shaders from **gl-transitions** ${pkgJson.version}
(https://github.com/gl-transitions/gl-transitions, https://gl-transitions.com), used under the MIT
licence below. Individual shaders carry their own author and licence line in their header comment;
those are kept intact in the bundled source and listed in the table.

## Package licence

${mitText}

## Shaders under other licences

${nonMit.length} of the ${meta.length} bundled shaders are not MIT. Their notices are reproduced here as the
licences require, and the same text stays in the shader source.

${bsdNotes}
## Every bundled shader

| Shader | Author | Licence |
| --- | --- | --- |
${rows}

*Generated by scripts/build-gl-transitions.mjs. Do not edit by hand.*
`;
writeFileSync(join(ROOT, 'licenses/gl-transitions.md'), NOTICE);
// The same text, for the About pane (Settings > About > Third-party notices).
appendFileSync(coreOut, `\n/** The third-party notice for the bundled shaders, shown in Settings > About. */\nexport const GL_TRANSITIONS_NOTICE: string = ${JSON.stringify(NOTICE)};\n`);

const byCat = {};
for (const m of meta) byCat[m.category] = (byCat[m.category] ?? 0) + 1;
console.log(`gl-transitions ${pkgJson.version}: ${meta.length} registered, ${unsupported.length} unsupported (${unsupported.map((u) => u.name).join(', ')})`);
console.log('categories', byCat);
console.log('featured', meta.filter((m) => m.featured).length, '| licences', [...new Set(meta.map((m) => m.license))].join(', '));
console.log('params', meta.reduce((n, m) => n + m.params.length, 0), 'flattened keys across', meta.filter((m) => m.params.length).length, 'shaders');
console.log('wrote', coreOut.replace(ROOT, '.'), engineOut.replace(ROOT, '.'), 'licenses/gl-transitions.md');
