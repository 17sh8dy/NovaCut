/**
 * Crash recovery / session restore.
 *
 * Independent of the normal "save to .novacut file" flow (useAutosave). This keeps a small
 * ring of recent snapshots in localStorage — project data PLUS editor state (playhead, zoom,
 * selection) — so an unexpected close can be recovered even for a project that was never
 * saved to disk. Renderer-only: no PlatformBridge or engine involvement.
 */

import { deserializeProject, serializeProject, type Project } from '@opencut/core';

const KEY = 'oc.recovery.v1';
const SESSION_KEY = 'oc.session.open';
/** Fallback retention when a caller does not pass one (newest last). */
const MAX_VERSIONS = 5;

export type RecoveryReason = 'interval' | 'edit' | 'exit';

export interface RecoverySnapshot {
  savedAt: number;
  reason: RecoveryReason;
  projectName: string;
  /** Serialized project (timeline, media, effects — everything in the domain model). */
  projectJson: string;
  // Editor state that lives outside the project:
  playhead: number;
  pixelsPerSecond: number;
  selectedClipIds: string[];
}

export interface RecoveryInput {
  project: Project;
  playhead: number;
  pixelsPerSecond: number;
  selectedClipIds: string[];
}

function read(): RecoverySnapshot[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RecoverySnapshot[]) : [];
  } catch {
    return [];
  }
}

function write(list: RecoverySnapshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded (large projects with thumbnails): keep only the newest and retry once.
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(-1)));
    } catch {
      /* out of space — recovery is best-effort, so give up silently */
    }
  }
}

/** Append a snapshot, trimming to the most recent MAX_VERSIONS. */
export function writeSnapshot(input: RecoveryInput, reason: RecoveryReason, keep = MAX_VERSIONS): void {
  const snap: RecoverySnapshot = {
    savedAt: Date.now(),
    reason,
    projectName: input.project.name,
    projectJson: serializeProject(input.project),
    playhead: input.playhead,
    pixelsPerSecond: input.pixelsPerSecond,
    selectedClipIds: input.selectedClipIds,
  };
  const list = read();
  list.push(snap);
  write(list.slice(-Math.max(1, keep)));
}

export function listSnapshots(): RecoverySnapshot[] {
  return read();
}

export function latestSnapshot(): RecoverySnapshot | null {
  const l = read();
  return l.length ? l[l.length - 1]! : null;
}

export function clearSnapshots(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Rehydrate a project from a snapshot. */
export function restoreProject(snap: RecoverySnapshot): Project {
  return deserializeProject(snap.projectJson);
}

// ── Session liveness ─────────────────────────────────────────────────────────
// A flag flipped on at load and off on a clean `beforeunload`. If it's still "on" at the
// next startup, the previous session never reached a clean exit → likely a crash.

export function wasPreviousSessionUnclean(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markSessionOpen(): void {
  try {
    localStorage.setItem(SESSION_KEY, 'true');
  } catch {
    /* ignore */
  }
}

export function markSessionClosed(): void {
  try {
    localStorage.setItem(SESSION_KEY, 'false');
  } catch {
    /* ignore */
  }
}
