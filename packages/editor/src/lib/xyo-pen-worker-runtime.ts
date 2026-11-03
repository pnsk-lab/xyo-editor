import type { PenBridge } from '../../../xyo-cpp-wasm/src/pen-bridge'
import type { XyoWorkerRuntime } from './xyo-worker-protocol'

/** Isolated opt-in decorator. Production entrypoints do not install this adapter. */
export function withXyoPenSnapshots(runtime: XyoWorkerRuntime, pen: PenBridge): XyoWorkerRuntime {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === 'snapshot') return async () => {
        const snapshot = await target.snapshot()
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid xyo-cpp snapshot')
        // Copy and consume only after WASM snapshot has returned. A failed drain
        // rejects the entire snapshot, and therefore publishes no partial batch.
        const penEvents = pen.drain()
        return { ...snapshot, penEvents }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
