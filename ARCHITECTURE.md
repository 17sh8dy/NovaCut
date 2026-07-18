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
packages/engine ─ Playback clock, WebGL2 compositor (video), photo render graph, shared GL
     │            plumbing, Web Audio graph, media probing, export orchestration.
     │            Browser APIs only, no React, no Electron.
     ▼
packages/photo ─ Still-image domain: PhotoDocument, the layer TREE (groups / adjustment
     │           layers / clipping), transforms, blend modes, photo commands, versioned IO.
     ▼
packages/core ── Domain model (Project/Sequence/Track/Clip/Media/Keyframe), the command
                 system + history, effect/transition registries, versioned project IO.
                 Zero runtime dependencies.
```

Dependencies only ever point **downward**. `core` depends on nothing; `photo` depends on
`core`; `engine` depends on both; `ui` depends on all three; `desktop` wires them together.

`engine → photo` is deliberate. The photo render graph interprets the layer tree directly
rather than being handed a flattened list, because flattening discards the very structure —
group isolation, clipping runs, adjustment scope — that the graph exists to interpret. Both
are zero-DOM domain packages, so the alternative was duplicating a 27-mode blend union and the
layer tree inside the engine, where the two copies would drift.

### Inside `packages/engine`

```
gl/       ── GLContext (programs, quad, uploads, FBOs), FboPool, the shared effect chain, mat3.
compositor/ ─ Video: track walk, clip time-window search, source seeking, clip transform.
photo/    ── PhotoRenderer: the recursive layer-tree render graph + blend-mode GLSL.
```

Both renderers stand on `gl/`. That is not tidiness: **every texture in the pipeline is
bottom-up**, and two copies of that convention is how it comes to disagree — which it already
did once, silently, in shipped code (each effect pass flipped the frame; upside-down at odd
effect counts, self-cancelling at even ones). One implementation, pinned by `verify:orientation`.
Sharing the effect chain is also why a filter written for video appears in the photo editor for
free.

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

**Video.** `Sequence + playhead → Compositor`. For each visible track (bottom-up), the
compositor uploads the clip's current frame to a WebGL2 texture, applies its stacked effect
shaders, then composites with its transform and opacity. Audio is mixed in parallel through a
Web Audio graph. Export reuses the exact same frame-generation path, piped to FFmpeg.

**Photo.** `PhotoDocument → PhotoRenderer`. The graph walks the layer tree bottom-up and, per
layer, does the same three things regardless of kind:

```
source ─place(model matrix)─→ canvas-sized raster ─effect chain─→ ─blend(mode, opacity)─→ accumulator
```

Everything after `place` happens in canvas space, which is what makes the graph uniform: an
image, a group and an adjustment differ only in how they produce their raster. A group renders
its children against a *transparent* backdrop and composites the flattened result as one unit
(so group opacity cross-fades the flattened group, not each child). An adjustment layer has no
pixels — it re-runs its effect against the live backdrop beneath it. Clipping runs composite
into their base layer's unit before that unit blends.

Buffers come from an `FboPool` (acquire/release) rather than a fixed ping/pong pair, because
nesting depth is a property of the user's document, not of the code. `render()` asserts the pool
balances each frame, so a leaked buffer fails at the frame that leaked rather than by exhausting
VRAM twenty minutes later.

**Non-destructive by construction.** The document stores no pixels — only a description of how
to composite the originals — and the graph re-derives the result every draw. That is what keeps
transforms, adjustment params and effect stacks editable forever, and it is also why History can
snapshot whole documents cheaply.

## Future roadmap hooks (designed-in, not bolted-on)

- **AI tools** → an `Effect` whose "apply" is async and may call a service. The registry
  already supports async effects; a background-removal node is just another effect.
- **Plugins** → the effect/transition registries are the plugin surface. A plugin SDK
  registers new definitions at runtime.
- **Cloud & collaboration** → commands are serializable; a transport that broadcasts
  commands is the collaboration layer.
- **Motion graphics / 3D** → new clip *kinds* plus new compositor node types.

See `README.md` for how to run, and each package's `README`/source headers for detail.
