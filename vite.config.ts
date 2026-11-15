import { defineConfig } from 'vite';

// Relative base so the built `dist/` works from any static host path
// (e.g. GitHub Pages under /repo-name/), which keeps "share as a link" easy.
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1000 }, // three.js alone is ~600 kB
});
