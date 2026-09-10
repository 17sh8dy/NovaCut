/**
 * Text presets for the video editor — the looks a creator actually reaches for, as plain data.
 *
 * This is the video counterpart of the photo editor's `TEXT_PRESETS`, and it exists for the same
 * reason: picking a look starts nearly every session and almost never involves a decision the
 * user cares about. Before this, the video presets set `fontSize` and `fontWeight` and nothing
 * else — six rows that all produced the same white text at different sizes, while `TextStyle`'s
 * stroke, shadow, glow, gradient and background fields sat unused.
 *
 * ## Why these font stacks and not the photo editor's
 *
 * The photo presets name Anton, Bebas Neue, Luckiest Guy and friends. Nova Cut loads **no
 * webfonts at all** — there is no `@font-face` anywhere and the renderer runs under a strict CSP
 * with no network — so every one of those silently falls back to the default sans, and a preset
 * called "Retro Pop" renders as plain Inter. A preset that does not look like its own name is
 * worse than no preset.
 *
 * So these use families Windows and macOS both actually ship (Impact, Arial Black, Georgia,
 * Trebuchet MS, Consolas/Menlo), each with a fallback chain that degrades to a similar shape
 * rather than to the default sans. The look is the point; the exact face is not.
 *
 * ## Partial, not complete
 *
 * `style` is a PARTIAL merged over the clip's current style, so applying a preset to text that
 * already exists keeps what the user chose deliberately — their size on a vertical sequence, say
 * — and changes only the look the preset is about. Where a preset must positively turn something
 * OFF (Clean Caption has no stroke) it says so with `undefined`, because a merge cannot express
 * absence any other way.
 */

import type { TextStyle } from './types.js';

export interface VideoTextPreset {
  id: string;
  label: string;
  /** Grouping for the browser panel. */
  group: 'Essentials' | 'Bold & Punchy' | 'Stylised';
  /** Seeded into the new clip so the preset reads as itself the moment it lands. */
  defaultContent: string;
  /** Short note under the label; kept to a few words. */
  hint?: string;
  style: Partial<TextStyle>;
}

// Stacks, not families: each falls back to something with a similar silhouette before it
// reaches the generic, so a machine missing the first choice still gets the intent.
const DISPLAY = 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif';
const HEAVY = '"Arial Black", "Segoe UI Black", Inter, system-ui, sans-serif';
const CLEAN = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const SERIF = 'Georgia, "Times New Roman", "Playfair Display", serif';
const ROUND = '"Trebuchet MS", Verdana, Tahoma, system-ui, sans-serif';
const MONO = 'Consolas, Menlo, "JetBrains Mono", ui-monospace, monospace';

export const VIDEO_TEXT_PRESETS: readonly VideoTextPreset[] = [
  // ── Essentials ──────────────────────────────────────────────────────────────
  {
    id: 'title',
    label: 'Title',
    group: 'Essentials',
    defaultContent: 'Title',
    hint: 'Clean and large',
    style: {
      fontFamily: CLEAN, fontSize: 120, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1,
      color: '#ffffff', shadow: { color: '#00000099', blur: 18, x: 0, y: 6 },
      stroke: undefined, glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    group: 'Essentials',
    defaultContent: 'Subtitle',
    style: {
      fontFamily: CLEAN, fontSize: 64, fontWeight: 600, letterSpacing: 0, lineHeight: 1.2,
      color: '#f3f4f6', shadow: { color: '#00000088', blur: 12, x: 0, y: 3 },
      stroke: undefined, glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'caption',
    label: 'Clean Caption',
    group: 'Essentials',
    defaultContent: 'Caption text',
    hint: 'Readable over anything',
    style: {
      fontFamily: CLEAN, fontSize: 46, fontWeight: 600, lineHeight: 1.25,
      color: '#ffffff', shadow: { color: '#000000b3', blur: 8, x: 0, y: 2 },
      stroke: undefined, glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'lower-third',
    label: 'Lower Third',
    group: 'Essentials',
    defaultContent: 'Name · Role',
    hint: 'Sits on a bar',
    style: {
      fontFamily: CLEAN, fontSize: 52, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1.15,
      color: '#ffffff', background: { color: '#0f1115e0', padding: 26, radius: 10 },
      shadow: { color: '#00000066', blur: 14, x: 0, y: 6 },
      stroke: undefined, glow: undefined, gradient: undefined,
    },
  },
  {
    id: 'chip',
    label: 'Badge',
    group: 'Essentials',
    defaultContent: 'NEW',
    hint: 'Pill background',
    style: {
      fontFamily: CLEAN, fontSize: 44, fontWeight: 800, letterSpacing: 2, lineHeight: 1,
      color: '#0f1115', background: { color: '#ffffff', padding: 22, radius: 999 },
      shadow: { color: '#00000055', blur: 16, x: 0, y: 6 },
      stroke: undefined, glow: undefined, gradient: undefined,
    },
  },

  // ── Bold & Punchy ───────────────────────────────────────────────────────────
  {
    id: 'thumbnail-punch',
    label: 'Thumbnail Punch',
    group: 'Bold & Punchy',
    defaultContent: 'INSANE',
    hint: 'Thick outline',
    style: {
      fontFamily: DISPLAY, fontSize: 150, fontWeight: 900, letterSpacing: 1, lineHeight: 0.95,
      color: '#ffffff', stroke: { color: '#000000', width: 12 },
      shadow: { color: '#000000b3', blur: 22, x: 0, y: 10 },
      glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'gold-hype',
    label: 'Gold Hype',
    group: 'Bold & Punchy',
    defaultContent: 'WINNER',
    hint: 'Gradient fill',
    style: {
      fontFamily: DISPLAY, fontSize: 140, fontWeight: 900, letterSpacing: 1, lineHeight: 0.95,
      color: '#ffe259', gradient: { from: '#ffe259', to: '#e8a021', angle: 90 },
      stroke: { color: '#3b1f00', width: 10 },
      shadow: { color: '#000000a6', blur: 18, x: 0, y: 8 },
      glow: undefined, background: undefined,
    },
  },
  {
    id: 'sticker',
    label: 'Sticker',
    group: 'Bold & Punchy',
    defaultContent: 'WOW!',
    hint: 'White keyline',
    style: {
      fontFamily: HEAVY, fontSize: 120, fontWeight: 900, letterSpacing: 1, lineHeight: 1,
      color: '#ff4d6d', stroke: { color: '#ffffff', width: 14 },
      shadow: { color: '#00000073', blur: 14, x: 0, y: 8 },
      glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'outline',
    label: 'Outline',
    group: 'Bold & Punchy',
    defaultContent: 'EMPTY',
    hint: 'Hollow letters',
    style: {
      fontFamily: HEAVY, fontSize: 130, fontWeight: 900, letterSpacing: 2, lineHeight: 1,
      // Fully transparent fill: the stroke IS the letterform here.
      color: '#00000000', stroke: { color: '#ffffff', width: 5 },
      shadow: { color: '#00000073', blur: 16, x: 0, y: 6 },
      glow: undefined, gradient: undefined, background: undefined,
    },
  },

  // ── Stylised ────────────────────────────────────────────────────────────────
  {
    id: 'neon',
    label: 'Neon',
    group: 'Stylised',
    defaultContent: 'LIVE',
    hint: 'Cyan glow',
    style: {
      fontFamily: ROUND, fontSize: 110, fontWeight: 700, letterSpacing: 6, lineHeight: 1.1,
      color: '#f5f9ff', glow: { color: '#31d7ff', radius: 26, intensity: 1 },
      stroke: { color: '#31d7ff', width: 2 },
      shadow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    group: 'Stylised',
    defaultContent: '> run',
    hint: 'Monospace glow',
    style: {
      fontFamily: MONO, fontSize: 64, fontWeight: 600, letterSpacing: 0, lineHeight: 1.3,
      color: '#4ade80', glow: { color: '#22c55e', radius: 14, intensity: 0.7 },
      background: { color: '#0a0f0ad9', padding: 24, radius: 8 },
      stroke: undefined, shadow: undefined, gradient: undefined,
    },
  },
  {
    id: 'elegant',
    label: 'Elegant',
    group: 'Stylised',
    defaultContent: 'Studio',
    hint: 'Serif italic',
    style: {
      fontFamily: SERIF, fontSize: 96, fontWeight: 500, italic: true, letterSpacing: 3,
      lineHeight: 1.2, color: '#f4efe6',
      shadow: { color: '#0000005e', blur: 14, x: 0, y: 4 },
      stroke: undefined, glow: undefined, gradient: undefined, background: undefined,
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    group: 'Stylised',
    defaultContent: 'DREAM',
    hint: 'Warm gradient',
    style: {
      fontFamily: HEAVY, fontSize: 130, fontWeight: 900, letterSpacing: 2, lineHeight: 1,
      color: '#ff6a3d', gradient: { from: '#ff9a3d', to: '#ff2e63', angle: 120 },
      shadow: { color: '#00000080', blur: 20, x: 0, y: 8 },
      stroke: undefined, glow: undefined, background: undefined,
    },
  },
];

/** Preset groups in display order, derived so adding a preset needs no second edit. */
export const VIDEO_TEXT_PRESET_GROUPS: readonly VideoTextPreset['group'][] = [
  ...new Set(VIDEO_TEXT_PRESETS.map((p) => p.group)),
];

export const findTextPreset = (id: string): VideoTextPreset | undefined =>
  VIDEO_TEXT_PRESETS.find((p) => p.id === id);
