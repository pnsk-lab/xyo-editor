import { mount } from 'svelte'
import App from '../src/App.svelte'
import '../src/app.css'
import { PluginHost } from '../src/lib/plugins/host'
import { runtimeBackends } from '../src/lib/runtime-backends'

const host = new PluginHost({ runtimes: runtimeBackends })
host.install(
  {
    manifest: {
      id: 'demo-panel',
      name: 'Demo panel',
      version: '0.0.1',
      description: 'Browser fixture plugin',
    },
    activate(context) {
      context.tabs.add({
        id: 'panel',
        label: 'デモ',
        order: 5,
        mount(container, view) {
          const output = document.createElement('div')
          output.dataset.testid = 'plugin-view'
          container.append(output)
          const render = (state: { theme: string; running: boolean; snapshot: { project: { targets: unknown[] } } }) => {
            output.textContent = `theme=${state.theme} running=${state.running} sprites=${state.snapshot.project.targets.length}`
          }
          render(view.getState())
          return view.onStateChange(render)
        },
      })
      context.ui.notify('デモプラグインを有効にしました')
    },
  },
  { source: 'external' },
)
host.activateAll()

;(window as unknown as Record<string, unknown>).__pluginHost = host

mount(App, { target: document.getElementById('app')!, props: { plugins: host } })
