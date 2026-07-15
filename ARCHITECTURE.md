# Open Cut — Architecture

Open Cut is a non-linear video editor (NLE) built as a **layered monorepo** so the
same domain and rendering logic can power desktop today and web/mobile later.

## Guiding principles

1. **Platform-agnostic core.** Nothing in `packages/core` imports Electron, the DOM,
   or React. It is pure TypeScript describing *what* a project is and *how* it changes.
2. **Deterministic edits.** Every mutation to a project goes through a `Command`, giving
   us undo/redo, autosave diffs, and (future) collaboration for free.
3. **The renderer is a web app.** The Electron renderer is plain React + Vite. A web
   build is the same renderer with a different `PlatformBridge`. Only the *bridge*
   (file access, native FFmpeg, dialogs) is platform-specific.
4. **Data-driven features.** Effects, transitions, and export presets are described as
   metadata (params, ranges, defaults). Adding one is data, not new UI plumbing.

## Layers

```
apps/desktop  ── Electron shell. main + preload + renderer entry. Owns the PlatformBridge
     │           implementation (dialogs, fs, native ffmpeg via child_process).
     ▼
packages/ui   ── React design system + editor panels. Talks to core through the store.
     │           Knows nothing about Electron; receives a PlatformBridge via context.
     ▼
packages/engine ─ Playback clock, WebGL2 compositor, Web Audio graph, media probing,
     │            export orchestration. Browser APIs only, no React, no Electron.
     ▼
packages/core ── Domain model (Project/Sequence/Track/Clip/Media/Keyframe), the command
                 system + history, effect/transition registries, versioned project IO.
                 Zero runtime dependencies.
```

Dependencies only ever point **downward**. `core` depends on nothing; `engine` and `ui`
depend on `core`; `desktop` wires them together.

## The PlatformBridge seam

Everything platform-specific is funneled through one interface (`packages/core` defines
it, each app implements it):

| Capability      | Desktop (Electron)             | Web (future)              | Mobile (future)        |
| --------------- | ------------------------------ | ------------------------- | ---------------------- |
| Open/save files | native dialogs + fs via IPC    | File System Access API    | native share sheet     |
| Media decode    | native ffprobe / `<video>`     | `<video>` + WebCodecs     | native decoder         |
| Export          | native ffmpeg (`child_process`)| ffmpeg.wasm / WebCodecs   | native encoder         |
| Persistence     | JSON on disk                   | IndexedDB / cloud         | app storage            |

Because the UI only sees the interface, porting is "implement the bridge," not "rewrite
the app."

## Rendering pipeline

`Sequence + playhead → Compositor`. For each visible track (top-down), the compositor
uploads the clip's current frame to a WebGL2 texture, applies its stacked effect shaders,
then blends according to opacity/blend mode. Audio is mixed in parallel through a Web
Audio graph. Export reuses the exact same frame-generation path, piped to FFmpeg.

## Future roadmap hooks (designed-in, not bolted-on)

- **AI tools** → an `Effect` whose "apply" is async and may call a service. The registry
  already supports async effects; a background-removal node is just another effect.
- **Plugins** → the effect/transition registries are the plugin surface. A plugin SDK
  registers new definitions at runtime.
- **Cloud & collaboration** → commands are serializable; a transport that broadcasts
  commands is the collaboration layer.
- **Motion graphics / 3D** → new clip *kinds* plus new compositor node types.

See `README.md` for how to run, and each package's `README`/source headers for detail.
