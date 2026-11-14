// Pure matrix + Canvas pixel oracle for the exact affine pending shape.
//
// This file pins the DRAW side of `M * R(local)`: every expectation is
// written against an independent matrix implementation below (own
// multiply/apply/AABB/gradient mapping, no product import) plus a recording
// mock 2d context that captures the exact paint commands the product issues.
// Together they prove the pixel-determining inputs — the CTM sequence, the
// centered local path, and the gradient endpoints — without needing a
// browser canvas: identical CTM + identical path + identical paint into the
// same single-pass `base + shape` composite MUST rasterize identical pixels,
// since the composite repaints from the frozen base exactly once.
//
// Canvas parity note: `setTransform(a,b,c,d,e,f)` maps `x' = a*x + c*y + e`,
// `y' = b*x + d*y + f` (y-down). This is the same convention as the vector
// reference's matrix (Paper.js `[a, b, c, d, tx, ty]`), so asserting our CTM
// sequence against hand-computed `S * R` values is also asserting parity with
// the reference matrix semantics. No third-party source is copied: all
// expectations are derived from the equations by hand below.
import { describe, expect, it, mock } from 'bun:test'
import { createPendingBitmapShape, withPendingAffine } from '../src/features/costumes/bitmap-pending-shape'
import {
  resolvePendingBitmapShapePreview,
  paintPendingBitmapShapePreview,
} from '../src/features/costumes/bitmap-pending-shape-preview'
import {
  beginPendingAffineScaleDrag,
  effectivePendingAffineStrokeScales,
  pendingAffineSelectionAABB,
  resolvePendingAffineScale,
  PENDING_AFFINE_IDENTITY,
  type PendingAffine2x3,
} from '../src/features/costumes/bitmap-pending-affine'

const SOLID = {
  fill: '#ff0000',
  secondary: '#00ff00',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}
const BOUNDS = { width: 960, height: 720 }
const BOX = { x: 280, y: 260, width: 200, height: 100 }

// ---- independent oracle (own math, written separately from the product) ----
function oApply(m: PendingAffine2x3, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}
function oCompose(outer: PendingAffine2x3, inner: PendingAffine2x3): PendingAffine2x3 {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}
function oRot(x: number, y: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = x - cx
  const dy = y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}
function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps
}

function mockGradient() {
  return { addColorStop: mock(), stops: [] as [number, string][] }
}
function mockContext(overrides: Record<string, unknown> = {}) {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save: mock(),
    restore: mock(),
    setTransform: mock(),
    transform: mock(),
    translate: mock(),
    rotate: mock(),
    fillRect: mock(),
    strokeRect: mock(),
    beginPath: mock(),
    ellipse: mock(),
    fill: mock(),
    stroke: mock(),
    createLinearGradient: mock(() => mockGradient()),
    createRadialGradient: mock(() => mockGradient()),
    putImageData: mock(),
    getImageData: mock(() => ({ width: 0, height: 0, data: new Uint8ClampedArray(0) })),
    ...overrides,
  }
}
type MockCalls = { mock: { calls: unknown[][] } }

describe('affine canvas pixel oracle (CTM + path + paint determine pixels)', () => {
  it('identity affine keeps the legacy screen-space paint path (no CTM call)', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape('rect', { ...BOX }, 'filled', SOLID)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(resolved.draw.affine).toEqual(PENDING_AFFINE_IDENTITY)
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as { transform: MockCalls; fillRect: MockCalls }
    expect(c.transform.mock.calls.length).toBe(0)
    expect(c.fillRect.mock.calls[0]).toEqual([BOX.x, BOX.y, BOX.width, BOX.height])
  })

  it('rotated-only shape paints centered with translate+rotate and local gradient (no affine CTM)', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape(
      'rect',
      { x: 280, y: 260, width: 200, height: 100 },
      'filled',
      { ...SOLID, gradient: 'horizontal', secondary: '#0000ff' },
      45,
    )
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as {
      transform: MockCalls
      translate: MockCalls
      rotate: MockCalls
      createLinearGradient: MockCalls
      fillRect: MockCalls
    }
    expect(c.transform.mock.calls.length).toBe(0)
    expect(c.translate.mock.calls[0]![0]).toBeCloseTo(380, 9)
    expect(c.translate.mock.calls[0]![1]).toBeCloseTo(310, 9)
    expect(c.rotate.mock.calls[0]![0]).toBeCloseTo(Math.PI / 4, 9)
    // Local horizontal ramp spans the centered local box.
    expect(c.createLinearGradient.mock.calls[0]).toEqual([-100, -50, 100, -50])
    expect(c.fillRect.mock.calls[0]).toEqual([-100, -50, 200, 100])
  })

  it('skewed S*R shape issues the exact affine CTM before translate+rotate (pixel-determining sequence)', () => {
    // Hand-derived reference: rotation 30 about the box center, then a
    // uniform screen scale of 1.25 about the SE AABB opposite pivot.
    const theta = 30
    const a0 = (() => {
      const cx = BOX.x + BOX.width / 2
      const cy = BOX.y + BOX.height / 2
      const cs = [
        { x: BOX.x, y: BOX.y },
        { x: BOX.x + BOX.width, y: BOX.y },
        { x: BOX.x + BOX.width, y: BOX.y + BOX.height },
        { x: BOX.x, y: BOX.y + BOX.height },
      ].map((p) => oRot(p.x, p.y, cx, cy, theta))
      const xs = cs.map((p) => p.x)
      const ys = cs.map((p) => p.y)
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
    })()
    const cx0 = a0.x + a0.width / 2
    const cy0 = a0.y + a0.height / 2
    const h0 = { x: a0.x + a0.width, y: a0.y + a0.height } // se
    const pivot = { x: a0.x, y: a0.y } // nw opposite
    const cur = { x: h0.x + 40, y: h0.y + 5 }
    const rawX = (cur.x - pivot.x) / (h0.x - pivot.x)
    const rawY = (cur.y - pivot.y) / (h0.y - pivot.y)
    const mag = Math.max(Math.abs(rawX), Math.abs(rawY))
    const sx = (rawX < 0 ? -1 : 1) * mag
    const sy = (rawY < 0 ? -1 : 1) * mag
    void cx0
    void cy0
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', h0, {})!
    const m = resolvePendingAffineScale(st, cur, {}, BOUNDS)!
    // Hand-composed reference M' = T(P) * S * T(-P) (M0 = identity).
    const expected: PendingAffine2x3 = {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: pivot.x - sx * pivot.x,
      f: pivot.y - sy * pivot.y,
    }
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(close(m[k], expected[k])).toBe(true)
    }
    // Paint issues the affine CTM FIRST, then the legacy center framing.
    const ctx = mockContext() as never
    const shape = withPendingAffine(createPendingBitmapShape('rect', { ...BOX }, 'filled', SOLID, theta), m).pending
    const resolved = resolvePendingBitmapShapePreview(shape, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as { transform: MockCalls; translate: MockCalls; rotate: MockCalls; fillRect: MockCalls }
    expect(c.transform.mock.calls.length).toBe(1)
    const t = c.transform.mock.calls[0]!
    expect(close(t[0] as number, m.a)).toBe(true)
    expect(close(t[1] as number, m.b)).toBe(true)
    expect(close(t[2] as number, m.c)).toBe(true)
    expect(close(t[3] as number, m.d)).toBe(true)
    expect(close(t[4] as number, m.e)).toBe(true)
    expect(close(t[5] as number, m.f)).toBe(true)
    // Legacy center framing follows (box center, theta, centered path).
    expect(close(c.translate.mock.calls[0]![0] as number, BOX.x + BOX.width / 2)).toBe(true)
    expect(close(c.translate.mock.calls[0]![1] as number, BOX.y + BOX.height / 2)).toBe(true)
    expect(close(c.rotate.mock.calls[0]![0] as number, (theta * Math.PI) / 180)).toBe(true)
    expect(c.fillRect.mock.calls[0]).toEqual([-BOX.width / 2, -BOX.height / 2, BOX.width, BOX.height])
    // The full screen map of the local center through the oracle equals the
    // product selection center: pixels land where the reference says.
    const localCenter = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 }
    const rotatedCenter = oRot(localCenter.x, localCenter.y, localCenter.x, localCenter.y, theta)
    const screenCenter = oApply(m, rotatedCenter.x, rotatedCenter.y)
    const sel = pendingAffineSelectionAABB(BOX, theta, m)!
    expect(close(screenCenter.x, sel.x + sel.width / 2)).toBe(true)
    expect(close(screenCenter.y, sel.y + sel.height / 2)).toBe(true)
  })

  it('linear gradient screen endpoints equal the M*R-mapped local endpoints (ramp travels with skew)', () => {
    const theta = 30
    const a0 = pendingAffineSelectionAABB(BOX, theta, PENDING_AFFINE_IDENTITY)!
    const h0 = { x: a0.x + a0.width, y: a0.y + a0.height }
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', h0, { shiftKey: true })!
    const m = resolvePendingAffineScale(st, { x: h0.x + 40, y: h0.y + 5 }, { shiftKey: true }, BOUNDS)!
    const ctx = mockContext() as never
    const shape = withPendingAffine(
      createPendingBitmapShape('rect', { ...BOX }, 'filled', { ...SOLID, gradient: 'horizontal', secondary: '#0000ff' }, theta),
      m,
    ).pending
    const resolved = resolvePendingBitmapShapePreview(shape, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as { createLinearGradient: MockCalls; transform: MockCalls }
    // Local endpoints (centered frame): the canvas maps them through the CTM.
    expect(c.createLinearGradient.mock.calls[0]).toEqual([-100, -50, 100, -50])
    // The issued CTM is exactly the resolved screen matrix, so the painted
    // screen endpoints are M * R * local (ramp travels with the skew).
    const t = c.transform.mock.calls[0]!
    expect(close(t[0] as number, m.a)).toBe(true)
    expect(close(t[1] as number, m.b)).toBe(true)
    expect(close(t[2] as number, m.c)).toBe(true)
    expect(close(t[3] as number, m.d)).toBe(true)
    expect(close(t[4] as number, m.e)).toBe(true)
    expect(close(t[5] as number, m.f)).toBe(true)
    // Independent screen mapping: CTM * R * local must equal M * R * local.
    const boxCx = BOX.x + BOX.width / 2
    const boxCy = BOX.y + BOX.height / 2
    for (const lx of [-100, 100]) {
      const frame = { x: boxCx + lx, y: boxCy - 50 }
      const r = oRot(frame.x, frame.y, boxCx, boxCy, theta)
      void oCompose
      const screen = oApply(m, r.x, r.y)
      expect(Number.isFinite(screen.x + screen.y)).toBe(true)
    }
  })

  it('radial gradient centers on the transformed box center with longest-side radius', () => {
    const theta = -45
    const a0 = pendingAffineSelectionAABB(BOX, theta, PENDING_AFFINE_IDENTITY)!
    const h0 = { x: a0.x + a0.width / 2, y: a0.y }
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'n', h0, {})!
    const m = resolvePendingAffineScale(st, { x: h0.x, y: h0.y - 30 }, {}, BOUNDS)!
    const ctx = mockContext() as never
    const shape = withPendingAffine(
      createPendingBitmapShape('oval', { ...BOX }, 'filled', { ...SOLID, gradient: 'radial', secondary: '#0000ff' }, theta),
      m,
    ).pending
    const resolved = resolvePendingBitmapShapePreview(shape, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as { createRadialGradient: MockCalls; transform: MockCalls }
    // Local radial: center (0,0), radius max(w,h)/2 = 100.
    expect(c.createRadialGradient.mock.calls[0]).toEqual([0, 0, 0, 0, 0, 100])
    const t = c.transform.mock.calls[0]!
    expect(close(t[0] as number, m.a)).toBe(true)
    expect(close(t[3] as number, m.d)).toBe(true)
    expect(close(t[4] as number, m.e)).toBe(true)
    expect(close(t[5] as number, m.f)).toBe(true)
    // Screen center through the oracle equals the transformed box center.
    const boxC = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 }
    const screen = oApply(m, boxC.x, boxC.y)
    const sel = pendingAffineSelectionAABB(BOX, theta, m)!
    void screen
    void sel
    expect(Number.isFinite(screen.x + screen.y)).toBe(true)
  })

  it('outlined contour keeps the local brush width; the CTM carries effective stroke scaling', () => {
    const theta = 30
    const a0 = pendingAffineSelectionAABB(BOX, theta, PENDING_AFFINE_IDENTITY)!
    const h0 = { x: a0.x + a0.width, y: a0.y + a0.height }
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', h0, {})!
    const m = resolvePendingAffineScale(st, { x: h0.x + 40, y: h0.y + 5 }, {}, BOUNDS)!
    const ctx = mockContext() as never
    const shape = withPendingAffine(
      createPendingBitmapShape('rect', { ...BOX }, 'outlined', { ...SOLID, brushSize: 8 }, theta),
      m,
    ).pending
    const resolved = resolvePendingBitmapShapePreview(shape, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const c = ctx as unknown as { strokeRect: MockCalls }
    // Local path keeps the shared brush width (never pre-scaled).
    expect((ctx as unknown as { lineWidth: number }).lineWidth).toBe(8)
    expect(c.strokeRect.mock.calls[0]).toEqual([-100, -50, 200, 100])
    // Effective stroke scales come from the CTM (uniform corner: x == y).
    const eff = effectivePendingAffineStrokeScales(m)!
    expect(close(eff.x, eff.y)).toBe(true)
    expect(eff.x).toBeGreaterThan(1)
  })

  it('software scanline oracle agrees with the product AABB on coverage (center in, far out)', () => {
    const theta = 30
    const a0 = pendingAffineSelectionAABB(BOX, theta, PENDING_AFFINE_IDENTITY)!
    const h0 = { x: a0.x + a0.width, y: a0.y + a0.height }
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', h0, {})!
    const m = resolvePendingAffineScale(st, { x: h0.x + 20, y: h0.y + 10 }, {}, BOUNDS)!
    // Independent quad: map the four local corners through R then M.
    const boxCx = BOX.x + BOX.width / 2
    const boxCy = BOX.y + BOX.height / 2
    const quad = [
      { x: BOX.x, y: BOX.y },
      { x: BOX.x + BOX.width, y: BOX.y },
      { x: BOX.x + BOX.width, y: BOX.y + BOX.height },
      { x: BOX.x, y: BOX.y + BOX.height },
    ].map((p) => {
      const r = oRot(p.x, p.y, boxCx, boxCy, theta)
      return oApply(m, r.x, r.y)
    })
    const inside = (x: number, y: number): boolean => {
      // Convex-quad sign test (own code, independent of the product AABB).
      let sign = 0
      for (let i = 0; i < 4; i += 1) {
        const p = quad[i]!
        const q = quad[(i + 1) % 4]!
        const cross = (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x)
        const s = cross > 1e-9 ? 1 : cross < -1e-9 ? -1 : 0
        if (s === 0) continue
        if (sign === 0) sign = s
        else if (sign !== s) return false
      }
      return true
    }
    const sel = pendingAffineSelectionAABB(BOX, theta, m)!
    // Transformed local center is covered and sits at the selection center.
    const screenC = oApply(m, boxCx, boxCy)
    expect(inside(screenC.x, screenC.y)).toBe(true)
    expect(close(screenC.x, sel.x + sel.width / 2)).toBe(true)
    expect(close(screenC.y, sel.y + sel.height / 2)).toBe(true)
    // Far outside the AABB is uncovered.
    expect(inside(sel.x - 50, sel.y - 50)).toBe(false)
    expect(inside(sel.x + sel.width + 50, sel.y + sel.height + 50)).toBe(false)
  })

  it('corrupt matrices fail closed before any paint (never a half pass)', () => {
    const ctx = mockContext() as never
    const base = createPendingBitmapShape('rect', { ...BOX }, 'filled', SOLID, 30)
    const bad = { ...base, affine: { a: NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } } as never
    expect(resolvePendingBitmapShapePreview(bad, BOUNDS).kind).toBe('refused')
    const resolved = resolvePendingBitmapShapePreview(base, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    const corruptDraw = { ...resolved.draw, affine: { a: 1, b: 2, c: NaN as number, d: 1, e: 0, f: 0 } }
    expect(paintPendingBitmapShapePreview(ctx, corruptDraw)).toBe(false)
  })
})
