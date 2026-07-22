/**
 * Renderer entry. Constructs the desktop PlatformBridge, creates the app store around it,
 * and mounts the platform-agnostic editor. A web build would differ only in which bridge
 * and mount target it uses — the <EditorApp> is identical.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppStore, EditorApp } from '@opencut/ui';
import { ElectronBridge } from './bridge.js';
import { connectShell } from './shell.js';

const store = createAppStore(new ElectronBridge());
// Menu commands, .opencut file associations and the unsaved-changes quit guard. Connected before
// the first render so a project handed over at launch is handled the moment it arrives.
connectShell(store);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <EditorApp store={store} />
  </StrictMode>,
);
