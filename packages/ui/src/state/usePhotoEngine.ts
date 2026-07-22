/**
 * usePhotoEngine — bridges the photo UI to the rendering engine.
 *
 * The still-image counterpart of usePlaybackEngine, and much smaller: a photo has no clock and
 * no audio, so this owns only a PhotoRenderer and a FrameSourcePool and redraws whenever the
 * document changes.
 *
 * It hands the renderer *callbacks* rather than a flattened layer list. The old shape walked
 * `doc.layers` here and passed the engine an array of decoded stills, which stopped working the
 * moment layers could nest: flattening a tree discards the very structure — groups, clipping
 * runs, adjustment scope — that the render graph exists to interpret. Resolving media through
 * `getFrame`/`getMedia` keeps the document pixel-free (History snapshots it whole) while
 * letting the engine walk the real tree.
 */

import { useEffect, useRef } from 'react';
import type { MediaId } from '@opencut/core';
import { FrameSourcePool, PhotoRenderer, dlog } from '@opencut/engine';
import { applyCanvasSize, type PhotoDocument } from '@opencut/photo';
import { usePhotoStore } from './photoContext.js';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportOptions {
  format: ExportFormat;
  /** 0..1, honored by JPEG and WebP. PNG is lossless and ignores it. */
  quality: number;
  /** Output size multiplier. 2 renders the whole composition at twice the canvas resolution. */
  scale: number;
  /**
   * Keep the document's own (possibly transparent) background.
   *
   * When false the canvas is flattened onto `matte` first. JPEG has no alpha at all, so
   * exporting transparency to it would silently composite onto black — the classic "why is my
   * logo on a black square" — which is why the dialog forces this off for JPEG.
   */
  transparent: boolean;
  matte: string;
}

export interface PhotoEngine {
  attach: (canvas: HTMLCanvasElement) => void;
  /** Redraw now (e.g. after a resize). Rendering is otherwise driven by store changes. */
  redraw: () => void;
  /** The composited canvas as a PNG blob, or null before a canvas is attached. */
  toPng: () => Promise<Blob | null>;
  /** Render the document off-screen at `scale` and encode it. Never touches the live canvas. */
  exportImage: (options: ExportOptions) => Promise<Blob | null>;
}

export function usePhotoEngine(): PhotoEngine {
  const store = usePhotoStore();
  const renderer = useRef<PhotoRenderer | null>(null);
  const pool = useRef<FrameSourcePool | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const api = useRef<PhotoEngine | null>(null);

  /**
   * Draw the document.
   *
   * Layers whose bitmap has not decoded yet resolve to null and the graph skips them rather
   * than drawing blank; the pool's onFrameReady fires when each one lands and brings us back
   * here. That callback is the only signal an image finished decoding — without it the first
   * paint of a fresh import is empty and nothing would ever redraw it.
   */
  const renderDoc = (doc: PhotoDocument) => {
    const r = renderer.current;
    const p = pool.current;
    if (!r || !p) return;
    r.render(contextFor(doc, p));
  };

  const ensureCore = () => {
    if (!pool.current) {
      const bridge = store.getState().bridge;
      const p = new FrameSourcePool((src) => bridge.resolveMediaUrl(src));
      p.onFrameReady = () => renderDoc(store.getState().doc);
      pool.current = p;
    }
  };
  ensureCore();

  if (!api.current) {
    api.current = {
      attach: (canvas) => {
        ensureCore();
        canvasRef.current = canvas;
        if (renderer.current) return;
        dlog('engine', 'photo attach(canvas)', { w: canvas.width, h: canvas.height });
        renderer.current = new PhotoRenderer(canvas);
        renderDoc(store.getState().doc);
      },
      redraw: () => renderDoc(store.getState().doc),
      toPng: async () => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        // Draw once more so the buffer is guaranteed current, then read the canvas rather than
        // the renderer's own pixels: GL readPixels is bottom-up and would need a manual vflip,
        // while toBlob respects canvas orientation and works because the GL context is created
        // with preserveDrawingBuffer.
        renderDoc(store.getState().doc);
        return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
      },
      exportImage: async (options) => {
        ensureCore();
        const p = pool.current;
        if (!p) return null;
        return exportOffscreen(store.getState().doc, p, options);
      },
    };
  }

  // Redraw whenever the document changes (import, filter tweak, undo, …).
  useEffect(() => {
    ensureCore();
    let lastDoc = store.getState().doc;
    renderDoc(lastDoc);
    const unsub = store.subscribe((s) => {
      if (s.doc === lastDoc) return;
      lastDoc = s.doc;
      renderDoc(s.doc);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Redraw once the fonts a document asked for have actually loaded.
   *
   * Text is rasterized with whatever the platform can resolve AT THAT MOMENT. A family still
   * loading falls back, gets cached under its pixel signature, and then never re-rasterizes —
   * so a headline would stay in the fallback face for the rest of the session. `document.fonts`
   * reports when that changes; dropping the raster cache is what makes the correction visible.
   */
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    const invalidate = () => {
      renderer.current?.invalidateVectors();
      renderDoc(store.getState().doc);
    };
    void fonts.ready.then(invalidate);
    fonts.addEventListener('loadingdone', invalidate);
    return () => fonts.removeEventListener('loadingdone', invalidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release GPU/decoder resources on unmount, nulling refs so a remount (StrictMode's dev cycle
  // included) rebuilds via ensureCore rather than reusing a disposed renderer.
  useEffect(() => {
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
      pool.current?.disposeAll();
      pool.current = null;
      canvasRef.current = null;
    };
  }, []);

  return api.current;
}

/** The media-resolution callbacks the render graph needs. Shared by live draw and export. */
const contextFor = (doc: PhotoDocument, p: FrameSourcePool) => ({
  doc,
  getMedia: (id: MediaId) => doc.media.find((m) => m.id === id),
  getFrame: (id: MediaId) => {
    const media = doc.media.find((m) => m.id === id);
    return media ? p.get(media).getFrame() : null;
  },
});

/**
 * Render at an arbitrary scale, off-screen, and encode.
 *
 * A second, throwaway PhotoRenderer rather than resizing the live one: the visible canvas's
 * backing store IS the document size, so resizing it to 4× for an export would evict every
 * pooled buffer, force a full redraw at the wrong size, and leave the user watching their
 * artwork flash. One extra GL context for the duration of an encode is the cheaper trade.
 *
 * Scaling reuses `applyCanvasSize(…, scaleContent)` — the same command the canvas-size dialog
 * runs — so "export at 2×" is defined as "the document, at 2× canvas". Anything else would be a
 * second definition of what scaling means, free to disagree with the first.
 */
async function exportOffscreen(
  doc: PhotoDocument,
  pool: FrameSourcePool,
  options: ExportOptions,
): Promise<Blob | null> {
  const scale = Math.max(0.05, Math.min(8, options.scale));
  let target = doc;
  if (scale !== 1) {
    target = applyCanvasSize(
      Math.round(doc.width * scale),
      Math.round(doc.height * scale),
      true,
    ).apply(doc);
  }
  if (!options.transparent) target = { ...target, background: opaque(options.matte) };

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const renderer = new PhotoRenderer(canvas);
  try {
    renderer.render(contextFor(target, pool));
    const mime = options.format === 'png' ? 'image/png'
      : options.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), mime, options.quality),
    );
  } finally {
    // The context is useless the moment we have the bytes, and browsers cap how many live GL
    // contexts a page may hold — leaking one per export would eventually kill the editor's own.
    renderer.dispose();
  }
}

/** Force a hex colour opaque, so a matte can never itself be see-through. */
function opaque(hex: string): string {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  return m ? `#${m[1]}ff` : '#ffffffff';
}
