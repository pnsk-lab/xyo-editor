import { describe, expect, it } from 'bun:test'
import { PenBridge, type PenAbiModule } from './pen-bridge'

function fixture() {
  let consumed = 0
  let count = 2
  let kind = 1
  let failConsume = false
  const values = [0, 0.5, 1, 1, 5, 1, 2, 3, 4]
  const module: PenAbiModule = {
    _xyo_browser_pen_enable: () => 1,
    _xyo_browser_pen_count: () => count,
    _xyo_browser_pen_kind: (_h, i) => i === 0 ? kind : 3,
    _xyo_browser_pen_value: (_h, _i, field) => values[field],
    _xyo_browser_pen_consume: () => { ++consumed; return +!failConsume },
    _xyo_browser_error: () => 1,
    UTF8ToString: () => 'pen failed',
  }
  return { module, values, consumed: () => consumed, setCount: (n: number) => { count = n }, setKind: (n: number) => { kind = n }, failConsume: () => { failConsume = true } }
}

describe('isolated experimental pen ABI adapter', () => {
  it('copies a complete ordered batch and consumes once', () => {
    const f = fixture(), bridge = new PenBridge(f.module, 1)
    expect(bridge.drain()).toEqual([{ type: 'line', rgba: [0, 0.5, 1, 1], diameter: 5, x0: 1, y0: 2, x1: 3, y1: 4 }, { type: 'clear' }])
    expect(f.consumed()).toBe(1)
  })
  it('never consumes malformed or failed batches', () => {
    for (const invalid of ['count', 'kind', 'value'] as const) {
      const f = fixture(), bridge = new PenBridge(f.module, 1)
      if (invalid === 'count') f.setCount(-1)
      if (invalid === 'kind') f.setKind(7)
      if (invalid === 'value') f.values[2] = NaN
      expect(() => bridge.drain()).toThrow('pen failed')
      expect(f.consumed()).toBe(0)
    }
    const f = fixture(), bridge = new PenBridge(f.module, 1)
    f.failConsume()
    expect(() => bridge.drain()).toThrow('pen failed')
  })
})
