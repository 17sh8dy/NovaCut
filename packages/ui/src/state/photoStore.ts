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
 * both halves reading fields that are null for the other. The bridge and host services it
 * does need are passed in, so this stays as platform-agnostic as its sibling.
 */

import { create } from 'zustand';
import {
  History,
  newMediaId,
  registerBuiltins,
  type Command,
  type MediaAsset,
  type PlatformBridge,
} from '@opencut/core';
import {
  createPhotoDocument,
  findLayer,
  importImage,
  serializePhotoDocument,
  type Layer,
  type LayerId,
  type PhotoDocument,
} from '@opencut/photo';

registerBuiltins();

/** Host services the photo editor borrows from the app shell. */
export interface PhotoHost {
  bridge: PlatformBridge;
  notify: (title: string, kind?: 'info' | 'success' | 'error', body?: string) => void;
}

interface PhotoState {
  bridge: PlatformBridge;
  history: History<PhotoDocument>;
  doc: PhotoDocument;
  dirty: boolean;
  /** True while an import is decoding, so the UI can show progress. */
  importing: boolean;
  selectedLayerId: LayerId | null;

  selectedLayer: () => Layer | undefined;

  dispatch: (command: Command<PhotoDocument>) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  selectLayer: (id: LayerId | null) => void;
  newDocument: (name?: string) => void;
  /** Open the host's file picker and add each chosen image as a layer. */
  importImages: () => Promise<void>;
}

export function createPhotoStore({ bridge, notify }: PhotoHost) {
  const initial = createPhotoDocument();
  const history = new History<PhotoDocument>(initial);

  return create<PhotoState>((set, get) => ({
    bridge,
    history,
    doc: initial,
    dirty: false,
    importing: false,
    selectedLayerId: null,

    // findLayer, not doc.layers.find: layers nest, so a selected layer may live several
    // groups deep and a flat scan would silently report "nothing selected".
    selectedLayer: () => {
      const { doc, selectedLayerId } = get();
      return selectedLayerId ? findLayer(doc.layers, selectedLayerId) : undefined;
    },

    dispatch: (command) => {
      const doc = get().history.dispatch(command);
      set({ doc, dirty: true });
    },
    undo: () => set({ doc: get().history.undo(), dirty: true }),
    redo: () => set({ doc: get().history.redo(), dirty: true }),
    canUndo: () => get().history.canUndo,
    canRedo: () => get().history.canRedo,

    selectLayer: (selectedLayerId) => set({ selectedLayerId }),

    newDocument: (name) => {
      const doc = createPhotoDocument(name ?? 'Untitled');
      get().history.reset(doc, 'New Photo');
      set({ doc, dirty: false, selectedLayerId: null });
    },

    importImages: async () => {
      const files = await bridge.importDialog();
      const images = files.filter((f) => isImage(f.mime, f.name));
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
          if (added) set({ selectedLayerId: added.id });
        }
      } finally {
        set({ importing: false });
      }
    },
  }));
}

/**
 * Build a MediaAsset for a still, taking its size from the DECODED image rather than
 * bridge.probeMedia.
 *
 * probeMedia shells out to ffprobe, which is optional (the README says the editor stays
 * usable without FFmpeg) and falls back to a hardcoded 1920x1080 when missing. For video that
 * is a cosmetic guess; for a photo it is the canvas size, so a missing ffprobe would silently
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

const isImage = (mime: string, name: string): boolean =>
  mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(name);

/** Serialize the current document (used by save + future autosave). */
export const photoDocToJson = (doc: PhotoDocument): string => serializePhotoDocument(doc);

export type PhotoStore = ReturnType<typeof createPhotoStore>;
