/**
 * Auto-update from the GitHub releases of 17sh8dy/NovaCut (see `publish` in electron-builder.yml).
 *
 * The flow, and who decides what:
 *   1. When "Check for updates automatically" is on, the app checks shortly after launch and every
 *      few hours after. A check downloads nothing; it only reads `latest.yml` on the newest release.
 *   2. A newer version asks first. Nothing is downloaded until the person says so.
 *   3. Installing is a second explicit choice, so an update can never restart the app under
 *      someone's unsaved work.
 *
 * It does nothing in a development run (there is no installed app to replace) and for the portable
 * build, which has no installer to hand the update to. electron-updater is a devDependency on
 * purpose: electron-vite bundles it into main, and `files` in electron-builder.yml keeps
 * node_modules out of the package.
 */

import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

// electron-updater is CommonJS; read `autoUpdater` off the default export rather than the name.
const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let wired = false;
let timer: NodeJS.Timeout | null = null;
let busy = false;
/** A version the person already said "Later" to this session; do not ask again until restart. */
let declined: string | null = null;

/** Portable builds set this; they cannot update themselves in place. */
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', async (info) => {
    if (declined === info.version || busy) return;
    busy = true;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Nova Cut update',
      message: `Nova Cut ${info.version} is available.`,
      detail: `You have ${app.getVersion()}. Download it now? You choose when to install it.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((err) => console.error('[updater] download failed', err));
    } else {
      declined = info.version;
      busy = false;
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Nova Cut update',
      message: `Nova Cut ${info.version} is ready to install.`,
      detail: 'Save your project first. Nova Cut will close and reopen to finish the update.',
      buttons: ['Restart and update', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    busy = false;
    if (response === 0) autoUpdater.quitAndInstall(false, true);
    else declined = info.version;
  });

  autoUpdater.on('error', (err) => {
    busy = false;
    console.error('[updater]', err?.message ?? err);
  });
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err));
}

/** Turn the periodic check on or off. Safe to call repeatedly with the same value. */
export function setAutoUpdateCheck(enabled: boolean): void {
  if (!app.isPackaged || isPortable()) return;
  if (!enabled) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  if (timer) return;
  wire();
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref();
}
