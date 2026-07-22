/**
 * Keyboard shortcuts for the photo workspace.
 *
 * Bound on `window` at capture time so they work wherever focus happens to be — except in a
 * text field, which is checked first. A photo editor where Delete only works if you remembered
 * to click the canvas is a photo editor people stop using the keyboard in.
 *
 * The bindings are the ones muscle memory already knows from Photoshop and Figma. Inventing
 * better ones is not a service to anybody.
 */

import { useEffect } from 'react';
import {
  alignLayers,
  clearSelection as clearSelectionOp,
  deleteLayer,
  deselect,
  duplicateLayer,
  groupSelection,
  hasSelection,
  invertSelection,
  moveLayer,
  parentOf,
  selectAllPixels,
  setLayerTransform,
  setLayerVisible,
  ungroup,
  isGroupLayer,
  isRasterLayer,
  type LayerId,
} from '@opencut/photo';
import type { PhotoStore } from '../../state/photoStore.js';
import { naturalSizeOf } from './layerGeometry.js';

/**
 * Brush size steps proportionally, not by a fixed amount.
 *
 * `[` and `]` on a 4px pencil and on a 400px airbrush have to feel like the same gesture; a
 * flat ±1 would take four hundred presses to cross the range, and a flat ±20 would make the
 * pencil unusable.
 */
const brushStep = (size: number): number => Math.max(1, Math.round(size * 0.15));

/** Nudge distance in canvas pixels; Shift makes it a big step. */
const NUDGE = 1;
const NUDGE_BIG = 10;

export function usePhotoShortcuts(store: PhotoStore) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      // A dialog owns the keyboard while it is open; Escape is the modal's own business.
      if (s.dialog) return;
      if (isTypingTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;
      const selection = s.selection;
      const primary = s.selectedLayerId;

      // ── Modified ──
      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) s.redo();
            else s.undo();
            return;
          case 'y':
            e.preventDefault();
            s.redo();
            return;
          case 'a':
            e.preventDefault();
            // Shift is the pixel version, matching Select > All vs. selecting layers.
            if (e.shiftKey) s.dispatch(selectAllPixels());
            else s.selectAll();
            return;
          case 'i':
            if (!e.shiftKey) return;
            e.preventDefault();
            s.dispatch(invertSelection());
            return;
          case 'c':
            e.preventDefault();
            s.copySelection();
            return;
          case 'v':
            // Note: an actual clipboard IMAGE paste is handled separately, on the paste event —
            // the keydown cannot read clipboard contents.
            e.preventDefault();
            s.pasteClipboard();
            return;
          case 'd':
            // Photoshop's binding: Ctrl+D deselects, Ctrl+J duplicates. Worth matching even
            // though it moves duplicate off the key it had in the previous slice — muscle
            // memory for Deselect is far stronger, and a wrong Ctrl+D is a lost selection.
            e.preventDefault();
            s.dispatch(deselect());
            return;
          case 'j':
            e.preventDefault();
            for (const id of selection) s.dispatch(duplicateLayer(id));
            return;
          case 'g':
            e.preventDefault();
            if (e.shiftKey) {
              for (const id of selection) {
                const layer = find(s, id);
                if (layer && isGroupLayer(layer)) s.dispatch(ungroup(id));
              }
            } else if (selection.length > 1) {
              s.dispatch(groupSelection(selection));
            }
            return;
          case 'e':
            e.preventDefault();
            s.setDialog('export');
            return;
          case 'n':
            e.preventDefault();
            s.setDialog('newCanvas');
            return;
          case '0':
            e.preventDefault();
            s.fitToWindow();
            return;
          case '1':
            e.preventDefault();
            s.setViewport({ zoom: 1, panX: 0, panY: 0, autoFit: false });
            return;
          case '=':
          case '+':
            e.preventDefault();
            s.setViewport({ zoom: Math.min(32, s.viewport.zoom * 1.25), autoFit: false });
            return;
          case '-':
            e.preventDefault();
            s.setViewport({ zoom: Math.max(0.02, s.viewport.zoom / 1.25), autoFit: false });
            return;
          case '[':
          case ']': {
            // Reorder within the layer's own parent, which is what "bring forward" means in a
            // tree — moving it to the document root instead would silently pull it out of its
            // group.
            e.preventDefault();
            if (!primary) return;
            const parent = parentOf(s.doc.layers, primary);
            const siblings = parent && isGroupLayer(parent) ? parent.children : s.doc.layers;
            const at = siblings.findIndex((l) => l.id === primary);
            if (at === -1) return;
            const to = e.key === ']'
              ? (e.shiftKey ? siblings.length : at + 2) // +2: an index in the ORIGINAL list
              : (e.shiftKey ? 0 : at - 1);
            s.dispatch(moveLayer(primary, parent?.id ?? null, to));
            return;
          }
        }
        return;
      }

      // ── Unmodified ──
      switch (e.key) {
        case 'Delete':
        case 'Backspace': {
          // With a marquee up, Delete erases INSIDE it rather than dropping the whole layer —
          // which is what Delete means in every photo editor, and the destructive alternative
          // would be a very surprising way to lose work.
          const layer = primary ? find(s, primary) : undefined;
          if (hasSelection(s.doc.selection) && layer) {
            e.preventDefault();
            if (isRasterLayer(layer)) s.dispatch(clearSelectionOp(layer.id, 'layer'));
            else if (layer.mask) s.dispatch(clearSelectionOp(layer.id, 'mask'));
            else s.dispatch(deleteLayer(layer.id));
            return;
          }
          if (selection.length === 0) return;
          e.preventDefault();
          for (const id of selection) s.dispatch(deleteLayer(id));
          return;
        }
        case 'Escape':
          e.preventDefault();
          if (s.editingTextId) s.setEditingText(null);
          else if (hasSelection(s.doc.selection)) s.dispatch(deselect());
          else if (s.tool !== 'move') s.setTool('move');
          else s.selectLayer(null);
          return;
        case 'Enter':
          // Enter opens the text editor for a selected text layer — the fastest path from
          // "select" to "type" without reaching for the mouse.
          if (primary && find(s, primary)?.kind === 'text') {
            e.preventDefault();
            s.setEditingText(primary);
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (selection.length === 0) return;
          e.preventDefault();
          const step = e.shiftKey ? NUDGE_BIG : NUDGE;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          for (const id of selection) {
            const layer = find(s, id);
            if (!layer) continue;
            s.dispatch(setLayerTransform(id, { x: layer.transform.x + dx, y: layer.transform.y + dy }));
          }
          return;
        }
      }

      switch (e.key.toLowerCase()) {
        case 'v': s.setTool('move'); return;
        case 't': s.setTool('text'); return;
        case 'r': s.setTool('shape'); return;
        case 'c': s.setTool('crop'); return;
        case 'h': s.setTool('hand'); return;
        // The families whose key toggles between their two members, as Photoshop's do.
        case 'm': s.setTool(s.tool === 'select-rect' ? 'select-ellipse' : 'select-rect'); return;
        case 'l': s.setTool(s.tool === 'lasso' ? 'polygon' : 'lasso'); return;
        case 'w': s.setTool('wand'); return;
        case 'b': s.setTool('brush'); return;
        case 'e': s.setTool('eraser'); return;
        case 'g': s.setTool(s.tool === 'bucket' ? 'gradient' : 'bucket'); return;
        case 'x': s.swapColors(); return;
        case '[': s.setBrush({ size: Math.max(1, s.brush.size - brushStep(s.brush.size)) }); return;
        case ']': s.setBrush({ size: Math.min(600, s.brush.size + brushStep(s.brush.size)) }); return;
        case ',':
          // Hide/show, the way Photoshop's eye column works from the keyboard.
          for (const id of selection) {
            const layer = find(s, id);
            if (layer) s.dispatch(setLayerVisible(id, !layer.visible));
          }
          return;
        case 'k': {
          // Centre on the canvas. Moved off `L`, which the lasso family now owns — a selection
          // tool's letter is the stronger convention.
          if (selection.length === 0) return;
          s.dispatch(alignLayers(selection, 'hcenter', (l) => naturalSizeOf(l, s.doc)));
          s.dispatch(alignLayers(selection, 'vcenter', (l) => naturalSizeOf(l, s.doc)));
          return;
        }
      }
    };

    /**
     * Clipboard image paste.
     *
     * A separate listener because only a real `paste` event carries clipboard *data* — a
     * keydown handler cannot read it, for the obvious security reason. Layer paste stays on
     * Ctrl+V; this fires alongside it and only does something when the system clipboard holds
     * an image, so pasting a copied layer and pasting a screenshot never collide.
     */
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      e.preventDefault();
      void store.getState().importFiles(files);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [store]);
}

const find = (s: ReturnType<PhotoStore['getState']>, id: LayerId) => {
  const visit = (layers: readonly ReturnType<PhotoStore['getState']>['doc']['layers'][number][]): typeof layers[number] | undefined => {
    for (const l of layers) {
      if (l.id === id) return l;
      if (l.kind === 'group') {
        const found = visit(l.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(s.doc.layers);
};

/** True when a key event came from a field the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}
