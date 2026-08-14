import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors ui.config.ts — same aliases, same IIFE-for-file:// reason — but bundles the timeline
// pointer harness. CSS is emitted as one file the page links, because the gestures under test
// are aimed at real element rects and an unstyled timeline has none.
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
    outDir: resolve(__dirname, 'dist-pointer'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'timeline-pointer.entry.tsx'),
      formats: ['iife'],
      name: 'PointerHarness',
      fileName: () => 'pointer-harness.js',
    },
  },
});
