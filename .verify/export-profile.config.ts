import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Same aliases as vite.config.ts — the harness must compile the exact engine source the app ships.
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@opencut/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@opencut/photo': resolve(__dirname, '../packages/photo/src/index.ts'),
      '@opencut/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-export'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'export-profile.entry.ts'),
      formats: ['iife'],
      name: 'ExportProfiler',
      fileName: () => 'harness.js',
    },
  },
});
