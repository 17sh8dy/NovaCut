import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Same aliases as the other GPU harnesses: the page compiles the exact engine source the app ships.
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@opencut/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@opencut/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-speed'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'speed.entry.ts'),
      formats: ['iife'],
      name: 'Speed',
      fileName: () => 'harness.js',
    },
  },
});
