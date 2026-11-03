import { describe, expect, test } from 'bun:test'
import type { AudioHostContext } from '../../xyo-cpp-wasm/src/web-audio-host'
import { XyoAudioSupervisor } from '../src/lib/xyo-audio-supervisor'

function fixture() {
  let resolve!: (buffer: AudioBuffer) => void
  const pending = new Promise<AudioBuffer>((yes) => {
    resolve = yes
  })
  const source = {
    playbackRate: { value: 1 },
    buffer: null,
    onended: null as null | (() => void),
    starts: 0,
    stops: 0,
    connect() {},
    disconnect() {},
    start() {
      this.starts++
    },
    stop() {
      this.stops++
    },
  }
  const context = {
    destination: {},
    decodeAudioData: () => pending,
    createBufferSource: () => source,
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
    createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
  } as unknown as AudioHostContext
  return { supervisor: new XyoAudioSupervisor(context), source, resolve }
}

describe('XyoAudioSupervisor', () => {
  test('worker epochs isolate repeated WASM generations and late decode', async () => {
    const { supervisor: s, source, resolve } = fixture()
    const a = s.openWorker(),
      b = s.openWorker()
    expect(a).not.toBe(b)
    expect(s.openGeneration(a, 1, () => {})).toBe(true)
    expect(s.start(a, 1, 1n, new ArrayBuffer(1), 1)).toBe(true)
    expect(s.invalidateWorker(a)).toBe(true)
    expect(s.openGeneration(a, 1, () => {})).toBe(false)
    expect(s.openGeneration(b, 1, () => {})).toBe(true)
    expect(s.start(a, 1, 2n, new ArrayBuffer(1), 1)).toBe(false)
    resolve({} as AudioBuffer)
    await Promise.resolve()
    await Promise.resolve()
    expect(source.starts).toBe(0)
  })

  test('generation cancellation is tombstoned and stop ACK is independent', () => {
    const { supervisor: s } = fixture(),
      epoch = s.openWorker()
    expect(s.openGeneration(epoch, 7, () => {})).toBe(true)
    expect(s.start(epoch, 7, 1n, new ArrayBuffer(1), 1)).toBe(true)
    expect(s.stop(epoch, 7, 1n)).toBe(true)
    expect(s.stop(epoch, 7, 1n)).toBe(true)
    expect(s.invalidateGeneration(epoch, 7)).toBe(true)
    expect(s.openGeneration(epoch, 7, () => {})).toBe(false)
    expect(s.start(epoch, 7, 2n, new ArrayBuffer(1), 1)).toBe(false)
  })

  test('failed cancellation stays failed on retry', async () => {
    const { supervisor: s, source, resolve } = fixture(),
      epoch = s.openWorker()
    s.openGeneration(epoch, 2, () => {})
    s.start(epoch, 2, 1n, new ArrayBuffer(1), 1)
    resolve({} as AudioBuffer)
    await Promise.resolve()
    await Promise.resolve()
    source.stop = () => {
      throw new Error('stop failure')
    }
    expect(s.invalidateGeneration(epoch, 2)).toBe(false)
    expect(s.invalidateGeneration(epoch, 2)).toBe(false)
    expect(s.invalidateWorker(epoch)).toBe(false)
  })
})
