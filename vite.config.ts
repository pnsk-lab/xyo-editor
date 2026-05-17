import { defineConfig } from 'vite-plus'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 800,
  },
  fmt: {
    semi: false,
    singleQuote: true,
  },
})
