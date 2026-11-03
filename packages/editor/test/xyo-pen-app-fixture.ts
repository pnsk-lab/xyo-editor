// Browser E2E only: a private registry entry points at private WASM artifacts.
import { mount } from 'svelte'
import App from '../src/App.svelte'
import { runtimeBackends } from '../src/lib/runtime-backends'
import { createXyoBackend } from '../src/lib/xyo-backend'
import '../src/app.css'

runtimeBackends.register({
  id: 'pen-isolated',
  label: 'Isolated pen test',
  load: () => () =>
    createXyoBackend(
      () => new Worker(new URL('./xyo-pen-worker.ts', import.meta.url), { type: 'module' }),
      { experimentalPen: true },
    ),
})
mount(App, { target: document.getElementById('app')! })
