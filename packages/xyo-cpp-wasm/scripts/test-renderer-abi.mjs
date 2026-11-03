// Run after build.sh. Exercises the actual wasm32 callback-table ABI.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const build = join(root, '.work/build-wasm')
const { default: create } = await import(pathToFileURL(join(build, 'xyo-browser-esm.mjs')).href)
const m = await create({ wasmBinary: await readFile(join(build, 'xyo-browser-esm.wasm')) })
const calls = []
const signatures = ['iidd','vi','iiidd','iiiii','iiii','iiiii','viii','iii','viiiii','viiii','diidii','vii','vii','iii','iii','ii','viiiddddd','viiiddd','vii','viii','viii']
const callbacks = signatures.map((sig, index) => m.addFunction((...args) => {
  calls.push([index, ...args])
  return index === 0 ? -1 : 0
}, sig))
const tableSize = 4 * (1 + signatures.length)
const table = m._malloc(tableSize)
const dv = () => new DataView(m.HEAPU8.buffer)
const fill = () => { dv().setUint32(table, 0x1234, true); callbacks.forEach((p, i) => dv().setUint32(table + 4 * (i + 1), p, true)) }
fill()
const h = m._xyo_browser_create()
const load = data => { const p = m._malloc(data.length); m.HEAPU8.set(data,p); try { return m._xyo_browser_load_sb3(h,p,data.length) } finally { m._free(p) } }
const bytes = await readFile(join(root, '.work/xyo-cpp/tests/fixtures/basic.sb3'))
assert.equal(load(bytes), 1)
assert.equal(m._xyo_browser_renderer_attach(h, 0, tableSize), 0)
assert.equal(m._xyo_browser_renderer_attach(h, table, tableSize - 4), 0)
assert.equal(m._xyo_browser_renderer_attach(h, table + 1, tableSize), 0)
dv().setUint32(table + 4, 0, true)
assert.equal(m._xyo_browser_renderer_attach(h, table, tableSize), 0)
fill()
assert.equal(m._xyo_browser_renderer_attach(h, table, tableSize), 1)
// The bridge copies the table, not a borrowed pointer to the table itself.
dv().setUint32(table + 4, 0, true)
assert.equal(m._xyo_browser_mouse(h, 100, 90, 480, 360, 1, 0, 0), 1)
assert.ok(calls.some(c => c[0] === 0 && c[1] === 0x1234 && c[2] === 100 && c[3] === 90))
assert.equal(m._xyo_browser_step(h), 1)
assert.ok(calls.some(c => c[0] === 1 && c[1] === 0x1234))
const count = calls.length
assert.equal(m._xyo_browser_renderer_attach(h, table, tableSize), 0) // old bridge survives invalid replacement
assert.equal(m._xyo_browser_step(h), 1)
assert.ok(calls.length > count)
assert.equal(load(Buffer.from('invalid')), 0)
assert.equal(load(bytes), 1) // attachment survives transactional project load
const beforeReloadStep = calls.length
assert.equal(m._xyo_browser_step(h), 1)
assert.ok(calls.length > beforeReloadStep)
assert.equal(m._xyo_browser_renderer_detach(h), 1)
assert.equal(m._xyo_browser_renderer_detach(h), 1)
const detached = calls.length
assert.equal(m._xyo_browser_step(h), 1)
assert.equal(m._xyo_browser_mouse(h, 100, 90, 480, 360, 0, 0, 0), 1)
assert.equal(calls.length, detached)
fill()
assert.equal(m._xyo_browser_renderer_attach(h, table, tableSize), 1)
assert.equal(m._xyo_browser_destroy(h), 1)
assert.equal(m._xyo_browser_renderer_detach(h), 0)
const destroyed = calls.length
for (const fn of callbacks) m.removeFunction(fn)
m._free(table)
assert.equal(calls.length, destroyed)
console.log('WASM renderer attach/detach callback ABI passed')
