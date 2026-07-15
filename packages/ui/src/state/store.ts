/**
 * The app store (Zustand).
 *
 * This is the single connection point between React and the core domain. Components read
 * slices of state and call actions; actions run Commands through the History and mirror the
 * resulting Project into the store so React re-renders. The store also holds transient UI
 * state (selection, zoom, dialogs) that never belongs in the persisted project.
 */

import { create } from 'zustand';
import type { RecoverySnapshot } from './recovery.js';
import { restoreProject } from './recovery.js';
import {
  loadPreferences,
  savePreferences,
  DEFAULT_PREFERENCES,
  type AppPreferences,
} from './preferences.js';
import {
  resolveBindings,
  saveOverrides,
  defaultBindings,
  type Bindings,
  type ShortcutId,
} from './shortcuts.js';
import {
  addClip,
  addMedia as addMediaCommand,
  createClipFromMedia,
  createProject,
  newClipId,
  splitClipsAt,
  getActiveSequence,
  History,
  registerBuiltins,
  seconds,
  serializeProject,
  type Clip,
  type ClipId,
  type Command,
  type MediaAsset,
  type PlatformBridge,
  type Project,
  type Sequence,
  type Ticks,
  type TrackId,
} from '@opencut/core';

registerBuiltins();

export type PanelId = 'media' | 'effects' | 'transitions' | 'text' | 'audio' | 'captions';
export type InspectorTab = 'transform' | 'effects' | 'audio' | 'speed' | 'text';
export type DialogId = 'export' | 'projectSettings' | 'newProject' | 'shortcuts' | 'settings' | null;
/** Which top-level screen is showing: the Home launcher, or one of the editor workspaces. */
export type AppView = 'home' | 'editor' | 'photo';

export interface ImportProgress {
  total: number;
  done: number;
  currentFile: string;
}

interface AppState {
  bridge: PlatformBridge;
  history: History;
  project: Project;
  projectPath: string | null;
  dirty: boolean;

  // Selection
  selectedClipIds: ClipId[];
  selectedMediaIds: string[];

  // Playback (mirrors the engine clock)
  isPlaying: boolean;
  playhead: Ticks;
  playbackSpeed: number;
  loop: boolean;

  // UI
  view: AppView;
  preferences: AppPreferences;
  shortcuts: Bindings;
  activePanel: PanelId;
  inspectorTab: InspectorTab;
  dialog: DialogId;
  /** Timeline horizontal zoom in pixels-per-second. */
  pixelsPerSecond: number;
  snapEnabled: boolean;
  rippleEnabled: boolean;
  /** Transient: timeline position (ticks) of the active magnetic snap guide, or null. */
  snapGuide: Ticks | null;
  search: string;
  importProgress: ImportProgress | null;
  toast: { id: number; title: string; body?: string; kind: 'info' | 'success' | 'error' } | null;
  /** A recoverable session offered after an unclean shutdown, or null. */
  recovery: RecoverySnapshot | null;
  /** Set by Home's "Import Media" so the Media Library opens the import dialog once mounted. */
  pendingImport: boolean;

  // Derived helpers
  sequence: () => Sequence;
  selectedClip: () => Clip | undefined;

  // Actions
  dispatch: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Split at the playhead: selected clips it bisects, or every clip under it if none selected. */
  splitAtPlayhead: () => void;

  selectClip: (id: ClipId | null, additive?: boolean) => void;
  selectMedia: (ids: string[]) => void;

  setPlaying: (playing: boolean) => void;
  setPlayhead: (t: Ticks) => void;
  setPlaybackSpeed: (s: number) => void;
  toggleLoop: () => void;

  setView: (v: AppView) => void;
  setPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  resetPreferences: () => void;
  setShortcut: (id: ShortcutId, combo: string) => void;
  resetShortcut: (id: ShortcutId) => void;
  resetAllShortcuts: () => void;
  setActivePanel: (p: PanelId) => void;
  setInspectorTab: (t: InspectorTab) => void;
  openDialog: (d: DialogId) => void;
  setPendingImport: (v: boolean) => void;
  setPixelsPerSecond: (pps: number) => void;
  toggleSnap: () => void;
  toggleRipple: () => void;
  setSnapGuide: (t: Ticks | null) => void;
  setSearch: (q: string) => void;
  notify: (title: string, kind?: 'info' | 'success' | 'error', body?: string) => void;

  // Crash recovery
  offerRecovery: (snap: RecoverySnapshot) => void;
  restoreRecovery: () => void;
  dismissRecovery: () => void;

  // Project lifecycle
  newProject: (name?: string) => void;
  loadProjectData: (project: Project, path: string | null) => void;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;

  // Media
  addMedia: (assets: MediaAsset[]) => void;
  setImportProgress: (p: ImportProgress | null) => void;
  addMediaToTimeline: (media: MediaAsset, trackId?: TrackId, at?: Ticks) => void;
}

export function createAppStore(bridge: PlatformBridge) {
  const initial = createProject();
  const history = new History(initial);
  const preferences = loadPreferences();

  return create<AppState>((set, get) => ({
    bridge,
    history,
    project: initial,
    projectPath: null,
    dirty: false,

    selectedClipIds: [],
    selectedMediaIds: [],

    isPlaying: false,
    playhead: 0,
    playbackSpeed: 1,
    loop: false,

    view: preferences.showHomeOnLaunch ? 'home' : 'editor',
    preferences,
    shortcuts: resolveBindings(),
    activePanel: 'media',
    inspectorTab: 'transform',
    dialog: null,
    pixelsPerSecond: 60,
    snapEnabled: true,
    rippleEnabled: false,
    snapGuide: null,
    search: '',
    importProgress: null,
    toast: null,
    recovery: null,
    pendingImport: false,

    sequence: () => getActiveSequence(get().project),
    selectedClip: () => {
      const { project, selectedClipIds } = get();
      if (selectedClipIds.length === 0) return undefined;
      const seq = getActiveSequence(project);
      const id = selectedClipIds[0];
      for (const t of seq.tracks) {
        const c = t.clips.find((cl) => cl.id === id);
        if (c) return c;
      }
      return undefined;
    },

    dispatch: (command) => {
      const project = get().history.dispatch(command);
      set({ project, dirty: true });
    },
    undo: () => set({ project: get().history.undo(), dirty: true }),
    redo: () => set({ project: get().history.redo(), dirty: true }),
    canUndo: () => get().history.canUndo,
    canRedo: () => get().history.canRedo,

    splitAtPlayhead: () => {
      const s = get();
      const time = s.playhead;
      const seq = s.sequence();
      const selected = new Set(s.selectedClipIds);
      const restrict = selected.size > 0;
      const specs: { clipId: ClipId; rightId: ClipId }[] = [];
      for (const track of seq.tracks) {
        if (track.locked) continue;
        for (const c of track.clips) {
          if (restrict && !selected.has(c.id)) continue;
          if (time > c.start && time < c.start + c.duration) {
            specs.push({ clipId: c.id, rightId: newClipId() });
          }
        }
      }
      if (specs.length === 0) return;
      get().dispatch(splitClipsAt(specs, time));
      set({ selectedClipIds: specs.map((x) => x.rightId) }); // select the new right halves
    },

    selectClip: (id, additive = false) => {
      if (id === null) return set({ selectedClipIds: [] });
      const cur = get().selectedClipIds;
      if (additive) {
        set({ selectedClipIds: cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id] });
      } else {
        set({ selectedClipIds: [id], inspectorTab: get().inspectorTab });
      }
    },
    selectMedia: (ids) => set({ selectedMediaIds: ids }),

    setPlaying: (isPlaying) => set({ isPlaying }),
    setPlayhead: (playhead) => set({ playhead }),
    setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
    toggleLoop: () => set({ loop: !get().loop }),

    setView: (view) => set({ view }),
    setPreference: (key, value) => {
      const preferences = { ...get().preferences, [key]: value };
      savePreferences(preferences);
      set({ preferences });
    },
    resetPreferences: () => {
      savePreferences(DEFAULT_PREFERENCES);
      set({ preferences: { ...DEFAULT_PREFERENCES } });
    },
    setShortcut: (id, combo) => {
      const shortcuts = { ...get().shortcuts, [id]: combo };
      saveOverrides(shortcuts);
      set({ shortcuts });
    },
    resetShortcut: (id) => {
      const shortcuts = { ...get().shortcuts, [id]: defaultBindings()[id] };
      saveOverrides(shortcuts);
      set({ shortcuts });
    },
    resetAllShortcuts: () => {
      const shortcuts = defaultBindings();
      saveOverrides(shortcuts);
      set({ shortcuts });
    },
    setActivePanel: (activePanel) => set({ activePanel }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    openDialog: (dialog) => set({ dialog }),
    setPendingImport: (pendingImport) => set({ pendingImport }),
    setPixelsPerSecond: (pps) => set({ pixelsPerSecond: Math.max(8, Math.min(400, pps)) }),
    toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
    toggleRipple: () => set({ rippleEnabled: !get().rippleEnabled }),
    setSnapGuide: (snapGuide) => set({ snapGuide }),
    setSearch: (search) => set({ search }),
    notify: (title, kind = 'info', body) =>
      set({ toast: { id: Date.now(), title, kind, ...(body !== undefined ? { body } : {}) } }),

    offerRecovery: (recovery) => set({ recovery }),
    dismissRecovery: () => set({ recovery: null }),
    restoreRecovery: () => {
      const snap = get().recovery;
      if (!snap) return;
      const project = restoreProject(snap);
      get().history.reset(project, 'Recover Session');
      // Restore the full editor state: project (timeline/media/effects) + playhead, zoom, selection.
      set({
        project,
        projectPath: null,
        dirty: true, // recovered but not yet written to disk
        recovery: null,
        playhead: snap.playhead,
        pixelsPerSecond: snap.pixelsPerSecond,
        selectedClipIds: snap.selectedClipIds as ClipId[],
      });
      get().notify('Previous session restored', 'success');
    },

    newProject: (name) => {
      const project = createProject(name ?? 'Untitled Project');
      get().history.reset(project, 'New Project');
      set({ project, projectPath: null, dirty: false, selectedClipIds: [], playhead: 0 });
    },
    loadProjectData: (project, path) => {
      get().history.reset(project, 'Open');
      set({ project, projectPath: path, dirty: false, selectedClipIds: [], playhead: 0 });
    },
    save: async () => {
      const { project, projectPath, bridge } = get();
      const res = await bridge.saveProject(project, projectPath ?? undefined);
      if (res) {
        set({ projectPath: res.path, dirty: false });
        get().notify('Project saved', 'success');
      }
    },
    saveAs: async () => {
      const { project, bridge } = get();
      const res = await bridge.saveProject(project);
      if (res) {
        set({ projectPath: res.path, dirty: false });
        get().notify('Project saved', 'success');
      }
    },

    addMedia: (assets) => {
      // Route through History so the media is part of the canonical project. A direct `set`
      // here desyncs History: the next dispatch() (e.g. dropping a clip) rebuilds the project
      // from History's snapshot and drops the media, leaving clips with no resolvable asset
      // (black preview + silent audio).
      if (assets.length > 0) get().dispatch(addMediaCommand(assets));
    },
    setImportProgress: (importProgress) => set({ importProgress }),
    addMediaToTimeline: (media, trackId, at) => {
      const seq = get().sequence();
      const kindWanted = media.kind === 'audio' ? 'audio' : 'video';
      const track =
        (trackId ? seq.tracks.find((t) => t.id === trackId) : undefined) ??
        seq.tracks.find((t) => t.kind === kindWanted);
      if (!track) return;
      const start = at ?? nextFreeStart(track.clips);
      const clip = createClipFromMedia(media, start);
      get().dispatch(addClip(track.id, clip));
      get().selectClip(clip.id);
    },
  }));
}

/** Place a new clip after the last one on a track (append), avoiding overlaps. */
function nextFreeStart(clips: Clip[]): Ticks {
  if (clips.length === 0) return 0;
  return clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0 as Ticks);
}

/** Serialize the current project (used by autosave). */
export const projectToJson = (project: Project): string => serializeProject(project);
export const DEFAULT_CLIP_LENGTH = seconds(5);

export type AppStore = ReturnType<typeof createAppStore>;
