/**
 * The Text Effects shelf: 25 finished treatments for a title.
 *
 * ## Why these are recipes and not a new kind of thing
 *
 * Almost everything a "text effect" needs — a glow, an outline, a drop shadow, a gradient
 * wash, chromatic fringing, a glitch — already exists in the effect registry and already runs
 * on text, because text is rasterized and pushed through the same effect chain as video. So a
 * text effect here is a NAMED RECIPE: one or more real `EffectInstance`s with tuned params,
 * applied to the clip.
 *
 * That decision is worth being explicit about, because the obvious alternative — a parallel
 * `TextEffectDefinition` with its own storage on `TextStyle` and its own render hook — would
 * have to re-earn everything the effect stack already provides. Applied as recipes, these
 * inherit stacking order, per-param keyframing, enable/disable toggles, the inspector's
 * generated sliders, undo/redo, project serialization and the export path on day one, and the
 * user can take any recipe apart and tune the individual effects afterwards. They are not a
 * special case anywhere in the pipeline; they are a good starting point.
 *
 * The cost of this choice is that a recipe is not reversible as a unit — once applied it is
 * just effects on the clip, and "remove Neon Sign" means removing the effects it added. That is
 * the same bargain every editor's preset browser makes, and it is the right one: a preset the
 * user cannot then edit is a dead end.
 */

import type { EffectInstance } from '../model/types.js';
import { constant } from '../model/types.js';
import { newEffectId } from '../model/ids.js';
import { getEffectDef, packColor } from './registry.js';

/** The shelves the Text Effects browser groups by. */
export type TextEffectGroup = 'Glow & Light' | 'Outline & Shadow' | 'Color' | 'Texture' | 'Broken';

export const TEXT_EFFECT_GROUPS: TextEffectGroup[] = [
  'Glow & Light',
  'Outline & Shadow',
  'Color',
  'Texture',
  'Broken',
];

/** One step of a recipe: an effect type plus the params that make it read the intended way. */
interface RecipeStep {
  type: string;
  params: Record<string, number>;
}

export interface TextEffectDefinition {
  id: string;
  label: string;
  group: TextEffectGroup;
  /** One line for the chip's tooltip — what the user is about to get. */
  hint: string;
  steps: RecipeStep[];
}

const c = packColor;

/**
 * The catalog.
 *
 * Params are tuned against the default 96px title on a 1080p sequence, which is the size the
 * text presets drop in at. Anything radius- or distance-based is therefore in the tens of
 * pixels, not the ones — a 2px glow on a 96px letterform is invisible, and "the effect does
 * nothing" is indistinguishable from "the effect is broken".
 */
export const TEXT_EFFECTS: TextEffectDefinition[] = [
  // ── Glow & Light ──
  { id: 'te-glow', label: 'Glow', group: 'Glow & Light', hint: 'Soft halo around the letters',
    steps: [{ type: 'glow', params: { threshold: 0.35, intensity: 1.1, radius: 18 } }] },
  { id: 'te-neon', label: 'Neon Sign', group: 'Glow & Light', hint: 'Bright tube with a coloured bloom',
    steps: [
      { type: 'outline', params: { width: 5, strength: 1, color: c('#00e5ff') } },
      { type: 'bloom', params: { threshold: 0.4, intensity: 1.6, radius: 42 } },
    ] },
  { id: 'te-bloom', label: 'Bloom', group: 'Glow & Light', hint: 'Overexposed highlight spill',
    steps: [{ type: 'bloom', params: { threshold: 0.55, intensity: 1.2, radius: 36 } }] },
  { id: 'te-dreamy', label: 'Dreamy', group: 'Glow & Light', hint: 'Soft-focus diffusion',
    steps: [{ type: 'dreamy', params: { amount: 0.55, radius: 26 } }] },
  { id: 'te-backlight', label: 'Backlight', group: 'Glow & Light', hint: 'Wide warm glow from behind',
    steps: [
      { type: 'glow', params: { threshold: 0.2, intensity: 1.4, radius: 46 } },
      { type: 'color-overlay', params: { color: c('#ffcf8f'), amount: 0.18 } },
    ] },

  // ── Outline & Shadow ──
  { id: 'te-outline', label: 'Outline', group: 'Outline & Shadow', hint: 'Clean keyline around the glyphs',
    steps: [{ type: 'outline', params: { width: 8, strength: 1, color: c('#ffffff') } }] },
  { id: 'te-bold-outline', label: 'Heavy Outline', group: 'Outline & Shadow', hint: 'Thick sticker-style border',
    steps: [{ type: 'outline', params: { width: 20, strength: 1, color: c('#000000') } }] },
  { id: 'te-drop-shadow', label: 'Drop Shadow', group: 'Outline & Shadow', hint: 'Offset shadow with soft falloff',
    steps: [{ type: 'drop-shadow', params: { distance: 22, angle: 315, softness: 14, strength: 0.65, color: c('#000000') } }] },
  { id: 'te-hard-shadow', label: 'Hard Shadow', group: 'Outline & Shadow', hint: 'Crisp offset with no blur',
    steps: [{ type: 'drop-shadow', params: { distance: 16, angle: 315, softness: 0.5, strength: 1, color: c('#000000') } }] },
  { id: 'te-long-shadow', label: 'Long Shadow', group: 'Outline & Shadow', hint: 'Flat shadow trailing off at 45°',
    // Three offset copies at rising distance approximate the continuous 45° wedge of a true
    // long shadow. A single copy reads as a plain drop shadow; the stack is what fills the gap.
    steps: [
      { type: 'drop-shadow', params: { distance: 60, angle: 315, softness: 0.5, strength: 0.35, color: c('#000000') } },
      { type: 'drop-shadow', params: { distance: 36, angle: 315, softness: 0.5, strength: 0.45, color: c('#000000') } },
      { type: 'drop-shadow', params: { distance: 14, angle: 315, softness: 0.5, strength: 0.6, color: c('#000000') } },
    ] },
  { id: 'te-emboss', label: 'Emboss', group: 'Outline & Shadow', hint: 'Raised, lit from the top left',
    steps: [
      { type: 'drop-shadow', params: { distance: 4, angle: 135, softness: 1, strength: 0.8, color: c('#ffffff') } },
      { type: 'drop-shadow', params: { distance: 4, angle: 315, softness: 1, strength: 0.8, color: c('#000000') } },
    ] },
  { id: 'te-glass', label: 'Glass', group: 'Outline & Shadow', hint: 'Thin bright edge over a soft shadow',
    steps: [
      { type: 'drop-shadow', params: { distance: 10, angle: 315, softness: 22, strength: 0.5, color: c('#000000') } },
      { type: 'outline', params: { width: 2.5, strength: 0.8, color: c('#ffffff') } },
    ] },

  // ── Color ──
  { id: 'te-gradient', label: 'Gradient', group: 'Color', hint: 'Two-stop wash across the letters',
    steps: [{ type: 'gradient-overlay', params: { color: c('#6d5efc'), color2: c('#31d7ff'), angle: 90, amount: 1 } }] },
  { id: 'te-sunset', label: 'Sunset', group: 'Color', hint: 'Warm orange-to-pink gradient',
    steps: [{ type: 'gradient-overlay', params: { color: c('#ff7a3d'), color2: c('#ff3ec8'), angle: 60, amount: 1 } }] },
  { id: 'te-gold', label: 'Gold', group: 'Color', hint: 'Metallic gold with a dark keyline',
    steps: [
      { type: 'gradient-overlay', params: { color: c('#8a5a12'), color2: c('#ffe9a8'), angle: 90, amount: 1 } },
      { type: 'outline', params: { width: 4, strength: 1, color: c('#4a2f08') } },
    ] },
  { id: 'te-chrome', label: 'Chrome', group: 'Color', hint: 'Cold metal with a bright rim',
    steps: [
      { type: 'gradient-overlay', params: { color: c('#3a4a5e'), color2: c('#eaf2ff'), angle: 90, amount: 1 } },
      { type: 'outline', params: { width: 3, strength: 1, color: c('#0d1420') } },
    ] },
  { id: 'te-duotone', label: 'Duotone', group: 'Color', hint: 'Two-colour mapping of the luminance',
    steps: [{ type: 'duotone', params: { color: c('#1b1464'), color2: c('#ff6a3d'), amount: 1 } }] },
  { id: 'te-tint', label: 'Solid Tint', group: 'Color', hint: 'Flat colour fill over the glyphs',
    steps: [{ type: 'color-overlay', params: { color: c('#6d5efc'), amount: 1 } }] },

  // ── Texture ──
  { id: 'te-blur', label: 'Blur', group: 'Texture', hint: 'Defocused, for depth behind a foreground',
    steps: [{ type: 'blur', params: { radius: 6 } }] },
  { id: 'te-grain', label: 'Film Grain', group: 'Texture', hint: 'Fine analogue noise over the fill',
    steps: [{ type: 'film-grain', params: { amount: 0.35, size: 1 } }] },
  { id: 'te-halftone', label: 'Halftone', group: 'Texture', hint: 'Print-style dot screen',
    steps: [{ type: 'halftone', params: { size: 6, angle: 25, amount: 1 } }] },
  { id: 'te-pixelate', label: 'Pixelate', group: 'Texture', hint: 'Chunky low-resolution blocks',
    steps: [{ type: 'pixelate', params: { size: 10 } }] },
  { id: 'te-posterize', label: 'Posterize', group: 'Texture', hint: 'Flattened into a few tone steps',
    steps: [{ type: 'posterize', params: { levels: 4 } }] },

  // ── Broken ──
  { id: 'te-chromatic', label: 'Chromatic Aberration', group: 'Broken', hint: 'Red/blue fringing on the edges',
    steps: [{ type: 'chromatic-aberration', params: { amount: 6, angle: 0 } }] },
  { id: 'te-glitch', label: 'Glitch', group: 'Broken', hint: 'Torn scanlines and colour tearing',
    steps: [{ type: 'glitch-fx', params: { amount: 0.55, speed: 1.4 } }] },
  { id: 'te-vhs', label: 'VHS', group: 'Broken', hint: 'Tape wobble and colour bleed',
    steps: [{ type: 'vhs', params: { amount: 0.6 } }] },
  { id: 'te-rgb-split', label: 'RGB Split', group: 'Broken', hint: 'Channels pulled apart vertically',
    steps: [{ type: 'rgb-split', params: { amount: 10, angle: 90 } }] },
  { id: 'te-shatter', label: 'Shatter', group: 'Broken', hint: 'Hard glitch with heavy fringing',
    steps: [
      { type: 'glitch-fx', params: { amount: 0.8, speed: 2.4 } },
      { type: 'chromatic-aberration', params: { amount: 12, angle: 45 } },
    ] },
];

export const getTextEffect = (id: string): TextEffectDefinition | undefined =>
  TEXT_EFFECTS.find((t) => t.id === id);

/**
 * Turn a recipe into live effect instances ready to append to a clip.
 *
 * Every param is seeded from the effect's own definition first and then overridden by the
 * recipe, so a recipe only has to state what it cares about — and a recipe that names a param
 * which has since been renamed degrades to that effect's default instead of binding an
 * undefined uniform. Steps naming an unregistered effect are skipped rather than throwing: one
 * stale entry should cost its own step, not the whole recipe.
 */
export function instantiateTextEffect(id: string): EffectInstance[] {
  const recipe = getTextEffect(id);
  if (!recipe) return [];
  const out: EffectInstance[] = [];
  for (const step of recipe.steps) {
    const def = getEffectDef(step.type);
    if (!def) continue;
    const params: Record<string, ReturnType<typeof constant>> = {};
    for (const p of def.params) params[p.key] = constant(step.params[p.key] ?? p.default);
    out.push({ id: newEffectId(), type: step.type, enabled: true, params });
  }
  return out;
}
