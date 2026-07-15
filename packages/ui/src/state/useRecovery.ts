/**
 * Drives crash recovery: takes snapshots on a 30s interval, after edits (debounced), and
 * before the window closes; and on startup detects an unclean previous session to offer a
 * restore. See recovery.ts for the storage details.
 */

import { useEffect } from 'react';
import { useAppStore } from './context.js';
import {
  latestSnapshot,
  markSessionClosed,
  markSessionOpen,
  wasPreviousSessionUnclean,
  writeSnapshot,
  type RecoveryReason,
} from './recovery.js';

const INTERVAL_MS = 30_000;
const EDIT_DEBOUNCE_MS = 2_000;

export function useRecovery() {
  const store = useAppStore();

  useEffect(() => {
    // Startup: if the last session didn't close cleanly and we have a snapshot, offer it.
    // (Runs before markSessionOpen so we read the *previous* session's flag.)
    if (wasPreviousSessionUnclean()) {
      const snap = latestSnapshot();
      if (snap) store.getState().offerRecovery(snap);
    }
    markSessionOpen();

    const snapshot = (reason: RecoveryReason) => {
      const s = store.getState();
      writeSnapshot(
        {
          project: s.project,
          playhead: s.playhead,
          pixelsPerSecond: s.pixelsPerSecond,
          selectedClipIds: s.selectedClipIds,
        },
        reason,
      );
    };

    // 1) Every 30 seconds while there are unsaved changes.
    const interval = window.setInterval(() => {
      if (store.getState().dirty) snapshot('interval');
    }, INTERVAL_MS);

    // 2) After important edits — the project object identity changes on every command.
    //    Debounced so a burst of edits produces a single snapshot.
    let lastProject = store.getState().project;
    let editTimer = 0;
    const unsub = store.subscribe((s) => {
      if (s.project !== lastProject) {
        lastProject = s.project;
        window.clearTimeout(editTimer);
        editTimer = window.setTimeout(() => snapshot('edit'), EDIT_DEBOUNCE_MS);
      }
    });

    // 3) Before the app closes — final snapshot, then mark this session as cleanly closed.
    const onBeforeUnload = () => {
      snapshot('exit');
      markSessionClosed();
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(editTimer);
      unsub();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [store]);
}
