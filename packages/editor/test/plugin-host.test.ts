import { describe, expect, it } from 'bun:test'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import { PluginHost } from '../src/lib/plugins/host'
import type { PluginEditorState, PluginHostBindings, PluginStorage, PluginTab, XyoPlugin } from '../src/lib/plugins/types'
import { RuntimeBackendRegistry } from '../src/lib/runtime-backends'

function memoryStorage(): PluginStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function editorState(theme: PluginEditorState['theme'] = 'light'): PluginEditorState {
  const snapshot = new ScratchVM().snapshot()
  return {
    projectTitle: 'Test',
    theme,
    status: 'Ready',
    fps: 30,
    running: false,
    selectedTargetId: snapshot.selectedTargetId,
    stage: { width: 480, height: 360, fullscreen: false },
    snapshot,
  }
}

function bindings(state = editorState()): PluginHostBindings {
  return {
    vm: new ScratchVM(),
    on: () => () => {},
    getState: () => state,
    ui: {
      getTheme: () => state.theme,
      setTheme: () => {},
      toggleTheme: () => {},
      notify: () => {},
    },
  }
}

const tab: PluginTab = {
  id: 'panel',
  label: 'Panel',
  mount() {
    return () => {}
  },
}

describe('plugin host', () => {
  it('activates a plugin and removes its contributions when disabled', async () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    const plugin: XyoPlugin = {
      manifest: { id: 'demo', name: 'Demo' },
      activate(context) {
        context.tabs.add(tab)
      },
    }

    host.install(plugin, { source: 'builtin' })
    await host.activate('demo')

    expect(host.list()[0]?.status).toBe('active')
    expect(host.listTabs().map((entry) => entry.id)).toEqual(['demo/panel'])

    await host.deactivate('demo')

    expect(host.list()[0]?.status).toBe('inactive')
    expect(host.listTabs()).toEqual([])
  })

  it('registers runtimes while active and frees the id again', async () => {
    const runtimes = new RuntimeBackendRegistry()
    const host = new PluginHost({ runtimes, storage: memoryStorage() })
    const plugin: XyoPlugin = {
      manifest: { id: 'runtime-demo', name: 'Runtime demo' },
      activate(context) {
        context.runtimes.register({
          id: 'demo-runtime',
          label: 'Demo runtime',
          load: () => () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() }),
        })
      },
    }

    host.install(plugin)
    await host.activate('runtime-demo')
    expect(runtimes.list().some((entry) => entry.id === 'demo-runtime')).toBe(true)

    await host.deactivate('runtime-demo')
    expect(runtimes.list().some((entry) => entry.id === 'demo-runtime')).toBe(false)

    // Re-activation must be able to reuse the same runtime id.
    await host.activate('runtime-demo')
    expect(runtimes.list().some((entry) => entry.id === 'demo-runtime')).toBe(true)
  })

  it('resolves whenReady only after the editor attaches', async () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    let ready = false
    host.install({
      manifest: { id: 'ready-demo', name: 'Ready demo' },
      activate(context) {
        void context.whenReady().then(() => {
          ready = true
        })
      },
    })

    await host.activate('ready-demo')
    expect(ready).toBe(false)

    host.attach(bindings())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toBe(true)
    expect(host.getState().projectTitle).toBe('Test')
  })

  it('publishes editor state and theme changes to subscribers', async () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    const themes: string[] = []
    const states: string[] = []
    host.install({
      manifest: { id: 'observer', name: 'Observer' },
      activate(context) {
        context.ui.subscribeTheme((theme) => themes.push(theme))
        context.subscribeState((state) => states.push(state.status))
      },
    })

    await host.activate('observer')
    host.attach(bindings())

    const nextState = { ...editorState('dark'), status: 'Running' }
    host.publishState(nextState)
    host.publishTheme('dark')

    expect(states).toContain('Running')
    expect(themes).toEqual(['light', 'dark'])
  })

  it('namespaces storage per plugin and persists disabled plugins', async () => {
    const storage = memoryStorage()
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage })
    const plugin: XyoPlugin = {
      manifest: { id: 'store-demo', name: 'Store demo' },
      activate(context) {
        context.storage.set('value', { count: 2 })
        expect(context.storage.get('value')).toEqual({ count: 2 })
        context.storage.remove('value')
        expect(context.storage.get('value')).toBeUndefined()
      },
    }

    host.install(plugin)
    await host.activate('store-demo')
    await host.setEnabled('store-demo', false)

    const restarted = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage })
    restarted.install(plugin)
    expect(restarted.list()[0]?.enabled).toBe(false)
  })

  it('rejects duplicate, invalid and malformed plugins', () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    const plugin: XyoPlugin = { manifest: { id: 'dup', name: 'Dup' }, activate() {} }
    host.install(plugin)

    expect(() => host.install(plugin)).toThrow('already installed')
    expect(() => host.install({ manifest: { id: 'bad id', name: 'Bad' }, activate() {} })).toThrow(
      'Invalid plugin ID',
    )
    expect(() =>
      host.install({ manifest: { id: 'no-name', name: '' }, activate() {} }),
    ).toThrow('must have a name')
  })

  it('reports activation failures without stopping other plugins', async () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    host.install({
      manifest: { id: 'broken', name: 'Broken' },
      activate() {
        throw new Error('boom')
      },
    })
    host.install({ manifest: { id: 'healthy', name: 'Healthy' }, activate() {} })

    await host.activate('broken')
    await host.activate('healthy')

    const broken = host.list().find((entry) => entry.manifest.id === 'broken')
    expect(broken?.status).toBe('error')
    expect(broken?.error).toBe('boom')
    expect(host.list().find((entry) => entry.manifest.id === 'healthy')?.status).toBe('active')
  })

  it('exposes the VM and state through a tab view context', () => {
    const host = new PluginHost({ runtimes: new RuntimeBackendRegistry(), storage: memoryStorage() })
    const state = editorState()
    const hostBindings = bindings(state)
    host.attach(hostBindings)

    const view = host.createViewContext('demo', tab)
    expect(view.pluginId).toBe('demo')
    expect(view.tabId).toBe('panel')
    expect(view.vm).toBe(hostBindings.vm)
    expect(view.getState()).toBe(state)
  })
})
