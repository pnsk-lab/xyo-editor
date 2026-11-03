import { afterEach, describe, expect, it } from 'bun:test'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

const originalWorker = globalThis.Worker

afterEach(() => {
  globalThis.Worker = originalWorker
})

describe('runtime worker canvas replacement', () => {
  it('does not create a worker or transfer a canvas for an unsupported backend', () => {
    let transfers = 0
    const canvas = {
      transferControlToOffscreen: () => {
        transfers++
        return {}
      },
    }
    const controller = new RuntimeWorkerController(
      {} as never,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )
    expect(controller.attachCanvas(canvas as never, {} as never)).toBe(false)
    expect(transfers).toBe(0)
    controller.dispose()
  })

  it('filters stale question events and forwards answers to the worker', async () => {
    const messages: any[] = [],
      questions: unknown[] = []
    let worker!: FakeWorker
    class FakeWorker {
      onmessage?: (event: { data: unknown }) => void
      constructor() {
        worker = this
      }
      postMessage(message: unknown) {
        messages.push(message)
      }
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const snapshot = { project: { targets: [] } }
    const vm = { exportAssetBytes: () => ({}), lightweightSnapshot: () => snapshot }
    const canvas = { width: 480, height: 360, transferControlToOffscreen: () => ({}) }
    const controller = new RuntimeWorkerController(
      vm as never,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      (payload) => questions.push(payload),
    )
    controller.attachCanvas(canvas as never, snapshot as never)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    worker.onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot, syncId: 1 } })
    worker.onmessage!({
      data: { type: 'question', payload: { question: 'old' }, syncId: 1, resetId: 0 },
    })
    controller.stopAll()
    worker.onmessage!({
      data: { type: 'question', payload: { question: 'stale' }, syncId: 99, resetId: 0 },
    })
    controller.greenFlag()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const flag = messages.find((m) => m.type === 'greenFlag')
    worker.onmessage!({
      data: {
        type: 'question',
        payload: { question: '' },
        syncId: flag.syncId,
        resetId: flag.syncId,
      },
    })
    controller.answerPrompt('')
    expect(questions).toEqual([{ question: 'old' }, { question: '' }])
    expect(messages.find((m) => m.type === 'answerPrompt')?.value).toBe('')
    controller.dispose()
  })

  it('reattaches a replaced canvas after initialization without restarting the worker', async () => {
    const messages: Array<{ type: string; canvas?: object }> = []
    let workers = 0
    class FakeWorker {
      onmessage?: (event: unknown) => void
      constructor() {
        workers++
      }
      postMessage(message: { type: string; canvas?: object }) {
        messages.push(message)
      }
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const vm = { exportAssetBytes: () => ({}) }
    const snapshot = { project: { targets: [] } }
    const firstOffscreen = {}
    const nextOffscreen = {}
    const first = { width: 480, height: 360, transferControlToOffscreen: () => firstOffscreen }
    let transfers = 0
    const next = {
      width: 480,
      height: 360,
      transferControlToOffscreen: () => {
        transfers++
        return nextOffscreen
      },
    }
    const controller = new RuntimeWorkerController(vm as never, () => {})

    expect(controller.attachCanvas(first as never, snapshot as never)).toBe(true)
    expect(controller.attachCanvas(next as never, snapshot as never)).toBe(true)
    expect(controller.attachCanvas(next as never, snapshot as never)).toBe(true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(workers).toBe(1)
    expect(transfers).toBe(1)
    expect(messages.filter((message) => message.type === 'init')[0]?.canvas).toBe(firstOffscreen)
    expect(messages.filter((message) => message.type === 'attachCanvas')[0]?.canvas).toBe(
      nextOffscreen,
    )
    expect(messages.findIndex((message) => message.type === 'init')).toBeLessThan(
      messages.findIndex((message) => message.type === 'attachCanvas'),
    )
    controller.dispose()
  })
})
