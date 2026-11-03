import { describe, expect, test } from 'bun:test'
import { ScratchVM } from '../../vm/src/index'
import { overlayXyoSnapshot, type XyoTarget } from './snapshot'

const live = (id: string, name: string, isStage: boolean, isOriginal = true): XyoTarget => ({ id, name, isStage, isOriginal, x: 1234, y: -987, direction: 35, size: 90, volume: 25, visible: true, currentCostume: 0, layerOrder: 2, bubbleText: '', bubbleType: '', variables: {} })

describe('headless snapshot overlay', () => {
  test('maps regenerated IDs, variables and clones without mutating the model', () => {
    const model = new ScratchVM().snapshot()
    const sprite = model.project.targets.find(t => !t.isStage)!
    sprite.variables = { editorVar: ['score', 1, true] }
    sprite.lists = { editorList: ['items', ['old']] }
    const before = structuredClone(model)
    const stage = model.project.targets.find(t => t.isStage)!
    const original = live('generated', sprite.name, false)
    original.variables = { newVar: { name: 'score', type: '', value: 8 }, newList: { name: 'items', type: 'list', value: [1, 'x'] } }
    const clone = live('clone-id', sprite.name, false, false)
    clone.variables = { newVar: { name: 'score', type: '', value: 11 } }
    const result = overlayXyoSnapshot(model, { targets: [live('stage-new', stage.name, true), original, clone], threadCount: 1, stepSerial: 3 })
    expect(model).toEqual(before)
    expect(result.selectedTargetId).toBe(model.selectedTargetId)
    expect(result.threads).toEqual(model.threads)
    expect(result.project.targets[1].id).toBe(sprite.id)
    expect(result.project.targets[1].x).toBe(1234)
    expect(result.project.targets[1].variables.editorVar).toEqual(['score', 8, true])
    expect(result.project.targets[1].lists.editorList).toEqual(['items', [1, 'x']])
    expect(result.project.targets[1].blocks).toEqual(sprite.blocks)
    expect(result.project.targets[2].cloneOf).toBe(sprite.id ?? sprite.name)
    expect(result.project.targets[2].variables.editorVar[1]).toBe(11)
  })
  test('copies and clears live speech bubbles independently for clones', () => {
    const model = new ScratchVM().snapshot()
    const stage = model.project.targets.find(t => t.isStage)!
    const sprite = model.project.targets.find(t => !t.isStage)!
    sprite.speechBubble = { type: 'say', text: 'stale' }
    const original = live('sprite', sprite.name, false)
    const clone = live('clone', sprite.name, false, false)
    original.bubbleText = 'hello'; original.bubbleType = 'say'
    clone.bubbleText = 'hmm'; clone.bubbleType = 'think'
    const first = overlayXyoSnapshot(model, { targets: [live('stage', stage.name, true), original, clone], threadCount: 1, stepSerial: 1 })
    expect(first.project.targets[1].speechBubble).toEqual({ type: 'say', text: 'hello' })
    expect(first.project.targets[2].speechBubble).toEqual({ type: 'think', text: 'hmm' })
    original.bubbleText = ''
    const cleared = overlayXyoSnapshot(model, { targets: [live('stage', stage.name, true), original], threadCount: 0, stepSerial: 2 })
    expect(cleared.project.targets[1].speechBubble).toBeUndefined()
    expect(sprite.speechBubble?.text).toBe('stale')
  })
  test('refreshes stage and sprite data monitors without changing their metadata', () => {
    const model = new ScratchVM().snapshot()
    const stage = model.project.targets.find(t => t.isStage)!
    const sprite = model.project.targets.find(t => !t.isStage)!
    stage.variables = { global: ['score', 1] }
    stage.lists = { globalList: ['global items', ['old']] }
    sprite.variables = { local: ['score', 2] }
    sprite.lists = { localList: ['items', ['old']] }
    model.project.monitors = [
      { id: 'global', opcode: 'data_variable', params: { VARIABLE: 'score' }, mode: 'slider', visible: true, x: 90, sliderMax: 321, value: 1 },
      { id: `${sprite.id}:local`, opcode: 'data_variable', spriteName: sprite.name, params: { VARIABLE: 'score' }, mode: 'default', visible: false, x: 22, value: 2 },
      { id: 'unrelated-monitor-id', opcode: 'data_listcontents', spriteName: sprite.name, params: { LIST: 'items' }, mode: 'list', visible: true, width: 300, value: [] },
      { id: 'globalList', opcode: 'data_listcontents', params: { LIST: 'global items' }, mode: 'list', visible: true, value: [] },
      { id: `${sprite.id}:x-position`, opcode: 'motion_xposition', params: {}, mode: 'default', visible: true, value: 0 },
      { id: 'y-position', opcode: 'motion_yposition', spriteName: sprite.name, params: {}, mode: 'default', visible: true, value: 0 },
      { id: 'direction', opcode: 'motion_direction', spriteName: sprite.name, params: {}, mode: 'default', visible: true, value: 0 },
      { id: 'size', opcode: 'looks_size', spriteName: sprite.name, params: {}, mode: 'default', visible: true, value: 0 },
      { id: 'volume', opcode: 'sound_volume', spriteName: sprite.name, params: {}, mode: 'default', visible: true, value: 0 },
      { id: 'costume-no', opcode: 'looks_costumenumbername', spriteName: sprite.name, params: { NUMBER_NAME: 'number' }, mode: 'default', visible: true, value: 0 },
      { id: 'costume-name', opcode: 'looks_costumenumbername', spriteName: sprite.name, params: { NUMBER_NAME: 'name' }, mode: 'default', visible: true, value: '' },
      { id: 'backdrop-no', opcode: 'looks_backdropnumbername', params: { NUMBER_NAME: 'number' }, mode: 'default', visible: true, value: 0 },
      { id: 'backdrop-name', opcode: 'looks_backdropnumbername', params: { NUMBER_NAME: 'name' }, mode: 'default', visible: true, value: '' },
      { id: 'other', opcode: 'sensing_answer', params: {}, mode: 'default', visible: true, value: 'keep' },
    ]
    const original = structuredClone(model.project.monitors)
    const st = live('stage', stage.name, true), sp = live('sprite', sprite.name, false)
    st.variables = { global: { name: 'score', type: '', value: 42 }, globalList: { name: 'global items', type: 'list', value: ['global'] } }
    sp.variables = { local: { name: 'score', type: '', value: 99 }, localList: { name: 'items', type: 'list', value: [3, 'live'] } }
    const result = overlayXyoSnapshot(model, { targets: [st, sp], threadCount: 0, stepSerial: 1 })
    expect(result.project.monitors.map(m => m.value)).toEqual([42, 99, [3, 'live'], ['global'], 1234, -987, 35, 90, 25, 1, sprite.costumes[0]?.name ?? '', 1, stage.costumes[0]?.name ?? '', 'keep'])
    expect(result.project.monitors.map(({ value, ...metadata }) => metadata)).toEqual(original.map(({ value, ...metadata }) => metadata))
    expect(model.project.monitors).toEqual(original)
    const withAnswer = overlayXyoSnapshot(model, { targets: [st, sp], threadCount: 0, stepSerial: 2, io: { answer: 'live answer' } })
    expect(withAnswer.project.monitors.at(-1)?.value).toBe('live answer')
  })
  test('rejects conflicting and ambiguous monitor identities', () => {
    const model = new ScratchVM().snapshot()
    const stage = model.project.targets.find(t => t.isStage)!
    const sprite = model.project.targets.find(t => !t.isStage)!
    sprite.variables = { a: ['one', 1], b: ['same', 2], c: ['same', 3] }
    const targets = [live('stage', stage.name, true), live('sprite', sprite.name, false)]
    const snapshot = { targets, threadCount: 0, stepSerial: 0 }
    model.project.monitors = [{ id: 'a', spriteName: sprite.name, opcode: 'data_variable', params: { VARIABLE: 'same' }, mode: 'default', visible: true }]
    expect(() => overlayXyoSnapshot(model, snapshot)).toThrow('conflicting monitor ID')
    model.project.monitors[0].id = 'unknown'
    expect(() => overlayXyoSnapshot(model, snapshot)).toThrow('ambiguous monitor name')
  })
  test('rejects ambiguous names and conflicting variable IDs', () => {
    const model = new ScratchVM().snapshot()
    const sprite = model.project.targets.find(t => !t.isStage)!
    const stage = model.project.targets.find(t => t.isStage)!
    const targets = [live('stage', stage.name, true), live('sprite', sprite.name, false)]
    sprite.variables = { v: ['score', 0] }
    targets[1].variables = { v: { name: 'different', type: '', value: 1 } }
    expect(() => overlayXyoSnapshot(model, { targets, threadCount: 0, stepSerial: 0 })).toThrow()
    targets[1].variables = {}
    model.project.targets.push({ ...structuredClone(sprite), id: 'another' })
    expect(() => overlayXyoSnapshot(model, { targets, threadCount: 0, stepSerial: 0 })).toThrow()
  })
})
