/**
 * Autosave. When the project is dirty and has a save location, persist it on a fixed
 * interval (from project settings). Silent — no toast — so it never interrupts editing.
 * If the project was never saved, autosave holds off until the user picks a location.
 */

import { useEffect } from 'react';
import { useAppStore } from './context.js';

export function useAutosave() {
  const store = useAppStore();

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const interval = store.getState().project.settings.autosaveIntervalMs;
      timer = window.setTimeout(async () => {
        const s = store.getState();
        if (s.dirty && s.projectPath) {
          await s.bridge.saveProject(s.project, s.projectPath);
          store.setState({ dirty: false });
        }
        schedule();
      }, Math.max(15000, interval));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [store]);
}
