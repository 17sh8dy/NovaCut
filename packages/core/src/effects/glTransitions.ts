/**
 * GL Transitions, registered into Nova Cut's transition registry.
 *
 * The catalog itself is generated (glTransitions.generated.ts, by scripts/build-gl-transitions.mjs
 * from the pinned `gl-transitions` package). This file only turns each generated entry into an
 * ordinary TransitionDefinition, so everything that already reads the registry — the inspector's
 * parameter sliders, `addTransition`'s default-param seeding, the serialiser — works unchanged.
 *
 * Every entry is namespaced `gl:<name>`, so none can collide with, replace or shadow one of Nova
 * Cut's own transitions (`cube` stays the classic cube; `gl:cube` is the library's).
 *
 * They are offered in the Transitions browser like any other. `hidden` stays available on the
 * definition for anything that should resolve (so a saved project still renders) without being
 * offered.
 */

import { GL_TRANSITIONS } from './glTransitions.generated.js';
import { registerTransition, type EffectParamDef, type GlParamBinding, type TransitionDefinition } from './registry.js';

export interface GlTransitionMeta {
  /** The package's stable name, e.g. 'CrossZoom'. */
  name: string;
  label: string;
  author: string;
  license: string;
  description: string;
  tags: string[];
  category: string;
  featured: boolean;
  /** Flattened numeric params (see the generator). */
  params: EffectParamDef[];
  bindings: GlParamBinding[];
}

/** The registry key of a GL transition. */
export const glTransitionType = (name: string): string => `gl:${name}`;

export function glTransitionDefinition(m: GlTransitionMeta, hidden: boolean): TransitionDefinition {
  return {
    type: glTransitionType(m.name),
    label: m.label,
    render: glTransitionType(m.name),
    params: m.params,
    hidden,
    source: 'gl-transitions',
    category: m.category,
    featured: m.featured,
    tags: m.tags,
    author: m.author,
    license: m.license,
    description: m.description,
    gl: { name: m.name, bindings: m.bindings },
  };
}

/** Register the whole catalog. */
export function registerGlTransitions(hidden = false): void {
  for (const m of GL_TRANSITIONS) registerTransition(glTransitionDefinition(m, hidden));
}
