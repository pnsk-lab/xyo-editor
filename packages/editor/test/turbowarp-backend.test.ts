import { afterEach, expect, test } from 'bun:test'
import { createTurboWarpBackend } from '../src/lib/turbowarp-backend'
import type { TurboWarpScaffoldingNamespace } from '../src/lib/turbowarp-adapter'

const old = {
  canvas: globalThis.HTMLCanvasElement,
  window: globalThis.window,
  navigator: globalThis.navigator,
  raf: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
}
const calls: string[] = []
class Canvas {
  clientWidth = 480
  clientHeight = 360
}
class VM {
  static latest: VM
  constructor() {
    VM.latest = this
  }
  runtime: { targets: unknown[] } = { targets: [] }
  setCompatibilityMode() {}
  setLocale() {
    return Promise.resolve()
  }
  setStageSize() {}
  attachRenderer(r: Renderer) {
    calls.push('attach')
    expect(r.canvas).toBe(canvas)
  }
  attachStorage() {}
  start() {
    calls.push('start')
  }
  stopAll() {}
  clear() {
    calls.push('clear')
  }
  quit() {
    calls.push('quit')
  }
  setTurboMode() {}
  postIOData() {}
  greenFlag() {}
  on() {}
  removeListener() {}
  async loadProject() {
    calls.push('load')
  }
}
class Renderer {
  gl = { getExtension: () => ({ loseContext: () => calls.push('lose') }) }
  constructor(public canvas: HTMLCanvasElement) {
    calls.push('renderer')
  }
  draw() {
    calls.push('draw')
  }
  resize() {}
  pick(_x: number, _y: number, _w: number, _h: number, candidates: number[]) {
    calls.push(`pick:${candidates.join(',')}`)
    return candidates[0] ?? -1
  }
  getBounds() {
    return null
  }
  getFencedPositionOfDrawable(id: number, p: [number, number]) {
    calls.push(`fence:${id}`)
    return p
  }
}
const namespace = {
  VM,
  Renderer,
  Storage: class {},
  AudioEngine: class {},
} as unknown as TurboWarpScaffoldingNamespace
let canvas: HTMLCanvasElement
function setup() {
  calls.length = 0
  globalThis.HTMLCanvasElement = Canvas as unknown as typeof HTMLCanvasElement
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en' } })
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  canvas = new Canvas() as unknown as HTMLCanvasElement
}
afterEach(() => {
  globalThis.HTMLCanvasElement = old.canvas
  Object.defineProperty(globalThis, 'window', { configurable: true, value: old.window })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: old.navigator })
  globalThis.requestAnimationFrame = old.raf
  globalThis.cancelAnimationFrame = old.cancel
})
test('creates one shared renderer lazily and releases ownership once', async () => {
  setup()
  const backend = createTurboWarpBackend(namespace)
  expect(calls).toEqual([])
  backend.renderer.attachCanvas(canvas)
  backend.renderer.attachCanvas(canvas)
  backend.renderer.requestDraw(backend.vm.snapshot())
  expect(calls.filter((x) => x === 'renderer')).toHaveLength(1)
  expect(calls).toContain('attach')
  expect(calls).toContain('draw')
  await Promise.all([backend.dispose!(), backend.dispose!()])
  expect(calls.filter((x) => x === 'quit')).toHaveLength(1)
  expect(calls.filter((x) => x === 'lose')).toHaveLength(1)
})
test('syncs the initial project and coalesces edits', async () => {
  setup()
  const backend = createTurboWarpBackend(namespace)
  const synced = () =>
    new Promise<void>((resolve) => {
      const off = backend.vm.on('TURBOWARP_PROJECT_SYNCED', () => {
        off()
        resolve()
      })
    })
  const initial = synced()
  backend.renderer.attachCanvas(canvas)
  await initial
  expect(calls.filter((x) => x === 'load')).toHaveLength(1)
  const edited = synced()
  backend.vm.emit('PROJECT_CHANGED', {})
  backend.vm.emit('PROJECT_CHANGED', {})
  await edited
  expect(calls.filter((x) => x === 'load')).toHaveLength(2)
  await backend.dispose!()
})
test('maps picked and fenced originals to editor IDs and retains clone IDs', async () => {
  setup()
  const backend = createTurboWarpBackend(namespace)
  const original = backend.vm.snapshot().project.targets.find((t) => !t.isStage)!
  const sprite = { name: original.name, costumes: [], sounds: [] }
  VM.latest.runtime.targets.push(
    {
      id: 'tw-original',
      isOriginal: true,
      isStage: false,
      sprite,
      drawableID: 42,
      variables: {},
      blocks: { _blocks: {} },
    },
    {
      id: 'tw-clone',
      isOriginal: false,
      isStage: false,
      sprite,
      drawableID: 43,
      variables: {},
      blocks: { _blocks: {} },
    },
    {
      id: 'unknown',
      isOriginal: true,
      isStage: false,
      sprite: { ...sprite, name: 'unknown' },
      drawableID: 44,
      variables: {},
      blocks: { _blocks: {} },
    },
  )
  const synced = new Promise<void>((resolve) => {
    const off = backend.vm.on('TURBOWARP_PROJECT_SYNCED', () => {
      off()
      resolve()
    })
  })
  backend.renderer.attachCanvas(canvas)
  expect(backend.renderer.pick(0, 0)).toBeNull()
  await synced
  expect(backend.renderer.pick(0, 0, 1, 1, [original.id!])).toBe(original.id!)
  expect(backend.renderer.pick(0, 0, 1, 1, ['tw-clone'])).toBe('tw-clone')
  expect(backend.renderer.pick(0, 0, 1, 1, ['unknown'])).toBeNull()
  expect(backend.renderer.getFencedPositionOfDrawable(original.id!, [1, 2])).toEqual([1, 2])
  expect(calls).toContain('fence:42')
  expect(backend.renderer.getFencedPositionOfDrawable('tw-clone', [3, 4])).toEqual([3, 4])
  expect(calls).toContain('fence:43')
  expect(backend.renderer.getFencedPositionOfDrawable('unknown', [0, 0])).toEqual([0, 0])
  await backend.dispose!()
})
test('disposes an unattached VM, including when constructor validation fails', async () => {
  setup()
  const backend = createTurboWarpBackend({
    ...namespace,
    Renderer: undefined,
  } as unknown as TurboWarpScaffoldingNamespace)
  expect(() => backend.renderer.attachCanvas(canvas)).toThrow('Renderer')
  await backend.dispose!()
  expect(calls.filter((x) => x === 'quit')).toHaveLength(1)
})
