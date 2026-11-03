import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createUnifiedEngine, type UnifiedModule } from '../src/lib/xyo-unified-engine'
import type { LlvmScriptRunner } from '../src/lib/llvm-backend'
import type { RuntimeSnapshot, ScratchCanvasRenderer } from '../../vm/src/index'

// Verifies the renderer bridge wiring against the real runtime: a `touching`
// block must reach the host renderer and use its answer. The renderer itself is
// a stub here so the assertion is about wiring, not about pixels.
const build = join(import.meta.dir, '..', '..', 'llvm-wasm', '.work', 'unified-build')
const available = existsSync(join(build, 'unified_runtime.wasm'))

async function loadModule(): Promise<UnifiedModule> {
  const require = createRequire(import.meta.url)
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}\n')
  const loaded = require(join(build, 'unified_runtime.js'))
  const factory = typeof loaded === 'function' ? loaded : loaded.default
  const wasm = readFileSync(join(build, 'unified_runtime.wasm'))
  const compiled = new WebAssembly.Module(wasm)
  return (await factory({
    wasmBinary: wasm,
    instantiateWasm(imports: Record<string, unknown>, ready: (i: unknown, m: unknown) => void) {
      const instance = new WebAssembly.Instance(compiled, imports as WebAssembly.Imports)
      ready(instance, compiled)
      return instance.exports
    },
  })) as UnifiedModule
}

const unusedRunner = {
  buildAdmitted: async () => ({ ok: false as const, error: 'unused' }),
  runBuilt: async () => ({ ok: false as const, error: 'unused' }),
} satisfies LlvmScriptRunner

// Records what the runtime asks for; the answer is fixed so the assertion is
// deterministic.
function stubRenderer(result: boolean) {
  const calls = {
    touching: 0,
    draw: 0,
    sync: 0,
    created: 0,
    penSkin: 0,
    penLines: 0,
    penClears: 0,
    penStamps: 0,
  }
  let next = 1
  const draws = new Map<number, number>()
  const stub = {
    requestDraw() {
      calls.sync++
    },
    draw() {
      calls.draw++
    },
    pick() {
      return null
    },
    createDrawable() {
      calls.created++
      return next++
    },
    destroyDrawable(id: number) {
      draws.delete(id)
    },
    setDrawableOrder() {},
    getDrawableOrder() {
      return 0
    },
    getBounds() {
      return { left: -10, right: 10, top: 10, bottom: -10 }
    },
    getCurrentSkinSize() {
      return [20, 20]
    },
    getFencedPositionOfDrawable(_n: string, position: [number, number]) {
      return position
    },
    isTouchingDrawables() {
      calls.touching++
      return result
    },
    isTouchingColor() {
      return false
    },
    isColorTouchingColor() {
      return false
    },
    createPenSkin() {
      calls.penSkin++
      return calls.penSkin
    },
    penLine() {
      calls.penLines++
    },
    penClear() {
      calls.penClears++
    },
    penStamp() {
      calls.penStamps++
    },
  }
  return { renderer: stub as unknown as ScratchCanvasRenderer, calls }
}

function modelSnapshot(): RuntimeSnapshot {
  const target = (id: string, name: string, isStage: boolean) => ({
    id,
    name,
    isStage,
    isClone: false,
    variables: {},
    lists: {},
    blocks: {},
    costumes: [],
    sounds: [],
    currentCostume: 0,
    volume: 100,
    layerOrder: 0,
    x: 0,
    y: 0,
    direction: 90,
    size: 100,
    visible: true,
  })
  return {
    project: {
      targets: [target('Stage', 'Stage', true), target('Sprite1', 'Sprite1', false)],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0' },
    },
    running: false,
    threads: [],
    selectedTargetId: 'Stage',
  } as unknown as RuntimeSnapshot
}

function touchingProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          h: {
            opcode: 'event_whenflagclicked',
            next: 'if',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 0,
            y: 0,
          },
          if: {
            opcode: 'control_if',
            next: null,
            parent: 'h',
            inputs: { CONDITION: [2, 'touch'], SUBSTACK: [2, 'setv'] },
            fields: {},
          },
          touch: {
            opcode: 'sensing_touchingobject',
            next: null,
            parent: 'if',
            inputs: { TOUCHINGOBJECTMENU: [1, [10, 'Sprite1']] },
            fields: {},
          },
          setv: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'if',
            inputs: { VALUE: [1, [4, '1']] },
            fields: { VARIABLE: ['v', 'v'] },
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
        x: 0,
        y: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

async function runWith(result: boolean) {
  ;(globalThis as unknown as { __xyoRendererDebug?: boolean }).__xyoRendererDebug = true
  const m = await loadModule()
  const { renderer, calls } = stubRenderer(result)
  const engine = createUnifiedEngine(m, unusedRunner, {
    renderer: { renderer, snapshot: modelSnapshot },
  })
  const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(touchingProject())) })
  await engine.loadSb3(Buffer.from(bytes))
  engine.greenFlagCompiled()
  for (let i = 0; i < 5; i++) engine.step()
  const snapshot = engine.snapshot() as {
    targets: Array<{ variables: Record<string, { value: unknown }> }>
  }
  const value = snapshot.targets[0]!.variables.v!.value
  engine.dispose()
  return { value, calls }
}

function penProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          h: {
            opcode: 'event_whenflagclicked',
            next: 'clear',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 0,
            y: 0,
          },
          clear: { opcode: 'pen_clear', next: 'down', parent: 'h', inputs: {}, fields: {} },
          down: { opcode: 'pen_penDown', next: 'move', parent: 'clear', inputs: {}, fields: {} },
          move: {
            opcode: 'motion_movesteps',
            next: 'up',
            parent: 'down',
            inputs: { STEPS: [1, [4, '10']] },
            fields: {},
          },
          up: { opcode: 'pen_penUp', next: null, parent: 'move', inputs: {}, fields: {} },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
        x: 0,
        y: 0,
        direction: 90,
        size: 100,
        visible: true,
      },
    ],
    monitors: [],
    extensions: ['pen'],
    meta: { semver: '3.0.0' },
  }
}

describe.skipIf(!available)('unified runtime renderer bridge', () => {
  test('pen blocks reach the host renderer pen API', async () => {
    const m = await loadModule()
    const { renderer, calls } = stubRenderer(true)
    const engine = createUnifiedEngine(m, unusedRunner, {
      renderer: { renderer, snapshot: modelSnapshot },
    })
    try {
      await engine.loadSb3(
        Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(penProject())) })),
      )
      engine.greenFlagCompiled()
      for (let i = 0; i < 5; i++) engine.step()
      // createPenSkin, then clear and a line for the 10-step move.
      expect(calls.penSkin).toBeGreaterThan(0)
      expect(calls.penClears).toBeGreaterThan(0)
      expect(calls.penLines).toBeGreaterThan(0)
    } finally {
      engine.dispose()
    }
  }, 60000)

  test('a touching block reaches the host renderer and uses its answer', async () => {
    const hit = await runWith(true)
    expect(hit.calls.touching).toBeGreaterThan(0)
    expect(hit.calls.created).toBeGreaterThan(0)
    expect(hit.value).toBe('1')
  }, 120000)

  test('a false answer from the renderer leaves the branch unexecuted', async () => {
    const miss = await runWith(false)
    expect(miss.calls.touching).toBeGreaterThan(0)
    expect(miss.value).toBe(0)
  }, 120000)
})
