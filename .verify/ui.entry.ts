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
