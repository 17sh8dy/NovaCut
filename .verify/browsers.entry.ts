/**
 * Browser-shelf harness — drives the REAL video editor through the new libraries.
 *
 * The catalogs are verified elsewhere (`verify:textanim` proves the animation maths, the GL
 * harness proves the shaders reach pixels). What neither of those can tell you is whether a
 * user can actually GET to any of it: whether the rail opens the Filters panel, whether a chip
 * click reaches the right clip, whether search narrows the grid, whether the star sticks. Those
 * are the failures that make a finished feature indistinguishable from an unbuilt one.
 *
 * So this mounts `EditorApp` — the same component the desktop app ships — clicks the shelves the
 * way a person would, and asserts on the resulting PROJECT STATE rather than on the DOM. A chip
 * that highlights but writes nothing to the clip has failed, and only a state assertion catches
 * that.
 *
 *   npm run verify:browsers
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, createAppStore } from '@opencut/ui';
import { TICKS_PER_SECOND, updateClip, type PlatformBridge } from '@opencut/core';

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
/** Ask the host to capture the window; it writes a PNG next to the harness. */
const shot = async (name: string) => {
  console.log('__SHOT__' + name);
  await sleep(700);
};

const text = (el: Element | null | undefined) => (el?.textContent || '').trim();

/** A rail button, matched on its visible label. */
const rail = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.oc-rail__btn')].find((b) =>
    text(b).toLowerCase().includes(label.toLowerCase()),
  );

/**
 * A chip's CARD in the current browser grid, matched on its label.
 *
 * The card is a `<div>` wrapping two buttons — the apply target and the favourite star — because
 * nesting a button inside a button is invalid HTML. So clicking the card does nothing: a DOM
 * click dispatches at the element you name and bubbles UP, it does not propagate down into a
 * child. `clickChip` exists to stop that mistake being made twice.
 */
const chipCard = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.oc-chip--item')].find(
    (c) => text(c.querySelector('.oc-chip__label')).toLowerCase() === label.toLowerCase(),
  );

/** Click a chip the way a user does — on its apply button. */
const clickChip = (label: string): boolean => {
  const hit = chipCard(label)?.querySelector<HTMLButtonElement>('.oc-chip__hit');
  hit?.click();
  return !!hit;
};

const chipLabels = () =>
  [...document.querySelectorAll('.oc-chip__label')].map((e) => text(e));

/** A button anywhere, matched on text or title. */
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (text(b) + ' ' + (b.getAttribute('title') || '')).toLowerCase().includes(label.toLowerCase()),
  );

/** A tab in a browser's category strip. */
const tab = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.oc-browser__tabs button')].find(
    (b) => text(b).toLowerCase() === label.toLowerCase(),
  );

/** A sub-tab in the Text panel's Presets/Animations/Effects segmented control. */
const section = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.oc-browser__sections button')].find(
    (b) => text(b).toLowerCase() === label.toLowerCase(),
  );

async function typeInSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('.oc-browser__search input');
  if (!input) return false;
  // React owns the input's value, so setting `.value` directly is reverted on the next render.
  // Going through the native setter and then dispatching `input` is what makes React see it.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(180);
  return true;
}

async function main() {
  const results: Record<string, unknown> = {};
  try {
    document.documentElement.style.cssText = 'width:100%;height:100%';
    document.body.style.cssText = 'margin:0;width:1440px;height:900px;overflow:hidden';
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    document.body.appendChild(host);

    /*
     * Wipe the shelves' persisted state first.
     *
     * Favourites are a TOGGLE backed by localStorage, and localStorage survives between runs of
     * this harness. Left alone, run N stars "Fade In" and run N+1 un-stars it, so the check
     * passes and fails on alternate runs — a flake that looks like a real intermittent bug and
     * costs an afternoon to chase. A fresh shelf every run is the only way the assertion means
     * anything.
     */
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('opencut.favorites.') || key.startsWith('opencut.recent.')) {
        localStorage.removeItem(key);
      }
    }

    const store = createAppStore(bridge);
    store.getState().setView('editor');
    // The recovery prompt from a previous harness run covers the timeline in every screenshot.
    setTimeout(() => button('Discard')?.click(), 900);
    createRoot(host).render(createElement(EditorApp, { store }));
    await sleep(500);

    const seq = () => store.getState().sequence();
    const clips = () => seq().tracks.flatMap((t) => t.clips);
    const textClip = () => clips().find((c) => c.kind === 'text');

    results.mounted = !!document.querySelector('.oc-rail');
    results.railHasFilters = !!rail('Filters');

    // ── 1. Add a title, so the animation shelves have something to act on ──
    rail('Text')?.click();
    await sleep(250);
    results.textPanelDefaultsToPresets = !!document.querySelector('.oc-textpreset');
    (document.querySelector('.oc-textpreset') as HTMLButtonElement | undefined)?.click();
    await sleep(350);
    results.textClipAdded = !!textClip();

    // ── 2. Text ▸ Animations ▸ In ──
    section('Animations')?.click();
    await sleep(250);
    results.animTabsPresent = ['In', 'Out', 'Loop'].every((t) => !!tab(t));
    const inCount = chipLabels().length;
    results.inAnimationsListed = inCount;

    await shot('text-animations-in');

    results.chipClickable = clickChip('Pop In');
    await sleep(300);
    const afterIn = textClip()?.text;
    results.animateInApplied = afterIn?.animateIn?.type === 'pop-in';
    results.animateInHasDuration = (afterIn?.animateIn?.duration ?? 0) > 0;

    // ── 3. Out and Loop write their OWN slots — the three must not collide ──
    tab('Out')?.click();
    await sleep(220);
    results.outAnimationsListed = chipLabels().length;

    /*
     * An idle chip must show its subject, and for exits that means resting at progress 0.
     *
     * The preview runs the animation's real `apply()`, so parking every un-hovered chip at
     * progress 1 — "finished" — would render all twenty-five exits as an empty box: faded out,
     * slid off, scaled to nothing. Every state assertion in this file would still pass. Reading
     * the previews' computed opacity is what actually catches it.
     */
    const idleOpacities = [...document.querySelectorAll('.oc-animprev__text')].map((e) =>
      parseFloat(getComputedStyle(e).opacity || '1'),
    );
    results.exitChipsVisibleAtRest =
      idleOpacities.length > 0 && idleOpacities.every((o) => o > 0.9);
    await shot('text-animations-out');

    clickChip('Fade Out');
    await sleep(280);

    tab('Loop')?.click();
    await sleep(220);
    results.loopAnimationsListed = chipLabels().length;
    clickChip('Pulse');
    await sleep(280);

    const all3 = textClip()?.text;
    results.threeSlotsCoexist =
      all3?.animateIn?.type === 'pop-in' &&
      all3?.animateOut?.type === 'fade-out' &&
      all3?.animateLoop?.type === 'pulse';

    // ── 4. Clicking the applied chip again clears that slot ──
    clickChip('Pulse');
    await sleep(280);
    results.clickAgainClearsSlot = textClip()?.text?.animateLoop === undefined;

    // ── 5. Search narrows the grid ──
    tab('In')?.click();
    await sleep(200);
    results.searchBoxPresent = await typeInSearch('slide');
    const narrowed = chipLabels();
    results.searchNarrows = narrowed.length > 0 && narrowed.length < inCount;
    results.searchResultsAllMatch = narrowed.every((l) => l.toLowerCase().includes('slide'));
    await typeInSearch('');
    await sleep(150);

    // ── 6. Favourites persist to the shelf's own storage ──
    // Is localStorage even usable here? A file:// page can be handed an opaque origin, in which
    // case the shelf's persistence is untestable by this harness rather than broken in the app —
    // and the two must not be confused for one another.
    try {
      localStorage.setItem('opencut.probe', '1');
      results.localStorageAvailable = localStorage.getItem('opencut.probe') === '1';
    } catch (e) {
      results.localStorageAvailable = false;
      results.localStorageError = String(e);
    }
    const star = chipCard('Fade In')?.querySelector<HTMLButtonElement>('.oc-chip__fav');
    results.foundFavouriteStar = !!star;
    star?.click();
    await sleep(250);
    results.favoriteStored = (localStorage.getItem('opencut.favorites.text-anim') || '').includes('fade-in');
    results.favoriteSectionShown = [...document.querySelectorAll('.oc-section-title')].some((e) =>
      text(e).toLowerCase().includes('favourite'),
    );

    // ── 7. Text ▸ Effects applies a real recipe as real effects ──
    section('Effects')?.click();
    await sleep(280);
    results.textEffectsListed = chipLabels().length;
    const fxBefore = textClip()?.effects.length ?? 0;
    await shot('text-effects');
    clickChip('Long Shadow');
    await sleep(320);
    const fxAfter = textClip()?.effects.length ?? 0;
    // Long Shadow is a three-step recipe, so it must add three stacked effects — and undo must
    // take all three back as ONE step.
    results.recipeAddedMultipleEffects = fxAfter - fxBefore === 3;
    store.getState().undo();
    await sleep(250);
    results.recipeIsOneUndoStep = (textClip()?.effects.length ?? -1) === fxBefore;

    // ── 8. The Filters shelf ──
    rail('Filters')?.click();
    await sleep(300);
    results.filterCategoriesPresent = ['Basic', 'Cinematic', 'Vintage', 'B&W'].every((t) => !!tab(t));
    results.filtersListed = chipLabels().length;
    await shot('filters');

    // Diagnostic: a preview that occupies no space, or that never got its background, is a
    // browser full of blank boxes — which passes every state assertion above and is useless.
    {
      const img = document.querySelector('.oc-filtprev__img');
      const prev = document.querySelector('.oc-chip__preview');
      const r = img?.getBoundingClientRect();
      const cs = img ? getComputedStyle(img) : null;
      const chain: string[] = [];
      let node: Element | null = prev ?? null;
      while (node && chain.length < 6) {
        const b = node.getBoundingClientRect();
        const st = getComputedStyle(node);
        chain.push(`${node.className}|${Math.round(b.width)}x${Math.round(b.height)}|disp=${st.display}|w=${st.width}|align=${st.alignItems}`);
        node = node.parentElement;
      }
      results.swatchDiag = {
        imgPresent: !!img,
        imgBox: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null,
        imgBackground: cs ? cs.backgroundImage.slice(0, 40) : null,
        chain,
      };
      // A preview with zero area is a blank chip. It satisfies every other assertion in this
      // file, so without this the browsers can look finished and ship showing nothing.
      results.swatchHasArea = !!r && r.width > 20 && r.height > 20;
    }

    tab('Cinematic')?.click();
    await sleep(220);
    const cinematic = chipLabels();
    results.cinematicTabFilters = cinematic.length > 0 && cinematic.length < (results.filtersListed as number);
    results.cinematicIncludesTealOrange = cinematic.includes('Teal & Orange');

    const beforeFilter = textClip()?.effects.length ?? 0;
    clickChip('Teal & Orange');
    await sleep(320);
    const applied = textClip()?.effects ?? [];
    results.filterApplied = applied.length === beforeFilter + 1;
    results.filterIsTealOrange = applied[applied.length - 1]?.type === 'f-teal-orange';
    // The one exposed dial has to arrive seeded, or the filter renders at zero strength.
    results.filterHasIntensity = applied[applied.length - 1]?.params.intensity?.static === 1;

    // ── 9. The Effects shelf must NOT have been flooded by the filters ──
    rail('Effects')?.click();
    await sleep(280);
    tab('All')?.click();
    await sleep(220);
    const toolLabels = chipLabels();
    results.effectsShelfExcludesFilters = !toolLabels.includes('Teal & Orange');
    results.effectsShelfExcludesHiddenMask = !toolLabels.includes('Reveal Mask');
    results.effectsShelfStillHasTools = toolLabels.includes('Gaussian Blur');
    await shot('effects');

    // ── 10. The inspector exposes the same slots for tuning ──
    store.getState().selectClip(textClip()!.id);
    store.getState().setInspectorTab('text');
    await sleep(320);
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.oc-select')];
    results.inspectorAnimationSelects = selects.length;
    results.inspectorShowsAppliedAnimation = selects.some((s) => s.value === 'pop-in');
    await shot('inspector-text');

    // ── 11. End to end: an animation chosen in the browser must change PIXELS ──
    //
    // Everything above proves the click reaches the model. This proves the model reaches the
    // screen — the step where a lane that was designed for a DOM overlay and rebuilt for the
    // GPU rasterizer would quietly do nothing. A title that animates in the data and sits
    // motionless in the preview is the exact failure mode worth a pixel assertion.
    {
      const clip = textClip()!;
      const seqId = seq().id;
      // Fade In only, over a known window, so the expected result is unambiguous.
      store.getState().dispatch({
        label: 'Harness: set fade in',
        apply: (proj) =>
          updateClip(proj, seqId, clip.id, (c) => ({
            ...c,
            effects: [],
            text: { ...c.text!, animateIn: { type: 'fade-in', params: {}, duration: 1 }, animateOut: undefined, animateLoop: undefined },
          })),
      });
      await sleep(200);

      const canvas = document.querySelector<HTMLCanvasElement>('.oc-preview__canvas-wrap canvas');
      results.previewCanvasFound = !!canvas;
      /** Mean luminance of the whole frame — the title is white on black, so it only rises. */
      const brightness = (): number => {
        if (!canvas) return -1;
        const o = document.createElement('canvas');
        o.width = canvas.width;
        o.height = canvas.height;
        const cx = o.getContext('2d', { willReadFrequently: true })!;
        cx.drawImage(canvas, 0, 0);
        const d = cx.getImageData(0, 0, o.width, o.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
        return sum / (d.length / 4) / 3;
      };

      const seek = async (seconds: number) => {
        store.getState().setPlayhead((seconds * TICKS_PER_SECOND) as never);
        await sleep(260);
      };

      await seek(0.02);
      const atStart = brightness();
      await seek(1.5);
      const afterFade = brightness();

      // Faded in, the title is on screen; two hundredths of a second in, it is all but gone.
      results.fadeInStartBrightness = +atStart.toFixed(2);
      results.fadeInRestBrightness = +afterFade.toFixed(2);
      results.animationReachesPixels = afterFade > atStart + 1 && atStart < 3;
    }

    results.ok =
      results.mounted === true &&
      results.chipClickable === true &&
      results.railHasFilters === true &&
      results.textClipAdded === true &&
      results.animTabsPresent === true &&
      results.inAnimationsListed === 25 &&
      results.outAnimationsListed === 25 &&
      results.exitChipsVisibleAtRest === true &&
      results.loopAnimationsListed === 25 &&
      results.animateInApplied === true &&
      results.animateInHasDuration === true &&
      results.threeSlotsCoexist === true &&
      results.clickAgainClearsSlot === true &&
      results.searchNarrows === true &&
      results.searchResultsAllMatch === true &&
      results.favoriteStored === true &&
      results.favoriteSectionShown === true &&
      (results.textEffectsListed as number) >= 25 &&
      results.recipeAddedMultipleEffects === true &&
      results.recipeIsOneUndoStep === true &&
      results.filterCategoriesPresent === true &&
      (results.filtersListed as number) >= 25 &&
      results.cinematicTabFilters === true &&
      results.swatchHasArea === true &&
      results.filterApplied === true &&
      results.filterIsTealOrange === true &&
      results.filterHasIntensity === true &&
      results.effectsShelfExcludesFilters === true &&
      results.effectsShelfExcludesHiddenMask === true &&
      results.effectsShelfStillHasTools === true &&
      results.inspectorAnimationSelects === 3 &&
      results.inspectorShowsAppliedAnimation === true &&
      results.previewCanvasFound === true &&
      results.animationReachesPixels === true;
  } catch (e) {
    results.error = String(e);
    results.stack = (e as Error)?.stack;
    // ── 11. End to end: an animation chosen in the browser must change PIXELS ──
    //
    // Everything above proves the click reaches the model. This proves the model reaches the
    // screen — the step where a lane that was designed for a DOM overlay and rebuilt for the
    // GPU rasterizer would quietly do nothing. A title that animates in the data and sits
    // motionless in the preview is the exact failure mode worth a pixel assertion.
    {
      const clip = textClip()!;
      const seqId = seq().id;
      // Fade In only, over a known window, so the expected result is unambiguous.
      store.getState().dispatch({
        label: 'Harness: set fade in',
        apply: (proj) =>
          updateClip(proj, seqId, clip.id, (c) => ({
            ...c,
            effects: [],
            text: { ...c.text!, animateIn: { type: 'fade-in', params: {}, duration: 1 }, animateOut: undefined, animateLoop: undefined },
          })),
      });
      await sleep(200);

      const canvas = document.querySelector<HTMLCanvasElement>('.oc-preview__canvas-wrap canvas');
      results.previewCanvasFound = !!canvas;
      /** Mean luminance of the whole frame — the title is white on black, so it only rises. */
      const brightness = (): number => {
        if (!canvas) return -1;
        const o = document.createElement('canvas');
        o.width = canvas.width;
        o.height = canvas.height;
        const cx = o.getContext('2d', { willReadFrequently: true })!;
        cx.drawImage(canvas, 0, 0);
        const d = cx.getImageData(0, 0, o.width, o.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
        return sum / (d.length / 4) / 3;
      };

      const seek = async (seconds: number) => {
        store.getState().setPlayhead((seconds * TICKS_PER_SECOND) as never);
        await sleep(260);
      };

      await seek(0.02);
      const atStart = brightness();
      await seek(1.5);
      const afterFade = brightness();

      // Faded in, the title is on screen; two hundredths of a second in, it is all but gone.
      results.fadeInStartBrightness = +atStart.toFixed(2);
      results.fadeInRestBrightness = +afterFade.toFixed(2);
      results.animationReachesPixels = afterFade > atStart + 1 && atStart < 3;
    }

    results.ok = false;
  }
  done(results);
}

window.addEventListener('error', (e) => done({ ok: false, error: 'window error: ' + e.message }));
window.addEventListener('unhandledrejection', (e) =>
  done({ ok: false, error: 'rejection: ' + String(e.reason) }),
);

void main();
