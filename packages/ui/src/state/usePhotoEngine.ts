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
import { FrameSourcePool, PhotoRenderer, dlog } from '@opencut/engine';
import type { PhotoDocument } from '@opencut/photo';
import { usePhotoStore } from './photoContext.js';

export interface PhotoEngine {
  attach: (canvas: HTMLCanvasElement) => void;
  /** Redraw now (e.g. after a resize). Rendering is otherwise driven by store changes. */
  redraw: () => void;
  /** The composited canvas as a PNG blob, or null before a canvas is attached. */
  toPng: () => Promise<Blob | null>;
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

    r.render({
      doc,
      getMedia: (id) => doc.media.find((m) => m.id === id),
      getFrame: (id) => {
        const media = doc.media.find((m) => m.id === id);
        return media ? p.get(media).getFrame() : null;
      },
    });
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
