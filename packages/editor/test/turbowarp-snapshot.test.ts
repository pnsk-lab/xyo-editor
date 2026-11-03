import { describe, expect, it } from 'bun:test'
import { turboWarpSnapshot } from '../src/lib/turbowarp-snapshot'

describe('TurboWarp runtime snapshot', () => {
  it('converts live targets, clones, monitor records and threads without sharing values', () => {
    const sprite = {
      name: 'Cat',
      costumes: [{ name: 'a', assetId: 'abc', md5: 'abc.svg', dataFormat: 'svg' }],
      sounds: [],
    }
    const stage = {
      id: 'stage-id',
      isStage: true,
      isOriginal: true,
      sprite: { name: 'Stage', costumes: [], sounds: [] },
      variables: {
        v: { name: 'score', value: 7, type: '', isCloud: true },
        b: { name: 'go', value: 'go', type: 'broadcast_msg' },
      },
      blocks: { _blocks: {} },
    }
    const original = {
      id: 'cat-id',
      isOriginal: true,
      sprite,
      x: 999,
      y: 10,
      size: 100,
      direction: 90,
      variables: { l: { name: 'list', value: [1, 'two'], type: 'list' } },
      blocks: {
        _blocks: {
          a: {
            opcode: 'motion_movesteps',
            fields: { F: { value: 'yes', id: 'f' } },
            inputs: { STEPS: { block: 'b', shadow: 'b' } },
          },
        },
      },
    }
    const clone = { ...original, id: 'clone-id', isOriginal: false, x: -900 }
    const monitor = {
      id: 'l',
      opcode: 'data_listcontents',
      mode: 'list',
      params: { LIST: 'list' },
      value: [1, 'two'],
      visible: true,
      x: 0,
      y: 0,
    }
    const runtime = {
      targets: [stage, original, clone],
      executableTargets: [stage, clone, original],
      _editingTarget: original,
      _monitorState: { valueSeq: () => [monitor] },
      threads: [
        { target: clone, topBlock: 'a', stack: ['a', 'b'], status: 1 },
        { updateMonitor: true },
      ],
      turboMode: true,
      origin: 'example',
      frameLoop: { framerate: 30 },
    }
    const result = turboWarpSnapshot({ runtime })
    expect(result.selectedTargetId).toBe('cat-id')
    expect(result.project.targets.map((t) => t.id)).toEqual(['stage-id', 'cat-id', 'clone-id'])
    expect(result.project.targets[2].cloneOf).toBe('cat-id')
    expect(result.project.targets[2].x).toBe(-900)
    expect(result.project.targets[1].layerOrder).toBe(2)
    expect(result.project.targets[0].variables.v).toEqual(['score', 7, true])
    expect(result.project.targets[0].broadcasts.b).toBe('go')
    expect(result.project.targets[1].lists.l).toEqual(['list', [1, 'two']])
    expect(result.project.targets[1].blocks.a.inputs?.STEPS).toEqual([1, 'b'])
    expect(result.project.monitors[0].value).toEqual([1, 'two'])
    expect(result.threads).toEqual([
      { targetName: 'Cat', topBlockId: 'a', currentBlockId: 'b', status: 'waiting' },
    ])
    expect(result.running && result.turboMode && result.compatibilityMode).toBe(true)
    original.variables.l.value.push('changed')
    monitor.value.push('changed')
    expect(result.project.targets[1].lists.l[1]).toEqual([1, 'two'])
    expect(result.project.monitors[0].value).toEqual([1, 'two'])
  })
  it('does not invent a sprite for a stage-only project', () => {
    const result = turboWarpSnapshot({
      vm: {
        runtime: {
          targets: [{ id: 's', isStage: true, isOriginal: true, sprite: { name: 'Stage' } }],
        },
      },
    })
    expect(result.project.targets.map((t) => t.id)).toEqual(['s'])
    expect(result.selectedTargetId).toBe('s')
  })
})
