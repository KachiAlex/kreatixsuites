import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // perf budget: warn only on real regressions — lazy chunks (pdf.js/pdf-lib
  // ~430KB) ride under this; main entry should stay well below after editor
  // code-splitting.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
})
