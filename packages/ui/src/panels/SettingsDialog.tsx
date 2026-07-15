/**
 * The application Settings window: a sidebar of categories (like pro editing software) plus a
 * full keyboard-shortcut editor. App-wide preferences persist via the store (localStorage);
 * theme + editing toggles reuse the existing project/store mechanisms. No engine involvement.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Settings as GeneralIcon,
  Palette,
  Scissors,
  Play,
  Keyboard,
  Gauge,
  Info,
  RotateCcw,
  AlertTriangle,
  X,
} from 'lucide-react';
import { type Project } from '@opencut/core';
import { Button, Segmented } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { SHORTCUT_DEFS, comboFromEvent, conflicts, formatCombo, type ShortcutId } from '../state/shortcuts.js';

type Category = 'General' | 'Appearance' | 'Editing' | 'Playback' | 'Keyboard Shortcuts' | 'Performance' | 'About';

const CATEGORIES: { id: Category; icon: typeof GeneralIcon }[] = [
  { id: 'General', icon: GeneralIcon },
  { id: 'Appearance', icon: Palette },
  { id: 'Editing', icon: Scissors },
  { id: 'Playback', icon: Play },
  { id: 'Keyboard Shortcuts', icon: Keyboard },
  { id: 'Performance', icon: Gauge },
  { id: 'About', icon: Info },
];

export function SettingsDialog() {
  const store = useAppStore();
  const [category, setCategory] = useState<Category>('General');

  const close = () => store.getState().openDialog(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="oc-backdrop" onPointerDown={close}>
      <div className="oc-settings" onPointerDown={(e) => e.stopPropagation()}>
        <nav className="oc-settings__sidebar">
          <div className="oc-settings__brand">Settings</div>
          {CATEGORIES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className="oc-settings__navitem"
              data-active={category === id}
              onClick={() => setCategory(id)}
            >
              <Icon size={16} />
              {id}
            </button>
          ))}
        </nav>

        <div className="oc-settings__main">
          <div className="oc-settings__header">
            <h2>{category}</h2>
            <button className="oc-icon-btn" onClick={close} aria-label="Close settings">
              <X size={18} />
            </button>
          </div>
          <div className="oc-settings__content">
            {category === 'General' && <GeneralPane />}
            {category === 'Appearance' && <AppearancePane />}
            {category === 'Editing' && <EditingPane />}
            {category === 'Playback' && <PlaybackPane />}
            {category === 'Keyboard Shortcuts' && <ShortcutsPane />}
            {category === 'Performance' && <PerformancePane />}
            {category === 'About' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Reusable row + toggle ──────────────────────────────────────────────────────

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="oc-setting-row">
      <div className="oc-setting-row__text">
        <span className="oc-setting-row__title">{title}</span>
        {desc && <span className="oc-setting-row__desc">{desc}</span>}
      </div>
      <div className="oc-setting-row__control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} className="oc-switch" data-on={checked} onClick={() => onChange(!checked)}>
      <span className="oc-switch__knob" />
    </button>
  );
}

// ── Panes ──────────────────────────────────────────────────────────────────────

function GeneralPane() {
  const store = useAppStore();
  const prefs = useStore((s) => s.preferences);
  return (
    <>
      <Row title="Show Home screen on launch" desc="Open the launcher instead of an empty project.">
        <Toggle checked={prefs.showHomeOnLaunch} onChange={(v) => store.getState().setPreference('showHomeOnLaunch', v)} />
      </Row>
      <div className="oc-setting-actions">
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => store.getState().resetPreferences()}>
          Reset all preferences to defaults
        </Button>
      </div>
    </>
  );
}

function AppearancePane() {
  const store = useAppStore();
  const theme = useStore((s) => s.project.settings.theme);
  const prefs = useStore((s) => s.preferences);
  const setTheme = (t: Project['settings']['theme']) => {
    document.documentElement.setAttribute('data-theme', t);
    store.getState().dispatch({ label: 'Theme', apply: (p) => ({ ...p, settings: { ...p.settings, theme: t } }) });
  };
  return (
    <>
      <Row title="Theme" desc="Applies to the current project.">
        <Segmented
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'midnight', label: 'Midnight' },
            { value: 'light', label: 'Light' },
          ]}
          value={theme}
          onChange={(v) => setTheme(v as Project['settings']['theme'])}
        />
      </Row>
      <Row title="Reduce motion" desc="Disable UI transitions everywhere (accessibility / large projects).">
        <Toggle checked={prefs.reduceMotionAlways} onChange={(v) => store.getState().setPreference('reduceMotionAlways', v)} />
      </Row>
    </>
  );
}

function EditingPane() {
  const store = useAppStore();
  const snap = useStore((s) => s.snapEnabled);
  const ripple = useStore((s) => s.rippleEnabled);
  return (
    <>
      <Row title="Snapping" desc="Magnetically align clips to edges, the playhead and markers. Hold Alt to bypass.">
        <Toggle checked={snap} onChange={() => store.getState().toggleSnap()} />
      </Row>
      <Row title="Ripple edits" desc="Shift later clips to close gaps when deleting.">
        <Toggle checked={ripple} onChange={() => store.getState().toggleRipple()} />
      </Row>
    </>
  );
}

function PlaybackPane() {
  const store = useAppStore();
  const prefs = useStore((s) => s.preferences);
  return (
    <>
      <Row title="Reduce animations during playback" desc="Freeze UI transitions while playing for smoother, less distracting playback.">
        <Toggle checked={prefs.reduceMotionDuringPlayback} onChange={(v) => store.getState().setPreference('reduceMotionDuringPlayback', v)} />
      </Row>
      <Row title="Auto-scroll timeline" desc="Keep the playhead in view by scrolling the timeline as it plays.">
        <Toggle checked={prefs.autoScrollDuringPlayback} onChange={(v) => store.getState().setPreference('autoScrollDuringPlayback', v)} />
      </Row>
    </>
  );
}

function PerformancePane() {
  const store = useAppStore();
  const prefs = useStore((s) => s.preferences);
  return (
    <>
      <Row title="Timeline thumbnails" desc="Show media thumbnails on clips. Turn off to reduce memory use on very large projects.">
        <Toggle checked={prefs.timelineThumbnails} onChange={(v) => store.getState().setPreference('timelineThumbnails', v)} />
      </Row>
      <Row title="Reduce animations during playback" desc="Recommended for long videos.">
        <Toggle checked={prefs.reduceMotionDuringPlayback} onChange={(v) => store.getState().setPreference('reduceMotionDuringPlayback', v)} />
      </Row>
      <p className="oc-setting-note">
        Open Cut renders the timeline with memoized, virtualization-friendly components and follows the playhead
        with a single re-render per frame, so it stays responsive on long timelines.
      </p>
    </>
  );
}

function AboutPane() {
  return (
    <div className="oc-about">
      <div className="oc-about__mark" />
      <h1>Open Cut</h1>
      <p className="oc-about__tag">A modern, professional non-linear video editor.</p>
      <p className="oc-about__ver">Version 0.1.0 · Desktop</p>
      <p className="oc-about__meta">WebGL2 compositor · Web Audio engine · FFmpeg export</p>
    </div>
  );
}

// ── Keyboard shortcut editor ────────────────────────────────────────────────────

function ShortcutsPane() {
  const store = useAppStore();
  const bindings = useStore((s) => s.shortcuts);
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const conflictMap = conflicts(bindings);

  // While capturing, the next non-modifier keystroke becomes the new binding.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(null);
      const combo = comboFromEvent(e);
      if (!combo) return; // bare modifier — keep waiting
      store.getState().setShortcut(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true); // capture phase, beats global shortcuts
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, store]);

  const grouped = ['Playback', 'Editing', 'File'] as const;

  return (
    <>
      <div className="oc-setting-actions" style={{ justifyContent: 'flex-end', marginTop: 0, marginBottom: 4 }}>
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => store.getState().resetAllShortcuts()}>
          Reset all to defaults
        </Button>
      </div>
      {grouped.map((group) => (
        <div key={group} className="oc-sc-group">
          <div className="oc-sc-group__title">{group}</div>
          {SHORTCUT_DEFS.filter((d) => d.category === group).map((def) => {
            const combo = bindings[def.id];
            const conflicted = !!conflictMap[combo];
            return (
              <div key={def.id} className="oc-sc-row">
                <span className="oc-sc-row__label">{def.label}</span>
                <div className="oc-sc-row__right">
                  {conflicted && (
                    <span className="oc-sc-row__warn" title="This key is assigned to more than one action">
                      <AlertTriangle size={13} /> Conflict
                    </span>
                  )}
                  <button
                    className="oc-sc-key"
                    data-capturing={capturing === def.id}
                    data-conflict={conflicted}
                    onClick={() => setCapturing(def.id)}
                  >
                    {capturing === def.id ? 'Press keys…' : formatCombo(combo)}
                  </button>
                  <button
                    className="oc-icon-btn oc-icon-btn--sm"
                    title="Reset to default"
                    onClick={() => store.getState().resetShortcut(def.id)}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
