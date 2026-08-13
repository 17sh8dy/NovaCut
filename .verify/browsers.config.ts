import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same aliases as ui.config.ts — the harness must compile the exact components the app ships,
// not a copy. IIFE for the same file:// reason the others are.
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
    outDir: resolve(__dirname, 'dist-browsers'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'browsers.entry.ts'),
      formats: ['iife'],
      name: 'BrowsersHarness',
      fileName: () => 'browsers-harness.js',
    },
  },
});
