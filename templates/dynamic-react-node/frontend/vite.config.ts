import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative paths: the app is served under /a/:projectId/ by the Studio
  // proxy and under / in Docker — never assume the public prefix.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev only: forward API calls to the local backend.
      '/api': 'http://127.0.0.1:8080',
    },
  },
});
