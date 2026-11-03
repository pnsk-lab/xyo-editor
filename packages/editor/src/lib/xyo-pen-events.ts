import type { PenEvent } from '../../../xyo-cpp-wasm/src/pen-bridge'

/** Narrow renderer interface; called only after snapshot validation and generation check. */
export interface XyoPenRenderer {
  discardPenLayer(): void
  penBatchAtomic(operations: readonly ({ type: 'clear' } | { type: 'line'; line: { x1: number; y1: number; x2: number; y2: number; size: number; color: string; transparency: number } })[]): void
}

/** Validate/copy the entire untrusted worker batch before touching the renderer. */
export function prepareXyoPenBatch(input: unknown): PenEvent[] {
  if (!Array.isArray(input) || input.length > 4096) throw new Error('Invalid xyo-cpp pen batch')
  return Array.from(input, (item: unknown, index): PenEvent => {
    if (!Object.hasOwn(input, index) || !item || typeof item !== 'object') throw new Error('Invalid xyo-cpp pen event')
    const event = item as Record<string, unknown>
    if (event.type === 'clear') return { type: 'clear' }
    if (event.type !== 'line' || !Array.isArray(event.rgba) || event.rgba.length !== 4 ||
        !Array.from(event.rgba).every((v: unknown, i: number) => Object.hasOwn(event.rgba as unknown[], i) && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid xyo-cpp pen event')
    const fields = [event.diameter, event.x0, event.y0, event.x1, event.y1]
    if (!fields.every(v => typeof v === 'number' && Number.isFinite(v)) || (event.diameter as number) < 0) throw new Error('Invalid xyo-cpp pen event')
    return { type: 'line', rgba: [...event.rgba] as [number, number, number, number], diameter: event.diameter as number,
      x0: event.x0 as number, y0: event.y0 as number, x1: event.x1 as number, y1: event.y1 as number }
  })
}

export function applyXyoPenBatch(renderer: XyoPenRenderer, batch: readonly PenEvent[]): void {
  const byte = (value: number) => Math.round(value * 255)
  const operations = batch.map(event => {
    if (event.type === 'clear') return { type: 'clear' as const }
    const [r, g, b, a] = event.rgba
    return { type: 'line' as const, line: { x1: event.x0, y1: event.y0, x2: event.x1, y2: event.y1, size: event.diameter,
      color: `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`, transparency: (1 - a) * 100 } }
  })
  renderer.penBatchAtomic(operations)
}
