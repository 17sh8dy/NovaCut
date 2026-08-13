# Open Cut — Effects Framework & 50-Effect Roadmap

Scalable architecture for the animations / text / filters / transitions library. This is the
**framework + catalog** deliverable; the 5 Batch‑1 effects land in the next step and plug into
the seams described here. Nothing in this document alters the existing render loop, coordinate
systems, or buffer swaps — every new capability is an **additive** branch.

---

## 1. The core finding: Open Cut has four effect layers, not one

Effects are applied at four different layers by design. A single "one function signature for all
50" wrapper would fight the engine and risk exactly the inverted-frame / black-flash bugs we must
avoid. So the framework is **one registry umbrella with four typed lanes**, each sharing the
registry *pattern* (`register / get / all`, keyed by `type`, params drive the UI) but hooking its
correct layer. All four share the `progress 0..1 + params` convention.

| # | Lane | Renders at | Contract (core registry) | Core edit to extend? |
|---|------|-----------|--------------------------|----------------------|
| 1 | **Filters** | GPU pixel shader in the ping‑pong chain — `compositor.ts` `applyEffect()` runs `EFFECT_FRAGMENTS[render]`, binding `u_<paramKey>` generically | `EffectDefinition` + a fragment in `shaders.ts` | **None** (true zero‑touch plugin surface) |
| 2 | **Transitions** | Two‑clip GPU blend — *new* `TRANSITION_FRAGMENTS[render]` | `TransitionDefinition` + a fragment in `transitions.ts` | **Additive** blend branch in `compositor.ts` + a drop handler |
| 3 | **Text animations** | GPU — the text raster's reveal, transform and appended passes | `TextAnimationDefinition.apply({content, progress, params})` → numbers | **Additive** branch in `renderClip` |
| 4 | **Transform animations** | Transform matrix — `buildModelMatrix()` samples `clip.transform` keyframes | `AnimationDefinition.build(params) → keyframes` | **None** (writes keyframes via existing undoable commands) |

Filters (1) and transform animations (4) need **zero** core changes. Transitions (2) and text
animations (3) need small additive hooks — approved, and detailed in §4.

> **Important:** Transitions were previously **stubbed** — the model, registry, browser chips, and
> drag data all existed, but there was **no blend path in the compositor and no drop handler**
> (`.transitions` was only ever serialized). Lane 2 makes them real for the first time.

---

## 2. What this step added (the scaffolding — already in the tree)

- **`core/effects/registry.ts`** — two new typed lanes alongside the existing effect/transition
  registries:
  - `AnimationDefinition` + `registerAnimation / getAnimation / allAnimations`
  - `TextAnimationDefinition` + `registerTextAnimation / getTextAnimation / allTextAnimations`
  - `TransformChannel`, `AnimationKeyframeSpec`, `TextAnimationInput/Output` contracts, and a
    `defaultParams()` helper.
- **`core/model/types.ts`** — additive optional `TextStyle.animation?: TextAnimation`. A clip with
  no `animation` renders byte‑for‑byte as before.
- **`engine/compositor/transitions.ts`** — the transition GLSL framework: `transitionFrag()`
  wrapper, `TRANSITION_FRAGMENTS` (seeded with the `cut` fallback), `getTransitionFragment()`,
  `hasTransitionFragment()`, and the shared quad vertex shader.
- **`engine/index.ts`** — exports the transitions module.

All four lanes are registry-driven, so adding an effect is *data + one pure function/shader* — no
engine wiring, no UI wiring (browsers read `all*()`).

---

## 3. How to author each lane (recipes for Batch 1+)

**Filter** — add to `EFFECTS[]` in `definitions.ts` + a fragment in `EFFECT_FRAGMENTS`:
```ts
{ type: 'duotone', label: 'Duotone', category: 'color', render: 'duotone',
  params: [p('mix','Mix',0,1,1,0.01)] }
// shaders.ts: duotone: frag(`uniform float u_mix; void main(){ ... }`)
```

**Transition** — add to `TRANSITIONS[]` + a fragment in `TRANSITION_FRAGMENTS`:
```ts
{ type: 'cross-dissolve', label: 'Cross Dissolve', render: 'dissolve', params: [] }
// transitions.ts: dissolve: transitionFrag(`void main(){
//   fragColor = mix(texture(u_from,v_uv), texture(u_to,v_uv), u_progress); }`)
```

**Text animation** — `registerTextAnimation({ type, label, kind, duration, params, apply })`, pure.
Returns NUMBERS, not CSS — see §7:
```ts
{ type: 'typewriter', label: 'Typewriter', kind: 'in', duration: 1.2, params: [],
  apply: ({ progress }) => ({ reveal: progress }) }
```

**Transform animation** — `registerAnimation({ type, label, params, build })`, pure, fraction‑based:
```ts
build: ({ zoom }) => ({ scaleX:[{at:0,value:1},{at:1,value:zoom}],
                        scaleY:[{at:0,value:1},{at:1,value:zoom}] })
```

---

## 4. The additive hooks Batch 1 will land (reviewed here first)

**Hook A — Transition blend (`compositor.ts`).** In `render()`, per track, detect an active
transition window between adjacent clips A→B. If `hasTransitionFragment(def.render)`: render A to
the `ping` FBO and B to the `pong` FBO (reusing the existing clip render path pointed at a target),
then a new `blendTransition(fromTex, toTex, progress, params, render)` draws to the canvas via a
cached transition program. Otherwise the current single‑clip path runs unchanged. `renderClip()`,
`composite()`, and the buffer‑swap logic are **not modified** — this is a new guarded branch.

**Hook B — Text reveal.** ⚠️ **Superseded — this hook describes a layer that no longer exists.**
`TextOverlay` was deleted when text moved onto the GPU (see `textRaster.ts`), because a DOM
overlay is invisible to `readPixels` and every title was silently dropped from exports. The
replacement is in `Compositor.renderClip`: it calls `resolveTextAnimation(style, localSeconds,
clipSeconds)`, hands the resulting `reveal` to `rasterizeText`, multiplies `opacity` and the
transform into the model matrix, and appends the returned `passes` to the clip's effect chain.
See §7.

**Hook C — Animation applier (`core` command + Animations browser).** `applyAnimationPreset()`
scales each spec's fractional `at` by `clip.duration` and `upsertKeyframe()`s onto the transform
channels through the normal `dispatch` → undoable, non‑destructive, zero render changes.

**Hook D — Transition drop handler (`Timeline.tsx`).** Consume the existing
`application/x-opencut-transition` drag payload on a clip boundary → add a `Transition` to the
track via a command, so users can place them.

---

## 5. The 50-effect catalog

### ✅ Batch 1 — 5 baseline effects (next step)
| Lane | Name | Key / render | Notes |
|------|------|--------------|-------|
| Transition | **Crossfade** | `cross-dissolve` / `dissolve` | `mix(from,to,progress)`; also proves Hooks A + D |
| Text | **Typewriter** | `typewriter` | char‑by‑char reveal; proves Hook B |
| Filter | **Gaussian Blur** | `gaussian-blur` / `gaussianBlur` | true **separable** blur (upgrade over the existing 9‑tap box `blur`; new key, existing clips unaffected) |
| Animation | **Kinetic Zoom** | `kinetic-zoom` | Ken‑Burns scale+pan keyframes; proves Hook C |
| Filter | **Monochrome** | `monochrome` | tintable luma (richer than `black-white`; new key) |

### 🔜 Remaining 45

**Transitions (12)** — each an entry in `TRANSITIONS[]` + a `TRANSITION_FRAGMENTS` shader
- [ ] Fade to Color · [ ] Slide (directional) · [ ] Push · [ ] Dolly Zoom · [ ] Spin
- [ ] Blur Dissolve · [ ] Flash · [ ] Whip Pan · [ ] Glitch · [ ] 3D Flip · [ ] Cube · [ ] Page Turn

**Filters (14)** — each an `EFFECTS[]` entry + `EFFECT_FRAGMENTS` shader
- [ ] Duotone · [ ] Sepia · [ ] Posterize · [ ] Halftone · [ ] Bloom · [ ] Radial Blur · [ ] Edge Detect (Sobel)
- [ ] Invert · [ ] Threshold · [ ] Gradient Map · [ ] CRT / Scanlines · [ ] Kaleidoscope · [ ] VHS / Bad‑TV · [ ] Sketch

**Text animations (9)** — each a `registerTextAnimation()` pure `apply`
- [ ] Fade In · [ ] Word Fade · [ ] Character Stagger · [ ] Slide Up · [ ] Bounce In
- [ ] Blur In · [ ] Wave · [ ] Glitch Text · [ ] Number Counter

**Transform animations (10)** — each a `registerAnimation()` pure `build`
- [ ] Zoom In (punch) · [ ] Zoom Out · [ ] Pan (directional) · [ ] Spin · [ ] Shake · [ ] Pulse
- [ ] Slide‑In Entrance · [ ] Pop‑In Entrance · [ ] Fade In/Out · [ ] Float / Drift

**Total: 5 + 45 = 50 distinct effects across 4 categories.**

---

## 6. How this honors the four rules
1. **Core rendering untouched** — filters & transform anims need zero core edits; transitions &
   text anims are *new guarded branches* that never alter the draw loop, UV/coordinate space, or
   buffer swaps. The transition base‑case is a hard `cut` = today's behavior.
2. **Modular registry** — nothing is hardcoded into engine files; every effect is a self‑contained
   definition + pure function/shader registered into `effectsRegistry`.
3. **Incremental** — framework first, then batches of 5; no code dumping.
4. **Strict interface** — each lane has one fixed, pure contract taking `progress 0..1 + params`
   and returning its layer's output with no side effects.

---

## 7. Text animations, as actually built

The doc above was written when text was a DOM overlay. It isn't any more, and the text lane was
rebuilt around that. What follows describes the shipped design.

### The contract

`TextAnimationDefinition.apply({ content, progress, params })` returns a `TextAnimationOutput` of
pure numbers, every field optional and defaulting to neutral:

| Field | Meaning |
|---|---|
| `reveal` | fraction of the string painted, 0..1 — layout still uses the FULL string |
| `opacity` | multiplied into the clip's own opacity |
| `dx` / `dy` | offset in fractions of the text's own rendered size (`dy` positive = down) |
| `scaleX` / `scaleY` | multiplied into the clip's scale |
| `rotate` | degrees, added |
| `passes` | ordinary effects (`{type, params}`) appended to the clip's chain this frame |

`passes` is the extensibility hinge: anything that changes pixels rather than placement is an
existing registry effect with resolved params, so the lane needs no new engine code to gain a
new pixel trick, and any of the ~80 registered effects is animation material.

### Three slots, not one

`TextStyle` carries `animateIn`, `animateOut` and `animateLoop`, each a
`{ type, params, duration }` where `duration` is in **seconds** (choreography, not timeline
position). `resolveTextAnimation` composes them for a frame: opacities and scales multiply,
offsets and rotations add, `reveal` takes the minimum, `passes` concatenate. In/out durations
are budgeted against the clip length *before* either runs, so a trimmed title plays its
choreography faster rather than overlapping it.

Authoring direction: `in` runs 0 (nothing) → 1 (arrived); `out` runs 0 (resting) → 1 (gone);
`loop` gets a phase that wraps forever.

### Where it plugs in

`Compositor.renderClip` — one guarded branch, taken only when a slot is filled:

```
resolveTextAnimation → reveal ──→ rasterizeText(style, reveal)   (full-size layout, partial paint)
                     → passes ──→ runEffectChain([...clip.effects, ...passes])
                     → transform → buildModelMatrix / composite opacity
```

The rasterizer measures the whole string and truncates only the painting, so a typewriter does
not shrink its own bitmap — which matters because the compositor places text by its centre, and
a shrinking bitmap makes a centred title creep sideways as it types.

### Catalog & shelves

75 animations (25 in / 25 out / 25 loop) in `core/effects/textAnimations.ts`, 30 filters in
`filters.ts`, 28 text-effect recipes in `textEffects.ts`. Filters are ordinary effects carrying a
`filter` category and a `constants` bag bound as uniforms from the DEFINITION — one shared
`filterGrade` shader, one `intensity` param. Text effects are recipes over real effect instances,
so they stack, keyframe, undo and export with no special case.

Two registry flags keep the browsers navigable: `filter` moves an effect to the Filters shelf,
`hidden` keeps machinery (the `text-reveal` mask) out of every picker. `allTools()` is what the
Effects browser and the photo pickers read.

### What pins it

- `npm run verify:textanim` — catalog shape, entrances settling at rest, exits starting at rest,
  loop seams, purity, and the in/out budget on a trimmed clip.
- `npm run verify:orientation` — the `filterGrade` constants and the `textReveal` mask on real
  pixels, including that two filters through the one cached program don't leak into each other.
- `npm run verify:browsers` — mounts the real `EditorApp`, clicks the shelves, asserts on project
  state, screenshots each panel, and checks a fade-in actually changes preview pixels.
