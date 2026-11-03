import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { type Browser } from 'playwright-core'
import { hasXyoWasm, optIn } from './artifacts'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

// Opt-in: requires the separately built Emscripten artifacts and Chromium.
const suite = optIn('XYO_CPP_WASM_BROWSER_TEST', hasXyoWasm) ? describe : describe.skip
const root = join(import.meta.dir, '../../..')
const build = join(root, 'packages/xyo-cpp-wasm/.work/build-wasm')
let server: ReturnType<typeof Bun.serve> | undefined
let browser: Browser | undefined

suite('real xyo-cpp WASM in Chromium', () => {
  beforeAll(async () => {
    for (const path of [
      join(build, 'xyo-browser.js'),
      join(build, 'xyo-browser.wasm'),
      join(root, 'packages/xyo-cpp-wasm/.work/xyo-cpp/tests/fixtures/basic.sb3'),
    ]) {
      if (!(await Bun.file(path).exists())) throw new Error(`Missing test prerequisite: ${path}`)
    }
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        switch (new URL(request.url).pathname) {
          case '/':
            return new Response('<!doctype html><script src="/xyo-browser.js"></script>', {
              headers: { 'content-type': 'text/html' },
            })
          case '/xyo-browser.js':
            return new Response(Bun.file(join(build, 'xyo-browser.js')), {
              headers: { 'content-type': 'text/javascript' },
            })
          case '/xyo-browser.wasm':
            return new Response(Bun.file(join(build, 'xyo-browser.wasm')), {
              headers: { 'content-type': 'application/wasm' },
            })
          case '/basic.sb3':
            return new Response(
              Bun.file(join(root, 'packages/xyo-cpp-wasm/.work/xyo-cpp/tests/fixtures/basic.sb3')),
            )
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

  it('compiles numeric and mixed scripts and falls back for unsupported scripts', async () => {
    const archive = (mode: 'numeric' | 'mixed' | 'unsupported') => {
      const blocks: Record<string, unknown> = {
        hat: {
          opcode: 'event_whenflagclicked',
          next: mode === 'numeric' ? 'a' : 'say',
          parent: null,
          inputs: {},
          fields: {},
          topLevel: true,
        },
        a: {
          opcode: 'data_changevariableby',
          next: 'b',
          parent: mode === 'numeric' ? 'hat' : 'say',
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
      if (mode !== 'numeric')
        blocks.say = {
          opcode: 'looks_say',
          next: mode === 'mixed' ? 'a' : null,
          parent: 'hat',
          inputs: { MESSAGE: [1, [10, 'hello']] },
          fields: {},
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
      return Array.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))
    }
    const page = await browser!.newPage()
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/`)
      const result = await page.evaluate(
        async ([compiled, mixed, fallback]) => {
          const m = await (window as any).createXyoBrowser()
          const h = m._xyo_browser_create()
          if (!h) throw new Error('create failed')
          const check = (ok: number, operation: string) => {
            if (!ok) throw new Error(`${operation}: ${m.UTF8ToString(m._xyo_browser_error(h))}`)
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
          const load = (data: number[]) => {
            const p = m._malloc(data.length)
            if (!p) throw new Error('malloc failed')
            try {
              m.HEAPU8.set(data, p)
              check(m._xyo_browser_load_sb3(h, p, data.length), 'load')
            } finally {
              m._free(p)
            }
          }
          try {
            const capabilities = m._xyo_browser_capabilities()
            const defaultMode = m._xyo_browser_compiled_enabled(h)
            check(m._xyo_browser_set_compiled(h, 1), 'enable')
            load(compiled)
            const initial = stats()
            const before = value()
            check(m._xyo_browser_green_flag(h), 'flag')
            const flagged = stats()
            const flaggedValue = value()
            check(m._xyo_browser_step(h), 'step')
            const stepped = stats()
            const compiledValue = value()
            load(mixed)
            check(m._xyo_browser_green_flag(h), 'mixed flag')
            const mixedFlagged = stats()
            check(m._xyo_browser_step(h), 'mixed step')
            const mixedStepped = stats(),
              mixedValue = value()
            load(fallback)
            check(m._xyo_browser_green_flag(h), 'fallback flag')
            const fallbackFlagged = stats()
            check(m._xyo_browser_step(h), 'fallback step')
            return {
              capabilities,
              defaultMode,
              initial,
              before,
              flagged,
              flaggedValue,
              stepped,
              compiledValue,
              mixedFlagged,
              mixedStepped,
              mixedValue,
              fallbackFlagged,
              fallbackStepped: stats(),
              fallbackValue: value(),
            }
          } finally {
            m._xyo_browser_destroy(h)
          }
        },
        [archive('numeric'), archive('mixed'), archive('unsupported')],
      )
      expect(result.capabilities & 2).toBe(2)
      expect(result.defaultMode).toBe(0)
      expect(result.initial).toEqual([0, 0, 0, 0, 0])
      expect(result.before).toBe(7)
      expect(result.flagged).toEqual([1, 1, 0, 0, 1])
      expect(result.flaggedValue).toBe(7)
      expect(result.stepped).toEqual([1, 1, 1, 0, 0])
      expect(result.compiledValue).toBe(12)
      expect(result.mixedFlagged).toEqual([2, 2, 1, 0, 1])
      expect(result.mixedStepped).toEqual([2, 2, 2, 0, 0])
      expect(result.mixedValue).toBe(12)
      expect(result.fallbackFlagged).toEqual([3, 2, 2, 0, 0])
      expect(result.fallbackStepped).toEqual([3, 2, 2, 1, 0])
      expect(result.fallbackValue).toBe(7)
    } finally {
      await page.close()
    }
  }, 30000)

  it('loads basic.sb3 and runs the flag script in the interpreter', async () => {
    const page = await browser!.newPage()
    try {
      const wasmResponses: number[] = []
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/xyo-browser.wasm')
          wasmResponses.push(response.status())
      })
      await page.goto(`http://127.0.0.1:${server!.port}/`)
      const result = await page.evaluate(async () => {
        let canvasCreates = 0
        let contextRequests = 0
        const createElement = document.createElement.bind(document)
        document.createElement = ((name: string, options?: ElementCreationOptions) => {
          if (name.toLowerCase() === 'canvas') canvasCreates++
          return createElement(name, options)
        }) as typeof document.createElement
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (...args: any[]) {
          contextRequests++
          return (getContext as any).apply(this, args)
        } as typeof HTMLCanvasElement.prototype.getContext
        let offscreenCreates = 0
        if (window.OffscreenCanvas) {
          window.OffscreenCanvas = new Proxy(window.OffscreenCanvas, {
            construct(target, args, newTarget) {
              offscreenCreates++
              return Reflect.construct(target, args, newTarget)
            },
          })
        }
        const m = await (window as any).createXyoBrowser()
        const capabilities = m._xyo_browser_capabilities()
        const h = m._xyo_browser_create()
        if (!h) throw new Error('create failed')
        try {
          const response = await fetch('/basic.sb3')
          if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`)
          const bytes = new Uint8Array(await response.arrayBuffer())
          const ptr = m._malloc(bytes.length)
          if (!ptr) throw new Error('malloc failed')
          try {
            m.HEAPU8.set(bytes, ptr)
            if (!m._xyo_browser_load_sb3(h, ptr, bytes.length))
              throw new Error(m.UTF8ToString(m._xyo_browser_error(h)))
          } finally {
            m._free(ptr)
          }
          const snapshot = () => {
            const ptr = m._xyo_browser_snapshot(h)
            if (!ptr) throw new Error('snapshot failed')
            return JSON.parse(m.UTF8ToString(ptr))
          }
          const before = snapshot()
          if (!m._xyo_browser_green_flag(h)) throw new Error('green flag failed')
          if (!m._xyo_browser_step(h)) throw new Error('step failed')
          return {
            capabilities,
            before,
            after: snapshot(),
            canvasCreates,
            contextRequests,
            offscreenCreates,
            canvasElements: document.querySelectorAll('canvas').length,
          }
        } finally {
          m._xyo_browser_destroy(h)
        }
      })
      expect(wasmResponses).toEqual([200])
      expect([
        result.canvasCreates,
        result.contextRequests,
        result.offscreenCreates,
        result.canvasElements,
      ]).toEqual([0, 0, 0, 0])
      expect(result.capabilities & 1).toBe(1)
      expect(result.capabilities & 2).toBe(2) // limited compiled mode is available; this test uses the interpreter
      const before = result.before.targets.find((target: any) => target.name === 'Sprite1')
      const after = result.after.targets.find((target: any) => target.name === 'Sprite1')
      expect(before).toMatchObject({ x: 0, y: 0, bubbleText: '' })
      expect(after).toMatchObject({ x: 10, y: 0, bubbleText: 'none world' })
      expect(result.after.stepSerial).toBeGreaterThan(result.before.stepSerial)
    } finally {
      await page.close()
    }
  }, 30000)
})
