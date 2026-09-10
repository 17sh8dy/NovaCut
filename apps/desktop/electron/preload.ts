/**
 * Preload — the only bridge between the sandboxed renderer and Node/Electron. It exposes a
 * minimal, typed `window.opencut` API over contextBridge; the renderer never touches
 * ipcRenderer or Node directly, which keeps the app secure (contextIsolation on).
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  CH,
  type ExportJobDTO,
  type MenuCommand,
  type MenuId,
  type OpenCutApi,
  type WindowAction,
} from './ipc-types.js';

/**
 * Subscribe to a main→renderer channel, returning an unsubscribe.
 *
 * The listener is wrapped so the renderer only ever sees the payload: handing it Electron's
 * IpcRendererEvent would leak `sender` — a live handle back into the main process — straight
 * through the context bridge, which is the one thing contextIsolation exists to prevent.
 */
function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_e: unknown, value: T): void => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api: OpenCutApi = {
  platform: 'desktop',
  os: process.platform,
  openProject: () => ipcRenderer.invoke(CH.openProject),
  saveProject: (json, path, suggestedName) => ipcRenderer.invoke(CH.saveProject, json, path, suggestedName),
  loadProject: (path) => ipcRenderer.invoke(CH.loadProject, path),
  recentProjects: () => ipcRenderer.invoke(CH.recentProjects),
  importFiles: (kinds) => ipcRenderer.invoke(CH.importFiles, kinds),
  probeMedia: (src) => ipcRenderer.invoke(CH.probeMedia, src),
  generateThumbnail: (src, atSeconds) => ipcRenderer.invoke(CH.generateThumbnail, src, atSeconds),
  // Custom protocol so <video>/<img> can load local files under a strict CSP.
  mediaUrl: (src) => {
    if (/^(https?|blob|data|novacut):/.test(src)) return src;
    return `novacut://media/${encodeURIComponent(src)}`;
  },
  // Electron removed File.path; this is the supported way to get a dropped file's path.
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  chooseExportPath: (defaultName) => ipcRenderer.invoke(CH.chooseExportPath, defaultName),
  encoderCreate: (job: ExportJobDTO, inW, inH, outW, outH, audioWav) =>
    ipcRenderer.invoke(CH.encoderCreate, job, inW, inH, outW, outH, audioWav ?? null),
  encoderWrite: (jobId, frame) => ipcRenderer.invoke(CH.encoderWrite, jobId, frame),
  encoderFinish: (jobId) => ipcRenderer.invoke(CH.encoderFinish, jobId),
  encoderAbort: (jobId) => ipcRenderer.invoke(CH.encoderAbort, jobId),
  confirmDiscard: (projectName) => ipcRenderer.invoke(CH.confirmDiscard, projectName),
  notify: (title, body) => ipcRenderer.send(CH.notify, title, body),
  revealFile: (path) => ipcRenderer.send(CH.revealFile, path),

  onMenuCommand: (handler) => subscribe<MenuCommand>(CH.menuCommand, handler),
  onOpenProjectPath: (handler) => subscribe<string>(CH.openProjectPath, handler),
  setDirty: (dirty, projectName) => ipcRenderer.send(CH.setDirty, dirty, projectName),
  saveComplete: (saved) => ipcRenderer.send(CH.saveComplete, saved),
  popupMenu: (id: MenuId, x, y) => ipcRenderer.send(CH.popupMenu, id, x, y),
  openExternal: (url) => ipcRenderer.send(CH.openExternal, url),
  windowAction: (action: WindowAction) => ipcRenderer.send(CH.windowAction, action),
  onWindowState: (handler) => subscribe<{ maximized: boolean }>(CH.windowState, handler),

  chooseDirectory: () => ipcRenderer.invoke(CH.chooseDirectory),
  systemInfo: () => ipcRenderer.invoke(CH.systemInfo),
  storageUsage: (projectDir) => ipcRenderer.invoke(CH.storageUsage, projectDir),
  clearCache: () => ipcRenderer.invoke(CH.clearCache),
  clearRecentProjects: () => ipcRenderer.invoke(CH.clearRecentProjects),
  openDataFolder: () => ipcRenderer.invoke(CH.openDataFolder),
  setLaunchOnStartup: (enabled) => ipcRenderer.invoke(CH.setLaunchOnStartup, enabled),
  setZoomFactor: (factor) => ipcRenderer.send(CH.setZoomFactor, factor),
  setHostPrefs: (prefs) => ipcRenderer.send(CH.hostPrefs, prefs),
};

contextBridge.exposeInMainWorld('opencut', api);
