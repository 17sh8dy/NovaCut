/**
 * App-level user preferences — distinct from per-project settings (which live in
 * project.settings and are saved in the .novacut file). These are editor-wide and persist in
 * localStorage across projects and sessions. Read/written by the Settings window.
 *
 * EVERY KEY HERE IS READ BY SOMETHING. The settings registry pairs each of these with a control
 * and marks it `status: 'live'`; a preference with no reader belongs in neither file. See the
 * note at the top of settingsRegistry.ts for why that rule is enforced so bluntly.
 */

/**
 * Theme, including the OS-following option, which is resolved to a concrete theme at render.
 *
 * Three, not four. The old 'midnight' was a second dark theme with its own blues and its own
 * accent overrides — a variant that had to be remembered by every rule that touched a surface,
 * in exchange for a difference most people would not name if asked. Two well-made palettes plus
 * "follow the system" is the whole set; loadPreferences migrates anyone who was on midnight.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** A concrete palette — what `system` resolves to and what `data-theme` ever gets set to. */
export type ResolvedTheme = 'light' | 'dark';

export interface AppPreferences {
  // ── General ──
  theme: ThemePreference;
  /**
   * The accent, as a CSS colour. Empty string means "Ocean Blue" — the default --accent from the
   * design tokens, and the reason it is stored as empty rather than as '#1565ff' is that
   * tokens.css must stay the single definition of it. See useAppliedPreferences.
   *
   * Note this is the ACCENT default, not the brand colour: since the logo changed they are
   * different values on purpose, because the mark's blue is too light to carry white button
   * text. tokens.css explains the split.
   */
  accentColor: string;
  launchOnStartup: boolean;
  showHomeOnLaunch: boolean;
  reopenLastProject: boolean;
  confirmOnClose: boolean;

  // ── Interface ──
  /** Percent. Applied as the window's zoom factor. */
  uiScale: number;
  compactMode: boolean;
  largeIcons: boolean;
  /** Pixels per timeline track. */
  timelineHeight: number;
  timelineThumbnails: boolean;
  /** Pixels within which a dragged clip snaps. */
  snapStrength: number;
  showRulers: boolean;
  showGuides: boolean;
  animationSpeed: 'off' | 'fast' | 'normal';
  reduceMotionDuringPlayback: boolean;
  autoScrollDuringPlayback: boolean;

  // ── Projects ──
  defaultProjectDir: string;
  /** Seconds between recovery snapshots; 0 disables autosave. */
  autosaveInterval: number;
  backupVersions: number;
  maxRecentProjects: number;
  defaultResolution: string;
  defaultFrameRate: string;

  // ── Video ──
  previewQuality: 'full' | 'half' | 'quarter';
  defaultTransitionMs: number;
  rippleByDefault: boolean;

  // ── Photo ──
  photoCanvasColor: 'transparent' | 'white' | 'black';
  photoExportFormat: 'png' | 'jpeg' | 'webp';
  photoHqPreview: boolean;

  // ── Performance ──
  gpuAcceleration: boolean;
  maxTextureSize: string;
  memoryCacheMb: number;
  lowMemoryMode: boolean;
  /** ffmpeg encoder threads; 0 lets ffmpeg choose. */
  cpuThreads: number;

  // ── Export ──
  exportDir: string;
  exportFilenamePattern: string;
  exportCodec: string;
  exportHardware: boolean;
  exportVideoBitrate: number;
  exportAudioBitrate: string;
  rememberExportSettings: boolean;

  // ── Notifications ──
  notifyExport: boolean;
  notifySounds: boolean;

  // ── Experimental ──
  developerMode: boolean;
  fpsOverlay: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  // Follow the OS out of the box. A creative tool that ignores the system appearance is the
  // first thing a new user has to go and fix.
  theme: 'system',
  accentColor: '',
  launchOnStartup: false,
  showHomeOnLaunch: true,
  reopenLastProject: false,
  confirmOnClose: true,

  uiScale: 100,
  compactMode: false,
  largeIcons: false,
  timelineHeight: 72,
  timelineThumbnails: true,
  snapStrength: 8,
  showRulers: true,
  showGuides: true,
  animationSpeed: 'normal',
  reduceMotionDuringPlayback: true,
  autoScrollDuringPlayback: true,

  defaultProjectDir: '',
  autosaveInterval: 30,
  backupVersions: 5,
  maxRecentProjects: 12,
  defaultResolution: '1080p',
  defaultFrameRate: '30',

  previewQuality: 'full',
  defaultTransitionMs: 500,
  rippleByDefault: false,

  photoCanvasColor: 'transparent',
  photoExportFormat: 'png',
  photoHqPreview: true,

  gpuAcceleration: true,
  maxTextureSize: '8192',
  memoryCacheMb: 1024,
  lowMemoryMode: false,
  cpuThreads: 0,

  exportDir: '',
  exportFilenamePattern: '{project}-{date}',
  exportCodec: 'h264',
  exportHardware: false,
  exportVideoBitrate: 12,
  exportAudioBitrate: '192',
  rememberExportSettings: true,

  notifyExport: true,
  notifySounds: false,

  developerMode: false,
  fpsOverlay: false,
};

/**
 * The accent presets offered in Settings.
 *
 * `value: ''` is Ocean Blue and is deliberately NOT the literal '#1565ff': storing the colour
 * here would make this file a second definition of it, free to drift from the one in tokens.css.
 * Empty means "whatever tokens.css says --accent is".
 *
 * That is NOT the logo's blue, and has not been since the mark changed: #0A84FF measures 3.65:1
 * under white text and cannot be a button fill. `swatch` below is the only literal, and it is
 * only ever painted into a preview circle.
 *
 * Every value must be a colour that can carry white text at ~4.5:1, because that is what
 * --accent is used for. The custom picker in the Settings dialog is not held to that, which is
 * the price of letting people choose; the presets are the safe path and the default.
 */
export interface AccentPreset {
  value: string;
  label: string;
  /** What to paint the swatch, since '' has no colour of its own. */
  swatch: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { value: '', label: 'Ocean Blue (Nova Cut)', swatch: '#1565ff' },
  { value: '#7c5cf5', label: 'Purple', swatch: '#7c5cf5' },
  { value: '#0f9d63', label: 'Green', swatch: '#0f9d63' },
  { value: '#d97706', label: 'Orange', swatch: '#d97706' },
  { value: '#dc2626', label: 'Red', swatch: '#dc2626' },
  { value: '#db2777', label: 'Pink', swatch: '#db2777' },
  { value: '#5b6472', label: 'Gray', swatch: '#5b6472' },
];

const STORAGE_KEY = 'oc.preferences.v1';

export function loadPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Spread over the defaults rather than replacing them: a preferences file written by an
    // older build is missing every key added since, and those must fall back rather than
    // arrive as `undefined` in a control that expects a value.
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return migrate({ ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<AppPreferences>) });
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Fixes up values that were valid in an older build.
 *
 * Stored preferences outlive the code that wrote them, and a removed enum member does not
 * announce itself: 'midnight' would simply land on `data-theme='midnight'`, match no rule, and
 * leave the app rendering the dark defaults with a Theme control showing nothing selected. It is
 * rewritten here, at the one place preferences enter the app, rather than defended against at
 * every read.
 */
function migrate(prefs: AppPreferences): AppPreferences {
  const theme = (prefs.theme as string) === 'midnight' ? 'dark' : prefs.theme;
  return theme === prefs.theme ? prefs : { ...prefs, theme };
}

export function savePreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* best-effort */
  }
}

/** `system` resolved against the OS setting, so callers always get a concrete theme. */
export function resolveTheme(theme: ThemePreference): ResolvedTheme {
  if (theme !== 'system') return theme;
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  return prefersLight ? 'light' : 'dark';
}

/**
 * Writes the resolved theme to the document root.
 *
 * Exported so the app entry can call it BEFORE the first render. useAppliedPreferences applies
 * the same attribute from an effect, which runs after React has already painted a frame — and
 * that frame would be the dark default, so a light-theme user would see a dark flash on every
 * launch. One call at startup and the very first paint is correct.
 */
export function applyTheme(theme: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}
