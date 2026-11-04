// Builds the dashboard (Decision MP-026) from dashboard/ into dist/, which the controller serves at its main
// address. Build output and Vite's cache stay outside the folders a source
// snapshot covers, so building or testing never changes measured source. Root files like this one are
// protected from stories. Vite and Vitest load it natively (`--configLoader native`), so loading writes
// no temporary file into node_modules, which the test sandbox may only read.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'dashboard',
  base: '/',
  cacheDir: '../.vite-cache',
  plugins: [react()],
  // No file is inlined as a data: URL: the page's security policy loads fonts and other files from the controller
  // only, so an inlined font (Vite inlines files under 4 KB by default) would be refused.
  build: { outDir: '../dist', emptyOutDir: true, assetsInlineLimit: 0 },
  // Four simulated pages at a time: Vitest's default of one per CPU thread but one (31 on the director's PC) took
  // about 4.9 GB, and four took 1.5 GB and finished sooner (40 s against 31 s, October 28).
  // Each test file first loads every page the dashboard loads on demand (src/test-setup.ts), so a test's wait for a page
  // never includes preparing its code on a busy computer (November 4, 2026).
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    maxWorkers: 4,
    setupFiles: ['./src/test-setup.ts'],
  },
});
