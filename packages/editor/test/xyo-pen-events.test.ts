import { describe, expect, it } from 'bun:test'
import { applyXyoPenBatch, prepareXyoPenBatch } from '../src/lib/xyo-pen-events'

describe('experimental xyo pen events', () => {
  it('validates and copies before ordered renderer application', () => {
    const raw = [
      { type: 'line', rgba: [1, 0.5, 0, 0.25], diameter: 2, x0: 1, y0: 2, x1: 3, y1: 4 },
      { type: 'clear' },
    ]
    const batch = prepareXyoPenBatch(raw)
    raw[0].rgba![0] = 0
    const calls: unknown[] = []
    applyXyoPenBatch({ discardPenLayer() {}, penBatchAtomic: (ops) => calls.push(...ops) }, batch)
    expect(calls).toEqual([
      {
        type: 'line',
        line: { x1: 1, y1: 2, x2: 3, y2: 4, size: 2, color: 'rgb(255, 128, 0)', transparency: 75 },
      },
      { type: 'clear' },
    ])
  })
  it('rejects malformed and excessive batches', () => {
    expect(() =>
      prepareXyoPenBatch([
        { type: 'clear' },
        { type: 'line', rgba: [1, 0, 0, 1], diameter: 1, x0: NaN, y0: 0, x1: 0, y1: 0 },
      ]),
    ).toThrow()
    expect(() =>
      prepareXyoPenBatch(Array.from({ length: 4097 }, () => ({ type: 'clear' }))),
    ).toThrow()
    const hole = [{ type: 'clear' }, , { type: 'clear' }]
    expect(() => prepareXyoPenBatch(structuredClone(hole))).toThrow()
    expect(() =>
      prepareXyoPenBatch([
        { type: 'line', rgba: new Array(4), diameter: 1, x0: 0, y0: 0, x1: 0, y1: 0 },
      ]),
    ).toThrow()
  })
})
