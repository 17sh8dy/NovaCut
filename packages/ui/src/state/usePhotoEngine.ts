/**
 * usePhotoEngine — bridges the photo UI to the rendering engine.
 *
 * The still-image counterpart of usePlaybackEngine, and much smaller: a photo has no clock
 * and no audio, so this owns only a Compositor and a FrameSourcePool and redraws whenever the
 * document changes. It reuses the SAME compositor the video editor uses, entered through
 * renderStill() instead of render().
 */

import { useEffect, useRef } from 'react';
import { Compositor, FrameSourcePool, dlog, type StillLayer } from '@opencut/engine';
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
  const compositor = useRef<Compositor | null>(null);
  const pool = useRef<FrameSourcePool | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const api = useRef<PhotoEngine | null>(null);

  /**
   * Build the engine's view of the document and draw it.
   *
   * Layers whose bitmap has not decoded yet are skipped rather than drawn blank; the pool's
   * onFrameReady fires when each one lands and brings us back here. That callback is the only
   * signal an image finished decoding — without it the first paint of a fresh import is empty
   * and nothing would ever redraw it.
   */
  const renderDoc = (doc: PhotoDocument) => {
    const c = compositor.current;
    const p = pool.current;
    if (!c || !p) return;

    const layers: StillLayer[] = [];
    for (const layer of doc.layers) {
      if (!layer.visible || !layer.mediaId) continue;
      const media = doc.media.find((m) => m.id === layer.mediaId);
      if (!media) continue;
      const frame = p.get(media).getFrame();
      if (!frame) continue; // still decoding — onFrameReady will bring us back
      layers.push({
        frame,
        width: media.width,
        height: media.height,
        effects: layer.effects,
        opacity: layer.opacity,
      });
    }

    c.renderStill({ width: doc.width, height: doc.height, background: doc.background, layers });
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
        if (compositor.current) return;
        dlog('engine', 'photo attach(canvas)', { w: canvas.width, h: canvas.height });
        compositor.current = new Compositor(canvas, pool.current!);
        renderDoc(store.getState().doc);
      },
      redraw: () => renderDoc(store.getState().doc),
      toPng: async () => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        // Draw once more so the buffer is guaranteed current, then read the canvas rather
        // than compositor.readPixels(): readPixels is bottom-up and would need a manual
        // vflip, while toBlob respects canvas orientation and works because the GL context
        // is created with preserveDrawingBuffer.
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

  // Release GPU/decoder resources on unmount, nulling refs so a remount (StrictMode's dev
  // cycle included) rebuilds via ensureCore rather than reusing a disposed compositor.
  useEffect(() => {
    return () => {
      compositor.current?.dispose();
      compositor.current = null;
      pool.current?.disposeAll();
      pool.current = null;
      canvasRef.current = null;
    };
  }, []);

  return api.current;
}
