<div align="center">

# 🎬 Nova Cut

**A modern, professional non-linear video editor.**
Desktop-first, architected to grow into web and mobile from the same core.

</div>

---

Nova Cut is a fast, beautiful NLE built like a product, not a demo. It has a real layered
architecture: a platform-agnostic domain core, a WebGL2/Web-Audio rendering engine, a
polished React design system, and a thin Electron shell that supplies native file access
and FFmpeg export. The same editor renders whether the host is desktop, web, or mobile —
only the *platform bridge* changes.

## Highlights

- **Real timeline** — multi-track video/audio, drag/move/trim, split, ripple delete,
  duplicate, snapping, magnetic edges, zoom/scroll, per-track mute/solo/lock/hide/rename,
  undo/redo with edit coalescing.
- **Live GPU preview** — a WebGL2 compositor renders the exact frame you'll export, with
  stacked, keyframeable effects as shaders.
- **Deep inspector** — transform + keyframes (bezier easing), an effects rack, audio
  (volume automation, fades, EQ model, pitch), speed (ramps, reverse), and full text.
- **Data-driven effects & transitions** — 25+ effects and 13 transitions described as
  metadata; the UI and shaders are generated from it. Adding one is data, not plumbing.
- **Professional export** — resolution up to 8K, 24–240 fps, codec/container matrix,
  quality/bitrate, hardware acceleration, live size & render-time estimates, and a real
  frame-streaming pipeline into native FFmpeg.
- **Premium UI** — a restrained, neutral design system in System / Light / Dark with a
  choosable accent colour, resizable/dockable panels, subtle motion, keyboard shortcuts,
  autosave. See [Design system](#design-system).

## Architecture (short version)

```
apps/desktop     Electron shell + native PlatformBridge (dialogs, fs, FFmpeg)
packages/ui      React design system, editor panels, app store  (no Electron)
packages/engine  WebGL2 compositor, Web Audio graph, clock, exporter  (no React)
packages/core    Domain model, commands/undo, registries, IO  (zero deps)
```

Dependencies point only downward. Everything platform-specific is funneled through one
`PlatformBridge` interface, so a web/mobile port means "implement the bridge," not
"rewrite the app." Full details in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Getting started

**Prerequisites:** Node ≥ 20. Released builds bundle FFmpeg, but the binaries are not in
this repository — so for media probing, thumbnails, and export from a source checkout, run
`npm run ffmpeg:fetch` (downloads an LGPL build into `apps/desktop/resources/ffmpeg/`), or put
`ffmpeg` / `ffprobe` on your `PATH`, or set `OPENCUT_FFMPEG` / `OPENCUT_FFPROBE`. The editor is
fully usable without FFmpeg; those features degrade gracefully.

```bash
npm install        # install the whole workspace
npm run dev        # launch the desktop app with HMR
npm run build      # production build (out/)
npm run typecheck  # type-check every package
```

## Packaging the desktop app

```bash
npm run pack       # unpacked app in apps/desktop/release/win-unpacked (fast, for testing)
npm run dist       # installers for the current OS, in apps/desktop/release
npm run icon       # re-render every icon from assets/NovaCut.svg
```

`npm run dist` produces an NSIS installer **and** a portable `.exe` on Windows, a DMG on macOS,
and an AppImage + deb on Linux. Configuration lives in `apps/desktop/electron-builder.yml`.

## The logo

**`assets/NovaCut.svg` and `assets/NovaCut-small.svg` are the single source of truth** — small
hand-authored vectors: no metadata, no filters, no embedded rasters, transparent everywhere the
mark isn't. `npm run icon` (`scripts/make-icons.cjs`) rasterises them through Chromium and writes:

| Output | Contents |
| --- | --- |
| `apps/desktop/build/icon.ico` | 16 · 24 · 32 · 48 · 64 as 32-bit DIBs, 128 · 256 as PNG |
| `apps/desktop/build/icon.icns` | the ten types `iconutil` emits, 16 → 1024 |
| `apps/desktop/build/icons/NxN.png` | the Linux icon-theme set, 16 → 1024 |
| `apps/desktop/build/icon.png` | 1024², the generic fallback |
| `packages/ui/src/assets/logo.svg` | the full vector, bundled by the renderer |
| `packages/ui/src/assets/logo-small.svg` | the small-size vector, ditto |

`electron-builder.yml` points `win.icon` / `mac.icon` / `linux.icon` at those files explicitly, so
a build never silently re-derives them. **Change the logo in the SVG and re-run — never hand-edit
an output**, or the taskbar icon and the in-app mark drift apart with nothing to say which is right.

**There are two drawings on purpose.** The mark — two overlapping translucent frames, a play
triangle and a pair of corner brackets — reads at 128px and collapses into a plain blue square at
16px, where the opacities converge on the background and the 12px bracket strokes fall below one
pixel. So **32px and below take a simplified drawing**: one solid frame, a knocked-out triangle,
no brackets. `make-icons.cjs` applies that threshold to the icon files and the CSS applies it
again to the 22px title-bar mark. An icon is not one drawing scaled, it is a family drawn per
size — which is why `.ico` is a multi-image format in the first place.

`--brand-blue` in `packages/ui/src/theme/tokens.css` is the SVG's fill verbatim, so the mark and
the UI around it cannot disagree about the brand colour. **`--accent` is deliberately a different
value**: the mark's `#0A84FF` measures 3.65:1 under white text and cannot carry a button label.
That file explains the split.

Builds are unsigned, so Windows SmartScreen warns on first run until a code-signing certificate
is configured (`CSC_LINK` / `CSC_KEY_PASSWORD`).

FFmpeg is resolved at runtime from `OPENCUT_FFMPEG` / `OPENCUT_FFPROBE`, then from
`resources/ffmpeg/` inside the installed app, then from `PATH`. As of 1.0.0 the installer ships
an LGPL FFmpeg in that folder (`extraResources`), which is most of the download size — the
lookup order above is what lets a user substitute their own build without repackaging.
`npm run dist` runs `npm run ffmpeg:check` first, which refuses to package unless both binaries
are present, actually execute, and report neither `--enable-gpl` nor `--enable-nonfree`.

> **Windows, once per machine:** electron-builder unpacks a signing toolchain that contains macOS
> symlinks, which a standard Windows account may not create — the build then fails with *"Cannot
> create symbolic link: A required privilege is not held by the client"*. Enable **Developer
> Mode** (Settings → System → For developers), or run the packaging step from an elevated shell.

## Design system

`packages/ui/src/theme/tokens.css` is the whole thing, and its header states the three rules the
rest of the UI is held to:

1. **Surfaces are neutral.** White and light grey in Light, charcoal in Dark. The interface is the
   room; the user's photos and video are the only saturated things on screen.
2. **The accent is a signal, not a decoration.** It marks what is interactive or active — primary
   buttons, the selected tool, selection outlines, focus rings, sliders, progress, switches — and
   nothing else. There are no accent-washed panels and no glows.
3. **The brand is not the accent.** `--brand-deep / --brand-blue / --brand-cyan` are the logo's own
   gradient stops and never change. `--accent` is a user preference that *defaults* to the brand
   blue. Choosing a green accent recolours the controls and leaves the mark alone.

**Themes** are System (default, follows the OS live), Light and Dark. Only `--accent` is ever
written to the document by the app; `--accent-hover / -active / -text / -soft / -line` are derived
from it per theme with `color-mix`, so hover lightens on charcoal and darkens on white without the
app having to know which theme is active.

**Accent presets** live in `ACCENT_PRESETS` (`state/preferences.ts`): Ocean Blue (default), Purple,
Green, Orange, Red, Pink, Gray, plus a custom colour picker. Ocean Blue is stored as the empty
string rather than as `#1565ff`, so tokens.css stays the only place the brand colour is written
down.

**Motion** is fade, scale and slide at 100 / 160 / 240 ms on one decelerate curve. The only looping
animations left are the ones that carry information: the export progress sheen, loading skeletons,
and the spinner.

## How the pieces fit

- **Editing** — every change is a `Command` (`packages/core/commands`). The `History` gives
  undo/redo and coalescing; the store mirrors the resulting immutable `Project` into React.
- **Rendering** — `usePlaybackEngine` drives a `PlaybackClock` that advances the playhead;
  the `Compositor` draws each visible clip (frame → effect shader chain → transform/opacity
  composite). Export reuses the identical path via `OfflineExporter`.
- **Time** — positions are integer *ticks* (`705600000`/s) so thousands of edits never
  drift; frame rates and audio boundaries all land on whole ticks.

## Roadmap (designed-in, not bolted-on)

AI tools (background/object removal, captions, upscaling) fit as async effects. Plugins
register into the effect/transition registries. Collaboration broadcasts commands. Cloud
projects swap the persistence bridge. Motion graphics / 3D add new clip kinds and
compositor nodes. None require a rewrite — see `ARCHITECTURE.md`.

## License

MIT
