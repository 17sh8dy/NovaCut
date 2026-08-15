/**
 * Global keyboard shortcuts.
 *
 * Editable shortcuts are resolved from the store's `shortcuts` bindings (see shortcuts.ts and
 * the Settings > Keyboard editor); the switch below maps each shortcut id to its action, so
 * remapping a key never changes behavior. A few always-on transport/zoom keys (arrows,
 * Home/End, +/-) remain fixed. Keystrokes while typing in inputs are ignored.
 */

import { useEffect } from 'react';
import { deleteClips, duplicateClips, rippleDeleteClips } from '@opencut/core';
import { useAppStore } from './context.js';
import { usePlayback } from './playbackContext.js';
import { comboFromEvent, comboToId } from './shortcuts.js';

export function useShortcuts() {
  const store = useAppStore();
  const engine = usePlayback();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const s = store.getState();
      /*
       * Nothing here fires while a modal is open.
       *
       * These listen on the window, so they ran straight through an open dialog: Space started
       * playback behind the Export window, and Delete destroyed the selected clip while the user
       * was choosing a codec — with the timeline covered, so the only evidence was a clip that
       * had gone missing by the time the dialog closed. A modal is a modal.
       *
       * Escape is the exception in spirit but not in code: Modal owns its own Escape handler, so
       * leaving early here is exactly what lets Escape close the dialog and nothing else.
       */
      if (s.dialog !== null) return;
      /*
       * The WHOLE selection, not just its first member. Shift-clicking builds a multi-selection
       * and every clip in it draws as selected, but Delete / Ripple Delete / Duplicate each read
       * `selectedClipIds[0]` and acted on one clip — the other four stayed put, still highlighted,
       * looking like the key had not registered.
       */
      const selected = s.selectedClipIds;

      // ── Editable shortcuts (from the registry) ──
      const combo = comboFromEvent(e);
      const id = combo ? comboToId(s.shortcuts)[combo] : undefined;
      if (id) {
        e.preventDefault();
        switch (id) {
          case 'playPause':
            return engine.toggle();
          case 'split':
            return s.splitAtPlayhead();
          case 'undo':
            return s.undo();
          case 'redo':
          case 'redoAlt':
            return s.redo();
          /*
           * Deselect after a delete. The ids would otherwise outlive the clips, and a second
           * Delete on that stale selection dispatches a command that removes nothing — which
           * still rebuilds the project object, so History's `next === prev` junk guard does not
           * catch it and the user gets an undo step that undoes nothing.
           */
          case 'delete':
            if (!selected.length) return;
            s.dispatch(deleteClips(selected));
            return s.selectClip(null);
          case 'rippleDelete':
            if (!selected.length) return;
            s.dispatch(rippleDeleteClips(selected));
            return s.selectClip(null);
          case 'duplicate':
            return selected.length ? s.dispatch(duplicateClips(selected)) : undefined;
          case 'selectAll':
            return s.selectAllClips();
          case 'deselectAll':
            return s.selectClip(null);
          case 'save':
            return void s.save();
          // Both replace the open project, so both ask about unsaved work first.
          case 'new':
            return void (async () => {
              if (!(await s.guardUnsaved())) return;
              s.newProject();
            })();
          case 'open':
            return void (async () => {
              if (!(await s.guardUnsaved())) return;
              const res = await s.bridge.openProjectDialog();
              if (res) s.loadProjectData(res.project, res.path);
            })();
        }
      }

      // ── Fixed transport / zoom extras (not user-remappable) ──
      if (e.key === 'ArrowLeft') return engine.step(e.shiftKey ? -10 : -1);
      if (e.key === 'ArrowRight') return engine.step(e.shiftKey ? 10 : 1);
      if (e.key === 'Home') return engine.seek(0);
      if (e.key === 'End') return engine.seek(s.sequence().duration);
      if (e.key === '=' || e.key === '+') return s.setPixelsPerSecond(s.pixelsPerSecond * 1.3);
      if (e.key === '-' || e.key === '_') return s.setPixelsPerSecond(s.pixelsPerSecond / 1.3);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, engine]);
}
