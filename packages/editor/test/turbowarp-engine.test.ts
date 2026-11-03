import { afterEach, expect, test } from 'bun:test'
import { createTurboWarpEngine, createTurboWarpEngineVM } from '../src/lib/turbowarp-engine'
import { createTurboWarpRenderer } from '../src/lib/turbowarp-renderer'
import type { TurboWarpScaffoldingNamespace } from '../src/lib/turbowarp-adapter'
import { chromium } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

const originals = {
  canvas: globalThis.HTMLCanvasElement,
  window: globalThis.window,
  navigator: globalThis.navigator,
}
class Canvas {}
const calls: string[] = []
class VM {
  setCompatibilityMode(value: boolean) {
    calls.push(`compat:${value}`)
  }
  setLocale(locale: string) {
    calls.push(`locale:${locale}`)
    return Promise.resolve()
  }
  setStageSize(w: number, h: number) {
    calls.push(`stage:${w}x${h}`)
  }
  attachRenderer(renderer: Renderer) {
    calls.push('renderer')
    expect(renderer.canvas).toBe(canvas)
  }
  attachStorage(_storage: Storage) {
    calls.push('storage')
  }
  attachAudioEngine(_audio: Audio) {
    calls.push('audio')
  }
  stopAll() {
    calls.push('stop')
  }
  clear() {
    calls.push('clear')
  }
  quit() {
    calls.push('quit')
  }
}
let canvas: HTMLCanvasElement
class Renderer {
  gl = { getExtension: () => ({ loseContext: () => calls.push('lose') }) }
  constructor(
    public canvas: HTMLCanvasElement,
    ...bounds: number[]
  ) {
    calls.push(`bounds:${bounds.join(',')}`)
  }
}
class Storage {
  constructor() {
    calls.push('new storage')
  }
}
class Audio {
  audioContext = {
    state: 'running',
    close: async () => {
      calls.push('close')
    },
  }
  constructor() {
    calls.push('new audio')
  }
}
const namespace = {
  VM,
  Renderer,
  Storage,
  AudioEngine: Audio,
} as unknown as TurboWarpScaffoldingNamespace
function setup(audio = true) {
  calls.length = 0
  globalThis.HTMLCanvasElement = Canvas as unknown as typeof HTMLCanvasElement
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: audio ? { AudioContext: class {} } : {},
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'ja' } })
  canvas = new Canvas() as unknown as HTMLCanvasElement
}
afterEach(() => {
  globalThis.HTMLCanvasElement = originals.canvas
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originals.window })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originals.navigator })
})

test('connects official components in order on the provided canvas and disposes once', async () => {
  setup()
  const engine = createTurboWarpEngine(namespace, canvas)
  expect(calls).toEqual([
    'compat:true',
    'locale:ja',
    'stage:480x360',
    'bounds:-240,240,-180,180',
    'renderer',
    'new storage',
    'storage',
    'new audio',
    'audio',
  ])
  expect(engine.renderer.canvas).toBe(canvas)
  await Promise.all([engine.dispose(), engine.dispose()])
  expect(calls.slice(-5)).toEqual(['stop', 'clear', 'quit', 'lose', 'close'])
})

test('accepts a VM created before the canvas and transfers ownership', async () => {
  setup()
  const vm = createTurboWarpEngineVM(namespace)
  expect(calls).toEqual([])
  const engine = createTurboWarpEngine(namespace, canvas, vm)
  expect(engine.vm).toBe(vm)
  await engine.dispose()
  expect(calls.slice(-5)).toEqual(['stop', 'clear', 'quit', 'lose', 'close'])
})

test('renderer adapter borrows the VM renderer without taking ownership', async () => {
  setup()
  const engine = createTurboWarpEngine(namespace, canvas)
  let borrowed: unknown
  const adapter = createTurboWarpRenderer(engine.Renderer, {
    syncSnapshot: (renderer) => {
      borrowed = renderer
    },
    getTargets: () => [],
  })
  adapter.attachCanvas(canvas)
  expect(new engine.Renderer(canvas)).toBe(engine.renderer)
  expect(() => new engine.Renderer(new Canvas() as unknown as HTMLCanvasElement)).toThrow(
    'another canvas',
  )
  expect(calls.filter((call) => call.startsWith('bounds:'))).toHaveLength(1)
  adapter.dispose()
  expect(calls).not.toContain('lose')
  await engine.dispose()
  expect(() => new engine.Renderer(canvas)).toThrow('disposed')
  expect(borrowed).toBeUndefined()
})

test('allows browsers without audio and preserves WebGL constructor errors', async () => {
  setup(false)
  const engine = createTurboWarpEngine(namespace, canvas)
  expect(engine.audioEngine).toBeUndefined()
  await engine.dispose()
  const failure = new Error('Could not get WebGL context')
  const broken = {
    ...namespace,
    Renderer: class {
      constructor() {
        throw failure
      }
    },
  } as unknown as TurboWarpScaffoldingNamespace
  expect(() => createTurboWarpEngine(broken, canvas)).toThrow(failure)
  expect(calls.slice(-3)).toEqual(['stop', 'clear', 'quit'])
})

const browserTest = process.env.TURBOWARP_CDN_TEST === '1' ? test : test.skip
browserTest(
  'official browser VM accepts a canvas later and runs an embedded SB3',
  async () => {
    const build = await Bun.build({
      entrypoints: [new URL('../src/lib/turbowarp-engine.ts', import.meta.url).pathname],
      target: 'browser',
    })
    if (!build.success) throw new Error(String(build.logs))
    const bundle = await build.outputs[0]!.text()
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        return new URL(req.url).pathname === '/engine.js'
          ? new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
          : new Response('<!doctype html><html><head></head><body></body></html>', {
              headers: { 'content-type': 'text/html' },
            })
      },
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await launchBrowser({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${server.port}/`)
      await page.addScriptTag({
        url: 'https://cdn.jsdelivr.net/npm/@turbowarp/packager@3.14.0/dist/scaffolding/scaffolding-full.js',
      })
      const costume = {
        name: 'c',
        assetId: '12345678901234567890123456789012',
        md5ext: '12345678901234567890123456789012.svg',
        dataFormat: 'svg',
        rotationCenterX: 5,
        rotationCenterY: 5,
      }
      const project = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [costume],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
          },
          {
            isStage: false,
            name: 'Sprite1',
            variables: {},
            lists: {},
            broadcasts: {},
            blocks: {
              flag: {
                opcode: 'event_whenflagclicked',
                next: 'move',
                parent: null,
                inputs: {},
                fields: {},
                shadow: false,
                topLevel: true,
                x: 0,
                y: 0,
              },
              move: {
                opcode: 'motion_changexby',
                next: null,
                parent: 'flag',
                inputs: { DX: [1, [4, '25']] },
                fields: {},
                shadow: false,
                topLevel: false,
              },
            },
            comments: {},
            currentCostume: 0,
            costumes: [costume],
            sounds: [],
            volume: 100,
            layerOrder: 1,
            visible: true,
            x: 0,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: 'all around',
          },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' },
      }
      const sb3 = zipSync({
        'project.json': strToU8(JSON.stringify(project)),
        [costume.md5ext]: strToU8(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
        ),
      })
      const result = await page.evaluate(async (bytes) => {
        const { createTurboWarpEngine, createTurboWarpEngineVM } = await import('/engine.js')
        const ns = (window as any).Scaffolding
        const vm = createTurboWarpEngineVM(ns)
        const canvas = document.createElement('canvas')
        document.body.append(canvas)
        const engine = createTurboWarpEngine(ns, canvas, vm)
        await vm.loadProject(new Uint8Array(bytes))
        vm.start()
        vm.greenFlag()
        const deadline = Date.now() + 10000
        while (
          vm.runtime.targets.find((target: any) => !target.isStage)?.x !== 25 &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 50))
        const result = {
          sameVM: engine.vm === vm,
          sameCanvas: engine.renderer.canvas === canvas,
          sameRenderer: vm.runtime.renderer === engine.renderer,
          x: vm.runtime.targets.find((target: any) => !target.isStage)?.x,
          assets: vm.assets.length,
        }
        await engine.dispose()
        return result
      }, Array.from(sb3))
      expect(result).toEqual({
        sameVM: true,
        sameCanvas: true,
        sameRenderer: true,
        x: 25,
        assets: 2,
      })
    } finally {
      await browser?.close()
      server.stop(true)
    }
  },
  60000,
)

test('cleans all resources even if cleanup fails', async () => {
  setup()
  class BrokenVM extends VM {
    clear() {
      super.clear()
      throw new Error('clear failed')
    }
  }
  const engine = createTurboWarpEngine(
    { ...namespace, VM: BrokenVM } as unknown as TurboWarpScaffoldingNamespace,
    canvas,
  )
  await expect(engine.dispose()).rejects.toThrow('Failed to dispose')
  expect(calls.slice(-5)).toEqual(['stop', 'clear', 'quit', 'lose', 'close'])
})
