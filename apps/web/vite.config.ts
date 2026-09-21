import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    injectRegister: null,
    registerType: 'prompt',
    manifest: false,
    workbox: {
      globPatterns: ['**/*.{js,css,html}'],
      navigateFallback: 'index.html',
      navigateFallbackAllowlist: [/^\/(?:dashboard|reports)\/?$/, /^\/pos\/(?:login|dashboard|register|payment|customers|orders(?:\/[^/]+)?)\/?$/],
      cleanupOutdatedCaches: false,
    },
  })],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', rewrite: path => path.replace(/^\/api/, '') } },
  },
})
