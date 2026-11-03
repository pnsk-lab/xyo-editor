// Explicit fake registration: a fresh built-in VM/renderer pair stands in for an
// independently registered runtime. No TurboWarp code or network is involved.
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import { mount } from 'svelte'
import App from '../src/App.svelte'
import { runtimeBackends } from '../src/lib/runtime-backends'
import '../src/app.css'

runtimeBackends.register({
  id: 'fake',
  label: 'Fake VM',
  load: () => {
    sessionStorage.setItem(
      'fake-load-count',
      String(Number(sessionStorage.getItem('fake-load-count') || 0) + 1),
    )
    if (sessionStorage.getItem('fake-load-fails') === 'yes') throw new Error('fake load failure')
    return () => ({ vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() })
  },
})

mount(App, { target: document.getElementById('app')! })
