import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'

/** Public surface only: alternative implementations need not share private fields. */
export type RuntimeVM = { [K in keyof ScratchVM]: ScratchVM[K] }
export type RuntimeRenderer = Pick<ScratchCanvasRenderer,
  'attachCanvas' | 'requestDraw' | 'dispose' | 'clearCachedCostumes' | 'pick' | 'getFencedPositionOfDrawable'
> & import('@hikkaku/vm').RendererFacade
export type RuntimeBackend = {
  vm: RuntimeVM
  renderer: RuntimeRenderer
  /** Only the built-in Scratch backend is currently compatible with this worker. */
  worker?: 'scratch'
  /** Self-scheduled engines must not also be stepped by the editor. */
  executionDriver?: 'editor' | 'backend'
  /** Release backend-owned resources other than the renderer, which the editor disposes. */
  dispose?: () => void | Promise<void>
  /** Last LLVM compilation: duration and how many units compiled / were considered. */
  llvmStats?: () => { ms: number; passed: number; total: number } | undefined
}
export type RuntimeBackendFactory = () => RuntimeBackend | Promise<RuntimeBackend>
export type RuntimeBackendRegistration = {
  id: string
  label: string
  /** Load code on demand; the returned factory creates a fresh pair per editor. */
  load: () => RuntimeBackendFactory | Promise<RuntimeBackendFactory>
  /** Optional availability check, run before the backend is offered. */
  probe?: () => Promise<void>
  /** Explanation shown when `probe` rejects, e.g. missing build artifacts. */
  unavailableReason?: string
}
export type RuntimeBackendInfo = Readonly<{ id: string; label: string }>
export type RuntimeBackendStorage = Pick<Storage, 'getItem' | 'setItem'>

export const DEFAULT_RUNTIME_BACKEND_ID = 'scratch'
export const RUNTIME_BACKEND_STORAGE_KEY = 'hikkaku.runtime-backend'

function validId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id)
}

function browserStorage(): RuntimeBackendStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Registry instances are independent, so hosts can register additional backends. */
export class RuntimeBackendRegistry {
  private readonly entries = new Map<string, RuntimeBackendRegistration>()
  private readonly factories = new Map<string, Promise<RuntimeBackendFactory>>()
  private readonly probes = new Map<string, Promise<boolean>>()

  constructor() {
    this.register({
      id: DEFAULT_RUNTIME_BACKEND_ID,
      label: '現行 VM',
      load: () => () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer(), worker: 'scratch' }),
    })
  }

  register(registration: RuntimeBackendRegistration): void {
    if (!validId(registration.id)) throw new Error(`Invalid runtime backend ID: ${registration.id}`)
    if (this.entries.has(registration.id)) throw new Error(`Runtime backend already registered: ${registration.id}`)
    if (!registration.label.trim()) throw new Error('Runtime backend label must not be empty')
    // Copy metadata so later caller mutation cannot corrupt registry keys.
    this.entries.set(registration.id, { ...registration })
    this.probes.delete(registration.id)
    this.factories.delete(registration.id)
  }

  unregister(id: string): boolean {
    if (!this.entries.delete(id)) return false
    this.factories.delete(id)
    this.probes.delete(id)
    return true
  }

  list(): RuntimeBackendInfo[] {
    return Array.from(this.entries.values(), ({ id, label }) => ({ id, label }))
  }

  /** Cached availability check; backends without a `probe` are always available. */
  probe(id: string): Promise<boolean> {
    const cached = this.probes.get(id)
    if (cached) return cached
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve(false)
    const pending = (async () => {
      if (!entry.probe) return true
      try {
        await entry.probe()
        return true
      } catch {
        return false
      }
    })()
    this.probes.set(id, pending)
    return pending
  }

  /** Why a backend is unavailable, when its registration declares a reason. */
  unavailableReason(id: string): string | undefined {
    return this.entries.get(id)?.unavailableReason
  }

  async create(id: string): Promise<RuntimeBackend> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown runtime backend: ${id}`)
    let loading = this.factories.get(id)
    if (!loading) {
      loading = Promise.resolve().then(() => entry.load())
      this.factories.set(id, loading)
      // A transient module loading failure must not permanently poison this entry.
      void loading.catch(() => { if (this.factories.get(id) === loading) this.factories.delete(id) })
    }
    const factory = await loading
    // The editor attaches the renderer after its canvas is available. Attaching
    // here as well would initialize a backend twice, possibly before mounting.
    return await factory()
  }

  /** Missing, invalid, unavailable and not-yet-registered selections use Scratch. */
  getSelectedId(storage: RuntimeBackendStorage | undefined = browserStorage()): string {
    try {
      const id = storage?.getItem(RUNTIME_BACKEND_STORAGE_KEY)
      return id && validId(id) && this.entries.has(id) ? id : DEFAULT_RUNTIME_BACKEND_ID
    } catch {
      return DEFAULT_RUNTIME_BACKEND_ID
    }
  }

  /** Returns false when persistence is unavailable; unknown IDs are always rejected. */
  setSelectedId(id: string, storage: RuntimeBackendStorage | undefined = browserStorage()): boolean {
    if (!validId(id) || !this.entries.has(id)) throw new Error(`Unknown runtime backend: ${id}`)
    if (!storage) return false
    try {
      storage.setItem(RUNTIME_BACKEND_STORAGE_KEY, id)
      return true
    } catch {
      return false
    }
  }
}

export const runtimeBackends = new RuntimeBackendRegistry()
