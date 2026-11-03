import type { XyoWorkerOperation, XyoWorkerRequest, XyoWorkerResponse, XyoWorkerRuntime } from './xyo-worker-protocol'

/** Install inside a worker entrypoint; the caller supplies the unresolved WASM factory. */
export function createXyoWorkerHost(factory: () => XyoWorkerRuntime | Promise<XyoWorkerRuntime>, post: (response: XyoWorkerResponse) => void) {
  let runtime: XyoWorkerRuntime | undefined
  let loaded = false
  let generation = 0
  let disposed = false
  let tail = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let audioEnabled = false
  const audioGenerations = new Set<number>()
  async function drain(tag: number) {
    if (!audioEnabled || !runtime?.audio) return
    for (const command of await runtime.audio.drain()) {
      if (command.type === 'open') audioGenerations.add(command.generation)
      post({ id: 0, generation: tag, ok: true, value: { audio: command } })
    }
  }
  function heartbeat() {
    if (timer !== undefined || disposed || !audioEnabled || !runtime?.audio) return
    timer = setTimeout(() => {
      timer = undefined
      const run = async () => {
        if (disposed || !audioEnabled || !runtime?.audio) return
        try { await runtime.audio.tick(); await drain(generation); post({ id: 0, generation, ok: true, value: { audioHeartbeat: true } }); heartbeat() }
        catch (error) { post({ id: 0, generation, ok: false, error: `Audio transport failed: ${String(error)}` }) }
      }
      tail = tail.then(run, run)
    }, 100)
  }
  async function execute(op: XyoWorkerOperation, vm: XyoWorkerRuntime): Promise<unknown> {
    switch (op.type) {
      case 'load': return vm.loadSb3(op.bytes)
      case 'flag': return op.compiled ? vm.greenFlagCompiled() : vm.greenFlagInterpreter()
      case 'step': return vm.step()
      case 'stop': return vm.stop()
      case 'key': return vm.key(op.key, op.down, op.keyCode)
      case 'mouse': return vm.mouse(op.x, op.y, op.width, op.height, op.down, op.button, op.dragged)
      case 'wheel': return vm.wheel(op.dx, op.dy)
      case 'answer': return vm.answer(op.text)
      case 'answerIfQuestion':
        if (!vm.answerIfQuestion) throw new Error('xyo-cpp runtime does not support question identities')
        return vm.answerIfQuestion(op.questionId, op.text)
      case 'snapshot': return vm.snapshot()
      case 'stats': return { supportsCompiledExecution: vm.supportsCompiledExecution, compileStats: vm.compileStats }
      case 'dispose': return vm.dispose()
      case 'audioReply': return vm.audio?.reply(op.reply)
    }
  }
  return (request: XyoWorkerRequest): void => {
    if (request.generation > generation) generation = request.generation
    const run = async () => {
      const respond = (result: { ok: true; value?: unknown } | { ok: false; error: string }) => post({ id: request.id, generation: request.generation, ...result })
      if (disposed || request.generation !== generation) { respond({ ok: false, error: 'Stale or disposed worker request' }); return }
      try {
        // A stop/dispose before initialization need not instantiate WASM.
        if (!runtime && (request.operation.type === 'stop' || request.operation.type === 'dispose')) {
          if (request.operation.type === 'dispose') disposed = true
          respond({ ok: true }); return
        }
        runtime ??= await factory()
        if (request.generation !== generation) { respond({ ok: false, error: 'Stale worker request' }); return }
        if (audioGenerations.size && ['stop', 'load', 'dispose', 'flag'].includes(request.operation.type))
          throw new Error('Active audio requires worker teardown; graceful lifecycle is unavailable')
        // A superseded load can finish factory initialization without loading a project.
        if (request.operation.type === 'stop' && !loaded) { respond({ ok: true }); return }
        if (request.operation.type === 'dispose') { disposed = true; if (timer !== undefined) clearTimeout(timer) }
        if (request.operation.type === 'flag' && request.operation.audioEnabled && !runtime.audio)
          throw new Error('Audio was requested but the runtime has no audio adapter')
        const value = await execute(request.operation, runtime)
        if (request.operation.type === 'audioReply' && request.operation.reply.type === 'cancelAck' && request.operation.reply.ok) {
          audioGenerations.delete(request.operation.reply.generation)
          if (!audioGenerations.size) {
            audioEnabled = false
            if (timer !== undefined) { clearTimeout(timer); timer = undefined }
          }
        }
        if (request.operation.type === 'flag' && request.operation.audioEnabled && runtime.audio) { audioEnabled = true; await runtime.audio.open(); heartbeat() }
        await drain(request.generation)
        if (request.operation.type === 'load') loaded = true
        respond({ ok: true, value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (runtime?.audio && (request.operation.type === 'audioReply' || request.operation.type === 'step' || request.operation.type === 'flag'))
          post({ id: 0, generation: request.generation, ok: false, error: `Audio transport failed: ${message}` })
        respond({ ok: false, error: message })
      }
    }
    tail = tail.then(run, run).catch(() => {})
  }
}
