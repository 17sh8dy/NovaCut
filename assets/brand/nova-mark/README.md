# Nova Mark (Nova Cut logo, option 1)

Chosen 2026-10-22 from the concept board (Option 1, "Nova Mark"). **Not wired into the app yet.**
Nothing in this folder is used by the build; the current icon still comes from `assets/NovaCut.svg`.

## Folder

| Path | What |
|---|---|
| `svg/nova-mark-<variant>.svg` | App icon, 1024 canvas, full drawing (use at 48px and up) |
| `svg/nova-mark-<variant>-small.svg` | Simplified drawing for 32px and below (bolder, no inner ring) |
| `svg/nova-glyph-<variant>.svg` | The N alone on transparent, for headers and the product switcher |
| `png/<variant>/nova-mark-<variant>-<size>.png` | 16, 24, 32, 48, 64, 128, 256, 512, 1024 |
| `png/glyph/` | Glyph-only PNGs, 128/256/512 tall |
| `ico/nova-mark.ico` | Windows icon (default variant, 16 to 256, PNG-compressed entries) |
| `preview-sheet.png` | Every variant at every size on grey, to eyeball them |
| `build.mjs` / `render.cjs` | The generators. SVGs and PNGs are outputs; never hand-edit them |

Regenerate: `node assets/brand/nova-mark/build.mjs` then `npx electron assets/brand/nova-mark/render.cjs`.

## Variants and colours

Each variant colours three planes: A the diagonal slab, B the lower-left stem, C the detached segment.

| Variant | Tile | A (slab) | B (stem) | C (segment) |
|---|---|---|---|---|
| default | #0A0E22 to #0F1531 | #17C3FF, #2F7DFF, #4B2EFF | #A87DFF to #6A48F7 | #B58BFF to #8458F8 |
| purple | #150C2B to #201244 | #B58BFF, #7A4DFF, #5B2DF0 | #CBA9FF to #8A5CF6 | #D8BEFF to #9B6EFF |
| light | #F7F8FC to #E9ECF6 | #0BA5F0, #2563EB, #4F2FE8 | #9B6BFF to #6D45F0 | #A57BFF to #7B52F0 |
| mono-dark | #23262E to #171A20 | #F7F8FB to #D2D7E2 | #C3C9D6 to #A1A8BA | #E6E9F0 to #C0C6D4 |
| mono-light | #FAFAFC to #ECEDF1 | #1B1E27 to #2B2F3B | #3C4150 to #4E5465 | #2A2E3A to #3B4050 |

## Geometry (1024 canvas)

Traced from the Option 1 concept board. This is deliberately not a conventional N; it is three planes.

- **A, diagonal slab (blue):** the top of the left stem, the long diagonal (slope ~0.99) and the foot at
  bottom right, as one piece. Its lower-left edge is a straight cut line from (153,342) to (690,874).
- **B, lower-left stem (purple):** sits under the cut line; the diagonal cut is its top edge.
- **C, detached upper-right segment (violet):** separated from A by a dark channel (62 units vertical,
  92 in the small drawing) parallel to A's upper edge. Curved top rising to a rounded peak at the right.
- Outer corners rounded about 50 units; the cut and the channel are sharp. The glyph fills ~70% of the tile.
- Tile: rounded square, radius 228 (same corner as the current icon), 4px blue-to-violet edge hairline
  at 55% opacity. No glow, no drop shadow.
- Small drawing (32px and below): same shapes, wider channel, glyph 1.08x, edge hairline dropped.

## Before it goes in the app

- The app pipeline (`npm run icon`) derives `.ico` / `.icns` / Linux PNGs from `assets/NovaCut.svg` and
  `NovaCut-small.svg`. To adopt this mark, point those two at the default tile SVGs and re-run it.
- `packages/ui/src/assets/logo.svg` and the home screen's `BrandText` blue will need a look.
