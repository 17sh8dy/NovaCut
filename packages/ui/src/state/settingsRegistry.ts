/**
 * The settings registry — every setting the app has, as DATA.
 *
 * The Settings window renders itself from this list; it holds no hard-coded rows. That is what
 * makes the search box possible at all: searching a hand-written UI means grepping JSX, while
 * searching a registry is a filter over `label`, `desc` and `keywords`. It is also what keeps a
 * setting's title, help text and search terms from drifting apart, because there is only one
 * copy of each.
 *
 * ── THE `status` FIELD IS THE IMPORTANT PART ─────────────────────────────────────
 * This codebase has been bitten twice by declaring things the renderer never honoured: eleven
 * blend modes the compositor ignored, and a whole transitions UI that drew markers no shader
 * ever read. A settings page is the easiest place in an app to repeat that mistake, because a
 * toggle that flips and persists *looks* finished whether or not anything reads it.
 *
 * So every entry declares one of:
 *   'live'    — reading this preference changes what the app does, today.
 *   'planned' — the UI exists, the feature does not. Rendered disabled, labelled, and NEVER
 *               presented as a working control.
 *
 * A 'planned' entry earns its place by making the shape of the product visible and by being
 * searchable — not by pretending. When the feature lands, flip the status; that is the whole
 * change on this side.
 */

import type { AppPreferences } from './preferences.js';

export type SettingsCategory =
  | 'General'
  | 'Interface'
  | 'Projects'
  | 'Video'
  | 'Photo'
  | 'Performance'
  | 'Export'
  | 'Shortcuts'
  | 'Storage'
  | 'Privacy'
  | 'Notifications'
  | 'Experimental'
  | 'About';

export const CATEGORY_ORDER: SettingsCategory[] = [
  'General', 'Interface', 'Projects', 'Video', 'Photo', 'Performance',
  'Export', 'Shortcuts', 'Storage', 'Privacy', 'Notifications', 'Experimental', 'About',
];

/** Categories whose content is bespoke rather than a list of rows. */
export const CUSTOM_PANES: SettingsCategory[] = ['Shortcuts', 'Storage', 'About'];

export type SettingStatus = 'live' | 'planned';

interface Base {
  /** Stable id. For 'live' entries backed by a preference, this IS the preference key. */
  id: string;
  category: SettingsCategory;
  label: string;
  desc?: string;
  /** Extra search terms that aren't in the label or description ("gpu", "vram", "fps"). */
  keywords?: string;
  status: SettingStatus;
  /** Shown beside a planned control to say what it is waiting on. */
  blockedBy?: string;
  /** Only meaningful once another setting is on. */
  requires?: keyof AppPreferences;
  /** Changing this only takes effect after a restart; the UI says so. */
  needsRestart?: boolean;
  /** Group heading within a category, so long panes stay scannable. */
  group?: string;
}

export type SettingDef = Base &
  (
    | { control: 'toggle' }
    | { control: 'select'; options: { value: string; label: string }[] }
    | { control: 'segmented'; options: { value: string; label: string }[] }
    | { control: 'slider'; min: number; max: number; step: number; unit?: string; zeroLabel?: string }
    | { control: 'number'; min: number; max: number; step: number; unit?: string }
    | { control: 'text'; placeholder?: string }
    /** The accent swatch row plus a custom colour picker. One setting, one bespoke control. */
    | { control: 'accent' }
    | { control: 'folder' }
    /** A button, not a value: "Clear cache", "Open logs folder". */
    | { control: 'action'; actionLabel: string; danger?: boolean }
    /** Read-only fact: GPU name, data directory. */
    | { control: 'info' }
  );

const RESOLUTIONS = [
  { value: '4K', label: '3840 × 2160 (4K)' },
  { value: '1440p', label: '2560 × 1440 (1440p)' },
  { value: '1080p', label: '1920 × 1080 (1080p)' },
  { value: '720p', label: '1280 × 720 (720p)' },
];
const FRAME_RATES = [
  { value: '23.976', label: '23.976 fps' }, { value: '24', label: '24 fps' },
  { value: '25', label: '25 fps' }, { value: '30', label: '30 fps' },
  { value: '50', label: '50 fps' }, { value: '60', label: '60 fps' },
];

export const SETTINGS: SettingDef[] = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    id: 'theme', category: 'General', group: 'Appearance', control: 'segmented', status: 'live',
    label: 'Theme', desc: 'System follows your operating system’s light/dark setting.',
    keywords: 'dark light system appearance colour scheme',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  {
    id: 'accentColor', category: 'General', group: 'Appearance', control: 'accent', status: 'live',
    label: 'Accent colour',
    desc: 'Primary buttons, active tools, selection, sliders and focus rings. The Open Cut logo always stays Deep Navy → Blue → Cyan.',
    keywords: 'accent colour color highlight brand blue purple green orange red pink gray theme',
  },
  {
    id: 'language', category: 'General', group: 'Appearance', control: 'select', status: 'planned',
    blockedBy: 'Open Cut has no translations yet — the interface is English only.',
    label: 'Language', keywords: 'locale i18n translation english',
    options: [{ value: 'en', label: 'English' }],
  },
  {
    id: 'launchOnStartup', category: 'General', group: 'Startup', control: 'toggle', status: 'live',
    label: 'Launch on startup', desc: 'Open Cut starts when you sign in.',
    keywords: 'boot login autostart startup',
  },
  {
    id: 'showHomeOnLaunch', category: 'General', group: 'Startup', control: 'toggle', status: 'live',
    label: 'Show Home screen on launch', desc: 'Open the launcher instead of an empty project.',
    keywords: 'home launcher startup welcome',
  },
  {
    id: 'reopenLastProject', category: 'General', group: 'Startup', control: 'toggle', status: 'planned',
    blockedBy: 'The last project path is not recorded at quit yet.',
    label: 'Reopen last project', desc: 'Load the project you had open when you last quit.',
    keywords: 'remember last project restore session reopen',
  },
  {
    id: 'confirmOnClose', category: 'General', group: 'Startup', control: 'toggle', status: 'live',
    label: 'Confirm before closing unsaved projects',
    desc: 'Turning this off discards unsaved work without asking.',
    keywords: 'confirm quit close unsaved warn prompt exit',
  },
  {
    id: 'minimizeToTray', category: 'General', group: 'Startup', control: 'toggle', status: 'planned',
    blockedBy: 'There is no tray icon yet.',
    label: 'Minimise to tray', keywords: 'tray system notification area background minimise',
  },
  {
    id: 'checkForUpdates', category: 'General', group: 'Updates', control: 'toggle', status: 'planned',
    blockedBy: 'Builds are not published to an update feed yet.',
    label: 'Check for updates automatically', keywords: 'update upgrade version release auto',
  },

  // ── Interface ──────────────────────────────────────────────────────────────
  {
    id: 'uiScale', category: 'Interface', group: 'Layout', control: 'slider', status: 'live',
    min: 80, max: 150, step: 10, unit: '%',
    label: 'Interface scale', desc: 'Zooms the whole window. Useful on very high-density displays.',
    keywords: 'zoom scale size dpi hidpi text bigger smaller',
  },
  {
    id: 'compactMode', category: 'Interface', group: 'Layout', control: 'toggle', status: 'live',
    label: 'Compact mode', desc: 'Tighter padding throughout, for smaller screens.',
    keywords: 'compact dense density spacing padding small',
  },
  {
    id: 'largeIcons', category: 'Interface', group: 'Layout', control: 'toggle', status: 'live',
    label: 'Large icons', desc: 'Bigger tool and panel icons.',
    keywords: 'icons large size toolbar rail',
  },
  {
    id: 'timelineHeight', category: 'Interface', group: 'Timeline', control: 'slider', status: 'live',
    min: 48, max: 128, step: 4, unit: 'px',
    label: 'Track height', desc: 'Height of a video track. Audio lanes stay proportionally shorter.',
    keywords: 'timeline track height row thick thin',
  },
  {
    id: 'timelineThumbnails', category: 'Interface', group: 'Timeline', control: 'toggle', status: 'live',
    label: 'Clip thumbnails', desc: 'Show media thumbnails on timeline clips.',
    keywords: 'thumbnails filmstrip preview clips timeline',
  },
  {
    id: 'autoScrollDuringPlayback', category: 'Interface', group: 'Timeline', control: 'toggle', status: 'live',
    label: 'Follow the playhead', desc: 'Scroll the timeline to keep the playhead in view during playback.',
    keywords: 'autoscroll follow playhead scroll timeline playback',
  },
  {
    id: 'snapStrength', category: 'Interface', group: 'Timeline', control: 'slider', status: 'live',
    min: 2, max: 24, step: 1, unit: 'px',
    label: 'Snap strength', desc: 'How close a clip must be before it snaps. Hold Alt to bypass.',
    keywords: 'snap magnet align strength distance timeline',
  },
  {
    id: 'showRulers', category: 'Interface', group: 'Canvas', control: 'toggle', status: 'live',
    label: 'Show rulers by default',
    desc: 'Starting state for the photo canvas rulers. The tool rail still toggles them per session.',
    keywords: 'ruler measure guides canvas photo',
  },
  {
    id: 'showGuides', category: 'Interface', group: 'Canvas', control: 'toggle', status: 'live',
    label: 'Show smart guides by default',
    desc: 'Starting state for alignment guides on the photo canvas. The tool rail still toggles them.',
    keywords: 'guides smart align snap canvas photo',
  },
  {
    id: 'animationSpeed', category: 'Interface', group: 'Motion', control: 'segmented', status: 'live',
    label: 'Animation speed', keywords: 'animation motion speed transitions ui reduce accessibility',
    options: [
      { value: 'off', label: 'Off' }, { value: 'fast', label: 'Fast' },
      { value: 'normal', label: 'Normal' },
    ],
  },
  {
    id: 'reduceMotionDuringPlayback', category: 'Interface', group: 'Motion', control: 'toggle', status: 'live',
    label: 'Freeze animations during playback', desc: 'Less distracting, and smoother on long videos.',
    keywords: 'animation playback motion freeze performance',
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  {
    id: 'defaultProjectDir', category: 'Projects', group: 'Locations', control: 'folder', status: 'live',
    label: 'Default project location', desc: 'Where the Save dialog starts.',
    keywords: 'folder directory location save path projects',
  },
  {
    id: 'autosaveInterval', category: 'Projects', group: 'Saving', control: 'select', status: 'live',
    label: 'Autosave interval', desc: 'How often the recovery snapshot is written.',
    keywords: 'autosave backup interval recovery crash save',
    options: [
      { value: '0', label: 'Off' }, { value: '15', label: 'Every 15 seconds' },
      { value: '30', label: 'Every 30 seconds' }, { value: '60', label: 'Every minute' },
      { value: '300', label: 'Every 5 minutes' },
    ],
  },
  {
    id: 'backupVersions', category: 'Projects', group: 'Saving', control: 'number', status: 'live',
    min: 1, max: 20, step: 1,
    label: 'Recovery snapshots to keep', desc: 'Older snapshots are discarded as new ones are written.',
    keywords: 'backup versions history recovery snapshots keep',
  },
  {
    id: 'maxRecentProjects', category: 'Projects', group: 'Recent', control: 'number', status: 'live',
    min: 4, max: 40, step: 1,
    label: 'Maximum recent projects', desc: 'How many entries the Home screen remembers.',
    keywords: 'recent projects history list max limit',
  },
  {
    id: 'clearRecent', category: 'Projects', group: 'Recent', control: 'action', status: 'live',
    actionLabel: 'Clear list', label: 'Recent projects',
    desc: 'Forget the list. The project files themselves are not touched.',
    keywords: 'recent clear forget history list',
  },
  {
    id: 'defaultResolution', category: 'Projects', group: 'New projects', control: 'select', status: 'live',
    label: 'Default resolution', options: RESOLUTIONS,
    keywords: 'resolution size 1080p 4k default new project sequence',
  },
  {
    id: 'defaultFrameRate', category: 'Projects', group: 'New projects', control: 'select', status: 'live',
    label: 'Default frame rate', options: FRAME_RATES,
    keywords: 'fps frame rate default new project timeline',
  },

  // ── Video ──────────────────────────────────────────────────────────────────
  {
    id: 'previewQuality', category: 'Video', group: 'Playback', control: 'segmented', status: 'planned',
    blockedBy: 'The compositor always renders at sequence resolution; there is no render scale.',
    label: 'Preview quality', desc: 'Lower resolutions play back more smoothly while editing.',
    keywords: 'preview quality playback resolution proxy smooth performance',
    options: [
      { value: 'full', label: 'Full' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' },
    ],
  },
  {
    id: 'defaultTransitionMs', category: 'Video', group: 'Editing', control: 'slider', status: 'planned',
    blockedBy: 'Transitions take their length from the window clamped around the cut.',
    min: 100, max: 2000, step: 50, unit: 'ms',
    label: 'Default transition duration', desc: 'Applied when you drop a transition onto a cut.',
    keywords: 'transition duration length crossfade default',
  },
  {
    id: 'rippleByDefault', category: 'Video', group: 'Editing', control: 'toggle', status: 'live',
    label: 'Ripple edits by default', desc: 'Close the gap when a clip is deleted.',
    keywords: 'ripple delete gap close edit trim',
  },
  {
    id: 'proxyMedia', category: 'Video', group: 'Editing', control: 'toggle', status: 'planned',
    blockedBy: 'Proxy generation is not implemented.',
    label: 'Proxy media', keywords: 'proxy optimised media transcode offline lowres 4k',
  },

  // ── Photo ──────────────────────────────────────────────────────────────────
  {
    id: 'photoCanvasColor', category: 'Photo', group: 'New documents', control: 'select', status: 'live',
    label: 'Default canvas colour', desc: 'Background for new photo documents.', keywords: 'canvas background colour white transparent new document',
    options: [
      { value: 'transparent', label: 'Transparent' }, { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
    ],
  },
  {
    id: 'photoExportFormat', category: 'Photo', group: 'Export', control: 'segmented', status: 'live',
    label: 'Default image format', desc: 'Pre-selected in the photo export dialog.', keywords: 'png jpg jpeg webp format export image default',
    options: [
      { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'webp', label: 'WebP' },
    ],
  },
  {
    id: 'photoHqPreview', category: 'Photo', group: 'Canvas', control: 'toggle', status: 'live',
    label: 'High-quality previews',
    desc: 'Render the canvas at full document resolution while editing. Turn off to cap the preview at 2048px on large documents — exports are always full resolution either way.',
    keywords: 'preview quality high canvas render photo',
  },
  {
    id: 'photoColorProfile', category: 'Photo', group: 'Colour', control: 'select', status: 'planned',
    blockedBy: 'The photo pipeline is sRGB end to end; wide-gamut output is not implemented.',
    label: 'Colour profile', keywords: 'colour color profile srgb display p3 gamut icc',
    options: [{ value: 'srgb', label: 'sRGB' }],
  },

  // ── Performance ────────────────────────────────────────────────────────────
  {
    id: 'gpuAcceleration', category: 'Performance', group: 'Graphics', control: 'toggle', status: 'live',
    needsRestart: true,
    label: 'GPU acceleration', desc: 'Hardware-accelerated rendering. Turn off only to work around a driver bug.',
    keywords: 'gpu hardware acceleration graphics driver render performance',
  },
  {
    id: 'gpuDevice', category: 'Performance', group: 'Graphics', control: 'info', status: 'live',
    label: 'Graphics device', keywords: 'gpu device adapter card vendor renderer vram',
  },
  {
    id: 'maxTextureSize', category: 'Performance', group: 'Graphics', control: 'select', status: 'live',
    label: 'Maximum texture resolution',
    desc: 'Images larger than this are downscaled before they reach the GPU. Your hardware limit always applies as well, whichever is smaller.',
    keywords: 'texture size resolution gpu memory vram limit photo large',
    options: [
      { value: '2048', label: '2048 px' }, { value: '4096', label: '4096 px' },
      { value: '8192', label: '8192 px' }, { value: '16384', label: '16384 px' },
    ],
  },
  {
    id: 'memoryCacheMb', category: 'Performance', group: 'Memory', control: 'slider', status: 'planned',
    blockedBy: 'The frame, paint and mask caches evict by liveness, not by a byte budget — bounding them needs per-entry size accounting that does not exist yet.',
    min: 128, max: 4096, step: 128, unit: ' MB',
    label: 'Media cache size', desc: 'Decoded frames and thumbnails kept in memory.',
    keywords: 'memory cache ram size frames thumbnails limit',
  },
  {
    id: 'lowMemoryMode', category: 'Performance', group: 'Memory', control: 'toggle', status: 'live',
    label: 'Low memory mode',
    desc: 'Drops caches aggressively and disables clip thumbnails. For machines under memory pressure.',
    keywords: 'low memory ram limited small conserve',
  },
  {
    id: 'cpuThreads', category: 'Performance', group: 'Processing', control: 'slider', status: 'live',
    min: 0, max: 32, step: 1, zeroLabel: 'Automatic',
    label: 'Encoder thread limit',
    desc: '0 lets FFmpeg decide. Lower it to leave CPU headroom for other work during a long export.',
    keywords: 'cpu threads cores parallel processing export ffmpeg encode',
  },
  {
    id: 'backgroundRender', category: 'Performance', group: 'Processing', control: 'toggle', status: 'planned',
    blockedBy: 'There is no background render queue yet.',
    label: 'Background rendering', keywords: 'background render cache preview queue idle',
  },

  // ── Export ─────────────────────────────────────────────────────────────────
  {
    id: 'exportDir', category: 'Export', group: 'Destination', control: 'folder', status: 'live',
    label: 'Default export folder', desc: 'Where the Export dialog starts.',
    keywords: 'export folder directory output location save path',
  },
  {
    id: 'exportFilenamePattern', category: 'Export', group: 'Destination', control: 'text', status: 'live',
    placeholder: '{project}-{date}',
    label: 'Filename format',
    desc: 'Tokens: {project} {date} {time} {resolution} {fps}. Unknown tokens are left as-is.',
    keywords: 'filename pattern name format template export tokens',
  },
  {
    id: 'exportCodec', category: 'Export', group: 'Encoding', control: 'select', status: 'live',
    label: 'Default codec', keywords: 'codec h264 h265 hevc vp9 av1 prores encoder export format',
    options: [
      { value: 'h264', label: 'H.264' }, { value: 'h265', label: 'H.265 / HEVC' },
      { value: 'vp9', label: 'VP9' }, { value: 'av1', label: 'AV1' }, { value: 'prores', label: 'ProRes' },
    ],
  },
  {
    id: 'exportHardware', category: 'Export', group: 'Encoding', control: 'toggle', status: 'live',
    label: 'Hardware encoding', desc: 'Use the GPU encoder when the codec supports it. Much faster, slightly larger files.',
    keywords: 'hardware gpu nvenc encoding acceleration export fast',
  },
  {
    id: 'exportVideoBitrate', category: 'Export', group: 'Encoding', control: 'slider', status: 'live',
    min: 1, max: 100, step: 1, unit: ' Mbps',
    label: 'Video bitrate', keywords: 'bitrate video quality mbps size export',
  },
  {
    id: 'exportAudioBitrate', category: 'Export', group: 'Encoding', control: 'select', status: 'live',
    label: 'Audio bitrate', keywords: 'audio bitrate kbps aac quality export sound',
    options: [
      { value: '128', label: '128 kbps' }, { value: '192', label: '192 kbps' },
      { value: '256', label: '256 kbps' }, { value: '320', label: '320 kbps' },
    ],
  },
  {
    id: 'rememberExportSettings', category: 'Export', group: 'Behaviour', control: 'toggle', status: 'live',
    label: 'Remember last export settings', desc: 'Reopen the Export dialog with whatever you used last.',
    keywords: 'remember export settings last reuse defaults',
  },

  // ── Privacy ────────────────────────────────────────────────────────────────
  {
    id: 'telemetry', category: 'Privacy', group: 'Data collection', control: 'info', status: 'live',
    label: 'Analytics and crash reports',
    keywords: 'analytics telemetry tracking crash reports usage statistics privacy data',
  },
  {
    id: 'dataDir', category: 'Privacy', group: 'Your data', control: 'info', status: 'live',
    label: 'Data storage location', keywords: 'data folder appdata location storage where files privacy',
  },
  {
    id: 'openDataDir', category: 'Privacy', group: 'Your data', control: 'action', status: 'live',
    actionLabel: 'Open folder', label: 'Browse app data',
    desc: 'Preferences, recent projects and recovery snapshots live here.',
    keywords: 'open folder appdata explorer data privacy',
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    id: 'notifyExport', category: 'Notifications', control: 'toggle', status: 'live',
    label: 'Export finished',
    desc: 'A system notification when a render completes. The in-app toast always appears.',
    keywords: 'notification export finished complete render toast alert',
  },
  {
    id: 'notifySounds', category: 'Notifications', control: 'toggle', status: 'planned',
    blockedBy: 'Notifications carry no sound.',
    label: 'Sound effects', desc: 'Play a short chime with notifications.',
    keywords: 'sound audio chime beep notification effects',
  },
  {
    id: 'notifyUpdates', category: 'Notifications', control: 'toggle', status: 'planned',
    blockedBy: 'Depends on automatic updates, which are not implemented.',
    label: 'Update available', keywords: 'notification update available version release',
  },

  // ── Experimental ───────────────────────────────────────────────────────────
  {
    id: 'developerMode', category: 'Experimental', control: 'toggle', status: 'planned',
    blockedBy: 'There are no developer-only diagnostics to reveal yet.',
    label: 'Developer mode', desc: 'Adds diagnostics to the status bar and keeps DevTools reachable.',
    keywords: 'developer debug devtools diagnostics advanced',
  },
  {
    id: 'fpsOverlay', category: 'Experimental', control: 'toggle', status: 'planned',
    blockedBy: 'The preview has no frame-time overlay.',
    label: 'FPS overlay', desc: 'Draw a frame-time readout over the preview.',
    keywords: 'fps overlay performance frame time debug diagnostics',
  },
  {
    id: 'vulkanRenderer', category: 'Experimental', control: 'toggle', status: 'planned',
    blockedBy: 'The compositor is WebGL2. A Vulkan path does not exist.',
    label: 'Vulkan renderer', keywords: 'vulkan renderer backend gpu experimental graphics',
  },
  {
    id: 'newExportEngine', category: 'Experimental', control: 'toggle', status: 'planned',
    blockedBy: 'There is one export engine.',
    label: 'New export engine', keywords: 'export engine experimental encoder new',
  },
];

/** Case-insensitive match over everything a user might reasonably type. */
export function matchesQuery(def: SettingDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${def.label} ${def.desc ?? ''} ${def.keywords ?? ''} ${def.category} ${def.group ?? ''}`.toLowerCase();
  // Every whitespace-separated term must appear, so "export gpu" narrows rather than widens.
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * Categories a query has any hits in — including the bespoke panes, which have no registry rows
 * but must still be findable by name and by the terms below.
 */
const CUSTOM_PANE_KEYWORDS: Record<string, string> = {
  Shortcuts: 'shortcuts keyboard keys bindings hotkeys combo remap',
  Storage: 'storage disk space usage cache size clear gb projects autosaves',
  About: 'about version build changelog licence license github website discord contributors credits',
};

export function categoriesMatching(query: string): Set<SettingsCategory> {
  const q = query.trim().toLowerCase();
  const hit = new Set<SettingsCategory>();
  if (!q) return new Set(CATEGORY_ORDER);
  for (const def of SETTINGS) if (matchesQuery(def, q)) hit.add(def.category);
  for (const [cat, words] of Object.entries(CUSTOM_PANE_KEYWORDS)) {
    const hay = `${cat} ${words}`.toLowerCase();
    if (q.split(/\s+/).every((t) => hay.includes(t))) hit.add(cat as SettingsCategory);
  }
  return hit;
}
