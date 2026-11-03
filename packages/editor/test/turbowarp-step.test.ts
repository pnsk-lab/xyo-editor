import { describe, expect, test } from 'bun:test'
import { createTurboWarpStep } from '../src/lib/turbowarp-step'

function fixture(running = true) {
  const calls: string[] = []
  let disposed = false,
    loading = false
  let callback = () => {}
  const loop = {
    running,
    stop() {
      calls.push('stop')
      this.running = false
    },
    start() {
      calls.push('start')
      this.running = true
    },
    stepCallback() {
      calls.push('step')
      callback()
    },
  }
  const host = {
    runtime: { frameLoop: loop },
    isDisposed: () => disposed,
    isLoading: () => loading,
  }
  const stepper = createTurboWarpStep(host)
  return {
    loop,
    host,
    stepper,
    calls,
    onStep: (fn: () => void) => {
      callback = fn
    },
    dispose: () => {
      disposed = true
    },
    load: () => {
      loading = true
    },
  }
}

describe('TurboWarp single frame', () => {
  test('pauses the scheduler and restores its previous state', () => {
    const f = fixture()
    f.stepper.step()
    expect(f.calls).toEqual(['stop', 'step', 'start'])
    expect(f.loop.running).toBe(true)
    const paused = fixture(false)
    paused.stepper.step()
    expect(paused.calls).toEqual(['step'])
    expect(paused.loop.running).toBe(false)
  })
  test('rejects loading and disposed hosts', () => {
    const f = fixture()
    f.load()
    expect(() => f.stepper.step()).toThrow('loading')
    expect(f.calls).toEqual([])
    const g = fixture()
    g.dispose()
    expect(() => g.stepper.step()).toThrow('disposed')
    expect(g.calls).toEqual([])
  })
  test('prevents reentry even through another helper', () => {
    const f = fixture()
    const other = createTurboWarpStep(f.host)
    f.onStep(() => expect(() => other.step()).toThrow('already in progress'))
    f.stepper.step()
    expect(f.calls).toEqual(['stop', 'step', 'start'])
  })
  test('honors stop requests and lifecycle changes during the callback', () => {
    for (const action of ['stop', 'dispose', 'load'] as const) {
      const f = fixture()
      f.onStep(() => {
        if (action === 'stop') createTurboWarpStep(f.host).requestStop()
        else if (action === 'dispose') f.dispose()
        else f.load()
      })
      f.stepper.step()
      expect(f.calls).toEqual(['stop', 'step'])
      expect(f.loop.running).toBe(false)
    }
  })
  test('restores on synchronous callback failure and releases the lock', () => {
    const f = fixture()
    const error = new Error('step failure')
    f.onStep(() => {
      throw error
    })
    expect(() => f.stepper.step()).toThrow(error)
    expect(f.calls).toEqual(['stop', 'step', 'start'])
    f.onStep(() => {})
    f.stepper.step()
    expect(f.loop.running).toBe(true)
  })
  test('does not restart twice if callback already started the loop', () => {
    const f = fixture()
    f.onStep(() => f.loop.start())
    f.stepper.step()
    expect(f.calls).toEqual(['stop', 'step', 'start'])
  })
  test('reports stop and restoration failures without losing the original error', () => {
    const f = fixture()
    const error = new Error('stop failure')
    f.loop.stop = () => {
      throw error
    }
    expect(() => f.stepper.step()).toThrow(error)
    expect(f.calls).toEqual([])
    const g = fixture()
    const first = new Error('step failure')
    const second = new Error('start failure')
    g.onStep(() => {
      throw first
    })
    g.loop.start = () => {
      throw second
    }
    try {
      g.stepper.step()
      throw new Error('expected failure')
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError)
      expect((e as AggregateError).errors).toEqual([first, second])
    }
  })
})
