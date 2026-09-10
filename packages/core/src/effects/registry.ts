/**
 * Effect & transition registries.
 *
 * Effects are *described* here as metadata: their parameters, ranges, defaults, and the
 * name of the GLSL program the compositor uses to render them. The UI builds sliders from
 * this metadata; the engine looks up the shader by `render`. Adding an effect is adding a
 * definition (+ a shader) — no new UI or wiring.
 *
 * This registry is also the future **plugin surface**: a plugin SDK simply calls
 * `registerEffect()` at runtime.
 */

import { constant, type EffectInstance, type AnimatedValue, type InterpolationKind } from '../model/types.js';
import { newEffectId } from '../model/ids.js';

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
  /** Display unit, e.g. '%', 'px', '°'. */
  unit?: string;
  /**
   * How the UI should edit this param. Omitted means a slider.
   *
   * `color` is still a *number* everywhere else in the pipeline — see `packColor` — so the
   * engine's generic `uniform1f` binder, the keyframe sampler and both serializers are
   * untouched. Only the inspector reads this, and only to swap a slider for a swatch.
   */
  kind?: 'number' | 'color';
}

/**
 * Pack `#rrggbb` into one float, so a colour can travel the numeric param path.
 *
 * The alternative — widening `EffectInstance.params` to a union of numbers and strings — would
 * ripple through the animated-value sampler, both compositors and both serializers, in order
 * to give a handful of effects a colour picker. A 24-bit integer is exactly representable in a
 * float32 mantissa, so this round-trips losslessly through the uniform, through `constant()`
 * and through JSON. The shader unpacks it with two divisions (`unpackColor` in shaders.ts).
 */
export function packColor(hex: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return 0xffffff;
  return parseInt(m[1]!, 16);
}

/** The inverse, for the inspector's swatch. */
export function unpackColor(value: number): string {
  const n = Math.max(0, Math.min(0xffffff, Math.round(value)));
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** The full 24-bit range — the only sane bounds for a colour param. */
export const COLOR_PARAM_MAX = 0xffffff;

/**
 * `light` and `style` were added for the photo editor and are useful to both products.
 *
 * `light` is tonal work (exposure, highlights, shadows) as distinct from `color` (hue,
 * saturation, temperature) — the same split every photo tool makes, and the one that keeps an
 * adjustment picker of thirty entries navigable. `style` is the layer-style family (shadow,
 * outline, overlays): effects that decorate a layer's silhouette rather than recolour it.
 */
export type EffectCategory =
  | 'blur' | 'stylize' | 'color' | 'light' | 'style' | 'distort' | 'glitch' | 'time';

/**
 * The look-library taxonomy, which is deliberately NOT `EffectCategory`.
 *
 * An effect is a *tool* ("blur", "hue") and is filed by what it does to pixels. A filter is a
 * finished *look* ("Teal & Orange") and is filed by the mood it is reached for. Those are two
 * different questions a user asks, so they get two different shelves — the same reason a photo
 * app separates its adjustment sliders from its preset strip.
 */
export type FilterCategory =
  | 'basic' | 'cinematic' | 'color' | 'vintage' | 'creative' | 'bw';

export interface EffectDefinition {
  type: string;
  label: string;
  category: EffectCategory;
  /** GLSL program key the compositor resolves. 'passthrough' = CPU/no-op placeholder. */
  render: string;
  params: EffectParamDef[];
  /**
   * Uniforms bound from the DEFINITION rather than the instance — the shape of a look, as
   * opposed to the user's dial on it.
   *
   * This is what lets twenty-five filters share one shader and still be pure data. A filter's
   * grade (its lift, its gain, how far it fades the blacks) is fixed by the definition and is
   * not something the user edits param-by-param; only `intensity` is. Putting those numbers in
   * `params` would seed twenty-five sliders per filter into every instance and every saved
   * project, to express something that never varies. They bind exactly like params — `u_<key>`
   * — so the shader cannot tell the difference.
   */
  constants?: Record<string, number>;
  /**
   * Present when this effect is also published as a one-click *look* in the Filters browser.
   * Absent for the raw tools. See `FilterCategory`.
   */
  filter?: FilterCategory;
  /**
   * Keep this effect out of every browser and picker.
   *
   * For machinery that is a real effect to the engine but not a thing a user picks — the
   * reveal mask a text animation drives, for instance. It has to be in the registry so the
   * chain can render it; it must not be in the catalog, or the Effects panel fills up with
   * controls that only make sense when something else is animating them.
   */
  hidden?: boolean;
  /** True for effects that need async work (e.g. AI). Reserved for the roadmap. */
  async?: boolean;
}

export interface TransitionDefinition {
  type: string;
  label: string;
  render: string;
  params: EffectParamDef[];
}

const effects = new Map<string, EffectDefinition>();
const transitions = new Map<string, TransitionDefinition>();

export function registerEffect(def: EffectDefinition): void {
  effects.set(def.type, def);
}
export function registerTransition(def: TransitionDefinition): void {
  transitions.set(def.type, def);
}

export const getEffectDef = (type: string): EffectDefinition | undefined => effects.get(type);
export const getTransitionDef = (type: string): TransitionDefinition | undefined =>
  transitions.get(type);
export const allEffects = (): EffectDefinition[] => [...effects.values()];
export const allTransitions = (): TransitionDefinition[] => [...transitions.values()];
export const effectsByCategory = (cat: EffectCategory): EffectDefinition[] =>
  allTools().filter((e) => e.category === cat);

/**
 * The two shelves, split by the one field that distinguishes them.
 *
 * `allTools()` is what the Effects browser lists; `allFilters()` is what the Filters browser
 * lists. Deriving both from one registry (rather than keeping a second Map of filters) is what
 * guarantees a filter is a first-class effect everywhere else — it stacks, keyframes, exports
 * and appears in the photo editor with no special case anywhere in the pipeline.
 */
export const allFilters = (): EffectDefinition[] =>
  allEffects().filter((e) => !!e.filter && !e.hidden);
export const allTools = (): EffectDefinition[] =>
  allEffects().filter((e) => !e.filter && !e.hidden);
export const filtersByCategory = (cat: FilterCategory): EffectDefinition[] =>
  allFilters().filter((e) => e.filter === cat);

/** Instantiate an effect with all params seeded from their definition defaults. */
export function instantiateEffect(type: string): EffectInstance {
  const def = effects.get(type);
  if (!def) throw new Error(`Unknown effect type: ${type}`);
  const params: Record<string, AnimatedValue> = {};
  for (const p of def.params) params[p.key] = constant(p.default);
  return { id: newEffectId(), type, enabled: true, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-shader lanes: transform Animations & Text Animations
//
// Nova Cut renders effects at four different layers (see EFFECTS_FRAMEWORK.md): GPU pixel
// shaders (effects), two-clip GPU blends (transitions), the transform matrix (animations),
// and the DOM text overlay (text animations). The first two are GLSL, described by
// EffectDefinition / TransitionDefinition above. The last two are NOT pixel shaders, so
// forcing them through the `render`-key GLSL path would fight the engine. Instead they get
// their own typed registries here — same registry *pattern* (register / get / all, keyed by
// `type`, params drive the UI), different, layer-appropriate contract.
//
// Both contracts are PURE: an Animation returns keyframes to write onto a clip's transform
// (applied via the normal, undoable keyframe commands — the compositor already samples those,
// so the render loop is untouched); a TextAnimation maps (content, progress) to what the DOM
// overlay should display. No side effects, so they're trivially unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Transform channels an Animation preset may keyframe. Mirrors `Transform` scalar fields. */
export type TransformChannel = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity';

/**
 * One keyframe in a preset, positioned as a FRACTION of the clip (0 = clip start, 1 = clip
 * end). Keeping it fraction-based makes `build` pure and duration-agnostic; the applier scales
 * `at` by the clip's real duration when it writes the keyframes.
 */
export interface AnimationKeyframeSpec {
  at: number;
  value: number;
  interpolation?: InterpolationKind;
}

export interface AnimationDefinition {
  type: string;
  label: string;
  params: EffectParamDef[];
  /**
   * Pure builder: resolved param values → keyframes per transform channel. Only the channels
   * present in the returned object are written; the rest are left untouched. No side effects.
   */
  build: (params: Record<string, number>) => Partial<Record<TransformChannel, AnimationKeyframeSpec[]>>;
}

/**
 * Which slot a text animation is authored for. See `TextStyle.animateIn/Out/Loop`.
 *
 * The kind is part of the DEFINITION, not just a UI filter, because the three lanes are
 * evaluated on different clocks: `in` and `out` each run once over their own duration, while
 * `loop` runs on a repeating phase for as long as the clip is on screen. A definition that
 * doesn't know which clock it is on cannot be written correctly.
 */
export type TextAnimationKind = 'in' | 'out' | 'loop';

export interface TextAnimationInput {
  /** The clip's full text content. Available for length-aware reveals (typewriter). */
  content: string;
  /**
   * The animation's own clock, 0..1.
   *
   * `in`:   0 = the moment the clip starts, 1 = fully arrived.
   * `out`:  0 = still fully on screen, 1 = fully gone.
   * `loop`: the phase of one cycle, wrapping 0 → 1 → 0 forever.
   *
   * Each lane is authored in its own natural direction. It would be marginally cheaper to
   * define `out` as `in` played backwards and evaluate it with a reversed clock, but then every
   * exit would be forced to mirror an entrance — and the useful exits don't. "Fly out fast with
   * a blur" is not "blur in slowly" reversed.
   */
  progress: number;
  /** Resolved param values for this instance. */
  params: Record<string, number>;
}

/**
 * A GPU pass an animation asks for, named by effect-registry `type`.
 *
 * This is the extensibility hinge of the whole lane. Rather than growing a field on this
 * interface every time an animation wants a new pixel trick — and teaching the compositor to
 * bind it — an animation returns ordinary effect instances with resolved params, and the
 * engine appends them to the chain it was already running. So "Blur In" is `blur` with a
 * falling radius and "Glitch In" is `glitch-fx` with a falling amount: no engine change, and
 * any of the ~50 registered effects (plus any a plugin registers later) is instantly available
 * as animation material.
 */
export interface TextAnimationPass {
  type: string;
  params: Record<string, number>;
}

/**
 * What an animation does to the text this frame — pure numbers, no CSS.
 *
 * The earlier draft of this contract returned a bag of CSS properties, because text used to be
 * a DOM overlay sitting on top of the canvas. It isn't any more: text is rasterized and
 * composited on the GPU exactly like video, which is what made titles show up in exports at
 * all. So the contract has to speak the compositor's language — a reveal, a transform and a
 * list of passes — or animated text would render in the preview and vanish from the file, the
 * precise bug the rasterizer was written to kill.
 *
 * Every field is optional; an omitted field means "neutral", which is what lets a definition
 * state only what it actually changes.
 */
export interface TextAnimationOutput {
  /**
   * Fraction of the string that is visible, 0..1. Omit → all of it.
   *
   * Deliberately a fraction rather than a sliced string: the rasterizer needs to lay out the
   * FULL text to keep the box a stable size and only paint the revealed part. Handing it a
   * shortened string instead would shrink the bitmap as the animation ran, and since the
   * compositor places bitmaps by their centre, a centred title would creep sideways while it
   * typed.
   */
  reveal?: number;
  /** Multiplied into the clip's own opacity. */
  opacity?: number;
  /**
   * Offset in fractions of the text's OWN rendered size — `dx: -1` starts it one full text-width
   * to the left. Relative to the text rather than to the frame so a reveal looks the same on a
   * caption and on a full-width title, and identical at 1080p and 4K. Params scale it when an
   * animation wants to travel further than that.
   */
  dx?: number;
  dy?: number;
  /** Multiplied into the clip's scale. */
  scaleX?: number;
  scaleY?: number;
  /** Degrees, added to the clip's rotation. */
  rotate?: number;
  /** GPU passes appended to the clip's effect chain for this frame only. */
  passes?: TextAnimationPass[];
}

export interface TextAnimationDefinition {
  type: string;
  label: string;
  kind: TextAnimationKind;
  params: EffectParamDef[];
  /** Sensible default for `TextAnimation.duration`, in seconds. */
  duration: number;
  /** Pure map of (content, progress, params) → what to draw. No side effects. */
  apply: (input: TextAnimationInput) => TextAnimationOutput;
}

const animations = new Map<string, AnimationDefinition>();
const textAnimations = new Map<string, TextAnimationDefinition>();

export function registerAnimation(def: AnimationDefinition): void {
  animations.set(def.type, def);
}
export function registerTextAnimation(def: TextAnimationDefinition): void {
  textAnimations.set(def.type, def);
}

export const getAnimation = (type: string): AnimationDefinition | undefined => animations.get(type);
export const getTextAnimation = (type: string): TextAnimationDefinition | undefined =>
  textAnimations.get(type);
export const allAnimations = (): AnimationDefinition[] => [...animations.values()];
export const allTextAnimations = (): TextAnimationDefinition[] => [...textAnimations.values()];
export const textAnimationsByKind = (kind: TextAnimationKind): TextAnimationDefinition[] =>
  allTextAnimations().filter((a) => a.kind === kind);

/** Resolve an effect/animation param list to a flat `{ key: default }` value bag. */
export function defaultParams(params: EffectParamDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) out[p.key] = p.default;
  return out;
}
