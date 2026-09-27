import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // perf budget: warn only on real regressions — lazy chunks (pdf.js/pdf-lib
  // ~430KB) ride under this; main entry should stay well below after editor
  // code-splitting.
  build: {
    // lazily-loaded vendor chunks top out at ~770KB (mammoth/docx) — only fetched
    // when a Writer doc is opened; the main entry is the real budget concern.
    chunkSizeWarningLimit: 800,
    // split the heavy writer-only libs into a vendor chunk cached separately
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "writer-vendor", test: /katex|lowlight|tiptap-pagination-plus|tiptap-track-changes/ },
            { name: "ooxml", test: /docx|mammoth|jszip/ },
          ],
        },
      },
    },
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
