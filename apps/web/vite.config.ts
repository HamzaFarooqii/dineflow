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
      navigateFallbackAllowlist: [
        /^\/(?:dashboard|reports)\/?$/,
        /^\/pos\/(?:login|dashboard|register|floor|kitchen|payment|customers|inventory|products|settings|sync|orders(?:\/[^/]+)?)\/?$/,
      ],
      cleanupOutdatedCaches: false,
    },
  })],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const path = id.replace(/\\/g, '/')
          if (!path.includes('/node_modules/')) return undefined
          if (path.includes('/@supabase/')) return 'vendor-supabase'
          if (path.includes('/dexie/') || path.includes('/zustand/')) return 'vendor-offline'
          if (path.includes('/lucide-react/')) return 'vendor-icons'
          if (path.includes('/react/') || path.includes('/react-dom/') || path.includes('/react-router') || path.includes('/scheduler/')) {
            return 'vendor-react'
          }
          return 'vendor'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', rewrite: path => path.replace(/^\/api/, '') } },
  },
})
