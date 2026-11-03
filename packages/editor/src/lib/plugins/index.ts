import { runtimeBackends } from '../runtime-backends'
import { PluginHost } from './host'
import { turboWarpPlugin } from './turbowarp'
import type { XyoPlugin } from './types'

/**
 * Plugins shipped with the editor. They are installed on startup and can be
 * disabled from Settings → Plugins, but not removed.
 */
export const builtinPlugins: readonly XyoPlugin[] = [turboWarpPlugin]

/** Shared host for the standalone application. */
export const pluginHost = new PluginHost({ runtimes: runtimeBackends })

export function installBuiltinPlugins(host: PluginHost = pluginHost): void {
  for (const plugin of builtinPlugins) {
    if (host.has(plugin.manifest.id)) continue
    host.install(plugin, { source: 'builtin' })
  }
}

/** Installs and starts the bundled plugins. Safe to call more than once. */
export function initializeBuiltinPlugins(host: PluginHost = pluginHost): void {
  installBuiltinPlugins(host)
  host.activateAll()
}

/** Re-imports plugin URLs remembered from previous sessions. */
export async function restoreExternalPlugins(host: PluginHost = pluginHost): Promise<void> {
  await host.restoreExternalPlugins()
}

export { PluginHost, normalizePluginModule } from './host'
export type { PluginHostOptions } from './host'
export type {
  PluginContext,
  PluginEditorState,
  PluginHostBindings,
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
} from './types'
