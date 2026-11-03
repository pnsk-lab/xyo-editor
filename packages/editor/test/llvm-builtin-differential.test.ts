import { describe, expect, test } from 'bun:test'
import { admitSb3Project } from '@hikkaku/llvm-wasm'
import { ScratchVM } from '@hikkaku/vm'

// Headless reference semantics for the exact fixture shape that the test-only
// LLVM chain compiles (see llvm-compiler-worker.browser.test.ts): a single
// green-flag script setting one variable to numeric shadow 42. The browser
// chain yields UTF-16 units [0x34, 0x32] ("42") from the real xyo runtime;
// this pins the built-in VM side of that differential to the same value.
// No product wiring; the LLVM backend remains unregistered.
function project(variableId: string, literal: string, opcode = 'data_setvariableto') {
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
            opcode,
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

describe('built-in VM reference for the LLVM single-set fixture', () => {
  test('green flag sets the variable to a value stringifying to 42', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(project('v', '42'))
    vm.greenFlag()
    for (let i = 0; i < 10; i++) vm.step()
    const value = vm.getVariableValue('Stage', 'v')
    expect(String(value)).toBe('42')
  })

  test('reflag reruns the script to the same value', async () => {
    const vm = new ScratchVM()
    await vm.loadProject(project('v', '42'))
    for (let run = 0; run < 2; run++) {
      vm.greenFlag()
      for (let i = 0; i < 10; i++) vm.step()
      expect(String(vm.getVariableValue('Stage', 'v'))).toBe('42')
    }
  })

  test('change-only script accumulates from zero like the LLVM chain', async () => {
    const makeChange = () => {
      const p = project('v', '42')
      p.targets[0]!.blocks.set.opcode = 'data_changevariableby'
      return p
    }
    const vm = new ScratchVM()
    await vm.loadProject(makeChange())
    vm.greenFlag()
    for (let i = 0; i < 10; i++) vm.step()
    // Matches the LLVM side-test expectation 0x4045000000000000 (double 42).
    expect(String(vm.getVariableValue('Stage', 'v'))).toBe('42')
    expect(vm.getVariableValue('Stage', 'v')).toBe(42)
  })

  test('three-block chain accumulates to 22 like the LLVM chain', async () => {
    const blocks: Record<string, unknown> = {
      hat: {
        opcode: 'event_whenflagclicked',
        next: 'b0',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
        x: 10,
        y: 10,
      },
    }
    let prev = 'hat'
    for (const [i, opcode, literal] of [
      [0, 'data_setvariableto', '10'],
      [1, 'data_changevariableby', '5'],
      [2, 'data_changevariableby', '7'],
    ] as const) {
      const id = `b${i}`
      blocks[id] = {
        opcode,
        next: null,
        parent: prev,
        inputs: { VALUE: [1, [4, literal]] },
        fields: { VARIABLE: ['v', 'v'] },
        topLevel: false,
      }
      ;(blocks[prev] as Record<string, unknown>).next = id
      prev = id
    }
    const vm = new ScratchVM()
    await vm.loadProject({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          variables: { v: ['v', 0] },
          lists: {},
          broadcasts: {},
          blocks,
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
    })
    vm.greenFlag()
    for (let i = 0; i < 10; i++) vm.step()
    // Matches the LLVM side-test expectation 0x4036000000000000 (double 22).
    expect(vm.getVariableValue('Stage', 'v')).toBe(22)
  })

  test('two-variable script sets both strings like the LLVM chain', async () => {
    const blocks: Record<string, unknown> = {
      hat: {
        opcode: 'event_whenflagclicked',
        next: 'b0',
        parent: null,
        inputs: {},
        fields: {},
        topLevel: true,
        x: 10,
        y: 10,
      },
      b0: {
        opcode: 'data_setvariableto',
        next: 'b1',
        parent: 'hat',
        inputs: { VALUE: [1, [4, '10']] },
        fields: { VARIABLE: ['v', 'v'] },
        topLevel: false,
      },
      b1: {
        opcode: 'data_setvariableto',
        next: null,
        parent: 'b0',
        inputs: { VALUE: [1, [4, '20']] },
        fields: { VARIABLE: ['w', 'w'] },
        topLevel: false,
      },
    }
    const made = {
      targets: [
        {
          isStage: true,
          name: 'Stage',
          variables: { v: ['v', 0], w: ['w', 0] },
          lists: {},
          broadcasts: {},
          blocks,
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
    expect(admitSb3Project(made).route).toBe('llvm')
    const vm = new ScratchVM()
    await vm.loadProject(made)
    vm.greenFlag()
    for (let i = 0; i < 10; i++) vm.step()
    expect(String(vm.getVariableValue('Stage', 'v'))).toBe('10')
    expect(String(vm.getVariableValue('Stage', 'w'))).toBe('20')
  })

  test('orchestration: admitted scripts route llvm, others fall back and still run', async () => {
    async function runWithFallback(input: unknown) {
      const admission = admitSb3Project(input)
      if (admission.route === 'llvm') return { route: 'llvm' as const, admission }
      const vm = new ScratchVM()
      await vm.loadProject(input)
      vm.greenFlag()
      for (let i = 0; i < 10; i++) vm.step()
      return { route: 'fallback' as const, vm, reason: admission.reason }
    }
    const admitted = await runWithFallback(project('v', '42'))
    expect(admitted.route).toBe('llvm')
    expect(admitSb3Project(project('v', '42', 'data_changevariableby')).route).toBe('llvm')
    const motion = {
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
          x: 0,
          y: 0,
          direction: 90,
          size: 100,
          visible: true,
          variables: {},
          lists: {},
          broadcasts: {},
          blocks: {
            hat: {
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
              parent: 'hat',
              inputs: { STEPS: [1, [4, '25']] },
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
    const fallen = await runWithFallback(motion)
    expect(fallen.route).toBe('fallback')
    if (fallen.route === 'fallback') {
      expect(fallen.reason).toContain('unsupported body opcode')
      expect(fallen.vm.getTarget('Sprite1')?.x).toBe(25)
    }
  })
})
