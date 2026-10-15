import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

const devBackend = new URL(process.env.APPFORGE_DEV_BACKEND_URL ?? 'http://localhost:3001')
const devBackendPrefix = devBackend.pathname.replace(/\/$/, '')
const proxyPath = (requestPath: string) => `${devBackendPrefix}${requestPath}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/icon.svg'],
      manifest: {
        name: 'AppForge AI Studio',
        short_name: 'AppForge',
        description: 'AI-assisted web app development studio. Created by jpecina.',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    // Dev proxy: el frontend habla con el backend Oracle/local sin CORS.
    // Claves regex (^...): '/p' a secas capturaría también '/projects'.
    proxy: {
      '^/api/': { target: devBackend.origin, changeOrigin: true, rewrite: proxyPath },
      '^/p/': { target: devBackend.origin, changeOrigin: true, rewrite: proxyPath },
    },
  },
})
