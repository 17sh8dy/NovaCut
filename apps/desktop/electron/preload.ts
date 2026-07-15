/**
 * Preload — the only bridge between the sandboxed renderer and Node/Electron. It exposes a
 * minimal, typed `window.opencut` API over contextBridge; the renderer never touches
 * ipcRenderer or Node directly, which keeps the app secure (contextIsolation on).
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH, type ExportJobDTO, type OpenCutApi } from './ipc-types.js';

const api: OpenCutApi = {
  platform: 'desktop',
  openProject: () => ipcRenderer.invoke(CH.openProject),
  saveProject: (json, path) => ipcRenderer.invoke(CH.saveProject, json, path),
  loadProject: (path) => ipcRenderer.invoke(CH.loadProject, path),
  recentProjects: () => ipcRenderer.invoke(CH.recentProjects),
  importFiles: () => ipcRenderer.invoke(CH.importFiles),
  probeMedia: (src) => ipcRenderer.invoke(CH.probeMedia, src),
  generateThumbnail: (src, atSeconds) => ipcRenderer.invoke(CH.generateThumbnail, src, atSeconds),
  // Custom protocol so <video>/<img> can load local files under a strict CSP.
  mediaUrl: (src) => {
    if (/^(https?|blob|data|opencut):/.test(src)) return src;
    return `opencut://media/${encodeURIComponent(src)}`;
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
  notify: (title, body) => ipcRenderer.send(CH.notify, title, body),
};

contextBridge.exposeInMainWorld('opencut', api);
