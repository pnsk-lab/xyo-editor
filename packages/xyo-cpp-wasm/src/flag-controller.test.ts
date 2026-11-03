import { describe, expect, test } from 'bun:test'
import { FlagCompileController, type CompiledHeadlessRuntime } from './flag-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const calls: string[] = []
  const runtime: CompiledHeadlessRuntime = {
    loadSb3: b => { calls.push(`load:${b[0]}`) },
    greenFlag: () => { calls.push('flag') },
    step: () => { calls.push('step') },
    stop: () => { calls.push('stop') },
    dispose: () => { calls.push('dispose') },
  }
  return { calls, runtime }
}

describe('flag compile controller', () => {
  test('captures, loads, compiles and steps in order', async () => {
    const { calls, runtime } = fixture()
    const controller = new FlagCompileController(runtime, async () => { calls.push('capture'); return new Uint8Array([3]) })
    const flag = controller.flag()
    const step = controller.step()
    expect(await flag).toBe('applied')
    expect(await step).toBe('applied')
    expect(calls).toEqual(['capture', 'load:3', 'flag', 'step'])
  })

  test('rapid flag invalidates pending capture and old queued step', async () => {
    const { calls, runtime } = fixture()
    const first = deferred<Uint8Array>()
    let captures = 0
    const controller = new FlagCompileController(runtime, () => ++captures === 1 ? first.promise : Promise.resolve(new Uint8Array([2])))
    const old = controller.flag()
    await Promise.resolve()
    const step = controller.step()
    const next = controller.flag()
    first.resolve(new Uint8Array([1]))
    expect(await old).toBe('stale')
    expect(await step).toBe('stale')
    expect(await next).toBe('applied')
    expect(calls).toEqual(['load:2', 'flag'])
  })

  test.each(['edited', 'stop', 'dispose'] as const)('%s invalidates in-flight compilation and serializes cleanup', async action => {
    const { calls, runtime } = fixture()
    const compiling = deferred<void>()
    runtime.greenFlag = () => { calls.push('flag'); return compiling.promise }
    const controller = new FlagCompileController(runtime, async () => new Uint8Array([1]))
    const flag = controller.flag()
    // Wait until greenFlag is entered, without relying on a timer.
    while (!calls.includes('flag')) await Promise.resolve()
    const step = controller.step()
    const cleanup = controller[action]()
    expect(calls).toEqual(['load:1', 'flag'])
    compiling.resolve()
    expect(await flag).toBe('stale')
    expect(await step).toBe('stale')
    await cleanup
    expect(calls).toEqual(['load:1', 'flag', action === 'dispose' ? 'dispose' : 'stop'])
    if (action === 'dispose') expect(controller.dispose()).toBe(cleanup)
  })

  test('errors propagate when current, stale errors are ignored and queue recovers', async () => {
    const { calls, runtime } = fixture()
    const pending = deferred<Uint8Array>()
    let count = 0
    const controller = new FlagCompileController(runtime, () => ++count === 1 ? pending.promise : Promise.resolve(new Uint8Array([7])))
    const old = controller.flag()
    await Promise.resolve()
    const stop = controller.stop()
    pending.reject(new Error('obsolete'))
    expect(await old).toBe('stale')
    await stop
    runtime.greenFlag = () => { throw new Error('compile failed') }
    await expect(controller.flag()).rejects.toThrow('compile failed')
    expect(await controller.step()).toBe('stale')
    runtime.greenFlag = () => { calls.push('flag') }
    expect(await controller.flag()).toBe('applied')
    expect(calls).toEqual(['stop', 'load:7', 'load:7', 'flag'])
  })
})
