import { describe, expect, test } from 'bun:test'
import { createXyoWorkerHost } from '../src/lib/xyo-worker-host'
import type {
  XyoAudioCommand,
  XyoWorkerRequest,
  XyoWorkerResponse,
  XyoWorkerRuntime,
} from '../src/lib/xyo-worker-protocol'

function setup(failReply = false) {
  const queue: XyoAudioCommand[] = [],
    sent: XyoWorkerResponse[] = [],
    calls: string[] = []
  const runtime: XyoWorkerRuntime = {
    loadSb3() {},
    greenFlagCompiled() {},
    greenFlagInterpreter() {},
    step() {},
    stop() {
      calls.push('stop')
    },
    key() {},
    mouse() {},
    wheel() {},
    answer() {},
    snapshot() {},
    compileStats: {},
    supportsCompiledExecution: true,
    dispose() {
      calls.push('dispose')
    },
    audio: {
      open() {
        queue.push({ type: 'open', generation: 7 })
      },
      drain() {
        return queue.splice(0)
      },
      reply() {
        calls.push('reply')
        if (failReply) {
          failReply = false
          throw Error('bad ACK')
        }
      },
      tick() {},
      close() {},
    },
  }
  const handle = createXyoWorkerHost(
    () => runtime,
    (message) => sent.push(message),
  )
  const send = async (id: number, operation: XyoWorkerRequest['operation']) => {
    handle({ id, generation: 0, operation })
    while (!sent.some((r) => r.id === id)) await Promise.resolve()
  }
  return { send, sent, calls }
}

describe('worker audio host contract', () => {
  test('opens after flag and refuses lifecycle before cancellation ACK', async () => {
    const f = setup()
    await f.send(1, { type: 'flag', compiled: true, audioEnabled: true })
    expect(f.sent.find((r) => r.id === 0 && r.ok)?.value).toEqual({
      audio: { type: 'open', generation: 7 },
    })
    await f.send(2, { type: 'stop' })
    expect(f.sent.find((r) => r.id === 2)?.ok).toBe(false)
    expect(f.calls).not.toContain('stop')
    await f.send(3, { type: 'audioReply', reply: { type: 'cancelAck', generation: 7, ok: true } })
    await f.send(4, { type: 'dispose' })
    expect(f.calls).toEqual(['reply', 'dispose'])
  })
  test('successful cancel ACK stops idle heartbeat and allows another flag', async () => {
    const originalSet = globalThis.setTimeout,
      originalClear = globalThis.clearTimeout
    const timers = new Map<number, () => void>()
    let next = 0
    globalThis.setTimeout = ((fn: () => void) => {
      const id = ++next
      timers.set(id, fn)
      return id
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id)
    }) as typeof clearTimeout
    try {
      const f = setup()
      await f.send(1, { type: 'flag', compiled: true, audioEnabled: true })
      expect(timers.size).toBe(1)
      await f.send(2, { type: 'audioReply', reply: { type: 'cancelAck', generation: 7, ok: true } })
      expect(timers.size).toBe(0)
      await f.send(3, { type: 'flag', compiled: true, audioEnabled: true })
      expect(f.sent.find((r) => r.id === 3)?.ok).toBe(true)
      expect(timers.size).toBe(1)
      await f.send(4, { type: 'audioReply', reply: { type: 'cancelAck', generation: 7, ok: true } })
      expect(timers.size).toBe(0)
      await f.send(5, { type: 'dispose' })
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
  test('reply exception reports fatal transport failure', async () => {
    const f = setup(true)
    await f.send(1, { type: 'flag', compiled: true, audioEnabled: true })
    await f.send(2, {
      type: 'audioReply',
      reply: { type: 'stopAck', generation: 7, id: 1n, ok: false },
    })
    expect(f.sent.some((r) => r.id === 0 && !r.ok && r.error.includes('bad ACK'))).toBe(true)
    await f.send(3, { type: 'audioReply', reply: { type: 'cancelAck', generation: 7, ok: true } })
    await f.send(4, { type: 'dispose' })
  })
  test('audio disabled leaves flag headless', async () => {
    const f = setup()
    await f.send(1, { type: 'flag', compiled: false })
    expect(f.sent.some((r) => r.id === 0)).toBe(false)
    await f.send(2, { type: 'dispose' })
  })
})
