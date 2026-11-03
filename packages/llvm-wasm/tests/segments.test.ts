import { describe, expect, test } from 'bun:test'
import { admitSb3Project } from '../src/admission'
import { findSegments } from '../src/segments'

const num = (n: number) => [1, [4, String(n)]]
const setBlock = (id: string, next: string | null, variable = 'v', value = 1) => ({
  opcode: 'data_setvariableto', next, parent: null, inputs: { VALUE: num(value) }, fields: { VARIABLE: ['v', variable] },
})
const changeBlock = (id: string, next: string | null, variable = 'v') => ({
  opcode: 'data_changevariableby', next, parent: null, inputs: { VALUE: num(2) }, fields: { VARIABLE: ['v', variable] },
})
const hat = (next: string | null) => ({ opcode: 'event_whenflagclicked', next, parent: null, inputs: {}, fields: {}, topLevel: true, x: 0, y: 0 })
const target = (blocks: Record<string, unknown>) => ({
  isStage: true, name: 'Stage', variables: { v: ['v', 0] }, lists: {}, broadcasts: {}, blocks,
  costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0,
})
const project = (blocks: Record<string, unknown>) => ({ targets: [target(blocks)], monitors: [], extensions: [], meta: { semver: '3.0.0' } })

describe('segment extraction', () => {
  test('a plain run inside a loop becomes one segment', () => {
    const result = findSegments(project({
      hat: hat('loop'),
      loop: { opcode: 'control_repeat', next: null, parent: 'hat', inputs: { TIMES: num(3), SUBSTACK: [2, 'a'] }, fields: {} },
      a: setBlock('a', 'b'),
      b: changeBlock('b', null),
    }))
    expect(result.ok).toBe(true)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]!.blocks).toEqual(['a', 'b'])
    // The synthesized project is itself compilable by the existing gate.
    expect(admitSb3Project(result.segments[0]!.project).route).toBe('llvm')
  })

  test('a single plain block is below the default minimum', () => {
    const result = findSegments(project({
      hat: hat('loop'),
      loop: { opcode: 'control_repeat', next: null, parent: 'hat', inputs: { TIMES: num(3), SUBSTACK: [2, 'a'] }, fields: {} },
      a: setBlock('a', null),
    }))
    expect(result.segments).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  test('non-plain blocks split a run in two', () => {
    const result = findSegments(project({
      hat: hat('a'),
      a: setBlock('a', 'b'),
      b: changeBlock('b', 'wait'),
      wait: { opcode: 'control_wait', next: 'c', parent: 'b', inputs: { DURATION: num(1) }, fields: {} },
      c: setBlock('c', 'd'),
      d: changeBlock('d', null),
    }))
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]!.blocks).toEqual(['a', 'b'])
    expect(result.segments[1]!.blocks).toEqual(['c', 'd'])
  })

  test('the synthesized project ends the segment at its tail', () => {
    const result = findSegments(project({
      hat: hat('loop'),
      loop: { opcode: 'control_repeat', next: null, parent: 'hat', inputs: { TIMES: num(3), SUBSTACK: [2, 'a'] }, fields: {} },
      a: setBlock('a', 'b'),
      b: changeBlock('b', 'c'),
      c: setBlock('c', null),
    }))
    const single = result.segments[0]!.project as { targets: Array<{ blocks: Record<string, { next: unknown }> }> }
    const blocks = single.targets[0]!.blocks
    expect(blocks['c']!.next).toBeNull()
    expect(Object.keys(blocks).sort()).toEqual(['__xyo_segment_hat', 'a', 'b', 'c'])
  })

  test('reports a non-project input instead of guessing', () => {
    expect(findSegments(null).ok).toBe(false)
    expect(findSegments({ targets: 'nope' }).ok).toBe(false)
  })
})
