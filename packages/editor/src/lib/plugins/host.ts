import {
  runtimeBackends,
  type RuntimeBackendInfo,
  type RuntimeBackendRegistration,
  type RuntimeBackendRegistry,
} from '../runtime-backends'
import type {
  PluginContext,
  PluginEditorState,
  PluginHostBindings,
  PluginManifest,
  PluginNotificationKind,
  PluginRecordInfo,
  PluginSource,
  PluginStatus,
  PluginStorage,
  PluginTab,
  PluginTabEntry,
  PluginTheme,
  PluginViewContext,
  XyoPlugin,
} from './types'

export const PLUGIN_DISABLED_STORAGE_KEY = 'hikkaku.plugins.disabled'
export const PLUGIN_URLS_STORAGE_KEY = 'hikkaku.plugins.urls'
export const PLUGIN_STORAGE_PREFIX = 'hikkaku.plugin.'

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const PLUGIN_TAB_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

type Disposer = () => void | Promise<void>

type Activation = {
  disposers: Disposer[]
}

type PluginRecord = {
  plugin: XyoPlugin
  source: PluginSource
  url?: string
  enabled: boolean
  status: PluginStatus
  error?: string
  disposers: Disposer[]
  activation?: Activation
  activationPromise?: Promise<void>
}

export type PluginHostOptions = {
  /** Registry that plugin runtimes are added to. Defaults to the editor registry. */
  runtimes?: RuntimeBackendRegistry
  /** Defaults to `localStorage` when it is available. */
  storage?: PluginStorage
}

type ManifestInput = Partial<PluginManifest>

function normalizeManifest(input: unknown): Readonly<PluginManifest> {
  if (!input || typeof input !== 'object') {
    throw new Error('Plugin manifest is missing')
  }
  const value = input as ManifestInput
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(`Invalid plugin ID: ${JSON.stringify(value.id)}`)
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) throw new Error(`Plugin "${id}" must have a name`)
  const manifest: PluginManifest = { id, name }
  for (const key of ['description', 'version', 'author'] as const) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) manifest[key] = field.trim()
  }
  return Object.freeze(manifest)
}

function isValidTabId(id: string): boolean {
  return PLUGIN_TAB_ID_PATTERN.test(id)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultStorage(): PluginStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

async function runDisposers(disposers: Disposer[]): Promise<void> {
  // Later contributions may depend on earlier ones, so unwind in reverse.
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    const dispose = disposers[index]
    if (!dispose) continue
    try {
      await dispose()
    } catch (error) {
      console.warn('[plugins] disposer failed', error)
    }
  }
}

/**
 * Owns plugin lifecycle and exposes the editor to active plugins.
 *
 * The host is deliberately small: it does not sandbox plugin code. A plugin is
 * ordinary JavaScript with the same privileges as the page, so only install
 * code from sources you trust.
 */
export class PluginHost {
  private readonly records = new Map<string, PluginRecord>()
  private readonly tabEntries: PluginTabEntry[] = []
  private readonly tabListeners = new Set<(tabs: PluginTabEntry[]) => void>()
  private readonly recordListeners = new Set<(plugins: PluginRecordInfo[]) => void>()
  private readonly stateListeners = new Set<(state: PluginEditorState) => void>()
  private readonly themeListeners = new Set<(theme: PluginTheme) => void>()
  private readonly disabled = new Set<string>()
  private readonly runtimes: RuntimeBackendRegistry
  private readonly storage?: PluginStorage
  private readonly ready: Promise<void>
  private resolveReady!: (value?: void | PromiseLike<void>) => void
  private readyResolved = false
  private bindings?: PluginHostBindings
  private state?: PluginEditorState
  private theme: PluginTheme = 'light'
  private disposed = false
  private restoreTask?: Promise<void>

  constructor(options: PluginHostOptions = {}) {
    this.runtimes = options.runtimes ?? runtimeBackends
    this.storage = options.storage ?? defaultStorage()
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
    for (const id of this.readStringArray(PLUGIN_DISABLED_STORAGE_KEY)) {
      this.disabled.add(id)
    }
  }

  /** Installs a plugin without activating it. Throws on invalid or duplicate IDs. */
  install(
    plugin: XyoPlugin,
    options: { source?: PluginSource; url?: string } = {},
  ): PluginRecordInfo {
    const manifest = normalizeManifest(plugin.manifest)
    if (typeof plugin.activate !== 'function') {
      throw new Error(`Plugin "${manifest.id}" must define activate(context)`)
    }
    if (this.records.has(manifest.id)) {
      throw new Error(`Plugin is already installed: ${manifest.id}`)
    }
    const record: PluginRecord = {
      plugin: { manifest, activate: plugin.activate.bind(plugin) },
      source: options.source ?? 'external',
      url: options.url,
      enabled: !this.disabled.has(manifest.id),
      status: 'inactive',
      disposers: [],
    }
    this.records.set(manifest.id, record)
    this.notifyRecords()
    return this.describe(record)
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  /** Starts every enabled, inactive plugin. Activation errors are captured per plugin. */
  activateAll(): void {
    for (const [id, record] of this.records) {
      if (!record.enabled || record.status === 'active' || record.status === 'activating') continue
      void this.activate(id)
    }
  }

  async activate(id: string): Promise<void> {
    const record = this.requireRecord(id)
    if (this.disposed || !record.enabled) return
    if (record.status === 'active' || record.status === 'activating') return

    const activation: Activation = { disposers: [] }
    record.activation = activation
    record.status = 'activating'
    record.error = undefined
    this.notifyRecords()

    const context = this.createContext(record, activation)
    const activationPromise = (async () => {
      try {
        const disposer = await record.plugin.activate(context)
        if (typeof disposer === 'function') activation.disposers.push(disposer)
        if (record.activation !== activation || !record.enabled || this.disposed) {
          // Disabled (or the host was disposed) while activate() was awaiting.
          await runDisposers(activation.disposers)
          return
        }
        record.disposers.push(...activation.disposers)
        record.status = 'active'
      } catch (error) {
        await runDisposers(activation.disposers)
        if (record.activation === activation) {
          record.status = 'error'
          record.error = errorMessage(error)
          console.error(`[plugins] failed to activate "${id}"`, error)
        }
      } finally {
        if (record.activation === activation) {
          record.activationPromise = undefined
          this.notifyRecords()
        }
      }
    })()
    record.activationPromise = activationPromise
    await activationPromise
  }

  async deactivate(id: string): Promise<void> {
    const record = this.requireRecord(id)
    const activation = record.activation
    record.activation = undefined
    record.status = 'inactive'
    record.error = undefined
    this.notifyRecords()
    if (activation) {
      // An in-flight activate() notices the activation mismatch and unwinds itself.
      await record.activationPromise
    }
    await runDisposers(record.disposers.splice(0))
    this.notifyRecords()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.requireRecord(id)
    // Enabling an already-enabled plugin retries an activation that failed.
    if (record.enabled === enabled && record.status !== 'error') return
    record.enabled = enabled
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    this.persistDisabled()
    this.notifyRecords()
    if (enabled) await this.activate(id)
    else await this.deactivate(id)
  }

  async uninstall(id: string): Promise<void> {
    const record = this.requireRecord(id)
    if (record.source === 'builtin') {
      throw new Error(`Built-in plugins cannot be removed: ${id}`)
    }
    await this.deactivate(id)
    this.records.delete(id)
    this.disabled.delete(id)
    this.persistDisabled()
    if (record.url) this.removeUrl(record.url)
    this.notifyRecords()
  }

  /** Imports a plugin module from an http(s) URL and activates it. */
  async installFromUrl(url: string): Promise<PluginRecordInfo> {
    const trimmed = url.trim()
    if (!trimmed) throw new Error('Plugin URL is empty')
    let resolved: URL
    try {
      const base = globalThis.location?.href ?? 'http://localhost/'
      resolved = new URL(trimmed, base)
    } catch {
      throw new Error(`Invalid plugin URL: ${trimmed}`)
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      throw new Error('Plugins must be loaded over http(s)')
    }
    const module = (await import(/* @vite-ignore */ resolved.href)) as unknown
    const plugin = normalizePluginModule(module)
    const record = this.install(plugin, { source: 'external', url: resolved.href })
    // Remember the URL even when the plugin is disabled, so it stays listed.
    this.saveUrl(resolved.href)
    if (this.records.get(record.manifest.id)?.enabled) {
      await this.activate(record.manifest.id)
    }
    return this.describe(this.requireRecord(record.manifest.id))
  }

  /**
   * Re-imports plugin URLs saved by previous sessions. Concurrent and repeated
   * calls share one task. Failures are reported to the console and do not
   * prevent the editor from starting.
   */
  restoreExternalPlugins(): Promise<void> {
    this.restoreTask ??= this.restoreInstalled()
    return this.restoreTask
  }

  private async restoreInstalled(): Promise<void> {
    for (const url of this.readStringArray(PLUGIN_URLS_STORAGE_KEY)) {
      if ([...this.records.values()].some((record) => record.url === url)) continue
      try {
        await this.installFromUrl(url)
      } catch (error) {
        console.warn(`[plugins] could not restore "${url}"`, error)
      }
    }
  }

  list(): PluginRecordInfo[] {
    return [...this.records.values()]
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
        return a.plugin.manifest.name.localeCompare(b.plugin.manifest.name)
      })
      .map((record) => this.describe(record))
  }

  subscribe(listener: (plugins: PluginRecordInfo[]) => void): () => void {
    this.recordListeners.add(listener)
    listener(this.list())
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  listTabs(): PluginTabEntry[] {
    return [...this.tabEntries]
  }

  subscribeTabs(listener: (tabs: PluginTabEntry[]) => void): () => void {
    this.tabListeners.add(listener)
    listener([...this.tabEntries])
    return () => {
      this.tabListeners.delete(listener)
    }
  }

  /** Attaches the running editor. Resolves every plugin's `whenReady()`. */
  attach(bindings: PluginHostBindings): void {
    this.bindings = bindings
    this.state = bindings.getState()
    if (!this.readyResolved) {
      this.readyResolved = true
      this.resolveReady()
    }
    this.notifyState()
    const theme = bindings.ui.getTheme()
    if (theme !== this.theme) {
      this.theme = theme
      this.notifyTheme()
    }
  }

  detach(): void {
    this.bindings = undefined
  }

  /** Called by the editor whenever its observable state changes. */
  publishState(state: PluginEditorState): void {
    this.state = state
    this.notifyState()
  }

  /** Called by the editor after it applied a theme. */
  publishTheme(theme: PluginTheme): void {
    if (this.theme === theme) return
    this.theme = theme
    this.notifyTheme()
  }

  getState(): PluginEditorState {
    if (this.state) return this.state
    if (this.bindings) return this.bindings.getState()
    throw new Error('The editor is not ready yet; await context.whenReady() first')
  }

  getTheme(): PluginTheme {
    return this.theme
  }

  subscribeState(listener: (state: PluginEditorState) => void): () => void {
    this.stateListeners.add(listener)
    if (this.state) listener(this.state)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  subscribeTheme(listener: (theme: PluginTheme) => void): () => void {
    this.themeListeners.add(listener)
    listener(this.getTheme())
    return () => {
      this.themeListeners.delete(listener)
    }
  }

  createViewContext(pluginId: string, tab: PluginTab): PluginViewContext {
    const host = this
    return {
      pluginId,
      tabId: tab.id,
      get vm() {
        return host.requireVm()
      },
      get theme() {
        return host.getTheme()
      },
      getState: () => host.getState(),
      onStateChange: (listener) => host.subscribeState(listener),
      onThemeChange: (listener) => host.subscribeTheme(listener),
      notify: (message, kind = 'info') => host.notify(pluginId, message, kind),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.records.keys()]) {
      try {
        await this.deactivate(id)
      } catch {
        // Records without state are already gone; disposal must not throw.
      }
    }
    this.bindings = undefined
    this.stateListeners.clear()
    this.themeListeners.clear()
    this.tabListeners.clear()
    this.recordListeners.clear()
  }

  private requireRecord(id: string): PluginRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`Unknown plugin: ${id}`)
    return record
  }

  private requireVm() {
    if (!this.bindings) {
      throw new Error('The editor VM is not ready yet; await context.whenReady() first')
    }
    return this.bindings.vm
  }

  private describe(record: PluginRecord): PluginRecordInfo {
    const info: PluginRecordInfo = {
      manifest: record.plugin.manifest,
      source: record.source,
      enabled: record.enabled,
      status: record.status,
    }
    if (record.url) info.url = record.url
    if (record.error) info.error = record.error
    return info
  }

  private createContext(record: PluginRecord, activation: Activation): PluginContext {
    const host = this
    const pluginId = record.plugin.manifest.id
    const addDisposer = (disposer: Disposer) => {
      activation.disposers.push(disposer)
    }
    return {
      manifest: record.plugin.manifest,
      whenReady: () => host.ready,
      get vm() {
        return host.requireVm()
      },
      getState: () => host.getState(),
      subscribeState: (listener) => host.subscribeState(listener),
      onVmEvent: <T>(event: string, listener: (payload: T, ...args: unknown[]) => void) => {
        if (!host.bindings) {
          throw new Error(
            `Plugin "${pluginId}" subscribed to VM events before the editor was ready; await context.whenReady()`,
          )
        }
        const unsubscribe = host.bindings.on(
          event,
          listener as (payload: unknown, ...args: unknown[]) => void,
        )
        addDisposer(unsubscribe)
        return unsubscribe
      },
      ui: {
        get theme() {
          return host.getTheme()
        },
        setTheme: (theme) => host.requestTheme(theme),
        toggleTheme: () => host.requestTheme(host.getTheme() === 'dark' ? 'light' : 'dark'),
        subscribeTheme: (listener) => host.subscribeTheme(listener),
        notify: (message, kind = 'info') => host.notify(pluginId, message, kind),
      },
      tabs: {
        add: (tab) => host.addTab(pluginId, tab, addDisposer),
        list: () => host.listPluginTabs(pluginId),
      },
      runtimes: {
        register: (registration) => host.registerRuntime(registration, addDisposer),
        list: () => host.runtimes.list(),
      },
      storage: host.pluginStorage(pluginId),
      onDispose: addDisposer,
    }
  }

  private addTab(pluginId: string, tab: PluginTab, addDisposer: (disposer: Disposer) => void): () => void {
    const tabId = typeof tab?.id === 'string' ? tab.id.trim() : ''
    if (!isValidTabId(tabId)) {
      throw new Error(`Invalid tab ID for plugin "${pluginId}": ${JSON.stringify(tab?.id)}`)
    }
    const label = typeof tab.label === 'string' ? tab.label.trim() : ''
    if (!label) throw new Error(`Tab "${tabId}" must have a label`)
    if (typeof tab.mount !== 'function') throw new Error(`Tab "${tabId}" must define mount(container)`)
    const id = `${pluginId}/${tabId}`
    if (this.tabEntries.some((entry) => entry.id === id)) {
      throw new Error(`Tab is already registered: ${id}`)
    }
    const entry: PluginTabEntry = {
      id,
      pluginId,
      tab: { ...tab, id: tabId, label },
    }
    this.tabEntries.push(entry)
    this.notifyTabs()
    const remove = () => {
      const index = this.tabEntries.indexOf(entry)
      if (index < 0) return
      this.tabEntries.splice(index, 1)
      this.notifyTabs()
    }
    addDisposer(remove)
    return remove
  }

  private listPluginTabs(pluginId: string): PluginTabEntry[] {
    return this.tabEntries.filter((entry) => entry.pluginId === pluginId)
  }

  private registerRuntime(
    registration: RuntimeBackendRegistration,
    addDisposer: (disposer: Disposer) => void,
  ): () => void {
    this.runtimes.register(registration)
    const remove = () => {
      this.runtimes.unregister(registration.id)
    }
    addDisposer(remove)
    return remove
  }

  private requestTheme(theme: PluginTheme): void {
    if (this.bindings) {
      this.bindings.ui.setTheme(theme)
      return
    }
    this.publishTheme(theme)
  }

  private notify(pluginId: string, message: string, kind: PluginNotificationKind): void {
    if (this.bindings) {
      this.bindings.ui.notify(message, kind)
      return
    }
    const log = kind === 'error' ? console.error : console.info
    log(`[${pluginId}] ${message}`)
  }

  private notifyTabs(): void {
    const entries = [...this.tabEntries]
    for (const listener of this.tabListeners) listener(entries)
  }

  private notifyRecords(): void {
    const records = this.list()
    for (const listener of this.recordListeners) listener(records)
  }

  private notifyState(): void {
    if (!this.state) return
    for (const listener of this.stateListeners) listener(this.state)
  }

  private notifyTheme(): void {
    const theme = this.getTheme()
    for (const listener of this.themeListeners) listener(theme)
  }

  private pluginStorage(pluginId: string): PluginContext['storage'] {
    const prefix = `${PLUGIN_STORAGE_PREFIX}${pluginId}.`
    return {
      get: <T>(key: string): T | undefined => {
        try {
          const raw = this.storage?.getItem(prefix + key)
          return raw == null ? undefined : (JSON.parse(raw) as T)
        } catch {
          return undefined
        }
      },
      set: (key, value) => {
        try {
          this.storage?.setItem(prefix + key, JSON.stringify(value))
        } catch {
          // Quota or privacy errors must not break the plugin.
        }
      },
      remove: (key) => {
        try {
          this.storage?.removeItem(prefix + key)
        } catch {
          // Ignore unavailable storage.
        }
      },
    }
  }

  private readStringArray(key: string): string[] {
    try {
      const raw = this.storage?.getItem(key)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
    } catch {
      return []
    }
  }

  private persistDisabled(): void {
    const values = [...this.disabled]
    try {
      this.storage?.setItem(PLUGIN_DISABLED_STORAGE_KEY, JSON.stringify(values))
    } catch {
      // Persistence is best effort.
    }
  }

  private saveUrl(url: string): void {
    const urls = this.readStringArray(PLUGIN_URLS_STORAGE_KEY)
    if (urls.includes(url)) return
    try {
      this.storage?.setItem(PLUGIN_URLS_STORAGE_KEY, JSON.stringify([...urls, url]))
    } catch {
      // Persistence is best effort.
    }
  }

  private removeUrl(url: string): void {
    const urls = this.readStringArray(PLUGIN_URLS_STORAGE_KEY).filter((entry) => entry !== url)
    try {
      this.storage?.setItem(PLUGIN_URLS_STORAGE_KEY, JSON.stringify(urls))
    } catch {
      // Persistence is best effort.
    }
  }
}

/** Accepts `export default {...}` or `export const plugin = {...}`. */
export function normalizePluginModule(module: unknown): XyoPlugin {
  if (!module || typeof module !== 'object') {
    throw new Error('Plugin module must export a plugin object')
  }
  const namespace = module as Record<string, unknown>
  const candidate = namespace.default ?? namespace.plugin
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Plugin module must export a plugin object as its default export')
  }
  const plugin = candidate as Partial<XyoPlugin>
  return {
    manifest: normalizeManifest(plugin.manifest),
    activate: plugin.activate as XyoPlugin['activate'],
  }
}
