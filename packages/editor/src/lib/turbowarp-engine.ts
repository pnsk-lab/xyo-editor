import type { TurboWarpScaffoldingNamespace, TurboWarpVM } from './turbowarp-adapter'
import type { TurboWarpRenderer } from './turbowarp-renderer'

/** The additional public constructors exported by scaffolding-full 3.14.0. */
export interface TurboWarpEngineVM extends TurboWarpVM {
  readonly runtime: { targets: unknown[] }
  setCompatibilityMode(enabled: boolean): void
  setLocale(locale: string): Promise<unknown>
  setStageSize(width: number, height: number): void
  attachRenderer(renderer: TurboWarpRenderer): void
  attachStorage(storage: TurboWarpStorage): void
  attachAudioEngine(audio: TurboWarpAudioEngine): void
  start(): void
  clear(): void
  quit(): void
}

export interface TurboWarpStorage {
  readonly AssetType: Record<string, unknown>
  addWebStore(types: unknown[], get: (asset: { assetId: string; dataFormat: string }) => string): void
}

export interface TurboWarpAudioEngine {
  readonly audioContext: AudioContext
}

interface Constructors {
  VM: new () => TurboWarpEngineVM
  Renderer: new (canvas: HTMLCanvasElement, left: number, right: number, bottom: number, top: number) => TurboWarpRenderer
  Storage: new () => TurboWarpStorage
  AudioEngine: new () => TurboWarpAudioEngine
}

export interface TurboWarpEngine {
  readonly vm: TurboWarpEngineVM
  readonly renderer: TurboWarpRenderer
  readonly storage: TurboWarpStorage
  readonly audioEngine: TurboWarpAudioEngine | undefined
  /** Constructor facade for createTurboWarpRenderer: the adapter borrows this
   * renderer. Dispose the adapter first, then await engine.dispose(). */
  readonly Renderer: new (canvas: HTMLCanvasElement) => TurboWarpRenderer
  /** Releases the VM, owned audio context and WebGL context. Do not reuse these objects. */
  dispose(): Promise<void>
}

/** Create a VM before the canvas exists. Transfer it to createTurboWarpEngine
 * exactly once; if never transferred the caller must stop, clear and quit it. */
export function createTurboWarpEngineVM(namespace: TurboWarpScaffoldingNamespace): TurboWarpEngineVM {
  if (typeof namespace?.VM !== 'function') throw new Error('TurboWarp Scaffolding is missing VM')
  const VM = namespace.VM as unknown as new () => TurboWarpEngineVM
  return new VM()
}

/**
 * Create the official VM and renderer on the caller's canvas. The caller owns
 * DOM layout, input, overlays, project loading and VM start. Only embedded SB3
 * assets and built-in defaults are available unless a web store is configured.
 * An optional existing VM transfers ownership to the engine as soon as setup
 * starts; it must be unused (no renderer/storage/audio) and will be cleared
 * and quit on dispose or setup failure.
 *
 * Based on https://github.com/TurboWarp/packager/blob/v3.14.0/src/scaffolding/scaffolding.js
 * BitmapAdapter and VideoProvider are not exported by scaffolding-full; SB2 bitmap
 * conversion and video are therefore not configured here.
 */
export function createTurboWarpEngine(namespace: TurboWarpScaffoldingNamespace, canvas: HTMLCanvasElement, existingVM?: TurboWarpEngineVM): TurboWarpEngine {
  const lib = namespace as unknown as Constructors
  for (const name of ['VM', 'Renderer', 'Storage', 'AudioEngine'] as const) {
    if (typeof lib?.[name] !== 'function') throw new Error(`TurboWarp Scaffolding is missing ${name}`)
  }
  if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError('TurboWarp requires an HTMLCanvasElement')
  }

  let vm: TurboWarpEngineVM | undefined
  let renderer: TurboWarpRenderer | undefined
  let audio: TurboWarpAudioEngine | undefined
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    // Perform every cleanup even if an earlier operation fails.
    const errors: unknown[] = []
    const attempt = (fn: () => void) => { try { fn() } catch (error) { errors.push(error) } }
    if (vm) {
      attempt(() => vm!.stopAll())
      attempt(() => vm!.clear())
      attempt(() => vm!.quit())
    }
    if (renderer) {
      // RenderWebGL exposes no dispose. This canvas and context are owned until
      // disposal; losing it invalidates all GPU resources and is intentional.
      attempt(() => {
        const gl = (renderer as TurboWarpRenderer & { gl: WebGLRenderingContext }).gl
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      })
    }
    let closing: Promise<void> = Promise.resolve()
    if (audio && audio.audioContext.state !== 'closed') {
      try { closing = audio.audioContext.close() } catch (error) { errors.push(error) }
    }
    disposal = closing.catch((error: unknown) => { errors.push(error) }).then(() => {
      if (errors.length) throw new AggregateError(errors, 'Failed to dispose TurboWarp engine')
    })
    return disposal
  }

  try {
    vm = existingVM ?? new lib.VM()
    vm.setCompatibilityMode(true)
    // Like Scaffolding, locale setup is not a prerequisite for constructing the renderer.
    void vm.setLocale(navigator.language).catch(() => {})
    vm.setStageSize(480, 360)
    renderer = new lib.Renderer(canvas, -240, 240, -180, 180)
    if (renderer.canvas !== canvas) throw new Error('TurboWarp renderer did not use the supplied canvas')
    vm.attachRenderer(renderer)
    const storage = new lib.Storage()
    vm.attachStorage(storage)
    if (typeof window.AudioContext !== 'undefined' || typeof (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== 'undefined') {
      audio = new lib.AudioEngine()
      vm.attachAudioEngine(audio)
    }
    const sharedRenderer = renderer
    // A constructor may explicitly return an object. This facade lets the
    // existing lazy renderer adapter borrow the already-attached instance,
    // without allocating a second WebGL renderer or changing its ownership.
    const Renderer = function (requestedCanvas: HTMLCanvasElement) {
      if (disposal) throw new Error('TurboWarp engine is disposed')
      if (requestedCanvas !== canvas) throw new Error('TurboWarp engine renderer cannot be moved to another canvas')
      return sharedRenderer
    } as unknown as new (canvas: HTMLCanvasElement) => TurboWarpRenderer
    return { vm, renderer, storage, audioEngine: audio, Renderer, dispose }
  } catch (error) {
    // Preserve the construction error (notably the renderer's WebGL error).
    void dispose().catch(() => {})
    throw error
  }
}
