/**
 * Keyboard-shortcut registry.
 *
 * Data-driven so the Settings > Keyboard editor can list, rebind, detect conflicts, reset,
 * and persist shortcuts. The registry holds only DATA (ids, labels, default combos); the
 * actual actions live in useShortcuts, which looks up the bound combo for each id. This keeps
 * the binding layer decoupled from behavior, so remapping never touches the action code.
 *
 * A "combo" is a normalized string: sorted modifiers + key, e.g. `mod+shift+z`, `space`,
 * `delete`, `mod+k`. `mod` means Ctrl (Windows/Linux) or Cmd (macOS).
 */

export type ShortcutId =
  | 'playPause'
  | 'split'
  | 'undo'
  | 'redo'
  | 'redoAlt'
  | 'delete'
  | 'rippleDelete'
  | 'duplicate'
  | 'selectAll'
  | 'deselectAll'
  | 'save'
  | 'open'
  | 'new';

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  /** Grouping shown in the editor. */
  category: 'Playback' | 'Editing' | 'File';
  defaultCombo: string;
}

/** The editable shortcuts. (Transport arrows, Home/End and +/- zoom stay as fixed extras.) */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'playPause', label: 'Play / Pause', category: 'Playback', defaultCombo: 'space' },
  { id: 'split', label: 'Split Clip at Playhead', category: 'Editing', defaultCombo: 'mod+k' },
  { id: 'undo', label: 'Undo', category: 'Editing', defaultCombo: 'mod+z' },
  { id: 'redo', label: 'Redo', category: 'Editing', defaultCombo: 'mod+shift+z' },
  { id: 'redoAlt', label: 'Redo (alternate)', category: 'Editing', defaultCombo: 'mod+y' },
  { id: 'delete', label: 'Delete Selected', category: 'Editing', defaultCombo: 'delete' },
  { id: 'rippleDelete', label: 'Ripple Delete Selected', category: 'Editing', defaultCombo: 'shift+delete' },
  { id: 'duplicate', label: 'Duplicate Selected', category: 'Editing', defaultCombo: 'mod+d' },
  { id: 'selectAll', label: 'Select All Clips', category: 'Editing', defaultCombo: 'mod+a' },
  { id: 'deselectAll', label: 'Deselect All', category: 'Editing', defaultCombo: 'escape' },
  { id: 'save', label: 'Save Project', category: 'File', defaultCombo: 'mod+s' },
  { id: 'open', label: 'Open Project', category: 'File', defaultCombo: 'mod+o' },
  { id: 'new', label: 'New Project', category: 'File', defaultCombo: 'mod+n' },
];

export type Bindings = Record<ShortcutId, string>;

const STORAGE_KEY = 'oc.shortcuts.v1';

/** Normalize a KeyboardEvent to a combo string, or '' for a bare modifier press. */
export function comboFromEvent(e: KeyboardEvent): string {
  let key = e.key.toLowerCase();
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return ''; // modifier alone
  if (key === ' ' || e.code === 'Space') key = 'space';
  if (key === 'backspace') key = 'delete';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** Human-readable form, e.g. `mod+shift+z` → `Ctrl + Shift + Z`. */
export function formatCombo(combo: string): string {
  if (!combo) return '—';
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return combo
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return isMac ? '⇧' : 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p === 'space') return 'Space';
      if (p === 'delete') return 'Delete';
      if (p.startsWith('arrow')) return p.slice(5).replace(/^./, (c) => c.toUpperCase());
      return p.length === 1 ? p.toUpperCase() : p.replace(/^./, (c) => c.toUpperCase());
    })
    .join(' + ');
}

export function defaultBindings(): Bindings {
  return Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.id, d.defaultCombo])) as Bindings;
}

export function loadOverrides(): Partial<Bindings> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Bindings>;
  } catch {
    return {};
  }
}

/** Defaults merged with any persisted user overrides. */
export function resolveBindings(): Bindings {
  return { ...defaultBindings(), ...loadOverrides() };
}

/** Persist only the entries that differ from defaults. */
export function saveOverrides(bindings: Bindings): void {
  const defs = defaultBindings();
  const overrides: Partial<Bindings> = {};
  for (const d of SHORTCUT_DEFS) if (bindings[d.id] !== defs[d.id]) overrides[d.id] = bindings[d.id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* best-effort */
  }
}

/** combo → the ids bound to it. Any entry with 2+ ids is a conflict. */
export function conflicts(bindings: Bindings): Record<string, ShortcutId[]> {
  const byCombo: Record<string, ShortcutId[]> = {};
  for (const d of SHORTCUT_DEFS) {
    const combo = bindings[d.id];
    if (!combo) continue;
    (byCombo[combo] ??= []).push(d.id);
  }
  return Object.fromEntries(Object.entries(byCombo).filter(([, ids]) => ids.length > 1));
}

/** Reverse map combo → id for fast lookup during keydown (first binding wins on conflict). */
export function comboToId(bindings: Bindings): Record<string, ShortcutId> {
  const map: Record<string, ShortcutId> = {};
  for (const d of SHORTCUT_DEFS) {
    const c = bindings[d.id];
    if (c && !(c in map)) map[c] = d.id;
  }
  return map;
}
