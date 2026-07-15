import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Aliases mirror apps/desktop/electron.vite.config.ts so the harness compiles the exact same
// engine source the app ships.
//
// IIFE, not ES module: the host loads the page over file://, where Chromium blocks module
// scripts as cross-origin. A classic script sidesteps that without standing up a server.
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@opencut/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@opencut/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'entry.ts'),
      formats: ['iife'],
      name: 'OrientationHarness',
      fileName: () => 'harness.js',
    },
  },
});
