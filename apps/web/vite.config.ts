import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'og.png'],
      manifest: false, // manifest.webmanifest already lives in public/
      workbox: {
        // SPA shell offline: serve index.html for navigations (never /api)
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // precache the whole app — office suites tolerate a few MB for full
        // offline editing (pdf.worker ~1.3MB is the largest chunk)
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // never cache API or realtime endpoints at runtime
        runtimeCaching: [],
      },
    }),
  ],
  // perf budget: warn only on real regressions — lazy chunks (pdf.js/pdf-lib
  // ~430KB) ride under this; main entry should stay well below after editor
  // code-splitting.
  build: {
    // lazily-loaded vendor chunks top out at ~770KB (mammoth/docx) — only fetched
    // when a Writer doc is opened; the main entry is the real budget concern.
    // NOTE: no manual chunk groups — rolldown parks shared helpers in them,
    // which turns them into eager entry deps (modulepreloaded on every route).
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      // VITE_API_TARGET lets local dev hit the VPS backend+db, e.g.
      //   VITE_API_TARGET=https://suites.kreatixtech.com pnpm dev:web
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
})
