import { loadTurboWarpScaffolding } from '../src/lib/turbowarp-loader'
import { createTurboWarpEngine } from '../src/lib/turbowarp-engine'
import { TurboWarpRuntimeVM } from '../src/lib/turbowarp-runtime-vm'

;(window as any).runStepFixture = async () => {
  const namespace = await loadTurboWarpScaffolding()
  const engine = createTurboWarpEngine(namespace, document.querySelector('canvas')!)
  const adapter = new TurboWarpRuntimeVM(engine.vm)
  try {
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((target) => !target.isStage)!
    sprite.x = 0
    sprite.blocks = {
      flag: {
        opcode: 'event_whenflagclicked',
        next: 'move',
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0,
      },
      move: {
        opcode: 'motion_changexby',
        next: null,
        parent: 'flag',
        inputs: { DX: [1, [4, '25']] },
        fields: {},
        shadow: false,
        topLevel: false,
      },
    }
    await adapter.model.loadProject(project)
    engine.vm.start()
    await adapter.syncProject()
    const runtime = engine.vm.runtime as any
    const loop = runtime.frameLoop
    loop.stop()
    engine.vm.greenFlag()
    const target = runtime.targets.find((t: any) => !t.isStage && t.isOriginal)
    const before = {
      x: target.x,
      running: loop.running,
      threads: runtime.threads.length,
      topBlock: runtime.threads[0]?.topBlock,
    }
    const original = loop.stepCallback
    let calls = 0,
      nestedError = ''
    loop.stepCallback = function () {
      calls++
      try {
        adapter.vm.step()
      } catch (error) {
        nestedError = String(error)
      }
      return original.call(this)
    }
    adapter.vm.step()
    const after = {
      x: target.x,
      running: loop.running,
      calls,
      nestedError,
      snapshotX: adapter.vm.snapshot().project.targets.find((t) => !t.isStage)?.x,
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    const later = { x: target.x, running: loop.running, calls }
    loop.stepCallback = original
    return { before, after, later }
  } finally {
    adapter.dispose()
    await engine.dispose()
  }
}
