import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite config: three build targets in one file.
 *  - main:     Electron main process (Node)
 *  - preload:  the context-bridge script
 *  - renderer: the React editor (imports workspace packages from source via aliases)
 *
 * Workspace packages are aliased straight to their TS source so there's no separate build
 * step during development, and HMR covers the whole monorepo.
 */
const workspace = {
  '@opencut/core': resolve(__dirname, '../../packages/core/src/index.ts'),
  '@opencut/photo': resolve(__dirname, '../../packages/photo/src/index.ts'),
  '@opencut/engine': resolve(__dirname, '../../packages/engine/src/index.ts'),
  '@opencut/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') },
      },
    },
  },
  renderer: {
    root: __dirname,
    resolve: { alias: workspace },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') },
      },
    },
    plugins: [react()],
  },
});
