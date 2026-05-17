import { defineConfig } from 'vite-plus'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { compile } from 'svelte/compiler'

function sveltePackPlugin() {
  return {
    name: 'hikkaku:svelte-pack',
    transform: {
      filter: {
        id: /\.svelte$/,
      },
      handler(code: string, id: string) {
        const compiled = compile(code, {
          filename: id,
          generate: 'client',
          css: 'injected',
        })
        return {
          code: compiled.js.code,
          map: compiled.js.map,
        }
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  pack: {
    entry: ['src/editor.ts'],
    dts: {
      eager: true,
    },
    tsconfig: 'tsconfig.app.json',
    platform: 'browser',
    clean: false,
    css: {
      inject: true,
    },
    plugins: [sveltePackPlugin()],
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/blockly')) return 'blockly'
          if (id.includes('node_modules/svelte') || id.includes('node_modules/lucide-svelte')) return 'svelte-ui'
        },
      },
    },
  },
})
