import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // Forward /api/* to the Rust backend during development
      '/api': 'http://localhost:8080'
    }
  }
})
