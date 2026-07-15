/**
 * App-level user preferences — distinct from per-project settings (which live in
 * project.settings and are saved in the .opencut file). These are editor-wide and persist in
 * localStorage across projects and sessions. Read/written by the Settings page.
 */

export interface AppPreferences {
  /** Show the Home screen on launch instead of jumping straight into an empty project. */
  showHomeOnLaunch: boolean;
  /** Disable UI transitions/animations while playing, for smoother playback on long videos. */
  reduceMotionDuringPlayback: boolean;
  /** Never animate UI transitions (accessibility / very large projects). */
  reduceMotionAlways: boolean;
  /** Scroll the timeline to keep the playhead in view during playback. */
  autoScrollDuringPlayback: boolean;
  /** Render media thumbnails on timeline clips (turn off to save memory on huge projects). */
  timelineThumbnails: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  showHomeOnLaunch: true,
  reduceMotionDuringPlayback: true,
  reduceMotionAlways: false,
  autoScrollDuringPlayback: true,
  timelineThumbnails: true,
};

const STORAGE_KEY = 'oc.preferences.v1';

export function loadPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<AppPreferences>) } : { ...DEFAULT_PREFERENCES };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* best-effort */
  }
}
