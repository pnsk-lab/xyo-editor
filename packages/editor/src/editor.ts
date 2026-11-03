import { mount } from 'svelte'
import './app.css'
import Editor from './Editor.svelte'
import { createEditorContext, type EditorContext, type EditorContextTab, type EditorHeaderButton, type EditorHeaderConfig, type EditorHeaderLogo } from './lib/editor-context'
import { initializeBuiltinPlugins, pluginHost, restoreExternalPlugins } from './lib/plugins'

export { createEditorContext, Editor }
export type { EditorContext, EditorContextTab, EditorHeaderButton, EditorHeaderConfig, EditorHeaderLogo }
export { DEFAULT_RUNTIME_BACKEND_ID, RUNTIME_BACKEND_STORAGE_KEY, RuntimeBackendRegistry, runtimeBackends } from './lib/runtime-backends'
export type { RuntimeBackend, RuntimeBackendFactory, RuntimeBackendInfo, RuntimeBackendRegistration, RuntimeBackendStorage, RuntimeRenderer, RuntimeVM } from './lib/runtime-backends'
export { builtinPlugins, initializeBuiltinPlugins, installBuiltinPlugins, PluginHost, pluginHost, restoreExternalPlugins } from './lib/plugins'
export type {
  PluginContext,
  PluginEditorState,
  PluginHostBindings,
  PluginHostOptions,
  PluginManifest,
  PluginNotificationKind,
  PluginRecordInfo,
  PluginSource,
  PluginStageState,
  PluginStatus,
  PluginStorage,
  PluginTab,
  PluginTabEntry,
  PluginTheme,
  PluginViewContext,
  XyoPlugin,
} from './lib/plugins'

export function renderEditor(target: HTMLElement, context: EditorContext = createEditorContext({ plugins: pluginHost })) {
  return mount(Editor, {
    target,
    props: {
      context,
    },
  })
}
