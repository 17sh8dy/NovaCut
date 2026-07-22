/**
 * Photo editing operations, expressed as Commands.
 *
 * Each factory returns a Command<PhotoDocument> whose `apply` is a pure document→document
 * transform built from the mutation helpers. Core's History turns them into undo steps — the
 * same History the video editor uses, reached through its TDoc type parameter. Nothing here
 * touches UI or platform APIs.
 *
 * Two rules every command in here follows:
 *   • **Never throw.** `apply` runs inside History.dispatch, where a throw escapes as a UI
 *     crash. Anything that could fail (an unknown effect key, a missing layer) degrades to
 *     returning the document unchanged, which dispatch drops via its `next === prev` check.
 *   • **Never bake pixels.** Every operation stays a description. That is the whole promise of
 *     the editor: a crop is a transform, an adjustment is a layer, a filter is a stack entry.
 */

import {
  constant,
  getEffectDef,
  instantiateEffect,
  type Command,
  type EffectInstanceId,
  type MediaAsset,
} from '@opencut/core';
import type { BlendMode } from '../model/blend.js';
import type { Glow, Shadow, Stroke } from '../model/paint.js';
import { cloneFill, createAdjustmentLayer, createGroupLayer, createImageLayer } from '../model/factory.js';
import { newLayerId, type LayerId } from '../model/ids.js';
import { findLayer, parentOf } from '../model/tree.js';
import type { ColorLabel, Layer, PhotoDocument, Transform2D } from '../model/types.js';
import { IDENTITY_TRANSFORM, isGroupLayer } from '../model/types.js';
import {
  addEffect,
  addLayer,
  addMedia,
  groupLayers,
  moveLayerTo,
  removeEffect,
  removeLayer,
  ungroupLayer,
  updateEffect,
  updateLayer,
} from './mutations.js';

type PhotoCommand = Command<PhotoDocument>;

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Import a still as a new top layer. When the document is still empty the canvas adopts the
 * image's pixel size, so the first import defines the working resolution and renders 1:1.
 */
export function importImage(media: MediaAsset): PhotoCommand {
  return {
    label: 'Import Image',
    apply: (doc) => {
      const withMedia = addMedia(doc, media);
      const sized =
        doc.layers.length === 0 && media.width && media.height
          ? { ...withMedia, width: media.width, height: media.height }
          : withMedia;
      return addLayer(sized, createImageLayer(media.name || 'Layer', media));
    },
  };
}

export function deleteLayer(layerId: LayerId): PhotoCommand {
  return { label: 'Delete Layer', apply: (doc) => removeLayer(doc, layerId) };
}

export function renameLayer(layerId: LayerId, name: string): PhotoCommand {
  return {
    label: 'Rename Layer',
    coalesceKey: `rename:${layerId}`,
    apply: (doc) => updateLayer(doc, layerId, (l) => (l.name === name ? l : { ...l, name })),
  };
}

export function setLayerVisible(layerId: LayerId, visible: boolean): PhotoCommand {
  return {
    label: visible ? 'Show Layer' : 'Hide Layer',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => (l.visible === visible ? l : { ...l, visible })),
  };
}

export function setLayerLocked(layerId: LayerId, locked: boolean): PhotoCommand {
  return {
    label: locked ? 'Lock Layer' : 'Unlock Layer',
    apply: (doc) => updateLayer(doc, layerId, (l) => (l.locked === locked ? l : { ...l, locked })),
  };
}

/** Coalesced: an opacity drag collapses into one undo step. */
export function setLayerOpacity(layerId: LayerId, opacity: number): PhotoCommand {
  const clamped = Math.max(0, Math.min(1, opacity));
  return {
    label: 'Layer Opacity',
    coalesceKey: `opacity:${layerId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => (l.opacity === clamped ? l : { ...l, opacity: clamped })),
  };
}

export function setLayerBlendMode(layerId: LayerId, blendMode: BlendMode): PhotoCommand {
  return {
    label: 'Blend Mode',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => (l.blendMode === blendMode ? l : { ...l, blendMode })),
  };
}

export function setLayerColorLabel(layerId: LayerId, colorLabel: ColorLabel | null): PhotoCommand {
  return {
    label: 'Color Label',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if ((l.colorLabel ?? null) === colorLabel) return l;
        const next = { ...l };
        if (colorLabel) next.colorLabel = colorLabel;
        else delete next.colorLabel;
        return next;
      }),
  };
}

/** Toggle "clip to the layer below". */
export function setLayerClipped(layerId: LayerId, clipped: boolean): PhotoCommand {
  return {
    label: clipped ? 'Create Clipping Mask' : 'Release Clipping Mask',
    apply: (doc) => updateLayer(doc, layerId, (l) => (l.clipped === clipped ? l : { ...l, clipped })),
  };
}

/** Twist a folder open/closed. UI state, but it lives in the document so it persists. */
export function setGroupCollapsed(layerId: LayerId, collapsed: boolean): PhotoCommand {
  return {
    label: collapsed ? 'Collapse Group' : 'Expand Group',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) =>
        !isGroupLayer(l) || l.collapsed === collapsed ? l : { ...l, collapsed },
      ),
  };
}

/** Move a layer within the tree — reorder, or reparent into/out of a group. */
export function moveLayer(layerId: LayerId, toParentId: LayerId | null, toIndex: number): PhotoCommand {
  return { label: 'Reorder Layer', apply: (doc) => moveLayerTo(doc, layerId, toParentId, toIndex) };
}

export function groupSelection(layerIds: readonly LayerId[], name = 'Group'): PhotoCommand {
  return { label: 'Group Layers', apply: (doc) => groupLayers(doc, layerIds, createGroupLayer(name)) };
}

export function ungroup(groupId: LayerId): PhotoCommand {
  return { label: 'Ungroup', apply: (doc) => ungroupLayer(doc, groupId) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patch part of a layer's transform. Coalesced per layer, so a drag on the canvas — which
 * fires one of these per pointermove — collapses into a single undo step.
 */
export function setLayerTransform(layerId: LayerId, patch: Partial<Transform2D>): PhotoCommand {
  return {
    label: 'Transform Layer',
    coalesceKey: `transform:${layerId}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const next = { ...l.transform, ...patch };
        // Compare field-by-field rather than trusting the spread: History's junk-undo guard is
        // a reference check, so a drag that ends where it started must produce the SAME object.
        const same = (Object.keys(next) as (keyof Transform2D)[]).every(
          (k) => next[k] === l.transform[k],
        );
        return same ? l : { ...l, transform: next };
      }),
  };
}

/** Flip in the layer's own axes. Distinct from a negative scale only in how the UI reads it. */
export function flipLayer(layerId: LayerId, axis: 'h' | 'v'): PhotoCommand {
  return {
    label: axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => ({
        ...l,
        transform:
          axis === 'h'
            ? { ...l.transform, flipH: !l.transform.flipH }
            : { ...l.transform, flipV: !l.transform.flipV },
      })),
  };
}

/** Back to identity. A reset on an already-identity layer is a no-op, not an undo step. */
export function resetLayerTransform(layerId: LayerId): PhotoCommand {
  return {
    label: 'Reset Transform',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const keys = Object.keys(IDENTITY_TRANSFORM) as (keyof Transform2D)[];
        if (keys.every((k) => l.transform[k] === IDENTITY_TRANSFORM[k])) return l;
        return { ...l, transform: { ...IDENTITY_TRANSFORM } };
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adjustment layers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add an adjustment layer above `aboveLayerId` (or at the top of the stack).
 *
 * This is the non-destructive core of the editor: the result is an EffectInstance re-evaluated
 * against the live backdrop on every draw, so its params stay draggable forever and reordering
 * it re-renders rather than re-decodes.
 */
export function addAdjustmentLayer(type: string, name?: string): PhotoCommand {
  return {
    label: 'Add Adjustment Layer',
    apply: (doc) => {
      // createAdjustmentLayer calls instantiateEffect, which THROWS on an unknown key. Probe
      // the registry first: this runs inside dispatch, where a throw is a UI crash.
      const def = getEffectDef(type);
      if (!def) return doc;
      return addLayer(doc, createAdjustmentLayer(type, name ?? def.label));
    },
  };
}

/** Set one param on an adjustment layer. Coalesced, so a slider drag is one undo step. */
export function setAdjustmentParam(layerId: LayerId, key: string, value: number): PhotoCommand {
  return {
    label: 'Adjust',
    coalesceKey: `adj:${layerId}:${key}`,
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        if (l.kind !== 'adjustment') return l;
        if (l.adjustment.params[key]?.static === value) return l;
        return {
          ...l,
          adjustment: {
            ...l.adjustment,
            params: { ...l.adjustment.params, [key]: constant(value) },
          },
        };
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a filter to a layer by registry key. `instantiateEffect` is core's — so a photo layer's
 * effect is byte-identical to a video clip's, and any filter registered for one product is
 * immediately usable in the other.
 */
export function addLayerEffect(layerId: LayerId, type: string): PhotoCommand {
  return {
    label: 'Add Effect',
    apply: (doc) => {
      if (!getEffectDef(type)) return doc;
      return addEffect(doc, layerId, instantiateEffect(type));
    },
  };
}

export function deleteLayerEffect(layerId: LayerId, effectId: EffectInstanceId): PhotoCommand {
  return { label: 'Remove Effect', apply: (doc) => removeEffect(doc, layerId, effectId) };
}

export function setEffectEnabled(
  layerId: LayerId,
  effectId: EffectInstanceId,
  enabled: boolean,
): PhotoCommand {
  return {
    label: enabled ? 'Enable Effect' : 'Disable Effect',
    apply: (doc) =>
      updateEffect(doc, layerId, effectId, (e) => (e.enabled === enabled ? e : { ...e, enabled })),
  };
}

/**
 * Set one effect param. Coalesced per (effect, param) so a slider drag is one undo step.
 *
 * The value is wrapped with `constant()` because core's EffectInstance types params as
 * AnimatedValue. A still never keyframes, so this always writes an empty keyframe list and
 * the renderer's `sample()` reads straight through to the static value.
 */
export function setEffectParam(
  layerId: LayerId,
  effectId: EffectInstanceId,
  key: string,
  value: number,
): PhotoCommand {
  return {
    label: 'Adjust Effect',
    coalesceKey: `param:${effectId}:${key}`,
    apply: (doc) =>
      updateEffect(doc, layerId, effectId, (e) => {
        if (e.params[key]?.static === value) return e;
        return { ...e, params: { ...e.params, [key]: constant(value) } };
      }),
  };
}

/** Reorder the filter stack on a layer; effects apply bottom-up, so order is visible. */
export function moveLayerEffect(
  layerId: LayerId,
  effectId: EffectInstanceId,
  toIndex: number,
): PhotoCommand {
  return {
    label: 'Reorder Effect',
    apply: (doc) =>
      updateLayer(doc, layerId, (l) => {
        const from = l.effects.findIndex((e) => e.id === effectId);
        if (from === -1) return l;
        const to = Math.max(0, Math.min(l.effects.length - 1, toIndex));
        if (to === from) return l;
        const effects = [...l.effects];
        const [moved] = effects.splice(from, 1);
        effects.splice(to, 0, moved!);
        return { ...l, effects };
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export function renameDocument(name: string): PhotoCommand {
  return {
    label: 'Rename',
    coalesceKey: 'rename:doc',
    apply: (doc) => (doc.name === name ? doc : { ...doc, name, modifiedAt: Date.now() }),
  };
}

export function setBackground(background: string): PhotoCommand {
  return {
    label: 'Background',
    coalesceKey: 'background',
    apply: (doc) =>
      doc.background === background ? doc : { ...doc, background, modifiedAt: Date.now() },
  };
}

/**
 * Resize the canvas. Layers keep their transforms, so this crops/extends the frame around the
 * composition rather than rescaling it — Photoshop's Canvas Size, not Image Size.
 */
export function resizeCanvas(width: number, height: number): PhotoCommand {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return {
    label: 'Canvas Size',
    apply: (doc) =>
      doc.width === w && doc.height === h ? doc : { ...doc, width: w, height: h, modifiedAt: Date.now() },
  };
}

/** Duplicate a layer (and its subtree) directly above the original. */
export function duplicateLayer(layerId: LayerId): PhotoCommand {
  return {
    label: 'Duplicate Layer',
    apply: (doc) => {
      const layer = findLayer(doc.layers, layerId);
      if (!layer) return doc;
      const copy = cloneLayer(layer, `${layer.name} copy`);
      // Land it directly above the original wherever that is, including inside a group.
      const parent = parentOf(doc.layers, layerId);
      const siblings = parent && isGroupLayer(parent) ? parent.children : doc.layers;
      const at = siblings.findIndex((l) => l.id === layerId);
      return moveLayerTo(addLayer(doc, copy, parent?.id ?? null), copy.id, parent?.id ?? null, at + 1);
    },
  };
}

/**
 * Deep-copy a layer with fresh ids throughout.
 *
 * Fresh ids for descendants too, not just the root: two layers sharing an id would make every
 * `findLayer` return whichever came first, so selecting one would edit the other.
 */
function cloneLayer(layer: Layer, name?: string): Layer {
  const fresh = {
    ...layer,
    id: newLayerId(),
    name: name ?? layer.name,
    transform: { ...layer.transform },
  };
  if (isGroupLayer(fresh)) return { ...fresh, children: fresh.children.map((c) => cloneLayer(c)) };
  // Drawn layers carry nested paint objects. A shallow spread would leave the copy sharing its
  // original's fill/stroke/shadow, so restyling one would silently restyle the other — the
  // exact bug fresh ids exist to prevent, one level down.
  if (fresh.kind === 'text') {
    return { ...fresh, style: { ...fresh.style, fill: cloneFill(fresh.style.fill), ...clonePaint(fresh.style) } };
  }
  if (fresh.kind === 'shape') {
    return { ...fresh, params: { ...fresh.params }, fill: cloneFill(fresh.fill), ...clonePaint(fresh) };
  }
  return fresh;
}

/** Copy the optional decorations shared by both drawn layer kinds. */
const clonePaint = (src: { stroke: Stroke | null; shadow: Shadow | null; glow: Glow | null }) => ({
  stroke: src.stroke ? { ...src.stroke } : null,
  shadow: src.shadow ? { ...src.shadow } : null,
  glow: src.glow ? { ...src.glow } : null,
});
