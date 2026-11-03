/** Experimental, disconnected collision-question admission checks. No runtime ABI. */
export type CollisionIdentity = Readonly<{ epoch: number; serial: number }>
export type CollisionTarget = Readonly<{
  identity: CollisionIdentity
  /** Predecoded costume cache key, including content/version and decode options. */
  assetKey: string
}>
export type CollisionQuestion = Readonly<{
  epoch: number
  /** Complete live target set, captured by native code at the question point. */
  targets: readonly CollisionTarget[]
  subject: CollisionIdentity
  candidates: readonly CollisionIdentity[]
}>
export type CollisionAdmission =
  | { status: 'degraded'; reason: string }

/**
 * Owns identities for one runtime attachment. Never expose native addresses as
 * identity: allocator reuse and cloned targets otherwise make stale IDs valid.
 * Calls are synchronous, on the WASM worker, and must not call runtime APIs.
 * This class only checks prerequisites; it deliberately never returns an answer.
 */
export class CollisionQuestionGate {
  private epoch = 0
  private nextSerial = 1
  private live = new Set<number>()
  private decoded = new Set<string>()
  private entered = false

  /** Call only outside runtime callbacks, on initial attach or successful replacement. */
  reset(): number {
    if (this.entered) throw new Error('collision gate reentry')
    if (!Number.isSafeInteger(this.epoch + 1)) throw new Error('collision epoch exhausted')
    this.epoch++
    this.nextSerial = 1
    this.live.clear()
    this.decoded.clear()
    return this.epoch
  }

  /** Native lifecycle integration must register originals and clones before questions. */
  create(): CollisionIdentity {
    if (this.entered) throw new Error('collision gate reentry')
    if (!this.epoch || !Number.isSafeInteger(this.nextSerial)) throw new Error('collision identity unavailable')
    const serial = this.nextSerial++
    this.live.add(serial)
    return Object.freeze({ epoch: this.epoch, serial })
  }

  remove(id: CollisionIdentity): void {
    if (this.entered) throw new Error('collision gate reentry')
    if (id.epoch !== this.epoch || !this.live.delete(id.serial)) throw new Error('unknown collision identity')
  }

  /** Only call after successful decode, before entering a WASM runtime operation. */
  markDecoded(assetKey: string): void {
    if (this.entered) throw new Error('collision gate reentry')
    if (!assetKey) throw new Error('empty asset key')
    this.decoded.add(assetKey)
  }

  /** A failed/replaced/evicted image must be invalidated before runtime execution. */
  invalidateAsset(assetKey: string): void {
    if (this.entered) throw new Error('collision gate reentry')
    this.decoded.delete(assetKey)
  }

  inspect(q: CollisionQuestion): CollisionAdmission {
    if (this.entered) return { status: 'degraded', reason: 'reentrant question' }
    this.entered = true
    try {
      if (!this.epoch || q.epoch !== this.epoch) return { status: 'degraded', reason: 'stale epoch' }
      const ids = new Set<number>()
      for (const t of q.targets) {
        if (t.identity.epoch !== this.epoch || !this.live.has(t.identity.serial) || ids.has(t.identity.serial))
          return { status: 'degraded', reason: 'invalid or duplicate target identity' }
        ids.add(t.identity.serial)
        if (!t.assetKey || !this.decoded.has(t.assetKey)) return { status: 'degraded', reason: 'asset not decoded' }
      }
      if (ids.size !== this.live.size) return { status: 'degraded', reason: 'incomplete target set' }
      const contains = (id: CollisionIdentity) => id.epoch === this.epoch && ids.has(id.serial)
      if (!contains(q.subject) || q.candidates.some((id) => !contains(id)))
        return { status: 'degraded', reason: 'unknown question target' }
      // ScratchCanvasRenderer is approximate. Neither a positive nor a negative
      // result is safe to pass off as exact; no backend is connected here.
      return { status: 'degraded', reason: 'exact synchronous collision backend unavailable' }
    } catch {
      // A malformed question or throwing accessor must not become a false answer.
      return { status: 'degraded', reason: 'invalid question' }
    } finally {
      this.entered = false
    }
  }
}
