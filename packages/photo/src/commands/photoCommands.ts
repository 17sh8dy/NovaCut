/**
 * Photo editing operations, expressed as Commands.
 *
 * Each factory returns a Command<PhotoDocument> whose `apply` is a pure document→document
 * transform built from the mutation helpers. Core's History turns them into undo steps —
 * the same History the video editor uses, reached through its TDoc type parameter. Nothing
 * here touches UI or platform APIs.
 */

import {
  constant,
  getEffectDef,
  instantiateEffect,
  type Command,
  type EffectInstanceId,
  type MediaAsset,
} from '@opencut/core';
import type { LayerId } from '../model/ids.js';
import { createLayer } from '../model/factory.js';
import type { PhotoDocument } from '../model/types.js';
import {
  addEffect,
  addLayer,
  addMedia,
  removeEffect,
  removeLayer,
  reorderLayer,
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
      return addLayer(sized, createLayer(media.name || 'Layer', media));
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

export function moveLayer(layerId: LayerId, toIndex: number): PhotoCommand {
  return { label: 'Reorder Layer', apply: (doc) => reorderLayer(doc, layerId, toIndex) };
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
      // instantiateEffect THROWS on an unknown key rather than returning undefined, and this
      // runs inside History.dispatch — an unregistered type would escape as a UI crash. Probe
      // the registry first and degrade to a no-op, which dispatch drops via its === check.
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
 * the compositor's `sample()` reads straight through to the static value.
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
export function moveLayerEffect(layerId: LayerId, effectId: EffectInstanceId, toIndex: number): PhotoCommand {
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
