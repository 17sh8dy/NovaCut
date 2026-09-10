/**
 * The application menu.
 *
 * Every item here is a thin shell: it sends a `menu:command` id to the focused window and the
 * renderer decides what that means (see apps/desktop/src/menu.ts). The menu owns no behaviour,
 * so it can never disagree with the buttons in the title bar.
 *
 * ONE RULE, and it is the whole reason this file is careful: commands the renderer already binds
 * as keyboard shortcuts are declared with `registerAccelerator: false`. The accelerator still
 * SHOWS in the menu — users need to discover Ctrl+S somewhere — but Electron does not intercept
 * the keystroke. Without that flag both layers fire on one press, which for Undo means undoing
 * two steps and for New Project means discarding work twice.
 *
 * The window is frameless (the app draws its own title bar), and a frameless window shows no
 * native menu bar on Windows or Linux. So the same submenus are ALSO exposed to the renderer via
 * `popupMenu`, which the in-app File/Edit/View/Help buttons call — one definition, two surfaces.
 * `Menu.setApplicationMenu` is still called because macOS needs a real menu bar and because it is
 * what registers the accelerators.
 */

import { app, BrowserWindow, Menu, shell, dialog, type MenuItemConstructorOptions } from 'electron';
import { CH } from './ipc-types.js';

const isMac = process.platform === 'darwin';

/** Community invite, surfaced under Help. */
const DISCORD_INVITE = 'https://discord.gg/XBhER9Z6EB';

export type MenuId = 'file' | 'edit' | 'view' | 'help';

function send(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(CH.menuCommand, command);
}

/** A menu item mirroring a shortcut the renderer already owns: shows the key, never steals it. */
function mirrored(label: string, command: string, accelerator: string): MenuItemConstructorOptions {
  return { label, accelerator, registerAccelerator: false, click: () => send(command) };
}

/** A menu item that IS the only binding for its command, so it registers the accelerator. */
function owned(label: string, command: string, accelerator?: string): MenuItemConstructorOptions {
  return { label, ...(accelerator ? { accelerator } : {}), click: () => send(command) };
}

function submenus(): Record<MenuId, MenuItemConstructorOptions[]> {
  const mod = isMac ? 'Cmd' : 'Ctrl';
  return {
    file: [
      mirrored('New Project', 'new', `${mod}+N`),
      mirrored('Open Project…', 'open', `${mod}+O`),
      { type: 'separator' },
      mirrored('Save', 'save', `${mod}+S`),
      owned('Save As…', 'saveAs', `${mod}+Shift+S`),
      { type: 'separator' },
      owned('Import Media…', 'import', `${mod}+I`),
      owned('Export…', 'export', `${mod}+E`),
      { type: 'separator' },
      owned('Project Settings…', 'projectSettings'),
      owned('Preferences…', 'preferences', `${mod}+,`),
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
    edit: [
      mirrored('Undo', 'undo', `${mod}+Z`),
      mirrored('Redo', 'redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
      { type: 'separator' },
      // Roles, not commands: these must act on whatever input has focus, which is something only
      // the platform's own clipboard handling gets right (IME, selection, read-only fields).
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      mirrored('Split at Playhead', 'split', `${mod}+B`),
      mirrored('Duplicate', 'duplicate', `${mod}+D`),
      mirrored('Delete', 'delete', 'Delete'),
    ],
    view: [
      owned('Home', 'home'),
      owned('Video Editor', 'editor'),
      owned('Photo Editor', 'photo'),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
      // Reload is deliberately absent: it discards unsaved edits with a keystroke and no
      // confirmation. DevTools still offers it for diagnostics.
    ],
    help: [
      owned('Keyboard Shortcuts', 'shortcuts'),
      { type: 'separator' },
      // openExternal, not openPath: this must hand the invite to the user's browser/Discord app.
      { label: 'Join the Discord', click: () => void shell.openExternal(DISCORD_INVITE) },
      { type: 'separator' },
      { label: 'Open App Data Folder', click: () => void shell.openPath(app.getPath('userData')) },
      {
        label: 'About Nova Cut',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'About Nova Cut',
            message: `Nova Cut ${app.getVersion()}`,
            detail: [
              'A professional non-linear video and photo editor.',
              '',
              `Electron ${process.versions.electron}  ·  Chromium ${process.versions.chrome}`,
              `Node ${process.versions.node}`,
            ].join('\n'),
            buttons: ['OK'],
          });
        },
      },
    ],
  };
}

export function buildMenu(): void {
  const s = submenus();
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              owned('Preferences…', 'preferences', 'Cmd+,'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    { label: '&File', submenu: s.file },
    { label: '&Edit', submenu: s.edit },
    { label: '&View', submenu: s.view },
    {
      label: '&Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    { role: 'help', label: '&Help', submenu: s.help },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The currently-open popup, held only so it stays reachable while it is on screen.
 *
 * `Menu.buildFromTemplate(...).popup()` leaves the menu unreachable from JS the instant the call
 * returns; keeping a reference until it closes takes garbage collection out of the question
 * entirely rather than relying on Electron's own internal retention.
 */
let openPopup: Menu | null = null;

/** Pop one of the top-level menus at a point in the window, for the in-app menu bar. */
export function popupMenu(win: BrowserWindow, id: MenuId, x: number, y: number): void {
  const items = submenus()[id];
  if (!items) return;
  const menu = Menu.buildFromTemplate(items);
  openPopup?.closePopup(win); // one menu at a time, as a menu bar behaves
  openPopup = menu;
  menu.once('menu-will-close', () => {
    if (openPopup === menu) openPopup = null;
  });
  // Coordinates arrive as CSS pixels from the renderer and are rounded because `popup` rejects
  // fractional values — a devicePixelRatio of 1.25 (a very ordinary Windows display scale)
  // produces them constantly.
  menu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
}
