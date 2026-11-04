import { defineConfig } from 'vite';

// DEMO_BASE is set by the GitHub Pages workflow, which serves the site from /lunchrush/.
export default defineConfig({
  base: process.env.DEMO_BASE ?? '/',
  esbuild: { jsx: 'automatic' },
});
