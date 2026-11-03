/** Isolated opt-in polling ABI. Never call from inside WASM. */
export type PenEvent =
  | { type: 'clear' }
  | { type: 'line'; rgba: [number, number, number, number]; diameter: number; x0: number; y0: number; x1: number; y1: number }

export interface PenAbiModule {
  _xyo_browser_pen_enable(handle: number): number
  _xyo_browser_pen_count(handle: number): number
  _xyo_browser_pen_kind(handle: number, index: number): number
  _xyo_browser_pen_value(handle: number, index: number, field: number): number
  _xyo_browser_pen_consume(handle: number): number
  _xyo_browser_error(handle: number): number
  UTF8ToString(pointer: number): string
}

export class PenBridge {
  static readonly limit = 4096
  constructor(private readonly module: PenAbiModule, private readonly handle: number) {
    if (!handle || !module._xyo_browser_pen_enable(handle)) throw new Error('Could not enable experimental pen sink')
  }
  private fail(): never {
    const ptr = this.module._xyo_browser_error(this.handle)
    throw new Error(ptr ? this.module.UTF8ToString(ptr) : 'Invalid experimental pen batch')
  }
  drain(): PenEvent[] {
    const { module: m, handle: h } = this
    const count = m._xyo_browser_pen_count(h)
    if (!Number.isInteger(count) || count < 0 || count > PenBridge.limit) return this.fail()
    const result: PenEvent[] = []
    for (let index = 0; index < count; ++index) {
      const kind = m._xyo_browser_pen_kind(h, index)
      if (kind === 3) { result.push({ type: 'clear' }); continue }
      if (kind !== 1 && kind !== 2) return this.fail()
      const values = Array.from({ length: 9 }, (_, field) => m._xyo_browser_pen_value(h, index, field))
      if (values.some(value => !Number.isFinite(value)) || values.slice(0, 4).some(value => value < 0 || value > 1) || values[4] < 0) return this.fail()
      result.push({ type: 'line', rgba: values.slice(0, 4) as [number, number, number, number], diameter: values[4], x0: values[5], y0: values[6], x1: values[7], y1: values[8] })
    }
    // No batch is exposed unless every field and the atomic consume succeeds.
    if (!m._xyo_browser_pen_consume(h)) return this.fail()
    return result
  }
}
