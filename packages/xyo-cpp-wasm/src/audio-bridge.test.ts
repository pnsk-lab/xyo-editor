import { describe, expect, test } from 'bun:test'
import { AudioBridge, type AudioBridgeModule } from './audio-bridge'

function mock() {
  const heap = new Uint8Array(128)
  let kind = 1, failed = 0, ptr = 8, size = 3, generation = 7, lo = -1, hi = -2147483648
  const calls: unknown[][] = []
  // Every ABI call destroys the previously borrowed region. Pointer getters
  // restore their own data so retaining a view across calls fails this test.
  const call = <T extends unknown[]>(name: string, result: (...args: T) => number) => (...args: T) => {
    heap.fill(0, 8, 80); calls.push([name, ...args]); return result(...args)
  }
  const m: AudioBridgeModule = {
    HEAPU8: heap,
    _xyo_browser_audio_open: call('open', () => 1),
    _xyo_browser_audio_close: call('close', () => 1),
    _xyo_browser_audio_detach: call('detach', () => 1),
    _xyo_browser_audio_tick: call('tick', () => 0),
    _xyo_browser_audio_failed: call('failed', () => failed),
    _xyo_browser_audio_kind: call('kind', () => kind),
    _xyo_browser_audio_generation: call('generation', () => generation),
    _xyo_browser_audio_session_generation: call('sessionGeneration', () => generation),
    _xyo_browser_audio_id_lo: call('lo', () => lo),
    _xyo_browser_audio_id_hi: call('hi', () => hi),
    _xyo_browser_audio_bytes_size: call('size', () => size),
    _xyo_browser_audio_bytes: call('bytes', () => { heap.set([1, 2, 3], 8); return ptr }),
    _xyo_browser_audio_format: call('format', () => { heap.set([119, 97, 118, 0], 20); return 20 }),
    _xyo_browser_audio_target: call('target', () => { heap.set([116, 0], 30); return 30 }),
    _xyo_browser_audio_volume: call('volume', () => 50),
    _xyo_browser_audio_pitch: call('pitch', () => 0),
    _xyo_browser_audio_pan: call('pan', () => 0),
    _xyo_browser_audio_pop: call('pop', () => 1),
    _xyo_browser_audio_complete: call('complete', () => 1),
    _xyo_browser_audio_stop_ack: call('stopAck', () => 1),
    _xyo_browser_audio_close_ack: call('closeAck', () => 0),
  }
  return { m, calls, set: (v: { kind?: number; failed?: number; ptr?: number; size?: number; generation?: number; lo?: number; hi?: number }) => {
    kind = v.kind ?? kind; failed = v.failed ?? failed; ptr = v.ptr ?? ptr; size = v.size ?? size
    generation = v.generation ?? generation; lo = v.lo ?? lo; hi = v.hi ?? hi
  } }
}

describe('experimental audio ABI wrapper', () => {
  test('copies transient bytes and strings before the next call', () => {
    const { m, calls } = mock(), b = new AudioBridge(m, 1)
    const result = b.poll()
    expect(result).toEqual({ type: 'start', generation: 7, id: 0x80000000ffffffffn, bytes: new Uint8Array([1, 2, 3]), format: 'wav', target: 't', volume: 50, pitch: 0, pan: 0 })
    expect(calls.map(c => c[0])).toEqual(['failed', 'kind', 'generation', 'lo', 'hi', 'pitch', 'pan', 'size', 'bytes', 'format', 'target', 'volume'])
    b.pop()
    if (result?.type === 'start') expect([...result.bytes]).toEqual([1, 2, 3])
  })
  test('routes lifecycle, ID halves, completion and both ACKs', () => {
    const { m, calls, set } = mock(), b = new AudioBridge(m, 9)
    b.open(30); b.close(); expect(b.tick()).toBe(false)
    b.complete(7, 0x80000000ffffffffn); b.stopAck(7, 0x80000000ffffffffn, false)
    expect(b.closeAck(7, true)).toBe(false); b.detach()
    expect(calls).toContainEqual(['complete', 9, 7, 0xffffffff, 0x80000000])
    expect(calls).toContainEqual(['stopAck', 9, 7, 0xffffffff, 0x80000000, 0])
    set({ kind: 4 }); expect(b.poll()).toEqual({ type: 'volume', generation: 7, id: 0x80000000ffffffffn, volume: 50 })
    m._xyo_browser_audio_volume = () => NaN; expect(() => b.poll()).toThrow()
    set({ kind: 2 }); expect(b.poll()).toEqual({ type: 'stop', generation: 7, id: 0x80000000ffffffffn })
    set({ kind: 3, lo: 0, hi: 0 }); expect(b.poll()).toEqual({ type: 'cancel', generation: 7 })
    set({ kind: 0 }); expect(b.poll()).toBeNull()
  })
  test('session generation is available through close and fails closed after detach', () => {
    const { m } = mock()
    let session = 0
    m._xyo_browser_audio_open = () => { session = -1; return 1 }
    m._xyo_browser_audio_session_generation = () => session
    m._xyo_browser_audio_detach = () => { session = 0; return 1 }
    const b = new AudioBridge(m, 1)
    expect(() => b.getSessionGeneration()).toThrow()
    b.open(10)
    expect(b.getSessionGeneration()).toBe(0xffffffff)
    b.close()
    expect(b.getSessionGeneration()).toBe(0xffffffff)
    b.detach()
    expect(() => b.getSessionGeneration()).toThrow()
    session = NaN
    expect(() => b.getSessionGeneration()).toThrow()
    session = 0x100000000
    expect(() => b.getSessionGeneration()).toThrow()
  })
  test('rejects invalid handles, ABI errors, pointers, states and identifiers', () => {
    const { m, set } = mock()
    expect(() => new AudioBridge(m, 0)).toThrow()
    const b = new AudioBridge(m, 1)
    expect(() => b.open(0)).toThrow()
    expect(() => b.complete(0, 1n)).toThrow()
    expect(() => b.complete(1, 1n << 64n)).toThrow()
    set({ failed: -1 }); expect(() => b.poll()).toThrow(); expect(() => b.tick()).toThrow()
    set({ failed: 1, kind: 6 }); expect(() => b.poll()).toThrow()
    set({ kind: 1, ptr: 0 }); expect(() => b.poll()).toThrow()
    set({ ptr: 127, size: 3 }); expect(() => b.poll()).toThrow()
    set({ ptr: 8, size: 3, generation: 0 }); expect(() => b.poll()).toThrow()
    set({ generation: 1, lo: 0, hi: 0 }); expect(() => b.poll()).toThrow()
  })
})
