import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { XyoHeadlessRuntime, type XyoModule, type RendererCallbacksOptions } from '../src/index'

const test = process.env.XYO_WASM_TEST === '1' ? it : it.skip
const root = join(import.meta.dir, '..')

describe('renderer wrapper against real ESM WASM', () => {
  test('attaches, replaces, detaches and destroys native callbacks safely', async () => {
    const dir = join(root, '.work/build-wasm')
    const { default: create } = await import(pathToFileURL(join(dir, 'xyo-browser-esm.mjs')).href)
    const module: XyoModule = await create({ wasmBinary: await readFile(join(dir, 'xyo-browser-esm.wasm')) })
    const runtime = new XyoHeadlessRuntime(module)
    let draws = 0, picks = 0, syncs = 0
    const renderer = { requestDraw() {}, draw() { draws++ }, pick() { picks++; return null } }
    const options = { renderer, sync: () => { syncs++; return { snapshot: {}, targets: [] } }, fenceRect: () => [0, 0, 0, 0], pickToScratch: (x: number, y: number) => [x, y], setDrawableOrder: () => 0, destroyDrawable: () => {}, visualChange: () => {}, collisionMode: 'approximate' } as unknown as RendererCallbacksOptions
    try {
      runtime.loadSb3(await readFile(join(root, '.work/xyo-cpp/tests/fixtures/basic.sb3')))
      runtime.attachRenderer(options)
      runtime.step()
      runtime.mouse(100, 90, 480, 360, true)
      expect(draws).toBeGreaterThan(0); expect(picks).toBe(1); expect(syncs).toBeGreaterThan(1)
      runtime.attachRenderer(options)
      runtime.step()
      const beforeDetach = draws
      runtime.detachRenderer()
      runtime.step()
      expect(draws).toBe(beforeDetach)
      runtime.attachRenderer(options)
    } finally { runtime.dispose() }
    expect(() => runtime.detachRenderer()).toThrow('disposed')
  }, 30000)
})
