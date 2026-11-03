import { WebAudioHost, type AudioHostContext, type PlaybackResult } from '../../../xyo-cpp-wasm/src/web-audio-host'

/** A supervisor is owned by one editor and is never shared between workers. */
export class XyoAudioSupervisor {
  private nextEpoch = 0n
  private readonly epochs = new Map<bigint, Map<number, WebAudioHost>>()

  constructor(private readonly context: AudioHostContext) {}

  /** Epochs never repeat during this supervisor's lifetime. */
  openWorker(): bigint {
    const epoch = ++this.nextEpoch
    this.epochs.set(epoch, new Map())
    return epoch
  }

  /** Called only on receipt of an authorized new session, never for a late start. */
  openGeneration(epoch: bigint, generation: number, report: (generation: number, id: bigint, result: PlaybackResult) => void): boolean {
    const hosts = this.epochs.get(epoch)
    if (!hosts || hosts.has(generation)) return false
    const host = new WebAudioHost(generation, this.context, (g, id, result) => {
      if (this.epochs.get(epoch)?.get(g) === host) report(g, id, result)
    })
    hosts.set(generation, host)
    return true
  }

  start(epoch: bigint, generation: number, id: bigint, bytes: ArrayBuffer, volume: number, pitch = 0, pan = 0, format?: string): boolean {
    return this.epochs.get(epoch)?.get(generation)?.start(generation, id, bytes, volume, pitch, pan, format) ?? false
  }

  stop(epoch: bigint, generation: number, id: bigint): boolean {
    return this.epochs.get(epoch)?.get(generation)?.stop(generation, id) ?? false
  }

  setVolume(epoch: bigint, generation: number, id: bigint, volume: number): boolean {
    return this.epochs.get(epoch)?.get(generation)?.setVolume(generation, id, volume) ?? false
  }

  setEffects(epoch: bigint, generation: number, id: bigint, pitch: number, pan: number): boolean {
    return this.epochs.get(epoch)?.get(generation)?.setEffects(generation, id, pitch, pan) ?? false
  }

  /** Tombstone first; a failed cancellation must never become a successful ACK. */
  invalidateGeneration(epoch: bigint, generation: number): boolean {
    const host = this.epochs.get(epoch)?.get(generation)
    if (!host) return false
    // Keep the inactive host as a tombstone, and preserve a failed result.
    const result = this.results.get(host)
    if (result !== undefined) return result
    const ok = host.invalidate()
    this.results.set(host, ok)
    return ok
  }

  private readonly results = new WeakMap<WebAudioHost, boolean>()

  /** Invalidate every host before discarding routing, including on worker error. */
  invalidateWorker(epoch: bigint): boolean {
    const hosts = this.epochs.get(epoch)
    if (!hosts) return false
    let ok = true
    for (const generation of hosts.keys()) if (!this.invalidateGeneration(epoch, generation)) ok = false
    this.epochs.delete(epoch)
    return ok
  }
}
