/** Shares the single PlaybackEngine instance across the app (preview, transport, timeline). */
import { createContext, useContext, type ReactNode } from 'react';
import { usePlaybackEngine, type PlaybackEngine } from './usePlaybackEngine.js';

const PlaybackContext = createContext<PlaybackEngine | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const engine = usePlaybackEngine();
  return <PlaybackContext.Provider value={engine}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackEngine {
  const engine = useContext(PlaybackContext);
  if (!engine) throw new Error('usePlayback must be used within a PlaybackProvider');
  return engine;
}
