import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { type Browser } from 'playwright-core'
import { hasXyoEsm, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

// Opt in after building the Emscripten ESM artifacts; CHROME_BIN can override Chromium.
const suite = optIn('XYO_CPP_WASM_BROWSER_TEST', hasXyoEsm) ? describe : describe.skip
const build = join(import.meta.dir, '../../xyo-cpp-wasm/.work/build-wasm')
const base = '/production/subpath/'
let server: ReturnType<typeof Bun.serve> | undefined
let browser: Browser | undefined

suite('xyo-cpp ESM build in Chromium', () => {
  beforeAll(async () => {
    for (const name of ['xyo-browser-esm.mjs', 'xyo-browser-esm.wasm']) {
      if (!(await Bun.file(join(build, name)).exists()))
        throw new Error(`Missing Emscripten artifact: ${join(build, name)}`)
    }
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        switch (new URL(request.url).pathname) {
          case `${base}index.html`:
            return new Response('<!doctype html><title>ESM test</title>', {
              headers: { 'content-type': 'text/html' },
            })
          case `${base}assets/xyo-browser-esm.mjs`:
            return new Response(Bun.file(join(build, 'xyo-browser-esm.mjs')), {
              headers: { 'content-type': 'text/javascript' },
            })
          case `${base}wasm/xyo-browser-esm.wasm`:
            return new Response(Bun.file(join(build, 'xyo-browser-esm.wasm')), {
              headers: { 'content-type': 'application/wasm' },
            })
          default:
            return new Response('Not found', { status: 404 })
        }
      },
    })
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 30000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      server?.stop(true)
    }
  })

  it('imports ESM, resolves WASM under the base, and executes compiled SB3', async () => {
    const blocks = {
      hat: {
        opcode: 'event_whenflagclicked',
        next: 'a',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
      },
      a: {
        opcode: 'data_changevariableby',
        next: 'b',
        parent: 'hat',
        inputs: { VALUE: [1, [4, '3']] },
        fields: { VARIABLE: ['v', 'v'] },
      },
      b: {
        opcode: 'data_changevariableby',
        next: null,
        parent: 'a',
        inputs: { VALUE: [1, [4, '2']] },
        fields: { VARIABLE: ['v', 'v'] },
      },
    }
    const project = {
      targets: [
        {
          isStage: true,
          name: 'Stage',
          variables: { v: ['v', 7] },
          lists: {},
          broadcasts: {},
          blocks,
          costumes: [],
          sounds: [],
          currentCostume: 0,
          volume: 100,
          layerOrder: 0,
        },
      ],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0' },
    }
    const archive = Array.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))
    const page = await browser!.newPage()
    const responses: Array<{ path: string; status: number }> = []
    page.on('response', (response) => {
      if (/xyo-browser-esm\.(mjs|wasm)$/.test(new URL(response.url()).pathname))
        responses.push({ path: new URL(response.url()).pathname, status: response.status() })
    })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}${base}index.html`)
      const result = await page.evaluate(
        async ({ base, archive }) => {
          const moduleUrl = new URL(`${base}assets/xyo-browser-esm.mjs`, location.origin).href
          const imported = await import(/* @vite-ignore */ moduleUrl)
          const locations: string[] = []
          const m = await imported.default({
            locateFile(path: string) {
              locations.push(path)
              return new URL(`${base}wasm/${path}`, location.origin).href
            },
          })
          const h = m._xyo_browser_create()
          if (!h) throw new Error('create failed')
          const check = (ok: number, op: string) => {
            if (!ok) throw new Error(`${op}: ${m.UTF8ToString(m._xyo_browser_error(h))}`)
          }
          const stats = () => [
            m._xyo_browser_compile_attempts(),
            m._xyo_browser_compile_successes(),
            m._xyo_browser_compiled_executions(),
            m._xyo_browser_compile_fallbacks(),
            m._xyo_browser_compiled_live_modules(),
          ]
          const value = () =>
            JSON.parse(m.UTF8ToString(m._xyo_browser_snapshot(h))).targets[0].variables.v.value
          try {
            check(m._xyo_browser_set_compiled(h, 1), 'enable compiled mode')
            const ptr = m._malloc(archive.length)
            if (!ptr) throw new Error('malloc failed')
            try {
              m.HEAPU8.set(archive, ptr)
              check(m._xyo_browser_load_sb3(h, ptr, archive.length), 'load')
            } finally {
              m._free(ptr)
            }
            const initial = stats(),
              before = value()
            check(m._xyo_browser_green_flag(h), 'flag')
            const flagged = stats(),
              flagValue = value()
            check(m._xyo_browser_step(h), 'step')
            return {
              locations,
              capabilities: m._xyo_browser_capabilities(),
              initial,
              before,
              flagged,
              flagValue,
              stepped: stats(),
              after: value(),
            }
          } finally {
            m._xyo_browser_destroy(h)
          }
        },
        { base, archive },
      )
      expect(responses).toEqual([
        { path: `${base}assets/xyo-browser-esm.mjs`, status: 200 },
        { path: `${base}wasm/xyo-browser-esm.wasm`, status: 200 },
      ])
      expect(result.locations).toEqual(['xyo-browser-esm.wasm'])
      expect(result.capabilities & 2).toBe(2)
      expect(result.initial).toEqual([0, 0, 0, 0, 0])
      expect(result.before).toBe(7)
      expect(result.flagged).toEqual([1, 1, 0, 0, 1])
      expect(result.flagValue).toBe(7)
      expect(result.stepped).toEqual([1, 1, 1, 0, 0])
      expect(result.after).toBe(12)
    } finally {
      await page.close()
    }
  }, 30000)
})
