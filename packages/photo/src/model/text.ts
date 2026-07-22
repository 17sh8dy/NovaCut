/**
 * Text styling.
 *
 * Text is the feature creators use hardest — a thumbnail is usually one image and three words
 * — so this models what a thumbnail actually needs (heavy strokes, hard shadows, glow, gradient
 * fills, curved baselines) rather than a word processor's feature list. There is no tab stop
 * here and no hyphenation dictionary; there is a stroke, because every YouTube thumbnail on
 * earth has one.
 *
 * A style is FLAT and per-layer, not a cascade of character runs. Rich per-character styling
 * is a real feature and a much bigger one: it needs a run model, a selection model inside the
 * text, and an editor that can express both. Declaring `runs: []` today and rendering only
 * `runs[0]` is precisely the model-fiction `types.ts` exists to prevent — so the flat style
 * ships now, and named CHARACTER PRESETS (see `presets.ts`) cover the actual workflow of
 * "make this line look like that one" until runs land.
 */

import { DEFAULT_FILL, DEFAULT_GLOW, DEFAULT_SHADOW, DEFAULT_STROKE, type Fill, type Glow, type Shadow, type Stroke } from './paint.js';

export type TextAlign = 'left' | 'center' | 'right';
export type TextTransform = 'none' | 'uppercase' | 'lowercase';

export interface TextStyle {
  fontFamily: string;
  /** Pixels at document scale — a 96px headline on a 1280px thumbnail. */
  fontSize: number;
  /** 100..900. The rasterizer asks the platform for the nearest available weight. */
  fontWeight: number;
  italic: boolean;
  /** Extra space between characters, in px. Negative tightens. */
  letterSpacing: number;
  /** Multiplier on fontSize. 1.2 is the readable default; thumbnails often want 1.0. */
  lineHeight: number;
  align: TextAlign;
  transform: TextTransform;
  fill: Fill;
  stroke: Stroke | null;
  shadow: Shadow | null;
  glow: Glow | null;
  /**
   * Baseline curvature, -100..100. 0 is a straight line; positive arcs the text over a circle
   * (smile), negative under it (frown). Implemented by placing each glyph on the arc, which is
   * why it only applies to single-line text — see the rasterizer.
   */
  curve: number;
  /**
   * Horizontal skew in degrees, -45..45. The cheap half of "warp text": it costs one matrix
   * term and covers the italic-ish slant creators actually reach for. Envelope warps (arc
   * lower, flag, fisheye) need a mesh deform and are not modelled.
   */
  skew: number;
}

export const DEFAULT_TEXT_STYLE: Readonly<TextStyle> = Object.freeze({
  fontFamily: 'Inter',
  fontSize: 96,
  fontWeight: 800,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.15,
  align: 'center' as TextAlign,
  transform: 'none' as TextTransform,
  fill: DEFAULT_FILL as Fill,
  stroke: null,
  shadow: null,
  glow: null,
  curve: 0,
  skew: 0,
});

/** Turn a style's decorations on with sane defaults, for the inspector's toggles. */
export const enabledStroke = (): Stroke => ({ ...DEFAULT_STROKE });
export const enabledShadow = (): Shadow => ({ ...DEFAULT_SHADOW });
export const enabledGlow = (): Glow => ({ ...DEFAULT_GLOW });

// ─────────────────────────────────────────────────────────────────────────────
// Fonts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The families the picker offers before the platform is asked for more.
 *
 * This is a *curated* list, not "hundreds of fonts" hardcoded — a bundled list of names is
 * worthless if the machine doesn't have the files, and every name below either ships with
 * Windows/macOS or falls back predictably. The real breadth comes from
 * `mergeSystemFonts()`, which the UI feeds from the platform's font enumeration; on a typical
 * Windows install that is several hundred families, and they are ACTUALLY installed.
 *
 * Grouped because a flat alphabetical list of 400 names is unusable — the picker renders these
 * groups and then an "Installed" group for whatever the system reported.
 */
export interface FontGroup {
  label: string;
  families: readonly string[];
}

export const FONT_GROUPS: readonly FontGroup[] = [
  {
    label: 'Display & Impact',
    families: [
      'Impact', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Bangers',
      'Luckiest Guy', 'Fredoka One', 'Titan One', 'Righteous', 'Passion One',
      'Alfa Slab One', 'Ultra', 'Bungee', 'Black Ops One',
    ],
  },
  {
    label: 'Sans Serif',
    families: [
      'Inter', 'Segoe UI', 'Arial', 'Helvetica', 'Helvetica Neue', 'Roboto',
      'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Raleway',
      'Source Sans Pro', 'Work Sans', 'Rubik', 'Manrope', 'DM Sans', 'Barlow',
      'Karla', 'Mulish', 'Quicksand', 'Tahoma', 'Verdana', 'Trebuchet MS',
      'Franklin Gothic Medium', 'Calibri', 'Century Gothic',
    ],
  },
  {
    label: 'Serif',
    families: [
      'Georgia', 'Times New Roman', 'Garamond', 'Playfair Display', 'Merriweather',
      'Lora', 'PT Serif', 'Crimson Text', 'Libre Baskerville', 'Cormorant Garamond',
      'Bitter', 'Cambria', 'Book Antiqua', 'Palatino Linotype', 'Rockwell',
    ],
  },
  {
    label: 'Script & Handwriting',
    families: [
      'Pacifico', 'Dancing Script', 'Lobster', 'Caveat', 'Satisfy', 'Great Vibes',
      'Sacramento', 'Kaushan Script', 'Permanent Marker', 'Shadows Into Light',
      'Indie Flower', 'Comic Sans MS', 'Brush Script MT', 'Segoe Script',
    ],
  },
  {
    label: 'Monospace',
    families: [
      'JetBrains Mono', 'Consolas', 'Courier New', 'Cascadia Code', 'Fira Code',
      'IBM Plex Mono', 'Space Mono', 'Source Code Pro', 'Lucida Console',
    ],
  },
];

/** Every curated family, flat. Derived so it can never drift from the groups. */
export const CURATED_FONTS: readonly string[] = FONT_GROUPS.flatMap((g) => g.families);

/**
 * Fold platform-reported families into the curated groups.
 *
 * Anything already curated keeps its group (so "Georgia" stays under Serif rather than being
 * duplicated into a flat "Installed" bucket); everything else lands in one trailing group. The
 * result is stable and deduped, which matters because the picker's favourites are keyed by
 * family name.
 */
export function mergeSystemFonts(system: readonly string[]): FontGroup[] {
  const known = new Set(CURATED_FONTS.map((f) => f.toLowerCase()));
  const extra = [...new Set(system.map((f) => f.trim()).filter(Boolean))]
    .filter((f) => !known.has(f.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const groups = FONT_GROUPS.map((g) => ({ ...g }));
  if (extra.length > 0) groups.push({ label: 'Installed', families: extra });
  return groups;
}

/**
 * A CSS font shorthand for a style, with a fallback stack.
 *
 * The stack is what makes a missing family degrade to something in the same *genre* instead of
 * to Times New Roman — a thumbnail set in Anton that silently renders as a serif is worse than
 * one that renders as Impact.
 */
export function cssFont(style: Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>): string {
  const family = /[^a-z0-9 ]/i.test(style.fontFamily) ? JSON.stringify(style.fontFamily) : `"${style.fontFamily}"`;
  const italic = style.italic ? 'italic ' : '';
  return `${italic}${style.fontWeight} ${style.fontSize}px ${family}, "Segoe UI", system-ui, sans-serif`;
}

/** Apply `transform` to the raw content. The rasterizer and any measurer must agree on this. */
export function displayText(content: string, transform: TextTransform): string {
  if (transform === 'uppercase') return content.toUpperCase();
  if (transform === 'lowercase') return content.toLowerCase();
  return content;
}
