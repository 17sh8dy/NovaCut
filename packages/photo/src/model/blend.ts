/**
 * Blend modes.
 *
 * The full Photoshop set, in Photoshop's own menu order and grouping — that order is not
 * cosmetic, it is the only thing that makes a 27-item dropdown navigable, so `BLEND_GROUPS`
 * below is the canonical listing and the UI renders it verbatim rather than re-sorting.
 *
 * This lives in the photo model rather than core on purpose. Core already declares an
 * 11-mode `Clip.blendMode` that the video compositor never reads — model-only fiction the
 * photo model exists to avoid repeating. Rather than widen that union and deepen the lie,
 * photo owns a mode set its own renderer honors in full (see the engine's blendShaders).
 * If the video compositor ever grows a real blend path, it should adopt THIS union.
 *
 * Every mode here has a GLSL implementation. Adding one means adding both, together.
 */

export type BlendMode =
  // Normal
  | 'normal'
  | 'dissolve'
  // Darken
  | 'darken'
  | 'multiply'
  | 'colorBurn'
  | 'linearBurn'
  | 'darkerColor'
  // Lighten
  | 'lighten'
  | 'screen'
  | 'colorDodge'
  | 'linearDodge'
  | 'lighterColor'
  // Contrast
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'vividLight'
  | 'linearLight'
  | 'pinLight'
  | 'hardMix'
  // Inversion / cancellation
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  // Component (non-separable)
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/**
 * Photoshop's menu grouping, with the separators it draws between families.
 * The UI maps over this; nothing else should hardcode a mode list.
 */
export const BLEND_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly modes: readonly BlendMode[];
}> = [
  { label: 'Normal', modes: ['normal', 'dissolve'] },
  { label: 'Darken', modes: ['darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor'] },
  { label: 'Lighten', modes: ['lighten', 'screen', 'colorDodge', 'linearDodge', 'lighterColor'] },
  {
    label: 'Contrast',
    modes: ['overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix'],
  },
  { label: 'Inversion', modes: ['difference', 'exclusion', 'subtract', 'divide'] },
  { label: 'Component', modes: ['hue', 'saturation', 'color', 'luminosity'] },
] as const;

/** Display names. Photoshop calls two of these something other than their key. */
export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  dissolve: 'Dissolve',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color Burn',
  linearBurn: 'Linear Burn',
  darkerColor: 'Darker Color',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color Dodge',
  linearDodge: 'Linear Dodge (Add)',
  lighterColor: 'Lighter Color',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  hardLight: 'Hard Light',
  vividLight: 'Vivid Light',
  linearLight: 'Linear Light',
  pinLight: 'Pin Light',
  hardMix: 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

/** Every mode, flat, in menu order. Derived so it can never drift from BLEND_GROUPS. */
export const BLEND_MODES: readonly BlendMode[] = BLEND_GROUPS.flatMap((g) => g.modes);

const BLEND_SET = new Set<string>(BLEND_MODES);

/**
 * Narrow an untrusted string (a v1 document, a plugin, a hand-edited file) to a BlendMode,
 * falling back to 'normal'. The serializer runs everything loaded from disk through this:
 * an unknown mode must degrade to a visible layer, never crash the renderer's mode switch.
 */
export const asBlendMode = (value: unknown): BlendMode =>
  typeof value === 'string' && BLEND_SET.has(value) ? (value as BlendMode) : 'normal';
