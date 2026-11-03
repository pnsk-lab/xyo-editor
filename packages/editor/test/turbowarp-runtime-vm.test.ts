import { describe, expect, test } from 'bun:test'
import { strFromU8, unzipSync } from 'fflate'
import { TurboWarpRuntimeVM, type TurboWarpRuntimeEngine } from '../src/lib/turbowarp-runtime-vm'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function engine(load: () => Promise<void> = async () => {}) {
  const calls: string[] = []
  const vm: TurboWarpRuntimeEngine = {
    runtime: { targets: [] },
    async loadProject(bytes) {
      expect(bytes[0]).toBe(0x50)
      calls.push('load')
      await load()
    },
    greenFlag() {
      calls.push('flag')
    },
    stopAll() {
      calls.push('stop')
    },
    postIOData(device) {
      calls.push(device)
    },
    setTurboMode() {},
  }
  return { vm, calls }
}

describe('TurboWarpRuntimeVM', () => {
  test('routes hats and target stops with detached results and explicit limitations', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const sprite = adapter.model.exportProject().targets.find((t) => !t.isStage)!
    const tw = {
      id: 'tw',
      isOriginal: true,
      sprite: { name: sprite.name },
      variables: {},
      blocks: { _blocks: {} },
    }
    e.vm.runtime.targets.push(
      {
        id: 'stage',
        isStage: true,
        isOriginal: true,
        sprite: { name: 'Stage' },
        variables: {},
        blocks: { _blocks: {} },
      },
      tw,
    )
    const calls: unknown[] = []
    Object.assign(e.vm.runtime, {
      startHats(opcode: string, fields: Record<string, unknown>, target: unknown) {
        calls.push([opcode, { ...fields }, target])
        fields.KEY = 'MUTATED'
        return opcode === 'unknown'
          ? undefined
          : [{ target: tw, topBlock: 'hat', stack: ['next'], status: 0 }]
      },
      stopForTarget(target: unknown) {
        calls.push(target)
      },
    })
    expect(() => adapter.vm.startHats('event_whenkeypressed')).toThrow('not synchronized')
    await adapter.syncProject()
    const fields = { KEY: 'space' }
    expect(adapter.vm.runtime.startHats('event_whenkeypressed', fields, sprite.id!)).toEqual([
      { targetName: sprite.name, topBlockId: 'hat', currentBlockId: 'next', status: 'running' },
    ])
    expect(fields.KEY).toBe('space')
    expect(calls[0]).toEqual(['event_whenkeypressed', { KEY: 'space' }, tw])
    expect(() => adapter.vm.startHats('unknown')).toThrow('does not recognize')
    expect(() => adapter.vm.startHats('x', { KEY: 1 })).toThrow('must be strings')
    expect(() => adapter.vm.stopForTarget('missing')).toThrow('cannot be mapped')
    adapter.vm.runtime.stopForTarget(sprite.id!)
    expect(calls.at(-1)).toBe(tw)
    e.vm.runtime.targets.push({ id: 'clone', isOriginal: false, sprite: tw.sprite })
    expect(() => adapter.vm.stopForTarget(sprite.id!)).toThrow('clone removal')
    adapter.dispose()
  })
  test('routes block clicks to mapped TW targets and forwards reports only while current', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const sprite = adapter.model.exportProject().targets.find((t) => !t.isStage)!
    const listeners = new Set<(...args: unknown[]) => void>()
    const calls: unknown[] = []
    const target = {
      id: 'tw',
      isOriginal: true,
      sprite: { name: sprite.name },
      variables: {},
      blocks: { _blocks: {}, getBlock: (id: string) => (id === 'block' ? {} : null) },
    }
    Object.assign(e.vm.runtime, {
      targets: [
        {
          id: 'stage',
          isStage: true,
          isOriginal: true,
          sprite: { name: 'Stage' },
          variables: {},
          blocks: { _blocks: {} },
        },
        target,
      ],
      on: (_event: string, listener: (...args: unknown[]) => void) => listeners.add(listener),
      removeListener: (_event: string, listener: (...args: unknown[]) => void) =>
        listeners.delete(listener),
      setEditingTarget: (value: unknown) => calls.push(value),
      toggleScript: (id: string, options: unknown) => calls.push([id, options]),
    })
    expect(() => adapter.vm.toggleScript('block', sprite.id!)).toThrow('not synchronized')
    await adapter.syncProject()
    const reports: unknown[] = []
    adapter.vm.on('VISUAL_REPORT', (value) => reports.push(value))
    expect(adapter.vm.toggleScript('block', sprite.id!)).toBeUndefined()
    expect(adapter.vm.reportBlockValue('block', sprite.id!)).toBeUndefined()
    expect(calls).toEqual([
      target,
      ['block', { target, stackClick: true }],
      target,
      ['block', { target, stackClick: true }],
    ])
    const old = [...listeners][0]
    old({ id: 'block', value: '42' })
    expect(reports).toEqual([{ id: 'block', value: '42' }])
    expect(() => adapter.vm.reportBlockValue('missing', sprite.id!)).toThrow('block not found')
    adapter.model.emit('PROJECT_CHANGED', {})
    expect(listeners.size).toBe(0)
    old({ id: 'block', value: 'stale' })
    expect(reports).toHaveLength(1)
    await adapter.syncProject()
    adapter.vm.reportBlockValue('block', sprite.id!)
    expect(listeners.size).toBe(1)
    adapter.dispose()
    expect(listeners.size).toBe(0)
  })

  test('converts Scratch special key names to DOM keyboard keys', () => {
    const e = engine()
    const keys: unknown[] = []
    e.vm.postIOData = (device, data) => {
      if (device === 'keyboard') keys.push((data as { key: unknown }).key)
    }
    const adapter = new TurboWarpRuntimeVM(e.vm)
    for (const key of ['space', 'left arrow', 'up arrow', 'right arrow', 'down arrow', 'a'])
      adapter.vm.postKeyboard({ key, isDown: true })
    expect(keys).toEqual([' ', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'a'])
    adapter.dispose()
  })

  test('captures an SB3 and starts the injected engine', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    adapter.vm.greenFlag()
    await adapter.settled()
    adapter.vm.postMouse({ x: 1 })
    expect(e.calls).toEqual(['stop', 'load', 'flag', 'mouse'])
    expect(() => adapter.vm.step()).toThrow('does not support single-frame stepping')
  })

  test('steps a synchronized TurboWarp frame and restores its scheduler', async () => {
    const e = engine()
    const calls: string[] = []
    const loop = {
      running: true,
      stop() {
        calls.push('stop')
        this.running = false
      },
      start() {
        calls.push('start')
        this.running = true
      },
      stepCallback() {
        calls.push('frame')
      },
    }
    Object.assign(e.vm.runtime, { frameLoop: loop })
    const adapter = new TurboWarpRuntimeVM(e.vm)
    expect(() => adapter.vm.step()).toThrow('not synchronized')
    await adapter.syncProject()
    let frames = 0
    adapter.vm.on('RUNTIME_STEP', () => {
      frames++
    })
    adapter.vm.step()
    expect(calls).toEqual(['stop', 'frame', 'start'])
    expect(frames).toBe(1)
    adapter.dispose()
  })

  test('reports inputs and invalidates an in-flight run on editing', async () => {
    const loading = deferred(),
      entered = deferred()
    const e = engine(async () => {
      entered.resolve()
      await loading.promise
    })
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const errors: string[] = []
    adapter.model.on<{ message: string }>('ERROR', (event) => errors.push(event.message))
    adapter.vm.greenFlag()
    await entered.promise
    adapter.vm.postMouse({ x: 1 })
    adapter.model.emit('PROJECT_CHANGED', {})
    loading.resolve()
    await expect(adapter.settled()).rejects.toThrow('invalidated')
    expect(errors.some((message) => message.includes('input'))).toBe(true)
    expect(errors.some((message) => message.includes('invalidated'))).toBe(true)
    expect(e.calls).not.toContain('flag')
  })

  test('serializes loads and preserves a later run after stop', async () => {
    const loading = deferred(),
      entered = deferred()
    let n = 0
    const e = engine(async () => {
      if (++n === 1) {
        entered.resolve()
        await loading.promise
      }
    })
    const adapter = new TurboWarpRuntimeVM(e.vm)
    adapter.vm.greenFlag()
    await entered.promise
    const first = adapter.settled()
    adapter.vm.stopAll()
    adapter.vm.greenFlag()
    const second = adapter.settled()
    loading.resolve()
    await expect(first).rejects.toThrow('superseded')
    await second
    expect(e.calls.filter((c) => c === 'load')).toHaveLength(2)
    expect(e.calls.filter((c) => c === 'flag')).toHaveLength(1)
  })

  test('syncProject loads without starting scripts and notifies the host', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    let synced = 0
    adapter.model.on('TURBOWARP_PROJECT_SYNCED', () => {
      synced++
    })
    await adapter.syncProject()
    expect(e.calls).toEqual(['stop', 'load'])
    expect(synced).toBe(1)
  })

  test('forwards live snapshots without replacing edited blocks and rejects stale frames', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const original = project.targets.find((t) => !t.isStage)!
    original.blocks.editable = {
      opcode: 'motion_movesteps',
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    }
    await adapter.model.loadProject(project)
    const stage = project.targets.find((t) => t.isStage)!
    e.vm.runtime.targets.push({
      id: stage.id,
      isOriginal: true,
      isStage: true,
      sprite: { name: stage.name, costumes: [], sounds: [] },
      variables: {},
      blocks: { _blocks: {} },
    })
    e.vm.runtime.targets.push({
      id: 'tw-sprite-id',
      isOriginal: true,
      isStage: false,
      x: 123,
      y: 20,
      sprite: { name: original.name, costumes: [], sounds: [] },
      variables: {},
      blocks: { _blocks: {} },
    })
    const received: number[] = []
    adapter.vm.on<any>('RUNTIME_STEP', (snapshot) =>
      received.push(snapshot.project.targets.find((t: any) => t.id === original.id).x),
    )
    adapter.vm.greenFlag()
    await adapter.settled()
    const revision = adapter.revision
    expect(adapter.notifyFrame(revision)).toBe(true)
    const snap = adapter.vm.snapshot()
    expect(received).toEqual([123])
    expect(snap.project.targets.find((t) => t.id === original.id)?.blocks.editable).toBeDefined()
    expect(adapter.vm.getTarget(original.id!)?.x).toBe(123)
    expect(adapter.vm.getSelectedTarget().x).toBe(123)
    expect(adapter.vm.getEditingTarget().x).toBe(123)
    expect(adapter.vm.editingTarget?.x).toBe(123)
    expect(adapter.vm.getSpriteTargetByName(original.name)?.x).toBe(123)
    expect(adapter.vm.getStage().isStage).toBe(true)
    adapter.vm.editingTarget = stage.id!
    expect(adapter.vm.editingTarget?.id).toBe(stage.id)
    adapter.vm.editingTarget = original.id!
    const files = unzipSync(await adapter.vm.saveProjectSb3())
    const saved = JSON.parse(strFromU8(files['project.json']))
    expect(saved.targets.find((t: any) => t.id === original.id).x).toBe(123)
    expect(saved.targets.find((t: any) => t.id === original.id).blocks.editable).toBeDefined()
    expect(adapter.model.snapshot().project.targets.find((t) => t.id === original.id)?.x).not.toBe(
      123,
    )
    adapter.model.emit('PROJECT_CHANGED', {})
    expect(adapter.notifyFrame(revision)).toBe(false)
    expect(adapter.vm.snapshot().project.targets.find((t) => t.id === original.id)?.x).toBe(123)
  })

  test('exports live sprites with model assets and restores a deleted sprite across events', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((t) => !t.isStage)!,
      stage = project.targets.find((t) => t.isStage)!
    e.vm.runtime.targets.push({
      id: 'stage',
      isOriginal: true,
      isStage: true,
      sprite: { name: stage.name },
      variables: {},
      blocks: { _blocks: {} },
    })
    const runtimeSprite = {
      id: 'tw',
      isOriginal: true,
      x: 123,
      y: 45,
      sprite: { name: sprite.name },
      variables: {},
      blocks: { _blocks: {} },
    }
    e.vm.runtime.targets.push(runtimeSprite)
    adapter.vm.greenFlag()
    await adapter.settled()
    const modelFiles = unzipSync(await adapter.model.saveSpriteSb3(sprite.id!))
    const exported = unzipSync(await adapter.vm.exportSprite(sprite.name))
    expect(JSON.parse(strFromU8(exported['sprite.json'])).x).toBe(123)
    for (const name of Object.keys(modelFiles).filter((name) => name !== 'sprite.json'))
      expect(exported[name]).toEqual(modelFiles[name])
    expect(Object.keys(modelFiles).length).toBeGreaterThan(1)
    await expect(adapter.vm.saveSpriteSb3(stage.id!)).rejects.toThrow('Cannot export sprite')
    await expect(adapter.vm.exportSprite('missing')).rejects.toThrow('Cannot export sprite')
    const gate = deferred()
    const save = adapter.model.saveSpriteSb3.bind(adapter.model)
    adapter.model.saveSpriteSb3 = async (id) => {
      const bytes = await save(id)
      await gate.promise
      return bytes
    }
    const archive = adapter.vm.saveSpriteSb3()
    runtimeSprite.x = 999
    const revision = adapter.revision
    const events: string[] = []
    adapter.vm.on('PROJECT_CHANGED', () => events.push('changed'))
    adapter.vm.on('TARGETS_UPDATE', () => events.push('targets'))
    adapter.vm.deleteTarget(sprite.id!)
    expect(adapter.notifyFrame(revision)).toBe(false)
    gate.resolve()
    const bytes = await archive
    expect(JSON.parse(strFromU8(unzipSync(bytes)['sprite.json'])).x).toBe(123)
    const restored = adapter.vm.importSprite(bytes)
    expect(restored?.x).toBe(123)
    expect(restored?.y).toBe(45)
    expect(events).toContain('changed')
    expect(events).toContain('targets')
    const restoredFiles = unzipSync(await adapter.vm.saveSpriteSb3(restored!.id!))
    for (const name of Object.keys(modelFiles).filter((name) => name !== 'sprite.json'))
      expect(restoredFiles[name]).toEqual(modelFiles[name])
    adapter.dispose()
  })

  test('merges only unedited live fields after edits, preserving code and assets', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((t) => !t.isStage)!
    const stage = project.targets.find((t) => t.isStage)!
    sprite.variables = { a: ['a', 1], b: ['b', 2], missing: ['missing', 42] }
    await adapter.model.loadProject(project)
    const assetsBefore = unzipSync(await adapter.model.saveProjectSb3())
    e.vm.runtime.targets.push({
      id: 'stage',
      isOriginal: true,
      isStage: true,
      sprite: { name: stage.name, costumes: [], sounds: [] },
      variables: {},
      blocks: { _blocks: {} },
    })
    e.vm.runtime.targets.push({
      id: 'tw',
      isOriginal: true,
      x: 123,
      y: 77,
      sprite: { name: sprite.name, costumes: [], sounds: [] },
      variables: { a: { name: 'a', value: 10 }, b: { name: 'b', value: 20 } },
      blocks: { _blocks: {} },
    })
    adapter.vm.greenFlag()
    await adapter.settled()
    let notifications = 0
    adapter.model.on('PROJECT_CHANGED', () => {
      notifications++
    })
    const edited = adapter.model.getTarget(sprite.id!)!
    edited.x = 999
    edited.variables.a[1] = 555
    edited.blocks.myEdit = {
      opcode: 'motion_movesteps',
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    }
    adapter.model.emit('PROJECT_CHANGED', {})
    const result = adapter.model.getTarget(sprite.id!)!
    expect(result.x).toBe(999)
    expect(result.y).toBe(77)
    expect(result.variables.a[1]).toBe(555)
    expect(result.variables.b[1]).toBe(20)
    expect(result.variables.missing[1]).toBe(42)
    expect(result.blocks.myEdit).toBeDefined()
    expect(notifications).toBe(2)
    const assetsAfter = unzipSync(await adapter.model.saveProjectSb3())
    for (const name of Object.keys(assetsBefore).filter((name) => name !== 'project.json'))
      expect(assetsAfter[name]).toEqual(assetsBefore[name])
    expect(adapter.model.snapshot().running).toBe(false)
    expect(adapter.model.snapshot().threads).toEqual([])
  })

  test('merges monitor changes on invalidation without losing explicit edits or identities', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const monitor = (id: string, visible = true) => ({
      id,
      opcode: `custom_${id}`,
      mode: 'default',
      params: {},
      visible,
      value: 0,
    })
    project.monitors = [
      monitor('a'),
      monitor('b'),
      monitor('deleted'),
      monitor('runtime-deleted'),
      monitor('incompatible'),
    ]
    await adapter.model.loadProject(project)
    const state = new Map<string, unknown>()
    Object.assign(e.vm.runtime, { _monitorState: { map: state } })
    for (const m of [
      monitor('a', false),
      { ...monitor('b', false), value: 42 },
      monitor('deleted'),
      monitor('new'),
      { ...monitor('incompatible'), opcode: 'sensing_answer' },
    ])
      state.set(m.id, m)
    await adapter.syncProject()
    const modelProject = (adapter.model as any).project
    modelProject.monitors = modelProject.monitors.filter((m: { id: string }) => m.id !== 'deleted')
    modelProject.monitors.find((m: { id: string }) => m.id === 'b').visible = false
    modelProject.monitors.find((m: { id: string }) => m.id === 'b').mode = 'large'
    modelProject.monitors.push(monitor('edited-new'))
    adapter.model.emit('PROJECT_CHANGED', {})
    const result = adapter.model.snapshot().project.monitors
    expect(result.find((m) => m.id === 'a')?.visible).toBe(false)
    expect(result.find((m) => m.id === 'b')).toMatchObject({
      visible: false,
      mode: 'large',
      value: 42,
    })
    expect(result.some((m) => m.id === 'deleted' || m.id === 'runtime-deleted')).toBe(false)
    expect(result.find((m) => m.id === 'incompatible')?.opcode).toBe('custom_incompatible')
    expect(result.some((m) => m.id === 'edited-new')).toBe(true)
    expect(result.some((m) => m.id === 'new')).toBe(true)
    adapter.dispose()
  })

  test('keeps monitors when runtime IDs are incompatible or monitor state is unavailable', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    project.monitors = [
      { id: 'editor-id', opcode: 'sensing_timer', mode: 'default', params: {}, visible: true },
    ]
    await adapter.model.loadProject(project)
    Object.assign(e.vm.runtime, {
      _monitorState: {
        map: new Map([['tw-id', { ...project.monitors[0], id: 'tw-id', visible: false }]]),
      },
    })
    await adapter.syncProject()
    adapter.model.emit('PROJECT_CHANGED', {})
    expect(adapter.model.snapshot().project.monitors.map((m) => m.id)).toEqual(['editor-id'])
    delete (e.vm.runtime as any)._monitorState
    await adapter.syncProject()
    adapter.vm.stopAll()
    expect(adapter.model.snapshot().project.monitors.map((m) => m.id)).toEqual(['editor-id'])
    adapter.dispose()
  })

  test('snapshot listeners see the merged state after nested edit notifications', async () => {
    const e = engine(),
      adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((t) => !t.isStage)!,
      stage = project.targets.find((t) => t.isStage)!
    e.vm.runtime.targets.push({
      id: 'stage',
      isOriginal: true,
      isStage: true,
      sprite: { name: stage.name },
      variables: {},
      blocks: { _blocks: {} },
    })
    e.vm.runtime.targets.push({
      id: 'tw',
      isOriginal: true,
      x: 111,
      y: 5,
      sprite: { name: sprite.name },
      variables: {},
      blocks: { _blocks: {} },
    })
    adapter.vm.greenFlag()
    await adapter.settled()
    const received: Array<[number | undefined, number | undefined]> = []
    const unsubscribe = adapter.vm.on<ReturnType<typeof adapter.vm.snapshot>>(
      'PROJECT_CHANGED',
      (value) => {
        const target = value.project.targets.find((t) => t.id === sprite.id)
        received.push([target?.x, target?.y])
      },
    )
    adapter.model.updateTarget(sprite.id!, { y: 99 })
    expect(received).toEqual([
      [111, 99],
      [111, 99],
    ])
    unsubscribe()
    adapter.model.updateTarget(sprite.id!, { y: 30 })
    expect(received).toHaveLength(2)
  })

  test('forwards extra arguments and never replaces non-snapshot event payloads', () => {
    const adapter = new TurboWarpRuntimeVM(engine().vm)
    const error = {
      message: 'example',
      project: {},
      selectedTargetId: 's',
      running: false,
      threads: [],
    }
    const reported: unknown[] = []
    const extras: unknown[] = []
    adapter.vm.on('ERROR', (value) => reported.push(value))
    adapter.vm.on('RUNTIME_STEP', (_value, ...args) => extras.push(...args))
    adapter.model.emit('ERROR', error, 'detail')
    adapter.model.emit('RUNTIME_STEP', adapter.model.snapshot(), 'a', 7)
    expect(reported[0]).toBe(error)
    expect(extras).toEqual(['a', 7])
    const malformed = { message: 'not a snapshot' }
    let seen: unknown
    const listener = (value: unknown) => {
      seen = value
    }
    adapter.vm.on('PROJECT_CHANGED', listener)
    adapter.model.emit('PROJECT_CHANGED', malformed)
    expect(seen).toBe(malformed)
    adapter.vm.off('PROJECT_CHANGED', listener)
    seen = undefined
    adapter.model.emit('PROJECT_CHANGED', malformed)
    expect(seen).toBeUndefined()
  })

  test('commits live values on stop without restoring running threads', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((t) => !t.isStage)!,
      stage = project.targets.find((t) => t.isStage)!
    e.vm.runtime.targets.push({
      id: 'stage',
      isOriginal: true,
      isStage: true,
      sprite: { name: stage.name },
      variables: {},
      blocks: { _blocks: {} },
    })
    e.vm.runtime.targets.push({
      id: 'tw',
      isOriginal: true,
      x: 111,
      y: 5,
      sprite: { name: sprite.name },
      variables: {},
      blocks: { _blocks: {} },
    })
    ;(e.vm.runtime as { targets: unknown[]; threads?: unknown[] }).threads = [
      { topBlock: 'block', stack: ['block'], status: 0, target: { sprite: { name: sprite.name } } },
    ]
    adapter.vm.greenFlag()
    await adapter.settled()
    expect(adapter.vm.snapshot().threads).toHaveLength(1)
    adapter.vm.stopAll()
    expect(adapter.model.getTarget(sprite.id!)?.x).toBe(111)
    expect(adapter.vm.snapshot().running).toBe(false)
    expect(adapter.vm.snapshot().threads).toEqual([])
    let changes = 0
    adapter.model.on('PROJECT_CHANGED', () => {
      changes++
    })
    adapter.vm.stopAll()
    expect(changes).toBe(0)
    adapter.model.updateTarget(sprite.id!, { y: 99 })
    expect(adapter.model.getTarget(sprite.id!)?.x).toBe(111)
    expect(adapter.model.getTarget(sprite.id!)?.y).toBe(99)
  })

  test('maps regenerated target IDs and mirrors dragged positions into the saved model', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const project = adapter.model.exportProject()
    const sprite = project.targets.find((t) => !t.isStage)!
    const stage = project.targets.find((t) => t.isStage)!
    const runtimeSprite = {
      id: 'new-tw-id',
      isOriginal: true,
      x: 10,
      y: 0,
      sprite: { name: sprite.name, costumes: [], sounds: [] },
      variables: {},
      blocks: { _blocks: {} },
    }
    e.vm.runtime.targets.push(
      {
        id: 'new-stage-id',
        isOriginal: true,
        isStage: true,
        sprite: { name: stage.name, costumes: [], sounds: [] },
        variables: {},
        blocks: { _blocks: {} },
      },
      runtimeSprite,
    )
    const calls: string[] = []
    e.vm.startDrag = (id) => calls.push(`start:${id}`)
    e.vm.stopDrag = (id) => calls.push(`stop:${id}`)
    e.vm.setEditingTarget = (id) => calls.push(`select:${id}`)
    e.vm.postSpriteInfo = (data) => {
      runtimeSprite.x = (data as { x: number }).x
    }
    await adapter.syncProject()
    expect(adapter.runtimeTargetId(sprite.id!)).toBe('new-tw-id')
    expect(adapter.modelTargetId('new-tw-id')).toBe(sprite.id!)
    adapter.vm.startDrag(sprite.id!)
    adapter.vm.postSpriteInfo({ targetId: sprite.id, x: 100, y: 4 })
    adapter.vm.stopDrag(sprite.id!)
    expect(calls).toEqual(['start:new-tw-id', 'select:new-tw-id', 'stop:new-tw-id'])
    expect(adapter.model.exportProject().targets.find((t) => t.id === sprite.id)?.x).toBe(100)
    expect(adapter.vm.snapshot().project.targets.find((t) => t.id === sprite.id)?.x).toBe(100)
    adapter.vm.postMouse({ x: 0 })
    expect(e.calls).toContain('mouse')
  })

  test('reapplies mode changes during load and stop invalidates the pending load', async () => {
    const loading = deferred(),
      entered = deferred()
    const e = engine(async () => {
      entered.resolve()
      await loading.promise
    })
    const modes: boolean[] = []
    e.vm.setTurboMode = (enabled) => {
      modes.push(enabled)
    }
    const adapter = new TurboWarpRuntimeVM(e.vm)
    adapter.vm.greenFlag()
    await entered.promise
    adapter.vm.setTurboMode(true)
    loading.resolve()
    await adapter.settled()
    expect(modes).toEqual([true, true])
    const pending = deferred(),
      begun = deferred()
    const e2 = engine(async () => {
      begun.resolve()
      await pending.promise
    })
    const adapter2 = new TurboWarpRuntimeVM(e2.vm)
    const sync = adapter2.syncProject()
    await begun.promise
    adapter2.vm.stopAll()
    pending.resolve()
    await expect(sync).rejects.toThrow('stopped')
    expect(adapter2.notifyFrame()).toBe(false)
  })

  test('forwards engine events and unsubscribes on disposal', async () => {
    const e = engine()
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const source = {
      on(event: string, fn: (...args: unknown[]) => void) {
        listeners.set(event, fn)
      },
      removeListener(event: string) {
        listeners.delete(event)
      },
    }
    let events = 0
    adapter.vm.on('TARGETS_UPDATE', () => {
      events++
    })
    const unbind = adapter.bindRuntimeEvents(source)
    await adapter.syncProject()
    listeners.get('TARGETS_UPDATE')?.()
    expect(events).toBe(1)
    unbind()
    expect(listeners.size).toBe(0)
    adapter.bindRuntimeEvents(source)
    adapter.dispose()
    expect(listeners.size).toBe(0)
    expect(adapter.notifyFrame()).toBe(false)
  })

  test('exposes async load errors and can retry', async () => {
    let count = 0
    const e = engine(async () => {
      if (++count === 1) throw new Error('bad load')
    })
    const adapter = new TurboWarpRuntimeVM(e.vm)
    const errors: string[] = []
    adapter.model.on<{ message: string }>('ERROR', (event) => errors.push(event.message))
    adapter.vm.greenFlag()
    await expect(adapter.settled()).rejects.toThrow('bad load')
    expect(errors).toContain('bad load')
    adapter.vm.greenFlag()
    await adapter.settled()
    expect(e.calls).toContain('flag')
  })
})
