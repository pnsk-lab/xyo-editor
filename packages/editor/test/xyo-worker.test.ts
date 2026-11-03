import { describe, expect, test } from 'bun:test'
import { XyoWorkerClient, type XyoWorkerPort } from '../src/lib/xyo-worker-client'
import { createXyoWorkerHost } from '../src/lib/xyo-worker-host'
import type {
  XyoWorkerRequest,
  XyoWorkerResponse,
  XyoWorkerRuntime,
} from '../src/lib/xyo-worker-protocol'

function fixture() {
  const calls: string[] = []
  const runtime: XyoWorkerRuntime = {
    loadSb3: (b) => {
      calls.push(`load:${b[0]}`)
    },
    greenFlagInterpreter: () => {
      calls.push('interpreter')
    },
    greenFlagCompiled: () => {
      calls.push('compiled')
    },
    step: () => {
      calls.push('step')
    },
    stop: () => {
      calls.push('stop')
    },
    key: (key, down, code) => {
      calls.push(`key:${key}:${down}:${code}`)
    },
    mouse: (x, y, w, h, down, b, drag) => {
      calls.push(`mouse:${x}:${y}:${w}:${h}:${down}:${b}:${drag}`)
    },
    wheel: (x, y) => {
      calls.push(`wheel:${x}:${y}`)
    },
    answer: (text) => {
      calls.push(`answer:${text}`)
    },
    snapshot: () => ({ targets: [] }),
    compileStats: { attempts: 2 },
    supportsCompiledExecution: true,
    dispose: () => {
      calls.push('dispose')
    },
  }
  const listeners = new Map<string, Set<(event: any) => void>>()
  let terminated = 0
  const host = createXyoWorkerHost(
    () => runtime,
    (data: XyoWorkerResponse) =>
      queueMicrotask(() => listeners.get('message')?.forEach((f) => f({ data }))),
  )
  const port: XyoWorkerPort = {
    postMessage: (message: XyoWorkerRequest) => host(message),
    terminate: () => {
      terminated++
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn)
    },
  }
  return { calls, runtime, port, listeners, terminated: () => terminated }
}

describe('xyo headless worker', () => {
  test('serializes execution and forwards input, snapshot and module-wide stats', async () => {
    const f = fixture(),
      client = new XyoWorkerClient(() => f.port)
    await client.loadSb3(new Uint8Array([5]))
    await client.greenFlagInterpreter()
    await client.greenFlag()
    await Promise.all([
      client.step(),
      client.key('a', true, 65),
      client.mouse(1, 2, 480, 360, true, 0, false),
      client.wheel(3, 4),
      client.answer('ok'),
    ])
    expect(await client.snapshot()).toEqual({ targets: [] })
    expect(await client.stats()).toEqual({
      supportsCompiledExecution: true,
      compileStats: { attempts: 2 },
    })
    expect(f.calls).toEqual([
      'load:5',
      'interpreter',
      'compiled',
      'step',
      'key:a:true:65',
      'mouse:1:2:480:360:true:0:false',
      'wheel:3:4',
      'answer:ok',
    ])
    await client.dispose()
    expect(f.calls.at(-1)).toBe('dispose')
    expect(f.terminated()).toBe(1)
  })
  test('forwards question identities and preserves stale-answer results', async () => {
    const f = fixture(),
      client = new XyoWorkerClient(() => f.port)
    f.runtime.answerIfQuestion = (id, text) => {
      f.calls.push(`conditional:${id}:${text}`)
      return id === '8'
    }
    await client.loadSb3(new Uint8Array([1]))
    expect(await client.answerIfQuestion('7', 'old')).toBe(false)
    expect(await client.answerIfQuestion('8', 'new')).toBe(true)
    expect(f.calls).toEqual(['load:1', 'conditional:7:old', 'conditional:8:new'])
    client.terminate()
  })
  test('stop invalidates in-flight flag; late completion cannot satisfy another request', async () => {
    const f = fixture()
    let finish!: () => void, started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    f.runtime.greenFlagCompiled = () => {
      started()
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    const client = new XyoWorkerClient(() => f.port)
    await client.loadSb3(new Uint8Array([1]))
    const flag = client.greenFlag()
    const rejected = flag.then(
      () => 'resolved',
      (error) => error.message,
    )
    await entered
    const stop = client.stop()
    finish()
    expect(await rejected).toContain('Stale')
    await stop
    expect(f.calls).toEqual(['load:1', 'stop'])
    client.terminate()
  })
  test('hard termination rejects pending work immediately and ignores late responses', async () => {
    const f = fixture()
    let finish!: () => void, started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    f.runtime.step = () => {
      started()
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    const client = new XyoWorkerClient(() => f.port)
    await client.loadSb3(new Uint8Array([1]))
    const step = client.step(),
      rejected = step.then(
        () => 'resolved',
        (error) => error.message,
      )
    await entered
    client.terminate()
    client.terminate()
    expect(await rejected).toContain('Worker terminated')
    finish()
    await expect(client.snapshot()).rejects.toThrow()
    expect(f.terminated()).toBe(1)
  })
  test('stop after stale initialization does not stop an unloaded runtime', async () => {
    const f = fixture(),
      responses: XyoWorkerResponse[] = []
    let finish!: (runtime: XyoWorkerRuntime) => void, started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const initialized = new Promise<XyoWorkerRuntime>((resolve) => {
      finish = resolve
    })
    f.runtime.stop = () => {
      throw new Error('No project loaded')
    }
    const host = createXyoWorkerHost(
      () => {
        started()
        return initialized
      },
      (response) => responses.push(response),
    )
    host({ id: 1, generation: 1, operation: { type: 'load', bytes: new Uint8Array([1]) } })
    await entered
    host({ id: 2, generation: 2, operation: { type: 'stop' } })
    finish(f.runtime)
    while (responses.length < 2) await Promise.resolve()
    expect(responses[0].ok).toBe(false)
    expect(responses[1]).toEqual({ id: 2, generation: 2, ok: true })
    expect(f.calls).toEqual([])
  })
  test('reports operation errors and continues processing', async () => {
    const f = fixture(),
      client = new XyoWorkerClient(() => f.port)
    f.runtime.loadSb3 = () => {
      throw new Error('bad sb3')
    }
    await expect(client.loadSb3(new Uint8Array([1]))).rejects.toThrow('bad sb3')
    expect(await client.snapshot()).toEqual({ targets: [] })
    client.terminate()
  })
})
