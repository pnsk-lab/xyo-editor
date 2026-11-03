import { afterEach, describe, expect, test } from 'bun:test'
import { createTurboWarpRenderer, type TurboWarpRenderer } from '../src/lib/turbowarp-renderer'

const originalCanvas = globalThis.HTMLCanvasElement
class Canvas {
  clientWidth = 960
  clientHeight = 540
}
class Renderer implements TurboWarpRenderer {
  static instances: Renderer[] = []
  canvas: HTMLCanvasElement
  calls: unknown[][] = []
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    Renderer.instances.push(this)
  }
  draw() {
    this.calls.push(['draw'])
  }
  resize(width: number, height: number) {
    this.calls.push(['resize', width, height])
  }
  pick(...args: [number, number, number?, number?, number[]?]) {
    this.calls.push(['pick', ...args])
    return 7
  }
  getBounds(id: number) {
    this.calls.push(['bounds', id])
    return { left: -4, right: 6, top: 9, bottom: -1 }
  }
  getFencedPositionOfDrawable(id: number, position: [number, number]): [number, number] {
    this.calls.push(['fence', id, position])
    return [2, 3]
  }
}

afterEach(() => {
  globalThis.HTMLCanvasElement = originalCanvas
  Renderer.instances = []
})

describe('TurboWarp renderer adapter', () => {
  test('defers WebGL construction, maps Scratch coordinates and target IDs', () => {
    globalThis.HTMLCanvasElement = Canvas as unknown as typeof HTMLCanvasElement
    const canvas = new Canvas() as unknown as HTMLCanvasElement
    let syncs = 0
    let releases = 0
    const targets = [
      { targetId: 'stage', drawableId: 1, isStage: true },
      { targetId: 'sprite', drawableId: 7 },
    ]
    const adapter = createTurboWarpRenderer(Renderer, {
      getTargets: () => targets,
      syncSnapshot: () => {
        syncs++
      },
      dispose: () => {
        releases++
      },
    })
    expect(Renderer.instances).toHaveLength(0)
    adapter.attachCanvas(canvas)
    adapter.attachCanvas(canvas)
    expect(Renderer.instances).toHaveLength(1)
    const r = Renderer.instances[0]!
    adapter.requestDraw({} as never)
    expect(syncs).toBe(1)
    expect(r.calls[0]).toEqual(['draw'])
    expect(adapter.pick(120, 60, 4, 6)).toBe('sprite')
    expect(r.calls[1]).toEqual(['pick', 720, 180, 8, 9, [7]])
    expect(adapter.pick(0, 0, 1, 1, ['missing'])).toBeNull()
    expect(adapter.getBounds?.('sprite')).toEqual({
      left: -4,
      right: 6,
      top: 9,
      bottom: -1,
      width: 10,
      height: 10,
    })
    expect(adapter.getFencedPositionOfDrawable('sprite', [10, 20])).toEqual([2, 3])
    expect(r.calls.at(-1)).toEqual(['fence', 7, [10, 20]])
    targets[1]!.drawableId = 8
    expect(adapter.pick(0, 0)).toBeNull()
    expect(adapter.getFencedPositionOfDrawable('missing', [0, 0])).toEqual([0, 0])
    expect(() => adapter.attachCanvas(new Canvas() as unknown as HTMLCanvasElement)).toThrow()
    expect(() => adapter.clearCachedCostumes()).toThrow()
    adapter.dispose()
    adapter.dispose()
    expect(releases).toBe(1)
    expect(() => adapter.pick(0, 0)).toThrow()
  })

  test('rejects unsupported canvas and invisible layout', () => {
    globalThis.HTMLCanvasElement = Canvas as unknown as typeof HTMLCanvasElement
    const adapter = createTurboWarpRenderer(Renderer, {
      getTargets: () => [],
      syncSnapshot: () => {},
    })
    expect(() => adapter.attachCanvas({} as OffscreenCanvas)).toThrow('OffscreenCanvas')
    const canvas = new Canvas()
    canvas.clientWidth = 0
    adapter.attachCanvas(canvas as unknown as HTMLCanvasElement)
    expect(() => adapter.pick(0, 0)).toThrow('nonzero CSS dimensions')
  })
})
