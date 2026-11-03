import { ScratchCanvasRenderer } from '@hikkaku/vm'
import type { RuntimeBackend } from './runtime-backends'
import { XyoRuntimeVM, type XyoRuntimeEngine } from './xyo-runtime-vm'
import { XyoWorkerClient, type XyoWorkerPort } from './xyo-worker-client'

/** One worker per backend: never share module state or pending requests between editors. */
export function createXyoWorkerEngine(client: XyoWorkerClient): XyoRuntimeEngine & { readonly supportsAudio: boolean } {
  return {
    get supportsAudio() { return client.supportsAudio },
    loadSb3: bytes => client.loadSb3(bytes),
    greenFlagCompiled: () => client.greenFlag(),
    step: () => client.step(), stop: () => client.stop(),
    snapshot: () => client.snapshot(), stats: () => client.stats(),
    key: (key, down, code) => client.key(key, down, code),
    mouse: (x, y, width, height, down, button, dragged) => client.mouse(x, y, width, height, down, button, dragged),
    wheel: (dx, dy) => client.wheel(dx, dy), answer: text => client.answer(text),
    answerIfQuestion: (questionId, text) => client.answerIfQuestion(questionId, text),
    dispose: () => client.dispose(),
    interrupt: () => client.terminate('xyo-cpp worker interrupted'),
  }
}

export type XyoWorkerFactory = () => XyoWorkerPort | Promise<XyoWorkerPort>

/** The renderer displays snapshots; it does not provide collision sensing to WASM. */
export function createXyoBackend(factory: XyoWorkerFactory = async () => {
  const { default: WorkerConstructor } = await import('virtual:xyo-worker')
  return new WorkerConstructor()
}, options: { experimentalPen?: boolean } = {}): RuntimeBackend {
  let client: XyoWorkerClient | undefined
  let audioContext: AudioContext | undefined
  let disposed = false
  // Invoke resume in the gesture stack, not after worker initialization.
  const prepareAudio = () => {
    try {
      if (!audioContext && typeof globalThis.AudioContext === 'function') audioContext = new AudioContext()
      if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {})
    } catch { /* Audio is optional; the transport fails closed if unavailable. */ }
  }
  const renderer = new ScratchCanvasRenderer()
  const adapter = new XyoRuntimeVM(async () => {
    const port = await factory()
    if (disposed) { port.terminate(); throw new Error('xyo-cpp backend is disposed') }
    client = new XyoWorkerClient(() => port, audioContext)
    return createXyoWorkerEngine(client)
  }, undefined, options.experimentalPen ? renderer : undefined)
  let handle: number | ReturnType<typeof setTimeout> | undefined
  let raf = false
  let ticking = false
  let lastStep = 0
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
    if (!adapter.vm.isRunning()) return
    const now = globalThis.performance?.now() ?? Date.now()
    if (lastStep && now - lastStep < 1000 / 30) { schedule(); return }
    lastStep = now
    ticking = true
    try {
      adapter.vm.step()
      void adapter.settled().catch(() => {}).finally(() => { ticking = false; schedule() })
    } catch (error) {
      ticking = false
      adapter.model.emit('ERROR', { error, message: error instanceof Error ? error.message : String(error) })
    }
  }
  // The editor's runtime frame listener updates UI state but does not draw; the
  // headless worker cannot drive the canvas, so draw each published snapshot.
  const off = [
    adapter.model.on('PROJECT_RUN_START', schedule),
    adapter.model.on('RUNTIME_STEP', snapshot => renderer.requestDraw(snapshot as ReturnType<typeof adapter.vm.snapshot>)),
  ]
  const runtime = new Proxy(adapter.vm.runtime, {
    get(target, key) {
      if (key === 'greenFlag') return () => { prepareAudio(); return target.greenFlag() }
      return Reflect.get(target, key, target)
    },
  })
  const vm = new Proxy(adapter.vm, {
    get(target, key) {
      if (key === 'greenFlag') return () => { prepareAudio(); return target.greenFlag() }
      if (key === 'runtime') return runtime
      return Reflect.get(target, key, target)
    },
  })
  return {
    vm,
    renderer,
    executionDriver: 'backend',
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of off) unsubscribe()
      if (handle !== undefined) {
        if (raf) globalThis.cancelAnimationFrame(handle as number)
        else clearTimeout(handle as ReturnType<typeof setTimeout>)
      }
      // Graceful WASM disposal cannot interrupt a synchronous compile.
      client?.terminate('xyo-cpp backend disposed')
      if (audioContext) void audioContext.close().catch(() => {})
      adapter.dispose()
      return adapter.settled().catch(() => {})
    },
  }
}
