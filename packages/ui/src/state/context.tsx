/**
 * React binding for the app store. The desktop/web entry creates a store (with its
 * platform bridge) and drops it into this provider; components consume it via `useStore`.
 * Keeping the store in context (not a module singleton) means multiple editor windows or
 * SSR are possible later without a rewrite.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useStore as useZustand } from 'zustand';
import type { AppStore } from './store.js';

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** Select a slice of app state. Re-renders only when the selected value changes. */
export function useStore<T>(selector: (s: ReturnType<AppStore['getState']>) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used within a StoreProvider');
  return useZustand(store, selector);
}

/** Access the raw store (for actions / imperative reads outside render). */
export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStore must be used within a StoreProvider');
  return store;
}
