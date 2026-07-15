import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors apps/desktop/electron.vite.config.ts, plus React, so the harness mounts the exact
// components the app ships. IIFE for the same file:// reason as vite.config.ts.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@opencut/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@opencut/photo': resolve(__dirname, '../packages/photo/src/index.ts'),
      '@opencut/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
      '@opencut/ui': resolve(__dirname, '../packages/ui/src/index.ts'),
    },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(__dirname, 'dist-ui'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'ui.entry.ts'),
      formats: ['iife'],
      name: 'PhotoHarness',
      fileName: () => 'ui-harness.js',
    },
  },
});
