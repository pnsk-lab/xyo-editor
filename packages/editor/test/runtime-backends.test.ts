import { describe, expect, it } from 'bun:test'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import {
  DEFAULT_RUNTIME_BACKEND_ID,
  RUNTIME_BACKEND_STORAGE_KEY,
  RuntimeBackendRegistry,
} from '../src/lib/runtime-backends'

function memoryStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === RUNTIME_BACKEND_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === RUNTIME_BACKEND_STORAGE_KEY) value = next
    },
  }
}

describe('runtime backend registry', () => {
  it('creates fresh Scratch VM and renderer pairs', async () => {
    const registry = new RuntimeBackendRegistry()
    const first = await registry.create(DEFAULT_RUNTIME_BACKEND_ID)
    const second = await registry.create(DEFAULT_RUNTIME_BACKEND_ID)
    expect(first.vm).toBeInstanceOf(ScratchVM)
    expect(first.renderer).toBeInstanceOf(ScratchCanvasRenderer)
    expect(first.vm).not.toBe(second.vm)
    expect(first.renderer).not.toBe(second.renderer)
  })

  it('loads a registered backend once concurrently and creates unattached pairs', async () => {
    const registry = new RuntimeBackendRegistry()
    let loads = 0
    let attached = 0
    registry.register({
      id: 'custom-vm',
      label: 'Custom',
      load: async () => {
        loads++
        return () => ({
          vm: {
            attachRenderer: () => {
              attached++
            },
          } as unknown as ScratchVM,
          renderer: {} as ScratchCanvasRenderer,
        })
      },
    })
    await Promise.all([registry.create('custom-vm'), registry.create('custom-vm')])
    expect(loads).toBe(1)
    expect(attached).toBe(0)
    expect(registry.list()).toEqual([
      { id: 'scratch', label: '現行 VM' },
      { id: 'custom-vm', label: 'Custom' },
    ])
  })

  it('caches availability probes and exposes the reason', async () => {
    const registry = new RuntimeBackendRegistry()
    let probes = 0
    registry.register({
      id: 'unbuilt',
      label: 'Unbuilt',
      probe: async () => {
        probes++
        throw new Error('artifacts missing')
      },
      unavailableReason: 'このビルドには同梱されていません',
      load: () => () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() }),
    })
    expect(await registry.probe('unbuilt')).toBe(false)
    expect(await registry.probe('unbuilt')).toBe(false)
    expect(probes).toBe(1)
    expect(registry.unavailableReason('unbuilt')).toBe('このビルドには同梱されていません')
    expect(await registry.probe('scratch')).toBe(true)
    expect(await registry.probe('unknown')).toBe(false)
  })

  it('rejects invalid, duplicate and unknown IDs', async () => {
    const registry = new RuntimeBackendRegistry()
    const load = () => () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() })
    for (const id of ['', 'Scratch', '../scratch', 'with space', '1vm']) {
      expect(() => registry.register({ id, label: 'X', load })).toThrow()
    }
    expect(() => registry.register({ id: 'scratch', label: 'X', load })).toThrow()
    expect(() => registry.setSelectedId('unknown', memoryStorage())).toThrow()
    await expect(registry.create('unknown')).rejects.toThrow()
  })

  it('retries a failed asynchronous load', async () => {
    const registry = new RuntimeBackendRegistry()
    let attempts = 0
    registry.register({
      id: 'retry',
      label: 'Retry',
      load: async () => {
        if (++attempts === 1) throw new Error('load failed')
        return () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() })
      },
    })
    await expect(registry.create('retry')).rejects.toThrow('load failed')
    await expect(registry.create('retry')).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it('persists known selections and safely handles unavailable or stale storage', () => {
    const registry = new RuntimeBackendRegistry()
    registry.register({
      id: 'custom',
      label: 'Custom',
      load: () => () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() }),
    })
    const storage = memoryStorage()
    expect(registry.setSelectedId('custom', storage)).toBe(true)
    expect(registry.getSelectedId(storage)).toBe('custom')
    expect(new RuntimeBackendRegistry().getSelectedId(storage)).toBe('scratch')
    expect(registry.getSelectedId(memoryStorage('../invalid'))).toBe('scratch')
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(registry.getSelectedId(blocked)).toBe('scratch')
    expect(registry.setSelectedId('scratch', blocked)).toBe(false)
  })
})
