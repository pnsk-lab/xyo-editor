import { describe, expect, it } from 'bun:test'
import { RuntimeBackendRegistry } from '../src/lib/runtime-backends'
import { registerTurboWarpBackend, TURBOWARP_BACKEND_ID } from '../src/lib/register-turbowarp'

describe('TurboWarp backend registration', () => {
  it('registers metadata without loading the browser-only distribution', async () => {
    const registry = new RuntimeBackendRegistry()
    registerTurboWarpBackend(registry)
    expect(registry.list().find((entry) => entry.id === TURBOWARP_BACKEND_ID)?.label).toBe(
      'TurboWarp',
    )
    // Bun has no browser; the error occurs only if this backend is actually selected.
    await expect(registry.create(TURBOWARP_BACKEND_ID)).rejects.toThrow(
      'only be loaded in a browser',
    )
    expect((await registry.create('scratch')).vm).toBeDefined()
  })
})
