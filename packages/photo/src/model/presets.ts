/**
 * Presets — the creator toolkit's data layer.
 *
 * Canvas sizes, text looks and shape looks, as plain data. This is the highest
 * time-saved-per-line file in the photo editor: a creator who picks "YouTube Thumbnail" and a
 * text preset has skipped the two steps that otherwise start every session, and neither step
 * involved a decision they cared about.
 *
 * Everything is data, not code, for a reason: presets are the obvious first thing a user will
 * want to add their own of, and a preset that is a function is a preset that can never be
 * serialized into a user's library.
 */

import { SOLID, type Fill, type Glow, type Shadow, type Stroke } from './paint.js';
import type { ShapeKind, ShapeParams } from './shapes.js';
import type { TextStyle } from './text.js';

// ─────────────────────────────────────────────────────────────────────────────
// Canvas presets
// ─────────────────────────────────────────────────────────────────────────────

export interface CanvasPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Grouping for the picker. */
  group: string;
  /** Shown under the label; kept short. */
  hint?: string;
}

/**
 * Sizes as the platforms actually publish them, in 2026.
 *
 * Where a platform accepts a range, this takes the one that survives their re-encode best —
 * 1280×720 for a YouTube thumbnail rather than 1920×1080, because YouTube downscales to 1280
 * anyway and the smaller file clears the 2 MB limit with quality to spare.
 */
export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: 'yt-thumb', label: 'YouTube Thumbnail', width: 1280, height: 720, group: 'YouTube', hint: '16:9 · under 2 MB' },
  { id: 'yt-banner', label: 'YouTube Banner', width: 2560, height: 1440, group: 'YouTube', hint: 'safe area 1546×423' },
  { id: 'yt-short', label: 'Shorts Cover', width: 1080, height: 1920, group: 'YouTube', hint: '9:16' },
  { id: 'yt-avatar', label: 'Channel Avatar', width: 800, height: 800, group: 'YouTube' },

  { id: 'ig-square', label: 'Instagram Post', width: 1080, height: 1080, group: 'Instagram', hint: '1:1' },
  { id: 'ig-portrait', label: 'Instagram Portrait', width: 1080, height: 1350, group: 'Instagram', hint: '4:5' },
  { id: 'ig-story', label: 'Instagram Story', width: 1080, height: 1920, group: 'Instagram', hint: '9:16' },

  { id: 'tiktok', label: 'TikTok Video Cover', width: 1080, height: 1920, group: 'Social', hint: '9:16' },
  { id: 'x-post', label: 'X Post', width: 1600, height: 900, group: 'Social', hint: '16:9' },
  { id: 'x-header', label: 'X Header', width: 1500, height: 500, group: 'Social', hint: '3:1' },
  { id: 'discord-banner', label: 'Discord Banner', width: 960, height: 540, group: 'Social' },
  { id: 'twitch-thumb', label: 'Twitch Thumbnail', width: 1280, height: 720, group: 'Social' },
  { id: 'linkedin', label: 'LinkedIn Post', width: 1200, height: 627, group: 'Social' },

  { id: 'wall-1080', label: 'Wallpaper 1080p', width: 1920, height: 1080, group: 'Wallpaper' },
  { id: 'wall-1440', label: 'Wallpaper 1440p', width: 2560, height: 1440, group: 'Wallpaper' },
  { id: 'wall-4k', label: 'Wallpaper 4K', width: 3840, height: 2160, group: 'Wallpaper' },
  { id: 'wall-ultrawide', label: 'Ultrawide', width: 3440, height: 1440, group: 'Wallpaper', hint: '21:9' },
  { id: 'phone', label: 'Phone Wallpaper', width: 1290, height: 2796, group: 'Wallpaper' },

  { id: 'slide-16-9', label: 'Presentation', width: 1920, height: 1080, group: 'Print & Docs', hint: '16:9' },
  { id: 'a4-150', label: 'A4 @ 150 DPI', width: 1240, height: 1754, group: 'Print & Docs' },
  { id: 'a4-300', label: 'A4 @ 300 DPI', width: 2480, height: 3508, group: 'Print & Docs' },
  { id: 'letter-300', label: 'US Letter @ 300 DPI', width: 2550, height: 3300, group: 'Print & Docs' },
];

/** Preset groups in display order, derived so a new preset needs no second edit. */
export const CANVAS_PRESET_GROUPS: readonly string[] = [
  ...new Set(CANVAS_PRESETS.map((p) => p.group)),
];

export const findCanvasPreset = (id: string): CanvasPreset | undefined =>
  CANVAS_PRESETS.find((p) => p.id === id);

// ─────────────────────────────────────────────────────────────────────────────
// Text presets
// ─────────────────────────────────────────────────────────────────────────────

export interface TextPreset {
  id: string;
  label: string;
  /**
   * A PARTIAL style, merged over the current default.
   *
   * Partial rather than complete so applying a preset to existing text keeps what the user
   * chose deliberately — their font size on a big canvas, say — and changes only the look the
   * preset is actually about. A complete style would silently reset those every time.
   */
  style: Partial<TextStyle>;
  /** Sample word for the swatch, so the picker previews the look rather than naming it. */
  sample?: string;
}

const stroke = (width: number, color: string): Stroke => ({ width, color, align: 'outside', join: 'round' });
const shadow = (blur: number, offsetY: number, opacity = 0.6, color = '#000000'): Shadow =>
  ({ color, blur, offsetX: 0, offsetY, opacity });
const glow = (color: string, blur = 30, intensity = 1): Glow => ({ color, blur, intensity });
const gradient = (a: string, b: string, angle = 90): Fill =>
  ({ kind: 'linear', angle, stops: [{ offset: 0, color: a }, { offset: 1, color: b }] });

export const TEXT_PRESETS: readonly TextPreset[] = [
  {
    id: 'thumbnail-punch',
    label: 'Thumbnail Punch',
    sample: 'INSANE',
    style: {
      fontFamily: 'Anton', fontWeight: 900, transform: 'uppercase', lineHeight: 0.95,
      fill: SOLID('#ffffff'), stroke: stroke(14, '#000000'), shadow: shadow(24, 10, 0.7),
    },
  },
  {
    id: 'gold-hype',
    label: 'Gold Hype',
    sample: 'WINNER',
    style: {
      fontFamily: 'Anton', fontWeight: 900, transform: 'uppercase', lineHeight: 0.95,
      fill: gradient('#ffe259', '#e8a021'), stroke: stroke(12, '#3b1f00'), shadow: shadow(20, 8, 0.65),
    },
  },
  {
    id: 'neon',
    label: 'Neon',
    sample: 'live',
    style: {
      fontFamily: 'Bebas Neue', fontWeight: 700, transform: 'uppercase', letterSpacing: 2,
      fill: SOLID('#f5f9ff'), glow: glow('#31d7ff', 34, 1), stroke: stroke(3, '#31d7ff'),
    },
  },
  {
    id: 'clean-caption',
    label: 'Clean Caption',
    sample: 'Subtitle',
    style: {
      fontFamily: 'Inter', fontWeight: 600, lineHeight: 1.25,
      fill: SOLID('#ffffff'), shadow: shadow(10, 2, 0.5), stroke: null, glow: null,
    },
  },
  {
    id: 'outline-only',
    label: 'Outline',
    sample: 'EMPTY',
    style: {
      fontFamily: 'Archivo Black', fontWeight: 900, transform: 'uppercase',
      fill: SOLID('#00000000'), stroke: { width: 6, color: '#ffffff', align: 'center', join: 'round' },
    },
  },
  {
    id: 'sticker',
    label: 'Sticker',
    sample: 'NEW!',
    style: {
      fontFamily: 'Luckiest Guy', fontWeight: 400, transform: 'uppercase', letterSpacing: 1,
      fill: SOLID('#ff4d6d'), stroke: stroke(16, '#ffffff'), shadow: shadow(14, 6, 0.45),
    },
  },
  {
    id: 'elegant',
    label: 'Elegant',
    sample: 'Studio',
    style: {
      fontFamily: 'Playfair Display', fontWeight: 500, italic: true, letterSpacing: 1,
      lineHeight: 1.2, fill: SOLID('#f4efe6'), stroke: null, shadow: shadow(12, 3, 0.35),
    },
  },
  {
    id: 'retro-pop',
    label: 'Retro Pop',
    sample: 'GROOVY',
    style: {
      fontFamily: 'Bungee', fontWeight: 400, transform: 'uppercase', skew: -8,
      fill: gradient('#ff6a3d', '#ff2e63', 60), stroke: stroke(10, '#1a1423'), shadow: shadow(0, 12, 1, '#1a1423'),
    },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    sample: '> run',
    style: {
      fontFamily: 'JetBrains Mono', fontWeight: 600, letterSpacing: 0,
      fill: SOLID('#4ade80'), glow: glow('#22c55e', 18, 0.7), stroke: null, shadow: null,
    },
  },
  {
    id: 'curved-badge',
    label: 'Curved Badge',
    sample: 'ARCED',
    style: {
      fontFamily: 'Oswald', fontWeight: 700, transform: 'uppercase', letterSpacing: 4,
      curve: 42, fill: SOLID('#ffffff'), stroke: stroke(8, '#111827'),
    },
  },

  /*
   * ── Second wave ──
   *
   * The photo editor is where text gets fussed over — it has the layer stack, the curve and skew
   * controls and no timeline to fight for room — so it carries a deliberately wider set than the
   * video side's, rather than the two lists mirroring each other.
   *
   * These lean on families Windows and macOS actually ship (Impact, Arial Black, Georgia,
   * Trebuchet MS, Consolas, Comic Sans MS, Segoe Script). Open Cut bundles no webfonts and runs
   * under a CSP with no network, so a preset naming a Google font renders as the default sans —
   * a look that is not its own name. The distinctiveness here comes from the paint (gradient,
   * stroke, glow, offset shadow, skew, curve), which always renders as specified.
   */
  {
    id: 'hard-shadow',
    label: 'Hard Shadow',
    sample: 'POP',
    style: {
      fontFamily: 'Arial Black', fontWeight: 900, transform: 'uppercase', lineHeight: 1,
      // blur 0 — a crisp offset block, not a soft drop. This is the look, not a cheap shadow.
      fill: SOLID('#ffffff'), stroke: stroke(6, '#111827'),
      shadow: { color: '#ff2e63', blur: 0, offsetX: 8, offsetY: 8, opacity: 1 },
      glow: null,
    },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    sample: 'STEEL',
    style: {
      fontFamily: 'Impact', fontWeight: 900, transform: 'uppercase', letterSpacing: 1,
      fill: gradient('#f8fafc', '#64748b', 90), stroke: stroke(7, '#0f172a'),
      shadow: shadow(10, 4, 0.5), glow: null,
    },
  },
  {
    id: 'fire',
    label: 'Fire',
    sample: 'HOT',
    style: {
      fontFamily: 'Impact', fontWeight: 900, transform: 'uppercase', lineHeight: 0.95,
      fill: gradient('#fde047', '#dc2626', 90), stroke: stroke(9, '#450a0a'),
      glow: glow('#f97316', 26, 0.75), shadow: shadow(16, 6, 0.5),
    },
  },
  {
    id: 'frost',
    label: 'Frost',
    sample: 'CHILL',
    style: {
      fontFamily: 'Impact', fontWeight: 800, transform: 'uppercase', letterSpacing: 2,
      fill: gradient('#ffffff', '#7dd3fc', 90), stroke: stroke(5, '#0c4a6e'),
      glow: glow('#38bdf8', 30, 0.8), shadow: null,
    },
  },
  {
    id: 'extrude-3d',
    label: '3D Extrude',
    sample: 'DEPTH',
    style: {
      fontFamily: 'Arial Black', fontWeight: 900, transform: 'uppercase', lineHeight: 1,
      // A long, unblurred, fully opaque offset reads as an extruded side wall. One shadow is all
      // the model has, so this fakes the depth rather than stacking copies of the layer.
      fill: SOLID('#facc15'), stroke: stroke(5, '#1c1917'),
      shadow: { color: '#1c1917', blur: 0, offsetX: 0, offsetY: 14, opacity: 1 },
      glow: null,
    },
  },
  {
    id: 'vintage',
    label: 'Vintage',
    sample: 'Classic',
    style: {
      fontFamily: 'Georgia', fontWeight: 700, transform: 'uppercase', letterSpacing: 6,
      lineHeight: 1.3, fill: SOLID('#f5e6c8'), stroke: null, shadow: shadow(8, 3, 0.4), glow: null,
    },
  },
  {
    id: 'magazine',
    label: 'Magazine',
    sample: 'ISSUE',
    style: {
      fontFamily: 'Times New Roman', fontWeight: 700, transform: 'uppercase', letterSpacing: -2,
      lineHeight: 0.9, fill: SOLID('#ffffff'), stroke: null, shadow: shadow(14, 4, 0.35), glow: null,
    },
  },
  {
    id: 'handwritten',
    label: 'Handwritten',
    sample: 'note',
    style: {
      fontFamily: 'Segoe Script', fontWeight: 400, italic: true, transform: 'none',
      letterSpacing: 0, lineHeight: 1.35, fill: SOLID('#fdfdfd'),
      stroke: null, shadow: shadow(10, 3, 0.45), glow: null,
    },
  },
  {
    id: 'comic',
    label: 'Comic',
    sample: 'BAM!',
    style: {
      fontFamily: 'Comic Sans MS', fontWeight: 700, transform: 'uppercase', skew: -6,
      fill: SOLID('#ffd400'), stroke: stroke(12, '#1a1423'), shadow: shadow(0, 8, 1, '#1a1423'),
      glow: null,
    },
  },
  {
    id: 'minimal-caps',
    label: 'Minimal Caps',
    sample: 'MINIMAL',
    style: {
      fontFamily: 'Inter', fontWeight: 300, transform: 'uppercase', letterSpacing: 12,
      lineHeight: 1.4, fill: SOLID('#ffffff'), stroke: null, shadow: null, glow: null,
    },
  },
  {
    id: 'pastel-soft',
    label: 'Soft Pastel',
    sample: 'sweet',
    style: {
      fontFamily: 'Trebuchet MS', fontWeight: 700, transform: 'none', letterSpacing: 1,
      lineHeight: 1.2, fill: gradient('#fbc2eb', '#a6c1ee', 60),
      stroke: stroke(6, '#ffffff'), shadow: shadow(14, 5, 0.25), glow: null,
    },
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    sample: 'PLAN',
    style: {
      fontFamily: 'Consolas', fontWeight: 400, transform: 'uppercase', letterSpacing: 8,
      // Hollow, like a drafting stencil: transparent fill with a centred hairline around it.
      fill: SOLID('#00000000'),
      stroke: { width: 3, color: '#7dd3fc', align: 'center', join: 'miter' },
      glow: glow('#38bdf8', 16, 0.5), shadow: null,
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shape presets — the "quick assets" of the creator toolkit
// ─────────────────────────────────────────────────────────────────────────────

export interface ShapePreset {
  id: string;
  label: string;
  kind: ShapeKind;
  width: number;
  height: number;
  fill: Fill;
  stroke: Stroke | null;
  shadow: Shadow | null;
  glow: Glow | null;
  params?: Partial<ShapeParams>;
}

/**
 * Sizes are for a 1280×720 thumbnail and scale with the canvas at insert time, so a red arrow
 * lands looking like a red arrow on a 4K wallpaper instead of a speck.
 */
export const SHAPE_PRESETS: readonly ShapePreset[] = [
  {
    id: 'red-arrow', label: 'Red Arrow', kind: 'arrow', width: 420, height: 200,
    fill: SOLID('#ff2d2d'), stroke: stroke(10, '#ffffff'), shadow: shadow(18, 8, 0.5), glow: null,
  },
  {
    id: 'highlight-circle', label: 'Highlight Circle', kind: 'ellipse', width: 340, height: 340,
    fill: SOLID('#00000000'), stroke: { width: 14, color: '#ff2d2d', align: 'center', join: 'round' },
    shadow: shadow(14, 4, 0.4), glow: null,
  },
  {
    id: 'highlight-box', label: 'Highlight Box', kind: 'rounded-rectangle', width: 460, height: 260,
    fill: SOLID('#00000000'), stroke: { width: 12, color: '#ffe259', align: 'center', join: 'round' },
    shadow: null, glow: glow('#ffe259', 22, 0.8), params: { cornerRadius: 18 },
  },
  {
    id: 'label-chip', label: 'Label Chip', kind: 'rounded-rectangle', width: 380, height: 120,
    fill: gradient('#6d5efc', '#a855f7'), stroke: null, shadow: shadow(20, 8, 0.5), glow: null,
    params: { cornerRadius: 60 },
  },
  {
    id: 'scrim', label: 'Bottom Scrim', kind: 'rectangle', width: 1280, height: 320,
    fill: { kind: 'linear', angle: 90, stops: [{ offset: 0, color: '#00000000' }, { offset: 1, color: '#000000d9' }] },
    stroke: null, shadow: null, glow: null,
  },
  {
    id: 'burst', label: 'Burst', kind: 'star', width: 320, height: 320,
    fill: SOLID('#ffd60a'), stroke: stroke(8, '#1a1423'), shadow: shadow(16, 6, 0.45), glow: null,
    params: { points: 12, innerRatio: 0.72 },
  },
  {
    id: 'star', label: 'Star', kind: 'star', width: 260, height: 260,
    fill: SOLID('#ffd60a'), stroke: stroke(8, '#ffffff'), shadow: shadow(14, 5, 0.4), glow: null,
    params: { points: 5, innerRatio: 0.44 },
  },
  {
    id: 'speech', label: 'Speech Bubble', kind: 'speech-bubble', width: 420, height: 240,
    fill: SOLID('#ffffff'), stroke: stroke(8, '#111827'), shadow: shadow(18, 8, 0.4), glow: null,
    params: { cornerRadius: 36 },
  },
  {
    id: 'callout', label: 'Callout', kind: 'callout', width: 420, height: 220,
    fill: SOLID('#111827'), stroke: stroke(6, '#6d5efc'), shadow: shadow(20, 8, 0.5), glow: null,
    params: { cornerRadius: 16 },
  },
  {
    id: 'underline', label: 'Underline', kind: 'rounded-rectangle', width: 460, height: 26,
    fill: SOLID('#31d7ff'), stroke: null, shadow: null, glow: glow('#31d7ff', 18, 0.8),
    params: { cornerRadius: 13 },
  },
  {
    id: 'divider', label: 'Divider Line', kind: 'line', width: 520, height: 20,
    fill: SOLID('#00000000'), stroke: { width: 6, color: '#ffffff', align: 'center', join: 'round' },
    shadow: null, glow: null,
  },
  {
    id: 'chevron', label: 'Chevron', kind: 'chevron', width: 200, height: 260,
    fill: SOLID('#ffffff'), stroke: null, shadow: shadow(12, 4, 0.4), glow: null, params: { thickness: 0.28 },
  },
];

/**
 * Emoji offered as one-click stickers.
 *
 * Emoji rather than bundled artwork on purpose: every platform ships a full colour emoji font,
 * so these render identically to how the audience will see them elsewhere, cost zero bytes,
 * and never go stale. They are inserted as ordinary text layers — which means every text
 * control (stroke, shadow, glow, curve) works on them for free.
 */
export const STICKER_EMOJI: readonly string[] = [
  '🔥', '💯', '😱', '😭', '🤯', '😂', '😍', '🤔', '👀', '👇', '👉', '👍',
  '❤️', '💥', '⚡', '⭐', '✅', '❌', '⚠️', '💰', '🎯', '🏆', '🎁', '🚀',
  '🎮', '🎬', '🎵', '📈', '📉', '🔒', '🔔', '💡', '🧠', '💀', '👑', '🌟',
];
