/**
 * Applies preferences to the running app.
 *
 * This hook is the answer to "does this setting actually do anything?". Every preference that is
 * marked `live` in the settings registry is either read at its point of use (the timeline reads
 * `timelineHeight`, the exporter reads `exportCodec`) or applied here — and if it is applied
 * nowhere, it should not be in the registry as `live`.
 *
 * Everything below is a document-level or host-level effect, which is exactly the set that has
 * no natural owner deeper in the tree.
 */

import { useEffect } from 'react';
import { useAppStore, useStore } from './context.js';
import { applyTheme } from './preferences.js';
import { setMaxTextureSize } from '@opencut/engine';

export function useAppliedPreferences(): void {
  const store = useAppStore();
  const prefs = useStore((s) => s.preferences);

  // ── Theme, including following the OS ──
  useEffect(() => {
    const apply = () => applyTheme(prefs.theme);
    apply();
    if (prefs.theme !== 'system') return;
    // Only subscribe while actually following the OS, so the listener isn't left running for a
    // preference that can no longer change anything. This is what makes "System" live rather
    // than merely read-once: flipping Windows to light mode retints the app immediately.
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [prefs.theme]);

  /*
   * ── Accent colour ──
   *
   * ONE property. Every other accent token (--accent-hover, -active, -text, -soft, -line) is
   * derived from --accent with color-mix inside the theme blocks in tokens.css, so setting the
   * base here is enough and the derivations stay correct per theme — hover lightens on charcoal
   * and darkens on white, and this hook does not have to know which theme is active.
   *
   * It also cannot go stale: this used to write four properties, and when a fifth accent token
   * was added the inline set silently kept overriding only four of them.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!prefs.accentColor) {
      // Remove rather than reset to a literal: tokens.css is the source of truth for the brand
      // colour, and hardcoding it here would leave two copies free to disagree.
      root.style.removeProperty('--accent');
      return;
    }
    root.style.setProperty('--accent', prefs.accentColor);
  }, [prefs.accentColor]);

  // ── Density, icon size, motion ──
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-compact', prefs.compactMode);
    root.toggleAttribute('data-large-icons', prefs.largeIcons);
    root.setAttribute('data-animation', prefs.animationSpeed);
    // The existing reduce-motion gate is kept as the single switch the CSS reads, so "Off" and
    // the OS accessibility setting land in the same place.
    root.toggleAttribute('data-reduce-motion', prefs.animationSpeed === 'off');
  }, [prefs.compactMode, prefs.largeIcons, prefs.animationSpeed]);

  // ── Timeline metrics that CSS owns ──
  useEffect(() => {
    document.documentElement.style.setProperty('--track-h', `${prefs.timelineHeight}px`);
  }, [prefs.timelineHeight]);

  // ── Window zoom ──
  useEffect(() => {
    store.getState().bridge.setZoomFactor?.(prefs.uiScale / 100);
  }, [prefs.uiScale, store]);

  // ── Preferences the host acts on ──
  // Pushed rather than pulled: main cannot read the renderer's localStorage, and the values are
  // needed at the moment a dialog opens, not fetched lazily after it already has.
  useEffect(() => {
    store.getState().bridge.setHostPrefs?.({
      maxRecentProjects: prefs.maxRecentProjects,
      defaultProjectDir: prefs.defaultProjectDir,
      exportDir: prefs.exportDir,
      cpuThreads: prefs.cpuThreads,
      gpuAcceleration: prefs.gpuAcceleration,
      theme: prefs.theme,
    });
  }, [
    prefs.maxRecentProjects, prefs.defaultProjectDir, prefs.exportDir,
    prefs.cpuThreads, prefs.gpuAcceleration, prefs.theme, store,
  ]);

  // ── GPU upload cap ──
  // Set on the engine as a process-wide policy; see engine/gl/limits.ts for why it lives there
  // rather than being threaded through every render call.
  useEffect(() => {
    setMaxTextureSize(Number(prefs.maxTextureSize) || 0);
  }, [prefs.maxTextureSize]);

  // ── Launch on sign-in ──
  useEffect(() => {
    void store.getState().bridge.setLaunchOnStartup?.(prefs.launchOnStartup);
  }, [prefs.launchOnStartup, store]);

  // ── Low memory mode ──
  // It is a shorthand, not a separate mechanism: it forces off the two things that cost the most
  // memory. Expressing it as a real override rather than a flag other code has to remember to
  // check is what keeps it from becoming another declared-but-unread setting.
  useEffect(() => {
    if (!prefs.lowMemoryMode) return;
    const s = store.getState();
    if (s.preferences.timelineThumbnails) s.setPreference('timelineThumbnails', false);
    if (s.preferences.photoHqPreview) s.setPreference('photoHqPreview', false);
  }, [prefs.lowMemoryMode, store]);
}
