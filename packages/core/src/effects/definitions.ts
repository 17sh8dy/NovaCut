/**
 * Built-in effect & transition definitions. This is pure data — the catalog the whole app
 * reads from. Registering happens once at import time via `registerBuiltins()`.
 */

import { registerEffect, registerTransition, type EffectDefinition, type TransitionDefinition } from './registry.js';

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit?: string) =>
  ({ key, label, min, max, default: def, step, ...(unit ? { unit } : {}) });

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

  // ── Distort ──
  { type: 'chromatic-aberration', label: 'Chromatic Aberration', category: 'distort', render: 'chromatic',
    params: [p('amount', 'Amount', 0, 30, 4, 0.5, 'px'), p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'lens-distortion', label: 'Lens Distortion', category: 'distort', render: 'lensDistort',
    params: [p('k1', 'Distortion', -1, 1, 0.2, 0.01), p('scale', 'Scale', 0.5, 1.5, 1, 0.01)] },
  { type: 'shake', label: 'Shake', category: 'distort', render: 'passthrough',
    params: [p('amount', 'Amount', 0, 100, 10, 1, 'px'), p('frequency', 'Frequency', 0.1, 30, 8, 0.1, 'Hz')] },
  { type: 'rgb-split', label: 'RGB Split', category: 'distort', render: 'chromatic',
    params: [p('amount', 'Amount', 0, 40, 8, 0.5, 'px'), p('angle', 'Angle', 0, 360, 90, 1, '°')] },

  // ── Time ──
  { type: 'speed-ramp', label: 'Speed Ramp', category: 'time', render: 'passthrough',
    params: [p('start', 'Start Rate', 0.1, 8, 1, 0.05, 'x'), p('end', 'End Rate', 0.1, 8, 2, 0.05, 'x')] },
];

const TRANSITIONS: TransitionDefinition[] = [
  { type: 'fade', label: 'Fade', render: 'fade', params: [] },
  { type: 'cross-dissolve', label: 'Cross Dissolve', render: 'dissolve', params: [] },
  { type: 'slide', label: 'Slide', render: 'slide', params: [p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'push', label: 'Push', render: 'push', params: [p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'zoom', label: 'Zoom', render: 'zoom', params: [p('scale', 'Scale', 1, 4, 2, 0.1, 'x')] },
  { type: 'spin', label: 'Spin', render: 'spin', params: [p('turns', 'Turns', 0.25, 4, 1, 0.25)] },
  { type: 'blur', label: 'Blur', render: 'blurTransition', params: [p('amount', 'Amount', 0, 100, 40, 1)] },
  { type: 'flash', label: 'Flash', render: 'flash', params: [p('color', 'Color (0=black 1=white)', 0, 1, 1, 1)] },
  { type: 'whip', label: 'Whip Pan', render: 'whip', params: [p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'glitch', label: 'Glitch', render: 'glitchTransition', params: [p('intensity', 'Intensity', 0, 1, 0.6, 0.01)] },
  { type: '3d-flip', label: '3D Flip', render: 'flip3d', params: [p('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 1)] },
  { type: 'cube', label: 'Cube', render: 'cube', params: [p('axis', 'Axis (0=X 1=Y)', 0, 1, 1, 1)] },
  { type: 'page-turn', label: 'Page Turn', render: 'pageTurn', params: [] },
];

let registered = false;

/** Register all built-ins. Idempotent so repeated imports are safe. */
export function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  for (const e of EFFECTS) registerEffect(e);
  for (const t of TRANSITIONS) registerTransition(t);
}
