/**
 * The photo store (Zustand).
 *
 * The photo editor's connection point between React and @opencut/photo, mirroring store.ts:
 * components read slices and call actions; actions run Commands through core's History and
 * mirror the resulting document into the store so React re-renders.
 *
 * It is a SEPARATE store from the video AppStore rather than more fields on it. The two
 * documents share machinery (History, the effect registry, the compositor) but no state, and
 * folding a second document into a store whose every selector says `s.project` would leave
 * both halves reading fields that are null for the other. The bridge and host services it does
 * need are passed in, so this stays as platform-agnostic as its sibling.
 *
 * ## What is document and what is session
 *
 * The DOCUMENT holds what a reopened file must reproduce: layers, canvas, media. The STORE
 * holds what belongs to this session at this moment: the active tool, the viewport, what is
 * selected, what is on the clipboard. The split matters because every document change is an
 * undo step — so putting the zoom level in the document would make Ctrl+Z rewind the user's
 * scroll wheel, and putting the selection there would make it rewind their attention.
 */

import { create } from 'zustand';
import {
  History,
  isStillFile,
  newMediaId,
  registerBuiltins,
  type Command,
  type ImportedFile,
  type MediaAsset,
  type PlatformBridge,
  defaultProjectName,
} from '@opencut/core';
import {
  DEFAULT_BRUSH,
  createPhotoDocument,
  deserializePhotoDocument,
  findLayer,
  flattenLayers,
  importImage,
  newLayerId,
  serializePhotoDocument,
  type BrushSettings,
  type Fill,
  type Layer,
  type LayerId,
  type PhotoDocument,
  type ShapeKind,
} from '@opencut/photo';

registerBuiltins();

/** Host services the photo editor borrows from the app shell. */
export interface PhotoHost {
  bridge: PlatformBridge;
  notify: (title: string, kind?: 'info' | 'success' | 'error', body?: string) => void;
  /**
   * Starting state for the canvas overlays, from the app-level Interface preferences.
   *
   * Seeded rather than bound: the tool rail toggles these per session, so a live binding would
   * mean flipping a button in the rail silently rewrote a global preference — two controls
   * fighting over one value. The preference decides where a session STARTS; the rail owns it
   * from then on.
   */
  overlayDefaults?: { showRulers: boolean; showGuides: boolean };
  /**
   * Background for documents this session creates, from the Photo preferences.
   *
   * A `#rrggbbaa` string, because the document model stores alpha in the background and
   * "transparent" has to be expressible — `'transparent'` as a CSS keyword would not survive
   * the round-trip through the renderer's hexToRgba.
   */
  newDocumentBackground?: string;
}

/**
 * The active tool.
 *
 * Only tools with a real implementation are listed — a rail padded out with greyed-out icons
 * for features that do not exist is a worse promise than a short rail. The paint and selection
 * families landed with the op-list surface in `@opencut/photo`'s `paintOps.ts`; smudge, blur
 * and sharpen brushes are still absent, and the note at the foot of that file explains both
 * why and what replaces them.
 */
export type PhotoTool =
  | 'move'
  | 'text'
  | 'shape'
  | 'crop'
  | 'hand'
  // Paint
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'gradient'
  // Selection
  | 'select-rect'
  | 'select-ellipse'
  | 'lasso'
  | 'polygon'
  | 'wand';

/** Tools that deposit paint, and therefore need a paintable surface before they can run. */
export const PAINT_TOOLS: readonly PhotoTool[] = ['brush', 'eraser', 'bucket', 'gradient'];
/** Tools that build a selection rather than editing pixels. */
export const SELECT_TOOLS: readonly PhotoTool[] = [
  'select-rect', 'select-ellipse', 'lasso', 'polygon', 'wand',
];

export const isPaintTool = (t: PhotoTool): boolean => PAINT_TOOLS.includes(t);
export const isSelectTool = (t: PhotoTool): boolean => SELECT_TOOLS.includes(t);

/** How a magic wand or paint bucket decides what matches. */
export interface SampleSettings {
  /** 0..1 — how far a pixel may differ from the seed and still match. */
  tolerance: number;
  /** False matches every similar pixel anywhere, not just the connected blob. */
  contiguous: boolean;
}

export type PhotoDialog = null | 'export' | 'newCanvas' | 'canvasSize';

/** Which panel the left dock is showing. */
export type PhotoDock = 'layers' | 'assets' | 'history';

export interface Viewport {
  /** Canvas pixels per screen pixel. 1 = 100%. */
  zoom: number;
  /** Pan offset of the canvas centre from the viewport centre, in SCREEN pixels. */
  panX: number;
  panY: number;
  /** False once the user zooms or pans by hand, so a redraw stops re-fitting under them. */
  autoFit: boolean;
  /**
   * Bumped to request a re-fit RIGHT NOW.
   *
   * `autoFit` alone cannot express this: it is already true most of the time, so "Fit to
   * window" would set it true again, the value would not change, and the effect watching it
   * would never re-run — a button that silently does nothing whenever it is most likely to be
   * pressed. A monotonic counter is an event rather than a state, which is what this is.
   */
  fitNonce: number;
}

interface PhotoState {
  bridge: PlatformBridge;
  history: History<PhotoDocument>;
  doc: PhotoDocument;
  dirty: boolean;
  /** True while an import is decoding, so the UI can show progress. */
  importing: boolean;

  /**
   * Bumped on every history change.
   *
   * History's `canUndo` / `canRedo` / stack are plain getters React cannot observe. Most edits
   * also replace `doc`, so panels keyed on that stay honest — but the History panel needs to
   * re-render when the *cursor* moves even where the resulting state is identical. One counter
   * covers that without exposing the stack as state.
   */
  historyVersion: number;

  // ── Session state ──
  tool: PhotoTool;
  /** Which shape the shape tool draws. */
  shapeKind: ShapeKind;
  /** Ordered; the LAST entry is the primary selection the inspector edits. */
  selection: LayerId[];
  viewport: Viewport;
  showRulers: boolean;
  showGuides: boolean;
  snapping: boolean;
  dock: PhotoDock;
  dialog: PhotoDialog;
  /** Copied layers, deep-cloned at copy time so a later edit to the original cannot leak in. */
  clipboard: Layer[];
  /** The layer whose text is being edited in place, if any. */
  editingTextId: LayerId | null;

  // ── Paint ──
  brush: BrushSettings;
  /** The colour the brush, bucket and gradient use. Swappable with `background`. */
  foreground: string;
  background: string;
  gradientFill: Fill;
  gradientShape: 'linear' | 'radial';
  sample: SampleSettings;
  /**
   * Paint into the selected layer's MASK rather than its pixels.
   *
   * A mode rather than a separate set of tools, because every paint tool works on both and the
   * user's intent ("hide this part") is the same gesture either way. It is also what makes
   * "add a Blur adjustment, then brush it in" a two-click workflow.
   */
  maskMode: boolean;

  // ── Derived ──
  selectedLayerId: LayerId | null;
  selectedLayer: () => Layer | undefined;
  selectedLayers: () => Layer[];

  // ── Document ──
  dispatch: (command: Command<PhotoDocument>) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Move the history cursor by a signed number of steps (what the History panel's rows do). */
  travel: (delta: number) => void;

  selectLayer: (id: LayerId | null, mode?: 'replace' | 'toggle' | 'add') => void;
  selectAll: () => void;
  newDocument: (name?: string, size?: { width: number; height: number }) => void;
  loadDocument: (doc: PhotoDocument) => void;

  // ── Session actions ──
  setTool: (tool: PhotoTool) => void;
  setShapeKind: (kind: ShapeKind) => void;
  setViewport: (patch: Partial<Viewport>) => void;
  /** Fit the document to the viewport now, whatever the current auto-fit state. */
  fitToWindow: () => void;
  setDock: (dock: PhotoDock) => void;
  setDialog: (dialog: PhotoDialog) => void;
  setEditingText: (id: LayerId | null) => void;
  toggleFlag: (key: 'showRulers' | 'showGuides' | 'snapping' | 'maskMode') => void;

  setBrush: (patch: Partial<BrushSettings>) => void;
  setForeground: (color: string) => void;
  setBackground: (color: string) => void;
  swapColors: () => void;
  setGradient: (patch: { fill?: Fill; shape?: 'linear' | 'radial' }) => void;
  setSample: (patch: Partial<SampleSettings>) => void;

  copySelection: () => void;
  pasteClipboard: () => void;

  // ── Import ──
  /** Open the host's file picker and add each chosen image as a layer. */
  importImages: () => Promise<void>;
  /**
   * Add already-chosen files as layers, skipping the picker.
   *
   * Home runs the file dialog itself so it can route a .png here and a .mp4 to the timeline;
   * by the time this workspace mounts the question has been asked and answered.
   */
  importChosen: (files: readonly ImportedFile[]) => Promise<void>;
  /** Add dropped or pasted browser Files as layers. */
  importFiles: (files: readonly File[]) => Promise<void>;
}

/** Where the session's autosave lives. One slot — this is crash insurance, not a file format. */
const AUTOSAVE_KEY = 'opencut.photo.autosave.v3';

export function createPhotoStore({ bridge, notify, overlayDefaults, newDocumentBackground }: PhotoHost) {
  const initial = createPhotoDocument();
  const history = new History<PhotoDocument>(initial);

  const store = create<PhotoState>((set, get) => ({
    bridge,
    history,
    doc: initial,
    dirty: false,
    importing: false,
    historyVersion: 0,

    tool: 'move',
    shapeKind: 'rounded-rectangle',
    selection: [],
    viewport: { zoom: 1, panX: 0, panY: 0, autoFit: true, fitNonce: 0 },
    showRulers: overlayDefaults?.showRulers ?? true,
    showGuides: overlayDefaults?.showGuides ?? true,
    snapping: true,
    dock: 'layers',
    dialog: null,
    clipboard: [],
    editingTextId: null,

    brush: { ...DEFAULT_BRUSH },
    foreground: '#ffffff',
    background: '#000000',
    gradientFill: { kind: 'linear', angle: 0, stops: [
      { offset: 0, color: '#ffffff' },
      { offset: 1, color: '#ffffff00' },
    ] } as Fill,
    gradientShape: 'linear',
    sample: { tolerance: 0.18, contiguous: true },
    maskMode: false,

    selectedLayerId: null,

    // findLayer, not doc.layers.find: layers nest, so a selected layer may live several
    // groups deep and a flat scan would silently report "nothing selected".
    selectedLayer: () => {
      const { doc, selectedLayerId } = get();
      return selectedLayerId ? findLayer(doc.layers, selectedLayerId) : undefined;
    },
    selectedLayers: () => {
      const { doc, selection } = get();
      return selection.map((id) => findLayer(doc.layers, id)).filter((l): l is Layer => !!l);
    },

    dispatch: (command) => {
      const doc = get().history.dispatch(command);
      set({ doc, dirty: true });
      // Selection is by id, and ids survive every command except delete. Pruning here rather
      // than inside each command means no command has to know the selection exists.
      pruneSelection(set, get, doc);
    },
    undo: () => {
      const doc = get().history.undo();
      set({ doc, dirty: true });
      pruneSelection(set, get, doc);
    },
    redo: () => {
      const doc = get().history.redo();
      set({ doc, dirty: true });
      pruneSelection(set, get, doc);
    },
    canUndo: () => get().history.canUndo,
    canRedo: () => get().history.canRedo,
    travel: (delta) => {
      const h = get().history;
      const step = delta < 0 ? () => h.undo() : () => h.redo();
      let doc = h.current;
      for (let i = 0; i < Math.abs(delta); i++) doc = step();
      set({ doc, dirty: true });
      pruneSelection(set, get, doc);
    },

    selectLayer: (id, mode = 'replace') => {
      if (id === null) {
        set({ selection: [], selectedLayerId: null, editingTextId: null });
        return;
      }
      const { selection, editingTextId } = get();
      let next: LayerId[];
      if (mode === 'replace') next = [id];
      else if (mode === 'toggle') {
        next = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
      } else next = selection.includes(id) ? selection : [...selection, id];
      set({
        selection: next,
        selectedLayerId: next.at(-1) ?? null,
        // Leaving a layer must leave its text editor, or keystrokes keep landing in a layer the
        // user is no longer looking at.
        editingTextId: editingTextId && next.includes(editingTextId) ? editingTextId : null,
      });
    },

    selectAll: () => {
      // Root layers only. Selecting every descendant too would put a group AND its children in
      // one selection, so a nudge would move each child twice — once itself, once via its group.
      const ids = get().doc.layers.map((l) => l.id);
      set({ selection: ids, selectedLayerId: ids.at(-1) ?? null });
    },

    newDocument: (name, size) => {
      const fresh = createPhotoDocument(name ?? defaultProjectName('photo'), undefined, size);
      const doc = newDocumentBackground ? { ...fresh, background: newDocumentBackground } : fresh;
      get().history.reset(doc, 'New Photo');
      set({
        doc,
        dirty: false,
        selection: [],
        selectedLayerId: null,
        editingTextId: null,
        viewport: { zoom: 1, panX: 0, panY: 0, autoFit: true, fitNonce: get().viewport.fitNonce + 1 },
      });
    },

    loadDocument: (doc) => {
      get().history.reset(doc, 'Open');
      set({
        doc,
        dirty: false,
        selection: [],
        selectedLayerId: null,
        editingTextId: null,
        viewport: { zoom: 1, panX: 0, panY: 0, autoFit: true, fitNonce: get().viewport.fitNonce + 1 },
      });
    },

    setTool: (tool) => set({
      tool,
      ...(tool === 'text' ? {} : { editingTextId: null }),
      // Leaving the paint tools leaves mask-painting mode too. Staying in it while dragging a
      // layer around would silently send the next brush stroke to a mask the user has stopped
      // thinking about.
      ...(isPaintTool(tool) ? {} : { maskMode: false }),
    }),
    setShapeKind: (shapeKind) => set({ shapeKind }),
    setViewport: (patch) => set({ viewport: { ...get().viewport, ...patch } }),
    fitToWindow: () =>
      set({ viewport: { ...get().viewport, autoFit: true, fitNonce: get().viewport.fitNonce + 1 } }),
    setDock: (dock) => set({ dock }),
    setDialog: (dialog) => set({ dialog }),
    setEditingText: (editingTextId) => set({ editingTextId }),
    toggleFlag: (key) => set({ [key]: !get()[key] } as Partial<PhotoState>),

    // The brush's own colour tracks the foreground, so changing one never leaves the other
    // stale — a brush that paints a colour the swatch is not showing is a bug report.
    setBrush: (patch) => set({ brush: { ...get().brush, ...patch } }),
    setForeground: (foreground) => set({ foreground, brush: { ...get().brush, color: foreground } }),
    setBackground: (background) => set({ background }),
    swapColors: () => {
      const { foreground, background } = get();
      set({ foreground: background, background: foreground, brush: { ...get().brush, color: background } });
    },
    setGradient: (patch) => set({
      ...(patch.fill ? { gradientFill: patch.fill } : {}),
      ...(patch.shape ? { gradientShape: patch.shape } : {}),
    }),
    setSample: (patch) => set({ sample: { ...get().sample, ...patch } }),

    copySelection: () => {
      const layers = get().selectedLayers();
      if (layers.length === 0) return;
      // Cloned at COPY time, not at paste time: copy, edit the original, then paste must give
      // back what was copied — the contract every editor has.
      set({ clipboard: layers.map((l) => structuredClone(l)) });
      notify(`Copied ${layers.length} layer${layers.length === 1 ? '' : 's'}`, 'info');
    },

    pasteClipboard: () => {
      const { clipboard } = get();
      if (clipboard.length === 0) return;
      for (const layer of clipboard) {
        get().dispatch({
          label: 'Paste Layer',
          apply: (doc) => {
            const copy = reid(structuredClone(layer));
            // Offset slightly, so a paste is visible rather than landing exactly on what it was
            // copied from and looking like nothing happened.
            copy.transform = { ...copy.transform, x: copy.transform.x + 24, y: copy.transform.y + 24 };
            return { ...doc, layers: [...doc.layers, copy], modifiedAt: Date.now() };
          },
        });
        const added = get().doc.layers.at(-1);
        if (added) get().selectLayer(added.id, 'replace');
      }
    },

    importImages: async () => {
      const files = await bridge.importDialog(['image']);
      if (files.length === 0) return; // user canceled
      await get().importChosen(files);
    },

    importChosen: async (files) => {
      const images = files.filter((f) => isStillFile(f.mime, f.name));
      if (images.length === 0) {
        if (files.length > 0) notify('No images in that selection', 'error');
        return;
      }
      set({ importing: true });
      try {
        for (const f of images) {
          let asset: MediaAsset;
          try {
            asset = await imageAsset(f.src, f.name, f.size, bridge);
          } catch {
            notify('Could not read image', 'error', f.name);
            continue;
          }
          get().dispatch(importImage(asset));
          const added = get().doc.layers.at(-1);
          if (added) get().selectLayer(added.id, 'replace');
        }
      } finally {
        set({ importing: false });
      }
    },

    importFiles: async (files) => {
      const images = [...files].filter((f) => isStillFile(f.type, f.name));
      if (images.length === 0) {
        notify('No images in that drop', 'error');
        return;
      }
      set({ importing: true });
      try {
        for (const file of images) {
          // A dropped file on desktop resolves to a real path, which survives save/reopen. Only
          // where the host cannot supply one (web, or a pasted clipboard blob) does this fall
          // back to an object URL — which works for this session and nothing beyond it.
          const src = bridge.resolveDroppedFile(file) ?? URL.createObjectURL(file);
          try {
            const asset = await imageAsset(src, file.name || 'Pasted image', file.size, bridge);
            get().dispatch(importImage(asset));
            const added = get().doc.layers.at(-1);
            if (added) get().selectLayer(added.id, 'replace');
          } catch {
            notify('Could not read image', 'error', file.name);
          }
        }
      } finally {
        set({ importing: false });
      }
    },
  }));

  // History's cursor can move without the document reference changing; one counter lets panels
  // observe that without History becoming part of React state.
  history.subscribe(() => store.setState((s) => ({ historyVersion: s.historyVersion + 1 })));

  return store;
}

/**
 * Drop selected ids that no longer exist.
 *
 * Deleting a layer, or undoing past its creation, leaves a dangling selection — and every
 * consumer (inspector, canvas handles, nudge) would then quietly operate on nothing. Doing it
 * in one place beats each of them guarding.
 */
function pruneSelection(
  set: (partial: Partial<PhotoState>) => void,
  get: () => PhotoState,
  doc: PhotoDocument,
): void {
  const { selection } = get();
  if (selection.length === 0) return;
  const live = new Set<string>(flattenLayers(doc.layers).map((l) => l.id));
  const next = selection.filter((id) => live.has(id));
  if (next.length === selection.length) return;
  set({ selection: next, selectedLayerId: next.at(-1) ?? null });
}

/**
 * Give a cloned subtree fresh ids.
 *
 * Fresh ids for descendants too: two layers sharing an id makes every `findLayer` return
 * whichever comes first, so selecting one would edit the other.
 */
function reid(layer: Layer): Layer {
  const fresh: Layer = { ...layer, id: newLayerId() };
  if (fresh.kind === 'group') return { ...fresh, children: fresh.children.map(reid) };
  return fresh;
}

/**
 * Build a MediaAsset for a still, taking its size from the DECODED image rather than
 * bridge.probeMedia.
 *
 * probeMedia shells out to ffprobe, which is optional (the README says the editor stays usable
 * without FFmpeg) and falls back to a hardcoded 1920x1080 when missing. For video that is a
 * cosmetic guess; for a photo it is the canvas size, so a missing ffprobe would silently
 * letterbox every import. The renderer must decode the image to draw it regardless, so the
 * decode is the authoritative — and always available — source of dimensions.
 */
async function imageAsset(
  src: string,
  name: string,
  size: number,
  bridge: PlatformBridge,
): Promise<MediaAsset> {
  const { width, height } = await decodeSize(bridge.resolveMediaUrl(src));
  return {
    id: newMediaId(),
    kind: 'image',
    name,
    src,
    duration: 0, // core's convention: 0 means "still"
    width,
    height,
    hasAudio: false,
    fileSize: size,
    importedAt: Date.now(),
  };
}

function decodeSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Must be set before src so the fetch is a CORS request and the decode stays untainted —
    // the same reason FrameSource does it, and required for the later WebGL upload.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`Could not decode image: ${url}`));
    img.src = url;
  });
}

/** Serialize the current document (used by save + autosave). */
export const photoDocToJson = (doc: PhotoDocument): string => serializePhotoDocument(doc);

// ─────────────────────────────────────────────────────────────────────────────
// Autosave
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the document to local storage.
 *
 * Deliberately best-effort and silent: a full quota or a private-mode restriction must never
 * interrupt editing, and the user did not ask for this save. It is crash insurance offered on
 * next launch, not a substitute for saving a file.
 *
 * Note this stores only the DOCUMENT — layer structure and media *references*. Image bytes stay
 * on disk and are re-resolved through the bridge, which is what keeps the payload small enough
 * for local storage at all. A document whose images came from an object URL (a pasted
 * screenshot) restores with those layers unresolvable, which is why the restore prompt names
 * what it is offering rather than silently reopening.
 */
export function writeAutosave(doc: PhotoDocument): void {
  try {
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({ savedAt: Date.now(), name: doc.name, json: serializePhotoDocument(doc) }),
    );
  } catch {
    /* quota, private mode, disabled storage — all non-fatal */
  }
}

export interface PhotoAutosave {
  savedAt: number;
  name: string;
  doc: PhotoDocument;
}

/** Read back a previous session's autosave, or null when there is nothing usable. */
export function readAutosave(): PhotoAutosave | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; name: string; json: string };
    const doc = deserializePhotoDocument(parsed.json);
    // An empty document is not worth offering to restore — it is what the user gets by just
    // starting, and a "restore?" prompt for nothing is noise.
    if (doc.layers.length === 0) return null;
    return { savedAt: parsed.savedAt, name: parsed.name, doc };
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* see writeAutosave */
  }
}

export type PhotoStore = ReturnType<typeof createPhotoStore>;
