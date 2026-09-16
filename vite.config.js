import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// package.json's `version` is the single source of truth for the app
// version (see src/lib/version.js) -- read here rather than duplicated as a
// literal, and inlined at build time via `define` since plain JS (outside
// this config file) has no built-in way to read package.json without
// bundling Node's `fs` into the browser build.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'));

// Port is pinned to 5500 (not Vite's 5173 default) so it matches whatever
// origin you've already registered as an Authorized JavaScript origin in
// Google Cloud Console -- see README.md.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5500 },
  preview: { port: 5500 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    globals: false,
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{js,jsx}'],
      // main.jsx is a 3-line bootstrap (createRoot(...).render(...)) with no
      // branching logic of its own -- testing it would only be testing
      // React/ReactDOM itself, not this app. Excluded deliberately rather
      // than padded with a no-assertion smoke test just to inflate coverage.
      exclude: ['src/main.jsx'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
