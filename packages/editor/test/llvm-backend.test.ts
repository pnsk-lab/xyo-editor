import { describe, expect, test } from 'bun:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createLlvmBackend, type LlvmScriptRunner } from '../src/lib/llvm-backend'

function setProject(variableId = 'v', literal = '42') {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { [variableId]: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'set',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          set: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'hat',
            inputs: { VALUE: [1, [4, literal]] },
            fields: { VARIABLE: ['v', variableId] },
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
function changeProject() {
  const p = setProject()
  p.targets[0]!.blocks.set.opcode = 'data_changevariableby'
  return p
}
function mixedProject() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { v: ['v', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'set',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          set: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'hat',
            inputs: { VALUE: [1, [4, '42']] },
            fields: { VARIABLE: ['v', 'v'] },
            topLevel: false,
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
        x: 0,
        y: 0,
        direction: 90,
        size: 100,
        visible: true,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          hat2: {
            opcode: 'event_whenflagclicked',
            next: 'move',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 10,
            y: 10,
          },
          move: {
            opcode: 'motion_movesteps',
            next: null,
            parent: 'hat2',
            inputs: { STEPS: [1, [4, '10']] },
            fields: {},
          },
        },
        costumes: [],
        sounds: [],
        currentCostume: 0,
        volume: 100,
        layerOrder: 1,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0' },
  }
}
const sb3 = (project: unknown) =>
  Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))
const fakeBuild = {
  side: new Uint8Array([0, 97, 115, 109]),
  metadata: {
    abiDescriptor: 'abi',
    slots: [] as Array<{ global: string; kind: number; keyHex: string }>,
  },
}
function fakeRunner(
  vars: Array<{ id: string; valueHex: string; units: number[] | null }>,
  calls: { builds: unknown[]; runs: unknown[] } = { builds: [], runs: [] },
): LlvmScriptRunner {
  return {
    buildAdmitted: async (input) => {
      calls.builds.push(input)
      return { ok: true, build: fakeBuild }
    },
    runBuilt: async (input) => {
      calls.runs.push(input)
      return { ok: true, variables: vars }
    },
  }
}

describe('LLVM wrapper backend (fake runner, real built-in VM)', () => {
  test('admitted scripts run on LLVM and commit; the rest stays silent there', async () => {
    const calls = { builds: [] as unknown[], runs: [] as unknown[] }
    const backend = createLlvmBackend(
      fakeRunner([{ id: 'v', valueHex: '0x7ff900000005f61c', units: [0x34, 0x32] }], calls),
    )
    await backend.vm.loadProject(sb3(setProject()))
    // Building happens once at load from a minimal single-script project.
    expect(calls.builds).toHaveLength(1)
    const sent = calls.builds[0] as {
      project: { targets: Array<{ blocks: Record<string, unknown> }> }
    }
    expect(Object.keys(sent.project.targets[0]!.blocks).sort()).toEqual(['hat', 'set'])
    backend.vm.greenFlag()
    await backend.settled()
    expect(calls.runs).toHaveLength(1)
    expect(backend.lastError()).toBeNull()
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe('42')
    backend.dispose?.()
  })

  test('non-admitted threads still run in the wrapped VM alongside LLVM', async () => {
    const calls = { builds: [] as unknown[], runs: [] as unknown[] }
    const backend = createLlvmBackend(
      fakeRunner([{ id: 'v', valueHex: '0x7ff900000005f61c', units: [0x34, 0x32] }], calls),
    )
    await backend.vm.loadProject(sb3(mixedProject()))
    backend.vm.greenFlag()
    await backend.settled()
    for (let i = 0; i < 10; i++) backend.vm.step()
    expect(calls.builds).toHaveLength(1)
    expect(calls.runs).toHaveLength(1)
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe('42')
    expect(backend.vm.getTarget('Sprite1')?.x).toBe(10)
    backend.dispose?.()
  })

  test('reflag starts from live values so change accumulates', async () => {
    const calls = { builds: [] as unknown[], runs: [] as unknown[] }
    // Fake runner with change semantics: reads the seeded initial from the
    // SB3 it receives and adds 42, like the real host would from live state.
    const runner: LlvmScriptRunner = {
      buildAdmitted: async (input) => {
        calls.builds.push(input)
        return { ok: true, build: fakeBuild }
      },
      runBuilt: async (input) => {
        calls.runs.push(input)
        const files = unzipSync(input.sb3) as unknown as Record<string, Uint8Array>
        const seeded = JSON.parse(new TextDecoder().decode(files['project.json'])) as {
          targets: Array<{ variables: Record<string, [string, number]> }>
        }
        const initial = seeded.targets[0]!.variables['v']![1]
        const view = new DataView(new ArrayBuffer(8))
        view.setFloat64(0, (initial as number) + 42)
        return {
          ok: true,
          variables: [{ id: 'v', valueHex: '0x' + view.getBigUint64(0).toString(16), units: null }],
        }
      },
    }
    const backend = createLlvmBackend(runner)
    await backend.vm.loadProject(sb3(changeProject()))
    backend.vm.greenFlag()
    await backend.settled()
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe(42)
    backend.vm.greenFlag()
    await backend.settled()
    // 42 + 42: the second execution seeded from live state, not from zero.
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe(84)
    expect(calls.builds).toHaveLength(1)
    expect(calls.runs).toHaveLength(2)
    backend.dispose?.()
  })

  test('green flag during a slow load waits for the build instead of skipping', async () => {
    const calls = { builds: [] as unknown[], runs: [] as unknown[] }
    let releaseBuild!: (v: { ok: true; build: typeof fakeBuild }) => void
    const backend = createLlvmBackend({
      buildAdmitted: (input) =>
        new Promise<{ ok: true; build: typeof fakeBuild }>((r) => {
          calls.builds.push(input)
          releaseBuild = r
        }),
      runBuilt: async (input) => {
        calls.runs.push(input)
        return {
          ok: true,
          variables: [{ id: 'v', valueHex: '0x7ff900000005f61c', units: [0x34, 0x32] }],
        }
      },
    })
    const loading = backend.vm.loadProject(sb3(setProject()))
    // Flag immediately, long before the build resolves.
    backend.vm.greenFlag()
    await Bun.sleep(10)
    expect(calls.runs).toEqual([])
    releaseBuild({ ok: true, build: fakeBuild })
    await loading
    await backend.settled()
    expect(calls.runs).toHaveLength(1)
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe('42')
    expect(backend.lastError()).toBeNull()
    backend.dispose?.()
  })

  test('runner failure never throws green flag and keeps the built-in side', async () => {
    const errors: unknown[] = []
    const backend = createLlvmBackend(
      {
        buildAdmitted: async () => ({
          ok: false as const,
          error: 'compile unavailable in this test',
        }),
        runBuilt: async () => ({ ok: false as const, error: 'unreachable' }),
      },
      {
        onError: (e) => {
          errors.push(e)
        },
      },
    )
    await backend.vm.loadProject(sb3(setProject()))
    backend.vm.greenFlag()
    await backend.settled()
    expect(errors).toHaveLength(1)
    expect(backend.lastError()).not.toBeNull()
    expect(String(backend.lastError())).toContain('compile unavailable')
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe(0)
    backend.dispose?.()
  })

  test('unadmitted projects never touch the runner', async () => {
    const calls = { builds: [] as unknown[], runs: [] as unknown[] }
    const backend = createLlvmBackend(fakeRunner([], calls))
    const wait = setProject()
    wait.targets[0]!.blocks.set.opcode = 'control_wait'
    await backend.vm.loadProject(sb3(wait))
    backend.vm.greenFlag()
    await backend.settled()
    expect(calls.builds).toEqual([])
    expect(calls.runs).toEqual([])
    expect(backend.lastError()).toBeNull()
    backend.dispose?.()
  })

  test('dispose suppresses late commits', async () => {
    let release!: (v: { ok: true; variables: [] }) => void
    const backend = createLlvmBackend({
      buildAdmitted: async () => ({ ok: true, build: fakeBuild }),
      runBuilt: () =>
        new Promise((r) => {
          release = r
        }),
    })
    await backend.vm.loadProject(sb3(setProject()))
    backend.vm.greenFlag()
    backend.dispose?.()
    release({ ok: true, variables: [] })
    await backend.settled()
    expect(backend.vm.getVariableValue('Stage', 'v')).toBe(0)
  })
})
