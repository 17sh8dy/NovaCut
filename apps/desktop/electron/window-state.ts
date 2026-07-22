/**
 * Window geometry persistence.
 *
 * A desktop app that forgets where its window was is a desktop app that feels like a web page.
 * The saved rect is validated against the CURRENT displays before it is used — otherwise
 * unplugging the monitor the app was last on strands the window entirely off-screen, with no
 * way to get it back short of deleting the state file.
 */

import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowState extends Partial<Rectangle> {
  maximized?: boolean;
}

const DEFAULTS = { width: 1560, height: 960 };

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** Is this rect meaningfully visible on some connected display? */
function onSomeDisplay(rect: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    const overlapX = Math.min(rect.x + rect.width, b.x + b.width) - Math.max(rect.x, b.x);
    const overlapY = Math.min(rect.y + rect.height, b.y + b.height) - Math.max(rect.y, b.y);
    // Require a real patch of the title bar to be reachable, not a single pixel of corner.
    return overlapX > 120 && overlapY > 60;
  });
}

export function loadWindowState(): WindowState {
  let saved: WindowState;
  try {
    saved = JSON.parse(readFileSync(statePath(), 'utf8')) as WindowState;
  } catch {
    return { ...DEFAULTS };
  }
  const width = Math.max(900, saved.width ?? DEFAULTS.width);
  const height = Math.max(600, saved.height ?? DEFAULTS.height);
  const maximized = saved.maximized === true;
  if (saved.x === undefined || saved.y === undefined) return { width, height, maximized };
  const rect = { x: saved.x, y: saved.y, width, height };
  // Off-screen (monitor unplugged / resolution changed): drop the position, keep the size and
  // let Electron centre the window.
  return onSomeDisplay(rect) ? { ...rect, maximized } : { width, height, maximized };
}

/**
 * Persist geometry on every move/resize, debounced.
 *
 * `getNormalBounds` rather than `getBounds`: while maximized, getBounds returns the screen, and
 * saving that would make "restore down" a no-op forever after.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const persist = (): void => {
    if (win.isDestroyed()) return;
    const state: WindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      writeFileSync(statePath(), JSON.stringify(state), 'utf8');
    } catch {
      /* best-effort: a window that forgets its size is not worth failing a quit over */
    }
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    persist();
  });
}
