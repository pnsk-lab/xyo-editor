import { mount } from 'svelte'
import App from '../src/App.svelte'
import '../src/app.css'
import { PluginHost } from '../src/lib/plugins/host'

const host = new PluginHost()
host.install(
  {
    manifest: {
      id: 'select-audit-probe',
      name: 'Select audit probe',
      version: '0.0.1',
      description: 'Test-only plugin exposing the editor VM for external-write audits.',
    },
    activate(context) {
      context.tabs.add({
        id: 'audit-probe',
        label: 'Audit',
        order: 9999,
        mount(container, view) {
          ;(window as unknown as { __auditProbe?: unknown }).__auditProbe = { view }
          const marker = document.createElement('div')
          marker.dataset.testid = 'audit-probe-ready'
          container.append(marker)
          return () => {}
        },
      })
    },
  },
  { source: 'external' },
)
host.activateAll()

;(window as unknown as { __pluginHost?: unknown }).__pluginHost = host

mount(App, { target: document.getElementById('app')!, props: { plugins: host } })
