/**
 * Disconnected integer-grid experiment, NOT a Scratch renderer or runtime ABI.
 * Coordinates are integer pixel-cell origins in a shared Cartesian grid. Alpha
 * greater than zero occupies a cell. There is no scaling, rotation, filtering,
 * effect, color, pen, visibility or layer semantics in this model.
 * Callers must never treat this model as Scratch-exact without proving that the
 * native scene maps to it. Unsupported Scratch scenes must fail before calling.
 */
export type GridIdentity = Readonly<{ epoch: number; serial: number }>
export type GridTarget = Readonly<{ id: GridIdentity; asset: string; x: number; y: number }>
export type GridQuestion = Readonly<{
  epoch: number
  targets: readonly GridTarget[]
  subject: GridIdentity
  candidates: readonly GridIdentity[]
}>
export type GridAnswer = { status: 'ok'; touching: boolean } | { status: 'unsupported'; reason: string }
type Mask = { width: number; height: number; alpha: Uint8Array }

/** Asset registration copies decoded bytes before execution, never during a query. */
export class ExperimentalPixelCollision {
  private masks = new Map<string, Mask>()
  private entered = false

  register(key: string, width: number, height: number, alpha: Uint8Array): void {
    if (this.entered) throw new Error('collision reentry')
    if (!key || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        !Number.isSafeInteger(width * height) || !(alpha instanceof Uint8Array) || alpha.length !== width * height)
      throw new Error('invalid decoded mask')
    this.masks.set(key, { width, height, alpha: alpha.slice() })
  }

  invalidate(key: string): void {
    if (this.entered) throw new Error('collision reentry')
    this.masks.delete(key)
  }

  question(q: GridQuestion): GridAnswer {
    if (this.entered) return { status: 'unsupported', reason: 'reentrant question' }
    this.entered = true
    try {
      if (!Number.isSafeInteger(q.epoch) || q.epoch <= 0 || !Array.isArray(q.targets) || !Array.isArray(q.candidates))
        throw new Error('invalid question')
      const targets = new Map<number, { x: number; y: number; mask: Mask }>()
      for (const t of q.targets) {
        const serial = t.id.serial, x = t.x, y = t.y, mask = this.masks.get(t.asset)
        if (t.id.epoch !== q.epoch || !Number.isSafeInteger(serial) || serial <= 0 || targets.has(serial))
          throw new Error('invalid identity')
        if (!mask) throw new Error('asset not decoded')
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(x + mask.width) || !Number.isSafeInteger(y + mask.height))
          throw new Error('unsupported transform')
        targets.set(serial, { x, y, mask })
      }
      const resolve = (id: GridIdentity) => {
        const t = id.epoch === q.epoch && targets.get(id.serial)
        if (!t) throw new Error('unknown identity')
        return t
      }
      const a = resolve(q.subject)
      // Validate every candidate before returning any result, even after a hit.
      const candidates = q.candidates.map(resolve)
      for (const b of candidates) {
        const left = Math.max(a.x, b.x), right = Math.min(a.x + a.mask.width, b.x + b.mask.width)
        const bottom = Math.max(a.y, b.y), top = Math.min(a.y + a.mask.height, b.y + b.mask.height)
        for (let y = bottom; y < top; y++) for (let x = left; x < right; x++) {
          if (a.mask.alpha[(y - a.y) * a.mask.width + x - a.x] && b.mask.alpha[(y - b.y) * b.mask.width + x - b.x])
            return { status: 'ok', touching: true }
        }
      }
      return { status: 'ok', touching: false }
    } catch (error) {
      return { status: 'unsupported', reason: error instanceof Error ? error.message : 'invalid question' }
    } finally {
      this.entered = false
    }
  }
}
