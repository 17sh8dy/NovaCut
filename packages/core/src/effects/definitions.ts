/**
 * Built-in effect & transition definitions. This is pure data — the catalog the whole app
 * reads from. Registering happens once at import time via `registerBuiltins()`.
 */

import {
  COLOR_PARAM_MAX,
  packColor,
  registerEffect,
  registerTransition,
  type EffectDefinition,
  type EffectParamDef,
  type TransitionDefinition,
} from './registry.js';
import { registerFilters } from './filters.js';
import { registerTextAnimations } from './textAnimations.js';

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit?: string) =>
  ({ key, label, min, max, default: def, step, ...(unit ? { unit } : {}) });

/**
 * A colour param.
 *
 * Colours ride the numeric param path packed into a single float (see `packColor`), so this is
 * an ordinary param carrying a `kind` the inspector reads. Nothing downstream — the animated
 * value sampler, the uniform binder, either serializer — needs to know it is a colour.
 */
const color = (key: string, label: string, hex: string): EffectParamDef =>
  ({ key, label, min: 0, max: COLOR_PARAM_MAX, default: packColor(hex), step: 1, kind: 'color' });

const EFFECTS: EffectDefinition[] = [
  // ── Blur family ──
  { type: 'blur', label: 'Gaussian Blur', category: 'blur', render: 'blur',
    params: [p('radius', 'Radius', 0, 100, 8, 0.5, 'px')] },
  { type: 'motion-blur', label: 'Motion Blur', category: 'blur', render: 'motionBlur',
    params: [p('amount', 'Amount', 0, 100, 20, 1), p('angle', 'Angle', 0, 360, 0, 1, '°')] },

  // ── Stylize ──
  { type: 'glow', label: 'Glow', category: 'stylize', render: 'glow',
    params: [p('threshold', 'Threshold', 0, 1, 0.6, 0.01), p('intensity', 'Intensity', 0, 3, 1, 0.05), p('radius', 'Radius', 0, 60, 12, 0.5, 'px')] },
  { type: 'sharpen', label: 'Sharpen', category: 'stylize', render: 'sharpen',
    params: [p('amount', 'Amount', 0, 4, 1, 0.05)] },
  { type: 'film-grain', label: 'Film Grain', category: 'stylize', render: 'grain',
    params: [p('amount', 'Amount', 0, 1, 0.25, 0.01), p('size', 'Size', 0.5, 4, 1, 0.1)] },
  { type: 'noise', label: 'Noise', category: 'stylize', render: 'noise',
    params: [p('amount', 'Amount', 0, 1, 0.15, 0.01)] },
  { type: 'pixelate', label: 'Pixelate', category: 'stylize', render: 'pixelate',
    params: [p('size', 'Cell Size', 1, 128, 12, 1, 'px')] },
  { type: 'vignette', label: 'Vignette', category: 'stylize', render: 'vignette',
    params: [p('amount', 'Amount', 0, 1, 0.4, 0.01), p('softness', 'Softness', 0, 1, 0.5, 0.01)] },
  { type: 'mirror', label: 'Mirror', category: 'stylize', render: 'mirror',
    params: [p('axis', 'Axis (0=X 1=Y)', 0, 1, 0, 1)] },
  { type: 'vintage', label: 'Vintage', category: 'stylize', render: 'vintage',
    params: [p('amount', 'Amount', 0, 1, 0.6, 0.01)] },
  { type: 'black-white', label: 'Black & White', category: 'stylize', render: 'blackWhite',
    params: [p('amount', 'Amount', 0, 1, 1, 0.01)] },

  // ── Color ──
  { type: 'brightness', label: 'Brightness', category: 'color', render: 'colorAdjust',
    params: [p('brightness', 'Brightness', -1, 1, 0, 0.01)] },
  { type: 'contrast', label: 'Contrast', category: 'color', render: 'colorAdjust',
    params: [p('contrast', 'Contrast', -1, 1, 0, 0.01)] },
  { type: 'exposure', label: 'Exposure', category: 'color', render: 'colorAdjust',
    params: [p('exposure', 'Exposure', -2, 2, 0, 0.01, 'EV')] },
  { type: 'saturation', label: 'Saturation', category: 'color', render: 'colorAdjust',
    params: [p('saturation', 'Saturation', -1, 2, 0, 0.01)] },
  { type: 'hue', label: 'Hue', category: 'color', render: 'colorAdjust',
    params: [p('hue', 'Hue Shift', -180, 180, 0, 1, '°')] },
  { type: 'tint', label: 'Tint', category: 'color', render: 'colorAdjust',
    params: [p('tint', 'Tint', -1, 1, 0, 0.01)] },
  { type: 'temperature', label: 'Temperature', category: 'color', render: 'colorAdjust',
    params: [p('temperature', 'Temperature', -1, 1, 0, 0.01)] },
  { type: 'color-shift', label: 'Color Shift', category: 'color', render: 'colorAdjust',
    params: [p('hue', 'Hue Shift', -180, 180, 30, 1, '°'), p('saturation', 'Saturation', -1, 2, 0.2, 0.01)] },
  { type: 'vibrance', label: 'Vibrance', category: 'color', render: 'colorAdjust',
    params: [p('vibrance', 'Vibrance', -1, 2, 0, 0.01)] },
  { type: 'white-balance', label: 'White Balance', category: 'color', render: 'colorAdjust',
    params: [p('temperature', 'Temperature', -1, 1, 0, 0.01), p('tint', 'Tint', -1, 1, 0, 0.01)] },
  {
    // The whole colour panel as one adjustment layer. Composing these in a single pass keeps
    // the result in float between steps — stacking them as separate layers quantises to 8 bits
    // at every hop, which is exactly where a gradient sky starts banding.
    type: 'color-mixer', label: 'Color', category: 'color', render: 'colorAdjust',
    params: [
      p('temperature', 'Temperature', -1, 1, 0, 0.01),
      p('tint', 'Tint', -1, 1, 0, 0.01),
      p('vibrance', 'Vibrance', -1, 2, 0, 0.01),
      p('saturation', 'Saturation', -1, 2, 0, 0.01),
      p('hue', 'Hue Shift', -180, 180, 0, 1, '°'),
    ],
  },

  // ── Light (tonal) ──
  { type: 'highlights', label: 'Highlights', category: 'light', render: 'colorAdjust',
    params: [p('highlights', 'Highlights', -1, 1, 0, 0.01)] },
  { type: 'shadows', label: 'Shadows', category: 'light', render: 'colorAdjust',
    params: [p('shadows', 'Shadows', -1, 1, 0, 0.01)] },
  { type: 'whites', label: 'Whites', category: 'light', render: 'colorAdjust',
    params: [p('whites', 'Whites', -1, 1, 0, 0.01)] },
  { type: 'blacks', label: 'Blacks', category: 'light', render: 'colorAdjust',
    params: [p('blacks', 'Blacks', -1, 1, 0, 0.01)] },
  { type: 'gamma', label: 'Gamma', category: 'light', render: 'colorAdjust',
    params: [p('gamma', 'Gamma', -1, 1, 0, 0.01)] },
  {
    type: 'light', label: 'Light', category: 'light', render: 'colorAdjust',
    params: [
      p('exposure', 'Exposure', -3, 3, 0, 0.01, 'EV'),
      p('contrast', 'Contrast', -1, 1, 0, 0.01),
      p('highlights', 'Highlights', -1, 1, 0, 0.01),
      p('shadows', 'Shadows', -1, 1, 0, 0.01),
      p('whites', 'Whites', -1, 1, 0, 0.01),
      p('blacks', 'Blacks', -1, 1, 0, 0.01),
      p('gamma', 'Gamma', -1, 1, 0, 0.01),
    ],
  },

  // ── Detail ──
  { type: 'clarity', label: 'Clarity', category: 'stylize', render: 'clarity',
    params: [p('amount', 'Amount', -1, 2, 0.4, 0.01), p('radius', 'Radius', 2, 60, 18, 1, 'px')] },
  { type: 'noise-reduction', label: 'Noise Reduction', category: 'blur', render: 'denoise',
    params: [p('amount', 'Amount', 0, 1, 0.5, 0.01), p('radius', 'Radius', 0.5, 6, 1.5, 0.1, 'px')] },

  // ── Layer styles ──
  { type: 'drop-shadow', label: 'Drop Shadow', category: 'style', render: 'dropShadow',
    params: [
      p('distance', 'Distance', 0, 200, 24, 1, 'px'),
      p('angle', 'Angle', 0, 360, 315, 1, '°'),
      p('softness', 'Softness', 0.5, 60, 12, 0.5, 'px'),
      p('strength', 'Opacity', 0, 1, 0.6, 0.01),
      color('color', 'Color', '#000000'),
    ] },
  { type: 'outline', label: 'Outline', category: 'style', render: 'outline',
    params: [
      p('width', 'Width', 0, 120, 14, 0.5, 'px'),
      p('strength', 'Opacity', 0, 1, 1, 0.01),
      color('color', 'Color', '#ffffff'),
    ] },
  { type: 'color-overlay', label: 'Color Overlay', category: 'style', render: 'colorOverlay',
    params: [color('color', 'Color', '#6d5efc'), p('amount', 'Amount', 0, 1, 1, 0.01)] },
  { type: 'gradient-overlay', label: 'Gradient Overlay', category: 'style', render: 'gradientOverlay',
    params: [
      color('color', 'From', '#6d5efc'),
      color('color2', 'To', '#31d7ff'),
      p('angle', 'Angle', 0, 360, 90, 1, '°'),
      p('amount', 'Amount', 0, 1, 1, 0.01),
    ] },
  { type: 'bloom', label: 'Bloom', category: 'style', render: 'bloom',
    params: [
      p('threshold', 'Threshold', 0, 1, 0.65, 0.01),
      p('intensity', 'Intensity', 0, 3, 0.9, 0.05),
      p('radius', 'Radius', 1, 120, 30, 1, 'px'),
    ] },

  // ── Stylize additions ──
  { type: 'duotone', label: 'Duotone', category: 'stylize', render: 'duotone',
    params: [
      color('color', 'Shadows', '#1b1464'),
      color('color2', 'Highlights', '#ff6a3d'),
      p('amount', 'Amount', 0, 1, 1, 0.01),
    ] },
  { type: 'posterize', label: 'Posterize', category: 'stylize', render: 'posterize',
    params: [p('levels', 'Levels', 2, 32, 6, 1)] },
  { type: 'threshold', label: 'Threshold', category: 'stylize', render: 'threshold',
    params: [p('level', 'Level', 0, 1, 0.5, 0.01), p('softness', 'Softness', 0.001, 0.3, 0.02, 0.001)] },
  { type: 'invert', label: 'Invert', category: 'stylize', render: 'invert',
    params: [p('amount', 'Amount', 0, 1, 1, 0.01)] },

  // ── Distort ──
  { type: 'chromatic-aberration', label: 'Chromatic Aberration', category: 'distort', render: 'chromatic',
    params: [p('amount', 'Amount', 0, 30, 4, 0.5, 'px'), p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'lens-distortion', label: 'Lens Distortion', category: 'distort', render: 'lensDistort',
    params: [p('k1', 'Distortion', -1, 1, 0.2, 0.01), p('scale', 'Scale', 0.5, 1.5, 1, 0.01)] },
  { type: 'shake', label: 'Camera Shake', category: 'distort', render: 'shake',
    params: [p('amount', 'Amount', 0, 200, 40, 1, 'px'), p('frequency', 'Frequency', 0.1, 30, 6, 0.1, 'Hz')] },
  { type: 'rgb-split', label: 'RGB Split', category: 'distort', render: 'chromatic',
    params: [p('amount', 'Amount', 0, 40, 8, 0.5, 'px'), p('angle', 'Angle', 0, 360, 90, 1, '°')] },

  // ── Camera & motion ──
  { type: 'radial-blur', label: 'Zoom Blur', category: 'blur', render: 'radialBlur',
    params: [
      p('amount', 'Amount', 0, 2, 0.6, 0.01),
      p('centerX', 'Centre X', 0, 1, 0.5, 0.01),
      p('centerY', 'Centre Y', 0, 1, 0.5, 0.01),
    ] },
  { type: 'pulse', label: 'Beat Pulse', category: 'distort', render: 'pulse',
    params: [p('amount', 'Amount', 0, 2, 0.7, 0.01), p('bpm', 'Tempo', 40, 220, 120, 1, 'BPM')] },

  // ── Looks ──
  { type: 'glitch-fx', label: 'Glitch', category: 'glitch', render: 'glitch',
    params: [p('amount', 'Amount', 0, 1, 0.5, 0.01), p('speed', 'Speed', 0.1, 4, 1, 0.05)] },
  { type: 'vhs', label: 'VHS', category: 'glitch', render: 'vhs',
    params: [p('amount', 'Amount', 0, 1, 0.6, 0.01)] },
  { type: 'old-film', label: 'Old Film', category: 'stylize', render: 'oldFilm',
    params: [p('amount', 'Amount', 0, 1, 0.6, 0.01), p('sepia', 'Sepia', 0, 1, 0.5, 0.01)] },
  { type: 'light-leak', label: 'Light Leak', category: 'stylize', render: 'lightLeak',
    params: [
      p('amount', 'Amount', 0, 2, 0.8, 0.01),
      p('angle', 'Angle', 0, 360, 20, 1, '°'),
      p('speed', 'Drift', 0, 4, 1, 0.05),
      color('color', 'Colour', '#ff9a3c'),
    ] },
  { type: 'dreamy', label: 'Dreamy Glow', category: 'stylize', render: 'dreamy',
    params: [p('amount', 'Amount', 0, 1, 0.5, 0.01), p('radius', 'Radius', 1, 80, 22, 1, 'px')] },
  { type: 'neon', label: 'Neon Edges', category: 'stylize', render: 'neon',
    params: [
      p('intensity', 'Intensity', 0, 4, 1.4, 0.05),
      p('darken', 'Darken', 0, 1, 0.75, 0.01),
      color('color', 'Colour', '#31d7ff'),
    ] },
  { type: 'halftone', label: 'Halftone', category: 'stylize', render: 'halftone',
    params: [
      p('size', 'Dot Size', 2, 40, 8, 1, 'px'),
      p('angle', 'Angle', 0, 90, 25, 1, '°'),
      p('amount', 'Amount', 0, 1, 1, 0.01),
    ] },
  { type: 'tilt-shift', label: 'Tilt Shift', category: 'blur', render: 'tiltShift',
    params: [
      p('focus', 'Focus', 0, 1, 0.5, 0.01),
      p('width', 'Band Width', 0.01, 0.5, 0.12, 0.01),
      p('amount', 'Amount', 0, 12, 5, 0.1),
    ] },
  { type: 'kaleidoscope', label: 'Kaleidoscope', category: 'distort', render: 'kaleidoscope',
    params: [p('segments', 'Segments', 2, 24, 6, 1), p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'prism', label: 'Prism', category: 'distort', render: 'prism',
    params: [p('amount', 'Amount', 0, 4, 1, 0.05)] },

  /**
   * The reveal mask behind every wipe / iris / blinds / dissolve text animation.
   *
   * `hidden`, because it is machinery rather than a look: on its own it is a control surface
   * with no meaning ("mode 2, progress 0.4"), and it only makes sense when an animation is
   * driving it frame by frame. It has to be a real registered effect so the animation lane can
   * ask for it by type and the chain can render it with no special case.
   *
   * The defaults are the identity — fully revealed — so that an instance created by hand (or
   * left behind in an old project) shows the text rather than hiding it.
   */
  { type: 'text-reveal', label: 'Reveal Mask', category: 'stylize', render: 'textReveal', hidden: true,
    params: [
      p('mode', 'Mode', 0, 3, 0, 1),
      p('progress', 'Progress', 0, 1, 1, 0.001),
      p('angle', 'Angle', 0, 360, 0, 1, '°'),
      p('softness', 'Softness', 0.001, 0.5, 0.08, 0.001),
      p('count', 'Bands', 2, 32, 8, 1),
    ] },
];

const TRANSITIONS: TransitionDefinition[] = [
  // ── Essentials ──
  { type: 'cross-dissolve', label: 'Cross Dissolve', render: 'dissolve', params: [] },
  { type: 'fade', label: 'Fade Through', render: 'fade',
    params: [p('color', 'Colour (0=black 1=white)', 0, 1, 0, 0.01)] },
  { type: 'wipe', label: 'Wipe', render: 'wipe',
    params: [p('angle', 'Angle', 0, 360, 0, 1, '°'), p('softness', 'Softness', 0.001, 0.4, 0.02, 0.001)] },
  { type: 'circle', label: 'Circle Reveal', render: 'circle',
    params: [p('softness', 'Softness', 0.001, 0.3, 0.02, 0.001)] },

  // ── Motion ──
  { type: 'slide', label: 'Slide', render: 'slide', params: [p('angle', 'Angle', 0, 360, 180, 1, '°')] },
  { type: 'push', label: 'Push', render: 'push', params: [p('angle', 'Angle', 0, 360, 180, 1, '°')] },
  { type: 'zoom', label: 'Zoom Punch', render: 'zoom', params: [p('scale', 'Scale', 1.1, 6, 2.4, 0.1, 'x')] },
  { type: 'spin', label: 'Spin', render: 'spin', params: [p('turns', 'Turns', 0.25, 4, 1, 0.25)] },
  { type: 'whip', label: 'Whip Pan', render: 'whip', params: [p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'shake', label: 'Impact Shake', render: 'shakeTransition',
    params: [p('amount', 'Amount', 0, 2, 0.8, 0.01)] },

  // ── Stylised ──
  { type: 'blur', label: 'Blur Dissolve', render: 'blurTransition', params: [p('amount', 'Amount', 0, 160, 60, 1)] },
  { type: 'flash', label: 'Flash', render: 'flash', params: [p('color', 'Colour (0=black 1=white)', 0, 1, 1, 0.01)] },
  { type: 'glitch', label: 'Glitch', render: 'glitchTransition', params: [p('intensity', 'Intensity', 0, 1, 0.7, 0.01)] },
  { type: 'burn', label: 'Luma Burn', render: 'burn', params: [p('softness', 'Softness', 0.02, 0.5, 0.14, 0.01)] },
  { type: 'pixelize', label: 'Pixelize', render: 'pixelize', params: [p('size', 'Block Size', 4, 120, 40, 1, 'px')] },

  // ── Dimensional ──
  { type: '3d-flip', label: '3D Flip', render: 'flip3d', params: [p('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 1)] },
  { type: 'cube', label: 'Cube', render: 'cube', params: [p('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 1)] },
  { type: 'page-turn', label: 'Page Turn', render: 'pageTurn', params: [] },
];

let registered = false;

/**
 * Register all built-ins. Idempotent so repeated imports are safe.
 *
 * The filter and text-animation catalogs live in their own files but register from here, so
 * there is exactly one call every entry point already makes and no way to end up with an app
 * that has effects but no filters.
 */
export function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  for (const e of EFFECTS) registerEffect(e);
  for (const t of TRANSITIONS) registerTransition(t);
  registerFilters();
  registerTextAnimations();
}
