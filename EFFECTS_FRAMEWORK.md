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
| 3 | **Text animations** | DOM overlay — `TextOverlay` in `Preview.tsx` | `TextAnimationDefinition.apply(content, progress, params)` | **Additive** reveal hook in `TextOverlay` |
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

**Text animation** — `registerTextAnimation({ type, label, params, apply })`, pure:
```ts
apply: ({ content, progress }) => ({ content: content.slice(0, Math.ceil(content.length*progress)) })
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

**Hook B — Text reveal (`Preview.tsx` `TextOverlay`).** When `clip.text.animation` is set and
`getTextAnimation(type)` resolves, compute `progress = (time - clip.start) / clip.duration`, call
`apply()`, and use the returned `content` (fallback: full) + merge `style`. Untouched otherwise.

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
