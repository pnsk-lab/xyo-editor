import { describe, expect, test } from 'bun:test'
import { ScratchVM } from '@hikkaku/vm'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { XyoHeadlessRuntime, type XyoModule } from '../../xyo-cpp-wasm/src/index'
import { XyoRuntimeVM, type XyoRuntimeEngine } from '../src/lib/xyo-runtime-vm'
import { hasXyoWasm, optIn } from './artifacts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(model: ScratchVM) {
  const calls: string[] = []
  let x = 0
  const engine: XyoRuntimeEngine = {
    loadSb3(bytes) {
      expect(bytes[0]).toBe(0x50)
      calls.push('load')
    },
    greenFlagCompiled() {
      calls.push('compiled')
    },
    step() {
      calls.push('step')
      x = 42
    },
    stop() {
      calls.push('stop')
    },
    dispose() {
      calls.push('dispose')
    },
    snapshot() {
      return {
        threadCount: 0,
        stepSerial: 0,
        targets: model.snapshot().project.targets.map((t, i) => ({
          id: `xyo-${i}`,
          name: t.name,
          isStage: t.isStage,
          isOriginal: true,
          x: t.isStage ? 0 : x,
          y: t.y ?? 0,
          direction: t.direction ?? 90,
          size: t.size ?? 100,
          visible: t.visible ?? true,
          currentCostume: t.currentCostume ?? 0,
          layerOrder: t.layerOrder ?? 0,
          bubbleText: '',
          bubbleType: '',
          variables: Object.fromEntries([
            ...Object.entries(t.variables).map(([id, [name, value]]) => [
              id,
              { name, type: '', value },
            ]),
            ...Object.entries(t.lists).map(([id, [name, value]]) => [
              id,
              { name, type: 'list', value },
            ]),
          ]),
        })),
      }
    },
  }
  return { engine, calls }
}

describe('XyoRuntimeVM', () => {
  test('loads lazily, requests compiled execution and overlays detached state', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    let loads = 0
    const adapter = new XyoRuntimeVM(() => {
      loads++
      return f.engine
    }, model)
    expect(loads).toBe(0)
    adapter.vm.greenFlag()
    await adapter.settled()
    expect(f.calls).toEqual(['load', 'compiled'])
    adapter.vm.step()
    await adapter.settled()
    const sprite = adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!
    expect(sprite.x).toBe(42)
    sprite.x = 99
    expect(adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    adapter.vm.stopAll()
    await adapter.settled()
    expect(model.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    expect(() => adapter.vm.postMouse({ x: 1 })).not.toThrow()
    adapter.dispose()
    await adapter.settled()
    expect(f.calls.at(-1)).toBe('dispose')
  })
  test('invalidates a pending load on edit and serializes rapid flags', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred()
    let first = true
    f.engine.loadSb3 = async () => {
      f.calls.push('load')
      if (first) {
        first = false
        await gate.promise
      }
    }
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    while (!f.calls.includes('load')) await Promise.resolve()
    model.emit('PROJECT_CHANGED', {})
    adapter.greenFlag()
    gate.resolve()
    await adapter.settled()
    expect(f.calls.filter((x) => x === 'compiled')).toHaveLength(1)
    expect(f.calls.filter((x) => x === 'load')).toHaveLength(2)
    adapter.dispose()
    await adapter.settled()
  })
  test('surfaces headless limitations and observed interpreter fallback', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    const stats = { fallbacks: 0 }
    Object.assign(f.engine, {
      async stats() {
        return { compileStats: { ...stats } }
      },
      step() {
        stats.fallbacks++
      },
    })
    const messages: string[] = []
    model.on('ERROR', (e) => messages.push((e as { message: string }).message))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.step()
    await adapter.settled()
    expect(messages.some((s) => s.includes('headless'))).toBe(true)
    expect(messages.some((s) => s.includes('fell back') && s.includes('module-wide'))).toBe(true)
    adapter.dispose()
    await adapter.settled()
  })
  test('forwards input to the engine in order with explicit limitations', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      calls: unknown[][] = []
    const originalSnapshot = f.engine.snapshot.bind(f.engine)
    Object.assign(f.engine, {
      snapshot() {
        return { ...(originalSnapshot() as object), io: { question: 'Question?', questionId: '1' } }
      },
      async key(...args: unknown[]) {
        calls.push(['key', ...args])
      },
      async mouse(...args: unknown[]) {
        calls.push(['mouse', ...args])
      },
      async wheel(...args: unknown[]) {
        calls.push(['wheel', ...args])
      },
      async answerIfQuestion(...args: unknown[]) {
        calls.push(['answer', ...args])
        return true
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    expect(() => adapter.vm.postKeyboard({ key: 'a', isDown: true })).not.toThrow()
    adapter.greenFlag()
    await adapter.settled()
    adapter.vm.postKeyboard({ key: 'left arrow', isDown: true })
    adapter.vm.runtime.ioDevices.keyboard.postData({ KEY_OPTION: 'space', pressed: false })
    adapter.vm.postIOData('mouse', {
      x: 20,
      y: 30,
      canvasWidth: 480,
      canvasHeight: 360,
      buttons: 1,
      wasDragged: true,
    })
    adapter.vm.runtime.ioDevices.mouseWheel.postData({ deltaX: 2, deltaY: -3 })
    adapter.vm.answerPrompt('hello')
    await adapter.settled()
    expect(calls).toEqual([
      ['key', 'ArrowLeft', true, undefined],
      ['key', ' ', false, undefined],
      ['mouse', 20, 30, 480, 360, true, 0, true],
      ['wheel', 2, -3],
      ['answer', '1', 'hello'],
    ])
    expect(() => adapter.vm.postMouse({ x: 2, y: 3 })).toThrow('dimensions')
    expect(() => adapter.vm.postIOData('video', {})).toThrow('does not support')
    expect(() => adapter.vm.runtime.ioDevices.cloud.postData({})).toThrow('does not support')
    adapter.dispose()
    await adapter.settled()
  })
  test('publishes queued questions once, accepts empty answers and clears on stop', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred()
    const original = f.engine.snapshot.bind(f.engine)
    const questions = [
      { id: '1', text: '' },
      { id: '2', text: '' },
      { id: '3', text: 'last' },
    ]
    const answers: string[] = [],
      events: unknown[] = []
    Object.assign(f.engine, {
      snapshot() {
        return {
          ...(original() as object),
          io: { question: questions[0]?.text ?? null, questionId: questions[0]?.id ?? null },
        }
      },
      async answerIfQuestion(id: string, value: string) {
        if (questions[0]?.id !== id) return false
        answers.push(value)
        await gate.promise
        questions.shift()
        return true
      },
    })
    model.on('QUESTION', (e) => events.push(e))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.vm.answerPrompt('')
    adapter.vm.answerPrompt('duplicate')
    adapter.step()
    gate.resolve()
    await adapter.settled()
    expect(answers).toEqual([''])
    expect(events).toEqual([
      { question: '', questionId: '1' },
      { answer: '' },
      { question: '', questionId: '2' },
    ])
    adapter.stopAll()
    await adapter.settled()
    expect(events.at(-1)).toEqual({ question: null })
    adapter.dispose()
    await adapter.settled()
  })
  test('answer notification failure still delivers once after UI closes', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine),
      answers: string[] = []
    let question: string | null = 'Q'
    Object.assign(f.engine, {
      snapshot() {
        return { ...(original() as object), io: { question, questionId: question ? '1' : null } }
      },
      answerIfQuestion(id: string, value: string) {
        expect(id).toBe('1')
        answers.push(value)
        question = null
        return true
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    let uiClosed = false
    model.on('QUESTION', (event) => {
      if ((event as { answer?: string }).answer !== undefined) uiClosed = true
    })
    const unsubscribe = model.on('QUESTION', () => {
      throw new Error('answer listener failed')
    })
    expect(() => adapter.vm.answerPrompt('first')).toThrow('answer listener failed')
    expect(uiClosed).toBe(true)
    expect(answers).toEqual([])
    unsubscribe()
    adapter.vm.answerPrompt('duplicate')
    await adapter.settled()
    expect(answers).toEqual(['first'])
    adapter.dispose()
    await adapter.settled()
  })
  for (const action of ['stop', 'reflag'] as const)
    for (const throws of [false, true])
      test(`answer listener ${action}${throws ? ' and throws' : ''} cannot deliver to an old or new worker`, async () => {
        const model = new ScratchVM(),
          first = fixture(model),
          second = fixture(model),
          answers: string[] = []
        for (const f of [first, second]) {
          const original = f.engine.snapshot.bind(f.engine)
          Object.assign(f.engine, {
            interrupt() {},
            snapshot() {
              return { ...(original() as object), io: { question: 'Q', questionId: '1' } }
            },
            answerIfQuestion(id: string, text: string) {
              answers.push(`${id}:${text}`)
              return true
            },
          })
        }
        let loads = 0
        const adapter = new XyoRuntimeVM(() => (loads++ ? second.engine : first.engine), model)
        adapter.greenFlag()
        await adapter.settled()
        const unsubscribe = model.on('QUESTION', (event) => {
          if (!(event && typeof event === 'object' && 'answer' in event)) return
          if (action === 'stop') adapter.stopAll()
          else adapter.greenFlag()
          if (throws) throw new Error('answer notification failed')
        })
        if (throws)
          expect(() => adapter.vm.answerPrompt('old')).toThrow('answer notification failed')
        else expect(() => adapter.vm.answerPrompt('old')).not.toThrow()
        unsubscribe()
        await adapter.settled()
        expect(answers).toEqual([])
        adapter.dispose()
        await adapter.settled()
      })
  test('never sends an old answer to a replacement question', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred(),
      events: unknown[] = []
    const original = f.engine.snapshot.bind(f.engine)
    let id = '1',
      accepted = ''
    Object.assign(f.engine, {
      snapshot() {
        return { ...(original() as object), io: { question: 'same text', questionId: id } }
      },
      async step() {
        await gate.promise
        id = '2'
      },
      async answerIfQuestion(expected: string, text: string) {
        if (expected !== id) return false
        accepted = text
        return true
      },
    })
    model.on('QUESTION', (e) => events.push(e))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.step()
    await Promise.resolve()
    adapter.vm.answerPrompt('for first')
    gate.resolve()
    await adapter.settled()
    expect(accepted).toBe('')
    expect(events).toEqual([
      { question: 'same text', questionId: '1' },
      { answer: 'for first' },
      { question: 'same text', questionId: '2' },
    ])
    adapter.dispose()
    await adapter.settled()
  })
  test('ignores a late answer result after stop and reflag', async () => {
    const model = new ScratchVM(),
      old = fixture(model),
      fresh = fixture(model),
      gate = deferred()
    const events: unknown[] = []
    const oldSnapshot = old.engine.snapshot.bind(old.engine),
      freshSnapshot = fresh.engine.snapshot.bind(fresh.engine)
    Object.assign(old.engine, {
      interrupt() {},
      snapshot() {
        return { ...(oldSnapshot() as object), io: { question: 'old', questionId: '1' } }
      },
      async answerIfQuestion() {
        await gate.promise
        return true
      },
    })
    Object.assign(fresh.engine, {
      interrupt() {},
      snapshot() {
        return { ...(freshSnapshot() as object), io: { question: 'new', questionId: '2' } }
      },
    })
    let loads = 0
    const adapter = new XyoRuntimeVM(() => (loads++ === 0 ? old.engine : fresh.engine), model)
    model.on('QUESTION', (e) => events.push(e))
    adapter.greenFlag()
    await adapter.settled()
    adapter.vm.answerPrompt('value')
    await Promise.resolve()
    adapter.stopAll()
    adapter.greenFlag()
    await adapter.settled()
    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual([
      { question: 'old', questionId: '1' },
      { answer: 'value' },
      { question: null },
      { question: 'new', questionId: '2' },
    ])
    adapter.dispose()
    await adapter.settled()
  })
  test('reports queued inputs invalidated by stop', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred(),
      calls: string[] = [],
      messages: string[] = []
    Object.assign(f.engine, {
      async key(key: string) {
        calls.push(key)
        await gate.promise
      },
    })
    model.on('ERROR', (event) => messages.push((event as { message: string }).message))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.vm.postKeyboard({ key: 'a', isDown: true })
    await Promise.resolve()
    adapter.vm.postKeyboard({ key: 'b', isDown: true })
    adapter.stopAll()
    gate.resolve()
    await adapter.settled()
    expect(calls).toEqual(['a'])
    expect(messages.some((m) => m.includes('invalidated before delivery'))).toBe(true)
    adapter.dispose()
    await adapter.settled()
  })
  test('interrupts a blocked compile and starts a fresh engine on rapid flag', async () => {
    const model = new ScratchVM(),
      first = fixture(model),
      second = fixture(model),
      started = deferred(),
      blocked = deferred()
    let terminated = 0,
      created = 0
    Object.assign(first.engine, {
      greenFlagCompiled() {
        started.resolve()
        return blocked.promise
      },
      interrupt() {
        terminated++
      },
    })
    Object.assign(second.engine, {
      interrupt() {
        terminated++
      },
    })
    const adapter = new XyoRuntimeVM(() => (++created === 1 ? first.engine : second.engine), model)
    adapter.greenFlag()
    await started.promise
    adapter.greenFlag()
    await adapter.settled()
    expect(terminated).toBe(1)
    expect(created).toBe(2)
    expect(second.calls).toContain('compiled')
    blocked.resolve()
    await Promise.resolve()
    expect(adapter.vm.snapshot().project.targets.length).toBeGreaterThan(0)
    adapter.stopAll()
    await adapter.settled()
    expect(terminated).toBe(2)
    adapter.dispose()
    await adapter.settled()
  })
  test('discards an engine whose lazy factory resolves after replacement', async () => {
    const model = new ScratchVM(),
      old = fixture(model),
      fresh = fixture(model),
      gate = deferred(),
      entered = deferred()
    let created = 0,
      terminated = 0
    Object.assign(old.engine, {
      interrupt() {
        terminated++
      },
    })
    const adapter = new XyoRuntimeVM(async () => {
      if (++created === 1) {
        entered.resolve()
        await gate.promise
        return old.engine
      }
      return fresh.engine
    }, model)
    adapter.greenFlag()
    await entered.promise
    adapter.greenFlag()
    await adapter.settled()
    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(terminated).toBe(1)
    expect(old.calls).not.toContain('load')
    expect(fresh.calls).toContain('compiled')
    adapter.dispose()
    await adapter.settled()
  })
  test('interrupts blocked async stats on edit and ignores late completion', async () => {
    const model = new ScratchVM(),
      old = fixture(model),
      fresh = fixture(model),
      entered = deferred(),
      gate = deferred()
    let terminated = 0,
      created = 0
    Object.assign(old.engine, {
      async stats() {
        entered.resolve()
        await gate.promise
        return { compileStats: { fallbacks: 0 } }
      },
      interrupt() {
        terminated++
      },
    })
    const adapter = new XyoRuntimeVM(() => (++created === 1 ? old.engine : fresh.engine), model)
    adapter.greenFlag()
    await entered.promise
    model.emit('PROJECT_CHANGED', {})
    expect(terminated).toBe(1)
    adapter.greenFlag()
    await adapter.settled()
    expect(fresh.calls).toContain('compiled')
    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(old.calls).not.toContain('compiled')
    adapter.dispose()
    await adapter.settled()
  })
  test('input wakes idle execution and publishes frame and run start', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine)
    let running = false
    Object.assign(f.engine, {
      key() {
        running = true
      },
      snapshot() {
        return { ...(original() as object), threadCount: Number(running) }
      },
    })
    const events: string[] = []
    model.on('PROJECT_RUN_START', () => events.push('start'))
    model.on('RUNTIME_STEP', () => events.push('step'))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    events.length = 0
    adapter.vm.postKeyboard({ key: 'a', isDown: true })
    await adapter.settled()
    expect(events).toEqual(['start', 'step'])
    expect(adapter.vm.isRunning()).toBe(true)
    adapter.dispose()
    await adapter.settled()
  })
  test('preserves latest selection and exports live sprite state', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred()
    const step = f.engine.step.bind(f.engine)
    f.engine.step = async () => {
      await gate.promise
      await step()
    }
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.step()
    const stage = model.getStage(),
      sprite = model.snapshot().project.targets.find((t) => !t.isStage)!
    model.selectTarget(stage.id ?? stage.name)
    gate.resolve()
    await adapter.settled()
    expect(adapter.vm.snapshot().selectedTargetId).toBe(stage.id ?? stage.name)
    expect(JSON.parse(adapter.vm.toJSON(sprite.id!)).x).toBe(42)
    const archive = await adapter.vm.saveSpriteSb3(sprite.id!)
    expect(JSON.parse(strFromU8(unzipSync(archive)['sprite.json'])).x).toBe(42)
    expect(adapter.vm.snapshot().selectedTargetId).toBe(stage.id ?? stage.name)
    adapter.dispose()
    await adapter.settled()
  })
  test('merges changed variables and lists independently by ID on edit', async () => {
    const model = new ScratchVM(),
      sprite = model.snapshot().project.targets.find((t) => !t.isStage)!
    const target = model.getTarget(sprite.id!)!
    target.variables = { a: ['a', 1], b: ['b', 2] }
    target.lists = { a: ['a', [1]], b: ['b', [2]] }
    const f = fixture(model),
      raw = f.engine.snapshot.bind(f.engine)
    f.engine.snapshot = () => {
      const snapshot = raw() as {
        targets: { isStage: boolean; variables: Record<string, { value: unknown }> }[]
      }
      const values = snapshot.targets.find((t) => !t.isStage)!.variables
      values.a.value = 10
      // Lists and variables have distinct IDs in Scratch projects.
      return snapshot
    }
    // Use distinct list IDs so the headless snapshot can represent both kinds.
    target.lists = { la: ['la', [1]], lb: ['lb', [2]] }
    const snapshot = f.engine.snapshot.bind(f.engine)
    f.engine.snapshot = () => {
      const value = snapshot() as {
        targets: { isStage: boolean; variables: Record<string, { value: unknown }> }[]
      }
      value.targets.find((t) => !t.isStage)!.variables.la.value = [10]
      return value
    }
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    target.variables.b[1] = 20
    target.lists.lb[1] = [20]
    model.emit('PROJECT_CHANGED', {})
    await adapter.settled()
    const result = model.getTarget(sprite.id!)!
    expect(result.variables.a[1]).toBe(10)
    expect(result.variables.b[1]).toBe(20)
    expect(result.lists.la[1]).toEqual([10])
    expect(result.lists.lb[1]).toEqual([20])
    adapter.dispose()
    await adapter.settled()
  })
  test('does not stop an engine invalidated before its first load', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred()
    const adapter = new XyoRuntimeVM(async () => {
      await gate.promise
      return f.engine
    }, model)
    adapter.greenFlag()
    await Promise.resolve()
    await Promise.resolve()
    adapter.stopAll()
    gate.resolve()
    await adapter.settled()
    expect(f.calls).not.toContain('stop')
    expect(f.calls).not.toContain('load')
    adapter.dispose()
    await adapter.settled()
  })
  ;(optIn('XYO_WASM_TEST', hasXyoWasm) ? test : test.skip)(
    'runs a real compiled WASM flag through the adapter',
    async () => {
      const root = join(import.meta.dir, '../../xyo-cpp-wasm/.work/build-wasm')
      const createModule = createRequire(import.meta.url)(
        join(root, 'xyo-browser.js'),
      ) as (options: { wasmBinary: Uint8Array }) => Promise<XyoModule>
      const module = await createModule({
        wasmBinary: await readFile(join(root, 'xyo-browser.wasm')),
      })
      const model = new ScratchVM()
      await model.loadProject({
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: { v: ['v', 7] },
            lists: {},
            broadcasts: {},
            blocks: {
              hat: {
                opcode: 'event_whenflagclicked',
                next: 'change',
                parent: null,
                inputs: {},
                fields: {},
                topLevel: true,
              },
              change: {
                opcode: 'data_changevariableby',
                next: null,
                parent: 'hat',
                inputs: { VALUE: [1, [4, '3']] },
                fields: { VARIABLE: ['v', 'v'] },
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
      })
      const engine = new XyoHeadlessRuntime(module)
      const adapter = new XyoRuntimeVM(() => engine, model)
      try {
        adapter.greenFlag()
        await adapter.settled()
        adapter.step()
        await adapter.settled()
        expect(adapter.vm.snapshot().project.targets[0].variables.v[1]).toBe(10)
        expect(engine.compileStats.executions).toBeGreaterThan(0)
        adapter.stopAll()
        await adapter.settled()
      } finally {
        adapter.dispose()
        await adapter.settled()
      }
    },
    30000,
  )
  test('keeps stage dragging available and stops live execution before sprite edits', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    let interrupts = 0
    Object.assign(f.engine, {
      interrupt() {
        interrupts++
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    const sprite = model.snapshot().project.targets.find((t) => !t.isStage)!
    const pointer = { x: 100, y: 100, canvasWidth: 480, canvasHeight: 360, isDown: true }
    adapter.vm.postMouse(pointer)
    adapter.vm.startDrag(sprite.id!)
    adapter.vm.postSpriteInfo({ targetId: sprite.id, x: 15, y: 20 })
    adapter.vm.stopDrag(sprite.id!)
    expect(model.getTarget(sprite.id!)!.x).toBe(15)
    expect(model.isRunning()).toBe(false)
    adapter.greenFlag()
    await adapter.settled()
    adapter.step()
    await adapter.settled()
    adapter.vm.startDrag(sprite.id!)
    adapter.vm.postSpriteInfo({ targetId: sprite.id, y: 30 })
    adapter.vm.stopDrag(sprite.id!)
    expect(interrupts).toBe(1)
    expect(model.getTarget(sprite.id!)!.x).toBe(42)
    expect(model.getTarget(sprite.id!)!.y).toBe(30)
    adapter.vm.postMouse(pointer)
    adapter.dispose()
    await adapter.settled()
  })
  test('coalesces contiguous moves while preserving other input ordering', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      calls: string[] = [],
      gate = deferred(),
      entered = deferred()
    Object.assign(f.engine, {
      async key(key: string) {
        calls.push(`key:${key}`)
        if (key === 'block') {
          entered.resolve()
          await gate.promise
        }
      },
      mouse(x: number, _y: number, _w: number, _h: number, down: boolean) {
        calls.push(`mouse:${x}:${down}`)
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.vm.postKeyboard({ key: 'block', isDown: true })
    await entered.promise
    const mouse = (x: number, down: boolean) =>
      adapter.vm.postMouse({ x, y: 0, canvasWidth: 480, canvasHeight: 360, isDown: down })
    mouse(0, true)
    for (let i = 1; i <= 1000; i++) mouse(i, true)
    adapter.vm.postKeyboard({ key: 'a', isDown: true })
    mouse(1001, true)
    mouse(1002, true)
    mouse(1003, false)
    gate.resolve()
    await adapter.settled()
    expect(calls).toEqual([
      'key:block',
      'mouse:0:true',
      'mouse:1000:true',
      'key:a',
      'mouse:1002:true',
      'mouse:1003:false',
    ])
    adapter.dispose()
    await adapter.settled()
  })
  test('preserves last successful live state on worker and commit failures', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      errors: string[] = []
    model.on('ERROR', (e) => errors.push((e as { message: string }).message))
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    adapter.step()
    await adapter.settled()
    f.engine.step = () => {
      throw new Error('worker crashed')
    }
    adapter.step()
    await expect(adapter.settled()).rejects.toThrow('worker crashed')
    expect(model.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    expect(errors.some((e) => e.includes('worker crashed'))).toBe(true)
    adapter.dispose()
    await adapter.settled()

    const model2 = new ScratchVM(),
      f2 = fixture(model2),
      messages: string[] = []
    const secondSnapshot = f2.engine.snapshot.bind(f2.engine)
    f2.engine.snapshot = () => ({ ...(secondSnapshot() as object), threadCount: 1 })
    model2.on('ERROR', (e) => messages.push((e as { message: string }).message))
    const second = new XyoRuntimeVM(() => f2.engine, model2)
    second.greenFlag()
    await second.settled()
    second.step()
    await second.settled()
    const originalCommit = model2.commitRuntimeSnapshot.bind(model2)
    model2.commitRuntimeSnapshot = () => {
      throw new Error('commit failed')
    }
    f2.engine.step = () => {
      throw new Error('snapshot failure')
    }
    second.step()
    await expect(second.settled()).rejects.toThrow('snapshot failure')
    expect(messages.some((e) => e.includes('commit failed'))).toBe(true)
    expect(messages.some((e) => e.includes('snapshot failure'))).toBe(true)
    expect(second.vm.snapshot().running).toBe(false)
    expect(second.vm.snapshot().threads).toEqual([])
    expect(second.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    model2.commitRuntimeSnapshot = originalCommit
    second.dispose()
    await second.settled()
  })
  test('applies optional pen batches only after snapshot validation and ignores stale responses', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      gate = deferred()
    const original = f.engine.snapshot.bind(f.engine)
    const calls: unknown[] = []
    let delayed = false
    Object.assign(f.engine, {
      async snapshot() {
        const snapshot = original() as object
        if (delayed) await gate.promise
        return {
          ...snapshot,
          penEvents: [
            { type: 'line', rgba: [1, 0, 0, 1], diameter: 2, x0: 0, y0: 0, x1: 20, y1: 0 },
          ],
        }
      },
      interrupt() {},
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model, {
      discardPenLayer() {},
      penBatchAtomic(operations) {
        calls.push(...operations)
      },
    })
    adapter.greenFlag()
    await adapter.settled()
    expect(calls).toHaveLength(1)
    delayed = true
    adapter.step()
    await Promise.resolve()
    await Promise.resolve()
    adapter.stopAll()
    gate.resolve()
    await adapter.settled()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    adapter.dispose()
    await adapter.settled()
  })
  test('clears the pen only on actual project replacement, including while stopped', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      batches: unknown[] = []
    const adapter = new XyoRuntimeVM(() => f.engine, model, {
      discardPenLayer: () => batches.push([{ type: 'clear' }]),
      penBatchAtomic: (ops) => {
        if (ops.length) batches.push(ops)
      },
    })
    model.handleProjectLoaded()
    expect(batches).toEqual([])
    model.applyRuntimeSnapshot(model.snapshot())
    model.handleProjectLoaded()
    expect(batches).toEqual([])
    model.clear()
    expect(batches).toEqual([[{ type: 'clear' }]])
    model.handleProjectLoaded()
    expect(batches).toHaveLength(1)
    await model.loadProject(model.exportProject())
    expect(batches).toHaveLength(2)
    adapter.dispose()
    await adapter.settled()
  })
  for (const failingEvent of ['QUESTION', 'RUNTIME_STEP'] as const)
    test(`pen ${failingEvent} listener failure stops worker but preserves committed frame`, async () => {
      const model = new ScratchVM(),
        f = fixture(model),
        ink: unknown[] = [],
        errors: string[] = []
      const original = f.engine.snapshot.bind(f.engine)
      let question = false,
        interrupted = 0
      Object.assign(f.engine, {
        interrupt() {
          interrupted++
        },
        snapshot() {
          return {
            ...(original() as object),
            penEvents: question ? [{ type: 'clear' }] : [],
            io: question ? { question: 'Q', questionId: '1' } : {},
          }
        },
      })
      const adapter = new XyoRuntimeVM(() => f.engine, model, {
        discardPenLayer() {},
        penBatchAtomic: (events) => {
          if (events.length) ink.push(events)
        },
      })
      adapter.greenFlag()
      await adapter.settled()
      model.on('ERROR', (event) => {
        errors.push((event as { message: string }).message)
        throw new Error('error listener failed')
      })
      model.on(failingEvent, () => {
        throw new Error(`${failingEvent} listener failed`)
      })
      question = true
      adapter.step()
      await expect(adapter.settled()).rejects.toThrow('committed frame; notification failed')
      expect(ink).toHaveLength(1)
      expect(adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
      expect(interrupted).toBe(1)
      expect(adapter.vm.isRunning()).toBe(false)
      expect(() => adapter.step()).toThrow('not synchronized')
      expect(errors.some((message) => message.includes('runtime stopped'))).toBe(true)
      model.removeAllListeners('ERROR')
      model.removeAllListeners(failingEvent)
      question = false
      adapter.greenFlag()
      await adapter.settled()
      adapter.step()
      await adapter.settled()
      expect(f.calls.filter((call) => call === 'step')).toHaveLength(2)
      adapter.dispose()
      await adapter.settled()
    })
  for (const failingEvent of ['PROJECT_RUN_START', 'ERROR'] as const)
    test(`pen flag ${failingEvent} listener failure stops its worker`, async () => {
      const model = new ScratchVM(),
        f = fixture(model),
        ink: unknown[] = []
      const original = f.engine.snapshot.bind(f.engine)
      let interrupted = 0
      Object.assign(f.engine, {
        compileStats: { fallbacks: 0 },
        interrupt() {
          interrupted++
        },
        snapshot() {
          return { ...(original() as object), penEvents: [{ type: 'clear' }] }
        },
      })
      model.on(failingEvent, () => {
        throw new Error(`${failingEvent} listener failed`)
      })
      const adapter = new XyoRuntimeVM(() => f.engine, model, {
        discardPenLayer() {},
        penBatchAtomic: (events) => ink.push(events),
      })
      adapter.greenFlag()
      await expect(adapter.settled()).rejects.toThrow('committed frame; notification failed')
      expect(ink).toHaveLength(1)
      expect(interrupted).toBe(1)
      expect(adapter.vm.isRunning()).toBe(false)
      model.removeAllListeners(failingEvent)
      adapter.greenFlag()
      await adapter.settled()
      adapter.dispose()
      await adapter.settled()
    })
  test('stop interrupts even when clearing the current question throws', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine)
    let interrupted = 0
    Object.assign(f.engine, {
      interrupt() {
        interrupted++
      },
      snapshot() {
        return { ...(original() as object), io: { question: 'Q', questionId: '1' } }
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    model.on('QUESTION', () => {
      throw new Error('clear listener failed')
    })
    expect(() => adapter.stopAll()).toThrow('clear listener failed')
    expect(interrupted).toBe(1)
    expect(adapter.vm.isRunning()).toBe(false)
    model.removeAllListeners('QUESTION')
    adapter.greenFlag()
    await adapter.settled()
    adapter.dispose()
    await adapter.settled()
  })
  for (const operation of ['flag', 'dispose'] as const)
    for (const failure of ['commit', 'question'] as const)
      test(`${operation} tears down old worker when ${failure} listener fails`, async () => {
        const model = new ScratchVM(),
          f = fixture(model),
          original = f.engine.snapshot.bind(f.engine)
        let interrupted = 0
        Object.assign(f.engine, {
          interrupt() {
            interrupted++
          },
          snapshot() {
            return {
              ...(original() as object),
              threadCount: 1,
              io: { question: 'Q', questionId: '1' },
            }
          },
        })
        const adapter = new XyoRuntimeVM(() => f.engine, model)
        adapter.greenFlag()
        await adapter.settled()
        const commit = model.commitRuntimeSnapshot.bind(model)
        if (failure === 'commit')
          model.commitRuntimeSnapshot = () => {
            throw new Error('commit listener failed')
          }
        else
          model.on('QUESTION', () => {
            throw new Error('question listener failed')
          })
        expect(() => (operation === 'flag' ? adapter.greenFlag() : adapter.dispose())).toThrow(
          `${failure} listener failed`,
        )
        expect(interrupted).toBe(1)
        expect(adapter.vm.isRunning()).toBe(false)
        expect(adapter.vm.snapshot().running).toBe(false)
        expect(adapter.vm.snapshot().threads).toEqual([])
        model.commitRuntimeSnapshot = commit
        model.removeAllListeners('QUESTION')
        if (operation === 'flag') {
          adapter.greenFlag()
          await adapter.settled()
          adapter.dispose()
          await adapter.settled()
        } else await adapter.settled()
      })
  for (const action of ['stop', 'edit', 'project-change'] as const)
    test(`${action} preserves detached state when commit and question notification fail`, async () => {
      const model = new ScratchVM(),
        f = fixture(model),
        original = f.engine.snapshot.bind(f.engine),
        ink: unknown[] = []
      let interrupted = 0
      Object.assign(f.engine, {
        interrupt() {
          interrupted++
        },
        snapshot() {
          return {
            ...(original() as object),
            threadCount: 1,
            penEvents: [{ type: 'clear' }],
            io: { question: 'Q', questionId: '1' },
          }
        },
      })
      const adapter = new XyoRuntimeVM(() => f.engine, model, {
        discardPenLayer() {
          ink.length = 0
        },
        penBatchAtomic(events) {
          ink.push(...events)
        },
      })
      adapter.greenFlag()
      await adapter.settled()
      adapter.step()
      await adapter.settled()
      expect(adapter.vm.snapshot().running).toBe(true)
      expect(adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
      const beforeInk = ink.length,
        commit = model.commitRuntimeSnapshot.bind(model)
      model.commitRuntimeSnapshot = () => {
        throw new Error('commit failed')
      }
      model.on('QUESTION', () => {
        throw new Error('clear listener failed')
      })
      expect(() => {
        if (action === 'stop') adapter.stopAll()
        else if (action === 'edit') adapter.vm.postSpriteInfo({ x: 5 })
        else model.emit('PROJECT_CHANGED', {})
      }).toThrow('commit failed')
      expect(interrupted).toBe(1)
      expect(adapter.vm.isRunning()).toBe(false)
      expect(adapter.vm.snapshot().running).toBe(false)
      expect(adapter.vm.snapshot().threads).toEqual([])
      expect(adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
      expect(ink).toHaveLength(beforeInk)
      model.commitRuntimeSnapshot = commit
      model.removeAllListeners('QUESTION')
      adapter.greenFlag()
      await adapter.settled()
      expect(model.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
      expect(ink.length).toBeGreaterThanOrEqual(beforeInk)
      adapter.dispose()
      await adapter.settled()
    })
  test('worker failures interrupt even if question and error listeners throw', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine)
    let interrupted = 0
    Object.assign(f.engine, {
      interrupt() {
        interrupted++
      },
      snapshot() {
        return { ...(original() as object), io: { question: 'Q', questionId: '1' } }
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    model.on('QUESTION', () => {
      throw new Error('clear listener failed')
    })
    model.on('ERROR', () => {
      throw new Error('error listener failed')
    })
    f.engine.step = () => {
      throw new Error('worker failed')
    }
    adapter.step()
    await expect(adapter.settled()).rejects.toThrow('worker failed')
    await Promise.resolve()
    expect(interrupted).toBe(1)
    expect(adapter.vm.isRunning()).toBe(false)
    model.removeAllListeners('QUESTION')
    model.removeAllListeners('ERROR')
    adapter.dispose()
    await adapter.settled()
  })
  test('project replacement discards prior ink after question listener throws', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine),
      order: string[] = []
    Object.assign(f.engine, {
      interrupt() {
        order.push('interrupt')
      },
      snapshot() {
        return { ...(original() as object), penEvents: [], io: { question: 'Q', questionId: '1' } }
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model, {
      discardPenLayer() {
        order.push('discard')
      },
      penBatchAtomic() {},
    })
    adapter.greenFlag()
    await adapter.settled()
    model.on('QUESTION', () => {
      order.push('question')
      throw new Error('question failed')
    })
    expect(() => model.clear()).toThrow('question failed')
    expect(order).toEqual(['question', 'interrupt', 'discard'])
    expect(adapter.vm.isRunning()).toBe(false)
    model.removeAllListeners('QUESTION')
    adapter.dispose()
    await adapter.settled()
  })
  test('pen notification failure interrupts even when committed-state merge fails', async () => {
    const model = new ScratchVM(),
      f = fixture(model),
      original = f.engine.snapshot.bind(f.engine)
    let interrupted = 0
    Object.assign(f.engine, {
      interrupt() {
        interrupted++
      },
      snapshot() {
        return { ...(original() as object), threadCount: 1, penEvents: [{ type: 'clear' }] }
      },
    })
    const adapter = new XyoRuntimeVM(() => f.engine, model, {
      discardPenLayer() {},
      penBatchAtomic() {},
    })
    adapter.greenFlag()
    await adapter.settled()
    const commit = model.commitRuntimeSnapshot.bind(model)
    model.commitRuntimeSnapshot = () => {
      throw new Error('commit failed')
    }
    model.on('RUNTIME_STEP', () => {
      throw new Error('draw failed')
    })
    model.on('ERROR', () => {
      throw new Error('error listener failed')
    })
    adapter.step()
    await expect(adapter.settled()).rejects.toThrow('committed frame; notification failed')
    expect(interrupted).toBe(1)
    expect(adapter.vm.snapshot().running).toBe(false)
    expect(adapter.vm.snapshot().threads).toEqual([])
    expect(adapter.vm.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    model.commitRuntimeSnapshot = commit
    model.removeAllListeners('RUNTIME_STEP')
    model.removeAllListeners('ERROR')
    adapter.greenFlag()
    await adapter.settled()
    expect(model.snapshot().project.targets.find((t) => !t.isStage)!.x).toBe(42)
    adapter.dispose()
    await adapter.settled()
  })
  test('ordinary backend keeps its prior event failure behavior', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await adapter.settled()
    model.on('RUNTIME_STEP', () => {
      throw new Error('ordinary callback failed')
    })
    adapter.step()
    await expect(adapter.settled()).rejects.toThrow('ordinary callback failed')
    model.removeAllListeners('RUNTIME_STEP')
    adapter.dispose()
    await adapter.settled()
  })
  test('validates question identity before committing any pen batch', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    const original = f.engine.snapshot.bind(f.engine)
    let bad = false
    f.engine.snapshot = () => ({
      ...(original() as object),
      penEvents: bad ? [{ type: 'clear' }] : [],
      io: bad ? { question: 'Q', questionId: 'invalid' } : {},
    })
    const batches: unknown[] = []
    const adapter = new XyoRuntimeVM(() => f.engine, model, {
      discardPenLayer() {},
      penBatchAtomic: (events) => {
        if (events.length) batches.push(events)
      },
    })
    adapter.greenFlag()
    await adapter.settled()
    bad = true
    adapter.step()
    await expect(adapter.settled()).rejects.toThrow('question identity')
    expect(batches).toEqual([])
    adapter.dispose()
    await adapter.settled()
  })
  test('rejects pen commands without an explicitly enabled renderer', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    const original = f.engine.snapshot.bind(f.engine)
    f.engine.snapshot = () => ({ ...(original() as object), penEvents: [{ type: 'clear' }] })
    const adapter = new XyoRuntimeVM(() => f.engine, model)
    adapter.greenFlag()
    await expect(adapter.settled()).rejects.toThrow('without an enabled renderer')
    adapter.dispose()
    await adapter.settled()
  })
  test('reports engine failures and allows retry', async () => {
    const model = new ScratchVM(),
      f = fixture(model)
    let attempts = 0
    const adapter = new XyoRuntimeVM(() => {
      if (!attempts++) throw new Error('load failed')
      return f.engine
    }, model)
    const errors: unknown[] = []
    model.on('ERROR', (e) => errors.push(e))
    adapter.greenFlag()
    await expect(adapter.settled()).rejects.toThrow('load failed')
    expect(errors).toHaveLength(1)
    adapter.greenFlag()
    await adapter.settled()
    expect(f.calls).toContain('compiled')
    adapter.dispose()
    await adapter.settled()
  })
})
