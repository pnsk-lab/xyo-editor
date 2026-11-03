// Run after build.sh. Tests the generated ESM factory and Vite asset deployment.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(root, '.work')
const artifacts = join(work, 'build-wasm')
const { default: create } = await import(pathToFileURL(join(artifacts, 'xyo-browser-esm.mjs')).href)
const wasm = await readFile(join(artifacts, 'xyo-browser-esm.wasm'))
const m = await create({ wasmBinary: wasm })
assert.equal(m._xyo_browser_capabilities() & 3, 3)
const h = m._xyo_browser_create()
assert.ok(h)
assert.equal(m._xyo_browser_destroy(h), 1)
const fn = m.addFunction(x => x + 1, 'ii')
assert.ok(fn > 0)
m.removeFunction(fn)
// Reusing freed table entries must remain possible.
const again = m.addFunction(x => x * 2, 'ii')
assert.ok(again > 0)
m.removeFunction(again)

// Build a tiny isolated consumer using the editor's Vite install. Importing the
// wasm with ?url makes Vite copy/hash the binary and rewrite it for base.
const fixture = join(work, 'vite-distribution-fixture')
const outDir = join(work, 'vite-distribution-output')
await mkdir(fixture, { recursive: true })
await writeFile(join(fixture, 'index.html'), '<!doctype html><script type="module" src="/main.js"></script>')
await writeFile(join(fixture, 'main.js'), `import create from '../build-wasm/xyo-browser-esm.mjs';\nimport wasmUrl from '../build-wasm/xyo-browser-esm.wasm?url';\nwindow.createTestRuntime = () => create({locateFile: p => p.endsWith('.wasm') ? wasmUrl : p});\n`)
const editorRequire = createRequire(join(root, '../editor/package.json'))
const { build } = await import(pathToFileURL(editorRequire.resolve('vite')).href)
await build({ configFile: false, root: fixture, base: '/nested/deployment/', logLevel: 'error',
  build: { outDir, emptyOutDir: false, assetsInlineLimit: 0 } })
const html = await readFile(join(outDir, 'index.html'), 'utf8')
assert.match(html, /\/nested\/deployment\/assets\//)
const assets = join(outDir, 'assets')
const names = await readdir(assets)
const jsName = names.find(n => /^index-.*\.js$/.test(n))
const wasmName = names.find(n => /^xyo-browser-esm-.*\.wasm$/.test(n))
assert.ok(jsName, `missing bundled JavaScript: ${names}`)
assert.ok(wasmName, `missing copied WASM: ${names}`)
const js = await readFile(join(assets, jsName), 'utf8')
assert.ok(js.includes(`/nested/deployment/assets/${wasmName}`), 'WASM URL must include Vite base')
assert.deepEqual(await readFile(join(assets, wasmName)), wasm)
console.log('ESM callback registration and Vite base-path asset build passed')
