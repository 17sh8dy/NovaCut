/**
 * Autosave. When the project is dirty and has a save location, persist it on an interval taken
 * from the Projects preferences. Silent — no toast — so it never interrupts editing. If the
 * project was never saved, autosave holds off until the user picks a location.
 *
 * The interval is re-read on every tick rather than captured once, so changing it in Settings
 * takes effect at the next save instead of at the next app launch. Zero means off, and is
 * checked before scheduling so the timer stops entirely rather than spinning at some floor.
 *
 * ── TWO THINGS HERE ARE LOAD-BEARING ─────────────────────────────────────────────────
 *
 * 1. THE RESCHEDULE IS IN A `finally`. The loop is a self-rescheduling timeout, so an exception
 *    anywhere in the tick used to end it permanently: one transient write failure — a locked
 *    file, a full disk, a network drive blinking — and autosave was dead for the rest of the
 *    session, silently, with the UI still implying it was running. Reproduced before this fix:
 *    the first failing save was also the last tick that ever ran.
 *
 * 2. `dirty` IS ONLY CLEARED IF THE SAVED PROJECT IS STILL THE CURRENT ONE. A save is async, and
 *    the user keeps editing while it is in flight. Clearing the flag unconditionally afterwards
 *    marks those newer edits as saved when what actually reached disk was the older snapshot —
 *    and because the quit guard reads this same flag, the app would then let the window close
 *    without so much as a prompt. Comparing project identity is exact: every command produces a
 *    new project object, so `!==` means "edited since".
 */

import { useEffect } from 'react';
import { useAppStore } from './context.js';

export function useAutosave() {
  const store = useAppStore();

  useEffect(() => {
    let timer = 0;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      const seconds = store.getState().preferences.autosaveInterval;
      if (seconds <= 0) return; // Off: no timer at all.

      timer = window.setTimeout(async () => {
        try {
          const s = store.getState();
          if (s.dirty && s.projectPath) {
            // The exact object being written; compared by identity after the await.
            const saved = s.project;
            await s.bridge.saveProject(saved, s.projectPath);
            if (store.getState().project === saved) store.setState({ dirty: false });
          }
        } catch {
          // Autosave is a safety net, not a user action: a failure here must not raise a dialog
          // or a toast mid-edit. It stays silent and simply tries again at the next interval —
          // which is exactly what the `finally` below guarantees. A save the user asked for
          // reports its failure loudly; see `save` in store.ts.
        } finally {
          schedule();
        }
      }, seconds * 1000);
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [store]);
}
