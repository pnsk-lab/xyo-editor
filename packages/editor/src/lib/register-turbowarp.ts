import type { RuntimeBackendRegistration, RuntimeBackendRegistry } from './runtime-backends'

export const TURBOWARP_BACKEND_ID = 'turbowarp'

/**
 * Metadata is available immediately; code and the official distribution load
 * only when the backend is selected.
 */
export const turboWarpRegistration: RuntimeBackendRegistration = {
  id: TURBOWARP_BACKEND_ID,
  label: 'TurboWarp',
  async load() {
    const [{ loadTurboWarpScaffolding }, { createTurboWarpBackend }] = await Promise.all([
      import('./turbowarp-loader'),
      import('./turbowarp-backend'),
    ])
    const namespace = await loadTurboWarpScaffolding()
    return () => createTurboWarpBackend(namespace)
  },
}

export function registerTurboWarpBackend(registry: RuntimeBackendRegistry): void {
  registry.register(turboWarpRegistration)
}
