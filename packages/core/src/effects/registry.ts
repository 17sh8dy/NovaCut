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
}

export type EffectCategory =
  | 'blur' | 'stylize' | 'color' | 'distort' | 'glitch' | 'time';

export interface EffectDefinition {
  type: string;
  label: string;
  category: EffectCategory;
  /** GLSL program key the compositor resolves. 'passthrough' = CPU/no-op placeholder. */
  render: string;
  params: EffectParamDef[];
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
  allEffects().filter((e) => e.category === cat);

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
// OpenCut renders effects at four different layers (see EFFECTS_FRAMEWORK.md): GPU pixel
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

export interface TextAnimationInput {
  /** The clip's full text content. */
  content: string;
  /** Progress through the clip, 0..1. */
  progress: number;
  /** Resolved param values for this instance. */
  params: Record<string, number>;
}

export interface TextAnimationOutput {
  /** Text to display this frame (e.g. a prefix for typewriter). Omit → show full content. */
  content?: string;
  /** Inline style overrides merged onto the text element (opacity, transform, filter, …). */
  style?: Record<string, string | number>;
}

export interface TextAnimationDefinition {
  type: string;
  label: string;
  params: EffectParamDef[];
  /** Pure map of (content, progress, params) → what the overlay renders. No side effects. */
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

/** Resolve an effect/animation param list to a flat `{ key: default }` value bag. */
export function defaultParams(params: EffectParamDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) out[p.key] = p.default;
  return out;
}
