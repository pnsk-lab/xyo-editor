import { describe, expect, it } from 'bun:test'
import { XyoHeadlessRuntime, type XyoModule, type RendererCallbacksOptions } from '../src/index'

function fake() {
  const calls: unknown[] = []
  const module: XyoModule = {
    HEAPU8: new Uint8Array(1024),
    _malloc: () => 4, _free: ptr => { calls.push(['free', ptr]) },
    UTF8ToString: ptr => ptr === 1 ? '{"targets":[]}' : 'load failed',
    _xyo_browser_create: () => 1, _xyo_browser_destroy: h => { calls.push(['destroy', h]); return 1 },
    _xyo_browser_load_sb3: (_h, ptr, size) => { calls.push([...module.HEAPU8.slice(ptr, ptr + size)]); return 1 },
    _xyo_browser_green_flag: () => 1, _xyo_browser_stop: () => 1, _xyo_browser_step: () => 1,
    _xyo_browser_key: (h, p, n, down, code) => { calls.push(['key', h, new TextDecoder().decode(module.HEAPU8.slice(p, p + n)), down, code]); return 1 },
    _xyo_browser_mouse: (...args) => { calls.push(['mouse', ...args]); return 1 },
    _xyo_browser_wheel: (...args) => { calls.push(['wheel', ...args]); return 1 },
    _xyo_browser_answer: (h, p, n) => { calls.push(['answer', h, new TextDecoder().decode(module.HEAPU8.slice(p, p + n))]); return 1 },
    _xyo_browser_renderer_attach: () => 1, _xyo_browser_renderer_detach: () => 1,
    _xyo_browser_snapshot: () => 1, _xyo_browser_error: () => 2, _xyo_browser_capabilities: () => 1,
    _xyo_browser_set_compiled: (h, enabled) => { calls.push(['compiled', h, enabled]); return 1 },
    _xyo_browser_compiled_enabled: () => 0,
    _xyo_browser_compile_attempts: () => 2, _xyo_browser_compile_successes: () => 1,
    _xyo_browser_compiled_executions: () => 1, _xyo_browser_compile_fallbacks: () => 1,
    _xyo_browser_compiled_live_modules: () => 0,
  }
  return { module, calls }
}

describe('headless WASM host', () => {
  it('copies archives and frees temporary memory', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    runtime.loadSb3(Uint8Array.from([1, 2, 3]))
    expect(calls).toEqual([[1, 2, 3], ['free', 4]])
    expect(runtime.supportsCompiledExecution).toBe(false)
    expect(runtime.snapshot()).toEqual({ targets: [] })
    runtime.dispose(); runtime.dispose()
    expect(calls.filter(entry => Array.isArray(entry) && entry[0] === 'destroy')).toHaveLength(1)
    expect(() => runtime.step()).toThrow('disposed')
  })
  it('selects execution mode and exposes module-wide statistics', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    runtime.greenFlagCompiled(); runtime.greenFlagInterpreter()
    expect(calls).toEqual([['compiled', 1, 1], ['compiled', 1, 0]])
    expect(runtime.compileStats).toEqual({ attempts: 2, successes: 1, executions: 1, fallbacks: 1, liveModules: 0 })
    runtime.dispose()
  })
  it('retains heap-backed input across memory growth', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    module.HEAPU8.set([7, 8, 9], 20)
    const source = module.HEAPU8.subarray(20, 23)
    module._malloc = () => { source.fill(0); module.HEAPU8 = new Uint8Array(2048); return 4 }
    runtime.loadSb3(source)
    expect(calls).toEqual([[7, 8, 9], ['free', 4]])
    runtime.dispose()
  })
  it('forwards and validates input and frees UTF-8 allocations', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    runtime.key('ArrowLeft', true, 37); runtime.key('ArrowLeft', false, 37)
    runtime.mouse(120, 90, 480, 360, true, 0); runtime.wheel(2, -3); runtime.answer('はい😀')
    expect(calls).toEqual([
      ['key', 1, 'ArrowLeft', 1, 37], ['free', 4], ['key', 1, 'ArrowLeft', 0, 37], ['free', 4],
      ['mouse', 1, 120, 90, 480, 360, 1, 0, 0], ['wheel', 1, 2, -3], ['answer', 1, 'はい😀'], ['free', 4],
    ])
    expect(() => runtime.mouse(0, 0, 0, 360, false)).toThrow('Invalid mouse')
    expect(() => runtime.wheel(NaN, 0)).toThrow('Invalid wheel')
    expect(() => runtime.key('a', true, 2 ** 32)).toThrow('Invalid key code')
    module._xyo_browser_answer = () => 0
    expect(() => runtime.answer('bad')).toThrow('load failed')
    expect(calls.at(-1)).toEqual(['free', 4])
    runtime.dispose()
    expect(() => runtime.answer('late')).toThrow('disposed')
  })
  it('owns renderer callback tables across replacement, failure and destruction', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    let ptr = 8, id = 0, failAttach = false, failDetach = false, failDestroy = false
    module._malloc = size => { const p = ptr; ptr += size; return p }
    module.addFunction = () => ++id
    module.removeFunction = i => { calls.push(['remove', i]) }
    module._xyo_browser_renderer_attach = (_h, p, n) => { calls.push(['attach', p, n]); return failAttach ? 0 : 1 }
    module._xyo_browser_renderer_detach = () => { calls.push(['detach']); return failDetach ? 0 : 1 }
    module._xyo_browser_destroy = () => { calls.push(['destroy']); return failDestroy ? 0 : 1 }
    const options = { renderer: {}, sync: () => ({}), fenceRect: () => [0,0,0,0], pickToScratch: () => [0,0], setDrawableOrder: () => 0, destroyDrawable: () => {}, visualChange: () => {}, collisionMode: 'approximate' } as unknown as RendererCallbacksOptions
    runtime.attachRenderer(options)
    expect(calls).toEqual([['attach', 8, 88]])
    runtime.attachRenderer(options)
    expect(calls[1]).toEqual(['attach', 96, 88])
    expect(calls.slice(2, 23)).toEqual(Array.from({ length: 21 }, (_, i) => ['remove', i + 1]))
    expect(calls[23]).toEqual(['free', 8])
    failAttach = true
    expect(() => runtime.attachRenderer(options)).toThrow('load failed')
    expect(calls[24]).toEqual(['attach', 184, 88])
    expect(calls.slice(25, 46)).toEqual(Array.from({ length: 21 }, (_, i) => ['remove', i + 43]))
    expect(calls[46]).toEqual(['free', 184])
    failDetach = true
    expect(() => runtime.detachRenderer()).toThrow('load failed')
    expect(calls.at(-1)).toEqual(['detach']) // previous callbacks remain live
    failDestroy = true
    expect(() => runtime.dispose()).toThrow('Could not destroy')
    expect(calls.at(-1)).toEqual(['destroy'])
    failDestroy = false; failDetach = false
    runtime.detachRenderer()
    const detachAt = calls.findLastIndex(c => Array.isArray(c) && c[0] === 'detach')
    expect(calls.slice(detachAt + 1, detachAt + 22)).toEqual(Array.from({ length: 21 }, (_, i) => ['remove', i + 22]))
    expect(calls[detachAt + 22]).toEqual(['free', 96])
    failAttach = false
    runtime.attachRenderer(options)
    runtime.dispose()
    const destroyAt = calls.findLastIndex(c => Array.isArray(c) && c[0] === 'destroy')
    expect(calls[destroyAt + 1]).toEqual(['remove', 64])
    expect(calls.at(-1)).toEqual(['free', 272])
    expect(() => runtime.attachRenderer(options)).toThrow('disposed')
  })
  it('cleans up partial callback registration and rejects a legacy module', () => {
    const { module, calls } = fake(), runtime = new XyoHeadlessRuntime(module)
    const options = { renderer: {}, sync: () => ({}), fenceRect: () => [0,0,0,0], pickToScratch: () => [0,0], setDrawableOrder: () => 0, destroyDrawable: () => {}, visualChange: () => {}, collisionMode: 'approximate' } as unknown as RendererCallbacksOptions
    expect(() => runtime.attachRenderer(options)).toThrow('require the ESM')
    let n = 0
    module.addFunction = () => ++n === 3 ? 0 : n
    module.removeFunction = i => { calls.push(['remove', i]) }
    expect(() => runtime.attachRenderer(options)).toThrow('Unable to register callback')
    expect(calls).toEqual([['remove', 1], ['remove', 2], ['free', 4]])
    runtime.dispose()
  })
  it('frees temporary memory on load failure', () => {
    const { module, calls } = fake()
    module._xyo_browser_load_sb3 = () => 0
    const runtime = new XyoHeadlessRuntime(module)
    expect(() => runtime.loadSb3(Uint8Array.from([1]))).toThrow('load failed')
    expect(calls).toEqual([['free', 4]])
    runtime.dispose()
  })
})
