import { ScratchCanvasRenderer } from '@hikkaku/vm'
import type { RuntimeBackend } from './runtime-backends'
import { XyoRuntimeVM } from './xyo-runtime-vm'
import { createUnifiedEngine, type UnifiedModule } from './xyo-unified-engine'
import { createWorkerRunner, type LlvmRunnerUrls } from './llvm-runner'
import { XyoAudioSupervisor } from './xyo-audio-supervisor'
import type { AudioHostContext } from '../../../xyo-cpp-wasm/src/web-audio-host'

export interface UnifiedBackendUrls {
  /** ES module factory emitted by the unified build (`unified_runtime_esm.mjs`). */
  module: string
  /** Its Wasm asset (`unified_runtime_esm.wasm`). */
  wasm: string
  /** Artifacts the LLVM worker runner needs (compiler, llc/lld, host). */
  runner: LlvmRunnerUrls
  /** When present, sound commands from the runtime are played through it. */
  audioContext?: AudioHostContext
}

/**
 * Loads the Emscripten ES module glue.
 *
 * A plain `import(url)` of a `/public` asset is rewritten by the Vite dev
 * server, which refuses to transform public files and aborts the backend load
 * (`@vite-ignore` is not honoured for that case). Evaluating the fetched source
 * as a blob module bypasses the transform in dev and behaves the same in a
 * production build. The Wasm binary is always supplied explicitly, so the glue
 * never needs to resolve a URL relative to its own module.
 */
async function loadModuleFactory(url: string): Promise<unknown> {
  try {
    const source = await (await fetch(url)).text()
    const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      return (await import(/* @vite-ignore */ objectUrl)).default
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return (await import(/* @vite-ignore */ url)).default
  }
}

/**
 * Product backend over the unified xyo-cpp Wasm runtime: the interpreter runs
 * the project with xyo-cpp's full feature set, and LLVM side modules execute
 * the admitted scripts against that same Runtime instance.
 */
export async function createUnifiedBackend(urls: UnifiedBackendUrls): Promise<RuntimeBackend & { settled(): Promise<void> }> {
  const factory = (await loadModuleFactory(urls.module)) as (options: {
    wasmBinary?: Uint8Array
    locateFile?: (path: string) => string
  }) => Promise<UnifiedModule>
  const wasmBinary = new Uint8Array(await (await fetch(urls.wasm)).arrayBuffer())
  const module = await factory({
    wasmBinary,
    locateFile: (path) => (path.endsWith('.wasm') ? urls.wasm : path),
  })
  const runner = createWorkerRunner(urls.runner)
  const renderer = new ScratchCanvasRenderer()
  // The renderer bridge needs the editor snapshot, which only exists once the
  // adapter is built, so the engine reads it through this indirection.
  // Attaching the renderer to the model also installs its asset resolver, without
  // which drawables never receive costume images and collision stays empty.
  let adapter: XyoRuntimeVM | undefined
  const engine = createUnifiedEngine(module, runner, {
    audio: !!urls.audioContext,
    renderer: { renderer, snapshot: () => adapter!.vm.snapshot() },
  })
  const supervisor = urls.audioContext ? new XyoAudioSupervisor(urls.audioContext) : undefined
  // Browsers start the context suspended; resume it in the gesture that runs.
  const resumeAudio = () => {
    const context = urls.audioContext as { state?: string; resume?: () => Promise<void> } | undefined
    if (context?.state === 'suspended' && context.resume) void context.resume().catch(() => {})
  }
  const epoch = supervisor?.openWorker()
  let disposed = false
  let handle: number | ReturnType<typeof setTimeout> | undefined
  let raf = false
  let ticking = false
  let lastStep = 0
  adapter = new XyoRuntimeVM(async () => {
    if (disposed) throw new Error('unified backend is disposed')
    return engine
  })
  // Sound commands are drained after each settled step: the runtime queues
  // them, this loop hands them to Web Audio and reports terminal results back.
  const drainAudio = () => {
    const audio = engine.audio
    if (!audio || !supervisor || epoch === undefined) return
    let commands
    try { commands = audio.drain() } catch { return }
    for (const command of commands) {
      if (command.type === 'open') {
        supervisor.openGeneration(epoch, command.generation, (generation, id, result) => {
          try { audio.reply({ type: 'complete', generation, id, result }) } catch { /* session already closed */ }
        })
      } else if (command.type === 'start') {
        supervisor.start(epoch, command.generation, command.id, command.bytes, command.volume, command.pitch, command.pan, command.format)
      } else if (command.type === 'stop') {
        supervisor.stop(epoch, command.generation, command.id)
      } else if (command.type === 'volume') {
        supervisor.setVolume(epoch, command.generation, command.id, command.volume)
      } else if (command.type === 'effects') {
        supervisor.setEffects(epoch, command.generation, command.id, command.pitch, command.pan)
      } else if (command.type === 'cancel') {
        supervisor.invalidateGeneration(epoch, command.generation)
      }
    }
  }
  const schedule = () => {
    if (disposed || handle !== undefined) return
    if (typeof globalThis.requestAnimationFrame === 'function') {
      raf = true
      handle = globalThis.requestAnimationFrame(tick)
    } else {
      raf = false
      handle = setTimeout(tick, 1000 / 30)
    }
  }
  const tick = () => {
    handle = undefined
    if (disposed || ticking) return
    if (!adapter.vm.isRunning()) {
      // Keyboard/mouse hats can start threads while nothing is running, and the
      // runtime only reports PROJECT_RUN_START for flag starts. Poll slowly so
      // those threads are picked up instead of never being stepped.
      if (typeof globalThis.setTimeout === 'function') {
        raf = false
        handle = setTimeout(tick, 100)
      }
      return
    }
    resumeAudio()
    const now = globalThis.performance?.now() ?? Date.now()
    if (lastStep && now - lastStep < 1000 / 30) { schedule(); return }
    lastStep = now
    ticking = true
    try {
      adapter.vm.step()
      void adapter.settled().then(drainAudio, () => {}).finally(() => { ticking = false; schedule() })
    } catch (error) {
      ticking = false
      adapter.model.emit('ERROR', { error, message: error instanceof Error ? error.message : String(error) })
    }
  }
  adapter.model.attachRenderer(renderer as unknown as Parameters<typeof adapter.model.attachRenderer>[0])
  const off = [
    adapter.model.on('PROJECT_RUN_START', () => { resumeAudio(); schedule() }),
    adapter.model.on('RUNTIME_STEP', (snapshot) =>
      renderer.requestDraw(snapshot as ReturnType<typeof adapter.vm.snapshot>)),
  ]
  return {
    vm: adapter.vm,
    renderer,
    executionDriver: 'backend',
    // Test/integration convenience: resolves once queued load work finishes.
    settled: () => adapter.settled(),
    llvmStats: () => engine.llvmStats,
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of off) unsubscribe()
      if (handle !== undefined) {
        if (raf) globalThis.cancelAnimationFrame(handle as number)
        else clearTimeout(handle as ReturnType<typeof setTimeout>)
      }
      adapter.dispose()
      if (supervisor && epoch !== undefined) supervisor.invalidateWorker(epoch)
      return adapter.settled().catch(() => {})
    },
  }
}
