/**
 * GL Transitions Inspector harness: mounts the REAL editor and drives the REAL controls.
 *
 * The node suites prove the commands and the derived control list. What only a DOM can show is
 * that those controls are actually on screen and that touching one reaches the project: a colour
 * swatch that renders but writes nothing is indistinguishable, in a state test, from one that
 * works. So every assertion below reads the PROJECT, after doing what a person would do.
 *
 *   npm run verify:gltui      (screenshots: .verify/shots/gl-transition-inspector*.png)
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, createAppStore } from '@opencut/ui';
import {
  TICKS_PER_SECOND,
  addClip,
  addMedia,
  addTrack,
  createClipFromMedia,
  type PlatformBridge,
} from '@opencut/core';

const S = TICKS_PER_SECOND;
const bridge: PlatformBridge = {
  platform: 'desktop',
  openProjectDialog: async () => null,
  saveProject: async () => null,
  loadProject: async () => {
    throw new Error('unused');
  },
  recentProjects: async () => [],
  importDialog: async () => [],
  probeMedia: async () => {
    throw new Error('unused');
  },
  generateThumbnail: async () => '',
  resolveMediaUrl: (src) => src,
  resolveDroppedFile: () => null,
  chooseExportPath: async () => null,
  createEncoder: async () => {
    throw new Error('unused');
  },
  notify: () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = (r: Record<string, unknown>) => console.log('__RESULT__' + JSON.stringify(r));
const shot = async (name: string) => {
  console.log('__SHOT__' + name);
  await sleep(700);
};
const text = (el: Element | null | undefined) => (el?.textContent || '').trim();
const rail = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.oc-rail__btn')].find((b) => text(b).toLowerCase().includes(label.toLowerCase()));
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b).toLowerCase().includes(label.toLowerCase()));
const eqArr = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const nativeSet = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

async function main() {
  const results: Record<string, unknown> = {};
  try {
    document.documentElement.style.cssText = 'width:100%;height:100%';
    document.body.style.cssText = 'margin:0;width:1440px;height:900px;overflow:hidden';
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    document.body.appendChild(host);
    for (const key of Object.keys(localStorage)) if (key.startsWith('oc.preferences') || key.startsWith('opencut.')) localStorage.removeItem(key);

    const store = createAppStore(bridge);
    const s = () => store.getState();
    s().setView('editor');
    setTimeout(() => button('Discard')?.click(), 900);
    createRoot(host).render(createElement(EditorApp, { store }));
    await sleep(500);

    // Three butt-joined clips on one track.
    const media = { id: 'm1', name: 'a.mp4', kind: 'video' as const, src: '/tmp/a.mp4', duration: 60 * S, width: 1920, height: 1080, fps: 30, hasAudio: false, fileSize: 1, importedAt: 0 };
    s().dispatch(addMedia([media]));
    s().dispatch(addTrack('video'));
    const track = s().sequence().tracks.find((t) => t.kind === 'video')!;
    for (const [id, start] of [['A', 0], ['B', 5], ['C', 10]] as const) {
      s().dispatch(addClip(track.id, { ...createClipFromMedia(media, start * S), id, start: start * S, duration: 5 * S, sourceOut: 5 * S }));
    }
    const transitions = () => s().sequence().tracks.find((t) => t.id === track.id)!.transitions;
    const select = (id: string) => {
      s().selectTransition({ trackId: track.id, id });
    };

    // ── 1. The library: tabs, search, thumbnails, hover, favourites, drag ──
    rail('Trans')?.click();
    await sleep(350);
    const labels = () => [...document.querySelectorAll('.oc-chip--item .oc-chip__label')].map((e) => text(e));
    const tabButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.oc-browser__tabs button')];
    const tabNamed = (n: string) => tabButtons().find((t) => text(t) === n);
    const tabNames = tabButtons().map(text);
    results.tabsPresent = ['Featured', 'All', 'Nova Classic'].every((t) => tabNames.includes(t)) && tabNames.length === 11;
    results.featuredIsTheDefaultShelf = labels().length === 36 && tabNamed('Featured')?.getAttribute('aria-selected') === 'true';
    tabNamed('Nova Classic')?.click();
    await sleep(200);
    results.classicTabHasTheEighteen = labels().length === 18 && labels().includes('Cross Dissolve');
    tabNamed('All')?.click();
    await sleep(250);
    results.allTabHasEveryTransition = labels().length === 18 + 125;
    tabNamed('Glitch & Distort')?.click();
    await sleep(200);
    results.categoryTabFilters = labels().length > 5 && labels().length < 60 && labels().includes('Cross Warp');
    tabNamed('All')?.click();
    await sleep(200);

    const search = async (q: string) => {
      const input = document.querySelector<HTMLInputElement>('.oc-browser__search input');
      if (!input) return;
      nativeSet(input, q);
      await sleep(250);
    };
    await search('swirl');
    results.searchFindsByName = labels().includes('Swirl');
    await search('fkuteken');
    results.searchFindsByAuthor = labels().includes('Circle Crop') && labels().length < 15;
    await search('glitch');
    results.searchFindsByTag = labels().length > 3 && labels().length < 60;
    await search('qwertyuiop');
    results.searchWithNoMatchSaysSo = labels().length === 0 && !!document.querySelector('.oc-browser__none');
    await search('');
    tabNamed('Featured')?.click();
    await sleep(250);

    await shot('gl-transitions-library');
    // thumbnails are frames of the pre-rendered strip, not CSS imitations
    const thumbs = [...document.querySelectorAll<HTMLElement>('.oc-chip--item .oc-tthumb')];
    results.everyChipHasAThumbnail = thumbs.length === labels().length && thumbs.length === 36;
    results.thumbnailsUseTheSprite = thumbs.every((t) => /transition-sprites|image\/webp/.test(getComputedStyle(t).backgroundImage));
    const card = (label: string) => [...document.querySelectorAll<HTMLElement>('.oc-chip--item')].find((c) => text(c.querySelector('.oc-chip__label')) === label);
    const cc = card('Circle Crop');
    const thumb = cc?.querySelector<HTMLElement>('.oc-tthumb');
    const rest = thumb ? getComputedStyle(thumb).backgroundPosition : '';
    cc?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 1 }));
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await sleep(70);
      if (thumb) seen.add(getComputedStyle(thumb).backgroundPosition);
    }
    results.hoverPlaysTheStrip = seen.size >= 3;
    cc?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerId: 1 }));
    await sleep(250);
    results.restingFrameReturnsAfterHover = !!thumb && getComputedStyle(thumb).backgroundPosition === rest;
    // chips that are not hovered must be completely still: sample them twice, 400 ms apart
    const idleNow = () => [...document.querySelectorAll<HTMLElement>('.oc-chip--item .oc-tthumb')].filter((t) => t !== thumb).map((t) => getComputedStyle(t).backgroundPosition);
    const idleBefore = idleNow();
    await sleep(400);
    results.onlyTheHoveredChipAnimates = idleBefore.length > 10 && eqArr(idleBefore, idleNow());

    // favourites
    localStorage.removeItem('opencut.favorites.transitions');
    card('Swap')?.querySelector<HTMLButtonElement>('.oc-chip__fav')?.click();
    await sleep(250);
    results.favouriteCreatesASection = [...document.querySelectorAll('.oc-section-title')].some((e) => text(e) === 'Favourites');

    // drag and drop: the chip carries its type for the timeline to read
    const dt = new DataTransfer();
    card('Cross Warp')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    results.dragCarriesTheTransitionType = dt.getData('application/x-opencut-transition') === 'gl:crosswarp';

    // ── 2. Clicking a GL chip puts it on the cut, with its default settings ──
    tabNamed('All')?.click();
    await sleep(250);
    await search('circle crop');
    s().selectClip('A');
    s().setPlayhead(5 * S);
    card('Circle Crop')?.querySelector<HTMLButtonElement>('.oc-chip__hit')?.click();
    await sleep(300);
    results.clickingAChipAddsTheTransition = transitions().length === 1 && transitions()[0]!.type === 'gl:CircleCrop';
    const id = transitions()[0]?.id ?? '';
    results.addedWithDefaultColour = transitions()[0]?.params['bgcolor.r'] === 0 && transitions()[0]?.params['bgcolor.a'] === 1;
    await search('');

    // ── 3. The Inspector shows generated controls ──
    select(id);
    await sleep(400);
    const typeSelect = document.querySelector<HTMLSelectElement>('.oc-inspector select.oc-select, select.oc-select');
    results.typeSelectShowsTheTransition = typeSelect?.value === 'gl:CircleCrop';
    const groups = [...document.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    results.typeSelectIsGrouped = groups.includes('Nova Classic') && groups.some((g) => g?.startsWith('GL · '));
    results.creditLineShown = document.body.innerText.includes('By fkuteken') && document.body.innerText.includes('MIT');
    const colour = document.querySelector<HTMLInputElement>('input[type=color]');
    results.colourControlRendered = !!colour && colour.value === '#000000';
    results.opacityControlRendered = document.body.innerText.includes('Opacity');
    results.resetButtonRendered = !!button('Reset settings');
    await shot('gl-transition-inspector');

    // ── 4. Using the controls writes to the project ──
    if (colour) nativeSet(colour, '#ff8000');
    await sleep(250);
    const p = transitions()[0]!.params;
    results.colourPickWritesRgb = p['bgcolor.r'] === 1 && Math.abs(p['bgcolor.g'] - 128 / 255) < 1e-6 && p['bgcolor.b'] === 0;
    results.colourPickLeavesOpacityAlone = p['bgcolor.a'] === 1;
    s().undo();
    results.oneUndoRevertsTheWholeColourPick = transitions()[0]!.params['bgcolor.r'] === 0 && transitions()[0]!.params['bgcolor.g'] === 0;
    s().redo();
    await sleep(200);
    button('Reset settings')?.click();
    await sleep(250);
    results.resetButtonRestoresDefaults = transitions()[0]!.params['bgcolor.r'] === 0 && transitions()[0]!.params['bgcolor.g'] === 0;

    // ── 5. A boolean parameter is a toggle that flips the value ──
    s().dispatch({ label: 'noop', apply: (x) => x }); // keep history honest; no-op is ignored
    const { addTransition } = await import('@opencut/core');
    s().dispatch(addTransition(track.id, 'B', 'C', 'gl:Rolls', S));
    const rolls = transitions().find((t) => t.type === 'gl:Rolls')!;
    select(rolls.id);
    await sleep(400);
    const toggleRow = [...document.querySelectorAll<HTMLElement>('.oc-field')].find((f) => text(f.querySelector('.oc-field__label')) === 'Roll Down');
    results.boolRendersAsAToggle = !!toggleRow?.querySelector('button');
    toggleRow?.querySelector('button')?.click();
    await sleep(250);
    results.toggleWritesOne = transitions().find((t) => t.id === rolls.id)!.params.RotDown === 1;

    // ── 6. A vector parameter gets one slider per component ──
    s().dispatch(addTransition(track.id, 'B', 'C', 'gl:Directional', S));
    const dir = transitions().find((t) => t.type === 'gl:Directional')!;
    select(dir.id);
    await sleep(400);
    const vecRow = [...document.querySelectorAll<HTMLElement>('.oc-field')].find((f) => text(f.querySelector('.oc-field__label')) === 'Direction');
    results.vectorHasTwoSliders = (vecRow?.querySelectorAll('.oc-slider').length ?? 0) === 2;

    // ── 6b. A texture shader gets a dropdown of built-in maps ──
    s().dispatch(addTransition(track.id, 'A', 'B', 'gl:luma', S));
    const lumaTr = transitions().find((t) => t.type === 'gl:luma')!;
    select(lumaTr.id);
    await sleep(400);
    const mapRow = [...document.querySelectorAll<HTMLElement>('.oc-field')].find((f) => text(f.querySelector('.oc-field__label')) === 'Mask Shape');
    const mapSelect = mapRow?.querySelector<HTMLSelectElement>('select');
    results.textureShaderShowsAMapDropdown = !!mapSelect && mapSelect.options.length === 8 && mapSelect.value === '3';
    if (mapSelect) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(mapSelect, '0');
      mapSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(250);
    results.pickingAMapWritesTheProject = transitions().find((t) => t.id === lumaTr.id)!.params['luma.map'] === 0;

    // ── 7. A GL transition stays selected and editable ──
    select(dir.id);
    await sleep(300);
    const sel2 = document.querySelector<HTMLSelectElement>('select.oc-select');
    results.typeSelectKeepsTheTransition = sel2?.value === 'gl:Directional' && !!sel2.querySelector('option[value="gl:Directional"]');

    // ── 8. Classic transitions are untouched ──
    s().dispatch(addTransition(track.id, 'A', 'B', 'wipe', S));
    const wipe = transitions().find((t) => t.type === 'wipe')!;
    select(wipe.id);
    await sleep(300);
    results.classicStillGetsPlainSliders = document.querySelectorAll('.oc-slider').length === 3 && !document.querySelector('input[type=color]'); // duration + angle + softness
    await shot('gl-transition-inspector-classic');

    done({ ...results, ok: Object.values(results).every((v) => v === true) });
  } catch (err) {
    done({ ...results, ok: false, error: String(err), stack: (err as Error)?.stack });
  }
}
window.addEventListener('error', (e) => done({ ok: false, error: 'window error: ' + e.message }));
window.addEventListener('unhandledrejection', (e) => done({ ok: false, error: 'rejection: ' + String(e.reason) }));
main();
