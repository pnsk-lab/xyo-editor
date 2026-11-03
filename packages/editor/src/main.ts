import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initializeBuiltinPlugins, pluginHost } from './lib/plugins'
import { runtimeBackends } from './lib/runtime-backends'
import { registerXyoBackend } from './lib/register-xyo'

// Built-in plugins register their contributions synchronously, so runtimes they
// provide are available before the editor reads the saved selection.
initializeBuiltinPlugins()
registerXyoBackend(runtimeBackends)

const app = mount(App, {
  target: document.getElementById('app')!,
  props: { plugins: pluginHost },
})

export default app
