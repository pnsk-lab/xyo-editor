import { mount } from 'svelte'
import App from '../src/App.svelte'
import '../src/app.css'
import { runtimeBackends } from '../src/lib/runtime-backends'
import { loadTurboWarpScaffolding } from '../src/lib/turbowarp-loader'
import { createTurboWarpBackend } from '../src/lib/turbowarp-backend'

runtimeBackends.register({
  id: 'tw',
  label: 'TurboWarp test',
  async load() {
    const namespace = await loadTurboWarpScaffolding()
    return () => {
      const backend = createTurboWarpBackend(namespace)
      ;(window as any).__twBackend = backend
      return backend
    }
  },
})
mount(App, { target: document.getElementById('app')! })
