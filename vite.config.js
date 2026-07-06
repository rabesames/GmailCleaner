import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port is pinned to 5500 (not Vite's 5173 default) so it matches whatever
// origin you've already registered as an Authorized JavaScript origin in
// Google Cloud Console -- see README.md.
export default defineConfig({
  plugins: [react()],
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
