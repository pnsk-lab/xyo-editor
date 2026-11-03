import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createUnifiedEngine, type UnifiedModule } from '../src/lib/xyo-unified-engine'
import type { LlvmScriptRunner } from '../src/lib/llvm-backend'

// End-to-end over the real unified Wasm runtime: one module must interpret the
// unadmitted script and run the compiled one against the same Runtime, so both
// results show up in a single snapshot. The LLVM side is a reviewed fixed side
// module (the compiler/linker path is covered by the browser suites).
const build = join(import.meta.dir, '..', '..', 'llvm-wasm', '.work', 'unified-build')
const available = existsSync(join(build, 'unified_runtime.wasm'))
const sidePath = join(
  import.meta.dir,
  '..',
  '..',
  'llvm-wasm',
  'real-host',
  'build',
  'reference.wasm',
)

async function loadModule(): Promise<UnifiedModule> {
  const require = createRequire(import.meta.url)
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}\n')
  const loaded = require(join(build, 'unified_runtime.js'))
  const factory = typeof loaded === 'function' ? loaded : loaded.default
  const wasm = readFileSync(join(build, 'unified_runtime.wasm'))
  const compiled = new WebAssembly.Module(wasm)
  return (await factory({
    wasmBinary: wasm,
    instantiateWasm(imports: Record<string, unknown>, ready: (i: unknown, mod: unknown) => void) {
      const instance = new WebAssembly.Instance(compiled, imports as WebAssembly.Imports)
      ready(instance, compiled)
      return instance.exports
    },
  })) as UnifiedModule
}

const fixedRunner: LlvmScriptRunner = {
  buildAdmitted: async () => ({
    ok: true,
    build: {
      side: new Uint8Array(readFileSync(sidePath)),
      metadata: {
        abiDescriptor: 'unused-by-engine',
        slots: [
          { kind: 3, global: 'xyo_aot_slot_0', keyHex: '34003200' },
          { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' },
        ],
      },
    },
  }),
  runBuilt: async () => ({ ok: false, error: 'engine invokes in-process; runBuilt is unused' }),
}

function mixedProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0], w: ['w', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          hatA: {
            opcode: 'event_whenflagclicked',
            next: 'setV',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 0,
            y: 0,
          },
          setV: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'hatA',
            inputs: { VALUE: [1, [4, '42']] },
            fields: { VARIABLE: ['v', 'v'] },
            topLevel: false,
          },
          hatB: {
            opcode: 'event_whenflagclicked',
            next: 'loop',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 0,
            y: 200,
          },
          loop: {
            opcode: 'control_repeat',
            next: null,
            parent: 'hatB',
            inputs: { TIMES: [1, [6, '3']], SUBSTACK: [2, 'inc'] },
            fields: {},
          },
          inc: {
            opcode: 'data_changevariableby',
            next: null,
            parent: 'loop',
            inputs: { VALUE: [1, [4, '1']] },
            fields: { VARIABLE: ['w', 'w'] },
            topLevel: false,
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}

describe('unified runtime engine (real Wasm module)', () => {
  test.skipIf(!available || !existsSync(sidePath))(
    'interprets one script and runs the compiled one on the same Runtime',
    async () => {
      const m = await loadModule()
      const engine = createUnifiedEngine(m, fixedRunner)
      try {
        await engine.loadSb3(
          Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(mixedProject())) })),
        )
        expect(engine.fallbacks).toBe(0)
        engine.greenFlagCompiled()
        for (let i = 0; i < 40; i++) engine.step()
        const snapshot = engine.snapshot() as {
          targets: Array<{ variables: Record<string, { value: unknown }> }>
        }
        const variables = snapshot.targets[0]!.variables
        // Compiled script wrote into the shared Runtime.
        expect(variables.v!.value).toBe('42')
        // Interpreter ran the loop that LLVM never saw.
        expect(variables.w!.value).toBe(3)
      } finally {
        engine.dispose()
      }
    },
    120000,
  )

  test.skipIf(!available || !existsSync(sidePath))(
    'falls back to the interpreter when compilation fails',
    async () => {
      // Same project, but compilation always fails. The split kept the hat inert,
      // so if the interpreter were doing the work the value would still change.
      const brokenRunner: LlvmScriptRunner = {
        buildAdmitted: async () => ({ ok: false, error: 'compilation disabled for this test' }),
        runBuilt: async () => ({ ok: false, error: 'unused' }),
      }
      const m = await loadModule()
      const engine = createUnifiedEngine(m, brokenRunner)
      try {
        await engine.loadSb3(
          Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(mixedProject())) })),
        )
        expect(engine.fallbacks).toBe(1)
        engine.greenFlagCompiled()
        for (let i = 0; i < 40; i++) engine.step()
        const snapshot = engine.snapshot() as {
          targets: Array<{ variables: Record<string, { value: unknown }> }>
        }
        const variables = snapshot.targets[0]!.variables
        // The whole project loaded, so the interpreter ran the script LLVM could
        // not compile instead of dropping it.
        expect(variables.v!.value).toBe('42')
        expect(variables.w!.value).toBe(3)
      } finally {
        engine.dispose()
      }
    },
    120000,
  )

  test.skipIf(!available || !existsSync(sidePath))(
    'runs a loop body as a compiled segment',
    async () => {
      // The loop itself yields every iteration, so the interpreter drives it; the
      // two-block body is a yield-free run and is compiled.
      const segmentRunner: LlvmScriptRunner = {
        buildAdmitted: async () => ({
          ok: true,
          build: {
            side: new Uint8Array(readFileSync(sidePath)),
            metadata: {
              abiDescriptor: 'unused-by-engine',
              slots: [
                { kind: 3, global: 'xyo_aot_slot_0', keyHex: '3700' }, // "7"
                { kind: 0, global: 'xyo_aot_slot_1', keyHex: '76' }, // "v"
              ],
            },
          },
        }),
        runBuilt: async () => ({ ok: false, error: 'unused' }),
      }
      const loopProject = {
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['v', 0] },
            lists: {},
            broadcasts: {},
            costumes: [],
            sounds: [],
            currentCostume: 0,
            volume: 100,
            layerOrder: 0,
            blocks: {
              hat: {
                opcode: 'event_whenflagclicked',
                next: 'loop',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
                x: 0,
                y: 0,
              },
              loop: {
                opcode: 'control_repeat',
                next: null,
                parent: 'hat',
                inputs: { TIMES: [1, [6, '3']], SUBSTACK: [2, 'a'] },
                fields: {},
              },
              a: {
                opcode: 'data_setvariableto',
                next: 'b',
                parent: 'loop',
                inputs: { VALUE: [1, [4, '1']] },
                fields: { VARIABLE: ['v', 'v'] },
              },
              b: {
                opcode: 'data_changevariableby',
                next: null,
                parent: 'a',
                inputs: { VALUE: [1, [4, '1']] },
                fields: { VARIABLE: ['v', 'v'] },
              },
            },
          },
        ],
        monitors: [],
        extensions: [],
        meta: { semver: '3.0.0' },
      }
      const m = await loadModule()
      const engine = createUnifiedEngine(m, segmentRunner)
      try {
        await engine.loadSb3(
          Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(loopProject)) })),
        )
        expect(engine.segments).toBe(1)
        engine.greenFlagCompiled()
        for (let i = 0; i < 30; i++) engine.step()
        const snapshot = engine.snapshot() as {
          targets: Array<{ variables: Record<string, { value: unknown }> }>
        }
        // The stub module writes a fixed value, so the assertion is about the
        // runtime actually invoking the registered function (the interpreter
        // would not), not about the compiled semantics.
        expect(engine.segmentHits).toBeGreaterThan(0)
        expect(snapshot.targets[0]!.variables.v!.value).toBe('7')
      } finally {
        engine.dispose()
      }
    },
    120000,
  )

  test.skipIf(!available || !existsSync(sidePath))(
    'green flag twice accumulates from live state',
    async () => {
      const m = await loadModule()
      const engine = createUnifiedEngine(m, fixedRunner)
      try {
        await engine.loadSb3(
          Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(mixedProject())) })),
        )
        engine.greenFlagCompiled()
        for (let i = 0; i < 40; i++) engine.step()
        engine.greenFlagCompiled()
        for (let i = 0; i < 40; i++) engine.step()
        const snapshot = engine.snapshot() as {
          targets: Array<{ variables: Record<string, { value: unknown }> }>
        }
        const variables = snapshot.targets[0]!.variables
        // Interpreter loop runs again: 3 + 3.
        expect(variables.w!.value).toBe(6)
        // The compiled script sets 42 again (set, not change): still "42".
        expect(variables.v!.value).toBe('42')
      } finally {
        engine.dispose()
      }
    },
    120000,
  )
})
