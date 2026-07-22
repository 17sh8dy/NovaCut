/**
 * Selection commands.
 *
 * The selection lives in the document (see the field's note in `types.ts`), so all of this
 * rides History for free — Ctrl+Z steps back through marquees exactly as it steps back through
 * strokes, and an edit undone is restored alongside the selection it was made under.
 *
 * Marquee drags are coalesced per drag id, so dragging out a rectangle is one undo step rather
 * than one per pointermove. That is the same mechanism the brush uses, for the same reason.
 */

import type { Command } from '@opencut/core';
import type { LayerId } from '../model/ids.js';
import {
  EMPTY_SELECTION,
  combineRegion,
  hasSelection,
  type CombineMode,
  type Selection,
  type SelectionRegion,
} from '../model/selection.js';
import { findLayer } from '../model/tree.js';
import type { PhotoDocument } from '../model/types.js';

type PhotoCommand = Command<PhotoDocument>;

const current = (doc: PhotoDocument): Selection => doc.selection ?? { ...EMPTY_SELECTION, regions: [] };

/**
 * Replace the whole selection.
 *
 * `dragId` opts into coalescing: pass one while a marquee is being dragged so the whole drag is
 * a single undo entry, and omit it for a discrete action (a wand click, a menu command) that
 * genuinely deserves its own step.
 */
export function setSelection(selection: Selection | null, dragId?: string): PhotoCommand {
  return {
    label: 'Select',
    ...(dragId ? { coalesceKey: `select:${dragId}` } : {}),
    apply: (doc) => {
      const next = selection && hasSelection(selection) ? selection : null;
      if (next === null && doc.selection === null) return doc;
      return { ...doc, selection: next, modifiedAt: Date.now() };
    },
  };
}

/** Add one region using its own combine mode. */
export function addSelectionRegion(region: SelectionRegion, dragId?: string): PhotoCommand {
  return {
    label: 'Select',
    ...(dragId ? { coalesceKey: `select:${dragId}` } : {}),
    apply: (doc) => {
      const next = combineRegion(current(doc), region);
      return { ...doc, selection: next, modifiedAt: Date.now() };
    },
  };
}

export function deselect(): PhotoCommand {
  return {
    label: 'Deselect',
    apply: (doc) => (doc.selection === null ? doc : { ...doc, selection: null, modifiedAt: Date.now() }),
  };
}

/**
 * Select the whole canvas.
 *
 * Expressed as an inverted EMPTY selection rather than a canvas-sized rectangle, so it stays
 * correct after the canvas is resized or cropped — a stored rectangle would silently become a
 * partial selection the moment the frame changed.
 */
export function selectAllPixels(): PhotoCommand {
  return {
    label: 'Select All',
    apply: (doc) => ({
      ...doc,
      selection: { regions: [], feather: 0, expand: 0, inverted: true },
      modifiedAt: Date.now(),
    }),
  };
}

export function invertSelection(): PhotoCommand {
  return {
    label: 'Invert Selection',
    apply: (doc) => {
      const sel = doc.selection;
      // Inverting nothing selects everything, which is what Photoshop does and what makes
      // "invert" usable as a way to select all without reaching for another command.
      const next: Selection = sel
        ? { ...sel, inverted: !sel.inverted }
        : { regions: [], feather: 0, expand: 0, inverted: true };
      return { ...doc, selection: next, modifiedAt: Date.now() };
    },
  };
}

/** Feather and expand/contract, both coalesced so a slider drag is one step. */
export function setSelectionModifier(patch: { feather?: number; expand?: number }): PhotoCommand {
  const keys = Object.keys(patch).sort().join(',');
  return {
    label: patch.feather !== undefined ? 'Feather Selection' : 'Expand Selection',
    coalesceKey: `selmod:${keys}`,
    apply: (doc) => {
      if (!doc.selection) return doc;
      const next = { ...doc.selection, ...patch };
      if (next.feather === doc.selection.feather && next.expand === doc.selection.expand) return doc;
      return { ...doc, selection: next, modifiedAt: Date.now() };
    },
  };
}

/**
 * Select the opaque pixels of a layer.
 *
 * Only meaningful for layers whose silhouette is already geometry — a shape. For everything
 * else the answer lives in pixels the document does not hold, so this reports "no" by leaving
 * the document alone rather than producing a rectangle and calling it the subject.
 */
export function selectLayerBounds(layerId: LayerId, region: SelectionRegion): PhotoCommand {
  return {
    label: 'Select Layer',
    apply: (doc) => {
      if (!findLayer(doc.layers, layerId)) return doc;
      return { ...doc, selection: combineRegion(current(doc), region), modifiedAt: Date.now() };
    },
  };
}

/** The combine mode a fresh region should use, given what is already selected. */
export const resolveCombine = (mode: CombineMode, existing: Selection | null): CombineMode =>
  // Subtracting from nothing, or intersecting with nothing, would silently produce nothing at
  // all — which reads as the tool being broken. With no selection every mode is a replace.
  hasSelection(existing) ? mode : 'replace';
