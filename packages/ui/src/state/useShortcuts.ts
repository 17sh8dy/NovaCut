/**
 * Global keyboard shortcuts.
 *
 * Editable shortcuts are resolved from the store's `shortcuts` bindings (see shortcuts.ts and
 * the Settings > Keyboard editor); the switch below maps each shortcut id to its action, so
 * remapping a key never changes behavior. A few always-on transport/zoom keys (arrows,
 * Home/End, +/-) remain fixed. Keystrokes while typing in inputs are ignored.
 */

import { useEffect } from 'react';
import { deleteClip, duplicateClip, rippleDeleteClip } from '@opencut/core';
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
      const selected = s.selectedClipIds[0];

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
          case 'delete':
            return selected ? s.dispatch(deleteClip(selected)) : undefined;
          case 'rippleDelete':
            return selected ? s.dispatch(rippleDeleteClip(selected)) : undefined;
          case 'duplicate':
            return selected ? s.dispatch(duplicateClip(selected)) : undefined;
          case 'save':
            return void s.save();
          case 'new':
            return s.newProject();
          case 'open':
            return void (async () => {
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
