import { afterEach, describe, expect, it } from 'bun:test'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

const originalWorker = globalThis.Worker

afterEach(() => { globalThis.Worker = originalWorker })

describe('runtime worker canvas replacement', () => {
  it('reattaches a replaced canvas after initialization without restarting the worker', async () => {
    const messages: Array<{ type: string; canvas?: object }> = []
    let workers = 0
    class FakeWorker {
      onmessage?: (event: unknown) => void
      constructor() { workers++ }
      postMessage(message: { type: string; canvas?: object }) { messages.push(message) }
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const vm = { exportAssetBytes: () => ({}) }
    const snapshot = { project: { targets: [] } }
    const firstOffscreen = {}
    const nextOffscreen = {}
    const first = { width: 480, height: 360, transferControlToOffscreen: () => firstOffscreen }
    let transfers = 0
    const next = { width: 480, height: 360, transferControlToOffscreen: () => { transfers++; return nextOffscreen } }
    const controller = new RuntimeWorkerController(vm as never, () => {})

    expect(controller.attachCanvas(first as never, snapshot as never)).toBe(true)
    expect(controller.attachCanvas(next as never, snapshot as never)).toBe(true)
    expect(controller.attachCanvas(next as never, snapshot as never)).toBe(true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(workers).toBe(1)
    expect(transfers).toBe(1)
    expect(messages.filter((message) => message.type === 'init')[0]?.canvas).toBe(firstOffscreen)
    expect(messages.filter((message) => message.type === 'attachCanvas')[0]?.canvas).toBe(nextOffscreen)
    expect(messages.findIndex((message) => message.type === 'init')).toBeLessThan(messages.findIndex((message) => message.type === 'attachCanvas'))
    controller.dispose()
  })
})
