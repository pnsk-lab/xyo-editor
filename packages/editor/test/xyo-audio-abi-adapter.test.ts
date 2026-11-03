import { describe, expect, test } from 'bun:test'
import { XyoAudioAbiAdapter } from '../src/lib/xyo-audio-abi-adapter'
import type { AudioBridge, AudioBridgeCommand } from '../../xyo-cpp-wasm/src/audio-bridge'

function setup() {
  const queue: AudioBridgeCommand[] = [],
    calls: unknown[][] = []
  let failed = false,
    tick = true,
    ack = true,
    generation = 9
  const bridge: Pick<
    AudioBridge,
    | 'open'
    | 'getSessionGeneration'
    | 'close'
    | 'detach'
    | 'tick'
    | 'failed'
    | 'poll'
    | 'pop'
    | 'complete'
    | 'stopAck'
    | 'closeAck'
  > = {
    open: (n) => {
      calls.push(['open', n])
    },
    getSessionGeneration: () => generation,
    close: () => {
      calls.push(['close'])
      queue.length = 0
      queue.push({ type: 'cancel', generation })
    },
    detach: () => {
      calls.push(['detach'])
    },
    tick: () => tick,
    failed: () => failed,
    poll: () => queue[0] ?? null,
    pop: () => {
      calls.push(['pop'])
      queue.shift()
    },
    complete: (g, id) => {
      calls.push(['complete', g, id])
    },
    stopAck: (g, id, ok) => {
      calls.push(['stopAck', g, id, ok])
    },
    closeAck: (g, ok) => {
      calls.push(['closeAck', g, ok])
      return ack
    },
  }
  const adapter = new XyoAudioAbiAdapter(bridge, 50)
  return {
    adapter,
    queue,
    calls,
    set: (v: { failed?: boolean; tick?: boolean; ack?: boolean; generation?: number }) => {
      failed = v.failed ?? failed
      tick = v.tick ?? tick
      ack = v.ack ?? ack
      generation = v.generation ?? generation
    },
  }
}
const start = (id = 1n, volume = 50): AudioBridgeCommand => ({
  type: 'start',
  generation: 9,
  id,
  volume,
  pitch: 0,
  pan: 0,
  bytes: new Uint8Array([1, 2]),
  format: 'wav',
  target: 't',
})

describe('experimental worker audio ABI adapter', () => {
  test('opens, copies and clamps audio, handles completion/stop race', () => {
    const { adapter: a, queue, calls } = setup()
    a.open()
    const original = start()
    queue.push(original, start(2n, 200))
    const commands = a.drain()
    if (original.type === 'start') original.bytes.fill(0)
    expect(commands.map((c) => c.type)).toEqual(['open', 'start', 'start'])
    const c = commands[1]
    expect(c.type === 'start' && [...new Uint8Array(c.bytes)]).toEqual([1, 2])
    expect(c.type === 'start' && c.volume).toBe(0.5)
    expect(commands[2].type === 'start' && commands[2].volume).toBe(1)
    a.reply({ type: 'complete', generation: 9, id: 1n, result: 'ended' })
    queue.push({ type: 'stop', generation: 9, id: 1n })
    expect(a.drain()[0].type).toBe('stop')
    a.reply({ type: 'stopAck', generation: 9, id: 1n, ok: true })
    expect(calls).toContainEqual(['complete', 9, 1n])
    expect(calls).toContainEqual(['stopAck', 9, 1n, true])
    expect(() => a.reply({ type: 'complete', generation: 9, id: 1n, result: 'ended' })).toThrow()
  })
  test('forwards and normalizes volume commands in order', () => {
    const { adapter: a, queue } = setup()
    a.open()
    queue.push(start(), { type: 'volume', generation: 9, id: 1n, volume: 35 })
    expect(a.drain()).toEqual([
      { type: 'open', generation: 9 },
      {
        type: 'start',
        generation: 9,
        id: 1n,
        bytes: new Uint8Array([1, 2]).buffer,
        format: 'wav',
        volume: 0.5,
        pitch: 0,
        pan: 0,
      },
      { type: 'volume', generation: 9, id: 1n, volume: 0.35 },
    ])
  })
  test('forwards effects in order and rejects malformed values', () => {
    const { adapter: a, queue } = setup()
    a.open()
    queue.push(
      start(),
      { type: 'effects', generation: 9, id: 1n, pitch: 360, pan: -100 },
      { type: 'volume', generation: 9, id: 1n, volume: 20 },
    )
    const commands = a.drain()
    expect(commands.map((c) => c.type)).toEqual(['open', 'start', 'effects', 'volume'])
    expect(commands[2]).toEqual({ type: 'effects', generation: 9, id: 1n, pitch: 360, pan: -100 })
    queue.push({ type: 'effects', generation: 9, id: 1n, pitch: NaN, pan: 0 })
    expect(() => a.drain()).toThrow()
  })
  test('close is nonblocking; only a delivered successful cancellation ACK detaches', () => {
    const { adapter: a, calls, set } = setup()
    a.open()
    a.close()
    a.close()
    set({ tick: false })
    a.tick()
    expect(() => a.reply({ type: 'cancelAck', generation: 9, ok: true })).toThrow()
    expect(a.drain()).toEqual([
      { type: 'open', generation: 9 },
      { type: 'cancel', generation: 9 },
    ])
    expect(() => a.reply({ type: 'cancelAck', generation: 8, ok: true })).toThrow()
    set({ ack: false })
    expect(() => a.reply({ type: 'cancelAck', generation: 9, ok: true })).toThrow()
    expect(calls.some((c) => c[0] === 'detach')).toBe(false)
    set({ ack: true })
    a.reply({ type: 'cancelAck', generation: 9, ok: true })
    expect(calls.at(-1)).toEqual(['detach'])
    expect(() => a.reply({ type: 'cancelAck', generation: 9, ok: true })).toThrow()
    expect(a.drain()).toEqual([])
    a.open()
  })
  test('reports failure without detaching or fabricating ACKs', () => {
    const { adapter: a, queue, calls, set } = setup()
    a.open()
    queue.push(start())
    a.drain()
    queue.push({ type: 'stop', generation: 9, id: 1n })
    a.drain()
    expect(() => a.reply({ type: 'stopAck', generation: 9, id: 1n, ok: false })).toThrow()
    expect(calls).toContainEqual(['stopAck', 9, 1n, false])
    set({ failed: true })
    expect(() => a.tick()).toThrow()
    expect(calls.some((c) => c[0] === 'detach')).toBe(false)
  })
  test('rejects stale and invalid state transitions', () => {
    const { adapter: a, queue } = setup()
    expect(() => a.close()).toThrow()
    a.open()
    expect(() => a.open()).toThrow()
    expect(() => a.reply({ type: 'complete', generation: 8, id: 1n, result: 'ended' })).toThrow()
    queue.push({ ...start(), generation: 8 })
    expect(() => a.drain()).toThrow()
  })
  test('releases completed voices and rejects old start and duplicate replies', () => {
    const { adapter: a, queue } = setup()
    a.open()
    for (let i = 1n; i <= 1000n; i++) {
      queue.push(start(i))
      a.drain()
      a.reply({ type: 'complete', generation: 9, id: i, result: 'ended' })
    }
    expect((a as unknown as { voices: Map<bigint, unknown> }).voices.size).toBe(0)
    expect(() => a.reply({ type: 'complete', generation: 9, id: 1n, result: 'ended' })).toThrow()
    queue.push(start(1n))
    expect(() => a.drain()).toThrow()
  })
  test('late terminal reports during runtime cancellation cannot ACK or detach', () => {
    const { adapter: a, queue, calls } = setup()
    a.open()
    queue.push(start(), start(2n))
    a.drain()
    queue.push({ type: 'stop', generation: 9, id: 2n })
    a.drain()
    // Runtime stopAll queues cancellation while earlier host replies are in flight.
    queue.push({ type: 'cancel', generation: 9 })
    expect(a.drain()).toEqual([{ type: 'cancel', generation: 9 }])
    const before = calls.length
    a.reply({ type: 'complete', generation: 9, id: 1n, result: 'ended' })
    a.reply({ type: 'stopAck', generation: 9, id: 2n, ok: false })
    a.reply({ type: 'stopAck', generation: 9, id: 2n, ok: true })
    expect(calls.length).toBe(before)
    expect(() => a.reply({ type: 'complete', generation: 8, id: 1n, result: 'ended' })).toThrow()
    expect(() => a.reply({ type: 'cancelAck', generation: 9, ok: false })).toThrow()
    expect(calls.some((c) => c[0] === 'detach')).toBe(false)
    a.reply({ type: 'cancelAck', generation: 9, ok: true })
    expect(calls.at(-1)).toEqual(['detach'])
  })
  test('cancel produced by runtime stop enters closing', () => {
    const { adapter: a, queue, set } = setup()
    a.open()
    a.drain()
    queue.push({ type: 'cancel', generation: 9 })
    set({ tick: false })
    a.tick()
    expect(a.drain()).toEqual([{ type: 'cancel', generation: 9 }])
    a.reply({ type: 'cancelAck', generation: 9, ok: true })
  })
})
