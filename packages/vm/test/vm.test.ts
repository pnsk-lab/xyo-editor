import { describe, expect, it } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArgumentType, Asset, AssetType, BitmapAdapter, BlockType, Cast, Clone, Color, DataFormat, Helper, MathUtil, SVGRenderer, ScratchCanvasRenderer, ScratchStorage, ScratchVM, StringUtil, TargetType, costumeUpload, createDefaultProject, createVMAsset, defineMessages, extractFileName, getMonitorIdForBlockWithArgs, getProjectTitleFromFilename, loadSvgString, normalizeProject, parse, parseScratchProject, sanitizeSvg, scratchFetch, serializeSvgToString, soundUpload, spriteUpload, toListIndex, uid, unpackScratchInput, validate, validateProject, type RuntimeSnapshot, type ScratchBlock, type ScratchTarget } from '../src/index'

describe('ScratchVM clean-room core', () => {
  it('creates an SB3-shaped default project', () => {
    const project = createDefaultProject()
    expect(project.targets[0]?.isStage).toBe(true)
    expect(project.targets[1]?.name).toBe('Sprite1')
    expect(project.meta.semver).toBe('3.0.0')
  })

  it('normalizes partial SB3 JSON without mutating the input', () => {
    const input = {
      targets: [
        { isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, costumes: [], sounds: [] },
      ],
      cloudVariables: { projectId: 'p1' },
    }
    const project = normalizeProject(input)
    expect(project.targets.some((target) => !target.isStage)).toBe(true)
    expect(input.targets).toHaveLength(1)
    expect(project.cloudVariables).toEqual({ projectId: 'p1' })
  })

  it('preserves zero-valued target metadata while normalizing projects', () => {
    const project = normalizeProject({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          variables: {},
          lists: {},
          broadcasts: {},
          blocks: {},
          comments: {},
          costumes: [{ name: 'empty', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0 }],
          sounds: [],
          volume: 0,
          tempo: 0,
          videoTransparency: 0,
          layerOrder: 0,
        },
        {
          isStage: false,
          name: 'Sprite1',
          variables: {},
          lists: {},
          broadcasts: {},
          blocks: {},
          comments: {},
          costumes: [{ name: 'zero', dataFormat: 'svg', bitmapResolution: 0, rotationCenterX: 0, rotationCenterY: 0 }],
          sounds: [],
          currentCostume: 0,
          volume: 0,
          layerOrder: 0,
          x: 0,
          y: 0,
          size: 0,
          direction: 0,
          effects: { ghost: 0, brightness: 0 },
          pen: { down: true, size: 0, brightness: 0, saturation: 0, transparency: 0, color: '#123456' },
          penLines: [{ x1: 0, y1: 0, x2: 0, y2: 0, size: 0, transparency: 0, color: '#123456' }],
        },
      ],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0', vm: 'test', agent: 'test' },
    })
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    expect(stage.volume).toBe(0)
    expect(stage.tempo).toBe(0)
    expect(stage.videoTransparency).toBe(0)
    expect(stage.layerOrder).toBe(0)
    expect(sprite.volume).toBe(0)
    expect(sprite.layerOrder).toBe(0)
    expect(sprite.x).toBe(0)
    expect(sprite.y).toBe(0)
    expect(sprite.size).toBe(5)
    expect(sprite.direction).toBe(0)
    expect(sprite.effects).toEqual({ ghost: 0, brightness: 0 })
    expect(sprite.pen).toMatchObject({ down: true, size: 1, brightness: 0, saturation: 0, transparency: 0, color: '#123456' })
    expect(sprite.penLines?.[0]).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 0, size: 1, transparency: 0 })
    expect(sprite.costumes[0]).toMatchObject({ bitmapResolution: 1, rotationCenterX: 0, rotationCenterY: 0 })
  })

  it('runs a green-flag motion stack', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true },
      move: { opcode: 'motion_movesteps', parent: 'flag', inputs: { STEPS: [1, [4, '25']] } },
    }
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.x).toBe(25)
  })

  it('keeps control_wait suspended until its duration elapses', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.visible = false
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'show', topLevel: true },
      show: { opcode: 'looks_show', parent: 'flag', next: 'wait' },
      wait: { opcode: 'control_wait', parent: 'show', next: 'hide', inputs: { DURATION: [1, [5, 1]] } },
      hide: { opcode: 'looks_hide', parent: 'wait' },
    }

    vm.loadProject(project)
    vm.greenFlag()
    vm.step(1000)
    expect(vm.getTarget('Sprite1')?.visible).toBe(true)
    vm.step(1500)
    expect(vm.getTarget('Sprite1')?.visible).toBe(true)
    vm.step(2000)
    expect(vm.getTarget('Sprite1')?.visible).toBe(false)
  })

  it('runs clicked Blockly stacks through toggleScript', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      move: { opcode: 'motion_movesteps', next: 'turn', topLevel: true, inputs: { STEPS: [1, [4, '12']] } },
      turn: { opcode: 'motion_turnright', parent: 'move', inputs: { DEGREES: [1, [4, '15']] } },
    }
    vm.loadProject(project)

    const events: string[] = []
    vm.on('PROJECT_RUN_START', () => events.push('start'))
    vm.on('SCRIPT_GLOW_ON', (payload) => events.push(`glow:${(payload as { blockId: string }).blockId}`))

    const thread = vm.toggleScript('move', 'Sprite1')
    expect(thread?.currentBlockId).toBe('move')
    vm.step()
    vm.step()

    expect(vm.getTarget('Sprite1')?.x).toBe(12)
    expect(vm.getTarget('Sprite1')?.direction).toBe(105)
    expect(events).toEqual(['start', 'glow:move'])
  })

  it('runs clicked hat stacks from the first command after the hat', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true },
      move: { opcode: 'motion_movesteps', parent: 'flag', inputs: { STEPS: [1, [4, '9']] } },
    }
    vm.loadProject(project)

    const thread = vm.toggleScript('flag', 'Sprite1')
    expect(thread?.currentBlockId).toBe('move')
    vm.step()

    expect(vm.getTarget('Sprite1')?.x).toBe(9)
  })

  it('allows motion blocks to place sprites outside the stage', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setX', topLevel: true },
      setX: { opcode: 'motion_setx', parent: 'flag', next: 'setY', inputs: { X: [1, [4, '900']] } },
      setY: { opcode: 'motion_sety', parent: 'setX', inputs: { Y: [1, [4, '-420']] } },
    }

    vm.loadProject(project)
    vm.greenFlag()
    vm.step()

    const target = vm.getTarget('Sprite1')!
    expect(target.x).toBe(900)
    expect(target.y).toBe(-420)
  })

  it('casts nonnumeric command inputs without corrupting target state', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 20
    sprite.y = 30
    sprite.size = 100
    sprite.volume = 80
    sprite.variables.score = ['score', 'abc']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setX', topLevel: true },
      setX: { opcode: 'motion_setx', parent: 'flag', next: 'changeX', inputs: { X: [1, [10, 'not-a-number']] } },
      changeX: { opcode: 'motion_changexby', parent: 'setX', next: 'setY', inputs: { DX: [1, [10, 'not-a-number']] } },
      setY: { opcode: 'motion_sety', parent: 'changeX', next: 'setSize', inputs: { Y: [1, [10, 'not-a-number']] } },
      setSize: { opcode: 'looks_setsizeto', parent: 'setY', next: 'changeSize', inputs: { SIZE: [1, [10, 'not-a-number']] } },
      changeSize: { opcode: 'looks_changesizeby', parent: 'setSize', next: 'setEffect', inputs: { CHANGE: [1, [10, 'not-a-number']] } },
      setEffect: { opcode: 'looks_seteffectto', parent: 'changeSize', next: 'setVolume', fields: { EFFECT: ['ghost'] }, inputs: { VALUE: [1, [10, 'not-a-number']] } },
      setVolume: { opcode: 'sound_setvolumeto', parent: 'setEffect', next: 'changeVolume', inputs: { VOLUME: [1, [10, 'not-a-number']] } },
      changeVolume: { opcode: 'sound_changevolumeby', parent: 'setVolume', next: 'changeVariable', inputs: { VOLUME: [1, [10, 'not-a-number']] } },
      changeVariable: { opcode: 'data_changevariableby', parent: 'changeVolume', fields: { VARIABLE: ['score', 'score'] }, inputs: { VALUE: [1, [10, 'not-a-number']] } },
    }
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.x).toBe(0)
    expect(target.y).toBe(0)
    expect(target.size).toBe(5)
    expect(target.effects?.ghost).toBe(0)
    expect(target.volume).toBe(0)
    expect(vm.getVariableValue('Sprite1', 'score')).toBe(0)
  })

  it('evaluates SB3 variable literal inputs as variable reporters', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.flag = ['flag?', 'true']
    sprite.variables.result = ['result', false]
    sprite.lists.items = ['items', ['a', 'b']]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setResult', topLevel: true },
      setResult: {
        opcode: 'data_setvariableto',
        parent: 'flag',
        next: 'setListResult',
        fields: { VARIABLE: ['result', 'result'] },
        inputs: { VALUE: [2, 'equalsFlag'] },
      },
      equalsFlag: {
        opcode: 'operator_equals',
        parent: 'setResult',
        inputs: { OPERAND1: [1, [12, 'flag?', 'flag']], OPERAND2: [1, [10, 'true']] },
      },
      setListResult: {
        opcode: 'data_setvariableto',
        parent: 'setResult',
        fields: { VARIABLE: ['result', 'result'] },
        inputs: { VALUE: [2, 'equalsList'] },
      },
      equalsList: {
        opcode: 'operator_equals',
        parent: 'setListResult',
        inputs: { OPERAND1: [1, [13, 'items', 'items']], OPERAND2: [1, [10, 'a b']] },
      },
    }
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()

    expect(vm.getVariableValue('Sprite1', 'result')).toBe(true)
  })

  it('updates and removes SB3 data literal input references with variables and lists', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.flag = ['flag?', 'true']
    sprite.lists.items = ['items', ['a']]
    sprite.blocks = {
      equalsFlag: { opcode: 'operator_equals', inputs: { OPERAND1: [1, [12, 'flag?', 'flag']], OPERAND2: [1, [10, 'true']] } },
      equalsItems: { opcode: 'operator_equals', inputs: { OPERAND1: [1, [13, 'items', 'items']], OPERAND2: [1, [10, 'a']] } },
    }
    vm.loadProject(project)

    vm.renameVariable('Sprite1', 'flag', 'renamed flag')
    vm.renameList('Sprite1', 'items', 'renamed items')
    const renamed = vm.getTarget('Sprite1')!
    expect(renamed.blocks.equalsFlag?.inputs?.OPERAND1?.[1]).toEqual([12, 'renamed flag', 'flag'])
    expect(renamed.blocks.equalsItems?.inputs?.OPERAND1?.[1]).toEqual([13, 'renamed items', 'items'])

    vm.deleteVariable('Sprite1', 'flag')
    vm.deleteList('Sprite1', 'items')
    expect(renamed.blocks.equalsFlag?.inputs?.OPERAND1?.[1]).toBeNull()
    expect(renamed.blocks.equalsItems?.inputs?.OPERAND1?.[1]).toBeNull()
  })

  it('emits project-run-stop only when execution transitions to stopped', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'done', topLevel: true },
      done: { opcode: 'data_setvariableto', parent: 'flag', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    let stops = 0
    vm.on('PROJECT_RUN_STOP', () => {
      stops += 1
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    vm.step()
    expect(stops).toBe(1)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('1')
  })

  it('does not duplicate project-run-stop when a stop-all block runs', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'stop', topLevel: true },
      stop: { opcode: 'control_stop', parent: 'flag', fields: { STOP_OPTION: ['all'] } },
    }
    let runStops = 0
    let stopAlls = 0
    vm.on('PROJECT_RUN_STOP', () => {
      runStops += 1
    })
    vm.on('PROJECT_STOP_ALL', () => {
      stopAlls += 1
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(runStops).toBe(1)
    expect(stopAlls).toBe(1)
  })

  it('exports a defensive copy', () => {
    const vm = new ScratchVM()
    const exported = vm.exportProject()
    exported.targets[1]!.name = 'Changed'
    expect(vm.getTarget('Changed')).toBeUndefined()
  })

  it('does not mark a project changed while loading', () => {
    const vm = new ScratchVM()
    let changed = 0
    let loaded = 0
    vm.on('PROJECT_CHANGED', () => {
      changed += 1
    })
    vm.on('PROJECT_LOADED', () => {
      loaded += 1
    })
    vm.loadProject(createDefaultProject())
    expect(loaded).toBe(1)
    expect(changed).toBe(0)
  })

  it('clears transient hat and keyboard state when loading a project', () => {
    const first = createDefaultProject()
    const firstSprite = first.targets[1]!
    firstSprite.variables.count = ['count', 0]
    firstSprite.blocks = {
      keyHat: { opcode: 'event_whenkeypressed', next: 'change', topLevel: true, fields: { KEY_OPTION: ['space', 'space'] } },
      change: { opcode: 'data_changevariableby', parent: 'keyHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
      loudHat: { opcode: 'event_whengreaterthan', next: 'loudChange', topLevel: true, fields: { WHENGREATERTHANMENU: ['LOUDNESS'] }, inputs: { VALUE: [1, [4, '20']] } },
      loudChange: { opcode: 'data_changevariableby', parent: 'loudHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(first)
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.postIOData('audio', { loudness: 30 })
    vm.step()

    const second = createDefaultProject()
    const secondSprite = second.targets[1]!
    secondSprite.variables.count = ['count', 0]
    secondSprite.blocks = structuredClone(firstSprite.blocks)
    vm.loadProject(second)
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(2)
  })

  it('emits turbo events only when the mode changes', () => {
    const vm = new ScratchVM()
    let on = 0
    let off = 0
    vm.on('TURBO_MODE_ON', () => {
      on += 1
    })
    vm.on('TURBO_MODE_OFF', () => {
      off += 1
    })
    vm.setTurboMode(true)
    vm.setTurboMode(true)
    vm.setTurboMode(false)
    expect(on).toBe(1)
    expect(off).toBe(1)
  })

  it('supports sprite and variable mutations through the public facade', () => {
    const vm = new ScratchVM()
    const duplicate = vm.duplicateSprite('Sprite1')
    expect(duplicate?.name).toStartWith('Sprite1 copy')
    expect(duplicate?.id).toBeDefined()
    const duplicateId = duplicate!.id!
    expect(vm.getTargetIdForDrawableId(duplicateId)).toBe(duplicateId)
    expect(vm.reorderTarget(2, 1)).toBe(true)
    expect(vm.getSprites()[0]?.id).toBe(duplicate!.id)
    const variableId = vm.createVariable(duplicate!.name, 'score', 1)
    vm.setVariableValue(duplicate!.name, variableId, 5)
    expect(vm.getVariableValue(duplicate!.name, variableId)).toBe(5)
    vm.upsertVariableMonitor(duplicate!.name, variableId, true)
    expect(vm.getMonitors()[0]?.spriteName).toBe(duplicate!.name)
    expect(vm.renameSprite(duplicate!.name, 'RenamedSprite')).toBe(true)
    expect(vm.getMonitors()[0]?.spriteName).toBe('RenamedSprite')
    const renamedTarget = vm.getTarget('RenamedSprite')!
    renamedTarget.blocks.setScore = { opcode: 'data_setvariableto', fields: { VARIABLE: ['score', variableId] } }
    expect(vm.renameVariable('RenamedSprite', variableId, 'points')).toBeUndefined()
    expect(renamedTarget.blocks.setScore.fields?.VARIABLE).toEqual(['points', variableId])
    expect(vm.getMonitors()[0]?.params.VARIABLE).toBe('points')
    const listId = vm.createList('RenamedSprite', 'items', ['a'])
    renamedTarget.blocks.showList = { opcode: 'data_showlist', fields: { LIST: ['items', listId] } }
    vm.upsertListMonitor('RenamedSprite', listId, true)
    vm.renameList('RenamedSprite', listId, 'things')
    expect(renamedTarget.blocks.showList.fields?.LIST).toEqual(['things', listId])
    expect(vm.getMonitors().find((monitor) => monitor.opcode === 'data_listcontents')?.params.LIST).toBe('things')
    vm.deleteList('RenamedSprite', listId)
    expect(renamedTarget.blocks.showList).toBeUndefined()
    expect(vm.getMonitors().some((monitor) => monitor.opcode === 'data_listcontents')).toBe(false)
    vm.deleteVariable('RenamedSprite', variableId)
    expect(vm.getVariableValue('RenamedSprite', variableId)).toBeUndefined()
    expect(renamedTarget.blocks.setScore).toBeUndefined()
    expect(vm.getMonitors().some((monitor) => monitor.opcode === 'data_variable')).toBe(false)

    const safeId = vm.createVariable('RenamedSprite', 'safe', 0)
    renamedTarget.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'deleteMe', topLevel: true },
      deleteMe: { opcode: 'data_setvariableto', parent: 'flag', next: 'child', fields: { VARIABLE: ['safe', safeId] } },
      child: { opcode: 'motion_movesteps', parent: 'deleteMe', inputs: { STEPS: [1, [4, '10']] } },
      keepParent: { opcode: 'looks_say', inputs: { MESSAGE: [2, 'safeReporter'] } },
      safeReporter: { opcode: 'data_variable', parent: 'keepParent', fields: { VARIABLE: ['safe', safeId] } },
    }
    vm.deleteVariable('RenamedSprite', safeId)
    expect(renamedTarget.blocks.deleteMe).toBeUndefined()
    expect(renamedTarget.blocks.child).toBeUndefined()
    expect(renamedTarget.blocks.keepParent).toBeDefined()
    expect(renamedTarget.blocks.keepParent?.inputs?.MESSAGE?.[1]).toBeNull()
  })

  it('supports Scratch VM promise-style sprite and workspace mutation APIs', async () => {
    const vm = new ScratchVM()
    const duplicate = vm.duplicateSprite('Sprite1')
    expect(duplicate?.name).toStartWith('Sprite1 copy')
    await expect(Promise.resolve(duplicate)).resolves.toMatchObject({ name: duplicate?.name })
    const added = vm.addSprite('Sprite2')
    expect(added.name).toBe('Sprite2')
    await expect(Promise.resolve(added)).resolves.toMatchObject({ name: 'Sprite2' })
    await expect(vm.deleteSprite('Sprite2')).resolves.toBeUndefined()
    await expect(vm.installTargets([vm.getStage(), vm.getTarget('Sprite1')!], ['pen'], true)).resolves.toBeUndefined()
    vm.addSprite('Sprite2')
    await expect(vm.shareBlocksToTarget({ flag: { opcode: 'event_whenflagclicked', topLevel: true } }, 'Sprite2', 'Sprite1')).resolves.toBe(true)
    await expect(vm.shareBlocksToTarget({}, 'missing-target')).resolves.toBe(false)
  })

  it('keeps default sprite costumes independent when adding and painting sprites', async () => {
    const vm = new ScratchVM()
    const originalCostume = vm.getTarget('Sprite1')?.costumes[0]
    const added = vm.addSprite('Sprite2')

    expect(added.costumes[0]).toEqual(originalCostume)
    expect(vm.getTarget('Sprite2')?.costumes[0]).not.toBe(originalCostume)

    await vm.updateCostume('Sprite2', 0, { name: 'painted', dataFormat: 'svg' }, strToU8('<svg id="painted"></svg>'))

    expect(vm.getTarget('Sprite2')?.costumes[0]).toMatchObject({ name: 'painted', assetId: expect.any(String), md5ext: expect.stringContaining('.svg') })
    expect(vm.getTarget('Sprite1')?.costumes[0]).toMatchObject({ name: 'costume1', assetId: 'default-sprite', md5ext: 'default-sprite.svg' })
    expect(String(vm.getCostume(0, 'Sprite1'))).not.toContain('painted')
  })

  it('emits Scratch GUI facade event names and payload shapes', () => {
    const vm = new ScratchVM()
    let targetsUpdate: { targetList?: unknown[]; editingTarget?: { name?: string } } | undefined
    let workspaceUpdate: { xml?: string } | undefined
    let playgroundData: { blocks?: Record<string, unknown> } | undefined
    vm.on('targetsUpdate', (payload) => {
      targetsUpdate = payload as typeof targetsUpdate
    })
    vm.on('workspaceUpdate', (payload) => {
      workspaceUpdate = payload as typeof workspaceUpdate
    })
    vm.on('playgroundData', (payload) => {
      playgroundData = payload as typeof playgroundData
    })
    vm.selectTarget('Sprite1')
    expect(targetsUpdate?.targetList?.length).toBe(2)
    expect(targetsUpdate?.editingTarget?.name).toBe('Sprite1')
    expect(workspaceUpdate?.xml).toContain('<xml')
    vm.getPlaygroundData()
    expect(playgroundData?.blocks).toBeDefined()
  })

  it('can select targets by stable id or name', () => {
    const vm = new ScratchVM()
    const sprite = vm.getTarget('Sprite1')!
    const spriteId = sprite.id!
    vm.selectTarget(spriteId)
    expect(vm.snapshot().selectedTargetId).toBe(spriteId)
    expect(vm.getTarget(sprite.name)?.id).toBe(spriteId)
    vm.updateTarget(spriteId, { drawableId: 42 })
    expect(vm.getTargetIdForDrawableId(42)).toBe(spriteId)
    expect(vm.getTargetIdForDrawableId('42')).toBe(spriteId)
    expect(vm.runtime.getTargetByDrawableId(42)?.id).toBe(spriteId)
  })

  it('preserves unknown block fields and mutations', () => {
    const project = createDefaultProject()
    project.targets[1]!.blocks = {
      custom: {
        opcode: 'unknown_extension_block',
        mutation: { tagName: 'mutation', custom: true },
        topLevel: true,
        x: 12,
        y: 34,
        extensionData: { kept: true },
      },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    const block = vm.exportProject().targets[1]!.blocks.custom!
    expect(block.mutation?.custom).toBe(true)
    expect(block.extensionData).toEqual({ kept: true })
  })

  it('supports JSON string and byte project loading', async () => {
    const text = JSON.stringify(createDefaultProject())
    const fromString = new ScratchVM()
    await fromString.loadProject(text)
    expect(fromString.getStage().name).toBe('Stage')

    const fromBytes = new ScratchVM()
    await fromBytes.loadProject(new TextEncoder().encode(text))
    expect(fromBytes.getSprites()[0]?.name).toBe('Sprite1')
  })

  it('rejects invalid project loads without mutating the current project', async () => {
    const vm = new ScratchVM()
    vm.renameSprite('Sprite1', 'Kept')
    await expect(vm.loadProject('{broken json')).rejects.toThrow()
    expect(vm.getTarget('Kept')?.name).toBe('Kept')
  })

  it('applies workspace replacement through the change facade', () => {
    const vm = new ScratchVM()
    vm.applyWorkspaceChange('Sprite1', {
      blocks: {
        flag: { opcode: 'event_whenflagclicked', next: null, topLevel: true, x: 1, y: 2 },
      },
    })
    expect(vm.exportProject().targets[1]!.blocks.flag?.opcode).toBe('event_whenflagclicked')
  })

  it('supports costume, sound, and list facade methods', async () => {
    const vm = new ScratchVM()
    await expect(vm.addCostume('Sprite1', { name: 'second' })).resolves.toBe(1)
    await expect(vm.duplicateCostume('Sprite1', 1)).resolves.toBe(2)
    expect(vm.reorderCostume('not-a-target', 0, 1)).toBe(false)
    expect(vm.reorderCostume('Sprite1', 2, 1)).toBe(true)
    expect(vm.renameCostume('Sprite1', 1, 'renamed')).toBe(true)
    vm.setCurrentCostume('Sprite1', 1)
    expect(vm.getTarget('Sprite1')?.costumes).toHaveLength(3)
    expect(vm.getTarget('Sprite1')?.costumes[1]?.name).toBe('renamed')
    expect(vm.getTarget('Sprite1')?.currentCostume).toBe(1)
    const restoreCostume = vm.deleteCostume('Sprite1', 1)
    expect(vm.getTarget('Sprite1')?.costumes).toHaveLength(2)
    restoreCostume?.()
    expect(vm.getTarget('Sprite1')?.costumes[1]?.name).toBe('renamed')

    await expect(vm.addSound('Sprite1', { name: 'pop' })).resolves.toBe(0)
    await expect(vm.duplicateSound('Sprite1', 0)).resolves.toBe(1)
    expect(vm.renameSound('Sprite1', 1, 'pop copy')).toBe(true)
    expect(vm.reorderSound('not-a-target', 0, 1)).toBe(false)
    expect(vm.reorderSound('Sprite1', 1, 0)).toBe(true)
    expect(vm.getTarget('Sprite1')?.sounds).toHaveLength(2)
    expect(vm.getTarget('Sprite1')?.sounds[0]?.name).toBe('pop copy')

    const listId = vm.createList('Sprite1', 'items', ['a'])
    vm.setListValue('Sprite1', listId, ['b', 2])
    expect(vm.getListValue('Sprite1', listId)).toEqual(['b', 2])
    const globalId = vm.createVariable('Stage', 'global', 1)
    const globalListId = vm.createList('Stage', 'global items', ['stage'])
    vm.setVariableValue('Sprite1', globalId, 7)
    vm.setListValue('Sprite1', globalListId, ['from sprite'])
    expect(vm.getVariableValue('Sprite1', globalId)).toBe(7)
    expect(vm.getVariableValue('Sprite1', 'global')).toBe(7)
    expect(vm.getListValue('Sprite1', globalListId)).toEqual(['from sprite'])
    expect(vm.getListValue('Sprite1', 'global items')).toEqual(['from sprite'])
    vm.renameVariable('Sprite1', globalId, 'renamed global')
    vm.renameList('Sprite1', globalListId, 'renamed global items')
    expect(vm.getVariableValue('Sprite1', 'renamed global')).toBe(7)
    expect(vm.getVariableValue('Stage', globalId)).toBe(7)
    expect(vm.getListValue('Sprite1', 'renamed global items')).toEqual(['from sprite'])
    expect(vm.getListValue('Stage', globalListId)).toEqual(['from sprite'])
    vm.deleteVariable('Sprite1', globalId)
    vm.deleteList('Sprite1', globalListId)
    expect(vm.getVariableValue('Stage', globalId)).toBeUndefined()
    expect(vm.getListValue('Stage', globalListId)).toBeUndefined()
    const scoreId = vm.createVariable('Sprite1', 'score', 0)
    vm.upsertVariableMonitor('Sprite1', scoreId, true)
    vm.upsertListMonitor('Sprite1', listId, true)
    vm.setVariableValue('Sprite1', scoreId, 9)
    vm.setListValue('Sprite1', listId, ['c'])
    expect(vm.snapshot().project.monitors.find((monitor) => monitor.opcode === 'data_variable')?.value).toBe(9)
    expect(vm.snapshot().project.monitors.find((monitor) => monitor.opcode === 'data_listcontents')?.value).toEqual(['c'])
    vm.upsertBlockMonitor('Sprite1', 'motion_xposition', {}, true)
    vm.upsertBlockMonitor('Sprite1', 'sensing_current', { CURRENTMENU: 'YEAR' }, true)
    vm.updateTarget('Sprite1', { x: 42 })
    const motionMonitor = vm.snapshot().project.monitors.find((monitor) => monitor.opcode === 'motion_xposition')
    const currentYearMonitor = vm.snapshot().project.monitors.find((monitor) => monitor.opcode === 'sensing_current')
    expect(motionMonitor?.id).toContain('motion_xposition')
    expect(motionMonitor?.spriteName).toBe('Sprite1')
    expect(motionMonitor?.value).toBe(42)
    expect(currentYearMonitor?.id).toBe('sensing_current_year')
    expect(currentYearMonitor?.spriteName).toBeUndefined()
    expect(typeof currentYearMonitor?.value).toBe('number')
  })

  it('exports and imports SB3 archives with referenced assets', async () => {
    const vm = new ScratchVM()
    const asset = await vm.storeAsset(new TextEncoder().encode('<svg id="asset"></svg>'), 'svg')
    vm.addCostume('Sprite1', {
      name: 'stored',
      dataFormat: 'svg',
      assetId: asset.assetId,
      md5ext: asset.md5ext,
    })

    const archive = await vm.saveProjectSb3()
    const files = unzipSync(archive)
    expect(files['project.json']).toBeDefined()
    expect(files[asset.md5ext]).toBeDefined()
    expect(strFromU8(files['default-backdrop.svg']!)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>')

    const imported = new ScratchVM()
    imported.loadProject(archive)
    expect(imported.getTarget('Sprite1')?.costumes.some((costume) => costume.name === 'stored')).toBe(true)
    expect(strFromU8((await imported.loadAsset(asset.assetId, 'svg'))!)).toContain('asset')
  })

  it('imports nested project.json archives and cleans Scratch 2 control characters', () => {
    const archive = zipSync({
      'folder/project.json': strToU8(`${JSON.stringify(createDefaultProject()).slice(0, 12)}\b${JSON.stringify(createDefaultProject()).slice(12)}`),
      'folder/asset.svg': strToU8('<svg onload="bad()"><script>bad()</script><rect /></svg>'),
    })
    const vm = new ScratchVM()
    vm.loadProject(archive)
    expect(vm.getTarget('Sprite1')?.name).toBe('Sprite1')
    expect(strFromU8((unzipSync(archive)['folder/project.json'])!)).toContain('\b')
  })

  it('exports and imports Sprite3 archives', async () => {
    const vm = new ScratchVM()
    vm.renameSprite('Sprite1', 'Cat')
    const asset = await vm.storeAsset(strToU8('<svg><circle /></svg>'), 'svg')
    vm.addCostume('Cat', { name: 'round', assetId: asset.assetId, md5ext: asset.md5ext, dataFormat: 'svg' })

    const archive = await vm.saveSpriteSb3('Cat')
    const files = unzipSync(archive)
    expect(files['sprite.json']).toBeDefined()
    expect(files[asset.md5ext]).toBeDefined()

    const imported = new ScratchVM()
    const sprite = imported.importSprite(archive)
    expect(sprite?.name).toBe('Cat')
    expect(imported.getSprites().some((target) => target.name === 'Cat')).toBe(true)
    expect(strFromU8((await imported.loadAsset(asset.md5ext, 'svg'))!)).toContain('circle')
  })

  it('imports the first sprite target from project archives dropped into sprite import', () => {
    const project = createDefaultProject()
    project.targets[1]!.name = 'ArchiveSprite'
    const archive = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
    const vm = new ScratchVM()
    const sprite = vm.importSprite(archive)
    expect(sprite?.name).toBe('ArchiveSprite')
    expect(vm.getSprites().some((target) => target.name === 'ArchiveSprite')).toBe(true)
  })

  it('supports Scratch VM facade aliases for project, sprite, provider, and peripherals', async () => {
    const vm = new ScratchVM()
    const loadedFromJson = await vm.fromJSON(JSON.stringify(createDefaultProject()))
    expect(loadedFromJson.targets.some((target) => target.name === 'Sprite1')).toBe(true)
    const compatibilityEvents: string[] = []
    vm.on('TARGETS_UPDATE', () => compatibilityEvents.push('targets'))
    vm.on('WORKSPACE_UPDATE', () => compatibilityEvents.push('workspace'))
    vm.setCompatibilityMode(true)
    vm.setCompatibilityMode(true)
    expect(vm.runtime.compatibilityMode).toBe(true)
    expect(compatibilityEvents).toEqual(['targets', 'workspace'])
    vm.setLocale('ja', { hello: 'こんにちは' })
    expect(vm.getLocale()).toBe('ja')
    await vm.deserializeProject(createDefaultProject())
    await vm.installTargets([vm.getStage(), vm.getTarget('Sprite1')!], ['pen'], true)
    expect(vm.exportProject().extensions).toContain('pen')
    vm.extensionManager.loadExtensionIdSync('music')
    await vm.extensionManager.loadExtensionURL('https://extensions.example/scratch3_translate.js')
    expect(vm.extensionManager.isExtensionLoaded('music')).toBe(true)
    expect(vm.extensionManager.isExtensionLoaded('translate')).toBe(true)

    const archive = await vm.exportSprite('Sprite1')
    expect(unzipSync(archive)['sprite.json']).toBeDefined()
    await vm.updateCostume(0, { name: 'selected costume', dataFormat: 'svg' }, strToU8('<svg id="selected"></svg>'))
    expect(vm.getTarget('Sprite1')?.costumes[0]?.name).toBe('selected costume')
    expect(String(vm.getCostume(0))).toContain('selected')
    const svgBuffer = strToU8('<svg id="buffer"></svg>').buffer as ArrayBuffer
    await vm.updateCostume(0, { dataFormat: 'svg' }, svgBuffer)
    expect(String(vm.getCostume(0))).toContain('buffer')

    const cloudCalls: string[] = []
    vm.setVideoProvider({ enabled: true })
    vm.setCloudProvider({
      createVariable(name: string, value: unknown) {
        cloudCalls.push(`create:${name}:${value}`)
      },
      updateVariable(name: string, value: unknown) {
        cloudCalls.push(`update:${name}:${value}`)
      },
      renameVariable(oldName: string, newName: string) {
        cloudCalls.push(`rename:${oldName}:${newName}`)
      },
      deleteVariable(name: string) {
        cloudCalls.push(`delete:${name}`)
      },
    })
    const cloudId = vm.createVariable('Stage', 'cloud score', 1, true)
    expect(vm.hasCloudData()).toBe(true)
    vm.setVariableValue('Stage', cloudId, 2)
    vm.postIOData('cloud', { varUpdate: { name: 'cloud score', value: 7 } })
    expect(vm.getVariableValue('Stage', cloudId)).toBe(7)
    vm.renameVariable('Stage', cloudId, 'cloud total')
    vm.deleteVariable('Stage', cloudId)
    expect(vm.hasCloudData()).toBe(false)
    expect(cloudCalls).toEqual(['create:cloud score:1', 'update:cloud score:2', 'rename:cloud score:cloud total', 'delete:cloud total'])
    let peripheralListExtension = ''
    vm.on('PERIPHERAL_LIST_UPDATE', (info) => {
      peripheralListExtension = (info as { extensionId: string }).extensionId
    })
    vm.scanForPeripheral('microbit')
    expect(peripheralListExtension).toBe('microbit')
    vm.connectPeripheral('microbit', 'device-1')
    expect(vm.getPeripheralIsConnected('microbit')).toBe(true)
    vm.disconnectPeripheral('microbit')
    expect(vm.getPeripheralIsConnected('microbit')).toBe(false)
    const peripheralCalls: string[] = []
    vm.registerPeripheralExtension('boost', {
      scan: () => peripheralCalls.push('scan'),
      connect: (id: string) => peripheralCalls.push(`connect:${id}`),
      disconnect: () => peripheralCalls.push('disconnect'),
    })
    vm.runtime.scanForPeripheral('boost')
    vm.runtime.connectPeripheral('boost', 'hub')
    expect(vm.runtime.getPeripheralIsConnected('boost')).toBe(true)
    vm.runtime.disconnectPeripheral('boost')
    expect(vm.runtime.getPeripheralIsConnected('boost')).toBe(false)
    expect(peripheralCalls).toEqual(['scan', 'connect:hub', 'disconnect'])
    const socket = vm.runtime.getScratchLinkSocket('BLE') as { type: string }
    expect(socket.type).toBe('BLE')

    vm.startDrag('Sprite1')
    vm.postSpriteInfo({ x: 33, y: -44, direction: 0, size: 120, volume: 0 })
    vm.stopDrag('Sprite1')
    expect(vm.getTarget('Sprite1')?.x).toBe(33)
    expect(vm.getTarget('Sprite1')?.y).toBe(-44)
    expect(vm.getTarget('Sprite1')?.direction).toBe(0)
    expect(vm.getTarget('Sprite1')?.size).toBe(120)
    expect(vm.getTarget('Sprite1')?.volume).toBe(0)
    vm.postSpriteInfo({ name: 'Sprite1', size: 0 })
    expect(vm.getTarget('Sprite1')?.size).toBe(5)

    vm.deleteSprite('Sprite1')
    expect(vm.getTarget('Sprite1')).toBeUndefined()
  })

  it('notifies cloud providers when cloud variables change from blocks', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.variables.cloud = ['cloud', 0, true]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setCloud', topLevel: true },
      setCloud: { opcode: 'data_setvariableto', parent: 'flag', next: 'changeCloud', fields: { VARIABLE: ['cloud', 'cloud'] }, inputs: { VALUE: [1, [4, '4']] } },
      changeCloud: { opcode: 'data_changevariableby', parent: 'setCloud', fields: { VARIABLE: ['cloud', 'cloud'] }, inputs: { VALUE: [1, [4, '3']] } },
    }
    const calls: string[] = []
    const vm = new ScratchVM()
    vm.setCloudProvider({
      updateVariable(name: string, value: unknown) {
        calls.push(`${name}:${value}`)
      },
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(calls).toEqual(['cloud:4', 'cloud:7'])
    expect(vm.getVariableValue('Stage', 'cloud')).toBe(7)
  })

  it('preserves Scratch project origin metadata and stage constants', async () => {
    const project = createDefaultProject()
    project.meta.origin = 'CSFirst'
    const vm = new ScratchVM()
    await vm.loadProject(project)

    expect(ScratchVM.STAGE_WIDTH).toBe(480)
    expect(ScratchVM.STAGE_HEIGHT).toBe(360)
    expect(vm.runtime.STAGE_WIDTH).toBe(480)
    expect(vm.runtime.STAGE_HEIGHT).toBe(360)
    expect(vm.runtime.origin).toBe('CSFirst')
    expect(vm.snapshot().origin).toBe('CSFirst')
    expect(vm.exportProject().meta.origin).toBe('CSFirst')
    expect(JSON.parse(vm.toJSON()).meta.origin).toBe('CSFirst')
  })

  it('emits Scratch run-start aliases and preserves once listener arguments', () => {
    const vm = new ScratchVM()
    const events: string[] = []
    let dragArgs: unknown[] = []
    vm.on('PROJECT_START', () => events.push('PROJECT_START'))
    vm.on('PROJECT_RUN_START', () => events.push('PROJECT_RUN_START'))
    vm.once('BLOCK_DRAG_END', (...args) => {
      dragArgs = args
    })

    vm.greenFlag()
    vm.emitBlockEndDrag([{ opcode: 'motion_movesteps' }], 'a')
    vm.emitBlockEndDrag([{ opcode: 'motion_turnright' }], 'b')

    expect(events).toEqual(['PROJECT_START', 'PROJECT_RUN_START'])
    expect(dragArgs).toEqual([[{ opcode: 'motion_movesteps' }], 'a'])
  })

  it('supports Scratch VM facade aliases for current-target costumes and sounds', async () => {
    const vm = new ScratchVM()
    vm.selectTarget('Sprite1')
    vm.addCostume('hash.svg', { name: 'library costume' })
    expect(vm.getTarget('Sprite1')?.currentCostume).toBe(1)
    const costume = vm.getCostume(1)
    expect(typeof costume === 'string' ? costume : costume?.md5ext).toBe('hash.svg')
    await vm.updateSvg(1, '<svg id="updated"></svg>', 12, 13)
    expect(vm.getTarget('Sprite1')?.costumes[1]?.rotationCenterX).toBe(12)
    vm.duplicateCostume(1)
    vm.renameCostume(2, 'copy name')
    expect(vm.getTarget('Sprite1')?.costumes[2]?.name).toBe('copy name')

    vm.addSound({ name: 'beep', dataFormat: 'wav' })
    vm.duplicateSound(0)
    vm.renameSound(1, 'beep copy')
    await vm.updateSoundBuffer(1, new Uint8Array([1, 2, 3, 4]), { dataFormat: 'wav', sampleCount: 2 })
    expect(vm.getTarget('Sprite1')?.sounds[1]?.name).toBe('beep copy')
    expect(await vm.getSoundBuffer(1)).toEqual(new Uint8Array([1, 2, 3, 4]))
    await vm.updateSoundBuffer(1, new Uint8Array([0, 1]).buffer, { dataFormat: 'wav', sampleCount: 1 })
    expect(await vm.getSoundBuffer(1)).toEqual(new Uint8Array([0, 1]))
    vm.deleteSound(1)
    expect(vm.getTarget('Sprite1')?.sounds).toHaveLength(1)
  })

  it('keeps duplicated costume and sound names unique', async () => {
    const vm = new ScratchVM()
    await vm.addCostume('Sprite1', { name: 'paint' })
    await vm.duplicateCostume('Sprite1', 1)
    await vm.duplicateCostume('Sprite1', 1)
    expect(vm.getTarget('Sprite1')?.costumes.map((costume) => costume.name)).toEqual(['costume1', 'paint', 'paint copy2', 'paint copy'])

    await vm.addSound('Sprite1', { name: 'pop', dataFormat: 'wav' })
    await vm.duplicateSound('Sprite1', 0)
    await vm.duplicateSound('Sprite1', 0)
    expect(vm.getTarget('Sprite1')?.sounds.map((sound) => sound.name)).toEqual(['pop', 'pop copy2', 'pop copy'])
  })

  it('supports Scratch GUI current-target asset argument forms', async () => {
    const vm = new ScratchVM()
    const sprite = vm.addSprite('Second')
    await expect(vm.addSound({ name: 'targeted', dataFormat: 'wav' }, sprite.id)).resolves.toBe(0)
    expect(vm.getTarget('Second')?.sounds[0]?.name).toBe('targeted')

    vm.selectTarget('Sprite1')
    const asset = await vm.storeAsset(strToU8('<svg id="costume-data"></svg>'), 'svg')
    await vm.addCostume(asset.md5ext, { name: 'stored svg', assetId: asset.assetId, md5ext: asset.md5ext, dataFormat: 'svg' })
    expect(vm.getCostume(1)).toContain('costume-data')
  })

  it('supports Scratch VM sharing, monitor request, and project download facades', async () => {
    const vm = new ScratchVM()
    vm.addSprite('Sprite2')
    vm.selectTarget('Sprite1')
    vm.addCostume('shared.svg', { name: 'shared' })
    vm.addSound({ name: 'pop', dataFormat: 'wav' })
    expect(await vm.shareCostumeToTarget(1, 'Sprite2')).toBe(true)
    expect(await vm.shareSoundToTarget(0, 'Sprite2')).toBe(true)
    vm.selectTarget('Sprite2')
    expect(await vm.shareCostumeToTarget(1, 'Sprite2', 'Sprite1')).toBe(true)
    expect(await vm.shareSoundToTarget(0, 'Sprite2', 'Sprite1')).toBe(true)
    expect(await vm.shareCostumeToTarget(999, 'Sprite2')).toBe(false)
    expect(await vm.shareSoundToTarget(999, 'Sprite2')).toBe(false)
    vm.shareBlocksToTarget({ flag: { opcode: 'event_whenflagclicked', topLevel: true } }, 'Sprite2', 'Sprite1')
    expect(vm.getTarget('Sprite2')?.costumes.some((costume) => costume.name === 'shared')).toBe(true)
    expect(vm.getTarget('Sprite2')?.sounds.some((sound) => sound.name === 'pop')).toBe(true)
    expect(Object.values(vm.getTarget('Sprite2')?.blocks ?? {}).some((block) => block.opcode === 'event_whenflagclicked')).toBe(true)

    const monitor = { id: 'm1', mode: 'default', opcode: 'data_variable', params: {}, visible: false }
    vm.requestAddMonitor(monitor)
    vm.requestShowMonitor('m1')
    expect(vm.getMonitors()[0]?.visible).toBe(true)
    vm.requestUpdateMonitor(new Map<string, unknown>([['id', 'm1'], ['mode', 'large']]))
    expect(vm.getMonitors()[0]?.mode).toBe('large')
    vm.setMonitorSliderRange('m1', -10, 10, true)
    expect(vm.getMonitors()[0]?.sliderMin).toBe(-10)
    vm.setMonitorPosition('m1', 20, 30)
    expect(vm.getMonitors()[0]?.x).toBe(20)
    vm.requestHideMonitor('m1')
    expect(vm.getMonitors()[0]?.visible).toBe(false)
    vm.requestRemoveMonitor('m1')
    expect(vm.getMonitors()).toHaveLength(0)
    vm.monitorBlockListener({ type: 'create', monitor: { id: 'listener-monitor', opcode: 'data_variable', params: { VARIABLE: 'score' }, value: 3, visible: true } })
    expect(vm.getMonitors()[0]?.id).toBe('listener-monitor')
    vm.monitorBlockListener({ type: 'change', id: 'listener-monitor', mode: 'large', value: 4 })
    expect(vm.getMonitors()[0]?.mode).toBe('large')
    expect(vm.getMonitors()[0]?.value).toBe(4)
    vm.monitorBlockListener({ type: 'hide', id: 'listener-monitor' })
    expect(vm.getMonitors()[0]?.visible).toBe(false)
    vm.monitorBlockListener({ type: 'delete', id: 'listener-monitor' })
    expect(vm.getMonitors()).toHaveLength(0)

    const loader = new ScratchVM()
    loader.attachStorage({
      loadAsset: async () => strToU8(JSON.stringify(createDefaultProject())),
    })
    await loader.downloadProjectId(100)
    expect(loader.getTarget('Sprite1')?.name).toBe('Sprite1')
  })

  it('supports Scratch VM block/comment listeners and glow/report events', () => {
    const vm = new ScratchVM()
    const events: string[] = []
    vm.on('BLOCK_GLOW_ON', () => events.push('block-on'))
    vm.on('SCRIPT_GLOW_OFF', () => events.push('script-off'))
    vm.on('VISUAL_REPORT', (payload) => events.push(`report:${(payload as { value: string }).value}`))
    vm.blockListener({ type: 'create', blockId: 'b1', block: { opcode: 'looks_say', fields: { MESSAGE: ['hello'] } } })
    vm.blockListener({ type: 'change', blockId: 'b1', element: 'field', name: 'MESSAGE', newValue: 'world' })
    expect(vm.getTarget('Sprite1')?.blocks.b1?.fields?.MESSAGE?.[0]).toBe('world')
    vm.blockListener({ type: 'comment_create', commentId: 'c1', text: 'note' })
    vm.updateComment('Sprite1', 'c1', { text: 'changed' })
    expect((vm.getTarget('Sprite1')?.comments.c1 as { text: string }).text).toBe('changed')
    vm.variableListener({ type: 'var_create', varId: 'v1', varName: 'score', value: 1 })
    vm.addBlock('Sprite1', { opcode: 'data_variable', fields: { VARIABLE: ['score', 'v1'] } }, 'scoreReporter')
    vm.variableListener({ type: 'var_rename', varId: 'v1', newName: 'points' })
    expect(vm.getTarget('Sprite1')?.variables.v1?.[0]).toBe('points')
    expect(vm.getTarget('Sprite1')?.blocks.scoreReporter?.fields?.VARIABLE).toEqual(['points', 'v1'])
    vm.variableListener({ type: 'var_delete', varId: 'v1' })
    expect(vm.getTarget('Sprite1')?.blocks.scoreReporter).toBeUndefined()
    vm.listListener({ type: 'list_create', listId: 'l1', listName: 'items', value: ['a'] })
    vm.addBlock('Sprite1', { opcode: 'data_itemoflist', fields: { LIST: ['items', 'l1'] } }, 'itemReporter')
    vm.listListener({ type: 'list_rename', listId: 'l1', newName: 'things' })
    expect(vm.getTarget('Sprite1')?.lists.l1?.[0]).toBe('things')
    expect(vm.getTarget('Sprite1')?.blocks.itemReporter?.fields?.LIST).toEqual(['things', 'l1'])
    vm.listListener({ type: 'list_delete', listId: 'l1' })
    expect(vm.getTarget('Sprite1')?.blocks.itemReporter).toBeUndefined()

    const stageVariableId = vm.createVariable('Stage', 'stage score', 3)
    vm.addBlock('Stage', { opcode: 'data_variable', fields: { VARIABLE: ['stage score', stageVariableId] } }, 'stageScoreReporter')
    vm.variableListener({ type: 'var_rename', varId: stageVariableId, newName: 'stage points' })
    expect(vm.getVariableValue('Stage', 'stage points')).toBe(3)
    expect(vm.getStage().blocks.stageScoreReporter?.fields?.VARIABLE).toEqual(['stage points', stageVariableId])
    vm.variableListener({ type: 'var_delete', varId: stageVariableId })
    expect(vm.getStage().blocks.stageScoreReporter).toBeUndefined()

    const stageListId = vm.createList('Stage', 'stage list', ['x'])
    vm.addBlock('Stage', { opcode: 'data_listcontents', fields: { LIST: ['stage list', stageListId] } }, 'stageListReporter')
    vm.listListener({ type: 'list_rename', listId: stageListId, newName: 'stage things' })
    expect(vm.getListValue('Stage', 'stage things')).toEqual(['x'])
    expect(vm.getStage().blocks.stageListReporter?.fields?.LIST).toEqual(['stage things', stageListId])
    vm.listListener({ type: 'list_delete', listId: stageListId })
    expect(vm.getStage().blocks.stageListReporter).toBeUndefined()

    vm.glowBlock('b1', true)
    vm.quietGlow('b1')
    vm.visualReport('b1', 42)
    expect(events).toEqual(['block-on', 'script-off', 'report:42'])
    let dragEnd: [ScratchBlock[], string] | undefined
    vm.on('BLOCK_DRAG_END', (blocks, topBlockId) => {
      dragEnd = [blocks as ScratchBlock[], topBlockId as string]
    })
    vm.emitBlockEndDrag([{ opcode: 'motion_movesteps' }], 'top-block')
    expect(dragEnd?.[0][0]?.opcode).toBe('motion_movesteps')
    expect(dragEnd?.[1]).toBe('top-block')
    vm.blockListener({ type: 'delete', blockId: 'b1' })
    expect(vm.getTarget('Sprite1')?.blocks.b1).toBeUndefined()
    vm.deleteComment('Sprite1', 'c1')
    expect(vm.getTarget('Sprite1')?.comments.c1).toBeUndefined()
  })

  it('reports clicked value block results without starting a script', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.score = ['score', 8]
    sprite.blocks = {
      scoreReporter: { opcode: 'data_variable', fields: { VARIABLE: ['score', 'score'] } },
      sumReporter: {
        opcode: 'operator_add',
        inputs: {
          NUM1: [2, 'scoreReporter'],
          NUM2: [1, [4, '4']],
        },
      },
    }
    vm.loadProject(project)

    const events: string[] = []
    vm.on('VISUAL_REPORT', (payload) => events.push(`${(payload as { id: string }).id}:${(payload as { value: string }).value}`))

    expect(vm.reportBlockValue('sumReporter', 'Sprite1')).toBe(12)
    expect(vm.snapshot().threads).toHaveLength(0)
    expect(events).toEqual(['sumReporter:12'])
  })

  it('deletes block descendants and detaches remaining references', () => {
    const vm = new ScratchVM()
    vm.addBlock('Sprite1', { opcode: 'event_whenflagclicked', next: 'say', topLevel: true }, 'flag')
    vm.addBlock('Sprite1', { opcode: 'looks_say', parent: 'flag', inputs: { MESSAGE: [2, 'join'] } }, 'say')
    vm.addBlock('Sprite1', { opcode: 'operator_join', parent: 'say', inputs: { STRING1: [1, [10, 'a']], STRING2: [1, [10, 'b']] } }, 'join')
    vm.addBlock('Sprite1', { opcode: 'looks_think', inputs: { MESSAGE: [2, 'say'] }, topLevel: true }, 'other')
    vm.deleteBlock('Sprite1', 'say')
    const blocks = vm.getTarget('Sprite1')?.blocks ?? {}
    expect(blocks.say).toBeUndefined()
    expect(blocks.join).toBeUndefined()
    expect(blocks.flag?.next).toBeNull()
    expect(blocks.other?.inputs?.MESSAGE?.[1]).toBeNull()
  })

  it('clears active script and block glows on stop all', () => {
    const vm = new ScratchVM()
    const events: string[] = []
    vm.on('BLOCK_GLOW_OFF', (payload) => events.push(`block:${(payload as { blockId: string }).blockId}`))
    vm.on('SCRIPT_GLOW_OFF', (payload) => events.push(`script:${(payload as { blockId: string }).blockId}`))
    vm.glowBlock('block1', true)
    vm.glowScript('script1', true)
    vm.stopAll()
    expect(events).toEqual(['block:block1', 'script:script1'])
  })

  it('resets transient run state and notifies clone removal on green flag', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'say', topLevel: true },
      say: { opcode: 'looks_say', parent: 'flag', inputs: { MESSAGE: [1, [10, 'fresh']] } },
      clone: { opcode: 'control_start_as_clone', topLevel: true },
    }
    const vm = new ScratchVM()
    const events: string[] = []
    vm.on('BLOCK_GLOW_OFF', (payload) => events.push(`block:${(payload as { blockId: string }).blockId}`))
    vm.on('TARGETS_UPDATE', (snapshot) => events.push(`targets:${(snapshot as RuntimeSnapshot).project.targets.length}`))
    vm.loadProject(project)
    vm.glowBlock('old-block', true)
    vm.greenFlag()
    vm.step()
    vm.getTarget('Sprite1')!.speechBubble = { type: 'say', text: 'old' }
    const clone = structuredClone(vm.getTarget('Sprite1')!)
    clone.id = 'manual-clone'
    clone.name = 'Sprite1 clone'
    clone.isClone = true
    vm.addTarget(clone)
    vm.greenFlag()
    expect(events).toContain('block:old-block')
    expect(events).toContain('targets:2')
    expect(vm.exportProject().targets.some((target) => target.isClone)).toBe(false)
    expect(vm.getTarget('Sprite1')?.speechBubble?.text).toBeUndefined()
  })

  it('exposes Scratch runtime and extension-manager facade methods', () => {
    const vm = new ScratchVM()
    const events: string[] = []
    vm.on('MIC_LISTENING', (value) => events.push(`mic:${value}`))
    vm.on('EXTENSION_DATA_LOADING', (value) => events.push(`loading:${value}`))
    vm.on('targetWasCreated', (target) => events.push(`created:${(target as ScratchTarget).name}`))
    vm.on('targetWasRemoved', (target) => events.push(`removed:${(target as ScratchTarget).name}`))
    vm.runtime.emitMicListening(true)
    vm.runtime.emitExtensionLoading(false)
    const aliasTarget = vm.addTarget({ ...createDefaultProject().targets[1]!, name: 'AliasSprite' })
    if (aliasTarget) vm.disposeTarget(aliasTarget)
    expect(events).toEqual(['mic:true', 'loading:false', 'created:AliasSprite', 'removed:AliasSprite'])
    expect(vm.runtime.targets).toHaveLength(2)
    expect(vm.runtime.executableTargets[0]?.name).toBe('Sprite1')
    expect(vm.runtime.getMonitorState()).toBeInstanceOf(Map)
    expect(vm.runtime.getBlocksXML()).toContain('<category')
    expect(Array.isArray(vm.runtime.getBlocksJSON())).toBe(true)
    expect(vm.runtime.getIsHat('event_whenflagclicked')).toBe(true)
    expect(vm.runtime.getIsEdgeActivatedHat('event_whentouchingobject')).toBe(true)
    expect(typeof vm.runtime.getOpcodeFunction('motion_movesteps')).toBe('function')
    expect(vm.runtime.getTargetById('sprite1')?.name).toBe('Sprite1')
    expect(vm.runtime.getSpriteTargetByName('Sprite1')?.id).toBe('sprite1')
    expect(vm.runtime.getTargetForStage()?.isStage).toBe(true)
    expect(vm.runtime.getEditingTarget()?.name).toBe('Sprite1')
    const globalId = vm.runtime.createNewGlobalVariable('global score')
    expect(vm.runtime.getAllVarNamesOfType('scalar')).toContain('global score')
    vm.runtime.requestRemoveMonitorByTargetId('missing')
    expect(vm.runtime.resetRunId()).toStartWith('run')
    expect(vm.runtime.getLabelForOpcode('motion_movesteps')).toBe('movesteps')
    vm.enableProfiling()
    expect(vm.updateCurrentMSecs()).toBeGreaterThan(0)
    vm.disableProfiling()

    const sprite = vm.runtime.addTarget({ isStage: false, name: 'RuntimeSprite', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, costumes: [], sounds: [] })
    expect(sprite?.name).toBe('RuntimeSprite')
    expect(vm.runtime.getTargetByDrawableId(sprite!.id!)?.name).toBe('RuntimeSprite')
    vm.runtime.setExecutablePosition(sprite!, 1)
    expect(vm.runtime.executableTargets.some((target) => target.name === 'RuntimeSprite')).toBe(true)
    vm.runtime.removeExecutable(sprite!)
    expect(vm.runtime.getSpriteTargetByName('RuntimeSprite')).toBeUndefined()

    expect(vm.extensionManager.registerExtensionServiceSync?.('svc')).toBe('svc')
    expect(vm.extensionManager._sanitizeID?.('bad-id!')).toBe('badid')
    const extensionId = vm.extensionManager._registerInternalExtension?.({ getInfo: () => ({ id: 'clean', blocks: [] }) })
    expect(extensionId).toBe('clean')
    expect(vm.extensionManager.isExtensionLoaded('clean')).toBe(true)
    expect(vm.assets.some((asset) => asset.name === 'costume1')).toBe(true)
  })

  it('converts Scratch 2 project and sprite objects into the Level 1 model', () => {
    const sb2Project = {
      objName: 'Stage',
      variables: [{ name: 'global', value: 3 }],
      children: [{
        objName: 'OldSprite',
        scratchX: 12,
        scratchY: -8,
        scripts: [[5, 6, [['whenGreenFlag'], ['forward:', 10], ['setVar:to:', 'score', 7]]]],
        variables: [{ name: 'score', value: 0 }],
        costumes: [{ costumeName: 'old', baseLayerMD5: 'abc.png', bitmapResolution: 2 }],
        sounds: [{ soundName: 'meow', md5: 'sound.wav', sampleCount: 4, rate: 22050 }],
      }],
    }
    const vm = new ScratchVM()
    vm.loadProject(sb2Project)
    const sprite = vm.getTarget('OldSprite')!
    expect(sprite.x).toBe(12)
    expect(sprite.blocks.sb2_0_0?.opcode).toBe('event_whenflagclicked')
    expect(sprite.blocks.sb2_0_1?.opcode).toBe('motion_movesteps')
    expect(sprite.variables.score?.[0]).toBe('score')
    expect(sprite.costumes[0]?.md5ext).toBe('abc.png')

    const normalizedSprite = normalizeProject({ objName: 'LooseSprite', scripts: [[0, 0, [['whenGreenFlag']]]] })
    expect(normalizedSprite.targets.some((target) => target.name === 'LooseSprite')).toBe(true)
  })

  it('validates project and sprite inputs before import', async () => {
    const project = createDefaultProject()
    expect(validateProject(project).format).toBe('sb3')
    expect(validateProject(project).valid).toBe(true)
    expect(validateProject(project, true).valid).toBe(false)

    const vm = new ScratchVM()
    const spriteArchive = await vm.saveSpriteSb3('Sprite1')
    const result = validateProject(spriteArchive, true)
    expect(result.valid).toBe(true)
    expect(result.format).toBe('sprite3')
    expect(validateProject('{bad json').valid).toBe(false)
  })

  it('hydrates SB3 menu shadow inputs into editable menu fields', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setTouching', topLevel: true },
      setTouching: { opcode: 'data_setvariableto', parent: 'flag', inputs: { VALUE: [2, 'touchingReporter'] }, fields: { VARIABLE: ['hit', 'hit'] } },
      touchingReporter: { opcode: 'sensing_touchingobject', parent: 'setTouching', inputs: { TOUCHINGOBJECTMENU: [1, 'touchingMenu'] } },
      touchingMenu: { opcode: 'sensing_touchingobjectmenu', parent: 'touchingReporter', shadow: true, fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
      touchingHat: { opcode: 'event_whentouchingobject', topLevel: true, inputs: { TOUCHINGOBJECTMENU: [1, 'hatMenu'] } },
      hatMenu: { opcode: 'sensing_touchingobjectmenu', parent: 'touchingHat', shadow: true, fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    const blocks = vm.getTarget('Sprite1')!.blocks
    expect(blocks.touchingReporter?.fields?.TOUCHINGOBJECTMENU).toEqual(['Sprite2', 'Sprite2'])
    expect(blocks.touchingHat?.fields?.TOUCHINGOBJECTMENU).toEqual(['Sprite2', 'Sprite2'])
  })

  it('exposes parser-compatible unpack, parse, and validate facades', async () => {
    const project = createDefaultProject()
    const archive = zipSync({
      'nested/project.json': strToU8(JSON.stringify(project)),
      'nested/costume.svg': strToU8('<svg><rect /></svg>'),
    })
    const unpacked = unpackScratchInput(archive)
    expect(unpacked.json).toContain('"targets"')
    expect(unpacked.archive?.['nested/costume.svg']).toBeDefined()

    const parsed = parseScratchProject(archive)
    expect(parsed.projectVersion).toBe(3)
    expect(parsed.format).toBe('sb3')
    expect((parsed.project as { projectVersion: number }).projectVersion).toBe(3)

    const callbackValues: string[] = []
    parse(JSON.stringify(project), (error, output) => {
      expect(error).toBeNull()
      callbackValues.push((output?.[0] as { projectVersion: number }).projectVersion.toString())
    })
    validate(false, project, (error, output) => {
      expect(error).toBeNull()
      callbackValues.push((output as { projectVersion: number }).projectVersion.toString())
    })
    expect(callbackValues).toEqual(['3', '3'])
    expect(() => unpackScratchInput(new Uint8Array([83, 99, 114, 1]))).toThrow('Parser only supports Scratch 2.X and above')
  })

  it('exposes Scratch GUI file uploader helpers', () => {
    const storage = new ScratchStorage()
    expect(extractFileName('sprite.one.png')).toBe('sprite')
    expect(getProjectTitleFromFilename('game.sb3')).toBe('game')
    expect(getProjectTitleFromFilename(`${'x'.repeat(120)}.sb2`)).toHaveLength(100)
    expect(getProjectTitleFromFilename('image.png')).toBe('')

    const vmAsset = createVMAsset(storage, AssetType.ImageVector, DataFormat.SVG, strToU8('<svg></svg>'))
    expect(vmAsset.md5).toEndWith('.svg')
    expect(vmAsset.name).toBeNull()

    let costumes: Array<{ dataFormat: string; name: string | null; asset: Asset }> = []
    costumeUpload(strToU8('<svg onload="x()"><script>x()</script></svg>'), 'image/svg+xml', storage, uploaded => {
      costumes = uploaded
    })
    expect(costumes).toHaveLength(1)
    expect(costumes[0]?.dataFormat).toBe('svg')
    expect(costumes[0]?.asset.decodeText()).not.toContain('script')

    let soundFormat = ''
    soundUpload(new Uint8Array([1, 2, 3]), 'audio/x-wav', storage, sound => {
      soundFormat = sound.dataFormat
    })
    expect(soundFormat).toBe('wav')

    let spritePayload = ''
    spriteUpload(strToU8('<svg></svg>'), 'image/svg+xml', 'Painted', storage, sprite => {
      spritePayload = typeof sprite === 'string' ? sprite : ''
    })
    const sprite = JSON.parse(spritePayload) as { name: string; costumes: Array<{ name: string }> }
    expect(sprite.name).toBe('Painted')
    expect(sprite.costumes[0]?.name).toBe('Painted')
  })

  it('updates costume bytes and sound buffers through VM APIs', async () => {
    const vm = new ScratchVM()
    await vm.updateCostume('Sprite1', 0, { name: 'painted', dataFormat: 'svg' }, new TextEncoder().encode('<svg id="painted"></svg>'))
    expect(vm.getTarget('Sprite1')?.costumes[0]?.name).toBe('painted')
    expect(vm.getTarget('Sprite1')?.costumes[0]?.md5ext).toEndWith('.svg')

    vm.addSound('Sprite1', { name: 'tone', dataFormat: 'wav' })
    await vm.updateSoundBuffer('Sprite1', 0, new Uint8Array([1, 2, 3]), { sampleCount: 3 })
    expect(await vm.getSoundBuffer('Sprite1', 0)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sanitizes stored SVG assets', async () => {
    const vm = new ScratchVM()
    await vm.updateCostume('Sprite1', 0, { name: 'safe', dataFormat: 'svg' }, new TextEncoder().encode('<svg onload="alert(1)"><script>alert(2)</script><circle /></svg>'))
    const costume = vm.getTarget('Sprite1')?.costumes[0]
    const bytes = await vm.loadAsset(costume?.md5ext ?? '', 'svg')
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('script')
    expect(text).not.toContain('onload')
    expect(text).toContain('<svg')
  })

  it('emits an error and installs placeholders for missing referenced assets on load', async () => {
    const project = createDefaultProject()
    project.targets[1]!.costumes[0] = {
      name: 'missing',
      assetId: 'missing-asset',
      md5ext: 'missing-asset.svg',
      dataFormat: 'svg',
      rotationCenterX: 48,
      rotationCenterY: 48,
    }
    const vm = new ScratchVM()
    const errors: string[] = []
    vm.on('ERROR', payload => errors.push(String((payload as { message?: string }).message ?? '')))
    await vm.loadProject(project)
    expect(errors.some(message => message.includes('missing-asset.svg'))).toBe(true)
    expect(strFromU8((await vm.loadAsset('missing-asset.svg', 'svg'))!)).toContain('<svg')
  })

  it('exposes Scratch-compatible storage asset primitives', async () => {
    expect(DataFormat.PNG).toBe('png')
    expect(AssetType.ImageVector.contentType).toBe('image/svg+xml')
    expect(AssetType.Sprite.name).toBe('Sprite')
    expect(ScratchStorage.DataFormat.WAV).toBe('wav')

    const asset = new Asset(AssetType.ImageVector, undefined, DataFormat.SVG, strToU8('<svg></svg>'), true)
    expect(asset.assetId).toBeTruthy()
    expect(asset.decodeText()).toContain('<svg')
    expect(asset.encodeDataURI()).toStartWith('data:image/svg+xml;base64,')

    const storage = new ScratchStorage()
    expect(storage.scratchFetch.RequestMetadata.ProjectId).toBe('X-Project-ID')
    expect(typeof storage.scratchFetch.scratchFetch).toBe('function')
    expect(storage.getDefaultAssetId(AssetType.Sound)).toBe('default-sound')
    const stored = await storage.store(AssetType.ImageVector, DataFormat.SVG, strToU8('<svg id="stored"></svg>'))
    expect(storage.listAssets()).toContain(String(stored.id))
    expect((await storage.load(AssetType.ImageVector, stored.id, DataFormat.SVG))?.decodeText()).toContain('stored')
    expect(sanitizeSvg.sanitizeSvgText('<svg onclick="x()"><script>x()</script></svg>')).not.toContain('script')
    const svg = loadSvgString('<svg width="12" height="8"><rect /></svg>')
    expect(serializeSvgToString(svg)).toContain('<svg')
    const svgRenderer = new SVGRenderer()
    svgRenderer.loadSVG('<svg width="12" height="8"></svg>', false)
    expect(svgRenderer.size).toEqual([12, 8])
    expect(new BitmapAdapter().getResizedWidthHeight(100, 90)).toEqual({ width: 200, height: 180 })
    expect(ArgumentType.STRING).toBe('string')
    expect(BlockType.COMMAND).toBe('command')
    expect(TargetType.SPRITE).toBe('sprite')
    scratchFetch.clearMetadata()
    scratchFetch.setMetadata('X-Project-ID', 'p1')
    expect(scratchFetch.getMetadata('X-Project-ID')).toBe('p1')
    const options = scratchFetch.applyMetadata({ headers: { Existing: 'yes' } })
    expect(new Headers(options?.headers).get('X-Project-ID')).toBe('p1')
    expect(new Headers(options?.headers).get('Existing')).toBe('yes')
    scratchFetch.unsetMetadata('X-Project-ID')
    expect(scratchFetch.getMetadata('X-Project-ID')).toBeNull()
    await expect(new Helper(storage).load(AssetType.ImageVector, 'missing', DataFormat.SVG)).rejects.toThrow('No asset')
  })

  it('exposes Scratch-compatible utility modules for extensions', () => {
    expect(Cast.toNumber(Number.NaN)).toBe(0)
    expect(Cast.toNumber('0x10')).toBe(16)
    expect(Cast.toNumber('   ')).toBe(0)
    expect(Cast.toBoolean('false')).toBe(false)
    expect(Cast.toBoolean('FALSE')).toBe(false)
    expect(Cast.toBoolean(' 0 ')).toBe(true)
    expect(Cast.toBoolean(Number.NaN)).toBe(false)
    expect(Cast.compare('A', 'a')).toBe(0)
    expect(Cast.compare('', 0)).not.toBe(0)
    expect(Cast.compare('Infinity', Infinity)).toBe(0)
    expect(Cast.compare('9', '10')).toBeLessThan(0)
    expect(Cast.toRgbColorList('#03f')).toEqual([0, 51, 255])
    expect(Cast.toListIndex('last', 3, false)).toBe(3)
    expect(toListIndex('last', 3, false)).toBe(3)
    expect(Cast.toListIndex('Last', 3, false)).toBe(3)
    expect(Cast.toListIndex('ALL', 3, true)).toBe(Cast.LIST_ALL)
    expect(Cast.toListIndex('1.9', 3, false)).toBe(1)
    expect(Color.decimalToHex(0x0033ff)).toBe('#0033ff')
    expect(Color.hexToDecimal('#ffffff')).toBe(16777215)
    expect(Color.rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000')
    expect(Color.hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 })
    expect(MathUtil.degToRad(180)).toBe(Math.PI)
    expect(MathUtil.radToDeg(Math.PI)).toBe(180)
    expect(MathUtil.clamp(20, 0, 10)).toBe(10)
    expect(MathUtil.wrapClamp(7, 1, 5)).toBe(2)
    expect(MathUtil.tan(90)).toBe(Infinity)
    expect(MathUtil.reducedSortOrdering([5, 19, 13, 1])).toEqual([1, 3, 2, 0])
    expect(MathUtil.scale(5, 0, 10, 0, 100)).toBe(50)
    expect(uid()).toHaveLength(20)
    expect(getMonitorIdForBlockWithArgs('sensing_current', { CURRENTMENU: { value: 'YEAR' } })).toBe('sensing_current_year')
    expect(Clone.simple<{ a: number }>({ a: 1, fn: () => 2 })).toEqual({ a: 1 })
    expect(StringUtil.withoutTrailingDigits('Sprite123')).toBe('Sprite')
    expect(StringUtil.unusedName('Sprite1', ['Sprite1', 'Sprite2'])).toBe('Sprite3')
    expect(StringUtil.splitFirst('foo.tar.gz', '.')).toEqual(['foo', 'tar.gz'])
    expect(StringUtil.stringify({ value: Infinity })).toBe('{"value":0}')
    expect(StringUtil.replaceUnsafeChars("<>&'\"")).toBe('ltgtampaposquot')
    expect(defineMessages({ hello: { id: 'hello', default: 'Hello' } }).hello.default).toBe('Hello')
  })

  it('executes Level 1 operator reporters in stacks', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.score = ['score', 0]
    sprite.variables.same = ['same', false]
    sprite.variables.less = ['less', false]
    sprite.variables.mod = ['mod', 0]
    sprite.variables.sum = ['sum', 0]
    sprite.variables.rounded = ['rounded', 0]
    sprite.variables.math = ['math', 0]
    sprite.variables.letter = ['letter', '']
    sprite.variables.random = ['random', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'set', topLevel: true },
      set: {
        opcode: 'data_setvariableto',
        parent: 'flag',
        next: 'setSame',
        fields: { VARIABLE: ['score', 'score'] },
        inputs: { VALUE: [2, 'join'] },
      },
      join: {
        opcode: 'operator_join',
        parent: 'set',
        inputs: {
          STRING1: [1, [10, 'hello']],
          STRING2: [1, [10, ' world']],
        },
      },
      setSame: { opcode: 'data_setvariableto', parent: 'set', next: 'setLess', fields: { VARIABLE: ['same', 'same'] }, inputs: { VALUE: [2, 'sameReporter'] } },
      sameReporter: { opcode: 'operator_equals', parent: 'setSame', inputs: { OPERAND1: [1, [10, 'A']], OPERAND2: [1, [10, 'a']] } },
      setLess: { opcode: 'data_setvariableto', parent: 'setSame', next: 'setMod', fields: { VARIABLE: ['less', 'less'] }, inputs: { VALUE: [2, 'lessReporter'] } },
      lessReporter: { opcode: 'operator_lt', parent: 'setLess', inputs: { OPERAND1: [1, [10, '9']], OPERAND2: [1, [10, '10']] } },
      setMod: { opcode: 'data_setvariableto', parent: 'setLess', next: 'setSum', fields: { VARIABLE: ['mod', 'mod'] }, inputs: { VALUE: [2, 'modReporter'] } },
      modReporter: { opcode: 'operator_mod', parent: 'setMod', inputs: { NUM1: [1, [4, '-1']], NUM2: [1, [4, '10']] } },
      setSum: { opcode: 'data_setvariableto', parent: 'setMod', next: 'setRounded', fields: { VARIABLE: ['sum', 'sum'] }, inputs: { VALUE: [2, 'sumReporter'] } },
      sumReporter: { opcode: 'operator_add', parent: 'setSum', inputs: { NUM1: [1, [10, 'abc']], NUM2: [1, [4, '5']] } },
      setRounded: { opcode: 'data_setvariableto', parent: 'setSum', next: 'setMath', fields: { VARIABLE: ['rounded', 'rounded'] }, inputs: { VALUE: [2, 'roundReporter'] } },
      roundReporter: { opcode: 'operator_round', parent: 'setRounded', inputs: { NUM: [1, [10, 'not-a-number']] } },
      setMath: { opcode: 'data_setvariableto', parent: 'setRounded', next: 'setLetter', fields: { VARIABLE: ['math', 'math'] }, inputs: { VALUE: [2, 'mathReporter'] } },
      mathReporter: { opcode: 'operator_mathop', parent: 'setMath', fields: { OPERATOR: ['abs'] }, inputs: { NUM: [1, [10, 'not-a-number']] } },
      setLetter: { opcode: 'data_setvariableto', parent: 'setMath', next: 'setRandom', fields: { VARIABLE: ['letter', 'letter'] }, inputs: { VALUE: [2, 'letterReporter'] } },
      letterReporter: { opcode: 'operator_letter_of', parent: 'setLetter', inputs: { LETTER: [1, [10, 'not-a-number']], STRING: [1, [10, 'Scratch']] } },
      setRandom: { opcode: 'data_setvariableto', parent: 'setLetter', fields: { VARIABLE: ['random', 'random'] }, inputs: { VALUE: [2, 'randomReporter'] } },
      randomReporter: { opcode: 'operator_random', parent: 'setRandom', inputs: { FROM: [1, [10, 'not-a-number']], TO: [1, [10, 'not-a-number']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'score')).toBe('hello world')
    expect(vm.getVariableValue('Sprite1', 'same')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'less')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'mod')).toBe(9)
    expect(vm.getVariableValue('Sprite1', 'sum')).toBe(5)
    expect(vm.getVariableValue('Sprite1', 'rounded')).toBe(0)
    expect(vm.getVariableValue('Sprite1', 'math')).toBe(0)
    expect(vm.getVariableValue('Sprite1', 'letter')).toBe('')
    expect(vm.getVariableValue('Sprite1', 'random')).toBe(0)
  })

  it('matches Scratch edge cases for type casts and operator reporters', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.blankEqualsZero = ['blankEqualsZero', true]
    sprite.variables.zeroEqualsNumber = ['zeroEqualsNumber', false]
    sprite.variables.falseEqualsZero = ['falseEqualsZero', false]
    sprite.variables.contains = ['contains', false]
    sprite.variables.joinedBooleans = ['joinedBooleans', '']
    sprite.variables.letter = ['letter', '']
    sprite.variables.sameRandomEndpoint = ['sameRandomEndpoint', 0]
    sprite.variables.tangent = ['tangent', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setBlankEqualsZero', topLevel: true },
      setBlankEqualsZero: { opcode: 'data_setvariableto', parent: 'flag', next: 'setZeroEqualsNumber', fields: { VARIABLE: ['blankEqualsZero', 'blankEqualsZero'] }, inputs: { VALUE: [2, 'blankEqualsZeroReporter'] } },
      blankEqualsZeroReporter: { opcode: 'operator_equals', parent: 'setBlankEqualsZero', inputs: { OPERAND1: [1, [10, '']], OPERAND2: [1, [4, '0']] } },
      setZeroEqualsNumber: { opcode: 'data_setvariableto', parent: 'setBlankEqualsZero', next: 'setFalseEqualsZero', fields: { VARIABLE: ['zeroEqualsNumber', 'zeroEqualsNumber'] }, inputs: { VALUE: [2, 'zeroEqualsNumberReporter'] } },
      zeroEqualsNumberReporter: { opcode: 'operator_equals', parent: 'setZeroEqualsNumber', inputs: { OPERAND1: [1, [10, '0']], OPERAND2: [1, [4, '0']] } },
      setFalseEqualsZero: { opcode: 'data_setvariableto', parent: 'setZeroEqualsNumber', next: 'setContains', fields: { VARIABLE: ['falseEqualsZero', 'falseEqualsZero'] }, inputs: { VALUE: [2, 'falseEqualsZeroReporter'] } },
      falseEqualsZeroReporter: { opcode: 'operator_equals', parent: 'setFalseEqualsZero', inputs: { OPERAND1: [1, [10, false]], OPERAND2: [1, [4, '0']] } },
      setContains: { opcode: 'data_setvariableto', parent: 'setFalseEqualsZero', next: 'setJoinedBooleans', fields: { VARIABLE: ['contains', 'contains'] }, inputs: { VALUE: [2, 'containsReporter'] } },
      containsReporter: { opcode: 'operator_contains', parent: 'setContains', inputs: { STRING1: [1, [10, 'Scratch VM']], STRING2: [1, [10, 'vm']] } },
      setJoinedBooleans: { opcode: 'data_setvariableto', parent: 'setContains', next: 'setLetter', fields: { VARIABLE: ['joinedBooleans', 'joinedBooleans'] }, inputs: { VALUE: [2, 'joinedBooleansReporter'] } },
      joinedBooleansReporter: { opcode: 'operator_join', parent: 'setJoinedBooleans', inputs: { STRING1: [1, [10, true]], STRING2: [1, [10, false]] } },
      setLetter: { opcode: 'data_setvariableto', parent: 'setJoinedBooleans', next: 'setRandom', fields: { VARIABLE: ['letter', 'letter'] }, inputs: { VALUE: [2, 'letterReporter'] } },
      letterReporter: { opcode: 'operator_letter_of', parent: 'setLetter', inputs: { LETTER: [1, [10, '1.9']], STRING: [1, [10, 'Scratch']] } },
      setRandom: { opcode: 'data_setvariableto', parent: 'setLetter', next: 'setTangent', fields: { VARIABLE: ['sameRandomEndpoint', 'sameRandomEndpoint'] }, inputs: { VALUE: [2, 'randomReporter'] } },
      randomReporter: { opcode: 'operator_random', parent: 'setRandom', inputs: { FROM: [1, [10, '5.0']], TO: [1, [10, '5.0']] } },
      setTangent: { opcode: 'data_setvariableto', parent: 'setRandom', fields: { VARIABLE: ['tangent', 'tangent'] }, inputs: { VALUE: [2, 'tangentReporter'] } },
      tangentReporter: { opcode: 'operator_mathop', parent: 'setTangent', fields: { OPERATOR: ['tan'] }, inputs: { NUM: [1, [4, '90']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'blankEqualsZero')).toBe(false)
    expect(vm.getVariableValue('Sprite1', 'zeroEqualsNumber')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'falseEqualsZero')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'contains')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'joinedBooleans')).toBe('truefalse')
    expect(vm.getVariableValue('Sprite1', 'letter')).toBe('S')
    expect(vm.getVariableValue('Sprite1', 'sameRandomEndpoint')).toBe(5)
    expect(vm.getVariableValue('Sprite1', 'tangent')).toBe(Infinity)
  })

  it('tracks monitors and removes sprite monitors on target delete', () => {
    const vm = new ScratchVM()
    const variableId = vm.createVariable('Sprite1', 'score', 0)
    vm.upsertVariableMonitor('Sprite1', variableId, true)
    expect(vm.getMonitors()).toHaveLength(1)
    vm.setMonitorVisible(vm.getMonitors()[0]!.id, false)
    expect(vm.getMonitors()[0]!.visible).toBe(false)
    vm.deleteTarget('Sprite1')
    expect(vm.getMonitors()).toHaveLength(0)
  })

  it('closes pending questions when deleting the asking target', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'ask', topLevel: true },
      ask: { opcode: 'sensing_askandwait', parent: 'flag', inputs: { QUESTION: [1, [10, 'Ready?']] } },
    }
    const questions: Array<string | null> = []
    const vm = new ScratchVM()
    vm.on<{ question: string | null }>('QUESTION', (payload) => questions.push(payload.question))
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.deleteTarget('Sprite1')
    expect(questions).toEqual(['Ready?', null])
  })

  it('supports broadcast-and-wait until receiver threads complete', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'broadcastWait', topLevel: true },
      broadcastWait: { opcode: 'event_broadcastandwait', parent: 'flag', next: 'setDone', inputs: { BROADCAST_INPUT: [1, [10, 'go']] } },
      setDone: { opcode: 'data_setvariableto', parent: 'broadcastWait', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '2']] } },
      receiver: { opcode: 'event_whenbroadcastreceived', next: 'wait', topLevel: true, fields: { BROADCAST_OPTION: ['go', 'go'] } },
      wait: { opcode: 'control_wait', parent: 'receiver', next: 'setOne', inputs: { DURATION: [1, [4, '0.1']] } },
      setOne: { opcode: 'data_setvariableto', parent: 'wait', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    vm.step(300)
    vm.step(401)
    vm.step(402)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('2')
  })

  it('resolves broadcast menu shadows as message strings', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.received = ['received', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'broadcastMenu', topLevel: true },
      broadcastMenu: { opcode: 'event_broadcast', parent: 'flag', inputs: { BROADCAST_INPUT: [2, 'messageMenu'] } },
      messageMenu: { opcode: 'event_broadcast_menu', parent: 'broadcastMenu', shadow: true, fields: { BROADCAST_OPTION: ['go', 'go'] } },
      receiver: { opcode: 'event_whenbroadcastreceived', next: 'changeReceived', topLevel: true, fields: { BROADCAST_OPTION: ['go', 'go'] } },
      changeReceived: { opcode: 'data_changevariableby', parent: 'receiver', fields: { VARIABLE: ['received', 'received'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    expect(vm.getTarget('Sprite1')!.blocks.broadcastMenu?.fields?.BROADCAST_OPTION).toBeUndefined()
    expect(vm.getTarget('Sprite1')!.blocks.broadcastMenu?.inputs?.BROADCAST_INPUT).toEqual([2, 'messageMenu'])
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'received')).toBe(1)
  })

  it('normalizes legacy raw-string broadcast inputs on project load', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.received = ['received', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'broadcastRaw', topLevel: true },
      broadcastRaw: { opcode: 'event_broadcast', parent: 'flag', inputs: { BROADCAST_INPUT: [1, 'go'] } },
      receiver: { opcode: 'event_whenbroadcastreceived', next: 'setReceived', topLevel: true, fields: { BROADCAST_OPTION: ['go', 'go'] } },
      setReceived: { opcode: 'data_setvariableto', parent: 'receiver', fields: { VARIABLE: ['received', 'received'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    expect(vm.getTarget('Sprite1')!.blocks.broadcastRaw?.inputs?.BROADCAST_INPUT).toEqual([1, [10, 'go']])
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'received')).toBe('1')
  })

  it('keeps broadcast menu literals as inputs when importing Scratch archives', async () => {
    const fixturePath = join(import.meta.dir, '../../../..', 'Scratch Week Comics (FEATURED).sb3')
    const vm = new ScratchVM()
    await vm.loadProject(readFileSync(fixturePath))

    const page2 = vm.getTarget('Page2')
    const broadcastInputName = (block: ScratchBlock | undefined) => {
      const value = block?.inputs?.BROADCAST_INPUT?.[1]
      return Array.isArray(value) ? value[1] : undefined
    }
    const broadcast = Object.values(page2?.blocks ?? {}).find((block) => block.opcode === 'event_broadcast' && broadcastInputName(block) === 'npage')
    expect(broadcast?.inputs?.BROADCAST_INPUT).toEqual([1, [11, 'npage', '?JrUh]BTyiuj,KuW6bEF']])
    expect(broadcast?.fields?.BROADCAST_OPTION).toBeUndefined()

    const exportedJson = JSON.parse(strFromU8(unzipSync(await vm.saveProjectSb3())['project.json']!))
    const exportedPage2 = exportedJson.targets.find((target: ScratchTarget) => target.name === 'Page2')
    const exportedBroadcast = Object.values(exportedPage2.blocks).find((block) => (block as ScratchBlock).opcode === 'event_broadcast' && broadcastInputName(block as ScratchBlock) === 'npage') as ScratchBlock | undefined
    expect(exportedBroadcast?.inputs?.BROADCAST_INPUT).toEqual([1, [11, 'npage', '?JrUh]BTyiuj,KuW6bEF']])
    expect(exportedBroadcast?.fields?.BROADCAST_OPTION).toBeUndefined()
  })

  it('creates clone threads and cleans clones on stop all', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.cloned = ['cloned', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'clone', topLevel: true },
      clone: { opcode: 'control_create_clone_of', parent: 'flag', inputs: { CLONE_OPTION: [1, [10, '_myself_']] } },
      startClone: { opcode: 'control_start_as_clone', next: 'set', topLevel: true },
      set: { opcode: 'data_setvariableto', parent: 'startClone', fields: { VARIABLE: ['cloned', 'cloned'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    expect(vm.exportProject().targets.some((target) => target.isClone)).toBe(true)
    expect(vm.getSprites().some((target) => target.isClone)).toBe(false)
    vm.stopAll()
    expect(vm.exportProject().targets.some((target) => target.isClone)).toBe(false)
  })

  it('deletes clones from clone scripts and notifies target listeners', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'clone', topLevel: true },
      clone: { opcode: 'control_create_clone_of', parent: 'flag', inputs: { CLONE_OPTION: [1, [10, '_myself_']] } },
      startClone: { opcode: 'control_start_as_clone', next: 'deleteClone', topLevel: true },
      deleteClone: { opcode: 'control_delete_this_clone', parent: 'startClone' },
    }
    const targetCounts: number[] = []
    const vm = new ScratchVM()
    vm.on<RuntimeSnapshot>('TARGETS_UPDATE', (payload) => {
      targetCounts.push(payload.project.targets.length)
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.exportProject().targets.some((target) => target.isClone)).toBe(false)
    expect(targetCounts.length).toBeGreaterThan(0)
    expect(targetCounts.at(-1)).toBe(2)
  })

  it('stops only other scripts in the same sprite', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.current = ['current', 0]
    sprite.variables.other = ['other', 0]
    sprite.variables.secondSprite = ['secondSprite', 0]
    project.targets.push({
      ...createDefaultProject().targets[1]!,
      id: 'sprite2',
      name: 'Sprite2',
      variables: { secondSprite: ['secondSprite', 0] },
      layerOrder: 2,
      blocks: {
        flag2: { opcode: 'event_whenflagclicked', next: 'wait2', topLevel: true },
        wait2: { opcode: 'control_wait', parent: 'flag2', next: 'setSecond', inputs: { DURATION: [1, [4, '1']] } },
        setSecond: { opcode: 'data_setvariableto', parent: 'wait2', fields: { VARIABLE: ['secondSprite', 'secondSprite'] }, inputs: { VALUE: [1, [4, '1']] } },
      },
    })
    sprite.blocks = {
      stopper: { opcode: 'event_whenflagclicked', next: 'stopOthers', topLevel: true },
      stopOthers: { opcode: 'control_stop', parent: 'stopper', next: 'setCurrent', fields: { STOP_OPTION: ['other scripts in sprite'] } },
      setCurrent: { opcode: 'data_setvariableto', parent: 'stopOthers', fields: { VARIABLE: ['current', 'current'] }, inputs: { VALUE: [1, [4, '1']] } },
      otherScript: { opcode: 'event_whenflagclicked', next: 'wait', topLevel: true },
      wait: { opcode: 'control_wait', parent: 'otherScript', next: 'setOther', inputs: { DURATION: [1, [4, '1']] } },
      setOther: { opcode: 'data_setvariableto', parent: 'wait', fields: { VARIABLE: ['other', 'other'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    vm.step(1500)
    expect(vm.getVariableValue('Sprite1', 'current')).toBe('1')
    expect(vm.getVariableValue('Sprite1', 'other')).toBe(0)
    expect(vm.getVariableValue('Sprite2', 'secondSprite')).toBe('1')
  })

  it('executes list mutation blocks with Scratch-style indexes', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.lists.items = ['items', ['a', 'b']]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'add', topLevel: true },
      add: { opcode: 'data_addtolist', parent: 'flag', next: 'insert', fields: { LIST: ['items', 'items'] }, inputs: { ITEM: [1, [10, 'c']] } },
      insert: { opcode: 'data_insertatlist', parent: 'add', next: 'replace', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [4, '2']], ITEM: [1, [10, 'x']] } },
      replace: { opcode: 'data_replaceitemoflist', parent: 'insert', next: 'delete', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [10, 'last']], ITEM: [1, [10, 'z']] } },
      delete: { opcode: 'data_deleteoflist', parent: 'replace', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getListValue('Sprite1', 'items')).toEqual(['x', 'b', 'z'])
  })

  it('uses list and sensing reporters inside stacks', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.length = ['length', 0]
    sprite.variables.mouse = ['mouse', 0]
    sprite.variables.answer = ['answer', '']
    sprite.variables.down = ['down', false]
    sprite.lists.items = ['items', ['red', 'blue']]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setLength', topLevel: true },
      setLength: { opcode: 'data_setvariableto', parent: 'flag', next: 'setMouse', fields: { VARIABLE: ['length', 'length'] }, inputs: { VALUE: [2, 'lengthReporter'] } },
      lengthReporter: { opcode: 'data_lengthoflist', parent: 'setLength', fields: { LIST: ['items', 'items'] } },
      setMouse: { opcode: 'data_setvariableto', parent: 'setLength', next: 'setAnswer', fields: { VARIABLE: ['mouse', 'mouse'] }, inputs: { VALUE: [2, 'mouseX'] } },
      mouseX: { opcode: 'sensing_mousex', parent: 'setMouse' },
      setAnswer: { opcode: 'data_setvariableto', parent: 'setMouse', next: 'setDown', fields: { VARIABLE: ['answer', 'answer'] }, inputs: { VALUE: [2, 'answerReporter'] } },
      answerReporter: { opcode: 'sensing_answer', parent: 'setAnswer' },
      setDown: { opcode: 'data_setvariableto', parent: 'setAnswer', fields: { VARIABLE: ['down', 'down'] }, inputs: { VALUE: [2, 'mouseDown'] } },
      mouseDown: { opcode: 'sensing_mousedown', parent: 'setDown' },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 42, y: -7, down: true })
    vm.answerPrompt('ok')
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'length')).toBe(2)
    expect(vm.getVariableValue('Sprite1', 'mouse')).toBe(42)
    expect(vm.getVariableValue('Sprite1', 'answer')).toBe('ok')
    expect(vm.getVariableValue('Sprite1', 'down')).toBe(true)
  })

  it('starts keyboard and sprite-click hats', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.hit = ['hit', 0]
    sprite.variables.any = ['any', false]
    sprite.blocks = {
      keyHat: { opcode: 'event_whenkeypressed', next: 'setKey', topLevel: true, fields: { KEY_OPTION: ['space', 'space'] } },
      setKey: { opcode: 'data_setvariableto', parent: 'keyHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '1']] } },
      anyHat: { opcode: 'event_whenkeypressed', next: 'setAny', topLevel: true, fields: { KEY_OPTION: ['any', 'any'] } },
      setAny: { opcode: 'data_setvariableto', parent: 'anyHat', fields: { VARIABLE: ['any', 'any'] }, inputs: { VALUE: [2, 'upPressed'] } },
      upPressed: { opcode: 'sensing_keypressed', parent: 'setAny', fields: { KEY_OPTION: ['up arrow', 'up arrow'] } },
      clickHat: { opcode: 'event_whenthisspriteclicked', next: 'setClick', topLevel: true },
      setClick: { opcode: 'data_setvariableto', parent: 'clickHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '2']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    let started = 0
    vm.on('PROJECT_RUN_START', () => {
      started += 1
    })
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('1')
    expect(started).toBe(1)
    vm.clickTarget('Sprite1')
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('2')
    vm.postKeyboard({ key: 'ArrowUp', isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'any')).toBe(true)
  })

  it('starts sprite and stage click hats from mouse IO transitions', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.variables.stageHit = ['stageHit', 0]
    sprite.variables.spriteHit = ['spriteHit', 0]
    stage.blocks = {
      stageClick: { opcode: 'event_whenstageclicked', next: 'setStageHit', topLevel: true },
      setStageHit: { opcode: 'data_setvariableto', parent: 'stageClick', fields: { VARIABLE: ['stageHit', 'stageHit'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    sprite.blocks = {
      spriteClick: { opcode: 'event_whenthisspriteclicked', next: 'changeSpriteHit', topLevel: true },
      changeSpriteHit: { opcode: 'data_changevariableby', parent: 'spriteClick', fields: { VARIABLE: ['spriteHit', 'spriteHit'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'spriteHit')).toBe(1)
    vm.postMouse({ x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: false })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'spriteHit')).toBe(1)

    vm.postMouse({ x: 200, y: 100, isDown: true })
    vm.step()
    expect(vm.getVariableValue('Stage', 'stageHit')).toBe('1')
  })

  it('starts draggable sprite click hats on mouse up and suppresses dragged releases', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.draggable = true
    sprite.variables.hit = ['hit', 0]
    sprite.blocks = {
      click: { opcode: 'event_whenthisspriteclicked', next: 'changeHit', topLevel: true },
      changeHit: { opcode: 'data_changevariableby', parent: 'click', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 0, y: 0, down: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe(0)
    vm.postMouse({ x: 0, y: 0, down: false, wasDragged: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe(0)
    vm.postMouse({ x: 0, y: 0, down: true })
    vm.postMouse({ x: 0, y: 0, down: false })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe(1)
  })

  it('starts key-pressed hats for repeated key-down events while pressed', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.count = ['count', 0]
    sprite.blocks = {
      keyHat: { opcode: 'event_whenkeypressed', next: 'change', topLevel: true, fields: { KEY_OPTION: ['space', 'space'] } },
      change: { opcode: 'data_changevariableby', parent: 'keyHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.step()
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(2)
    vm.postKeyboard({ key: 'space', isDown: false })
    vm.postKeyboard({ key: 'Spacebar', isDown: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(3)
  })

  it('reports all currently pressed keyboard keys', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.space = ['space', false]
    sprite.variables.up = ['up', false]
    sprite.variables.any = ['any', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setSpace', topLevel: true },
      setSpace: { opcode: 'data_setvariableto', parent: 'flag', next: 'setUp', fields: { VARIABLE: ['space', 'space'] }, inputs: { VALUE: [2, 'spacePressed'] } },
      spacePressed: { opcode: 'sensing_keypressed', parent: 'setSpace', fields: { KEY_OPTION: ['space', 'space'] } },
      setUp: { opcode: 'data_setvariableto', parent: 'setSpace', next: 'setAny', fields: { VARIABLE: ['up', 'up'] }, inputs: { VALUE: [2, 'upPressed'] } },
      upPressed: { opcode: 'sensing_keypressed', parent: 'setUp', fields: { KEY_OPTION: ['up arrow', 'up arrow'] } },
      setAny: { opcode: 'data_setvariableto', parent: 'setUp', fields: { VARIABLE: ['any', 'any'] }, inputs: { VALUE: [2, 'anyPressed'] } },
      anyPressed: { opcode: 'sensing_keypressed', parent: 'setAny', fields: { KEY_OPTION: ['any', 'any'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postKeyboard({ key: 'space', isDown: true })
    vm.postKeyboard({ key: 'ArrowUp', isDown: true })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'space')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'up')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'any')).toBe(true)

    vm.postKeyboard({ key: 'space', isDown: false })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'space')).toBe(false)
    expect(vm.getVariableValue('Sprite1', 'up')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'any')).toBe(true)
  })

  it('executes looks bubble and sound volume blocks', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.sounds = [{ name: 'pop', assetId: 'pop', dataFormat: 'wav' }]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'say', topLevel: true },
      say: { opcode: 'looks_say', parent: 'flag', next: 'volume', inputs: { MESSAGE: [1, [10, 'hello']] } },
      volume: { opcode: 'sound_setvolumeto', parent: 'say', next: 'play', inputs: { VOLUME: [1, [4, '35']] } },
      play: { opcode: 'sound_play', parent: 'volume', fields: { SOUND_MENU: ['pop', 'pop'] } },
    }
    const played: string[] = []
    const volumes: number[] = []
    let stopped = 0
    let questionClosed = false
    const vm = new ScratchVM()
    vm.on<{ question: string | null }>('QUESTION', (payload) => {
      if (payload.question === null) questionClosed = true
    })
    vm.attachAudioEngine({
      playSound(_targetName: string, sound: { name: string }) {
        played.push(sound.name)
      },
      setVolume(_targetName: string, volume: number) {
        volumes.push(volume)
      },
      stopAllSounds() {
        stopped += 1
      },
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.speechBubble?.text).toBe('hello')
    expect(target.volume).toBe(35)
    expect(volumes).toEqual([35])
    expect(played).toEqual(['pop'])
    vm.stopAll()
    expect(vm.getTarget('Sprite1')?.speechBubble).toBeUndefined()
    expect(stopped).toBe(2)
    expect(questionClosed).toBe(true)
  })

  it('stores sound effects and reports loudness', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.loudness = ['loudness', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'think', topLevel: true },
      think: { opcode: 'looks_thinkforsecs', parent: 'flag', next: 'setPitch', inputs: { MESSAGE: [1, [10, 'hmm']], SECS: [1, [4, '0']] } },
      setPitch: { opcode: 'sound_seteffectto', parent: 'think', next: 'changePitch', fields: { EFFECT: ['PITCH'] }, inputs: { VALUE: [1, [4, '20']] } },
      changePitch: { opcode: 'sound_changeeffectby', parent: 'setPitch', next: 'storeLoudness', fields: { EFFECT: ['PITCH'] }, inputs: { VALUE: [1, [4, '-5']] } },
      storeLoudness: { opcode: 'data_setvariableto', parent: 'changePitch', fields: { VARIABLE: ['loudness', 'loudness'] }, inputs: { VALUE: [2, 'loudnessReporter'] } },
      loudnessReporter: { opcode: 'sensing_loudness', parent: 'storeLoudness' },
    }
    const calls: Array<Record<string, number>> = []
    const vm = new ScratchVM()
    vm.attachAudioEngine({
      setEffects(_targetName: string, effects: Record<string, number>) {
        calls.push(effects)
      },
    })
    vm.loadProject(project)
    vm.postIOData('audio', { loudness: 42 })
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.speechBubble?.type).toBe('think')
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.soundEffects?.pitch).toBe(15)
    expect(vm.getVariableValue('Sprite1', 'loudness')).toBe(42)
    expect(calls.at(-1)).toEqual({ pitch: 15 })
  })

  it('reports motion, size, and volume values', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.x = ['x', 0]
    sprite.variables.size = ['size', 0]
    sprite.variables.volume = ['volume', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'point', topLevel: true },
      point: { opcode: 'motion_pointindirection', parent: 'flag', next: 'setX', inputs: { DIRECTION: [1, [4, '-45']] } },
      setX: { opcode: 'motion_setx', parent: 'point', next: 'sizeTo', inputs: { X: [1, [4, '123']] } },
      sizeTo: { opcode: 'looks_setsizeto', parent: 'setX', next: 'volumeTo', inputs: { SIZE: [1, [4, '80']] } },
      volumeTo: { opcode: 'sound_setvolumeto', parent: 'sizeTo', next: 'storeX', inputs: { VOLUME: [1, [4, '55']] } },
      storeX: { opcode: 'data_setvariableto', parent: 'volumeTo', next: 'storeSize', fields: { VARIABLE: ['x', 'x'] }, inputs: { VALUE: [2, 'xReporter'] } },
      xReporter: { opcode: 'motion_xposition', parent: 'storeX' },
      storeSize: { opcode: 'data_setvariableto', parent: 'storeX', next: 'storeVolume', fields: { VARIABLE: ['size', 'size'] }, inputs: { VALUE: [2, 'sizeReporter'] } },
      sizeReporter: { opcode: 'looks_size', parent: 'storeSize' },
      storeVolume: { opcode: 'data_setvariableto', parent: 'storeSize', fields: { VARIABLE: ['volume', 'volume'] }, inputs: { VALUE: [2, 'volumeReporter'] } },
      volumeReporter: { opcode: 'sound_volume', parent: 'storeVolume' },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.direction).toBe(-45)
    expect(vm.getVariableValue('Sprite1', 'x')).toBe(123)
    expect(vm.getVariableValue('Sprite1', 'size')).toBe(80)
    expect(vm.getVariableValue('Sprite1', 'volume')).toBe(55)
  })

  it('executes additional motion, backdrop, and layer blocks', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.costumes.push({ name: 'second', dataFormat: 'svg' })
    project.targets.push({
      ...createDefaultProject().targets[1]!,
      id: 'sprite2',
      name: 'Sprite2',
      x: 40,
      y: -20,
      layerOrder: 2,
    })
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'goto', topLevel: true },
      goto: { opcode: 'motion_goto', parent: 'flag', next: 'point', inputs: { TO: [1, [10, 'Sprite2']] } },
      point: { opcode: 'motion_pointtowards', parent: 'goto', next: 'backdrop', inputs: { TOWARDS: [1, [10, '_mouse_']] } },
      backdrop: { opcode: 'looks_switchbackdropto', parent: 'point', next: 'front', fields: { BACKDROP: ['second', 'second'] } },
      front: { opcode: 'looks_gotofrontback', parent: 'backdrop', fields: { FRONT_BACK: ['front'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 40, y: 80 })
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.x).toBe(40)
    expect(vm.getTarget('Sprite1')?.y).toBe(-20)
    expect(vm.getTarget('Sprite1')?.direction).toBe(0)
    expect(vm.getStage().currentCostume).toBe(1)
    expect((vm.getTarget('Sprite1')?.layerOrder ?? 0) > (vm.getTarget('Sprite2')?.layerOrder ?? 0)).toBe(true)
  })

  it('points toward mouse positions in Scratch coordinates', () => {
    const quadrants: Array<[{ x: number; y: number }, number]> = [
      [{ x: 100, y: 100 }, 45],
      [{ x: -100, y: 100 }, -45],
      [{ x: 100, y: -100 }, 135],
      [{ x: -100, y: -100 }, -135],
    ]

    for (const [mouse, direction] of quadrants) {
      const project = createDefaultProject()
      const sprite = project.targets[1]!
      sprite.x = 0
      sprite.y = 0
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'point', topLevel: true },
        point: { opcode: 'motion_pointtowards', parent: 'flag', inputs: { TOWARDS: [1, [10, '_mouse_']] } },
      }
      const vm = new ScratchVM()
      vm.loadProject(project)
      vm.postMouse(mouse)
      vm.greenFlag()
      vm.step()
      expect(vm.getTarget('Sprite1')?.direction).toBe(direction)
    }
  })

  it('supports glide-to, backdrop-and-wait, touching hats, and online/loud reporters', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.costumes.push({ name: 'second', dataFormat: 'svg' })
    sprite.variables.hit = ['hit', 0]
    sprite.variables.online = ['online', false]
    sprite.variables.loud = ['loud', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'glideTo', topLevel: true },
      glideTo: { opcode: 'motion_glideto', parent: 'flag', next: 'switchWait', inputs: { TO: [1, [10, '_mouse_']], SECS: [1, [4, '0']] } },
      switchWait: { opcode: 'looks_switchbackdroptoandwait', parent: 'glideTo', next: 'setOnline', fields: { BACKDROP: ['second', 'second'] } },
      setOnline: { opcode: 'data_setvariableto', parent: 'switchWait', next: 'setLoud', fields: { VARIABLE: ['online', 'online'] }, inputs: { VALUE: [2, 'onlineReporter'] } },
      onlineReporter: { opcode: 'sensing_online', parent: 'setOnline' },
      setLoud: { opcode: 'data_setvariableto', parent: 'setOnline', fields: { VARIABLE: ['loud', 'loud'] }, inputs: { VALUE: [2, 'loudReporter'] } },
      loudReporter: { opcode: 'sensing_loud', parent: 'setLoud' },
      backdropHat: { opcode: 'event_whenbackdropswitchesto', next: 'setBackdropHit', topLevel: true, fields: { BACKDROP: ['second', 'second'] } },
      setBackdropHit: { opcode: 'data_setvariableto', parent: 'backdropHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '1']] } },
      touchingHat: { opcode: 'event_whentouchingobject', next: 'setTouchingHit', topLevel: true, fields: { TOUCHINGOBJECTMENU: ['_mouse_', '_mouse_'] } },
      setTouchingHit: { opcode: 'data_setvariableto', parent: 'touchingHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '2']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 11, y: 12 })
    vm.postIOData('audio', { loudness: 20 })
    vm.postIOData('network', { online: true })
    vm.greenFlag()
    for (let step = 0; step < 5; step += 1) vm.step()
    expect(vm.getTarget('Sprite1')?.x).toBe(11)
    expect(vm.getTarget('Sprite1')?.y).toBe(12)
    expect(vm.getStage().currentCostume).toBe(1)
    expect(vm.getVariableValue('Sprite1', 'online')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'loud')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('1')
    vm.postMouse({ x: 240, y: 180 })
    vm.step()
    vm.postMouse({ x: 11, y: 12 })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('2')
  })

  it('supports wait-until, repeat-until, and ask-and-wait control flow', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.count = ['count', 0]
    sprite.variables.answer = ['answer', '']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'repeatUntil', topLevel: true },
      repeatUntil: { opcode: 'control_repeat_until', parent: 'flag', next: 'ask', inputs: { CONDITION: [2, 'done'], SUBSTACK: [2, 'change'] } },
      done: { opcode: 'operator_gt', parent: 'repeatUntil', inputs: { OPERAND1: [2, 'count'], OPERAND2: [1, [4, '2']] } },
      count: { opcode: 'data_variable', parent: 'done', fields: { VARIABLE: ['count', 'count'] } },
      change: { opcode: 'data_changevariableby', parent: 'repeatUntil', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
      ask: { opcode: 'sensing_askandwait', parent: 'repeatUntil', next: 'storeAnswer', inputs: { QUESTION: [1, [10, 'ready?']] } },
      storeAnswer: { opcode: 'data_setvariableto', parent: 'ask', fields: { VARIABLE: ['answer', 'answer'] }, inputs: { VALUE: [2, 'answerReporter'] } },
      answerReporter: { opcode: 'sensing_answer', parent: 'storeAnswer' },
    }
    const vm = new ScratchVM()
    const questions: string[] = []
    vm.on<{ question: string }>('QUESTION', (payload) => {
      if (!payload.question) return
      questions.push(payload.question)
      vm.answerPrompt('yes')
    })
    vm.loadProject(project)
    vm.greenFlag()
    for (let i = 0; i < 8; i += 1) vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(3)
    expect(vm.getVariableValue('Sprite1', 'answer')).toBe('yes')
    expect(questions).toEqual(['ready?'])
  })

  it('keeps ask-and-wait threads paused until an answer is supplied', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.answer = ['answer', '']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'ask', topLevel: true },
      ask: { opcode: 'sensing_askandwait', parent: 'flag', next: 'storeAnswer', inputs: { QUESTION: [1, [10, 'ready?']] } },
      storeAnswer: { opcode: 'data_setvariableto', parent: 'ask', fields: { VARIABLE: ['answer', 'answer'] }, inputs: { VALUE: [2, 'answerReporter'] } },
      answerReporter: { opcode: 'sensing_answer', parent: 'storeAnswer' },
    }
    const vm = new ScratchVM()
    let questions = 0
    vm.on<{ question: string }>('QUESTION', (payload) => {
      if (payload.question) questions += 1
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    vm.step()
    expect(questions).toBe(1)
    expect(vm.snapshot().threads[0]?.status).toBe('waiting')
    expect(vm.getVariableValue('Sprite1', 'answer')).toBe('')
    vm.answerPrompt('yes')
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'answer')).toBe('yes')
    expect(vm.snapshot().threads).toHaveLength(0)
  })

  it('normalizes non-finite wait durations instead of waiting forever', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'wait', topLevel: true },
      wait: { opcode: 'control_wait', parent: 'flag', next: 'setDone', inputs: { DURATION: [1, [10, 'Infinity']] } },
      setDone: { opcode: 'data_setvariableto', parent: 'wait', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    vm.step(1001)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('1')
  })

  it('casts Scratch boolean strings inside control blocks', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.result = ['result', 'unchanged']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'ifFalseString', topLevel: true },
      ifFalseString: { opcode: 'control_if', parent: 'flag', next: 'ifTrueString', inputs: { CONDITION: [1, [10, 'false']], SUBSTACK: [2, 'bad'] } },
      bad: { opcode: 'data_setvariableto', parent: 'ifFalseString', fields: { VARIABLE: ['result', 'result'] }, inputs: { VALUE: [1, [10, 'bad']] } },
      ifTrueString: { opcode: 'control_if', parent: 'ifFalseString', inputs: { CONDITION: [1, [10, 'hello']], SUBSTACK: [2, 'good'] } },
      good: { opcode: 'data_setvariableto', parent: 'ifTrueString', fields: { VARIABLE: ['result', 'result'] }, inputs: { VALUE: [1, [10, 'good']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'result')).toBe('good')
  })

  it('continues after control branch substacks finish', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.result = ['result', 'start']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'ifElse', topLevel: true },
      ifElse: { opcode: 'control_if_else', parent: 'flag', next: 'after', inputs: { CONDITION: [1, [10, 'false']], SUBSTACK: [2, 'bad'], SUBSTACK2: [2, 'branch'] } },
      bad: { opcode: 'data_setvariableto', parent: 'ifElse', fields: { VARIABLE: ['result', 'result'] }, inputs: { VALUE: [1, [10, 'bad']] } },
      branch: { opcode: 'data_setvariableto', parent: 'ifElse', fields: { VARIABLE: ['result', 'result'] }, inputs: { VALUE: [1, [10, 'branch']] } },
      after: { opcode: 'data_setvariableto', parent: 'ifElse', fields: { VARIABLE: ['result', 'result'] }, inputs: { VALUE: [1, [10, 'after']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'result')).toBe('after')
  })

  it('supports repeat counts, for-each, while, counters, and list monitors', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.count = ['count', 0]
    sprite.variables.i = ['i', 0]
    sprite.variables.counter = ['counter', 0]
    sprite.lists.items = ['items', ['a']]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'clearCounter', topLevel: true },
      clearCounter: { opcode: 'control_clear_counter', parent: 'flag', next: 'repeat' },
      repeat: { opcode: 'control_repeat', parent: 'clearCounter', next: 'forEach', inputs: { TIMES: [1, [4, '3']], SUBSTACK: [2, 'changeCount'] } },
      changeCount: { opcode: 'data_changevariableby', parent: 'repeat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
      forEach: { opcode: 'control_for_each', parent: 'repeat', next: 'while', fields: { VARIABLE: ['i', 'i'] }, inputs: { VALUE: [1, [4, '2']], SUBSTACK: [2, 'incrCounter'] } },
      incrCounter: { opcode: 'control_incr_counter', parent: 'forEach' },
      while: { opcode: 'control_while', parent: 'forEach', next: 'storeCounter', inputs: { CONDITION: [2, 'lessThanFive'], SUBSTACK: [2, 'changeCountAgain'] } },
      lessThanFive: { opcode: 'operator_lt', parent: 'while', inputs: { OPERAND1: [2, 'countReporter'], OPERAND2: [1, [4, '5']] } },
      countReporter: { opcode: 'data_variable', parent: 'lessThanFive', fields: { VARIABLE: ['count', 'count'] } },
      changeCountAgain: { opcode: 'data_changevariableby', parent: 'while', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
      storeCounter: { opcode: 'data_setvariableto', parent: 'while', next: 'showList', fields: { VARIABLE: ['counter', 'counter'] }, inputs: { VALUE: [2, 'counterReporter'] } },
      counterReporter: { opcode: 'control_get_counter', parent: 'storeCounter' },
      showList: { opcode: 'data_showlist', parent: 'storeCounter', fields: { LIST: ['items', 'items'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    for (let step = 0; step < 8; step += 1) vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(5)
    expect(vm.getVariableValue('Sprite1', 'i')).toBe(2)
    expect(vm.getVariableValue('Sprite1', 'counter')).toBe(2)
    expect(vm.getMonitors().some((monitor) => monitor.opcode === 'data_listcontents' && monitor.visible)).toBe(true)
  })

  it('reports sensing collisions, distances, clock values, and username', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 0
    sprite.y = 0
    sprite.variables.touching = ['touching', false]
    sprite.variables.distance = ['distance', 0]
    sprite.variables.user = ['user', '']
    project.targets.push({
      ...createDefaultProject().targets[1]!,
      id: 'sprite2',
      name: 'Sprite2',
      x: 20,
      y: 0,
      layerOrder: 2,
    })
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setTouching', topLevel: true },
      setTouching: { opcode: 'data_setvariableto', parent: 'flag', next: 'setDistance', fields: { VARIABLE: ['touching', 'touching'] }, inputs: { VALUE: [2, 'touchingReporter'] } },
      touchingReporter: { opcode: 'sensing_touchingobject', parent: 'setTouching', fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
      setDistance: { opcode: 'data_setvariableto', parent: 'setTouching', next: 'setUser', fields: { VARIABLE: ['distance', 'distance'] }, inputs: { VALUE: [2, 'distanceReporter'] } },
      distanceReporter: { opcode: 'sensing_distanceto', parent: 'setDistance', fields: { DISTANCETOMENU: ['_mouse_', '_mouse_'] } },
      setUser: { opcode: 'data_setvariableto', parent: 'setDistance', fields: { VARIABLE: ['user', 'user'] }, inputs: { VALUE: [2, 'userReporter'] } },
      userReporter: { opcode: 'sensing_username', parent: 'setUser' },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 3, y: 4 })
    vm.postIOData('userData', { username: 'scratch-user' })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'touching')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'distance')).toBe(5)
    expect(vm.getVariableValue('Sprite1', 'user')).toBe('scratch-user')
  })

  it('uses costume bounds for touching object, mouse, and edge sensing', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 0
    sprite.y = 0
    sprite.variables.spriteHit = ['spriteHit', false]
    sprite.variables.mouseHit = ['mouseHit', false]
    sprite.variables.edgeHit = ['edgeHit', false]
    project.targets.push({
      ...structuredClone(project.targets[1]!),
      id: 'sprite2',
      name: 'Sprite2',
      x: 80,
      y: 0,
      layerOrder: 2,
    })
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'spriteHit', topLevel: true },
      spriteHit: { opcode: 'data_setvariableto', parent: 'flag', next: 'mouseHit', fields: { VARIABLE: ['spriteHit', 'spriteHit'] }, inputs: { VALUE: [2, 'spriteTouch'] } },
      spriteTouch: { opcode: 'sensing_touchingobject', parent: 'spriteHit', fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
      mouseHit: { opcode: 'data_setvariableto', parent: 'spriteHit', next: 'edgeHit', fields: { VARIABLE: ['mouseHit', 'mouseHit'] }, inputs: { VALUE: [2, 'mouseTouch'] } },
      mouseTouch: { opcode: 'sensing_touchingobject', parent: 'mouseHit', fields: { TOUCHINGOBJECTMENU: ['_mouse_', '_mouse_'] } },
      edgeHit: { opcode: 'data_setvariableto', parent: 'mouseHit', fields: { VARIABLE: ['edgeHit', 'edgeHit'] }, inputs: { VALUE: [2, 'edgeTouch'] } },
      edgeTouch: { opcode: 'sensing_touchingobject', parent: 'edgeHit', fields: { TOUCHINGOBJECTMENU: ['_edge_', '_edge_'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postMouse({ x: 40, y: 0 })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'spriteHit')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'mouseHit')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'edgeHit')).toBe(false)

    vm.updateTarget('Sprite1', { x: 200 })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'edgeHit')).toBe(true)
  })

  it('uses renderer collision results instead of broad target bounds when available', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.touching = ['touching', false]
    project.targets.push({
      ...structuredClone(project.targets[1]!),
      id: 'sprite2',
      name: 'Sprite2',
      x: 10,
      y: 0,
      layerOrder: 2,
    })
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setTouching', topLevel: true },
      setTouching: { opcode: 'data_setvariableto', parent: 'flag', fields: { VARIABLE: ['touching', 'touching'] }, inputs: { VALUE: [2, 'touchingReporter'] } },
      touchingReporter: { opcode: 'sensing_touchingobject', parent: 'setTouching', fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
    }

    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.attachRenderer({
      requestDraw: () => undefined,
      isTouchingDrawables: () => false,
    })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'touching')).toBe(false)
  })

  it('uses renderer pixel hit tests for mouse touching and color sensing', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.mouseHit = ['mouseHit', false]
    sprite.variables.touchingColor = ['touchingColor', false]
    sprite.variables.colorTouching = ['colorTouching', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setMouse', topLevel: true },
      setMouse: { opcode: 'data_setvariableto', parent: 'flag', next: 'setTouchingColor', fields: { VARIABLE: ['mouseHit', 'mouseHit'] }, inputs: { VALUE: [2, 'mouseReporter'] } },
      mouseReporter: { opcode: 'sensing_touchingobject', parent: 'setMouse', fields: { TOUCHINGOBJECTMENU: ['_mouse_', '_mouse_'] } },
      setTouchingColor: { opcode: 'data_setvariableto', parent: 'setMouse', next: 'setColorTouching', fields: { VARIABLE: ['touchingColor', 'touchingColor'] }, inputs: { VALUE: [2, 'touchingColorReporter'] } },
      touchingColorReporter: { opcode: 'sensing_touchingcolor', parent: 'setTouchingColor', inputs: { COLOR: [1, [9, '#112233']] } },
      setColorTouching: { opcode: 'data_setvariableto', parent: 'setTouchingColor', fields: { VARIABLE: ['colorTouching', 'colorTouching'] }, inputs: { VALUE: [2, 'colorTouchingReporter'] } },
      colorTouchingReporter: { opcode: 'sensing_coloristouchingcolor', parent: 'setColorTouching', inputs: { COLOR: [1, [9, '#445566']], COLOR2: [1, [9, '#112233']] } },
    }

    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.attachRenderer({
      requestDraw: () => undefined,
      drawableTouchingScratchPoint: () => false,
      isTouchingColor: () => false,
      isColorTouchingColor: () => false,
      sampleColor: () => ({ r: 17, g: 34, b: 51, a: 255 }),
    })
    vm.postMouse({ x: 0, y: 0 })
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'mouseHit')).toBe(false)
    expect(vm.getVariableValue('Sprite1', 'touchingColor')).toBe(false)
    expect(vm.getVariableValue('Sprite1', 'colorTouching')).toBe(false)
  })

  it('supports color sensing, drag mode, and object property reporters', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 7
    sprite.y = 8
    sprite.variables.camera = ['camera', 42]
    sprite.variables.touchingColor = ['touchingColor', false]
    sprite.variables.spriteX = ['spriteX', 0]
    sprite.variables.spriteCamera = ['spriteCamera', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'drag', topLevel: true },
      drag: { opcode: 'sensing_setdragmode', parent: 'flag', next: 'setTouching', fields: { DRAG_MODE: ['draggable'] } },
      setTouching: { opcode: 'data_setvariableto', parent: 'drag', next: 'setX', fields: { VARIABLE: ['touchingColor', 'touchingColor'] }, inputs: { VALUE: [2, 'touchingColorReporter'] } },
      touchingColorReporter: { opcode: 'sensing_touchingcolor', parent: 'setTouching', inputs: { COLOR: [1, [9, '#112233']] } },
      setX: { opcode: 'data_setvariableto', parent: 'setTouching', next: 'setCamera', fields: { VARIABLE: ['spriteX', 'spriteX'] }, inputs: { VALUE: [2, 'xOfSprite'] } },
      xOfSprite: { opcode: 'sensing_of', parent: 'setX', fields: { PROPERTY: ['x position'], OBJECT: ['Sprite1'] } },
      setCamera: { opcode: 'data_setvariableto', parent: 'setX', fields: { VARIABLE: ['spriteCamera', 'spriteCamera'] }, inputs: { VALUE: [2, 'cameraOfSprite'] } },
      cameraOfSprite: { opcode: 'sensing_of', parent: 'setCamera', fields: { PROPERTY: ['camera'] }, inputs: { OBJECT: [1, 'cameraObjectMenu'] } },
      cameraObjectMenu: { opcode: 'sensing_of_object_menu', parent: 'cameraOfSprite', shadow: true, fields: { OBJECT: ['Sprite1', 'Sprite1'] } },
    }
    const vm = new ScratchVM()
    vm.attachRenderer({
      sampleColor() {
        return { r: 17, g: 34, b: 51, a: 255 }
      },
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.draggable).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'touchingColor')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'spriteX')).toBe(7)
    expect(vm.getVariableValue('Sprite1', 'spriteCamera')).toBe(42)
  })

  it('samples across sprite bounds for touching-color sensing', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.touchingColor = ['touchingColor', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setTouching', topLevel: true },
      setTouching: { opcode: 'data_setvariableto', parent: 'flag', fields: { VARIABLE: ['touchingColor', 'touchingColor'] }, inputs: { VALUE: [2, 'touchingColorReporter'] } },
      touchingColorReporter: { opcode: 'sensing_touchingcolor', parent: 'setTouching', inputs: { COLOR: [1, [9, '#112233']] } },
    }
    const vm = new ScratchVM()
    vm.attachRenderer({
      sampleColor(x) {
        return x > 20 ? { r: 17, g: 34, b: 51, a: 255 } : { r: 255, g: 255, b: 255, a: 255 }
      },
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'touchingColor')).toBe(true)
  })

  it('executes custom procedure calls with string-number arguments', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.total = ['total', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'callAdd', topLevel: true },
      callAdd: {
        opcode: 'procedures_call',
        parent: 'flag',
        mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]' },
        inputs: { arg1: [1, [4, '5']] },
      },
      definition: { opcode: 'procedures_definition', next: 'changeTotal', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: {
        opcode: 'procedures_prototype',
        parent: 'definition',
        shadow: true,
        mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]', warp: 'false' },
      },
      changeTotal: { opcode: 'data_changevariableby', parent: 'definition', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [2, 'amountReporter'] } },
      amountReporter: { opcode: 'argument_reporter_string_number', parent: 'changeTotal', fields: { VALUE: ['amount'] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'total')).toBe(5)
  })

  it('returns from procedures before resuming the caller loop', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.total = ['total', 0]
    sprite.variables.done = ['done', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'repeat', topLevel: true },
      repeat: { opcode: 'control_repeat', parent: 'flag', next: 'done', inputs: { TIMES: [1, [4, '2']], SUBSTACK: [2, 'callAdd'] } },
      callAdd: { opcode: 'procedures_call', parent: 'repeat', mutation: { proccode: 'add', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]' } },
      done: { opcode: 'data_setvariableto', parent: 'repeat', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [10, 'true']] } },
      definition: { opcode: 'procedures_definition', next: 'changeTotal', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: { opcode: 'procedures_prototype', parent: 'definition', shadow: true, mutation: { proccode: 'add', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'false' } },
      changeTotal: { opcode: 'data_changevariableby', parent: 'definition', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'total')).toBe(2)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('true')
  })

  it('treats stop-this-script inside a procedure as returning from that procedure', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.total = ['total', 0]
    sprite.variables.after = ['after', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'forever', topLevel: true },
      forever: { opcode: 'control_forever', parent: 'flag', inputs: { SUBSTACK: [2, 'callTick'] } },
      callTick: { opcode: 'procedures_call', parent: 'forever', mutation: { proccode: 'tick', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      definition: { opcode: 'procedures_definition', next: 'changeTotal', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: { opcode: 'procedures_prototype', parent: 'definition', shadow: true, mutation: { proccode: 'tick', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      changeTotal: { opcode: 'data_changevariableby', parent: 'definition', next: 'stopProc', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [1, [4, '1']] } },
      stopProc: { opcode: 'control_stop', parent: 'changeTotal', next: 'unreachable', fields: { STOP_OPTION: ['this script', 'null'] } },
      unreachable: { opcode: 'data_changevariableby', parent: 'stopProc', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [1, [4, '100']] } },
      afterForever: { opcode: 'data_changevariableby', parent: 'forever', fields: { VARIABLE: ['after', 'after'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'total')).toBe(2)
    expect(vm.getVariableValue('Sprite1', 'after')).toBe(0)
    expect(vm.snapshot().threads).toHaveLength(1)
  })

  it('runs warp procedures to completion before yielding a forever loop', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.total = ['total', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'forever', topLevel: true },
      forever: { opcode: 'control_forever', parent: 'flag', inputs: { SUBSTACK: [2, 'callAdd'] } },
      callAdd: { opcode: 'procedures_call', parent: 'forever', mutation: { proccode: 'add many', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      definition: { opcode: 'procedures_definition', next: 'repeat', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: { opcode: 'procedures_prototype', parent: 'definition', shadow: true, mutation: { proccode: 'add many', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      repeat: { opcode: 'control_repeat', parent: 'definition', inputs: { TIMES: [1, [4, '1000']], SUBSTACK: [2, 'changeTotal'] } },
      changeTotal: { opcode: 'data_changevariableby', parent: 'repeat', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'total')).toBe(1000)
    expect(vm.snapshot().threads[0]?.currentBlockId).toBe('callAdd')
  })

  it('keeps common extension blocks executable through VM state and events', () => {
    const project = createDefaultProject()
    project.extensions = ['pen', 'music', 'translate', 'text2speech', 'videoSensing']
    const sprite = project.targets[1]!
    sprite.variables.tempo = ['tempo', 0]
    sprite.variables.translation = ['translation', '']
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'penDown', topLevel: true },
      penDown: { opcode: 'pen_penDown', parent: 'flag', next: 'setPenSize' },
      setPenSize: { opcode: 'pen_setPenSizeTo', parent: 'penDown', next: 'tempo', inputs: { SIZE: [1, [4, '7']] } },
      tempo: { opcode: 'music_setTempo', parent: 'setPenSize', next: 'storeTempo', inputs: { TEMPO: [1, [4, '120']] } },
      storeTempo: { opcode: 'data_setvariableto', parent: 'tempo', next: 'storeTranslation', fields: { VARIABLE: ['tempo', 'tempo'] }, inputs: { VALUE: [2, 'tempoReporter'] } },
      tempoReporter: { opcode: 'music_getTempo', parent: 'storeTempo' },
      storeTranslation: { opcode: 'data_setvariableto', parent: 'storeTempo', next: 'video', fields: { VARIABLE: ['translation', 'translation'] }, inputs: { VALUE: [2, 'translationReporter'] } },
      translationReporter: { opcode: 'translate_getTranslate', parent: 'storeTranslation', inputs: { WORDS: [1, [10, 'hello']] } },
      video: { opcode: 'videoSensing_setVideoTransparency', parent: 'storeTranslation', fields: { TRANSPARENCY: ['30'] }, inputs: { TRANSPARENCY: [1, [4, '30']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.pen).toMatchObject({ down: true, size: 7 })
    expect(vm.getStage().tempo).toBe(120)
    expect(vm.getStage().videoTransparency).toBe(30)
    expect(vm.getVariableValue('Sprite1', 'tempo')).toBe(120)
    expect(vm.getVariableValue('Sprite1', 'translation')).toBe('hello')
  })

  it('records pen trails while the pen is down', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'penDown', topLevel: true },
      penDown: { opcode: 'pen_penDown', parent: 'flag', next: 'move' },
      move: { opcode: 'motion_movesteps', parent: 'penDown', inputs: { STEPS: [1, [4, '40']] } },
    }
    const vm = new ScratchVM()
    const penLines: Array<{ x1: number; x2: number }> = []
    vm.attachRenderer({ penLine: (line) => penLines.push(line) })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.penLines).toHaveLength(0)
    expect(penLines).toHaveLength(1)
    expect(penLines[0]?.x2).toBe(40)
  })

  it('sends pen stamps to the renderer pen layer', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 12
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'stamp', topLevel: true },
      stamp: { opcode: 'pen_stamp', parent: 'flag' },
    }
    const vm = new ScratchVM()
    const stamps: ScratchTarget[] = []
    vm.attachRenderer({ penStamp: (target) => stamps.push(target) })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(stamps).toHaveLength(1)
    expect(stamps[0]?.name).toBe('Sprite1')
    expect(stamps[0]?.x).toBe(12)
  })

  it('renders numeric Scratch pen colors as ARGB CSS colors', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.visible = false
    sprite.penLines = [{ x1: -10, y1: -10, x2: 10, y2: 10, color: '4294967295', size: 4, transparency: 0 }]
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    const strokes: Array<{ strokeStyle: string }> = []
    let strokeStyle = ''
    const context = {
      get strokeStyle() {
        return strokeStyle
      },
      set strokeStyle(value: string) {
        strokeStyle = value
      },
      clearRect: () => undefined,
      fillRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      stroke: () => strokes.push({ strokeStyle }),
    } as unknown as CanvasRenderingContext2D
    const internals = renderer as unknown as {
      canvas: HTMLCanvasElement
      context: CanvasRenderingContext2D
    }
    internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
    internals.context = context
    renderer.requestDraw(vm.snapshot())
    expect(strokes).toContainEqual({ strokeStyle: 'rgba(255, 255, 255, 1)' })
  })

  it('draws a stationary pen down/up as a round pen dot', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 12
    sprite.y = -4
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'penDown', topLevel: true },
      penDown: { opcode: 'pen_penDown', parent: 'flag', next: 'penUp' },
      penUp: { opcode: 'pen_penUp', parent: 'penDown' },
    }
    const vm = new ScratchVM()
    const penLines: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; size: number; transparency: number }> = []
    vm.attachRenderer({ penLine: (line) => penLines.push(line) })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(penLines).toEqual([{ x1: 12, y1: -4, x2: 12, y2: -4, color: '#000000', size: 1, transparency: 0 }])
  })

  it('keeps large pen drawings intact', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'penDown', topLevel: true },
      penDown: { opcode: 'pen_penDown', parent: 'flag', next: 'callDraw' },
      callDraw: { opcode: 'procedures_call', parent: 'penDown', mutation: { proccode: 'draw many', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      definition: { opcode: 'procedures_definition', next: 'repeat', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: { opcode: 'procedures_prototype', parent: 'definition', shadow: true, mutation: { proccode: 'draw many', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      repeat: { opcode: 'control_repeat', parent: 'definition', inputs: { TIMES: [1, [4, '2501']], SUBSTACK: [2, 'move'] } },
      move: { opcode: 'motion_movesteps', parent: 'repeat', inputs: { STEPS: [1, [4, '0.05']] } },
    }
    const vm = new ScratchVM()
    const penLines: Array<{ x1: number }> = []
    vm.attachRenderer({ penLine: (line) => penLines.push(line) })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.penLines).toHaveLength(0)
    expect(penLines).toHaveLength(2501)
    expect(penLines[0]?.x1).toBe(0)
  })

  it('presents warp pen redraws only at the completed runtime step boundary', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'callDraw', topLevel: true },
      callDraw: { opcode: 'procedures_call', parent: 'flag', mutation: { proccode: 'redraw', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      definition: { opcode: 'procedures_definition', next: 'clear', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
      prototype: { opcode: 'procedures_prototype', parent: 'definition', shadow: true, mutation: { proccode: 'redraw', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } },
      clear: { opcode: 'pen_clear', parent: 'definition', next: 'penDown' },
      penDown: { opcode: 'pen_penDown', parent: 'clear', next: 'repeat' },
      repeat: { opcode: 'control_repeat', parent: 'penDown', inputs: { TIMES: [1, [4, '8']], SUBSTACK: [2, 'move'] } },
      move: { opcode: 'motion_movesteps', parent: 'repeat', inputs: { STEPS: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    let penClears = 0
    let draws = 0
    let drawsAtPenClear = -1
    vm.attachRenderer({
      penClear: () => {
        penClears += 1
        drawsAtPenClear = draws
      },
      penLine: () => undefined,
      requestDraw: () => { draws += 1 },
    })
    vm.loadProject(project)
    vm.greenFlag()
    draws = 0
    vm.step()
    expect(penClears).toBe(1)
    expect(drawsAtPenClear).toBe(0)
    expect(draws).toBeGreaterThanOrEqual(1)
  })

  it('soft-runs hardware, speech, and face extension blocks through IO facades', () => {
    const project = createDefaultProject()
    project.extensions = ['microbit', 'ev3', 'boost', 'gdxfor', 'speech2text', 'faceSensing']
    const sprite = project.targets[1]!
    sprite.variables.force = ['force', 0]
    sprite.variables.speech = ['speech', '']
    sprite.variables.face = ['face', false]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'displayText', topLevel: true },
      displayText: { opcode: 'microbit_displayText', parent: 'flag', next: 'motor', inputs: { TEXT: [1, [10, 'hi']] } },
      motor: { opcode: 'boost_motorOn', parent: 'displayText', next: 'storeForce' },
      storeForce: { opcode: 'data_setvariableto', parent: 'motor', next: 'storeSpeech', fields: { VARIABLE: ['force', 'force'] }, inputs: { VALUE: [2, 'forceReporter'] } },
      forceReporter: { opcode: 'gdxfor_getForce', parent: 'storeForce' },
      storeSpeech: { opcode: 'data_setvariableto', parent: 'storeForce', next: 'storeFace', fields: { VARIABLE: ['speech', 'speech'] }, inputs: { VALUE: [2, 'speechReporter'] } },
      speechReporter: { opcode: 'speech2text_getSpeech', parent: 'storeSpeech' },
      storeFace: { opcode: 'data_setvariableto', parent: 'storeSpeech', fields: { VARIABLE: ['face', 'face'] }, inputs: { VALUE: [2, 'faceReporter'] } },
      faceReporter: { opcode: 'faceSensing_faceIsDetected', parent: 'storeFace' },
      speechHat: { opcode: 'speech2text_whenIHearHat', next: 'setSpeechHit', topLevel: true, inputs: { PHRASE: [1, [10, 'hello']] } },
      setSpeechHit: { opcode: 'data_setvariableto', parent: 'speechHat', fields: { VARIABLE: ['speech', 'speech'] }, inputs: { VALUE: [1, [10, 'heard']] } },
    }
    const events: string[] = []
    const vm = new ScratchVM()
    vm.on('EXTENSION_DISPLAY', () => events.push('display'))
    vm.on('EXTENSION_ACTUATOR', () => events.push('actuator'))
    vm.loadProject(project)
    vm.postIOData('gdxfor', { force: 77 })
    vm.postIOData('speech', { text: 'hello computer' })
    vm.postIOData('face', { detected: true })
    vm.greenFlag()
    for (let step = 0; step < 4; step += 1) vm.step()
    expect(events).toContain('display')
    expect(events).toContain('actuator')
    expect(vm.getVariableValue('Sprite1', 'force')).toBe(77)
    expect(vm.getVariableValue('Sprite1', 'speech')).toBe('heard')
    expect(vm.getVariableValue('Sprite1', 'face')).toBe(true)
  })

  it('drives fake extension providers across video, speech, hardware, and face reporter matrix', () => {
    const project = createDefaultProject()
    project.extensions = ['videoSensing', 'translate', 'text2speech', 'speech2text', 'microbit', 'ev3', 'wedo2', 'boost', 'gdxfor', 'faceSensing', 'makeymakey']
    const sprite = project.targets[1]!
    const matrix: Array<[string, ScratchBlock]> = [
      ['videoMotion', { opcode: 'videoSensing_videoOn', fields: { ATTRIBUTE: ['motion'] } }],
      ['viewerLanguage', { opcode: 'translate_getViewerLanguage' }],
      ['speechText', { opcode: 'speech2text_getSpeech' }],
      ['microbitButton', { opcode: 'microbit_isButtonPressed' }],
      ['microbitTilt', { opcode: 'microbit_getTiltAngle' }],
      ['ev3Button', { opcode: 'ev3_buttonPressed' }],
      ['ev3Distance', { opcode: 'ev3_getDistance' }],
      ['ev3Brightness', { opcode: 'ev3_getBrightness' }],
      ['ev3Motor', { opcode: 'ev3_getMotorPosition' }],
      ['wedoDistance', { opcode: 'wedo2_getDistance' }],
      ['wedoTilted', { opcode: 'wedo2_isTilted' }],
      ['boostTilted', { opcode: 'boost_isTilted' }],
      ['boostMotor', { opcode: 'boost_getMotorPosition' }],
      ['boostColor', { opcode: 'boost_seeingColor' }],
      ['gdxForce', { opcode: 'gdxfor_getForce' }],
      ['gdxTilt', { opcode: 'gdxfor_getTilt' }],
      ['gdxSpin', { opcode: 'gdxfor_getSpinSpeed' }],
      ['gdxAcceleration', { opcode: 'gdxfor_getAcceleration' }],
      ['gdxFreefall', { opcode: 'gdxfor_isFreeFalling' }],
      ['faceDetected', { opcode: 'faceSensing_faceIsDetected' }],
      ['faceSize', { opcode: 'faceSensing_faceSize' }],
      ['faceTilt', { opcode: 'faceSensing_faceTilt' }],
    ]
    sprite.variables = Object.fromEntries(matrix.map(([name]) => [name, [name, 0]]))
    sprite.variables.hatHits = ['hatHits', 0]
    const blocks: Record<string, ScratchBlock> = {
      flag: { opcode: 'event_whenflagclicked', next: 'voice', topLevel: true },
      voice: { opcode: 'text2speech_setVoice', parent: 'flag', next: 'language', inputs: { VOICE: [1, [10, 'tenor']] } },
      language: { opcode: 'text2speech_setLanguage', parent: 'voice', next: 'display', inputs: { LANGUAGE: [1, [10, 'ja']] } },
      display: { opcode: 'microbit_displayText', parent: 'language', next: 'actuator', inputs: { TEXT: [1, [10, 'ok']] } },
      actuator: { opcode: 'wedo2_motorOn', parent: 'display', next: 'set-videoMotion' },
      videoHat: { opcode: 'videoSensing_whenMotionGreaterThan', next: 'hatChangeVideo', topLevel: true, inputs: { REFERENCE: [1, [4, '10']] } },
      hatChangeVideo: { opcode: 'data_changevariableby', parent: 'videoHat', fields: { VARIABLE: ['hatHits', 'hatHits'] }, inputs: { VALUE: [1, [4, '1']] } },
      faceHat: { opcode: 'faceSensing_whenFaceDetected', next: 'hatChangeFace', topLevel: true },
      hatChangeFace: { opcode: 'data_changevariableby', parent: 'faceHat', fields: { VARIABLE: ['hatHits', 'hatHits'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    for (const [index, [name, reporter]] of matrix.entries()) {
      const setId = `set-${name}`
      const reporterId = `report-${name}`
      blocks[setId] = {
        opcode: 'data_setvariableto',
        parent: index === 0 ? 'actuator' : `set-${matrix[index - 1]![0]}`,
        next: index === matrix.length - 1 ? null : `set-${matrix[index + 1]![0]}`,
        fields: { VARIABLE: [name, name] },
        inputs: { VALUE: [2, reporterId] },
      }
      blocks[reporterId] = { ...reporter, parent: setId }
    }
    sprite.blocks = blocks

    const displayEvents: unknown[] = []
    const actuatorEvents: unknown[] = []
    const vm = new ScratchVM()
    vm.on('EXTENSION_DISPLAY', (event) => displayEvents.push(event))
    vm.on('EXTENSION_ACTUATOR', (event) => actuatorEvents.push(event))
    vm.loadProject(project)
    vm.postIOData('video', { motion: 42, direction: 90 })
    vm.postIOData('user', { language: 'ja-JP' })
    vm.postIOData('speech', { text: 'hello matrix' })
    vm.postIOData('microbit', { buttonPressed: true, tilt: 11 })
    vm.postIOData('ev3', { buttonPressed: true, distance: 9, brightness: 21, motorPosition: 33 })
    vm.postIOData('wedo2', { distance: 15, tilted: true })
    vm.postIOData('boost', { tilted: true, motorPosition: 44, seeingColor: true })
    vm.postIOData('gdxfor', { force: 55, tilt: -10, spinSpeed: 3, acceleration: 4, freeFalling: true })
    vm.postIOData('face', { detected: true, size: 123, tilt: 35 })

    vm.greenFlag()
    for (let step = 0; step < 26; step += 1) vm.step()

    expect(displayEvents).toHaveLength(1)
    expect(actuatorEvents).toHaveLength(1)
    expect(vm.getStage().textToSpeechLanguage).toBe('ja')
    expect(vm.getVariableValue('Sprite1', 'videoMotion')).toBe(42)
    expect(vm.getVariableValue('Sprite1', 'viewerLanguage')).toBe('ja')
    expect(vm.getVariableValue('Sprite1', 'speechText')).toBe('hello matrix')
    expect(vm.getVariableValue('Sprite1', 'microbitButton')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'microbitTilt')).toBe(11)
    expect(vm.getVariableValue('Sprite1', 'ev3Button')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'ev3Distance')).toBe(9)
    expect(vm.getVariableValue('Sprite1', 'ev3Brightness')).toBe(21)
    expect(vm.getVariableValue('Sprite1', 'ev3Motor')).toBe(33)
    expect(vm.getVariableValue('Sprite1', 'wedoDistance')).toBe(15)
    expect(vm.getVariableValue('Sprite1', 'wedoTilted')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'boostTilted')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'boostMotor')).toBe(44)
    expect(vm.getVariableValue('Sprite1', 'boostColor')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'gdxForce')).toBe(55)
    expect(vm.getVariableValue('Sprite1', 'gdxTilt')).toBe(-10)
    expect(vm.getVariableValue('Sprite1', 'gdxSpin')).toBe(3)
    expect(vm.getVariableValue('Sprite1', 'gdxAcceleration')).toBe(4)
    expect(vm.getVariableValue('Sprite1', 'gdxFreefall')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'faceDetected')).toBe(true)
    expect(vm.getVariableValue('Sprite1', 'faceSize')).toBe(123)
    expect(vm.getVariableValue('Sprite1', 'faceTilt')).toBe(35)
    expect(vm.getVariableValue('Sprite1', 'hatHits')).toBe(2)
  })

  it('starts extension hats only on active-state edges', () => {
    const project = createDefaultProject()
    project.extensions = ['microbit']
    const sprite = project.targets[1]!
    sprite.variables.count = ['count', 0]
    sprite.blocks = {
      buttonHat: { opcode: 'microbit_whenButtonPressed', next: 'change', topLevel: true, fields: { BTN: ['A'] } },
      change: { opcode: 'data_changevariableby', parent: 'buttonHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postIOData('microbit', { buttonPressed: true })
    vm.step()
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(1)
    vm.postIOData('microbit', { buttonPressed: false })
    vm.step()
    vm.postIOData('microbit', { buttonPressed: true })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(2)
  })

  it('starts backdrop and greater-than event hats', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.costumes.push({ name: 'night', dataFormat: 'svg' })
    sprite.variables.hit = ['hit', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'switchBackdrop', topLevel: true },
      switchBackdrop: { opcode: 'looks_switchbackdropto', parent: 'flag', fields: { BACKDROP: ['night', 'night'] } },
      backdropHat: { opcode: 'event_whenbackdropswitchesto', next: 'setBackdrop', topLevel: true, fields: { BACKDROP: ['night', 'night'] } },
      setBackdrop: { opcode: 'data_setvariableto', parent: 'backdropHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '1']] } },
      loudHat: { opcode: 'event_whengreaterthan', next: 'setLoud', topLevel: true, fields: { WHENGREATERTHANMENU: ['LOUDNESS'] }, inputs: { VALUE: [1, [4, '20']] } },
      setLoud: { opcode: 'data_setvariableto', parent: 'loudHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '2']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('1')
    vm.postIOData('audio', { loudness: 30 })
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'hit')).toBe('2')
  })

  it('starts greater-than hats only on threshold crossing edges', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.count = ['count', 0]
    sprite.blocks = {
      loudHat: { opcode: 'event_whengreaterthan', next: 'change', topLevel: true, fields: { WHENGREATERTHANMENU: ['LOUDNESS'] }, inputs: { VALUE: [1, [4, '20']] } },
      change: { opcode: 'data_changevariableby', parent: 'loudHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.postIOData('audio', { loudness: 30 })
    vm.step(0)
    vm.step(1)
    vm.step(2)
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(1)
    vm.postIOData('audio', { loudness: 10 })
    vm.step(3)
    vm.postIOData('audio', { loudness: 30 })
    vm.step(4)
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(2)
  })

  it('starts touching-object hats only on contact edges', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 0
    sprite.y = 0
    sprite.variables.count = ['count', 0]
    project.targets.push({
      ...createDefaultProject().targets[1]!,
      id: 'sprite2',
      name: 'Sprite2',
      x: 10,
      y: 0,
      layerOrder: 2,
    })
    sprite.blocks = {
      touchHat: { opcode: 'event_whentouchingobject', next: 'change', topLevel: true, fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
      change: { opcode: 'data_changevariableby', parent: 'touchHat', fields: { VARIABLE: ['count', 'count'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.step()
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(1)
    vm.updateTarget('Sprite2', { x: 220 })
    vm.step()
    vm.updateTarget('Sprite2', { x: 10 })
    vm.step()
    expect(vm.getVariableValue('Sprite1', 'count')).toBe(2)
  })

  it('stores graphic effects and handles edge bounce and rotation style', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 239
    sprite.direction = 90
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setEffect', topLevel: true },
      setEffect: { opcode: 'looks_seteffectto', parent: 'flag', next: 'changeEffect', fields: { EFFECT: ['ghost'] }, inputs: { VALUE: [1, [4, '20']] } },
      changeEffect: { opcode: 'looks_changeeffectby', parent: 'setEffect', next: 'style', fields: { EFFECT: ['ghost'] }, inputs: { CHANGE: [1, [4, '5']] } },
      style: { opcode: 'motion_setrotationstyle', parent: 'changeEffect', next: 'bounce', fields: { STYLE: ['left-right'] } },
      bounce: { opcode: 'motion_ifonedgebounce', parent: 'style' },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.effects?.ghost).toBe(25)
    expect(target.rotationStyle).toBe('left-right')
    expect(target.direction).toBe(-90)
  })

  it('normalizes Scratch graphic effect field names while loading and running', () => {
    const project = createDefaultProject()
    project.targets[1]!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'setEffect', topLevel: true },
      setEffect: { opcode: 'looks_seteffectto', parent: 'flag', next: 'changeEffect', fields: { EFFECT: ['GHOST'] }, inputs: { VALUE: [1, [4, '20']] } },
      changeEffect: { opcode: 'looks_changeeffectby', parent: 'setEffect', fields: { EFFECT: ['BRIGHTNESS'] }, inputs: { CHANGE: [1, [4, '15']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    const loaded = vm.getTarget('Sprite1')!.blocks
    expect(loaded.setEffect?.fields?.EFFECT?.[0]).toBe('ghost')
    expect(loaded.changeEffect?.fields?.EFFECT?.[0]).toBe('brightness')
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.effects?.ghost).toBe(20)
    expect(target.effects?.brightness).toBe(15)
    expect(target.effects?.GHOST).toBeUndefined()
  })

  it('glides incrementally over time before continuing the stack', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 0
    sprite.y = 0
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'glide', topLevel: true },
      glide: { opcode: 'motion_glidesecstoxy', parent: 'flag', next: 'done', inputs: { SECS: [1, [4, '1']], X: [1, [4, '100']], Y: [1, [4, '50']] } },
      done: { opcode: 'data_setvariableto', parent: 'glide', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    expect(vm.getTarget('Sprite1')?.x).toBe(0)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    expect(vm.snapshot().threads[0]?.status).toBe('waiting')
    expect(vm.runtime.isWaitingThread(vm.snapshot().threads[0])).toBe(true)
    vm.step(500)
    expect(vm.getTarget('Sprite1')?.x).toBe(50)
    expect(vm.getTarget('Sprite1')?.y).toBe(25)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    vm.step(1000)
    expect(vm.getTarget('Sprite1')?.x).toBe(100)
    expect(vm.getTarget('Sprite1')?.y).toBe(50)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('1')
  })

  it('resolves costume and backdrop menu values by name, number, and relative options', () => {
    const project = createDefaultProject()
    const stage = project.targets[0]!
    const sprite = project.targets[1]!
    stage.costumes.push({ name: 'night', dataFormat: 'svg' }, { name: 'dawn', dataFormat: 'svg' })
    sprite.costumes.push({ name: 'walk', dataFormat: 'svg' }, { name: 'jump', dataFormat: 'svg' })
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'costumeByNumber', topLevel: true },
      costumeByNumber: { opcode: 'looks_switchcostumeto', parent: 'flag', next: 'costumeNext', inputs: { COSTUME: [1, [4, '2']] } },
      costumeNext: { opcode: 'looks_switchcostumeto', parent: 'costumeByNumber', next: 'backdropByNumber', inputs: { COSTUME: [1, [10, 'next costume']] } },
      backdropByNumber: { opcode: 'looks_switchbackdropto', parent: 'costumeNext', next: 'backdropPrevious', inputs: { BACKDROP: [1, [4, '3']] } },
      backdropPrevious: { opcode: 'looks_switchbackdropto', parent: 'backdropByNumber', inputs: { BACKDROP: [1, [10, 'previous backdrop']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    expect(vm.getTarget('Sprite1')?.costumes[vm.getTarget('Sprite1')!.currentCostume]?.name).toBe('jump')
    expect(vm.getStage().costumes[vm.getStage().currentCostume]?.name).toBe('night')
  })

  it('exposes renderer bounds, picking, touching, and fenced positions', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    project.targets[1]!.x = 0
    project.targets[1]!.y = 0
    project.targets[1]!.size = 100
    project.targets.push({
      ...structuredClone(project.targets[1]!),
      id: 'sprite2',
      name: 'Sprite2',
      x: 15,
      y: 0,
      layerOrder: 2,
    })
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    renderer.requestDraw(vm.snapshot())
    expect(renderer.getBounds('Sprite1')?.width).toBeGreaterThan(0)
    expect(renderer.pick(15, 0)).toBe('sprite2')
    expect(renderer.isTouchingDrawables('Sprite1')).toBe(true)
    expect(renderer.drawableTouchingScratchPoint('Sprite1', 0, 0)).toBe(true)
    expect(renderer.getFencedPositionOfDrawable('Sprite1', [999, 999])).toEqual([222, 162])

    const skinId = renderer.createSVGSkin('<svg></svg>', [48, 48])
    const drawableId = renderer.createDrawable('sprite')
    renderer.updateDrawableSkinId(drawableId, skinId)
    renderer.updateDrawablePosition(drawableId, [0, 0])
    renderer.updateDrawableScale(drawableId, [100, 100])
    expect(renderer.getCurrentSkinSize(drawableId)).toEqual([96, 96])
    expect(renderer.drawableTouchingScratchPoint(drawableId, 0, 0)).toBe(true)
    renderer.updateDrawableVisible(drawableId, false)
    expect(renderer.drawableTouchingScratchPoint(drawableId, 0, 0)).toBe(false)

    const internals = renderer as unknown as {
      canvas?: HTMLCanvasElement
      context?: CanvasRenderingContext2D
      backCanvas?: HTMLCanvasElement
      backContext?: Pick<CanvasRenderingContext2D, 'getImageData'>
    }
    internals.canvas = undefined
    internals.context = undefined
    internals.backCanvas = { width: 480, height: 360 } as HTMLCanvasElement
    internals.backContext = { getImageData: () => ({ data: new Uint8ClampedArray([17, 34, 51, 255]) }) as ImageData }
    expect(renderer.sampleColor(0, 0)).toEqual({ r: 17, g: 34, b: 51, a: 255 })
  })

  it('clears renderer costume caches when projects are replaced', async () => {
    const vm = new ScratchVM()
    let clears = 0
    vm.attachRenderer({ clearCachedCostumes: () => { clears += 1 } })

    await vm.loadProject(createDefaultProject())
    vm.clear()

    expect(clears).toBe(2)
  })

  it('releases cached costume object URLs and image bitmaps', () => {
    const originalUrl = globalThis.URL
    const revoked: string[] = []
    globalThis.URL = Object.assign(function URLMock() {} as unknown as typeof URL, originalUrl, {
      revokeObjectURL: (url: string) => {
        revoked.push(url)
      },
    })
    try {
      const renderer = new ScratchCanvasRenderer()
      const first = { closeCalls: 0, close() { this.closeCalls += 1 } }
      const second = { closeCalls: 0, close() { this.closeCalls += 1 } }
      const internals = renderer as unknown as {
        costumeImages: Map<string, { status: 'ready'; image?: ImageBitmap; objectUrl?: string }>
      }

      renderer.cacheCostumeImage('asset', 'png', first as unknown as ImageBitmap)
      renderer.cacheCostumeImage('asset', 'png', second as unknown as ImageBitmap)
      internals.costumeImages.set('url-asset:svg', { status: 'ready', objectUrl: 'blob:old' })
      renderer.clearCachedCostumes()

      expect(first.closeCalls).toBe(1)
      expect(second.closeCalls).toBe(1)
      expect(revoked).toEqual(['blob:old'])
      expect(internals.costumeImages.size).toBe(0)
    } finally {
      globalThis.URL = originalUrl
    }
  })

  it('draws oversized stage SVG backdrops at project scale instead of fitting them to the stage', () => {
    const originalImage = globalThis.Image
    globalThis.Image = class {} as typeof Image
    try {
      const project = createDefaultProject()
      const stage = project.targets[0]!
      stage.costumes = [{
        name: 'large backdrop',
        assetId: 'large-backdrop',
        md5ext: 'large-backdrop.svg',
        dataFormat: 'svg',
        rotationCenterX: 480,
        rotationCenterY: 360,
      }]
      project.targets[1]!.visible = false
      const vm = new ScratchVM()
      vm.loadProject(project)
      const renderer = new ScratchCanvasRenderer()
      const drawImageCalls: unknown[][] = []
      const scaleCalls: unknown[][] = []
      const context = {
        clearRect: () => undefined,
        fillRect: () => undefined,
        save: () => undefined,
        restore: () => undefined,
        scale: (...args: unknown[]) => scaleCalls.push(args),
        drawImage: (...args: unknown[]) => drawImageCalls.push(args),
      } as unknown as CanvasRenderingContext2D
      const internals = renderer as unknown as {
        canvas: HTMLCanvasElement
        context: CanvasRenderingContext2D
        costumeImages: Map<string, { status: 'ready'; image: HTMLImageElement }>
      }
      internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
      internals.context = context
      internals.costumeImages.set('large-backdrop.svg:svg', {
        status: 'ready',
        image: { naturalWidth: 960, naturalHeight: 720 } as HTMLImageElement,
      })

      renderer.requestDraw(vm.snapshot())

      expect(scaleCalls).toContainEqual([1, 1])
      expect(drawImageCalls[0]?.slice(1)).toEqual([-240, -180, 960, 720])
    } finally {
      globalThis.Image = originalImage
    }
  })

  it('draws viewBox-only SVG costumes using their rotation center size', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [{
      name: 'button',
      assetId: 'button',
      md5ext: 'button.svg',
      dataFormat: 'svg',
      rotationCenterX: 46.5,
      rotationCenterY: 20.5,
    }]
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    const drawImageCalls: unknown[][] = []
    const context = {
      beginPath: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      lineTo: () => undefined,
      moveTo: () => undefined,
      restore: () => undefined,
      rotate: () => undefined,
      save: () => undefined,
      scale: () => undefined,
      setLineDash: () => undefined,
      stroke: () => undefined,
      strokeRect: () => undefined,
      translate: () => undefined,
      drawImage: (...args: unknown[]) => drawImageCalls.push(args),
    } as unknown as CanvasRenderingContext2D
    const internals = renderer as unknown as {
      canvas: HTMLCanvasElement
      context: CanvasRenderingContext2D
      costumeImages: Map<string, { status: 'ready'; image: HTMLImageElement }>
    }
    internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
    internals.context = context
    internals.costumeImages.set('button.svg:svg', {
      status: 'ready',
      image: { naturalWidth: 300, naturalHeight: 132 } as HTMLImageElement,
    })

    renderer.requestDraw(vm.snapshot())

    expect(drawImageCalls[0]?.slice(1)).toEqual([-46.5, -20.5, 93, 41])
  })

  it('starts loading every costume in the snapshot before it is selected', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [
      {
        name: 'ready',
        assetId: 'ready',
        md5ext: 'ready.svg',
        dataFormat: 'svg',
        rotationCenterX: 40,
        rotationCenterY: 30,
      },
      {
        name: 'loading',
        assetId: 'loading',
        md5ext: 'loading.svg',
        dataFormat: 'svg',
        rotationCenterX: 60,
        rotationCenterY: 20,
      },
    ]
    sprite.currentCostume = 0
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    const requested: string[] = []
    const internals = renderer as unknown as {
      costumeImages: Map<string, { status: 'loading' | 'ready'; image?: HTMLImageElement }>
    }
    renderer.setAssetResolver((assetId) => {
      requested.push(assetId)
      return new Promise(() => undefined)
    })

    renderer.requestDraw(vm.snapshot())

    expect(requested).toContain('ready.svg')
    expect(requested).toContain('loading.svg')
    expect(internals.costumeImages.get('ready.svg:svg')?.status).toBe('loading')
    expect(internals.costumeImages.get('loading.svg:svg')?.status).toBe('loading')
  })

  it('draws pen lines for hidden sprites', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.visible = false
    sprite.penLines = [{ x1: -10, y1: -10, x2: 10, y2: 10, color: '#ff0000', size: 4, transparency: 0 }]
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    const strokes: Array<{ strokeStyle: string; lineWidth: number }> = []
    let strokeStyle = ''
    let lineWidth = 0
    const context = {
      get strokeStyle() {
        return strokeStyle
      },
      set strokeStyle(value: string) {
        strokeStyle = value
      },
      get lineWidth() {
        return lineWidth
      },
      set lineWidth(value: number) {
        lineWidth = value
      },
      clearRect: () => undefined,
      fillRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      stroke: () => strokes.push({ strokeStyle, lineWidth }),
    } as unknown as CanvasRenderingContext2D
    const internals = renderer as unknown as {
      canvas: HTMLCanvasElement
      context: CanvasRenderingContext2D
    }
    internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
    internals.context = context

    renderer.requestDraw(vm.snapshot())

    expect(strokes).toContainEqual({ strokeStyle: '#ff0000', lineWidth: 4 })
  })

  it('waits for play sound until done and resolves sound menu numbers', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.sounds = [
      { name: 'short', dataFormat: 'wav', rate: 1000, sampleCount: 2 },
      { name: 'long', dataFormat: 'wav', rate: 1000, sampleCount: 50 },
    ]
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'sound', topLevel: true },
      sound: { opcode: 'sound_playuntildone', parent: 'flag', next: 'set', inputs: { SOUND_MENU: [1, [4, '2']] } },
      set: { opcode: 'data_setvariableto', parent: 'sound', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const played: string[] = []
    const vm = new ScratchVM()
    vm.attachAudioEngine({ playSound: (_target: string, sound: { name: string }) => played.push(sound.name) })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    expect(played).toEqual(['long'])
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    vm.step(60)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('1')
  })

  it('unblocks play-sound-until-done when another script stops all sounds', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.sounds = [{ name: 'long', dataFormat: 'wav', rate: 1000, sampleCount: 1000 }]
    sprite.variables.done = ['done', 0]
    sprite.blocks = {
      flagSound: { opcode: 'event_whenflagclicked', next: 'sound', topLevel: true },
      sound: { opcode: 'sound_playuntildone', parent: 'flagSound', next: 'set', inputs: { SOUND_MENU: [1, [10, 'long']] } },
      set: { opcode: 'data_setvariableto', parent: 'sound', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [4, '1']] } },
      flagStop: { opcode: 'event_whenflagclicked', next: 'stopSounds', topLevel: true },
      stopSounds: { opcode: 'sound_stopallsounds', parent: 'flagStop' },
    }
    const stopped: string[] = []
    const vm = new ScratchVM()
    vm.attachAudioEngine({
      playSound: () => undefined,
      stopAllSounds: () => stopped.push('all'),
    })
    vm.loadProject(project)
    vm.greenFlag()
    vm.step(0)
    expect(stopped).toEqual(['all', 'all'])
    expect(vm.getVariableValue('Sprite1', 'done')).toBe(0)
    vm.step(1)
    expect(vm.getVariableValue('Sprite1', 'done')).toBe('1')
  })

  it('normalizes sound effects and returns a restore callback when deleting sounds', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.sounds = [{ name: 'pop', dataFormat: 'wav', rate: 44100, sampleCount: 1 }]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'pitch', topLevel: true },
      pitch: { opcode: 'sound_seteffectto', parent: 'flag', next: 'pan', fields: { EFFECT: ['PITCH'] }, inputs: { VALUE: [1, [4, '999']] } },
      pan: { opcode: 'sound_seteffectto', parent: 'pitch', fields: { EFFECT: ['PAN'] }, inputs: { VALUE: [1, [4, '-999']] } },
    }
    vm.loadProject(project)
    vm.greenFlag()
    vm.step()
    const target = vm.getTarget('Sprite1')!
    expect(target.soundEffects?.pitch).toBe(360)
    expect(target.soundEffects?.pan).toBe(-100)
    const restore = vm.deleteSound('Sprite1', 0)
    expect(vm.getTarget('Sprite1')?.sounds).toHaveLength(0)
    restore?.()
    expect(vm.getTarget('Sprite1')?.sounds[0]?.name).toBe('pop')
  })

  it('preserves selected costume identity when reordering costumes', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [
      { name: 'a', dataFormat: 'svg' },
      { name: 'b', dataFormat: 'svg' },
      { name: 'c', dataFormat: 'svg' },
    ]
    sprite.currentCostume = 1
    vm.loadProject(project)
    vm.reorderCostume('Sprite1', 0, 2)
    const target = vm.getTarget('Sprite1')!
    expect(target.costumes[target.currentCostume]?.name).toBe('b')
  })

  it('preserves selected costume identity when deleting another costume', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [
      { name: 'a', dataFormat: 'svg' },
      { name: 'b', dataFormat: 'svg' },
      { name: 'c', dataFormat: 'svg' },
    ]
    sprite.currentCostume = 1
    vm.loadProject(project)
    vm.deleteCostume('Sprite1', 0)
    const target = vm.getTarget('Sprite1')!
    expect(target.currentCostume).toBe(0)
    expect(target.costumes[target.currentCostume]?.name).toBe('b')
  })

  it('keeps the editing target when deleting another sprite', () => {
    const vm = new ScratchVM()
    const sprite2 = vm.addSprite('Sprite2')
    vm.selectTarget(sprite2.id ?? sprite2.name)
    vm.deleteTarget('Sprite1')
    expect(vm.getSelectedTarget().name).toBe('Sprite2')
    expect(vm.snapshot().selectedTargetId).toBe(sprite2.id ?? sprite2.name)
  })

  it('updates sprite-name menu references when renaming sprites', () => {
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    project.targets.push({
      ...structuredClone(sprite),
      id: 'sprite2',
      name: 'Sprite2',
      blocks: {},
      variables: {},
      lists: {},
      layerOrder: 2,
    })
    sprite.blocks = {
      point: { opcode: 'motion_pointtowards', inputs: { TOWARDS: [1, [10, 'Sprite2']] } },
      goto: { opcode: 'motion_goto', inputs: { TO: [1, [10, 'Sprite2']] } },
      touching: { opcode: 'sensing_touchingobject', fields: { TOUCHINGOBJECTMENU: ['Sprite2', 'Sprite2'] } },
      distance: { opcode: 'sensing_distanceto', fields: { DISTANCETOMENU: ['Sprite2', 'Sprite2'] } },
      of: { opcode: 'sensing_of', fields: { PROPERTY: ['x position'], OBJECT: ['Sprite2'] } },
      clone: { opcode: 'control_create_clone_of', inputs: { CLONE_OPTION: [1, [10, 'Sprite2']] } },
    }
    const vm = new ScratchVM()
    vm.loadProject(project)
    expect(vm.renameSprite('Sprite2', 'Enemy')).toBe(true)
    const blocks = vm.getTarget('Sprite1')!.blocks
    expect(blocks.point?.inputs?.TOWARDS?.[1]).toEqual([10, 'Enemy'])
    expect(blocks.goto?.inputs?.TO?.[1]).toEqual([10, 'Enemy'])
    expect(blocks.touching?.fields?.TOUCHINGOBJECTMENU).toEqual(['Enemy', 'Enemy'])
    expect(blocks.distance?.fields?.DISTANCETOMENU).toEqual(['Enemy', 'Enemy'])
    expect(blocks.of?.fields?.OBJECT).toEqual(['Enemy'])
    expect(blocks.clone?.inputs?.CLONE_OPTION?.[1]).toEqual([10, 'Enemy'])
  })

  it('shares blocks with fresh ids and remapped references', () => {
    const vm = new ScratchVM()
    const project = createDefaultProject()
    const source = project.targets[1]!
    project.targets.push({
      ...structuredClone(source),
      id: 'sprite2',
      name: 'Sprite2',
      blocks: {
        flag: { opcode: 'event_whenflagclicked', topLevel: true, next: null, parent: null },
      },
      variables: {},
      lists: {},
      layerOrder: 2,
    })
    source.variables.score = ['score', 0]
    source.blocks = {
      flag: { opcode: 'event_whenflagclicked', topLevel: true, next: 'set', parent: null, x: 10, y: 20 },
      set: { opcode: 'data_setvariableto', parent: 'flag', next: null, fields: { VARIABLE: ['score', 'score'] }, inputs: { VALUE: [1, 'literal'] } },
      literal: { opcode: 'math_number', parent: 'set', fields: { NUM: ['1'] } },
    }
    vm.loadProject(project)
    vm.shareBlocksToTarget(source.blocks, 'Sprite2', 'Sprite1')
    const target = vm.getTarget('Sprite2')!
    expect(target.blocks.flag?.opcode).toBe('event_whenflagclicked')
    const sharedHat = Object.entries(target.blocks).find(([id, block]) => id !== 'flag' && block.opcode === 'event_whenflagclicked')
    expect(sharedHat).toBeTruthy()
    const [hatId, hat] = sharedHat!
    expect(hatId).not.toBe('flag')
    expect(hat.next).toBeTruthy()
    expect(hat.next).not.toBe('set')
    const sharedSet = target.blocks[String(hat.next)]
    expect(sharedSet?.parent).toBe(hatId)
    expect(sharedSet?.inputs?.VALUE?.[1]).not.toBe('literal')
    expect(target.variables.score?.slice(0, 2)).toEqual(['score', 0])
  })

  it('supports Scratch VM event-emitter facade aliases on vm and runtime', () => {
    const vm = new ScratchVM()
    let projectChanged = 0
    let runtimeStarted = 0
    const onProjectChanged = () => {
      projectChanged += 1
    }
    vm.addListener('PROJECT_CHANGED', onProjectChanged)
    vm.emitProjectChanged()
    expect(projectChanged).toBe(1)
    vm.removeListener('PROJECT_CHANGED', onProjectChanged)
    vm.emitProjectChanged()
    expect(projectChanged).toBe(1)
    vm.runtime.once('RUNTIME_STARTED', () => {
      runtimeStarted += 1
    })
    vm.runtime.start()
    vm.runtime.start()
    expect(runtimeStarted).toBe(1)
    vm.runtime.addListener('PROJECT_CHANGED', onProjectChanged)
    vm.runtime.removeAllListeners('PROJECT_CHANGED')
    vm.emitProjectChanged()
    expect(projectChanged).toBe(1)
  })

  it('supports Scratch VM promise loading, editingTarget property, and compiler options', async () => {
    const vm = new ScratchVM()
    const loaded = await vm.loadProject(createDefaultProject())
    expect(loaded.targets[1]?.name).toBe('Sprite1')
    vm.editingTarget = vm.getStage()
    expect(vm.editingTarget?.isStage).toBe(true)
    vm.editingTarget = 'Sprite1'
    expect(vm.editingTarget?.name).toBe('Sprite1')
    vm.editingTarget = null
    expect(vm.getEditingTarget()?.isStage).toBe(true)
    vm.runtime.setEditingTarget('Sprite1')
    expect(vm.runtime.getEditingTarget()?.name).toBe('Sprite1')
    vm.runtime.setEditingTarget(undefined)
    expect(vm.runtime.getEditingTarget()?.isStage).toBe(true)
    vm.setCompilerOptions({ enabled: true, warpTimer: 500 })
    expect(vm.getCompilerOptions()).toEqual({ enabled: true, warpTimer: 500 })
  })
})
