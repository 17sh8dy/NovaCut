/**
 * Which control each parameter of a transition gets in the Inspector.
 *
 * A pure function of the transition's definition, so it can be tested without a DOM and so the
 * Inspector has no per-shader code at all: a GL transition declares its parameters once (in the
 * generated catalog) and the panel is derived from that.
 *
 *   float            -> slider
 *   sampler2D        -> a dropdown of the built-in greyscale maps
 *   int              -> whole-number slider
 *   bool             -> toggle
 *   vec2 / ivec2 ... -> one labelled slider per component
 *   vec3 / vec4 + colour -> a colour swatch (and an opacity slider for vec4)
 *
 * A transition's saved `params` stay a flat Record<string, number>; the grouping lives only here
 * and in the definition's `gl.bindings`, which is why nothing about saved projects changed.
 */

import type { EffectParamDef, TransitionDefinition } from '@opencut/core';

export type TransitionControl =
  | { kind: 'slider'; uniform: string; label: string; hint?: string; param: EffectParamDef }
  | { kind: 'integer'; uniform: string; label: string; hint?: string; param: EffectParamDef }
  | { kind: 'toggle'; uniform: string; label: string; hint?: string; param: EffectParamDef }
  | { kind: 'map'; uniform: string; label: string; hint?: string; param: EffectParamDef }
  | { kind: 'vector'; uniform: string; label: string; hint?: string; params: EffectParamDef[]; components: string[]; integer: boolean }
  | { kind: 'color'; uniform: string; label: string; hint?: string; params: EffectParamDef[]; alpha: boolean };

const AXES = ['X', 'Y', 'Z', 'W'];

export function describeTransitionControls(def: TransitionDefinition | undefined): TransitionControl[] {
  if (!def) return [];
  // Nova Cut's own transitions: one slider per param, exactly as before.
  if (!def.gl) {
    return def.params.map((param) => ({ kind: 'slider', uniform: param.key, label: param.label, param }));
  }
  const byKey = new Map(def.params.map((p) => [p.key, p]));
  const out: TransitionControl[] = [];
  for (const b of def.gl.bindings) {
    const params = b.keys.map((k) => byKey.get(k)).filter((p): p is EffectParamDef => !!p);
    if (params.length !== b.keys.length || params.length === 0) continue; // never draw a half-bound control
    const base = { uniform: b.uniform, label: b.label, ...(b.description ? { hint: b.description } : {}) };
    if (b.color && (b.type === 'vec3' || b.type === 'vec4')) {
      out.push({ ...base, kind: 'color', params, alpha: b.type === 'vec4' });
    } else if (b.type === 'sampler2D') {
      out.push({ ...base, kind: 'map', param: params[0]! });
    } else if (b.type === 'float') {
      out.push({ ...base, kind: 'slider', param: params[0]! });
    } else if (b.type === 'int') {
      out.push({ ...base, kind: 'integer', param: params[0]! });
    } else if (b.type === 'bool') {
      out.push({ ...base, kind: 'toggle', param: params[0]! });
    } else {
      out.push({ ...base, kind: 'vector', params, components: b.componentLabels ?? AXES.slice(0, params.length), integer: b.type.startsWith('ivec') });
    }
  }
  return out;
}

/** Every param key a set of controls edits, so a test can prove nothing is missing or doubled. */
export const controlKeys = (controls: TransitionControl[]): string[] =>
  controls.flatMap((c) => ('param' in c ? [c.param.key] : c.params.map((p) => p.key)));

// ── colour helpers (0..1 floats <-> #rrggbb) ─────────────────────────────────────────

const to255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => to255(v).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
