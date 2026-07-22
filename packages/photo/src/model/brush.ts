/**
 * Brushes.
 *
 * A brush is a *description*, not a bitmap: a round stamp with a hardness falloff, laid down
 * repeatedly along a path. That is deliberately the narrow definition — no bristle simulation,
 * no texture nozzles, no dual brush — because the wide definition needs an authoring format
 * for brush tips, and every field of it would be a promise the renderer could not keep. What
 * IS here is the set of controls that change how a stroke *feels*, and every one of them has a
 * live path through `engine/src/photo/paintRaster.ts`.
 *
 * ## Opacity vs. flow, which is the one thing brushes get wrong
 *
 * They are not two names for the same slider:
 *
 *   **flow**    is how much paint each individual stamp deposits.
 *   **opacity** is the ceiling for the stroke as a WHOLE.
 *
 * A 20%-flow stroke builds up as it overlaps itself; a 20%-opacity stroke never gets darker
 * than 20% no matter how many times it crosses itself. Getting this right needs the stroke
 * rendered into its own scratch buffer at `flow` per stamp and then composited once at
 * `opacity` — which is exactly what the rasterizer does, and why it cannot just draw stamps
 * straight onto the layer.
 */

export type BrushKind = 'brush' | 'pencil' | 'eraser';

/** What pressure is allowed to modulate. Pointer events carry it for free on pen hardware. */
export interface BrushDynamics {
  size: boolean;
  opacity: boolean;
}

export interface BrushSettings {
  kind: BrushKind;
  /** Stamp diameter in canvas pixels. */
  size: number;
  /** 0 = fully soft falloff, 1 = a hard edge (still antialiased by one pixel). */
  hardness: number;
  /** 0..1 — the whole stroke's ceiling. See the header. */
  opacity: number;
  /** 0..1 — per-stamp deposit. See the header. */
  flow: number;
  /** Distance between stamps as a fraction of `size`. 0.05–0.25 reads as a continuous line. */
  spacing: number;
  /**
   * 0..1 — how strongly the input path is smoothed before stamping.
   *
   * Pointer input is jittery at speed and a raw polyline shows every wobble; this pulls the
   * stamp position toward the cursor rather than snapping to it, which is what makes a
   * hand-drawn arc read as a curve instead of a seismograph.
   */
  smoothing: number;
  dynamics: BrushDynamics;
  /** CSS colour. Ignored by the eraser, which removes coverage rather than adding any. */
  color: string;
}

export const DEFAULT_BRUSH: Readonly<BrushSettings> = Object.freeze({
  kind: 'brush' as BrushKind,
  size: 48,
  hardness: 0.6,
  opacity: 1,
  flow: 1,
  spacing: 0.08,
  smoothing: 0.45,
  dynamics: { size: true, opacity: false },
  color: '#ffffff',
});

export interface BrushPreset {
  id: string;
  label: string;
  settings: Omit<BrushSettings, 'color'>;
}

/**
 * A small, opinionated set that covers the actual jobs.
 *
 * Not fifty variations of round: a preset list is only useful if a user can hold all of it in
 * their head, and these six are genuinely different tools rather than different numbers.
 */
export const BRUSH_PRESETS: readonly BrushPreset[] = [
  {
    id: 'soft-round', label: 'Soft Round',
    settings: { kind: 'brush', size: 64, hardness: 0.0, opacity: 1, flow: 1, spacing: 0.05, smoothing: 0.5, dynamics: { size: true, opacity: false } },
  },
  {
    id: 'hard-round', label: 'Hard Round',
    settings: { kind: 'brush', size: 32, hardness: 1, opacity: 1, flow: 1, spacing: 0.06, smoothing: 0.4, dynamics: { size: true, opacity: false } },
  },
  {
    id: 'pencil', label: 'Pencil',
    // Pencil is aliased by definition — a hard 1px-ish edge with no falloff at all.
    settings: { kind: 'pencil', size: 6, hardness: 1, opacity: 1, flow: 1, spacing: 0.1, smoothing: 0.25, dynamics: { size: false, opacity: false } },
  },
  {
    id: 'marker', label: 'Marker',
    settings: { kind: 'brush', size: 40, hardness: 0.85, opacity: 0.85, flow: 1, spacing: 0.04, smoothing: 0.5, dynamics: { size: false, opacity: false } },
  },
  {
    id: 'airbrush', label: 'Airbrush',
    // Low flow + high opacity is the build-up brush: repeated passes darken toward full.
    settings: { kind: 'brush', size: 120, hardness: 0, opacity: 1, flow: 0.08, spacing: 0.03, smoothing: 0.6, dynamics: { size: false, opacity: true } },
  },
  {
    id: 'soft-eraser', label: 'Soft Eraser',
    settings: { kind: 'eraser', size: 80, hardness: 0.2, opacity: 1, flow: 1, spacing: 0.05, smoothing: 0.5, dynamics: { size: true, opacity: false } },
  },
];

/** Apply a preset, keeping the colour the user already chose. */
export const applyBrushPreset = (current: BrushSettings, preset: BrushPreset): BrushSettings => ({
  ...preset.settings,
  color: current.color,
});

/**
 * The stamp interval in pixels. Never zero — a zero interval is an infinite loop, and a stroke
 * that hangs the editor is a worse failure than a slightly gappy line.
 */
export const stampInterval = (brush: BrushSettings): number =>
  Math.max(0.5, brush.size * Math.max(0.01, brush.spacing));
