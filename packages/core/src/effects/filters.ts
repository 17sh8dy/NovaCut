/**
 * The 30 built-in filters — finished *looks*, as opposed to the raw tools in `definitions.ts`.
 *
 * ## Why these are one shader and not thirty
 *
 * A film look is a grade: some exposure, some contrast, a curve on the blacks, a colour cast
 * pulled one way in the shadows and the other way in the highlights, maybe grain and a
 * vignette. Thirty looks are thirty sets of *numbers* through that same grade, not thirty
 * different programs. So every filter here renders through `filterGrade` and
 * differs only in its `constants` — which means adding the next hundred is adding data to this
 * array, with no shader work at all, and each one costs a single GPU pass.
 *
 * ## Why the numbers are `constants` and not `params`
 *
 * A filter exposes exactly one dial: **Intensity**, which cross-fades the grade against the
 * original. Everything else is what the look *is*. Putting `shadowTint` in `params` would seed
 * a dozen sliders into every instance and every saved project to express a value that never
 * changes, and would invite users to "adjust" Teal & Orange until it was no longer Teal &
 * Orange — at which point the preset has stopped being a preset. Users who want the underlying
 * dials already have them: the Color and Light tools are right next door, and stack on top.
 *
 * ## Every filter is a real effect
 *
 * These are registered into the same registry as everything else, so a filter keyframes,
 * stacks, undoes, renders in the photo editor and exports through the identical path. The only
 * thing the `filter` field changes is which shelf it appears on.
 */

import { packColor, registerEffect, type EffectDefinition, type FilterCategory } from './registry.js';

/**
 * The grade's shape. Every field is optional and defaults to neutral, so a look states only
 * what it actually does — which also makes the table below readable as a list of intentions.
 *
 * Ranges match the `colorAdjust` conventions so the numbers mean the same thing in both places:
 * exposure in stops, contrast/saturation/vibrance as −1..+n offsets, hue in degrees.
 */
interface Grade {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  vibrance?: number;
  temperature?: number;
  tint?: number;
  hue?: number;
  gamma?: number;
  /** Lifts the blacks toward grey — the single most recognisable "film" move. 0..1. */
  fade?: number;
  /** Split-toning: colours pushed into the dark and bright ends respectively. */
  shadowTint?: string;
  highlightTint?: string;
  /** How hard the split-tone is applied, 0..1. Ignored when neither tint is set. */
  toning?: number;
  /** Corner darkening, 0..1. */
  vignette?: number;
  /** Film grain, 0..1. */
  grain?: number;
}

const INTENSITY = {
  key: 'intensity',
  label: 'Intensity',
  min: 0,
  max: 1,
  default: 1,
  step: 0.01,
} as const;

/**
 * Build a filter definition from a grade.
 *
 * Colours are packed to floats here rather than in the shader's uniform list because that is
 * how every other colour in this codebase travels — see `packColor`. The uniform binder is
 * generic and stays that way.
 */
function filter(
  type: string,
  label: string,
  category: FilterCategory,
  grade: Grade,
): EffectDefinition {
  const constants: Record<string, number> = {};
  const put = (k: string, v: number | undefined, fallback = 0) => {
    constants[k] = v ?? fallback;
  };
  put('exposure', grade.exposure);
  put('contrast', grade.contrast);
  put('saturation', grade.saturation);
  put('vibrance', grade.vibrance);
  put('temperature', grade.temperature);
  put('tint', grade.tint);
  put('hue', grade.hue);
  put('gamma', grade.gamma);
  put('fade', grade.fade);
  put('toning', grade.toning, grade.shadowTint || grade.highlightTint ? 1 : 0);
  put('vignette', grade.vignette);
  put('grain', grade.grain);
  // Mid-grey is the no-op tint: the shader biases toward it, so an unset end does nothing.
  constants.shadowTint = packColor(grade.shadowTint ?? '#808080');
  constants.highlightTint = packColor(grade.highlightTint ?? '#808080');

  return {
    type,
    label,
    // Filters are colour work to the rest of the app — that is the category the photo editor's
    // adjustment picker and the effects browser file them under if they are ever shown there.
    category: 'color',
    render: 'filterGrade',
    params: [{ ...INTENSITY }],
    constants,
    filter: category,
  };
}

/**
 * The catalog: five per shelf, thirty in all.
 *
 * Evenly sized on purpose. An unevenly stocked browser teaches the user that some tabs are
 * worth opening and others aren't, and they stop looking in the thin ones.
 */
export const FILTERS: EffectDefinition[] = [
  // ── Basic: unglamorous fixes, the ones reached for on most clips ──
  filter('f-punch', 'Punch', 'basic', { contrast: 0.22, vibrance: 0.3, saturation: 0.05 }),
  filter('f-soft', 'Soft', 'basic', { contrast: -0.18, fade: 0.12, saturation: -0.05 }),
  filter('f-bright', 'Bright', 'basic', { exposure: 0.35, contrast: 0.06, vibrance: 0.12 }),
  filter('f-matte', 'Matte', 'basic', { fade: 0.3, contrast: 0.08, saturation: -0.08 }),
  filter('f-crisp', 'Crisp', 'basic', { contrast: 0.3, gamma: 0.08, vibrance: 0.18, vignette: 0.12 }),

  // ── Cinematic: the graded-feature looks ──
  filter('f-teal-orange', 'Teal & Orange', 'cinematic', {
    contrast: 0.18, saturation: 0.06,
    shadowTint: '#1d5f78', highlightTint: '#ffb37a', toning: 0.55,
    vignette: 0.18,
  }),
  filter('f-blockbuster', 'Blockbuster', 'cinematic', {
    contrast: 0.26, exposure: -0.08, vibrance: 0.2,
    shadowTint: '#12384f', highlightTint: '#ffd9b0', toning: 0.45,
    fade: 0.06, vignette: 0.24,
  }),
  filter('f-moonlight', 'Moonlight', 'cinematic', {
    exposure: -0.4, contrast: 0.1, saturation: -0.25, temperature: -0.35,
    shadowTint: '#2a3f7a', highlightTint: '#cfe2ff', toning: 0.5,
    vignette: 0.3,
  }),
  filter('f-desert', 'Desert', 'cinematic', {
    temperature: 0.3, contrast: 0.14, saturation: -0.1,
    shadowTint: '#6b4a2a', highlightTint: '#ffe6b8', toning: 0.4,
    fade: 0.1, grain: 0.08,
  }),
  filter('f-thriller', 'Thriller', 'cinematic', {
    contrast: 0.3, saturation: -0.2, tint: -0.12, exposure: -0.15,
    shadowTint: '#16302a', highlightTint: '#d8e8e0', toning: 0.5,
    vignette: 0.32,
  }),

  // ── Color: single-axis pushes, when a shot needs a nudge rather than a look ──
  filter('f-vivid', 'Vivid', 'color', { saturation: 0.35, vibrance: 0.25, contrast: 0.12 }),
  filter('f-warm', 'Warm', 'color', { temperature: 0.3, vibrance: 0.1 }),
  filter('f-cool', 'Cool', 'color', { temperature: -0.3, vibrance: 0.1 }),
  filter('f-pastel', 'Pastel', 'color', {
    saturation: -0.22, fade: 0.2, contrast: -0.1, exposure: 0.15,
    highlightTint: '#ffe9f2', toning: 0.35,
  }),
  filter('f-golden', 'Golden Hour', 'color', {
    temperature: 0.4, exposure: 0.15, vibrance: 0.2,
    highlightTint: '#ffc46b', toning: 0.45, vignette: 0.14,
  }),

  // ── Vintage: aged stock, each with the grain and lifted blacks that sell the age ──
  filter('f-sepia-look', 'Sepia', 'vintage', {
    saturation: -1, contrast: 0.1,
    shadowTint: '#3b2a1a', highlightTint: '#f0d9a8', toning: 0.85,
    grain: 0.1,
  }),
  filter('f-retro-70', 'Retro 70s', 'vintage', {
    temperature: 0.25, saturation: -0.1, fade: 0.26, contrast: 0.05,
    shadowTint: '#4a3520', highlightTint: '#ffcf8f', toning: 0.5,
    grain: 0.16, vignette: 0.2,
  }),
  filter('f-faded-film', 'Faded Film', 'vintage', {
    fade: 0.38, contrast: 0.14, saturation: -0.18,
    shadowTint: '#4a4a5e', highlightTint: '#f5efdc', toning: 0.4,
    grain: 0.14,
  }),
  filter('f-polaroid', 'Polaroid', 'vintage', {
    exposure: 0.12, fade: 0.22, saturation: -0.05, temperature: 0.15,
    shadowTint: '#3f4a52', highlightTint: '#fff2d8', toning: 0.45,
    vignette: 0.18, grain: 0.08,
  }),
  filter('f-super-8', 'Super 8', 'vintage', {
    temperature: 0.22, contrast: 0.2, fade: 0.18, saturation: -0.12,
    shadowTint: '#52341f', highlightTint: '#ffdca6', toning: 0.5,
    grain: 0.3, vignette: 0.3,
  }),

  // ── Creative: looks that are the point, not a correction ──
  filter('f-cyberpunk', 'Cyberpunk', 'creative', {
    contrast: 0.3, saturation: 0.3, exposure: -0.1,
    shadowTint: '#2b0f6b', highlightTint: '#00e5ff', toning: 0.7,
    vignette: 0.3,
  }),
  filter('f-dreamscape', 'Dreamscape', 'creative', {
    exposure: 0.2, contrast: -0.15, fade: 0.3, saturation: -0.1,
    shadowTint: '#6a5acd', highlightTint: '#ffd9f0', toning: 0.55,
  }),
  filter('f-infrared', 'Infrared', 'creative', {
    hue: 140, saturation: 0.4, contrast: 0.25,
    shadowTint: '#1a0b3d', highlightTint: '#ffd0e8', toning: 0.4,
  }),
  filter('f-toxic', 'Toxic', 'creative', {
    tint: -0.3, saturation: 0.28, contrast: 0.22,
    shadowTint: '#0f2a10', highlightTint: '#c8ff5e', toning: 0.6,
    vignette: 0.26,
  }),
  filter('f-neon-night', 'Neon Night', 'creative', {
    exposure: -0.25, contrast: 0.35, saturation: 0.35, temperature: -0.2,
    shadowTint: '#12043a', highlightTint: '#ff3ec8', toning: 0.6,
    vignette: 0.34,
  }),

  // ── Black & White: saturation floored, then toned. Toning is what stops mono reading flat ──
  filter('f-mono', 'Mono', 'bw', { saturation: -1, contrast: 0.1 }),
  filter('f-mono-contrast', 'High Contrast B&W', 'bw', {
    saturation: -1, contrast: 0.45, gamma: 0.1, vignette: 0.2,
  }),
  filter('f-silver', 'Silver Tone', 'bw', {
    saturation: -1, contrast: 0.2,
    shadowTint: '#2b3a4a', highlightTint: '#eaf2ff', toning: 0.4,
    grain: 0.1,
  }),
  filter('f-mono-warm', 'Warm Mono', 'bw', {
    saturation: -1, contrast: 0.15, fade: 0.14,
    shadowTint: '#3a2e22', highlightTint: '#fff4e2', toning: 0.35,
  }),
  filter('f-noir', 'Noir', 'bw', {
    saturation: -1, contrast: 0.55, exposure: -0.2, gamma: 0.16,
    vignette: 0.4, grain: 0.14,
  }),
];

let registered = false;

/** Register the built-in filters. Idempotent, like the other catalogs. */
export function registerFilters(): void {
  if (registered) return;
  registered = true;
  for (const f of FILTERS) registerEffect(f);
}
