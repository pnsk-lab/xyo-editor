import { defineConfig } from 'vite-plus'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { compile } from 'svelte/compiler'
import { existsSync } from 'node:fs'

function xyoWorkerPlugin() {
  const id = '\0virtual:xyo-worker'
  const available = process.env.XYO_WASM !== '0' && ['xyo-browser-esm.mjs', 'xyo-browser-esm.wasm'].every(name =>
    existsSync(new URL(`../xyo-cpp-wasm/.work/build-wasm/${name}`, import.meta.url)))
  return {
    name: 'hikkaku:xyo-worker',
    resolveId(source: string) { if (source === 'virtual:xyo-worker') return id },
    load(source: string) {
      if (source !== id) return
      return available
        ? `export { default } from '/src/lib/xyo-worker-entry.ts?worker'`
        : `export default class { constructor() { throw new Error('xyo-cpp WASM artifacts are missing; build xyo-cpp-wasm and restart Vite') } }`
    },
  }
}

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
  plugins: [xyoWorkerPlugin(), tailwindcss(), svelte()],
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
