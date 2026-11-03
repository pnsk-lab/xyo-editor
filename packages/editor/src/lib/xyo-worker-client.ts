import type { XyoAudioCommand, XyoAudioReply, XyoWorkerOperation, XyoWorkerRequest, XyoWorkerResponse } from './xyo-worker-protocol'
import { XyoAudioSupervisor } from './xyo-audio-supervisor'
import type { AudioHostContext } from '../../../xyo-cpp-wasm/src/web-audio-host'

export interface XyoAudioContext extends AudioHostContext {
  readonly state?: string
  resume?(): Promise<void>
  addEventListener?(type: 'statechange', listener: () => void): void
  removeEventListener?(type: 'statechange', listener: () => void): void
}

/** The factory chooses the worker entrypoint and generated WASM URL. */
export interface XyoWorkerPort {
  postMessage(message: XyoWorkerRequest): void
  terminate(): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void
}

type Pending = { generation: number; resolve: (value: any) => void; reject: (error: Error) => void }
export class XyoWorkerClient {
  private readonly worker: XyoWorkerPort
  private readonly pending = new Map<number, Pending>()
  private id = 0
  private generation = 0
  private closed = false
  private disposal?: Promise<void>
  private disposing = false
  private readonly supervisor?: XyoAudioSupervisor
  private readonly epoch?: bigint
  private readonly audioGenerations = new Set<number>()
  private readonly invalidAudio = new Set<number>()
  private readonly activeVoices = new Set<string>()
  private readonly pendingStarts = new Map<string, () => void>()
  private readonly pendingVolumes = new Map<string, number>()
  private readonly pendingEffects = new Map<string, { pitch: number; pan: number }>()
  private readonly resumeStarts = new Map<string, { start: () => void; fail: () => void }>()
  private resuming = false
  private resumeSerial = 0
  private removeResumeStart(key: string) {
    this.resumeStarts.delete(key)
    if (!this.resumeStarts.size && this.resuming) { this.resuming = false; ++this.resumeSerial }
  }
  // Bounded safety tombstones: unknown/gapped IDs must never be ACKed by a
  // high-water mark. Exhaustion tears down the epoch rather than guessing.
  private readonly cancelledStarts = new Set<string>()
  private rememberCancelled(key: string): boolean {
    if (!this.cancelledStarts.has(key) && this.cancelledStarts.size >= 4096) {
      this.terminate('Audio cancellation history limit exceeded')
      return false
    }
    this.cancelledStarts.add(key)
    return true
  }
  private onAudioState = () => {
    if (this.activeVoices.size && this.audioContext?.state && this.audioContext.state !== 'running')
      this.terminate('Audio context stopped running')
  }
  private watchdog?: ReturnType<typeof setTimeout>
  private armWatchdog() {
    if (this.watchdog !== undefined) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => this.terminate('Audio worker watchdog expired'), 5000)
  }
  constructor(factory: () => XyoWorkerPort, private readonly audioContext?: XyoAudioContext) {
    if (audioContext) {
      this.supervisor = new XyoAudioSupervisor(audioContext); this.epoch = this.supervisor.openWorker()
      audioContext.addEventListener?.('statechange', this.onAudioState)
    }
    this.worker = factory()
    this.worker.addEventListener('message', this.onMessage)
    this.worker.addEventListener('error', this.onFailure)
    this.worker.addEventListener('messageerror', this.onFailure)
  }
  get supportsAudio(): boolean { return !!this.audioContext }
  private onMessage = (event: { data: XyoWorkerResponse }) => {
    const data = event.data
    if (!data || !Number.isSafeInteger(data.id)) return
    if (data.id === 0) {
      if (!data.ok) { this.terminate(data.error); return }
      if (this.audioGenerations.size && data.generation === this.generation && (data.value as { audioHeartbeat?: boolean } | undefined)?.audioHeartbeat === true) this.armWatchdog()
      const command = (data.value as { audio?: XyoAudioCommand } | undefined)?.audio
      if (command) {
        try { this.onAudio(command, data.generation) }
        catch { this.terminate('Invalid audio transport event') }
      }
      return
    }
    const pending = this.pending.get(data.id)
    if (!pending || data.generation !== pending.generation) return
    this.pending.delete(data.id)
    if (data.ok) pending.resolve(data.value)
    else pending.reject(new Error(data.error))
  }
  private audioReply(reply: XyoAudioReply, delivered?: () => void) {
    void this.request({ type: 'audioReply', reply }).then(() => delivered?.(), () => this.terminate('Audio reply delivery failed'))
  }
  private onAudio(command: XyoAudioCommand, tag: number) {
    const s = this.supervisor, epoch = this.epoch
    if (!s || epoch === undefined) { this.terminate('Audio is disabled'); return }
    const g = command.generation
    if (!Number.isInteger(g) || g <= 0 || g > 0xffffffff) { this.terminate('Invalid audio generation'); return }
    if (command.type === 'cancel') {
      const ok = s.invalidateGeneration(epoch, g)
      for (const [voice, cancel] of this.pendingStarts) if (voice.startsWith(`${g}:`)) cancel()
      for (const voice of this.pendingVolumes.keys()) if (voice.startsWith(`${g}:`)) this.pendingVolumes.delete(voice)
      for (const voice of this.pendingEffects.keys()) if (voice.startsWith(`${g}:`)) this.pendingEffects.delete(voice)
      for (const voice of this.activeVoices) if (voice.startsWith(`${g}:`)) this.activeVoices.delete(voice)
      for (const voice of this.cancelledStarts) if (voice.startsWith(`${g}:`)) this.cancelledStarts.delete(voice)
      this.invalidAudio.add(g)
      this.audioReply({ type: 'cancelAck', generation: g, ok }, () => {
        if (!ok) return
        this.audioGenerations.delete(g)
        if (!this.audioGenerations.size && this.watchdog !== undefined) {
          clearTimeout(this.watchdog); this.watchdog = undefined
        }
      })
      if (!ok) this.terminate('Audio cancellation failed')
      return
    }
    if (tag !== this.generation || this.invalidAudio.has(g)) return
    if (command.type === 'open') {
      if (!s.openGeneration(epoch, g, (generation, id, result) => {
        this.activeVoices.delete(`${generation}:${id}`)
        if (!this.invalidAudio.has(generation) && !this.closed) this.audioReply({ type: 'complete', generation, id, result })
      })) { this.terminate('Duplicate audio generation'); return }
      this.audioGenerations.add(g)
      this.armWatchdog()
      return
    }
    if (!this.audioGenerations.has(g)) { this.terminate('Unknown audio generation'); return }
    if (command.type === 'stop') {
      const key = `${g}:${command.id}`
      const pending = this.pendingStarts.get(key)
      if (pending) { pending(); this.pendingVolumes.delete(key); this.pendingEffects.delete(key); if (!this.rememberCancelled(key)) return }
      const ok = pending || this.cancelledStarts.has(key) ? true : s.stop(epoch, g, command.id)
      this.audioReply({ type: 'stopAck', generation: g, id: command.id, ok })
      if (!ok) this.terminate('Audio stop failed')
      return
    }
    const startKey = `${g}:${command.id}`
    if (command.type === 'effects') {
      if (!Number.isFinite(command.pitch) || command.pitch < -360 || command.pitch > 360 || !Number.isFinite(command.pan) || command.pan < -100 || command.pan > 100) { this.terminate('Invalid audio effects'); return }
      if (this.pendingStarts.has(startKey)) this.pendingEffects.set(startKey, { pitch: command.pitch, pan: command.pan })
      else if (!this.cancelledStarts.has(startKey) && !s.setEffects(epoch, g, command.id, command.pitch, command.pan)) this.terminate('Audio effects update failed')
      return
    }
    if (command.type === 'volume') {
      if (!Number.isFinite(command.volume) || command.volume < 0 || command.volume > 1) { this.terminate('Invalid audio volume'); return }
      if (this.pendingStarts.has(startKey)) this.pendingVolumes.set(startKey, command.volume)
      else if (!this.cancelledStarts.has(startKey) && !s.setVolume(epoch, g, command.id, command.volume)) this.terminate('Audio volume update failed')
      return
    }
    if (command.type !== 'start' || !(command.bytes instanceof ArrayBuffer) ||
        (command.format !== undefined && (typeof command.format !== 'string' || command.format.length > 256))) {
      this.terminate('Invalid audio start'); return
    }
    if (this.pendingStarts.has(startKey) || this.activeVoices.has(startKey) || this.cancelledStarts.has(startKey)) { this.terminate('Duplicate audio voice'); return }
    if (this.pendingStarts.size + this.activeVoices.size >= 256) { this.terminate('Audio voice limit exceeded'); return }
    // Resume may be rejected by autoplay policy. Never launch later after a stop
    // or invalidation, and report a failed start rather than a fake success.
    const start = () => {
      if (this.closed || tag !== this.generation || this.invalidAudio.has(g)) return
      const voice = `${g}:${command.id}`
      const volume = this.pendingVolumes.get(voice) ?? command.volume
      this.pendingVolumes.delete(voice)
      const effects = this.pendingEffects.get(voice) ?? command
      this.pendingEffects.delete(voice)
      this.activeVoices.add(voice)
      if ((this.audioContext?.state && this.audioContext.state !== 'running') || !s.start(epoch, g, command.id, command.bytes, volume, effects.pitch, effects.pan, command.format)) {
        this.activeVoices.delete(voice)
        if (!this.rememberCancelled(voice)) return
        this.audioReply({ type: 'complete', generation: g, id: command.id, result: 'failed' })
      }
    }
    if (this.resuming || (this.audioContext?.state === 'suspended' && this.audioContext.resume)) {
      let settled = false
      const fail = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pendingStarts.delete(startKey)
        this.pendingVolumes.delete(startKey)
        this.pendingEffects.delete(startKey)
        this.removeResumeStart(startKey)
        if (!this.rememberCancelled(startKey)) return
        if (!this.closed && tag === this.generation && !this.invalidAudio.has(g)) this.audioReply({ type: 'complete', generation: g, id: command.id, result: 'failed' })
      }
      const timer = setTimeout(fail, 3000)
      this.pendingStarts.set(startKey, () => { settled = true; clearTimeout(timer); this.pendingStarts.delete(startKey); this.removeResumeStart(startKey) })
      this.resumeStarts.set(startKey, {
        fail,
        start: () => { if (!settled) { settled = true; clearTimeout(timer); this.pendingStarts.delete(startKey); this.removeResumeStart(startKey); start() } },
      })
      if (!this.resuming) {
        this.resuming = true
        const serial = ++this.resumeSerial
        const flush = (success: boolean) => {
          if (serial !== this.resumeSerial || !this.resuming) return
          this.resuming = false
          for (const entry of [...this.resumeStarts.values()]) success ? entry.start() : entry.fail()
        }
        try { void this.audioContext!.resume!().then(() => flush(true), () => flush(false)) }
        catch { flush(false) }
      }
    } else start()
  }
  private onFailure = (event: { message?: string }) => { this.terminate(event.message || 'Worker failed') }
  private invalidate(): void {
    if (this.supervisor && this.epoch !== undefined) {
      for (const g of this.audioGenerations) {
        if (!this.supervisor.invalidateGeneration(this.epoch, g)) { this.terminate('Audio cancellation failed'); break }
        this.invalidAudio.add(g)
      }
    }
    ++this.generation
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error('Stale worker request'))
    }
  }
  private request<T>(operation: XyoWorkerOperation): Promise<T> {
    if (this.closed || (this.disposing && operation.type !== 'dispose')) return Promise.reject(new Error('Worker is terminated or disposing'))
    const id = ++this.id, generation = this.generation
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { generation, resolve, reject })
      try { this.worker.postMessage({ id, generation, operation }) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  private lifecycle(operation: XyoWorkerOperation): Promise<void> {
    if (this.closed || this.disposing) return Promise.reject(new Error('Worker is terminated or disposing'))
    if (this.audioGenerations.size) {
      this.terminate('Active audio requires worker teardown')
      return Promise.reject(new Error('Active audio requires worker teardown'))
    }
    this.invalidate()
    return this.request(operation)
  }
  loadSb3(bytes: Uint8Array): Promise<void> { return this.lifecycle({ type: 'load', bytes: new Uint8Array(bytes) }) }
  greenFlag(): Promise<void> { return this.lifecycle({ type: 'flag', compiled: true, ...(this.audioContext ? { audioEnabled: true } : {}) }) }
  greenFlagInterpreter(): Promise<void> { return this.lifecycle({ type: 'flag', compiled: false, ...(this.audioContext ? { audioEnabled: true } : {}) }) }
  step(): Promise<void> { return this.request({ type: 'step' }) }
  stop(): Promise<void> {
    return this.lifecycle({ type: 'stop' })
  }
  key(key: string, down: boolean, keyCode?: number): Promise<void> { return this.request({ type: 'key', key, down, keyCode }) }
  mouse(x: number, y: number, width: number, height: number, down: boolean, button?: number, dragged?: boolean): Promise<void> { return this.request({ type: 'mouse', x, y, width, height, down, button, dragged }) }
  wheel(dx: number, dy: number): Promise<void> { return this.request({ type: 'wheel', dx, dy }) }
  answer(text: string): Promise<void> { return this.request({ type: 'answer', text }) }
  answerIfQuestion(questionId: string, text: string): Promise<boolean> { return this.request({ type: 'answerIfQuestion', questionId, text }) }
  snapshot(): Promise<unknown> { return this.request({ type: 'snapshot' }) }
  stats(): Promise<unknown> { return this.request({ type: 'stats' }) }
  /** Graceful disposal waits for synchronous WASM. Use terminate() for immediate cancellation. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    if (this.closed) return Promise.resolve()
    if (this.audioGenerations.size) { this.terminate('Active audio requires worker teardown'); return Promise.resolve() }
    this.invalidate()
    this.disposing = true
    this.disposal = this.request<void>({ type: 'dispose' }).finally(() => this.terminate())
    return this.disposal
  }
  /** Reject all waiters and terminate immediately, including during a blocked compile. */
  terminate(reason = 'Worker terminated'): void {
    if (this.closed) return
    this.closed = true
    if (this.watchdog !== undefined) clearTimeout(this.watchdog)
    this.audioContext?.removeEventListener?.('statechange', this.onAudioState)
    for (const cancel of this.pendingStarts.values()) cancel()
    this.pendingVolumes.clear()
    this.pendingEffects.clear()
    this.activeVoices.clear()
    if (this.supervisor && this.epoch !== undefined) this.supervisor.invalidateWorker(this.epoch)
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('error', this.onFailure)
    this.worker.removeEventListener('messageerror', this.onFailure)
    this.worker.terminate()
  }
}
