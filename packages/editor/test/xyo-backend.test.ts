import { describe, expect, test } from 'bun:test'
import { createXyoBackend, createXyoWorkerEngine } from '../src/lib/xyo-backend'
import { XyoWorkerClient, type XyoWorkerPort } from '../src/lib/xyo-worker-client'
import { RuntimeBackendRegistry } from '../src/lib/runtime-backends'
import { registerXyoBackend } from '../src/lib/register-xyo'
import type { XyoWorkerRequest } from '../src/lib/xyo-worker-protocol'

const blocked = Symbol('blocked')
function port(handler: (request: XyoWorkerRequest) => unknown) {
  let listener: ((event: any) => void) | undefined
  let terminated = false
  const calls: XyoWorkerRequest[] = []
  const worker: XyoWorkerPort = {
    postMessage(request) {
      calls.push(request)
      queueMicrotask(() => {
        const value = handler(request)
        if (value !== blocked)
          listener?.({ data: { id: request.id, generation: request.generation, ok: true, value } })
      })
    },
    terminate() {
      terminated = true
    },
    addEventListener(type, fn) {
      if (type === 'message') listener = fn
    },
    removeEventListener(type) {
      if (type === 'message') listener = undefined
    },
  }
  return { worker, calls, isTerminated: () => terminated }
}

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(predicate()).toBe(true)
}

describe('experimental xyo backend', () => {
  test('registers the experimental backend and fails closed without artifacts', async () => {
    const registry = new RuntimeBackendRegistry()
    registerXyoBackend(registry)
    expect(registry.getSelectedId(undefined)).toBe('scratch')
    expect(registry.list()[1].label).toContain('LLVM')
    expect(registry.list()[1].label).toContain('実験的')
    // Without served artifacts (headless here) load rejects instead of
    // starting any xyo-cpp worker; load failures are not cached.
    await expect(registry.create('xyo-cpp')).rejects.toThrow('アーティファクト')
    await expect(registry.create('xyo-cpp')).rejects.toThrow('アーティファクト')
  })
  test('uses compiled flag and retrieves asynchronous stats', async () => {
    const p = port((request) =>
      request.operation.type === 'stats' ? { compileStats: { fallbacks: 2 } } : undefined,
    )
    const engine = createXyoWorkerEngine(new XyoWorkerClient(() => p.worker))
    await engine.greenFlagCompiled()
    expect(p.calls[0].operation).toEqual({ type: 'flag', compiled: true })
    expect(await engine.stats?.()).toEqual({ compileStats: { fallbacks: 2 } })
    await engine.dispose()
    expect(p.isTerminated()).toBe(true)
  })
  test('schedules serialized frames, draws, and interrupts on stop', async () => {
    let backend: ReturnType<typeof createXyoBackend>
    let steps = 0
    const p = port((request) => {
      if (request.operation.type === 'stats') return { compileStats: { fallbacks: 0 } }
      if (request.operation.type === 'step') steps++
      if (request.operation.type === 'snapshot')
        return {
          threadCount: 1,
          stepSerial: steps,
          targets: backend.vm.snapshot().project.targets.map((t, i) => ({
            id: `xyo-${i}`,
            name: t.name,
            isStage: t.isStage,
            isOriginal: true,
            x: t.x ?? 0,
            y: t.y ?? 0,
            direction: t.direction ?? 90,
            size: t.size ?? 100,
            visible: t.visible ?? true,
            currentCostume: t.currentCostume ?? 0,
            layerOrder: t.layerOrder ?? 0,
            bubbleText: '',
            bubbleType: '',
            variables: Object.fromEntries([
              ...Object.entries(t.variables).map(([id, [name, value]]) => [
                id,
                { name, type: '', value },
              ]),
              ...Object.entries(t.lists).map(([id, [name, value]]) => [
                id,
                { name, type: 'list', value },
              ]),
            ]),
          })),
        }
    })
    backend = createXyoBackend(() => p.worker)
    let draws = 0
    backend.renderer.requestDraw = () => {
      draws++
    }
    backend.vm.greenFlag()
    await until(() => steps > 0 && draws > 0)
    expect(draws).toBeGreaterThan(0)
    expect(p.calls.some((c) => c.operation.type === 'flag' && c.operation.compiled)).toBe(true)
    backend.vm.stopAll()
    expect(p.isTerminated()).toBe(true)
    await backend.dispose?.()
  })
  test('stop interrupts a blocked compile and a new flag uses a fresh worker', async () => {
    const first = port((request) =>
      request.operation.type === 'flag'
        ? blocked
        : request.operation.type === 'stats'
          ? { compileStats: { fallbacks: 0 } }
          : undefined,
    )
    const second = port((request) =>
      request.operation.type === 'flag'
        ? blocked
        : request.operation.type === 'stats'
          ? { compileStats: { fallbacks: 0 } }
          : undefined,
    )
    let factories = 0
    const backend = createXyoBackend(() => (++factories === 1 ? first.worker : second.worker))
    const errors: string[] = []
    backend.vm.on('ERROR', (event) => errors.push((event as { message: string }).message))
    backend.vm.greenFlag()
    await until(() => first.calls.some((call) => call.operation.type === 'flag'))
    backend.vm.stopAll()
    expect(first.isTerminated()).toBe(true)
    backend.vm.greenFlag()
    await until(() => second.calls.some((call) => call.operation.type === 'flag'))
    expect(factories).toBe(2)
    expect(errors.some((error) => /terminated|interrupt|stale/i.test(error))).toBe(false)
    await backend.dispose?.()
    expect(second.isTerminated()).toBe(true)
  })
  test('uses and cancels requestAnimationFrame when available', async () => {
    const previousRequest = globalThis.requestAnimationFrame
    const previousCancel = globalThis.cancelAnimationFrame
    let requested = 0,
      cancelled = 0
    globalThis.requestAnimationFrame = () => {
      requested++
      return 42
    }
    globalThis.cancelAnimationFrame = (id) => {
      cancelled = id
    }
    try {
      const backend = createXyoBackend(() => {
        throw new Error('unused')
      })
      backend.vm.emit('PROJECT_RUN_START', backend.vm.snapshot())
      expect(requested).toBe(1)
      await backend.dispose?.()
      expect(cancelled).toBe(42)
    } finally {
      globalThis.requestAnimationFrame = previousRequest
      globalThis.cancelAnimationFrame = previousCancel
    }
  })
  test('surfaces worker startup failures', async () => {
    const backend = createXyoBackend(() => {
      throw new Error('missing WASM')
    })
    const messages: string[] = []
    backend.vm.on('ERROR', (value) => messages.push((value as { message: string }).message))
    backend.vm.greenFlag()
    await until(() => messages.some((message) => message.includes('missing WASM')))
    await backend.dispose?.()
  })
})
