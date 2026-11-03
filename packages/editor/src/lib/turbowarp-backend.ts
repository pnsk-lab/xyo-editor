import type { RuntimeBackend } from './runtime-backends'
import type { TurboWarpScaffoldingNamespace } from './turbowarp-adapter'
import { createTurboWarpEngine, createTurboWarpEngineVM, type TurboWarpEngine } from './turbowarp-engine'
import { createTurboWarpRenderer } from './turbowarp-renderer'
import { TurboWarpRuntimeVM } from './turbowarp-runtime-vm'

/** Experimental integration; deliberately not registered until editor parity is complete. */
export function createTurboWarpBackend(namespace: TurboWarpScaffoldingNamespace): RuntimeBackend {
  const engineVM = createTurboWarpEngineVM(namespace)
  const adapter = new TurboWarpRuntimeVM(engineVM)
  let engine: TurboWarpEngine | undefined
  let transferred = false
  let disposed = false
  let frame: number | undefined
  let syncQueued = false
  let syncRevision = 0
  let disposal: Promise<void> | undefined

  // Defer/coalesce edits, and do not supersede a run requested in the meantime.
  const scheduleSync = () => {
    if (!engine || disposed) return
    // An edit can synchronously emit a nested PROJECT_CHANGED while the adapter
    // commits live state, before its revision changes. The outer notification
    // must update the queued revision rather than leave it permanently stale.
    syncRevision = adapter.revision
    if (syncQueued) return
    syncQueued = true
    queueMicrotask(() => {
      syncQueued = false
      if (!disposed && engine && syncRevision === adapter.revision) void adapter.syncProject().catch(() => {})
    })
  }
  const unlisten = [adapter.model.on('PROJECT_CHANGED', scheduleSync), adapter.model.on('PROJECT_LOADED', scheduleSync)]
  const renderer = createTurboWarpRenderer(function (canvas: HTMLCanvasElement) {
    if (disposed) throw new Error('TurboWarp backend is disposed')
    // Engine validates constructors before accepting ownership.
    for (const name of ['VM', 'Renderer', 'Storage', 'AudioEngine']) {
      if (typeof (namespace as unknown as Record<string, unknown>)[name] !== 'function') throw new Error(`TurboWarp Scaffolding is missing ${name}`)
    }
    // Engine takes ownership once construction has begun, including failures.
    transferred = true
    engine = createTurboWarpEngine(namespace, canvas, engineVM)
    try {
      adapter.bindRuntimeEvents(engineVM)
      engineVM.start()
      const tick = () => {
        if (disposed) return
        adapter.notifyFrame()
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      void adapter.syncProject().catch(() => {})
      return engine.renderer
    } catch (error) {
      void engine.dispose().catch(() => {})
      throw error
    }
  } as unknown as new (canvas: HTMLCanvasElement) => import('./turbowarp-renderer').TurboWarpRenderer, {
    // The official VM owns and updates the live scene, not the editing snapshot.
    syncSnapshot: () => {},
    getTargets: () => engineVM.runtime.targets.flatMap((value) => {
      const target = value as { id?: unknown; drawableID?: unknown; isStage?: boolean }
      if (typeof target.id !== 'string' || typeof target.drawableID !== 'number') return []
      // Originals use editor IDs; clones retain runtime IDs. Unmapped and
      // ambiguous targets, including stale scenes during loading, are omitted.
      const targetId = adapter.modelTargetId(target.id)
      return targetId === undefined ? [] : [{ targetId, drawableId: target.drawableID, isStage: target.isStage }]
    }),
    clearCachedCostumes: () => {},
  })

  return {
    vm: adapter.vm,
    renderer,
    executionDriver: 'backend',
    dispose() {
      if (disposal) return disposal
      disposed = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      for (const off of unlisten) off()
      renderer.dispose()
      adapter.dispose()
      disposal = adapter.settled().catch(() => {}).then(async () => {
        if (engine) await engine.dispose()
        else if (!transferred) {
          engineVM.stopAll()
          engineVM.clear()
          engineVM.quit()
        }
      })
      return disposal
    },
  }
}
