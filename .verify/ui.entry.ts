/**
 * Photo workspace harness — drives the REAL EditorApp through the photo flow.
 *
 * The import path normally opens a native file dialog, which can't be automated. The bridge
 * is the seam that makes it testable: a stub whose importDialog returns a data-URL image lets
 * the whole flow run headless — import → decode → layer → filter → GPU render — through the
 * same components, store and compositor the app ships.
 *
 * Test image is RED top / BLUE bottom so the rendered canvas also proves orientation.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, createAppStore } from '@opencut/ui';
import type { PlatformBridge } from '@opencut/core';

const SIZE = 8;

function testImageDataUrl(): string {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, SIZE, SIZE / 2);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, SIZE / 2, SIZE, SIZE / 2);
  return c.toDataURL();
}

const IMG = testImageDataUrl();

const bridge: PlatformBridge = {
  platform: 'desktop',
  openProjectDialog: async () => null,
  saveProject: async () => null,
  loadProject: async () => {
    throw new Error('nope');
  },
  recentProjects: async () => [],
  importDialog: async () => [{ src: IMG, name: 'test.png', mime: 'image/png', size: 1 }],
  probeMedia: async () => {
    throw new Error('no ffprobe — the photo path must not need it');
  },
  generateThumbnail: async () => IMG,
  resolveMediaUrl: (src) => src,
  resolveDroppedFile: () => null,
  chooseExportPath: async () => null,
  createEncoder: async () => {
    throw new Error('nope');
  },
  notify: () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = (r: Record<string, unknown>) => console.log('__RESULT__' + JSON.stringify(r));

/**
 * Find a button by visible text OR title. Icon-only buttons (Undo/Redo) carry their label
 * only in `title`, so matching on textContent alone silently finds nothing and the "click"
 * becomes a no-op that looks like a product failure.
 */
const button = (text: string): HTMLButtonElement | undefined => {
  const want = text.toLowerCase();
  return [...document.querySelectorAll('button')].find((b) => {
    const label = ((b.textContent || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
    return label.includes(want);
  }) as HTMLButtonElement | undefined;
};

async function main() {
  const results: Record<string, unknown> = {};
  try {
    const host = document.createElement('div');
    // The workspace lays itself out with flex against a sized ancestor. Without an explicit
    // viewport here the stage measures 0x0, `fit()` clamps the zoom to its minimum, and the
    // canvas ends up sub-pixel — so every pointer coordinate lands outside it and the paint
    // and selection tools appear broken when they are not. The real app gets its size from the
    // Electron window; the harness has to say so.
    document.documentElement.style.cssText = 'width:100%;height:100%';
    document.body.style.cssText = 'margin:0;width:1280px;height:860px;overflow:hidden';
    host.style.cssText = 'width:100%;height:100%';
    document.body.appendChild(host);

    const store = createAppStore(bridge);
    store.getState().setView('photo');
    createRoot(host).render(createElement(EditorApp, { store }));
    await sleep(300);

    results.mounted = !!document.querySelector('.oc-photobar');
    results.hasLayersPanel = document.body.textContent!.includes('Layers');
    // The right-hand panel is the Inspector (transform + adjustment params + the filter rack).
    // Its "Filters" section only exists once a layer is selected, so assert on the panel title.
    results.hasInspectorPanel = document.body.textContent!.includes('Inspector');
    results.emptyState = document.body.textContent!.includes('Start with an image');

    // 1. Import — exercises importDialog → decodeSize → importImage command → layer.
    const add = button('Add Image');
    results.foundAddButton = !!add;
    add?.click();
    await sleep(600);
    results.layerAdded = !!document.querySelector('.oc-layer');
    const canvas = document.querySelector('.oc-stage__canvas') as HTMLCanvasElement | null;
    results.canvasPresent = !!canvas;
    results.canvasSize = canvas ? `${canvas.width}x${canvas.height}` : null;

    // The canvas must adopt the image's true pixel size even though probeMedia throws —
    // proving the photo path reads dimensions from the decode, not from ffprobe.
    results.sizedFromDecode = canvas?.width === SIZE && canvas?.height === SIZE;

    const read = () => {
      if (!canvas) return null;
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(canvas, 0, 0);
      const px = (y: number) => {
        const d = ctx.getImageData(Math.floor(canvas.width / 2), y, 1, 1).data;
        if (d[0]! > d[2]! + 30) return 'red';
        if (d[2]! > d[0]! + 30) return 'blue';
        return `other(${d[0]},${d[1]},${d[2]})`;
      };
      return { top: px(1), bottom: px(canvas.height - 2) };
    };
    results.renderedNoFilter = read();

    // 2. Add ONE filter — the count that was upside down before the fix.
    const layer = document.querySelector('.oc-layer') as HTMLElement | null;
    layer?.click();
    await sleep(120);
    button('Add Effect')?.click();
    await sleep(120);
    const pick = [...document.querySelectorAll('.oc-picker__item')].find((b) =>
      (b.textContent || '').includes('Brightness'),
    ) as HTMLButtonElement | undefined;
    results.foundFilterPicker = !!pick;
    pick?.click();
    await sleep(400);
    results.filterApplied = !!document.querySelector('.oc-fx');
    results.renderedOneFilter = read();

    // 3. Undo must remove the filter — proves the photo doc rides core's History.
    button('Undo')?.click();
    await sleep(300);
    results.undoRemovedFilter = !document.querySelector('.oc-fx');

    // 4. Vector layers — the schema-3 slice. Adding a shape from the Assets panel must produce
    //    a layer AND change pixels, which together prove the rasterizer reached the GPU. A layer
    //    that appears in the panel but draws nothing is the exact failure this catches.
    const beforeShape = read();
    ([...document.querySelectorAll('.oc-dock__tabs button')].find((b) =>
      (b.textContent || '').includes('Assets'),
    ) as HTMLButtonElement | undefined)?.click();
    await sleep(120);
    const tile = [...document.querySelectorAll('.oc-tile')].find((b) =>
      (b.textContent || '').includes('Label Chip'),
    ) as HTMLButtonElement | undefined;
    results.foundShapeAsset = !!tile;
    tile?.click();
    await sleep(400);
    results.shapeChangedPixels = JSON.stringify(read()) !== JSON.stringify(beforeShape);

    // 5. Text — inserted as a real text layer, rasterized through the same path.
    const textPreset = [...document.querySelectorAll('.oc-preset')].find((b) =>
      (b.textContent || '').includes('Thumbnail Punch'),
    ) as HTMLButtonElement | undefined;
    results.foundTextPreset = !!textPreset;
    const beforeText = read();
    textPreset?.click();
    await sleep(400);
    results.textChangedPixels = JSON.stringify(read()) !== JSON.stringify(beforeText);

    // Undo both so the orientation assertions below still describe the imported image alone.
    button('Undo')?.click();
    await sleep(150);
    button('Undo')?.click();
    await sleep(250);

    // 6. Paint — a brush stroke must create a paint layer, deposit pixels, and collapse into
    //    exactly ONE undo step no matter how many pointermoves produced it. The one-step part is
    //    the assertion that matters: without command coalescing a stroke is 400 undo entries,
    //    and that failure is invisible until someone presses Ctrl+Z.
    const stage = document.querySelector('.oc-stage') as HTMLElement | null;
    const doc = document.querySelector('.oc-stage__doc') as HTMLElement | null;
    results.hasStage = !!stage && !!doc;
    /**
     * A hash of every pixel, NOT a coverage count.
     *
     * The test image already fills the canvas edge to edge, so "how many pixels are opaque"
     * cannot go up no matter what is painted — an assertion on coverage would pass on a broken
     * brush and fail on a working one. Hashing the actual colours is the only measure that
     * detects paint on an already-opaque document.
     */
    const pixelHash = () => {
      if (!canvas) return 0;
      const o = document.createElement('canvas');
      o.width = canvas.width;
      o.height = canvas.height;
      const cx = o.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(canvas, 0, 0);
      const d = cx.getImageData(0, 0, o.width, o.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]!) | 0;
      return h;
    };
    const pointer = (type: string, x: number, y: number) => {
      const r = doc!.getBoundingClientRect();
      stage!.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: r.left + x,
          clientY: r.top + y,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      );
    };

    const rail = (title: string) =>
      ([...document.querySelectorAll('.oc-rail button')].find((b) =>
        (b.getAttribute('title') || '').includes(title),
      ) as HTMLButtonElement | undefined);

    results.foundBrushTool = !!rail('Brush');
    rail('Brush')?.click();
    await sleep(200);
    results.brushToolActive = !!document.querySelector('.oc-brushpresets');
    // Back to the Layers tab: the shape/text steps above left the dock on Assets, and a check
    // for a layer ROW would otherwise fail simply because no rows are rendered.
    ([...document.querySelectorAll('.oc-dock__tabs button')].find((b) =>
      (b.textContent || '').includes('Layers'),
    ) as HTMLButtonElement | undefined)?.click();
    await sleep(150);
    const beforePaint = pixelHash();
    // Coordinates are taken as FRACTIONS of the rendered document, so the assertions hold at
    // whatever zoom the fit lands on rather than assuming one.
    // Pin the stage to a known size. The panel SPLITTER's own sizing is not what these
    // assertions are about, and under the harness's synthetic viewport it hands the canvas a
    // few pixels — which would make every pointer coordinate land outside the document and the
    // tools look broken when they are not. Resizing triggers the stage's ResizeObserver, which
    // re-fits the zoom, so the coordinates below stay meaningful.
    // `flex: none` first: the stage is a flex item with `flex: 1`, so its flex-basis wins over
    // any width set here and the resize would silently do nothing.
    stage!.style.flex = 'none';
    stage!.style.width = '700px';
    stage!.style.height = '500px';
    button('Fit to window')?.click();
    await sleep(250);
    const rect = doc!.getBoundingClientRect();
    results.docRect = `${Math.round(rect.width)}x${Math.round(rect.height)}`;

    pointer('pointerdown', rect.width * 0.2, rect.height * 0.2);
    pointer('pointermove', rect.width * 0.4, rect.height * 0.4);
    pointer('pointermove', rect.width * 0.7, rect.height * 0.6);
    pointer('pointerup', rect.width * 0.7, rect.height * 0.6);
    await sleep(400);
    results.paintLayerCreated = [...document.querySelectorAll('.oc-layer__name')].some((e) =>
      (e.textContent || '').includes('Paint'),
    );
    results.paintDeposited = pixelHash() !== beforePaint;

    const undoBtn = button('Undo');
    undoBtn?.click();
    await sleep(300);
    // ONE undo removes the whole stroke, not one pointermove's worth of it.
    results.strokeIsOneUndoStep = pixelHash() === beforePaint;

    // 7. Selection — a marquee must produce marching ants, and Escape must clear it.
    rail('Rectangle Select')?.click();
    await sleep(120);
    pointer('pointerdown', rect.width * 0.1, rect.height * 0.1);
    pointer('pointermove', rect.width * 0.5, rect.height * 0.5);
    pointer('pointerup', rect.width * 0.6, rect.height * 0.7);
    await sleep(400);
    const antPath = document.querySelector('.oc-ants__over')?.getAttribute('d') || '';
    results.selectionAnts = antPath.length > 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    results.selectionCleared = !document.querySelector('.oc-ants__over');

    const ori = (r: unknown) => (r as { top: string; bottom: string } | null);
    results.ok =
      results.mounted === true &&
      results.layerAdded === true &&
      results.sizedFromDecode === true &&
      results.filterApplied === true &&
      results.undoRemovedFilter === true &&
      results.foundShapeAsset === true &&
      results.shapeChangedPixels === true &&
      results.foundTextPreset === true &&
      results.textChangedPixels === true &&
      results.hasStage === true &&
      results.paintLayerCreated === true &&
      results.paintDeposited === true &&
      results.strokeIsOneUndoStep === true &&
      results.selectionAnts === true &&
      results.selectionCleared === true &&
      ori(results.renderedNoFilter)?.top === 'red' &&
      ori(results.renderedNoFilter)?.bottom === 'blue' &&
      ori(results.renderedOneFilter)?.top === 'red' &&
      ori(results.renderedOneFilter)?.bottom === 'blue';
  } catch (e) {
    results.error = String(e);
    results.stack = (e as Error)?.stack;
    results.ok = false;
  }
  done(results);
}

window.addEventListener('error', (e) => done({ ok: false, error: 'window error: ' + e.message }));
window.addEventListener('unhandledrejection', (e) =>
  done({ ok: false, error: 'rejection: ' + String(e.reason) }),
);

void main();
