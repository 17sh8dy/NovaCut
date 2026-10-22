/**
 * Generates every Nova Mark SVG from ONE geometry, traced from the concept board (Option 1).
 *
 *   node assets/brand/nova-mark/build.mjs      -> writes ./svg/*.svg + variants.json
 *   electron assets/brand/nova-mark/render.cjs -> writes ./png/** and ./ico/nova-mark.ico
 *
 * The SVGs and PNGs in this folder are outputs. Change the geometry or a colour HERE, re-run
 * both, and never hand-edit a generated file.
 *
 * ── Geometry (1024 x 1024 canvas) ───────────────────────────────────────────────
 * Measured off the reference icon, then scaled so the glyph fills ~70% of the tile like it does
 * there. This is NOT a conventional N. It is three separate planes:
 *
 *   A  the blue DIAGONAL SLAB. One piece: the top of the left stem, the long diagonal (slope
 *      ~0.99) and the foot at bottom right. Its lower-left edge is a straight cut line from
 *      (153,342) to (690,874) that is shared with plane B.
 *   B  the purple LOWER-LEFT STEM. Sits under the cut line; the diagonal cut is its top edge.
 *   C  the detached UPPER-RIGHT SEGMENT. Separated from A by a dark channel that runs parallel
 *      to A's upper edge. Its top is a curved sweep rising to a rounded peak at the right.
 *
 * Corners are rounded (~50 units) on the outer extremities; the cut and the channel are sharp.
 * The tile is a 228-radius rounded square, the same corner as the current Nova Cut icon, with a
 * hairline blue-to-violet edge and NO glow.
 *
 * SMALL drawing (32px and below): identical shapes, a wider channel (so it survives as a whole
 * pixel at 16px), the glyph scaled up 1.08x and the edge hairline dropped.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'svg');
mkdirSync(OUT, { recursive: true });

const TILE = 1024;
const RADIUS = 228;

// A's upper edge: from (341,163) to (857,672).
const UP = { x0: 341, y0: 163, x1: 857, y1: 672 };
const SLOPE = (UP.y1 - UP.y0) / (UP.x1 - UP.x0);
/** y of A's upper edge at x, lifted by `gap` to make the channel's top edge. */
const channelY = (x, gap) => Math.round((UP.y0 + (x - UP.x0) * SLOPE - gap) * 10) / 10;

function shapes(gap) {
  return {
    // C: detached upper-right segment.
    c:
      `M654,303 C720,262 790,215 833,167 Q846,153 858,168 Q868,180 868,200 V${channelY(868, gap)} ` +
      `L654,${channelY(654, gap)} Z`,
    // B: lower-left stem, top edge is the cut line. Starts 12 above the line, under A, so no seam.
    b: 'M153,330 L380,557 V824 Q380,874 330,874 H203 Q153,874 153,824 Z',
    // A: the diagonal slab, drawn last so it owns the cut line.
    a:
      'M203,153 H318 Q331,153 341,163 L857,672 Q868,683 868,698 V824 Q868,874 818,874 H690 ' +
      'L153,342 V203 Q153,153 203,153 Z',
  };
}
const NORMAL = shapes(62);
const SMALL = shapes(92);

/** Gradients are in glyph space, so they follow the shapes when the group is scaled. */
const gradients = (p) =>
  `<linearGradient id="ga" gradientUnits="userSpaceOnUse" x1="153" y1="153" x2="868" y2="874">` +
  p.a.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') +
  `</linearGradient>` +
  `<linearGradient id="gb" gradientUnits="userSpaceOnUse" x1="153" y1="342" x2="320" y2="874">` +
  p.b.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') +
  `</linearGradient>` +
  `<linearGradient id="gc" gradientUnits="userSpaceOnUse" x1="850" y1="165" x2="700" y2="620">` +
  p.c.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') +
  `</linearGradient>`;

/**
 * Palette. Cyan to blue to indigo down the slab, violet for the two detached planes; the tile is
 * the same dark navy the app already sits on.
 */
const PALETTE = {
  default: {
    label: 'Default (cyan / blue / purple, dark navy tile)',
    tile: ['#0A0E22', '#0F1531'],
    edge: ['#2D6BFF', '#6B4BE0'],
    a: [[0, '#17C3FF'], [0.5, '#2F7DFF'], [1, '#4B2EFF']],
    b: [[0, '#A87DFF'], [1, '#6A48F7']],
    c: [[0, '#B58BFF'], [1, '#8458F8']],
  },
  purple: {
    label: 'Purple (dark mode accent)',
    tile: ['#150C2B', '#201244'],
    edge: ['#7A4DFF', '#A77BFF'],
    a: [[0, '#B58BFF'], [0.5, '#7A4DFF'], [1, '#5B2DF0']],
    b: [[0, '#CBA9FF'], [1, '#8A5CF6']],
    c: [[0, '#D8BEFF'], [1, '#9B6EFF']],
  },
  light: {
    label: 'Light (light mode)',
    tile: ['#F7F8FC', '#E9ECF6'],
    edge: ['#9DB6F5', '#B7A4F0'],
    a: [[0, '#0BA5F0'], [0.5, '#2563EB'], [1, '#4F2FE8']],
    b: [[0, '#9B6BFF'], [1, '#6D45F0']],
    c: [[0, '#A57BFF'], [1, '#7B52F0']],
  },
  'mono-dark': {
    label: 'Monochrome (dark)',
    tile: ['#23262E', '#171A20'],
    edge: ['#4A4F5C', '#3A3E49'],
    a: [[0, '#F7F8FB'], [1, '#D2D7E2']],
    b: [[0, '#C3C9D6'], [1, '#A1A8BA']],
    c: [[0, '#E6E9F0'], [1, '#C0C6D4']],
  },
  'mono-light': {
    label: 'Monochrome (light)',
    tile: ['#FAFAFC', '#ECEDF1'],
    edge: ['#C9CCD6', '#B5B9C6'],
    a: [[0, '#1B1E27'], [1, '#2B2F3B']],
    b: [[0, '#3C4150'], [1, '#4E5465']],
    c: [[0, '#2A2E3A'], [1, '#3B4050']],
  },
};

const planes = (g) =>
  `<path d="${g.c}" fill="url(#gc)"/><path d="${g.b}" fill="url(#gb)"/><path d="${g.a}" fill="url(#ga)"/>`;

function tileSvg(p, g, small) {
  const edge = small
    ? ''
    : `<rect x="2" y="2" width="${TILE - 4}" height="${TILE - 4}" rx="${RADIUS - 2}" fill="none" stroke="url(#edge)" stroke-width="4" opacity="0.55"/>`;
  const scale = small ? 1.08 : 1;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" width="${TILE}" height="${TILE}">` +
    `<title>Nova Cut - ${p.label}${small ? ' (small sizes)' : ''}</title>` +
    `<defs>` +
    `<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.tile[0]}"/><stop offset="1" stop-color="${p.tile[1]}"/></linearGradient>` +
    `<linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.edge[0]}"/><stop offset="1" stop-color="${p.edge[1]}"/></linearGradient>` +
    gradients(p) +
    `</defs>` +
    `<rect width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="url(#t)"/>` +
    edge +
    `<g transform="translate(512 513.5) scale(${scale}) translate(-510.5 -513.5)">${planes(g)}</g>` +
    `</svg>\n`
  );
}

/** Glyph only on transparent, for headers and the product switcher. */
const GLYPH_BOX = { x: 140, y: 140, w: 740, h: 750 };
function glyphSvg(p, g) {
  const b = GLYPH_BOX;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}">` +
    `<title>Nova Mark - ${p.label}</title><defs>${gradients(p)}</defs>${planes(g)}</svg>\n`
  );
}

const names = [];
for (const [name, p] of Object.entries(PALETTE)) {
  writeFileSync(join(OUT, `nova-mark-${name}.svg`), tileSvg(p, NORMAL, false));
  writeFileSync(join(OUT, `nova-mark-${name}-small.svg`), tileSvg(p, SMALL, true));
  names.push(name);
}
for (const name of ['default', 'light', 'mono-dark', 'mono-light']) {
  writeFileSync(join(OUT, `nova-glyph-${name}.svg`), glyphSvg(PALETTE[name], NORMAL));
}
writeFileSync(
  join(dirname(OUT), 'variants.json'),
  JSON.stringify({ variants: names, tile: TILE, radius: RADIUS, glyphAspect: GLYPH_BOX.w / GLYPH_BOX.h }, null, 2) + '\n',
);
console.log('wrote', names.length * 2 + 4, 'svgs to', OUT);
