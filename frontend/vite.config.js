import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: {
    outDir: '../pb_public',
    emptyOutDir: true,
    sourcemap: false,
  },
});
