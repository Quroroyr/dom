import { defineConfig } from 'vite';
export default defineConfig({
  // на GitHub Pages сайт живёт в /dom/, локально — в корне
  base: process.env.PAGES_BASE || '/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
