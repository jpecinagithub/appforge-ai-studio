import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Rutas relativas: la preview del estudio sirve el build bajo /p/:id/
  base: './',
  plugins: [react(), tailwindcss()],
});
