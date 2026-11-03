import { describe, expect, test } from 'bun:test'
import { XyoWorkerClient, type XyoWorkerPort } from '../src/lib/xyo-worker-client'
import type { XyoAudioCommand, XyoWorkerRequest } from '../src/lib/xyo-worker-protocol'
import type { XyoAudioContext } from '../src/lib/xyo-worker-client'

function fixture(
  options: { failStop?: boolean; failResume?: boolean; pendingResume?: boolean } = {},
) {
  const listeners = new Map<string, (event: any) => void>()
  const requests: XyoWorkerRequest[] = []
  let terminated = false,
    starts = 0,
    stops = 0
  let decode!: (value: AudioBuffer) => void
  const resumeResolvers: (() => void)[] = []
  let decodes = 0
  const gains: Array<{ value: number }> = []
  const pans: Array<{ value: number }> = []
  const source = {
    playbackRate: { value: 1 },
    buffer: null,
    onended: null,
    connect() {},
    disconnect() {},
    start() {
      starts++
    },
    stop() {
      stops++
      if (options.failStop) throw Error('stop')
    },
  }
  let stateListener: (() => void) | undefined
  const context = {
    destination: {},
    state: options.failResume || options.pendingResume ? 'suspended' : 'running',
    addEventListener(_type: string, listener: () => void) {
      stateListener = listener
    },
    removeEventListener() {
      stateListener = undefined
    },
    resume: () =>
      options.pendingResume
        ? new Promise<void>((resolve) => {
            resumeResolvers.push(resolve)
          })
        : options.failResume
          ? Promise.reject(Error('autoplay'))
          : Promise.resolve(),
    decodeAudioData: () => {
      decodes++
      return new Promise<AudioBuffer>((resolve) => {
        decode = resolve
      })
    },
    createBufferSource: () => source,
    createStereoPanner: () => {
      const pan = { value: 0 }
      pans.push(pan)
      return { pan, connect() {}, disconnect() {} }
    },
    createGain: () => {
      const gain = { value: 0 }
      gains.push(gain)
      return { gain, connect() {}, disconnect() {} }
    },
  } as unknown as XyoAudioContext
  const port: XyoWorkerPort = {
    postMessage(request) {
      requests.push(request)
      queueMicrotask(() =>
        listeners.get('message')?.({
          data: { id: request.id, generation: request.generation, ok: true },
        }),
      )
    },
    terminate() {
      terminated = true
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
  }
  const client = new XyoWorkerClient(() => port, context)
  const emit = (audio: XyoAudioCommand, generation = 0) =>
    listeners.get('message')?.({ data: { id: 0, generation, ok: true, value: { audio } } })
  const replies = () =>
    requests.flatMap((r) => (r.operation.type === 'audioReply' ? [r.operation.reply] : []))
  return {
    client,
    emit,
    replies,
    listeners,
    gains,
    pans,
    source,
    resume: (index = 0) => resumeResolvers[index](),
    resumeCount: () => resumeResolvers.length,
    decodes: () => decodes,
    state: (value: string) => {
      ;(context as { state: string }).state = value
      stateListener?.()
    },
    decode: () => decode({} as AudioBuffer),
    starts: () => starts,
    stops: () => stops,
    terminated: () => terminated,
  }
}
const open = { type: 'open', generation: 1 } as const
const start = {
  type: 'start',
  generation: 1,
  id: 1n,
  bytes: new ArrayBuffer(1),
  volume: 1,
  pitch: 0,
  pan: 0,
} as const
const stop = { type: 'stop', generation: 1, id: 1n } as const

describe('worker audio transport', () => {
  test('stop while ADPCM decode is pending acknowledges without later playback', async () => {
    const f = fixture()
    f.emit(open)
    f.emit({ ...start, format: 'adpcm' })
    f.emit(stop)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.starts()).toBe(0)
    expect(f.decodes()).toBe(0)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: true })
    expect(f.replies()).toContainEqual({
      type: 'complete',
      generation: 1,
      id: 1n,
      result: 'stopped',
    })
    expect(f.replies().filter((r) => r.type === 'complete')).toHaveLength(1)
    f.client.terminate()
  })
  test('effects survive resume and decode and update active playback', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit({ type: 'effects', generation: 1, id: 1n, pitch: 120, pan: -100 })
    f.state('running')
    f.resume()
    await Promise.resolve()
    await Promise.resolve()
    f.emit({ type: 'effects', generation: 1, id: 1n, pitch: -120, pan: 50 })
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.source.playbackRate.value).toBe(0.5)
    expect(f.pans[0].value).toBe(0.5)
    f.emit({ type: 'effects', generation: 1, id: 1n, pitch: 360, pan: 100 })
    expect(f.source.playbackRate.value).toBe(8)
    expect(f.pans[0].value).toBe(1)
    f.emit(stop)
    f.emit({ type: 'effects', generation: 1, id: 1n, pitch: 0, pan: 0 })
    expect(f.source.playbackRate.value).toBe(8)
    expect(f.terminated()).toBe(false)
    f.client.terminate()
  })
  test('stop ACK follows synchronous stop and completion is separate', async () => {
    const f = fixture()
    f.emit(open)
    f.emit(start)
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    f.emit(stop)
    expect(f.starts()).toBe(1)
    expect(f.stops()).toBe(1)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: true })
    f.client.terminate()
  })
  test('failed stop never sends a successful ACK and tears down', async () => {
    const f = fixture({ failStop: true })
    f.emit(open)
    f.emit(start)
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    f.emit(stop)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: false })
    expect(f.terminated()).toBe(true)
  })
  test('autoplay rejection reports failure instead of successful stop', async () => {
    const f = fixture({ failResume: true })
    f.emit(open)
    f.emit(start)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.replies()).toContainEqual({
      type: 'complete',
      generation: 1,
      id: 1n,
      result: 'failed',
    })
    expect(f.starts()).toBe(0)
    f.emit(stop)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: true })
    expect(f.terminated()).toBe(false)
    f.client.terminate()
  })
  test('unknown stop never receives a successful ACK', () => {
    const f = fixture()
    f.emit(open)
    f.emit(stop)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: false })
    expect(f.terminated()).toBe(true)
  })
  test('stop while resume is pending cancels start and ACKs without terminating', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit(stop)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: true })
    expect(f.terminated()).toBe(false)
    expect(f.starts()).toBe(0)
    f.state('running')
    f.resume()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.starts()).toBe(0)
    f.client.terminate()
  })
  test('applies volume updates during resume, decode and playback', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit({ type: 'volume', generation: 1, id: 1n, volume: 0.4 })
    f.state('running')
    f.resume()
    await Promise.resolve()
    await Promise.resolve()
    f.emit({ type: 'volume', generation: 1, id: 1n, volume: 0.3 })
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.gains[0].value).toBe(0.3)
    f.emit({ type: 'volume', generation: 1, id: 1n, volume: 0.8 })
    expect(f.gains[0].value).toBe(0.8)
    expect(f.terminated()).toBe(false)
    f.client.terminate()
  })
  test('volume change for a resume-pending voice is discarded when stopped', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit({ type: 'volume', generation: 1, id: 1n, volume: 0.25 })
    f.emit(stop)
    f.state('running')
    f.resume()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.starts()).toBe(0)
    expect(f.terminated()).toBe(false)
    expect(f.replies()).toContainEqual({ type: 'stopAck', generation: 1, id: 1n, ok: true })
    f.client.terminate()
  })
  test('rejects volume updates for an unknown voice', () => {
    const f = fixture()
    f.emit(open)
    f.emit({ type: 'volume', generation: 1, id: 33n, volume: 0.5 })
    expect(f.terminated()).toBe(true)
  })
  test('shared resume barrier drains starts in order even after state turns running', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit({ ...start, id: 2n })
    f.state('running')
    f.emit({ ...start, id: 3n })
    expect(f.resumeCount()).toBe(1)
    expect(f.decodes()).toBe(0)
    f.resume()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.decodes()).toBe(3)
    expect(f.replies().some((r) => r.type === 'complete' && r.result === 'failed')).toBe(false)
    f.client.terminate()
  })
  test('reverse-resolved abandoned resume cannot overtake new barrier', async () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    f.emit(start)
    f.emit(stop)
    f.emit({ ...start, id: 2n })
    expect(f.resumeCount()).toBe(2)
    f.state('running')
    f.resume(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.decodes()).toBe(1)
    f.resume(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.decodes()).toBe(1)
    expect(f.terminated()).toBe(false)
    f.client.terminate()
  })
  test('bounds outstanding pending starts to ABI voice limit', () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    for (let id = 1; id <= 256; id++) f.emit({ ...start, id: BigInt(id) })
    expect(f.terminated()).toBe(false)
    f.emit({ ...start, id: 257n })
    expect(f.terminated()).toBe(true)
  })
  test('bounds long-lived failed-start tombstones without fake ACK', () => {
    const f = fixture({ pendingResume: true })
    f.emit(open)
    for (let id = 1; id <= 4096; id++) {
      f.emit({ ...start, id: BigInt(id) })
      f.emit({ ...stop, id: BigInt(id) })
    }
    expect(f.terminated()).toBe(false)
    f.emit({ ...start, id: 4097n })
    f.emit({ ...stop, id: 4097n })
    expect(f.terminated()).toBe(true)
    expect(f.replies().some((r) => r.type === 'stopAck' && r.id === 4097n && r.ok)).toBe(false)
  })
  test('worker failure invalidates pending decode immediately', async () => {
    const f = fixture()
    f.emit(open)
    f.emit(start)
    f.listeners.get('error')?.({ message: 'dead' })
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.starts()).toBe(0)
    expect(f.terminated()).toBe(true)
  })
  test('pending autoplay resume times out as failed playback', () => {
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
      const f = fixture({ pendingResume: true })
      f.emit(open)
      f.emit(start)
      timers.get(2)!()
      expect(f.replies()).toContainEqual({
        type: 'complete',
        generation: 1,
        id: 1n,
        result: 'failed',
      })
      expect(f.starts()).toBe(0)
      f.client.terminate()
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
  test('successful cancel ACK clears watchdog and permits reflag', async () => {
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
      const f = fixture()
      f.emit(open)
      expect(timers.size).toBe(1)
      f.emit({ type: 'cancel', generation: 1 })
      await Promise.resolve()
      await Promise.resolve()
      expect(timers.size).toBe(0)
      await f.client.greenFlag()
      expect(f.terminated()).toBe(false)
      f.client.terminate()
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
  test('heartbeat extends watchdog; a stalled worker is terminated', () => {
    const originalSet = globalThis.setTimeout,
      originalClear = globalThis.clearTimeout
    let next = 0
    const timers = new Map<number, () => void>()
    globalThis.setTimeout = ((fn: () => void) => {
      const id = ++next
      timers.set(id, fn)
      return id
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id)
    }) as typeof clearTimeout
    try {
      const f = fixture()
      f.emit(open)
      for (let i = 0; i < 10; i++) {
        f.listeners.get('message')?.({
          data: { id: 0, generation: 0, ok: true, value: { audioHeartbeat: true } },
        })
        expect(timers.size).toBe(1)
        expect(f.terminated()).toBe(false)
      }
      ;[...timers.values()][0]()
      expect(f.terminated()).toBe(true)
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
  test('context suspension cancels active voices and terminates', async () => {
    const f = fixture()
    f.emit(open)
    f.emit(start)
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    f.state('suspended')
    expect(f.stops()).toBe(1)
    expect(f.terminated()).toBe(true)
  })
  test('stop with active generation synchronously cancels and terminates', async () => {
    const f = fixture()
    f.emit(open)
    f.emit(start)
    f.decode()
    await Promise.resolve()
    await Promise.resolve()
    const result = f.client.stop()
    expect(f.stops()).toBe(1)
    expect(f.terminated()).toBe(true)
    await expect(result).rejects.toThrow('worker teardown')
  })
})
