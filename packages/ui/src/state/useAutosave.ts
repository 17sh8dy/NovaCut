/**
 * Autosave. When the project is dirty and has a save location, persist it on an interval taken
 * from the Projects preferences. Silent — no toast — so it never interrupts editing. If the
 * project was never saved, autosave holds off until the user picks a location.
 *
 * The interval is re-read on every tick rather than captured once, so changing it in Settings
 * takes effect at the next save instead of at the next app launch. Zero means off, and is
 * checked before scheduling so the timer stops entirely rather than spinning at some floor.
 */

import { useEffect } from 'react';
import { useAppStore } from './context.js';

export function useAutosave() {
  const store = useAppStore();

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const seconds = store.getState().preferences.autosaveInterval;
      if (seconds <= 0) return; // Off: no timer at all.
      timer = window.setTimeout(async () => {
        const s = store.getState();
        if (s.dirty && s.projectPath) {
          await s.bridge.saveProject(s.project, s.projectPath);
          store.setState({ dirty: false });
        }
        schedule();
      }, seconds * 1000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [store]);
}
