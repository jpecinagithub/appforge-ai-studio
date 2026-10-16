import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const devBackend = new URL(process.env.APPFORGE_DEV_BACKEND_URL ?? 'http://localhost:3001')
const devBackendPrefix = devBackend.pathname.replace(/\/$/, '')
const proxyPath = (requestPath: string) => `${devBackendPrefix}${requestPath}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
