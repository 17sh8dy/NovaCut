/**
 * The Settings window.
 *
 * The rows are NOT written here — they are rendered from `settingsRegistry.ts`. That inversion is
 * what makes the search box real: filtering a registry is a predicate over data, whereas
 * searching a hand-written pane means the search and the UI are two lists that drift apart. It
 * also means adding a setting is one entry in one file, not a row here plus a key there plus a
 * search term somewhere else.
 *
 * Three panes are bespoke because they aren't lists of values: Shortcuts (a capture editor),
 * Storage (measured from disk) and About.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Settings as GeneralIcon, LayoutGrid, FolderOpen, Film, Image as ImageIcon, Gauge, Upload,
  Keyboard, HardDrive, Shield, Bell, FlaskConical, Info,
  RotateCcw, AlertTriangle, X, Search, Lock,
} from 'lucide-react';
import { Button, Segmented } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { SHORTCUT_DEFS, comboFromEvent, conflicts, formatCombo, type ShortcutId } from '../state/shortcuts.js';
import {
  CATEGORY_ORDER, CUSTOM_PANES, SETTINGS, categoriesMatching, matchesQuery,
  type SettingDef, type SettingsCategory,
} from '../state/settingsRegistry.js';
import { ACCENT_PRESETS, type AppPreferences } from '../state/preferences.js';
import { StoragePane } from './settings/StoragePane.js';
import { AboutPane } from './settings/AboutPane.js';
import './settings/settings.css';

/** Kept as an alias so existing callers (`initialCategory="Shortcuts"`) keep type-checking. */
export type Category = SettingsCategory;

const ICONS: Record<SettingsCategory, typeof GeneralIcon> = {
  General: GeneralIcon, Interface: LayoutGrid, Projects: FolderOpen, Video: Film,
  Photo: ImageIcon, Performance: Gauge, Export: Upload, Shortcuts: Keyboard,
  Storage: HardDrive, Privacy: Shield, Notifications: Bell, Experimental: FlaskConical, About: Info,
};

export function SettingsDialog({ initialCategory = 'General' }: { initialCategory?: Category }) {
  const store = useAppStore();
  const [category, setCategory] = useState<Category>(initialCategory);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const close = () => store.getState().openDialog(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape clears an active search before it closes the window — losing a whole dialog
        // because you wanted to undo a typo is the kind of small rudeness that adds up.
        if (searchRef.current?.value) {
          setQuery('');
          searchRef.current.value = '';
          return;
        }
        close();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searching = query.trim().length > 0;
  const hits = useMemo(() => categoriesMatching(query), [query]);
  const matched = useMemo(() => SETTINGS.filter((d) => matchesQuery(d, query)), [query]);

  // ── Sliding nav indicator ───────────────────────────────────────────────────
  const navRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<SettingsCategory, HTMLButtonElement | null>>>({});
  const [line, setLine] = useState({ top: 0, height: 0 });

  /*
   * `offsetTop` is relative to the nav (its offsetParent once it is positioned), so this stays
   * correct while the list scrolls — the indicator is inside the scroller and travels with it.
   *
   * It re-measures on `matched` as well as `category`: typing a query adds count badges, which
   * changes every row's height, and an indicator sized to the pre-search layout would sit
   * visibly proud of its row.
   */
  useLayoutEffect(() => {
    const el = itemRefs.current[category];
    if (!el) return;
    setLine({ top: el.offsetTop, height: el.offsetHeight });
  }, [category, matched, searching]);

  /*
   * While searching, land on the category with the MOST matches — not the first one in the
   * sidebar that happens to have any.
   *
   * Typing "gpu" is the case that proves it: Photo mentions GPU memory once and sits higher in
   * the list, so first-in-order lands you on a single tangential row while the three actual GPU
   * settings sit unseen under Performance. Ties fall back to sidebar order.
   */
  useEffect(() => {
    if (!searching || hits.has(category)) return;
    let best: SettingsCategory | null = null;
    let bestCount = 0;
    for (const c of CATEGORY_ORDER) {
      if (!hits.has(c)) continue;
      const count = matched.filter((d) => d.category === c).length;
      // `>` not `>=` keeps the earliest category on a tie.
      if (best === null || count > bestCount) { best = c; bestCount = count; }
    }
    if (best) setCategory(best);
  }, [searching, hits, category, matched]);

  return (
    <div className="oc-backdrop" onPointerDown={close}>
      <div className="oc-settings" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <nav className="oc-settings__sidebar">
          <div className="oc-settings__brand">Settings</div>
          <div className="oc-settings__search">
            <Search size={14} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search settings…"
              aria-label="Search settings"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="oc-settings__nav" ref={navRef}>
            {/*
              One line that SLIDES between categories, rather than thirteen that switch on and
              off. Because it is a single element it can animate, and that movement is what
              carries "you moved from Video to Photo" — a per-item border can only ever cut. It
              is decorative only in the sense that the active row is already tinted; its job is
              continuity between the row you left and the row you landed on.

              Measured from the DOM instead of computed from an index because the rows are not a
              fixed height (the search-count badge changes it), and a hard-coded row height would
              drift the moment that changed.
            */}
            <span className="oc-settings__navline" style={{ transform: `translateY(${line.top}px)`, height: line.height }} aria-hidden="true" />
            {CATEGORY_ORDER.map((id) => {
              const Icon = ICONS[id];
              const count = matched.filter((d) => d.category === id).length;
              const empty = searching && !hits.has(id);
              return (
                <button
                  key={id}
                  ref={(el) => { itemRefs.current[id] = el; }}
                  className="oc-settings__navitem"
                  data-active={category === id}
                  data-dim={empty}
                  disabled={empty}
                  onClick={() => setCategory(id)}
                >
                  <Icon size={15} />
                  <span>{id}</span>
                  {searching && count > 0 && <span className="oc-settings__count">{count}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="oc-settings__main">
          <div className="oc-settings__header">
            <h2>{category}</h2>
            {searching && (
              <span className="oc-settings__resultnote">
                {matched.length} result{matched.length === 1 ? '' : 's'} for “{query.trim()}”
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button className="oc-icon-btn" onClick={close} aria-label="Close settings">
              <X size={18} />
            </button>
          </div>
          <div className="oc-settings__content">
            <Pane category={category} query={query} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Pane({ category, query }: { category: SettingsCategory; query: string }) {
  if (CUSTOM_PANES.includes(category)) {
    if (category === 'Shortcuts') return <ShortcutsPane query={query} />;
    if (category === 'Storage') return <StoragePane />;
    return <AboutPane />;
  }
  return <RegistryPane category={category} query={query} />;
}

// ── Registry-driven pane ───────────────────────────────────────────────────────

function RegistryPane({ category, query }: { category: SettingsCategory; query: string }) {
  const rows = SETTINGS.filter((d) => d.category === category && matchesQuery(d, query));
  if (rows.length === 0) {
    return <p className="oc-setting-note">No settings here match “{query.trim()}”.</p>;
  }

  // Group headings are dropped while searching: with results scattered across groups, the
  // headings outnumber the hits and make the list harder to read, not easier.
  const searching = query.trim().length > 0;
  const groups = searching
    ? [{ name: '', items: rows }]
    : [...new Map(rows.map((r) => [r.group ?? '', [] as SettingDef[]])).entries()].map(([name]) => ({
        name,
        items: rows.filter((r) => (r.group ?? '') === name),
      }));

  const experimental = category === 'Experimental';
  return (
    <>
      {experimental && !searching && (
        <p className="oc-setting-warning">
          <AlertTriangle size={14} />
          These are unfinished. They can misbehave, and they can change or disappear without notice.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.name} className="oc-setting-group">
          {g.name && <div className="oc-setting-group__title">{g.name}</div>}
          {g.items.map((def) => (
            <SettingRow key={def.id} def={def} />
          ))}
        </div>
      ))}
      <ResetAll category={category} />
    </>
  );
}

function ResetAll({ category }: { category: SettingsCategory }) {
  const store = useAppStore();
  if (category !== 'General') return null;
  return (
    <div className="oc-setting-actions">
      <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => store.getState().resetPreferences()}>
        Reset all settings to defaults
      </Button>
    </div>
  );
}

/**
 * One row. A `planned` setting renders its control disabled with the reason attached — the point
 * is that it is visibly not available, rather than a switch that flips and does nothing.
 */
function SettingRow({ def }: { def: SettingDef }) {
  const store = useAppStore();
  const prefs = useStore((s) => s.preferences);
  const planned = def.status === 'planned';
  const gatedOff = def.requires ? !prefs[def.requires] : false;
  const disabled = planned || gatedOff;

  return (
    <div className="oc-setting-row" data-planned={planned || undefined}>
      <div className="oc-setting-row__text">
        <span className="oc-setting-row__title">
          {def.label}
          {planned && (
            <span className="oc-setting-tag" title={def.blockedBy}>
              <Lock size={10} /> Not yet available
            </span>
          )}
          {def.needsRestart && <span className="oc-setting-tag oc-setting-tag--info">Restart required</span>}
        </span>
        {def.desc && <span className="oc-setting-row__desc">{def.desc}</span>}
        {planned && def.blockedBy && <span className="oc-setting-row__blocked">{def.blockedBy}</span>}
      </div>
      <div className="oc-setting-row__control">
        <Control def={def} disabled={disabled} store={store} prefs={prefs} />
      </div>
    </div>
  );
}

type Store = ReturnType<typeof useAppStore>;

function Control({ def, disabled, store, prefs }: { def: SettingDef; disabled: boolean; store: Store; prefs: AppPreferences }) {
  const key = def.id as keyof AppPreferences;
  const value = prefs[key];
  const set = (v: AppPreferences[keyof AppPreferences]) =>
    store.getState().setPreference(key, v as never);

  switch (def.control) {
    case 'toggle':
      return <Toggle checked={!!value} disabled={disabled} onChange={(v) => set(v)} />;

    case 'segmented':
      return (
        <Segmented
          options={def.options}
          value={String(value ?? def.options[0]!.value)}
          onChange={(v) => !disabled && set(v)}
        />
      );

    case 'select':
      return (
        <select className="oc-select" disabled={disabled} value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );

    case 'slider':
      return (
        <div className="oc-setting-slider">
          <input
            type="range" min={def.min} max={def.max} step={def.step}
            disabled={disabled}
            value={Number(value ?? def.min)}
            onChange={(e) => set(Number(e.target.value))}
          />
          <span className="oc-setting-slider__value">
            {/* A bare "0" reads as "none"; for a limit, zero means "no limit". */}
            {Number(value) === 0 && def.zeroLabel
              ? def.zeroLabel
              : `${Number(value ?? def.min)}${def.unit ?? ''}`}
          </span>
        </div>
      );

    case 'number':
      return (
        <input
          className="oc-input oc-input--num" type="number"
          min={def.min} max={def.max} step={def.step} disabled={disabled}
          value={Number(value ?? def.min)}
          onChange={(e) => {
            // Clamp here, not on blur: a range check that only runs later lets an out-of-range
            // value reach whatever reads the preference in between.
            const n = Number(e.target.value);
            if (Number.isFinite(n)) set(Math.min(def.max, Math.max(def.min, n)));
          }}
        />
      );

    case 'text':
      return (
        <input
          className="oc-input" type="text" disabled={disabled}
          placeholder={def.placeholder ?? ''}
          value={String(value ?? '')}
          onChange={(e) => set(e.target.value)}
        />
      );

    case 'accent':
      return <AccentPicker />;

    case 'folder':
      return <FolderPicker settingKey={key} value={String(value ?? '')} disabled={disabled} />;

    case 'action':
      return <ActionButton def={def} />;

    case 'info':
      return <InfoValue id={def.id} />;
  }
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch" aria-checked={checked} disabled={disabled}
      className="oc-switch" data-on={checked}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="oc-switch__knob" />
    </button>
  );
}

/**
 * The accent swatch row plus the custom colour picker.
 *
 * The presets come from ACCENT_PRESETS rather than a literal list here, so "what the accent can
 * be" has one definition. Ocean Blue is stored as the empty string — see the note on that
 * constant for why the brand blue is never written down twice.
 *
 * `color` is set alongside `background` on each swatch because the selected ring is drawn with
 * `currentColor`: the ring is then the swatch's own colour in both themes, with no second copy
 * of the value in the stylesheet.
 */
function AccentPicker() {
  const store = useAppStore();
  const current = useStore((s) => s.preferences.accentColor);
  const isCustom = current !== '' && !ACCENT_PRESETS.some((p) => p.value === current);

  return (
    <div className="oc-accent-picker">
      {ACCENT_PRESETS.map((p) => (
        <button
          key={p.value || 'brand'}
          className="oc-accent-swatch"
          data-active={current === p.value}
          style={{ background: p.swatch, color: p.swatch }}
          title={p.label}
          aria-label={p.label}
          aria-pressed={current === p.value}
          onClick={() => store.getState().setPreference('accentColor', p.value)}
        />
      ))}
      <span className="oc-accent-picker__sep" />
      <input
        type="color"
        className="oc-accent-swatch oc-accent-custom"
        data-active={isCustom || undefined}
        style={{ color: current || undefined }}
        title="Custom colour…"
        aria-label="Custom accent colour"
        value={current || ACCENT_PRESETS[0]!.swatch}
        onChange={(e) => store.getState().setPreference('accentColor', e.target.value)}
      />
    </div>
  );
}

function FolderPicker({ settingKey, value, disabled }: { settingKey: keyof AppPreferences; value: string; disabled: boolean }) {
  const store = useAppStore();
  const bridge = store.getState().bridge;
  return (
    <div className="oc-folder-picker">
      <span className="oc-folder-picker__path" title={value || 'Not set'}>
        {value || <em>System default</em>}
      </span>
      <Button
        variant="ghost"
        disabled={disabled || !bridge.chooseDirectory}
        onClick={async () => {
          const dir = await bridge.chooseDirectory?.();
          if (dir) store.getState().setPreference(settingKey, dir as never);
        }}
      >
        Change…
      </Button>
      {value && (
        <Button variant="ghost" onClick={() => store.getState().setPreference(settingKey, '' as never)}>
          Reset
        </Button>
      )}
    </div>
  );
}

function ActionButton({ def }: { def: Extract<SettingDef, { control: 'action' }> }) {
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const s = store.getState();
      if (def.id === 'clearRecent') {
        await s.bridge.clearRecentProjects?.();
        s.notify('Recent projects cleared', 'success');
      } else if (def.id === 'openDataDir') {
        await s.bridge.openDataFolder?.();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant={def.danger ? 'ghost' : 'ghost'} disabled={busy} onClick={run}>
      {busy ? 'Working…' : def.actionLabel}
    </Button>
  );
}

/**
 * The graphics adapter as the renderer sees it.
 *
 * Asked here rather than taken from the host: Electron's `getGPUInfo` frequently returns no
 * device string on Windows and leaves you reporting "Vendor 0x1002", which tells a user nothing.
 * `UNMASKED_RENDERER_WEBGL` names the actual adapter — and it is the right answer anyway, since
 * it names the device the compositor will really run on. The host value stays as the fallback.
 */
function webglRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : '';
    // Release the context immediately; a settings pane must not hold a GPU context open.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/** Read-only facts that have to be fetched from the host. */
function InfoValue({ id }: { id: string }) {
  const store = useAppStore();
  const [text, setText] = useState<string>('…');

  useEffect(() => {
    let alive = true;
    const bridge = store.getState().bridge;
    if (id === 'telemetry') {
      setText('None collected');
      return;
    }
    void (async () => {
      const local = id === 'gpuDevice' ? webglRenderer() : '';
      if (local && alive) setText(local);
      const info = await bridge.systemInfo?.();
      if (!alive || !info) return setText((t) => (t === '…' ? 'Unavailable' : t));
      if (id === 'gpuDevice') setText(local || info.gpu || 'Unknown');
      else if (id === 'dataDir') setText(info.dataDir);
    })();
    return () => { alive = false; };
  }, [id, store]);

  if (id === 'telemetry') {
    return (
      <span className="oc-setting-value oc-setting-value--good">
        None collected — Nova Cut has no analytics, crash reporting or network calls.
      </span>
    );
  }
  return <span className="oc-setting-value" title={text}>{text}</span>;
}

// ── Keyboard shortcut editor ────────────────────────────────────────────────────

function ShortcutsPane({ query }: { query: string }) {
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

  // The pane has its own filter box, and the window's search feeds it too — typing "undo" in
  // either place should find the same row.
  const [local, setLocal] = useState('');
  const q = (local || query).trim().toLowerCase();
  const defs = SHORTCUT_DEFS.filter(
    (d) => !q || `${d.label} ${d.category} ${formatCombo(bindings[d.id])}`.toLowerCase().includes(q),
  );
  const groups = ['Playback', 'Editing', 'File'] as const;

  return (
    <>
      <div className="oc-sc-toolbar">
        <div className="oc-settings__search oc-settings__search--inline">
          <Search size={14} />
          <input
            type="search" placeholder="Filter shortcuts…" aria-label="Filter shortcuts"
            value={local} onChange={(e) => setLocal(e.target.value)}
          />
        </div>
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => store.getState().resetAllShortcuts()}>
          Reset all
        </Button>
      </div>

      {defs.length === 0 && <p className="oc-setting-note">No shortcuts match “{local || query}”.</p>}

      {groups.map((group) => {
        const items = defs.filter((d) => d.category === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="oc-sc-group">
            <div className="oc-sc-group__title">{group}</div>
            {items.map((def) => {
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
        );
      })}
    </>
  );
}

/** Re-exported so other panes can share the row chrome. */
export function SettingsRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
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
