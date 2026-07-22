/**
 * EditorApp — the top-level editor composition.
 *
 * Assembles the workspace from panels and resizable splitters. This component is fully
 * platform-agnostic: it receives an already-constructed store (with its PlatformBridge)
 * and renders the same UI whether that bridge is Electron, web, or mobile.
 */

import { useEffect, useMemo } from 'react';
import { ResizablePanels, Panel } from './components/primitives/index.js';
import { StoreProvider, useStore } from './state/context.js';
import { PlaybackProvider } from './state/playbackContext.js';
import { PhotoProvider } from './state/photoContext.js';
import { useShortcuts } from './state/useShortcuts.js';
import { useAutosave } from './state/useAutosave.js';
import { useRecovery } from './state/useRecovery.js';
import { useAppStore } from './state/context.js';
import type { AppStore } from './state/store.js';
import { TitleBar } from './panels/TitleBar.js';
import { LeftRail, BrowserPanel } from './panels/LeftRail.js';
import { Preview } from './panels/Preview.js';
import { Inspector } from './panels/Inspector.js';
import { Timeline } from './panels/Timeline.js';
import { StatusBar } from './panels/StatusBar.js';
import { Toast } from './panels/Toast.js';
import { ExportDialog } from './panels/ExportDialog.js';
import { ProjectSettingsDialog } from './panels/ProjectSettingsDialog.js';
import { SettingsDialog } from './panels/SettingsDialog.js';
import { HomePage } from './panels/HomePage.js';
import { PhotoEditor } from './panels/PhotoEditor.js';

import './theme/global.css';
import './components/primitives/primitives.css';
import './components/animated/animated.css';
import './panels/panels.css';
import './panels/timeline.css';
import './panels/dialog.css';

export function EditorApp({ store }: { store: AppStore }) {
  return (
    <StoreProvider store={store}>
      <AppRoot />
    </StoreProvider>
  );
}

/** Chooses between the Home launcher and the editor, and applies app-wide root attributes. */
function AppRoot() {
  useRecovery(); // runs on both screens so Home can offer "Recover" after a crash
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.project.settings.theme);
  const reduceMotionAlways = useStore((s) => s.preferences.reduceMotionAlways);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduceMotionAlways);
  }, [reduceMotionAlways]);

  // Keying on the view name replays the enter transition whenever we switch screens,
  // giving Home ↔ Editor a smooth cross-fade instead of a hard cut.
  return (
    <div className="oc-view" key={view}>
      {view === 'home' && <HomePage />}
      {view === 'photo' && <PhotoWorkspace />}
      {view === 'editor' && (
        <PlaybackProvider>
          <EditorLayout />
        </PlaybackProvider>
      )}
    </div>
  );
}

/**
 * The photo workspace and its store, mounted only while that view is active — so its document,
 * undo stack and GPU resources are created on entry and released on exit. It borrows the host
 * services it needs (bridge, toasts) from the app store rather than owning duplicates.
 */
function PhotoWorkspace() {
  const store = useAppStore();
  const host = useMemo(
    () => ({
      bridge: store.getState().bridge,
      notify: (title: string, kind?: 'info' | 'success' | 'error', body?: string) =>
        store.getState().notify(title, kind, body),
    }),
    [store],
  );
  return (
    <PhotoProvider host={host}>
      <PhotoEditor />
      <Toast />
    </PhotoProvider>
  );
}

function EditorLayout() {
  useShortcuts();
  useAutosave();
  const dialog = useStore((s) => s.dialog);
  const isPlaying = useStore((s) => s.isPlaying);
  const reduceMotionDuringPlayback = useStore((s) => s.preferences.reduceMotionDuringPlayback);

  // Freeze UI transitions during playback (pref-gated) for smoother, less distracting playback.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-playing', isPlaying && reduceMotionDuringPlayback);
  }, [isPlaying, reduceMotionDuringPlayback]);

  return (
    <div className="app-shell">
      <TitleBar />

      <div className="oc-workspace">
        <ResizablePanels direction="vertical" initial={[3, 2]} min={[220, 160]}>
          {/* Top row: browser · preview · inspector */}
          <ResizablePanels direction="horizontal" initial={[1, 2.4, 1]} min={[240, 360, 240]}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', width: '100%', minWidth: 0 }}>
              <LeftRail />
              <BrowserPanel />
            </div>
            <Panel title="Preview">
              <Preview />
            </Panel>
            <Panel title="Inspector">
              <Inspector />
            </Panel>
          </ResizablePanels>

          {/* Bottom: timeline */}
          <Timeline />
        </ResizablePanels>
      </div>

      <StatusBar />
      <Toast />
      <RecoveryPrompt />

      {dialog === 'export' && <ExportDialog />}
      {dialog === 'projectSettings' && <ProjectSettingsDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {/* Same window, opened straight onto the shortcut editor (Help → Keyboard Shortcuts). */}
      {dialog === 'shortcuts' && <SettingsDialog initialCategory="Keyboard Shortcuts" />}
    </div>
  );
}

/** Offered on startup when the previous session closed unexpectedly. */
function RecoveryPrompt() {
  const store = useAppStore();
  const recovery = useStore((s) => s.recovery);
  if (!recovery) return null;
  const when = new Date(recovery.savedAt).toLocaleString();
  return (
    <div className="oc-recovery" role="dialog" aria-label="Session recovery">
      <div className="oc-recovery__body">
        <strong>Restore your previous session?</strong>
        <span>
          Open Cut may have closed unexpectedly. A recovery of “{recovery.projectName}” from {when} is
          available (timeline, media, effects, playhead, zoom &amp; selection).
        </span>
      </div>
      <div className="oc-recovery__actions">
        <button className="oc-btn" onClick={() => store.getState().dismissRecovery()}>
          Discard
        </button>
        <button className="oc-btn oc-btn--primary" onClick={() => store.getState().restoreRecovery()}>
          Restore
        </button>
      </div>
    </div>
  );
}
