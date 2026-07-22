<div align="center">

# 🎬 Open Cut

**A modern, professional non-linear video editor.**
Desktop-first, architected to grow into web and mobile from the same core.

</div>

---

Open Cut is a fast, beautiful NLE built like a product, not a demo. It has a real layered
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
- **Premium UI** — dark-first design system, resizable/dockable panels, glass overlays,
  smooth motion, keyboard shortcuts, autosave, themes.

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

**Prerequisites:** Node ≥ 20. For media probing, thumbnails, and export, install
[FFmpeg](https://ffmpeg.org/) and ensure `ffmpeg` / `ffprobe` are on your `PATH`
(or set `OPENCUT_FFMPEG` / `OPENCUT_FFPROBE`). The editor is fully usable without FFmpeg;
those features degrade gracefully.

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
npm run icon       # re-render every icon from assets/OpenCut.svg
```

`npm run dist` produces an NSIS installer **and** a portable `.exe` on Windows, a DMG on macOS,
and an AppImage + deb on Linux. Configuration lives in `apps/desktop/electron-builder.yml`.

## The logo

**`assets/OpenCut.svg` is the single source of truth** — a 540-byte hand-authored vector: two
paths, one gradient, no metadata, no filters, no embedded rasters, transparent everywhere the
mark isn't. `npm run icon` (`scripts/make-icons.cjs`) rasterises it through Chromium and writes:

| Output | Contents |
| --- | --- |
| `apps/desktop/build/icon.ico` | 16 · 24 · 32 · 48 · 64 as 32-bit DIBs, 128 · 256 as PNG |
| `apps/desktop/build/icon.icns` | the ten types `iconutil` emits, 16 → 1024 |
| `apps/desktop/build/icons/NxN.png` | the Linux icon-theme set, 16 → 1024 |
| `apps/desktop/build/icon.png` | 1024², the generic fallback |
| `packages/ui/src/assets/logo.svg` | the vector itself, bundled by the renderer |

`electron-builder.yml` points `win.icon` / `mac.icon` / `linux.icon` at those files explicitly, so
a build never silently re-derives them. **Change the logo in the SVG and re-run — never hand-edit
an output**, or the taskbar icon and the in-app mark drift apart with nothing to say which is right.

The geometry was measured off the reference artwork (`assets/logo-reference.png`), not eyeballed;
`scripts/make-icons.cjs` documents the three alignment corrections that were applied. The brand
tokens in `packages/ui/src/theme/tokens.css` are the SVG's three gradient stops verbatim, so the
mark and the UI around it cannot disagree about what the brand colour is.

Builds are unsigned, so Windows SmartScreen warns on first run until a code-signing certificate
is configured (`CSC_LINK` / `CSC_KEY_PASSWORD`).

FFmpeg is resolved at runtime from `OPENCUT_FFMPEG` / `OPENCUT_FFPROBE`, then from
`resources/ffmpeg/` inside the installed app, then from `PATH`. Dropping `ffmpeg.exe` and
`ffprobe.exe` into that folder makes one installation self-sufficient without adding 80 MB to the
installer for everyone else.

> **Windows, once per machine:** electron-builder unpacks a signing toolchain that contains macOS
> symlinks, which a standard Windows account may not create — the build then fails with *"Cannot
> create symbolic link: A required privilege is not held by the client"*. Enable **Developer
> Mode** (Settings → System → For developers), or run the packaging step from an elevated shell.

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
