import { ScratchVM, type RuntimeSnapshot, type ScratchTarget } from '@hikkaku/vm'
import { strToU8, unzipSync, zipSync } from 'fflate'
import type { RuntimeVM } from './runtime-backends'
import { turboWarpSnapshot } from './turbowarp-snapshot'
import { createTurboWarpBlockExecution, type TurboWarpClickRuntime } from './turbowarp-block-execution'
import { createTurboWarpStep, type TurboWarpFrameLoop } from './turbowarp-step'

const snapshotEvents = new Set(['PROJECT_LOADED', 'PROJECT_CHANGED', 'TARGETS_UPDATE', 'WORKSPACE_UPDATE', 'MONITORS_UPDATE', 'BLOCKS_NEED_UPDATE', 'RUNTIME_STEP', 'PROJECT_START', 'PROJECT_RUN_START', 'PROJECT_RUN_STOP', 'RUNTIME_STARTED', 'RUNTIME_DISPOSED', 'TURBO_MODE_ON', 'TURBO_MODE_OFF'])

type EventListener = (payload: unknown, ...args: unknown[]) => void

const persistedRuntimeKeys: (keyof ScratchTarget)[] = ['variables', 'lists', 'currentCostume', 'volume', 'layerOrder', 'tempo', 'videoTransparency', 'videoState', 'visible', 'x', 'y', 'size', 'direction', 'draggable', 'rotationStyle', 'effects']

/** Merge only values unchanged by the editor; arrays are atomic on conflict. */
function mergeValue(base: unknown, edited: unknown, live: unknown): unknown {
  if (!base || !edited || !live || typeof base !== 'object' || typeof edited !== 'object' || typeof live !== 'object' || Array.isArray(base) || Array.isArray(edited) || Array.isArray(live)) {
    return JSON.stringify(base) === JSON.stringify(edited) ? structuredClone(live) : edited
  }
  const b = base as Record<string, unknown>, e = edited as Record<string, unknown>, l = live as Record<string, unknown>
  const result = { ...e }
  for (const key of Object.keys(b)) {
    if (Object.hasOwn(e, key) && Object.hasOwn(l, key)) result[key] = mergeValue(b[key], e[key], l[key])
  }
  return result
}

type Monitor = RuntimeSnapshot['project']['monitors'][number]

/** Merge by stable IDs only; an ambiguous or incompatible identity stays editor-owned. */
function mergeMonitors(base: Monitor[], edited: Monitor[], live: Monitor[], pairs: Map<string, string>): Monitor[] {
  const reverse = [...pairs].map(([model, runtime]) => [runtime, model] as const)
  const normalized = live.map(m => {
    const pair = reverse.find(([runtime]) => m.id.startsWith(`${runtime}:`))
    return pair ? { ...m, id: `${pair[1]}:${m.id.slice(pair[0].length + 1)}` } : m
  })
  const unique = (list: Monitor[], id: string) => list.filter(m => m.id === id)
  const identity = (a: Monitor, b: Monitor) => a.opcode === b.opcode && a.spriteName === b.spriteName && JSON.stringify(a.params) === JSON.stringify(b.params)
  const result: Monitor[] = []
  for (const monitor of edited) {
    const old = unique(base, monitor.id), current = unique(normalized, monitor.id)
    if (old.length !== 1 || unique(edited, monitor.id).length !== 1 || current.length > 1) { result.push(monitor); continue }
    if (!current.length) {
      // A different ID for the same monitor is not a trustworthy deletion.
      if (JSON.stringify(old[0]) !== JSON.stringify(monitor) || normalized.some(m => identity(old[0], m))) result.push(monitor)
      continue
    }
    if (!identity(old[0], current[0])) { result.push(monitor); continue }
    result.push(mergeValue(old[0], monitor, current[0]) as Monitor)
  }
  for (const monitor of normalized) {
    if (unique(normalized, monitor.id).length !== 1 || base.some(m => m.id === monitor.id || identity(m, monitor)) || edited.some(m => m.id === monitor.id || identity(m, monitor))) continue
    // An unrecognized target-prefixed ID cannot safely be persisted in the model.
    if (monitor.spriteName && !reverse.some(([, model]) => monitor.id.startsWith(`${model}:`)) && monitor.id.includes(':')) continue
    result.push(structuredClone(monitor))
  }
  return result
}

/** The host owns startup, scheduling and rendering of this injected VM. */
export interface TurboWarpRuntimeEngine {
  loadProject(data: Uint8Array): Promise<unknown>
  greenFlag(): void
  stopAll(): void
  postIOData(device: string, data: object): void
  setTurboMode(enabled: boolean): void
  setCompatibilityMode?(enabled: boolean): void
  setEditingTarget?(id: string): void
  startDrag?(id: string): void
  stopDrag?(id: string): void
  postSpriteInfo?(data: object): void
  runtime: { targets: unknown[] }
}

/**
 * Editing is delegated to ScratchVM. Execution is isolated in the injected engine.
 * A run captures an SB3; edits during capture/load are accepted but invalidate that
 * run, reported through ERROR and settled(). Inputs during loading are rejected
 * via ERROR rather than silently lost. Runtime state is a best-effort snapshot,
 * overlaid onto detached snapshots and committed with a three-way merge on stop
 * or edit. The host must arrange scheduling, rendering and per-frame calls to notifyFrame().
 * The host can connect runtime events with bindRuntimeEvents().
 */
export class TurboWarpRuntimeVM {
  readonly vm: RuntimeVM
  private pending: Promise<void> = Promise.resolve()
  private generation = 0
  private loading = false
  private active = false
  private disposed = false
  private live = false
  private turboMode = false
  private compatibilityMode: boolean | undefined
  private readonly subscriptions = new Set<() => void>()
  private mirroringDrag = false
  private draggingTargetId: string | undefined
  private baseline: RuntimeSnapshot | undefined
  private committing = false
  private blockExecution: ReturnType<typeof createTurboWarpBlockExecution> | undefined
  private stepper: ReturnType<typeof createTurboWarpStep> | undefined
  private readonly wrappedListeners = new Map<string, Map<EventListener, EventListener>>()

  constructor(readonly engine: TurboWarpRuntimeEngine, readonly model = new ScratchVM()) {
    const fail = (name: string): never => { throw new Error(`TurboWarp runtime does not support ${name}`) }
    const execution = new Set(['startHats', 'toggleScript', 'stopForTarget', 'dragSprite'])
    const self = this
    const invalidate = (projectReplaced = false) => {
      if (self.committing || self.mirroringDrag || (!self.loading && !self.active && !self.live)) return
      const busy = self.loading || self.active
      self.stepper?.requestStop()
      // PROJECT_CHANGED is emitted after editing: merge against the captured base
      // before invalidating. A replaced project must never inherit the old state.
      try {
        if (self.live && !projectReplaced) self.commitLiveState()
      } catch (error) {
        self.report(error)
        throw error
      } finally {
        ++self.generation
        self.clearBlockExecution()
        self.active = false
        self.loading = false
        self.live = false
        self.baseline = undefined
        if (busy) self.engine.stopAll()
      }
      if (busy) self.report(new Error('TurboWarp run invalidated by an edit; start again to run the edited project'))
    }
    this.subscriptions.add(this.model.on('PROJECT_CHANGED', () => invalidate()))
    this.subscriptions.add(this.model.on('PROJECT_LOADED', () => invalidate(true)))
    const runtime = new Proxy(this.model.runtime, {
      get(target, key, receiver) {
        if (key === 'greenFlag') return () => self.greenFlag()
        if (key === 'stopAll') return () => self.stopAll()
        if (key === 'setCompatibilityMode') return (enabled: boolean) => self.vm.setCompatibilityMode(enabled)
        if (key === 'toggleScript') return (id: string, target?: ScratchTarget | string) => self.clickBlock(id, target)
        if (key === 'startHats') return (opcode: string, fields?: Record<string, unknown>, target?: ScratchTarget | string) => self.startHats(opcode, fields, target)
        if (key === 'stopForTarget') return (target: ScratchTarget | string) => self.stopForTarget(target)
        if (key === 'ioDevices') return {
          ...target.ioDevices,
          mouse: { postData: (data: unknown) => self.input('mouse', data) },
          keyboard: { postData: (data: unknown) => self.input('keyboard', data) },
          mouseWheel: { postData: (data: unknown) => self.input('mouseWheel', data) },
          cloud: { ...target.ioDevices.cloud, postData: () => fail('cloud input') },
          video: { ...target.ioDevices.video, postData: () => fail('video input') },
        }
        return Reflect.get(target, key, receiver)
      },
      set(target, key, value, receiver) {
        if (key === 'turboMode') { self.vm.setTurboMode(value); return true }
        if (key === 'compatibilityMode') { self.vm.setCompatibilityMode(value); return true }
        return Reflect.set(target, key, value, receiver)
      },
    })
    this.vm = new Proxy(this.model, {
      get(target, key) {
        if (key === 'runtime') return runtime
        if (key === 'on') return (event: string, listener: EventListener) => self.on(event, listener)
        if (key === 'off') return (event: string, listener: EventListener) => self.off(event, listener)
        if (key === 'removeListener') return (event: string, listener: EventListener) => { self.off(event, listener); return self.vm }
        if (key === 'greenFlag') return () => self.greenFlag()
        if (key === 'stopAll') return () => self.stopAll()
        if (key === 'toggleScript' || key === 'reportBlockValue') return (id: string, target?: ScratchTarget | string) => self.clickBlock(id, target)
        if (key === 'dispose') return () => self.dispose()
        if (key === 'quit') return () => self.dispose()
        if (key === 'snapshot' || key === 'lightweightSnapshot') return () => self.snapshot()
        if (key === 'getTarget') return (id: string) => self.snapshot().project.targets.find(t => t.id === id || t.name === id)
        if (key === 'getStage' || key === 'getTargetForStage') return () => self.snapshot().project.targets.find(t => t.isStage)
        if (key === 'getSelectedTarget' || key === 'getEditingTarget' || key === 'editingTarget') {
          const selected = () => { const snap = self.snapshot(); return snap.project.targets.find(t => t.id === snap.selectedTargetId || t.name === snap.selectedTargetId) }
          return key === 'editingTarget' ? selected() ?? null : selected
        }
        if (key === 'getSpriteTargetByName') return (name: string) => self.snapshot().project.targets.find(t => !t.isStage && !t.isClone && t.name === name)
        if (key === 'exportProject') return () => self.exportProject()
        if (key === 'toJSON') return (id?: string) => JSON.stringify(id ? self.snapshot().project.targets.find(t => t.id === id || t.name === id) ?? null : self.exportProject(), null, 2)
        if (key === 'saveProjectSb3') return () => self.saveProjectSb3()
        if (key === 'saveSpriteSb3' || key === 'exportSprite') return (id?: string) => self.saveSpriteSb3(id)
        if (key === 'isRunning') return () => self.active && self.snapshot().running
        if (key === 'startHats' || key === 'startRuntimeHats') return (opcode: string, fields?: Record<string, unknown>, target?: ScratchTarget | string) => self.startHats(opcode, fields, target)
        if (key === 'stopForTarget') return (target: ScratchTarget | string) => self.stopForTarget(target)
        if (key === 'step') return () => self.step()
        if (key === 'startDrag') return (id: string) => self.startDrag(id)
        if (key === 'stopDrag') return (id?: string) => self.stopDrag(id)
        if (key === 'postSpriteInfo') return (data: unknown) => self.postSpriteInfo(data)
        if (key === 'postMouse') return (data: unknown) => self.input('mouse', data)
        if (key === 'postKeyboard') return (data: unknown) => self.input('keyboard', data)
        if (key === 'postWheel') return (data: unknown) => self.input('mouseWheel', data)
        if (key === 'postIOData') return (device: string, data: unknown) => self.input(device, data)
        if (key === 'setTurboMode') return (enabled: boolean) => { self.engine.setTurboMode(enabled); self.turboMode = enabled; self.model.setTurboMode(enabled) }
        if (key === 'setCompatibilityMode') return (enabled: boolean) => {
          if (!self.engine.setCompatibilityMode) return fail('compatibility mode')
          self.engine.setCompatibilityMode(enabled); self.compatibilityMode = enabled; self.model.setCompatibilityMode(enabled)
        }
        if (typeof key === 'string' && execution.has(key)) return () => fail(key)
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, key, value) { return Reflect.set(target, key, value, target) },
    }) as RuntimeVM
  }

  private on(event: string, listener: EventListener): () => void {
    if (!snapshotEvents.has(event)) return this.model.on(event, listener)
    let listeners = this.wrappedListeners.get(event)
    if (!listeners) this.wrappedListeners.set(event, listeners = new Map())
    let wrapped = listeners.get(listener)
    if (!wrapped) {
      wrapped = (payload, ...args) => {
        const value = payload as Partial<RuntimeSnapshot> | null
        const isSnapshot = value && typeof value === 'object' && value.project && typeof value.selectedTargetId === 'string' && typeof value.running === 'boolean' && Array.isArray(value.threads)
        listener(isSnapshot ? this.snapshot() : payload, ...args)
      }
      listeners.set(listener, wrapped)
    }
    const unsubscribe = this.model.on(event, wrapped)
    return () => {
      unsubscribe()
      if (listeners!.get(listener) === wrapped) listeners!.delete(listener)
      if (!listeners!.size) this.wrappedListeners.delete(event)
    }
  }

  private off(event: string, listener: EventListener): void {
    const listeners = this.wrappedListeners.get(event)
    const wrapped = listeners?.get(listener)
    if (wrapped) {
      this.model.off(event, wrapped)
      listeners!.delete(listener)
      if (!listeners!.size) this.wrappedListeners.delete(event)
    }
    this.model.off(event, listener)
  }

  private report(error: unknown): void {
    this.model.emit('ERROR', { error, message: error instanceof Error ? error.message : String(error) })
  }

  private clearBlockExecution(): void {
    this.blockExecution?.dispose()
    this.blockExecution = undefined
  }

  /** TW reports asynchronously via VISUAL_REPORT; neither click returns a synchronous value or thread. */
  private clickBlock(id: string, target?: ScratchTarget | string): undefined {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    if (this.loading || !this.live) throw new Error('TurboWarp project is not synchronized')
    if (!this.blockExecution) {
      const runtime = this.engine.runtime as Partial<TurboWarpClickRuntime>
      if (typeof runtime.toggleScript !== 'function' || typeof runtime.setEditingTarget !== 'function' || typeof runtime.on !== 'function' || typeof runtime.removeListener !== 'function') {
        throw new Error('TurboWarp runtime does not support block execution')
      }
      const generation = this.generation
      this.blockExecution = createTurboWarpBlockExecution({
        runtime: runtime as TurboWarpClickRuntime,
        runtimeTargetId: id => this.runtimeTargetId(id),
        isCurrent: () => !this.disposed && !this.loading && this.live && generation === this.generation,
        report: payload => this.model.emit('VISUAL_REPORT', payload),
      })
    }
    const targetId = typeof target === 'string' ? target : target?.id ?? this.model.snapshot().selectedTargetId
    this.blockExecution.click(id, targetId)
    return undefined
  }

  private executionTarget(target: ScratchTarget | string): any {
    const id = typeof target === 'string' ? target : target.id ?? target.name
    const runtimeId = this.runtimeTargetId(id)
    const resolved = this.engine.runtime.targets.find((candidate: any) => candidate.id === runtimeId)
    if (!resolved) throw new Error(`TurboWarp target cannot be mapped: ${id}`)
    return resolved
  }

  private requireSynchronized(): void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    if (this.loading || !this.live) throw new Error('TurboWarp project is not synchronized')
  }

  /** TW returns live threads (and undefined for unknown hats), not model snapshots. */
  private startHats(opcode: string, fields: Record<string, unknown> = {}, target?: ScratchTarget | string): RuntimeSnapshot['threads'] {
    this.requireSynchronized()
    const runtime = this.engine.runtime as any
    if (typeof runtime.startHats !== 'function') throw new Error('TurboWarp runtime does not support startHats')
    if (Object.values(fields).some(value => typeof value !== 'string')) throw new TypeError('TurboWarp hat match fields must be strings')
    const resolved = target === undefined ? undefined : this.executionTarget(target)
    const threads = runtime.startHats(opcode, { ...fields }, resolved)
    if (threads === undefined) throw new Error(`TurboWarp does not recognize hat opcode: ${opcode}`)
    if (!Array.isArray(threads)) throw new TypeError('TurboWarp startHats returned invalid threads')
    if (threads.length) this.active = true
    return turboWarpSnapshot({ runtime: { ...runtime, threads } }).threads
  }

  private stopForTarget(target: ScratchTarget | string): void {
    this.requireSynchronized()
    const runtime = this.engine.runtime as any
    if (typeof runtime.stopForTarget !== 'function') throw new Error('TurboWarp runtime does not support stopForTarget')
    const resolved = this.executionTarget(target)
    // The model removes this original's clones, but TW does not. Avoid a partial stop.
    if (resolved.isOriginal !== false && runtime.targets.some((candidate: any) => candidate.isOriginal === false && candidate.sprite === resolved.sprite)) {
      throw new Error('TurboWarp stopForTarget cannot match model clone removal')
    }
    runtime.stopForTarget(resolved)
  }

  /** Advance one full TurboWarp frame without competing with its frame loop. */
  private step(): void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    if (this.loading || !this.live) throw new Error('TurboWarp project is not synchronized')
    const runtime = this.engine.runtime as { frameLoop?: TurboWarpFrameLoop }
    const loop = runtime.frameLoop
    if (!loop || typeof loop.stop !== 'function' || typeof loop.start !== 'function' || typeof loop.stepCallback !== 'function') {
      throw new Error('TurboWarp runtime does not support single-frame stepping')
    }
    this.stepper ??= createTurboWarpStep({
      runtime: runtime as { frameLoop: TurboWarpFrameLoop },
      isDisposed: () => this.disposed,
      isLoading: () => this.loading,
    })
    const revision = this.generation
    this.stepper.step()
    this.notifyFrame(revision)
  }

  /** Synchronous editor API. Await settled() to observe asynchronous failure. */
  greenFlag(): void { this.queueProject(true) }

  /** Load the current editing project without starting scripts, for initial/stage rendering. */
  syncProject(): Promise<void> {
    this.queueProject(false)
    return this.settled()
  }

  private queueProject(runScripts: boolean): void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    this.stopAll()
    const generation = ++this.generation
    this.loading = true
    this.active = false
    this.live = false
    // Capture immediately, then serialize engine loads even after a failed request.
    const baseline = this.model.snapshot()
    const archive = this.model.saveProjectSb3()
    const run = this.pending.catch(() => {}).then(async () => {
      const bytes = await archive
      if (generation !== this.generation) throw new Error('TurboWarp run was superseded or stopped')
      await this.engine.loadProject(bytes)
      if (generation !== this.generation) throw new Error('TurboWarp run was superseded, stopped, or invalidated by an edit')
      this.engine.setTurboMode(this.turboMode)
      if (this.compatibilityMode !== undefined) this.engine.setCompatibilityMode!(this.compatibilityMode)
      this.baseline = baseline
      this.live = true
      this.active = runScripts
      this.loading = false
      if (runScripts) this.engine.greenFlag()
      if (generation !== this.generation) throw new Error('TurboWarp run was superseded, stopped, or invalidated by an edit')
      this.model.emit('TURBOWARP_PROJECT_SYNCED', this.snapshot())
    })
    this.pending = run.then(() => { if (generation === this.generation) this.loading = false }, error => {
      if (generation === this.generation) { this.loading = false; this.active = false; this.live = false; this.report(error) }
      throw error
    })
    // The editor's synchronous call does not consume a promise.
    void this.pending.catch(() => {})
  }

  settled(): Promise<void> { return this.pending }

  stopAll(): void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    this.stepper?.requestStop()
    const shouldCommit = this.live
    ++this.generation
    this.clearBlockExecution()
    this.loading = false
    this.active = false
    try {
      if (shouldCommit) this.commitLiveState()
    } catch (error) {
      this.report(error)
      throw error
    } finally {
      this.engine.stopAll()
    }
  }

  private input(device: string, data: unknown): void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    if (this.loading) {
      this.report(new Error('TurboWarp input cannot be delivered while a project is loading'))
      return
    }
    if (!data || typeof data !== 'object') throw new TypeError('TurboWarp input must be an object')
    if (device === 'keyboard') {
      // The editor uses Scratch key names, while TurboWarp expects DOM KeyboardEvent.key.
      const keys: Record<string, string> = { space: ' ', 'left arrow': 'ArrowLeft', 'right arrow': 'ArrowRight', 'up arrow': 'ArrowUp', 'down arrow': 'ArrowDown', enter: 'Enter' }
      const input = data as Record<string, unknown>
      const key = typeof input.key === 'string' ? (keys[input.key.toLowerCase()] ?? input.key) : input.key
      this.engine.postIOData(device, { ...input, key })
    } else {
      this.engine.postIOData(device, data)
    }
  }

  private commitLiveState(): void {
    if (!this.live || !this.baseline) return
    const baseline = this.baseline
    const edited = this.model.snapshot()
    const before = JSON.stringify(edited.project)
    const runtime = turboWarpSnapshot(this.engine)
    const pairs = this.targetPairs(runtime)
    const oldTargets = new Map(baseline.project.targets.filter(t => t.id).map(t => [t.id, t]))
    const runtimeTargets = new Map(runtime.project.targets.filter(t => !t.isClone && t.id).map(t => [t.id, t]))
    for (const target of edited.project.targets) {
      if (!target.id) continue
      const base = oldTargets.get(target.id)
      const current = runtimeTargets.get(pairs.get(target.id))
      if (!base || !current) continue
      for (const key of persistedRuntimeKeys) {
        if (current[key] !== undefined && base[key] !== undefined && target[key] !== undefined) {
          Object.assign(target, { [key]: mergeValue(base[key], target[key], current[key]) })
        }
      }
    }
    // An absent monitor state is not evidence that the runtime deleted monitors.
    if ((this.engine.runtime as { _monitorState?: unknown })._monitorState != null) {
      edited.project.monitors = mergeMonitors(baseline.project.monitors, edited.project.monitors, runtime.project.monitors, pairs)
    }
    // commitRuntimeSnapshot cannot accept executable threads; its purpose here is
    // persistence only, not restoring or restarting the editing model's runtime.
    edited.running = false
    edited.threads = []
    if (before === JSON.stringify(edited.project)) {
      this.baseline = edited
      return
    }
    this.committing = true
    try { this.model.commitRuntimeSnapshot(edited) } finally { this.committing = false }
    this.baseline = this.model.snapshot()
  }

  /** Export detached runtime values while preserving the model's assets and code. */
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
    // Capture both the live values and the model archive before yielding: deletion
    // or another edit can invalidate the runtime while the archive is pending.
    const snapshot = this.snapshot()
    const targetId = id ?? snapshot.selectedTargetId
    const target = snapshot.project.targets.find(t => !t.isClone && (t.id === targetId || t.name === targetId))
    const archive = await this.model.saveSpriteSb3(targetId)
    if (!target || target.isStage) throw new Error(`Cannot export sprite ${targetId}`)
    const files = unzipSync(archive)
    files['sprite.json'] = strToU8(JSON.stringify(target, null, 2))
    return zipSync(files)
  }

  private targetPairs(live: RuntimeSnapshot): Map<string, string> {
    const modelTargets = (this.baseline ?? this.model.snapshot()).project.targets.filter(t => !t.isClone)
    const runtimeTargets = live.project.targets.filter(t => !t.isClone)
    const pairs = new Map<string, string>()
    for (const target of modelTargets) {
      const candidates = runtimeTargets.filter(t => target.isStage ? t.isStage : !t.isStage && t.name === target.name)
      const modelMatches = modelTargets.filter(t => target.isStage ? t.isStage : !t.isStage && t.name === target.name)
      if (target.id && candidates.length === 1 && modelMatches.length === 1 && candidates[0].id) pairs.set(target.id, candidates[0].id!)
    }
    return pairs
  }

  /** Map editor IDs to TW IDs. Runtime clones retain their TW IDs in snapshots. */
  runtimeTargetId(id: string): string | undefined {
    if (!this.live) return undefined
    const live = turboWarpSnapshot(this.engine)
    if (live.project.targets.some(t => t.isClone && t.id === id)) return id
    const target = this.model.getTarget(id)
    return target?.id ? this.targetPairs(live).get(target.id) : undefined
  }

  /** Map TW IDs back to the editor IDs used by snapshot and renderer picking. */
  modelTargetId(id: string): string | undefined {
    if (!this.live) return undefined
    const live = turboWarpSnapshot(this.engine)
    if (live.project.targets.some(t => t.isClone && t.id === id)) return id
    return [...this.targetPairs(live)].find(([, runtimeId]) => runtimeId === id)?.[0]
  }

  private startDrag(id: string): void {
    this.draggingTargetId = id
    this.model.startDrag(id)
    const runtimeId = this.runtimeTargetId(id)
    if (!runtimeId) return
    if (!this.engine.startDrag) { this.report(new Error('TurboWarp engine does not support startDrag')); return }
    this.engine.startDrag(runtimeId)
  }

  private stopDrag(id = this.draggingTargetId ?? ''): void {
    this.model.stopDrag(id)
    this.draggingTargetId = undefined
    const runtimeId = this.runtimeTargetId(id)
    if (!runtimeId) return
    if (!this.engine.stopDrag) { this.report(new Error('TurboWarp engine does not support stopDrag')); return }
    this.engine.stopDrag(runtimeId)
  }

  private postSpriteInfo(data: unknown): void {
    if (!data || typeof data !== 'object') throw new TypeError('Sprite info must be an object')
    const value = data as Record<string, unknown>
    const id = String(value.targetId ?? value.id ?? value.name ?? this.draggingTargetId ?? this.model.snapshot().selectedTargetId)
    const runtimeId = this.runtimeTargetId(id)
    // Only suppress invalidation when both sides can be updated. Otherwise the
    // edit stays in the model and invalidates the stale engine as usual.
    if (runtimeId && this.engine.setEditingTarget && this.engine.postSpriteInfo && !this.loading) {
      this.engine.setEditingTarget(runtimeId)
      this.engine.postSpriteInfo({ ...value, targetId: runtimeId })
      this.mirroringDrag = true
      try { this.model.postSpriteInfo(data) } finally { this.mirroringDrag = false }
    } else {
      this.model.postSpriteInfo(data)
      if (this.live) this.report(new Error('TurboWarp sprite position could not be synchronized'))
    }
  }

  /** Host frame callbacks should pass the revision captured when they were scheduled. */
  get revision(): number { return this.generation }

  /** Returns false for disposed, loading, stale or invalidated runtime notifications. */
  notifyFrame(revision = this.generation): boolean {
    return this.notifyRuntimeEvent('RUNTIME_STEP', revision)
  }

  notifyRuntimeEvent(event: 'RUNTIME_STEP' | 'TARGETS_UPDATE' | 'MONITORS_UPDATE' | 'PROJECT_RUN_START' | 'PROJECT_RUN_STOP', revision = this.generation): boolean {
    if (this.disposed || this.loading || !this.live || revision !== this.generation) return false
    if (event === 'PROJECT_RUN_START') this.active = true
    if (event === 'PROJECT_RUN_STOP') this.active = false
    this.model.emit(event, this.snapshot())
    return true
  }

  /** Subscribe to TW runtime events; caller continues to supply frame notifications. */
  bindRuntimeEvents(source: { on(event: string, listener: (...args: unknown[]) => void): unknown; removeListener(event: string, listener: (...args: unknown[]) => void): unknown }): () => void {
    if (this.disposed) throw new Error('TurboWarp runtime is disposed')
    const events = ['TARGETS_UPDATE', 'MONITORS_UPDATE', 'PROJECT_RUN_START', 'PROJECT_RUN_STOP'] as const
    const listeners = events.map(event => {
      const listener = () => { this.notifyRuntimeEvent(event) }
      source.on(event, listener)
      return { event, listener }
    })
    let bound = true
    const unsubscribe = () => {
      if (!bound) return
      bound = false
      this.subscriptions.delete(unsubscribe)
      for (const { event, listener } of listeners) source.removeListener(event, listener)
    }
    this.subscriptions.add(unsubscribe)
    return unsubscribe
  }

  private snapshot(): RuntimeSnapshot {
    const model = this.model.snapshot()
    if (!this.live) return model
    const live = turboWarpSnapshot(this.engine)
    const liveOriginals = live.project.targets.filter(t => !t.isClone)
    const originals = new Map(liveOriginals.filter(t => t.id).map(t => [t.id, t]))
    const pairs = this.targetPairs(live)
    const reverse = new Map([...pairs].map(([modelId, runtimeId]) => [runtimeId, modelId]))
    const baselineTargets = new Map((this.baseline ?? model).project.targets.filter(t => t.id).map(t => [t.id, t]))
    const targets = model.project.targets.map(target => {
      const runtime = target.id ? originals.get(pairs.get(target.id)) : undefined
      if (!runtime) return target
      const merged = { ...target }
      const base = baselineTargets.get(target.id)
      for (const key of persistedRuntimeKeys) {
        if (runtime[key] !== undefined && base?.[key] !== undefined && target[key] !== undefined) {
          Object.assign(merged, { [key]: mergeValue(base[key], target[key], runtime[key]) })
        }
      }
      if (runtime.drawableId !== undefined) merged.drawableId = runtime.drawableId
      return merged
    })
    targets.push(...live.project.targets.filter(t => t.isClone).map(t => ({ ...t, cloneOf: t.cloneOf ? reverse.get(t.cloneOf) ?? t.cloneOf : undefined })))
    return { ...live, running: this.active && live.running, threads: this.active ? live.threads : [], selectedTargetId: model.selectedTargetId, project: { ...model.project, targets, monitors: live.project.monitors } }
  }

  dispose(): void {
    if (this.disposed) return
    this.stopAll()
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions.clear()
    for (const [event, listeners] of this.wrappedListeners) for (const wrapped of listeners.values()) this.model.off(event, wrapped)
    this.wrappedListeners.clear()
    this.model.quit()
  }
}
