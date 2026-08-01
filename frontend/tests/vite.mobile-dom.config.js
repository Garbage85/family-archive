import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: '/tmp/family-archive-mobile-dom-build',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'mobile-dom-scenario.html'),
    },
  },
});
