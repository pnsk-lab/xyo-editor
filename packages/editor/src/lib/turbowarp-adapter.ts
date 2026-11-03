/**
 * Experimental, browser-only integration with the official TurboWarp
 * Scaffolding distribution. This is deliberately not a replacement for the
 * editor's @hikkaku/vm interface: editing and snapshot APIs differ.
 *
 * The host must load a pinned Scaffolding script before creating an adapter.
 * https://github.com/TurboWarp/packager/blob/master/scaffolding-api-docs/README.md
 */
export interface TurboWarpVM {
  loadProject(data: string | ArrayBuffer | Uint8Array | object): Promise<unknown>
  saveProjectSb3(type?: string): Promise<Blob | Uint8Array | ArrayBuffer>
  greenFlag(): void
  stopAll(): void
  setTurboMode(enabled: boolean): void
  postIOData(device: string, data: object): void
  setEditingTarget(id: string): void
  postSpriteInfo(data: object): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface TurboWarpScaffolding {
  width: number
  height: number
  resizeMode: string
  editableLists: boolean
  vm: TurboWarpVM
  renderer: unknown
  storage: unknown
  setup(): void
  appendTo(element: HTMLElement): void
  relayout(): void
  loadProject(data: string | ArrayBuffer | Uint8Array): Promise<unknown>
  start(): void
  greenFlag(): void
  stopAll(): void
}

export interface TurboWarpScaffoldingNamespace {
  Scaffolding: new () => TurboWarpScaffolding
  VM: new () => TurboWarpVM
  Renderer: new (...args: never[]) => unknown
}

export interface TurboWarpAdapterOptions {
  width?: number
  height?: number
  resizeMode?: 'preserve-ratio' | 'dynamic-resize' | 'stretch'
  editableLists?: boolean
}

/** The adapter owns a single Scaffolding instance and its VM and renderer. */
export class TurboWarpAdapter {
  readonly scaffolding: TurboWarpScaffolding
  readonly vm: TurboWarpVM
  readonly renderer: unknown
  private started = false

  constructor(namespace: TurboWarpScaffoldingNamespace, container: HTMLElement, options: TurboWarpAdapterOptions = {}) {
    if (!namespace || typeof namespace.Scaffolding !== 'function') {
      throw new Error('TurboWarp Scaffolding is not loaded; load a pinned official distribution first')
    }
    const scaffolding = new namespace.Scaffolding()
    if (options.width !== undefined) scaffolding.width = options.width
    if (options.height !== undefined) scaffolding.height = options.height
    if (options.resizeMode !== undefined) scaffolding.resizeMode = options.resizeMode
    if (options.editableLists !== undefined) scaffolding.editableLists = options.editableLists
    scaffolding.setup()
    if (!scaffolding.vm || !scaffolding.renderer) {
      throw new Error('TurboWarp Scaffolding setup did not provide a VM and renderer')
    }
    scaffolding.appendTo(container)
    this.scaffolding = scaffolding
    this.vm = scaffolding.vm
    this.renderer = scaffolding.renderer
  }

  async loadProject(data: string | ArrayBuffer | Uint8Array): Promise<void> {
    await this.scaffolding.loadProject(data)
  }

  /** Start the runtime exactly once; later green flags restart project scripts. */
  greenFlag(): void {
    if (!this.started) {
      this.scaffolding.start()
      this.started = true
    } else {
      this.vm.greenFlag()
    }
  }

  stopAll(): void {
    this.scaffolding.stopAll()
  }

  setTurboMode(enabled: boolean): void {
    this.vm.setTurboMode(enabled)
  }

  selectTarget(id: string): void {
    this.vm.setEditingTarget(id)
  }

  postSpriteInfo(data: object): void {
    this.vm.postSpriteInfo(data)
  }

  postMouse(data: object): void {
    this.vm.postIOData('mouse', data)
  }

  postKeyboard(data: object): void {
    this.vm.postIOData('keyboard', data)
  }

  async saveProjectSb3(): Promise<Uint8Array> {
    const result = await this.vm.saveProjectSb3('uint8array')
    if (!(result instanceof Uint8Array)) throw new Error('TurboWarp returned an unexpected SB3 output type')
    return result
  }

  on(event: string, listener: (...args: unknown[]) => void): () => void {
    this.vm.on(event, listener)
    return () => { this.vm.removeListener(event, listener) }
  }

  relayout(): void {
    this.scaffolding.relayout()
  }
}
