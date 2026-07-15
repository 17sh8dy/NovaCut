/**
 * React binding for the photo store, mirroring context.tsx.
 *
 * The provider constructs the store lazily and keeps it for the life of the mount, so the
 * document and its undo stack survive re-renders but are released when the user leaves the
 * photo workspace.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore as useZustand } from 'zustand';
import { createPhotoStore, type PhotoHost, type PhotoStore } from './photoStore.js';

const PhotoContext = createContext<PhotoStore | null>(null);

export function PhotoProvider({ host, children }: { host: PhotoHost; children: ReactNode }) {
  // Lazy initializer: createPhotoStore must run once, not on every render.
  const [store] = useState(() => createPhotoStore(host));
  return <PhotoContext.Provider value={store}>{children}</PhotoContext.Provider>;
}

/** Select a slice of photo state. Re-renders only when the selected value changes. */
export function usePhoto<T>(selector: (s: ReturnType<PhotoStore['getState']>) => T): T {
  const store = useContext(PhotoContext);
  if (!store) throw new Error('usePhoto must be used within a PhotoProvider');
  return useZustand(store, selector);
}

/** Access the raw photo store (for actions / imperative reads outside render). */
export function usePhotoStore(): PhotoStore {
  const store = useContext(PhotoContext);
  if (!store) throw new Error('usePhotoStore must be used within a PhotoProvider');
  return store;
}
