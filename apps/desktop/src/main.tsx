/**
 * Renderer entry. Constructs the desktop PlatformBridge, creates the app store around it,
 * and mounts the platform-agnostic editor. A web build would differ only in which bridge
 * and mount target it uses — the <EditorApp> is identical.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppStore, EditorApp } from '@opencut/ui';
import { ElectronBridge } from './bridge.js';

const store = createAppStore(new ElectronBridge());

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <EditorApp store={store} />
  </StrictMode>,
);
