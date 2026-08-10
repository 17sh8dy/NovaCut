/**
 * The last export settings the user actually ran with.
 *
 * Deliberately NOT in AppPreferences. Preferences are things a person sets on purpose in the
 * Settings window; this is a side effect of doing work, written without asking. Mixing the two
 * would mean "Reset all settings to defaults" also wipes it, and that every settings audit has to
 * explain a key with no control attached.
 *
 * Only the fields worth carrying between sessions are stored. Resolution and frame rate are
 * excluded on purpose: they belong to the sequence being exported, and restoring 4K onto a 720p
 * project would be a worse default than the project's own.
 */

import type { ExportSettings } from '@opencut/core';

export type RememberedExport = Pick<
  ExportSettings,
  'quality' | 'container' | 'videoCodec' | 'bitrateMbps' | 'audioBitrateKbps' | 'hardwareAcceleration'
>;

const KEY = 'oc.export.last.v1';

export function readLastExport(): Partial<RememberedExport> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<RememberedExport>) : {};
  } catch {
    return {};
  }
}

export function writeLastExport(settings: ExportSettings): void {
  const keep: RememberedExport = {
    quality: settings.quality,
    container: settings.container,
    videoCodec: settings.videoCodec,
    audioBitrateKbps: settings.audioBitrateKbps,
    hardwareAcceleration: settings.hardwareAcceleration,
    ...(settings.bitrateMbps !== undefined ? { bitrateMbps: settings.bitrateMbps } : {}),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* best-effort */
  }
}

export function clearLastExport(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
