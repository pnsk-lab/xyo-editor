/** Experimental poll-only ABI. This class does not implement a transport or playback. */
export interface AudioBridgeModule {
  HEAPU8: Uint8Array
  _xyo_browser_audio_open(h: number, timeout: number): number
  _xyo_browser_audio_close(h: number): number
  _xyo_browser_audio_detach(h: number): number
  _xyo_browser_audio_tick(h: number): number
  _xyo_browser_audio_failed(h: number): number
  _xyo_browser_audio_kind(h: number): number
  _xyo_browser_audio_generation(h: number): number
  _xyo_browser_audio_session_generation(h: number): number
  _xyo_browser_audio_id_lo(h: number): number
  _xyo_browser_audio_id_hi(h: number): number
  _xyo_browser_audio_bytes_size(h: number): number
  _xyo_browser_audio_bytes(h: number): number
  _xyo_browser_audio_format(h: number): number
  _xyo_browser_audio_target(h: number): number
  _xyo_browser_audio_volume(h: number): number
  _xyo_browser_audio_pitch(h: number): number
  _xyo_browser_audio_pan(h: number): number
  _xyo_browser_audio_pop(h: number): number
  _xyo_browser_audio_complete(h: number, g: number, lo: number, hi: number): number
  _xyo_browser_audio_stop_ack(h: number, g: number, lo: number, hi: number, ok: number): number
  _xyo_browser_audio_close_ack(h: number, g: number, ok: number): number
}

export type AudioBridgeCommand =
  | { type: 'start'; generation: number; id: bigint; target: string; format: string; bytes: Uint8Array; volume: number; pitch: number; pan: number }
  | { type: 'effects'; generation: number; id: bigint; pitch: number; pan: number }
  | { type: 'stop'; generation: number; id: bigint }
  | { type: 'volume'; generation: number; id: bigint; volume: number }
  | { type: 'cancel'; generation: number }

function uint(value: number, name: string, nonzero = false): number {
  if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > 0xffffffff) throw new RangeError(`Invalid ${name}`)
  return value
}
// Emscripten may expose an i32 return as a signed JS number.
function abiUint(value: number, name: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) throw new Error(`Invalid ABI ${name}`)
  return value >>> 0
}
function flag(value: number, name: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`Invalid ABI ${name}`)
  return value === 1
}
function parts(generation: number, id: bigint): [number, number, number] {
  uint(generation, 'generation', true)
  if (typeof id !== 'bigint' || id <= 0n || id > 0xffffffffffffffffn) throw new RangeError('Invalid voice ID')
  return [generation, Number(id & 0xffffffffn), Number(id >> 32n)]
}

export class AudioBridge {
  constructor(private readonly module: AudioBridgeModule, private readonly handle: number) {
    if (!module || typeof module !== 'object') throw new TypeError('Invalid module')
    uint(handle, 'handle', true)
  }
  private checked(value: number, operation: string): void {
    if (!flag(value, operation)) throw new Error(`Audio ${operation} failed`)
  }
  open(timeoutTicks: number): void { this.checked(this.module._xyo_browser_audio_open(this.handle, uint(timeoutTicks, 'timeout', true)), 'open') }
  /** Available after open, including while closing, until successful detach. */
  getSessionGeneration(): number {
    const generation = abiUint(this.module._xyo_browser_audio_session_generation(this.handle), 'session generation')
    return uint(generation, 'session generation', true)
  }
  close(): void { this.checked(this.module._xyo_browser_audio_close(this.handle), 'close') }
  detach(): void { this.checked(this.module._xyo_browser_audio_detach(this.handle), 'detach') }
  /** False means closing or failed: never step the runtime afterwards. */
  tick(): boolean { this.failed(); return flag(this.module._xyo_browser_audio_tick(this.handle), 'tick') }
  failed(): boolean { return flag(this.module._xyo_browser_audio_failed(this.handle), 'failed') }
  pop(): void { this.checked(this.module._xyo_browser_audio_pop(this.handle), 'pop') }
  complete(generation: number, id: bigint): void {
    const [g, lo, hi] = parts(generation, id)
    this.checked(this.module._xyo_browser_audio_complete(this.handle, g, lo, hi), 'complete')
  }
  stopAck(generation: number, id: bigint, ok: boolean): void {
    const [g, lo, hi] = parts(generation, id)
    if (typeof ok !== 'boolean') throw new TypeError('Invalid ACK')
    this.checked(this.module._xyo_browser_audio_stop_ack(this.handle, g, lo, hi, Number(ok)), 'stop ACK')
  }
  /** False includes early, wrong-generation and failed cancellation ACKs. */
  closeAck(generation: number, ok: boolean): boolean {
    uint(generation, 'generation', true)
    if (typeof ok !== 'boolean') throw new TypeError('Invalid ACK')
    this.failed()
    return flag(this.module._xyo_browser_audio_close_ack(this.handle, generation, Number(ok)), 'close ACK')
  }
  private string(ptr: number, max: number): string {
    ptr = abiUint(ptr, 'string pointer')
    const heap = this.module.HEAPU8
    if (!ptr || !(heap instanceof Uint8Array) || ptr >= heap.length) throw new Error('Invalid audio string pointer')
    let end = ptr
    while (end < heap.length && end - ptr <= max && heap[end] !== 0) end++
    if (end >= heap.length || end - ptr > max) throw new Error('Unterminated audio string')
    return new TextDecoder('utf-8', { fatal: true }).decode(heap.subarray(ptr, end))
  }
  /** Peek without popping; every borrowed pointer is copied before the next ABI call. */
  poll(): AudioBridgeCommand | null {
    // kind=0 alone cannot distinguish an empty queue from an invalid handle.
    this.failed()
    const m = this.module, h = this.handle
    const kind = abiUint(m._xyo_browser_audio_kind(h), 'kind')
    if (kind === 0) return null
    if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4 && kind !== 5) throw new Error('Invalid audio command kind')
    const generation = abiUint(m._xyo_browser_audio_generation(h), 'generation')
    uint(generation, 'generation', true)
    const lo = abiUint(m._xyo_browser_audio_id_lo(h), 'ID low')
    const hi = abiUint(m._xyo_browser_audio_id_hi(h), 'ID high')
    const id = (BigInt(hi) << 32n) | BigInt(lo)
    if (kind === 3) {
      if (id !== 0n) throw new Error('Invalid cancel ID')
      return { type: 'cancel', generation }
    }
    if (id === 0n) throw new Error('Invalid voice ID')
    if (kind === 2) return { type: 'stop', generation, id }
    if (kind === 4) {
      const volume = m._xyo_browser_audio_volume(h)
      if (!Number.isFinite(volume)) throw new Error('Invalid audio volume')
      return { type: 'volume', generation, id, volume }
    }
    const pitch = m._xyo_browser_audio_pitch(h), pan = m._xyo_browser_audio_pan(h)
    if (!Number.isFinite(pitch) || pitch < -360 || pitch > 360 || !Number.isFinite(pan) || pan < -100 || pan > 100) throw new Error('Invalid audio effects')
    if (kind === 5) return { type: 'effects', generation, id, pitch, pan }
    const size = abiUint(m._xyo_browser_audio_bytes_size(h), 'bytes size')
    if (size > 8 * 1024 * 1024) throw new Error('Invalid audio bytes size')
    const ptr = abiUint(m._xyo_browser_audio_bytes(h), 'bytes pointer')
    const heap = m.HEAPU8
    if (!(heap instanceof Uint8Array) || (size > 0 && !ptr) || ptr > heap.length || size > heap.length - ptr) throw new Error('Invalid audio bytes pointer')
    const bytes = heap.slice(ptr, ptr + size)
    const format = this.string(m._xyo_browser_audio_format(h), 256)
    const target = this.string(m._xyo_browser_audio_target(h), 4096)
    const volume = m._xyo_browser_audio_volume(h)
    if (!Number.isFinite(volume)) throw new Error('Invalid audio volume')
    return { type: 'start', generation, id, target, format, bytes, volume, pitch, pan }
  }
}
