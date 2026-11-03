import { ScratchVM, type RuntimeSnapshot } from '@hikkaku/vm'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { overlayXyoSnapshot, type XyoSnapshot } from '../../../xyo-cpp-wasm/src/snapshot'
import type { RuntimeVM } from './runtime-backends'
import { applyXyoPenBatch, prepareXyoPenBatch, type XyoPenRenderer } from './xyo-pen-events'

/** A fresh, exclusively owned headless engine. The actual WASM module is loaded by the host. */
export interface XyoRuntimeEngine {
  loadSb3(bytes: Uint8Array): void | Promise<void>
  greenFlagCompiled(): void | Promise<void>
  step(): void | Promise<void>
  stop(): void | Promise<void>
  snapshot(): unknown | Promise<unknown>
  dispose(): void | Promise<void>
  /** Synchronously terminate an isolated worker and abandon all its pending work. */
  interrupt?(): void
  /** Module-wide cumulative counters, not necessarily exclusive to this engine. */
  readonly compileStats?: { fallbacks: number }
  /** True only when the worker and main-thread audio transport is enabled. */
  readonly supportsAudio?: boolean
  /** How collision sensing is provided, when the engine supports it at all. */
  readonly collision?: 'approximate' | 'none'
  /** Worker clients may return { compileStats: { fallbacks } } asynchronously. */
  stats?(): unknown | Promise<unknown>
  key?(key: string, down: boolean, keyCode?: number): void | Promise<void>
  mouse?(x: number, y: number, width: number, height: number, down: boolean, button?: number, dragged?: boolean): void | Promise<void>
  wheel?(dx: number, dy: number): void | Promise<void>
  answer?(text: string): void | Promise<void>
  answerIfQuestion?(questionId: string, text: string): boolean | Promise<boolean>
}
export type XyoEngineLoader = () => XyoRuntimeEngine | Promise<XyoRuntimeEngine>

/**
 * Experimental headless adapter. The host supplies the lazy engine loader and drives
 * vm.step(). Input is forwarded headlessly; sprite picking and collision sensing
 * are not implemented, and rendering/audio have compatibility limitations;
 * this adapter is not a replacement for the production Scratch backend. The xyo
 * engine may interpret scripts it cannot compile. An injected interrupt must actually
 * terminate its isolated worker synchronously; without it in-flight work cannot be
 * interrupted and subsequent work waits for it. Stale results are never published.
 */
export class XyoRuntimeVM {
  readonly vm: RuntimeVM
  private engine?: XyoRuntimeEngine
  private engineLoaded = false
  private tail: Promise<void> = Promise.resolve()
  private pending: Promise<void> = Promise.resolve()
  private generation = 0
  private ready = false
  private disposed = false
  private live?: RuntimeSnapshot
  private baseline?: RuntimeSnapshot
  private committing = false
  private fallbackCount?: number
  private mouseState?: string
  private question: string | null = null
  private questionId: string | null = null
  private answering = false
  private pendingMouse?: { key: string; deliver: () => void | Promise<void> }
  private readonly unsubscribers: (() => void)[] = []

  constructor(private readonly loadEngine: XyoEngineLoader, readonly model = new ScratchVM(), private readonly penRenderer?: XyoPenRenderer) {
    const invalidate = (replaced: boolean) => {
      if (this.committing || (!this.ready && !this.baseline)) return
      if (replaced) this.invalidate()
      else this.commitAndInvalidate()
      this.report(new Error('xyo-cpp run invalidated by an edit'))
    }
    // Lightweight snapshots retain project identity; PROJECT_LOADED alone is
    // also emitted by handleProjectLoaded(), which does not replace the project.
    let projectIdentity = model.lightweightSnapshot().project
    const rememberProject = () => { projectIdentity = model.lightweightSnapshot().project }
    this.unsubscribers.push(
      model.on('PROJECT_CHANGED', () => { try { invalidate(false) } finally { rememberProject() } }),
      model.on('TARGETS_UPDATE', rememberProject),
      model.on('PROJECT_LOADED', () => {
        const replacement = model.lightweightSnapshot().project !== projectIdentity
        rememberProject()
        try { invalidate(true) }
        finally { if (replacement && this.penRenderer) this.penRenderer.discardPenLayer() }
      }),
    )
    const unsupported = (name: string): never => { throw new Error(`xyo-cpp headless runtime does not support ${name}`) }
    const runtime = new Proxy(model.runtime, {
      get: (target, key) => {
        if (key === 'greenFlag') return () => this.greenFlag()
        if (key === 'stopAll') return () => this.stopAll()
        if (key === 'ioDevices') return {
          mouse: { postData: (data: unknown) => this.input('mouse', data) },
          keyboard: { postData: (data: unknown) => this.input('keyboard', data) },
          mouseWheel: { postData: (data: unknown) => this.input('wheel', data) },
          cloud: { postData: () => unsupported('cloud input'), setProvider: () => unsupported('cloud provider'), setStage: () => unsupported('cloud stage') },
          video: { postData: () => unsupported('video input'), setProvider: () => unsupported('video provider') },
        }
        if (['startHats', 'toggleScript', 'stopForTarget'].includes(String(key))) return () => unsupported(String(key))
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.vm = new Proxy(model, {
      get: (target, key) => {
        if (key === 'runtime') return runtime
        if (key === 'greenFlag') return () => this.greenFlag()
        if (key === 'stopAll') return () => this.stopAll()
        if (key === 'step') return () => this.step()
        if (key === 'dispose' || key === 'quit') return () => this.dispose()
        if (key === 'snapshot' || key === 'lightweightSnapshot') return () => this.snapshot()
        if (key === 'exportProject') return () => this.exportProject()
        if (key === 'saveProjectSb3') return () => this.saveProjectSb3()
        if (key === 'saveSpriteSb3' || key === 'exportSprite') return (id?: string) => this.saveSpriteSb3(id)
        if (key === 'toJSON') return (id?: string) => JSON.stringify(id ? this.snapshot().project.targets.find(t => t.id === id || t.name === id) ?? null : this.exportProject(), null, 2)
        if (key === 'isRunning') return () => this.ready && Boolean(this.live?.running)
        if (key === 'getTarget') return (id: string) => this.snapshot().project.targets.find(t => t.id === id || t.name === id)
        if (key === 'getStage' || key === 'getTargetForStage') return () => this.snapshot().project.targets.find(t => t.isStage)
        if (key === 'getSelectedTarget' || key === 'getEditingTarget' || key === 'editingTarget') {
          const selected = () => { const s = this.snapshot(); return s.project.targets.find(t => t.id === s.selectedTargetId || t.name === s.selectedTargetId) }
          return key === 'editingTarget' ? selected() ?? null : selected
        }
        if (key === 'postIOData') return (device: string, data: unknown) => this.input(device, data)
        if (key === 'postMouse') return (data: unknown) => this.input('mouse', data)
        if (key === 'postKeyboard') return (data: unknown) => this.input('keyboard', data)
        if (key === 'postWheel') return (data: unknown) => this.input('wheel', data)
        if (key === 'answerPrompt') return (data: string) => this.input('answer', data)
        if (key === 'startDrag') return (id: string) => { this.assertAlive(); this.model.startDrag(id) }
        if (key === 'stopDrag') return (id?: string) => { this.assertAlive(); this.model.stopDrag(id) }
        if (key === 'postSpriteInfo') return (data: unknown) => this.editSprite(data)
        if (['startHats', 'startRuntimeHats', 'toggleScript', 'reportBlockValue', 'stopForTarget'].includes(String(key))) return () => unsupported(String(key))
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as RuntimeVM
  }

  private report(error: unknown): void { this.model.emit('ERROR', { error, message: error instanceof Error ? error.message : String(error) }) }
  /** Pen and live state have committed together. If a notification fails, stop
   * the generation rather than leaving an undelivered QUESTION waiting forever.
   * Preserve that committed frame; do not treat it as an uncommitted batch. */
  private postCommit(generation: number, notification: () => void): void {
    if (!this.penRenderer) { notification(); return }
    if (!this.current(generation)) return
    try { notification() }
    catch (error) {
      if (!this.current(generation)) return
      const failure = new Error(`xyo-cpp committed frame; notification failed and runtime stopped: ${error instanceof Error ? error.message : String(error)}`)
      ++this.generation
      this.ready = false
      this.pendingMouse = undefined
      try { this.clearQuestion() } catch { /* Listener failure must not prevent teardown. */ }
      let saved = true
      try { if (this.live) this.commit() } catch { saved = false }
      if (saved) { this.live = undefined; this.baseline = undefined }
      else this.markLiveStopped()
      let interrupted = false
      try { interrupted = this.interrupt() } catch { /* Never skip error propagation after teardown failure. */ }
      if (!interrupted && this.engine && this.engineLoaded) {
        const engine = this.engine
        this.enqueue(async () => { await engine.stop() })
      }
      try { this.report(failure) } catch { /* ERROR listener failure is not recursively reported. */ }
      throw failure
    }
  }
  private enqueue(operation: () => Promise<void>, generation?: number, mouse = false): void {
    if (!mouse) this.pendingMouse = undefined
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    this.pending = result
    void result.catch(error => {
      if (generation !== undefined) {
        if (!this.current(generation)) return
        ++this.generation
        this.ready = false
        try { this.clearQuestion() } catch { /* A listener cannot prevent worker teardown. */ }
        let saved = true
        let commitError: unknown
        try { if (this.live) this.commit() } catch (failure) { saved = false; commitError = failure }
        if (saved) { this.live = undefined; this.baseline = undefined }
        else this.markLiveStopped()
        let interrupted = false
        try { interrupted = this.interrupt() } catch { /* Reporting a failed interrupt may itself throw. */ }
        if (!interrupted && this.engine && this.engineLoaded) {
          const engine = this.engine
          this.enqueue(async () => { await engine.stop() })
        }
        if (commitError !== undefined) { try { this.report(commitError) } catch { /* No recursive reporting. */ } }
      }
      try { this.report(error) } catch { /* An ERROR listener cannot undo teardown. */ }
    })
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation }
  /** A retained visual/data snapshot is not a resumable execution state. */
  private markLiveStopped(): void {
    if (this.live) this.live = { ...this.live, running: false, threads: [] }
  }
  private clearQuestion(): void {
    const hadQuestion = this.question !== null || this.answering
    this.question = null
    this.questionId = null
    this.answering = false
    if (hadQuestion) this.model.emit('QUESTION', { question: null })
  }
  private validateQuestion(raw: unknown, afterAnswer = false): { next: string | null; id: string | null } | undefined {
    if (this.answering && !afterAnswer) return undefined
    const io = (raw as { io?: { question?: unknown; questionId?: unknown } } | null)?.io
    const question = io?.question
    if (question !== undefined && question !== null && typeof question !== 'string') throw new Error('Invalid xyo-cpp question')
    const next = question ?? null
    const id = next === null ? null : io?.questionId
    if (id !== null && (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id))) throw new Error('Invalid xyo-cpp question identity')
    return { next, id: id as string | null }
  }
  private updateQuestion(raw: unknown, afterAnswer = false): void {
    const parsed = this.validateQuestion(raw, afterAnswer)
    if (!parsed) return
    const { next, id } = parsed
    if (afterAnswer) this.answering = false
    if (afterAnswer || next !== this.question || id !== this.questionId) {
      this.question = next
      this.questionId = id
      this.model.emit('QUESTION', { question: next, questionId: id })
    }
  }
  private assertAlive(): void { if (this.disposed) throw new Error('xyo-cpp runtime is disposed') }
  /** Detach an isolated engine immediately; never reuse a terminated instance. */
  private interrupt(): boolean {
    const engine = this.engine
    if (engine && !engine.interrupt) return false
    if (engine) {
      try { engine.interrupt!() } catch (error) { this.report(error); return false }
    }
    this.engine = undefined
    this.engineLoaded = false
    // Old operations may never settle, but can only touch their abandoned engine.
    this.tail = Promise.resolve()
    return true
  }
  private invalidate(preserveLive = false): void {
    let failed = false, failure: unknown
    try { this.clearQuestion() } catch (error) { failed = true; failure = error }
    ++this.generation
    this.ready = false
    if (!preserveLive) { this.live = undefined; this.baseline = undefined }
    else this.markLiveStopped()
    this.mouseState = undefined
    this.pendingMouse = undefined
    let interrupted = false
    try { interrupted = this.interrupt() } catch (error) { if (!failed) { failed = true; failure = error } }
    this.enqueue(async () => { if (!interrupted && this.engine && this.engineLoaded) await this.engine.stop() })
    if (failed) throw failure
  }
  greenFlag(): void {
    this.assertAlive()
    try {
      if (this.live) this.commit()
      this.clearQuestion()
    } catch (error) {
      // A failed pre-flag notification/commit must not leave the old worker live.
      // Retain the live snapshot for a later retry when committing failed.
      ++this.generation
      this.ready = false
      this.markLiveStopped()
      this.mouseState = undefined
      this.pendingMouse = undefined
      try { this.clearQuestion() } catch { /* Teardown must continue. */ }
      let interrupted = false
      try { interrupted = this.interrupt() } catch { /* Reporting must not block stop. */ }
      if (!interrupted && this.engine && this.engineLoaded) {
        const engine = this.engine
        this.enqueue(async () => { await engine.stop() })
      }
      throw error
    }
    const generation = ++this.generation
    this.ready = false
    this.live = undefined
    this.mouseState = undefined
    this.pendingMouse = undefined
    this.interrupt()
    const baseline = this.model.snapshot()
    this.baseline = baseline
    // Capture at invocation, not when the serialized queue eventually runs.
    const archive = this.model.saveProjectSb3()
    // Observe capture rejection even if an earlier operation is still pending.
    void archive.catch(() => {})
    this.enqueue(async () => {
      const bytes = await archive
      if (!this.current(generation)) return
      const engine = this.engine ?? await this.loadEngine()
      if (!this.current(generation)) {
        try {
          if (engine.interrupt) engine.interrupt()
          else await engine.dispose()
        } catch (error) { this.report(error) }
        return
      }
      this.engine = engine
      if (this.engineLoaded) await engine.stop()
      if (!this.current(generation)) return
      await engine.loadSb3(bytes)
      if (!this.current(generation)) return
      this.engineLoaded = true
      this.fallbackCount = await this.readFallbackCount()
      if (!this.current(generation)) return
      await engine.greenFlagCompiled()
      if (!this.current(generation)) return
      const raw = await engine.snapshot()
      if (!this.current(generation)) return
      const live = this.overlay(baseline, raw)
      const penBatch = this.preparePen(raw)
      this.validateQuestion(raw)
      const fallbackCount = await this.readFallbackCount()
      if (!this.current(generation)) return
      if (penBatch) applyXyoPenBatch(this.penRenderer!, penBatch)
      this.live = live
      this.ready = true
      this.postCommit(generation, () => this.checkFallback(fallbackCount))
      if (this.fallbackCount === undefined) this.postCommit(generation, () => this.report(new Error('xyo-cpp compile fallback statistics are unavailable; compiled execution cannot be verified')))
      const audioLimit = engine.supportsAudio ? 'audio playback and format support are experimental' : 'audio is not supported'
      const collision = engine.collision ?? 'none'
      this.postCommit(generation, () => this.report(collision === 'approximate'
        ? new Error(`xyo-cpp collision sensing is approximate (bounding geometry, no pixel-exact silhouettes); ${audioLimit}; execution may differ from Scratch`)
        : new Error(`xyo-cpp is headless: sprite picking and collision sensing are not supported; ${audioLimit}; mouse clicks target only the stage and execution may differ from Scratch`)))
      this.postCommit(generation, () => this.model.emit('PROJECT_RUN_START', this.snapshot()))
      this.postCommit(generation, () => this.updateQuestion(raw))
    }, generation)
  }
  step(): void {
    this.assertAlive()
    if (!this.ready) throw new Error('xyo-cpp project is not synchronized')
    const generation = this.generation
    this.enqueue(async () => {
      if (!this.current(generation) || !this.ready) return
      await this.engine!.step()
      if (!this.current(generation)) return
      const raw = await this.engine!.snapshot()
      if (!this.current(generation)) return
      const fallbackCount = await this.readFallbackCount()
      if (!this.current(generation)) return
      const live = this.overlay(this.baseline!, raw)
      const penBatch = this.preparePen(raw)
      this.validateQuestion(raw)
      if (penBatch) applyXyoPenBatch(this.penRenderer!, penBatch)
      this.live = live
      this.postCommit(generation, () => this.checkFallback(fallbackCount))
      this.postCommit(generation, () => this.updateQuestion(raw))
      this.postCommit(generation, () => this.model.emit('RUNTIME_STEP', this.snapshot()))
    }, generation)
  }
  private editSprite(data: unknown): void {
    this.assertAlive()
    if (this.live || this.baseline) {
      this.commitAndInvalidate()
      this.report(new Error('xyo-cpp run stopped for sprite editing; start again to run the edited project'))
    }
    this.model.postSpriteInfo(data)
  }
  private input(device: string, data: unknown): void {
    this.assertAlive()
    if (!this.ready || !this.engine) {
      if (device === 'mouse') {
        // Keep editor pointer handling functional without starting ScratchVM click hats.
        const safe = data && typeof data === 'object' ? { ...data, wasDragged: true } : data
        this.model.postMouse(safe)
      } else if (device === 'keyboard') {
        // Record editor IO without starting scripts in the editing model.
        this.model.postIOData('keyboard', data)
      } else if (device === 'wheel' || device === 'mouseWheel') this.model.postWheel(data)
      else throw new Error(`xyo-cpp input requires a synchronized project: ${device}`)
      if (this.baseline) this.report(new Error('xyo-cpp input was not delivered while the project was loading'))
      return
    }
    const engine = this.engine
    const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
    let deliver: () => void | Promise<void>
    let mouseKey: string | undefined
    let notificationFailed = false, notificationError: unknown
    const deliveryGeneration = this.generation
    if (device === 'keyboard') {
      if (!engine.key) throw new Error('xyo-cpp engine does not support keyboard input')
      const key = object?.key ?? object?.KEY_OPTION
      if (typeof key !== 'string' || !key) throw new TypeError('xyo-cpp keyboard input requires a key')
      const names: Record<string, string> = { space: ' ', 'left arrow': 'ArrowLeft', 'right arrow': 'ArrowRight', 'up arrow': 'ArrowUp', 'down arrow': 'ArrowDown', enter: 'Enter' }
      const mapped = names[key.toLowerCase()] ?? key
      const down = object?.isDown === true || object?.down === true || object?.pressed === true
      const code = object?.keyCode
      if (code !== undefined && (typeof code !== 'number' || !Number.isInteger(code) || code < -1 || code > 2147483647)) throw new TypeError('Invalid xyo-cpp key code')
      deliver = () => engine.key!(mapped, down, code as number | undefined)
    } else if (device === 'mouse') {
      if (!engine.mouse) throw new Error('xyo-cpp engine does not support mouse input')
      const x = object?.x, y = object?.y, width = object?.canvasWidth, height = object?.canvasHeight
      if ([x, y, width, height].some(n => typeof n !== 'number' || !Number.isFinite(n)) || (width as number) <= 0 || (height as number) <= 0) throw new TypeError('xyo-cpp mouse input requires canvas-local coordinates and positive canvas dimensions')
      const buttons = object?.buttons
      if (buttons !== undefined && (typeof buttons !== 'number' || ![0, 1, 2, 4, 8, 16].includes(buttons))) throw new TypeError('xyo-cpp mouse input cannot represent multiple buttons')
      const inferred = buttons === 2 ? 2 : buttons === 4 ? 1 : buttons === 8 ? 3 : buttons === 16 ? 4 : 0
      const button = object?.button ?? inferred
      if (typeof button !== 'number' || !Number.isInteger(button) || button < 0 || button > 4) throw new TypeError('Invalid xyo-cpp mouse button')
      const down = object?.isDown === true || object?.down === true || (typeof buttons === 'number' && buttons !== 0)
      const dragged = object?.wasDragged === true
      mouseKey = `${down}:${button}:${dragged}`
      deliver = () => engine.mouse!(x as number, y as number, width as number, height as number, down, button, dragged)
    } else if (device === 'wheel' || device === 'mouseWheel') {
      if (!engine.wheel) throw new Error('xyo-cpp engine does not support wheel input')
      const dx = object?.deltaX ?? object?.dx ?? 0, dy = object?.deltaY ?? object?.dy
      if (typeof dx !== 'number' || !Number.isFinite(dx) || typeof dy !== 'number' || !Number.isFinite(dy)) throw new TypeError('Invalid xyo-cpp wheel input')
      deliver = () => engine.wheel!(dx, dy)
    } else if (device === 'answer') {
      if (!engine.answerIfQuestion) throw new Error('xyo-cpp engine does not support question identities')
      if (typeof data !== 'string') throw new TypeError('xyo-cpp answer must be a string')
      if (this.question === null || this.questionId === null || this.answering) return
      const questionId = this.questionId
      this.answering = true
      try { this.model.emit('QUESTION', { answer: data }) }
      catch (error) { notificationFailed = true; notificationError = error }
      // A listener can synchronously stop or replace the worker, with or without
      // throwing. Never queue an old answer into that newer generation.
      if (!this.current(deliveryGeneration) || !this.ready || this.engine !== engine || this.questionId !== questionId) {
        if (notificationFailed) throw notificationError
        return
      }
      // Even if a later UI listener threw, earlier listeners may have hidden the
      // prompt. Queue this exact answer before propagating the exception.
      // A stale answer is deliberately discarded by the worker; its next
      // snapshot exposes the current question without answering it by accident.
      deliver = async () => { await engine.answerIfQuestion!(questionId, data) }
    } else throw new Error(`xyo-cpp headless runtime does not support ${device} input`)
    let pending: { key: string; deliver: () => void | Promise<void> } | undefined
    if (mouseKey !== undefined) {
      const movement = this.mouseState === mouseKey
      this.mouseState = mouseKey
      if (movement && this.pendingMouse?.key === mouseKey) {
        this.pendingMouse.deliver = deliver
        return
      }
      this.pendingMouse = movement ? (pending = { key: mouseKey, deliver }) : undefined
    }
    const generation = deliveryGeneration
    this.enqueue(async () => {
      if (pending && this.pendingMouse === pending) this.pendingMouse = undefined
      if (!this.current(generation) || !this.ready) {
        if (!this.disposed) this.report(new Error('xyo-cpp input was invalidated before delivery'))
        return
      }
      await (pending ? pending.deliver() : deliver())
      if (!this.current(generation)) return
      const raw = await engine.snapshot()
      if (!this.current(generation)) return
      const fallbackCount = await this.readFallbackCount()
      if (!this.current(generation)) return
      const wasRunning = this.live?.running === true
      const live = this.overlay(this.baseline!, raw)
      const penBatch = this.preparePen(raw)
      this.validateQuestion(raw, device === 'answer')
      if (penBatch) applyXyoPenBatch(this.penRenderer!, penBatch)
      this.live = live
      this.postCommit(generation, () => this.checkFallback(fallbackCount))
      this.postCommit(generation, () => this.updateQuestion(raw, device === 'answer'))
      if (!wasRunning && live.running) this.postCommit(generation, () => this.model.emit('PROJECT_RUN_START', this.snapshot()))
      this.postCommit(generation, () => this.model.emit('RUNTIME_STEP', this.snapshot()))
    }, generation, mouseKey !== undefined)
    if (notificationFailed) throw notificationError
  }
  private preparePen(raw: unknown) {
    if (!raw || typeof raw !== 'object' || !('penEvents' in raw)) {
      if (this.penRenderer) throw new Error('Experimental pen transport is unavailable')
      return undefined
    }
    if (!this.penRenderer) throw new Error('Pen events received without an enabled renderer')
    return prepareXyoPenBatch((raw as { penEvents: unknown }).penEvents)
  }
  private overlay(baseline: RuntimeSnapshot, raw: unknown): RuntimeSnapshot {
    const input = raw as XyoSnapshot
    const snapshot = overlayXyoSnapshot(baseline, input)
    if (!Number.isInteger(input.threadCount) || input.threadCount < 0) throw new Error('Invalid xyo-cpp thread count')
    snapshot.running = input.threadCount > 0
    // The headless API exposes a count, not resumable thread identities.
    snapshot.threads = []
    return snapshot
  }
  private async readFallbackCount(): Promise<number | undefined> {
    const stats = this.engine?.stats ? await this.engine.stats() : this.engine?.compileStats
    if (stats === undefined) return undefined
    if (!stats || typeof stats !== 'object') throw new Error('Invalid xyo-cpp compile statistics')
    const nested = 'compileStats' in stats ? stats.compileStats : stats
    if (!nested || typeof nested !== 'object' || !('fallbacks' in nested) || typeof nested.fallbacks !== 'number' || !Number.isSafeInteger(nested.fallbacks) || nested.fallbacks < 0) throw new Error('Invalid xyo-cpp compile statistics')
    return nested.fallbacks
  }
  private checkFallback(count: number | undefined): void {
    if (count !== undefined && this.fallbackCount !== undefined && count > this.fallbackCount) {
      this.report(new Error('xyo-cpp compiled execution fell back to the interpreter (module-wide counter; attribution may be shared)'))
    }
    this.fallbackCount = count
  }
  /** Stop even if committing or notifying listeners fails. Keep the detached
   * live snapshot on commit failure so the user can retry without data loss. */
  private commitAndInvalidate(): void {
    let failed = false, failure: unknown
    try { if (this.live) this.commit() } catch (error) { failed = true; failure = error }
    try { this.invalidate(failed) } catch (error) { if (!failed) { failed = true; failure = error } }
    if (failed) throw failure
  }
  stopAll(): void {
    this.assertAlive()
    this.commitAndInvalidate()
  }
  settled(): Promise<void> { return this.pending }
  private snapshot(): RuntimeSnapshot {
    const model = this.model.snapshot()
    if (!this.live) return model
    return { ...structuredClone(this.live), selectedTargetId: model.selectedTargetId }
  }
  private exportProject() {
    const project = this.snapshot().project
    return { ...project, targets: project.targets.filter(t => !t.isClone) }
  }
  private async saveProjectSb3(): Promise<Uint8Array> {
    const project = this.exportProject()
    const archive = await this.model.saveProjectSb3()
    const files = unzipSync(archive)
    files['project.json'] = strToU8(JSON.stringify(project))
    return zipSync(files)
  }
  private async saveSpriteSb3(id?: string): Promise<Uint8Array> {
    const snapshot = this.snapshot()
    const targetId = id ?? snapshot.selectedTargetId
    const target = snapshot.project.targets.find(t => !t.isClone && (t.id === targetId || t.name === targetId))
    const archive = await this.model.saveSpriteSb3(targetId)
    if (!target || target.isStage) throw new Error(`Cannot export sprite ${targetId}`)
    const files = unzipSync(archive)
    files['sprite.json'] = strToU8(JSON.stringify(target, null, 2))
    return zipSync(files)
  }
  private commit(): void {
    if (!this.live || !this.baseline) return
    const edited = this.model.snapshot()
    const base = this.baseline
    const keys = ['variables', 'lists', 'x', 'y', 'direction', 'size', 'visible', 'currentCostume', 'layerOrder'] as const
    for (const target of edited.project.targets) {
      const old = base.project.targets.find(t => t.id === target.id && !t.isClone)
      const live = this.live.project.targets.find(t => t.id === target.id && !t.isClone)
      if (!old || !live) continue
      for (const key of keys) {
        if (key === 'variables' || key === 'lists') {
          const editedRecords = target[key], baseRecords = old[key], liveRecords = live[key]
          for (const id of Object.keys(editedRecords)) {
            if (Object.hasOwn(baseRecords, id) && Object.hasOwn(liveRecords, id) && JSON.stringify(editedRecords[id]) === JSON.stringify(baseRecords[id])) {
              Object.assign(editedRecords, { [id]: structuredClone(liveRecords[id]) })
            }
          }
        } else if (JSON.stringify(target[key]) === JSON.stringify(old[key])) Object.assign(target, { [key]: structuredClone(live[key]) })
      }
    }
    edited.running = false
    edited.threads = []
    this.committing = true
    try { this.model.commitRuntimeSnapshot(edited) } finally { this.committing = false }
  }
  dispose(): void {
    if (this.disposed) return
    let failed = false, failure: unknown
    try { if (this.live) this.commit() } catch (error) { failed = true; failure = error }
    try { this.clearQuestion() } catch (error) { if (!failed) { failed = true; failure = error } }
    this.disposed = true
    ++this.generation
    this.ready = false
    this.live = undefined
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    let interrupted = false
    try { interrupted = this.interrupt() } catch (error) { if (!failed) { failed = true; failure = error } }
    this.enqueue(async () => { if (!interrupted && this.engine) await this.engine.dispose() })
    try { this.model.quit() } catch (error) { if (!failed) { failed = true; failure = error } }
    if (failed) throw failure
  }
}
