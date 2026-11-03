import type { RuntimeSnapshot } from '@hikkaku/vm'
import type {
  RuntimeBackendInfo,
  RuntimeBackendRegistration,
  RuntimeVM,
} from '../runtime-backends'

/** Colour scheme shared by the editor chrome and its block workspace. */
export type PluginTheme = 'light' | 'dark'

export type PluginSource = 'builtin' | 'external'

export type PluginStatus = 'inactive' | 'activating' | 'active' | 'error'

export type PluginManifest = {
  /** Stable identifier, for example `turbowarp` or `acme.stage-tools`. */
  id: string
  name: string
  description?: string
  version?: string
  author?: string
}

export type PluginNotificationKind = 'info' | 'success' | 'warning' | 'error'

/** Shape of the stage as it is currently displayed by the editor. */
export type PluginStageState = {
  width: number
  height: number
  fullscreen: boolean
}

/**
 * A read-only view of everything a plugin normally wants from the editor.
 * `snapshot` is the same object the editor renders from; treat it as immutable.
 */
export type PluginEditorState = {
  projectTitle: string
  theme: PluginTheme
  status: string
  fps: number
  running: boolean
  selectedTargetId: string
  stage: PluginStageState
  snapshot: RuntimeSnapshot
}

export type PluginViewContext = {
  readonly pluginId: string
  readonly tabId: string
  /** Edit-time VM (the same instance the editor drives). */
  readonly vm: RuntimeVM
  readonly theme: PluginTheme
  getState(): PluginEditorState
  onStateChange(listener: (state: PluginEditorState) => void): () => void
  onThemeChange(listener: (theme: PluginTheme) => void): () => void
  notify(message: string, kind?: PluginNotificationKind): void
}

/**
 * A tab contributed by a plugin.
 *
 * The editor mounts `mount` into an empty container when the tab becomes
 * visible and calls the returned function when the tab is hidden or removed.
 * Plugins therefore do not need to poll for visibility.
 */
export type PluginTab = {
  /** Unique within the owning plugin. Namespaced globally as `<pluginId>/<id>`. */
  id: string
  label: string
  /** An element (or a factory returning one) rendered in the tab bar. */
  icon?: Element | (() => Element)
  /** Lower values come first; defaults to 100 so plugin tabs follow built-ins. */
  order?: number
  mount(
    container: HTMLElement,
    context: PluginViewContext,
  ): void | (() => void)
}

export type PluginTabEntry = {
  /** Globally unique id: `<pluginId>/<tabId>`. */
  id: string
  pluginId: string
  tab: PluginTab
}

/**
 * Passed to `activate`. Contributions made here (tabs, runtimes, VM event
 * subscriptions, disposers) are removed automatically when the plugin is
 * disabled.
 */
export type PluginContext = {
  readonly manifest: Readonly<PluginManifest>
  /** Resolves once the editor has attached its VM. */
  whenReady(): Promise<void>
  /**
   * Edit-time VM. Throws until the editor is ready; `await whenReady()` first
   * if `activate` can run before the editor mounts.
   */
  readonly vm: RuntimeVM
  getState(): PluginEditorState
  subscribeState(listener: (state: PluginEditorState) => void): () => void
  onVmEvent<T = unknown>(
    event: string,
    listener: (payload: T, ...args: unknown[]) => void,
  ): () => void
  ui: {
    readonly theme: PluginTheme
    setTheme(theme: PluginTheme): void
    toggleTheme(): void
    subscribeTheme(listener: (theme: PluginTheme) => void): () => void
    notify(message: string, kind?: PluginNotificationKind): void
  }
  tabs: {
    add(tab: PluginTab): () => void
    list(): PluginTabEntry[]
  }
  runtimes: {
    register(registration: RuntimeBackendRegistration): () => void
    list(): RuntimeBackendInfo[]
  }
  /** JSON storage namespaced per plugin (`hikkaku.plugin.<id>.<key>`). */
  storage: {
    get<T>(key: string): T | undefined
    set(key: string, value: unknown): void
    remove(key: string): void
  }
  onDispose(disposer: () => void | Promise<void>): void
}

/**
 * A plugin is a plain object with a manifest and an `activate` function.
 *
 * ```js
 * export default {
 *   manifest: { id: 'hello', name: 'Hello' },
 *   activate(context) {
 *     context.tabs.add({ id: 'hello', label: 'Hello', mount: (el, view) => {
 *       el.textContent = `running: ${view.getState().running}`
 *       return view.onStateChange((state) => { el.textContent = `running: ${state.running}` })
 *     } })
 *   },
 * }
 * ```
 */
export type XyoPlugin = {
  manifest: PluginManifest
  activate(
    context: PluginContext,
  ): void | Promise<void> | (() => void | Promise<void>)
}

export type PluginRecordInfo = {
  manifest: Readonly<PluginManifest>
  source: PluginSource
  url?: string
  enabled: boolean
  status: PluginStatus
  error?: string
}

export type PluginHostBindings = {
  vm: RuntimeVM
  on(
    event: string,
    listener: (payload: unknown, ...args: unknown[]) => void,
  ): () => void
  getState(): PluginEditorState
  ui: {
    getTheme(): PluginTheme
    setTheme(theme: PluginTheme): void
    toggleTheme(): void
    notify(message: string, kind: PluginNotificationKind): void
  }
}

export type PluginStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
