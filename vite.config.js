import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port is pinned to 5500 (not Vite's 5173 default) so it matches whatever
// origin you've already registered as an Authorized JavaScript origin in
// Google Cloud Console -- see README.md.
export default defineConfig({
  plugins: [react()],
  server: { port: 5500 },
  preview: { port: 5500 },
});
