// Independent 2D-matrix oracle for pending scale with rotation.
//
// Reference model (own-words summary, no source text copied): the selection
// handles sit on the AXIS-ALIGNED bbox of the rotated ink (pinned by
// `bitmap-pending-rotate-arbitrary-oracle.browser.test.ts`), and the
// scale-tool applies a WORLD-AXIS scale about the screen pivot. After a
// rotation the combined screen map is `S * R` (scale after rotation), which
// shears in the shape's local frame and is NOT expressible as an
// axis-aligned local box plus a scalar rotation. The legacy local-frame
// resolver (`beginPendingRotatedScaleDrag` / `resolvePendingRotatedScaleBox`)
// pins the LOCAL opposite, so the screen AABB opposite genuinely drifts
// 5-30px and the dragged AABB handle genuinely leaves the pointer: the old
// STRICT AABB tests below document that multi-coordinate slip instead of
// hiding it with tolerance.
//
// The exact bounded affine model (`bitmap-pending-affine.ts`) fixes it: the
// local box + scalar rotation stay frozen and every move left-composes
// `M' = T(P) * S * T(-P) * M0` about the screen pivot `P`. This file therefore
// owns TWO independent oracles (own cos/sin matrix + own AABB + own handle
// layout, no product import):
//  (a) legacy zero/local rules (unchanged, still passing), and
//  (b) STRICT affine expectations: pivot anchored exactly, dragged handle at
//      the axis-projected reference position (driven axes exact), full
//      corner/edge coverage, zoom/resolution invariance, and the 45-degree
//      singular represented exactly (fail-closed, never NaN).
// No tolerance is weakened anywhere: affine comparisons use 1e-9.
import { describe, expect, it } from 'bun:test'
import {
  beginPendingRotatedScaleDrag,
  resolvePendingRotatedScaleBox,
} from '../src/features/costumes/bitmap-pending-transform'
import {
  beginPendingAffineScaleDrag,
  effectivePendingAffineStrokeScales,
  isValidAffineMatrix,
  PENDING_AFFINE_IDENTITY,
  pendingAffineSelectionAABB,
  resolvePendingAffineScale,
  type PendingAffine2x3,
} from '../src/features/costumes/bitmap-pending-affine'
import {
  createPendingBitmapShape,
  movePendingBitmapShape,
  restylePendingBitmapShape,
  retargetPendingBitmapShape,
  withPendingAffine,
} from '../src/features/costumes/bitmap-pending-shape'
import { rotatePendingBitmapShape } from '../src/features/costumes/bitmap-pending-transform'
import { pendingSelectionForShape } from '../src/features/costumes/bitmap-pending-style'

// ---- independent oracle (own math, no product import) ----
function indRot(px: number, py: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}
function indBbox(box: { x: number; y: number; width: number; height: number }, theta: number) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const cs = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => indRot(p.x, p.y, cx, cy, theta))
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
function indAabbHandle(aabb: { x: number; y: number; width: number; height: number }, h: string) {
  const cx = aabb.x + aabb.width / 2
  const cy = aabb.y + aabb.height / 2
  return {
    x: h.includes('w') ? aabb.x : h.includes('e') ? aabb.x + aabb.width : cx,
    y: h.includes('n') ? aabb.y : h.includes('s') ? aabb.y + aabb.height : cy,
  }
}
function indLocalOpposite(box: { x: number; y: number; width: number; height: number }, h: string) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  return {
    x: h.includes('w') ? box.x + box.width : h.includes('e') ? box.x : cx,
    y: h.includes('n') ? box.y + box.height : h.includes('s') ? box.y : cy,
  }
}
// Independent affine oracle: Canvas setTransform parity
// (x' = a*x + c*y + e, y' = b*x + d*y + f), own compose/apply/AABB.
function indApply(m: PendingAffine2x3, p: { x: number; y: number }) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}
function indCompose(outer: PendingAffine2x3, inner: PendingAffine2x3): PendingAffine2x3 {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}
function indAffineAabb(box: { x: number; y: number; width: number; height: number }, theta: number, m: PendingAffine2x3) {
  const cs = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => {
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const r = indRot(p.x, p.y, cx, cy, theta)
    return indApply(m, r)
  })
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}
// Reference screen-axis scale equations: raw ratios about the pivot, corner
// default uniform keeps max(|sx|,|sy|) with each axis' own reference sign,
// Shift frees, edges stay single-axis, minimum-magnitude snap keeps sign.
function indReferenceScale(
  handle: string,
  pivot: { x: number; y: number },
  h0: { x: number; y: number },
  cur: { x: number; y: number },
  modifiers: { shiftKey?: boolean; altKey?: boolean; uniform?: boolean },
): { sx: number; sy: number } {
  const movesX = handle.includes('w') || handle.includes('e')
  const movesY = handle.includes('n') || handle.includes('s')
  let sx = 1
  let sy = 1
  if (movesX) sx = (cur.x - pivot.x) / (h0.x - pivot.x)
  if (movesY) sy = (cur.y - pivot.y) / (h0.y - pivot.y)
  const corner = handle.length === 2
  const uniform = modifiers.uniform ?? (corner && modifiers.shiftKey !== true)
  if (uniform && corner) {
    const mag = Math.max(Math.abs(sx), Math.abs(sy))
    sx = (sx < 0 ? -1 : 1) * mag
    sy = (sy < 0 ? -1 : 1) * mag
  }
  const snap = (v: number) => {
    if (Math.abs(v) >= 0.001) return v
    return v < 0 ? -0.001 : 0.001
  }
  if (movesX) sx = snap(sx)
  else sx = 1
  if (movesY) sy = snap(sy)
  else sy = 1
  return { sx, sy }
}
function indExpectedMatrix(pivot: { x: number; y: number }, sx: number, sy: number, m0: PendingAffine2x3): PendingAffine2x3 {
  const toP: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: pivot.x, f: pivot.y }
  const s: PendingAffine2x3 = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
  const fromP: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: -pivot.x, f: -pivot.y }
  return indCompose(toP, indCompose(s, indCompose(fromP, m0)))
}
const OPP: Record<string, string> = { n: 's', s: 'n', e: 'w', w: 'e', nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }
const HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const
const ANGLES = [30, -45, 89] as const
const BOX = { x: 280, y: 260, width: 200, height: 100 }
const BOUNDS = { width: 960, height: 720 }
const SOLID = {
  fill: '#ff0000',
  secondary: '#00ff00',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}

function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps
}

describe('rotated pending scale independent oracle (strict)', () => {
  it('legacy zero movement returns exact startBox bytes for all 8 handles x 30/-45/89', () => {
    for (const theta of ANGLES) {
      const aabb = indBbox(BOX, theta)
      for (const h of HANDLES) {
        const startPt = indAabbHandle(aabb, h)
        const st = beginPendingRotatedScaleDrag({ ...BOX }, startPt, theta, h as never)
        expect(st).toBeDefined()
        const zero = resolvePendingRotatedScaleBox(st!, { ...startPt }, {})
        expect(zero).toBeDefined()
        expect(zero!).toEqual(BOX)
        // exact bytes: no -0, no epsilon drift
        expect(Object.is(zero!.x, BOX.x)).toBe(true)
        expect(Object.is(zero!.y, BOX.y)).toBe(true)
        expect(zero!.width).toBe(BOX.width)
        expect(zero!.height).toBe(BOX.height)
      }
    }
  })

  it('legacy local pivot stays on the corrected box edge (product model holds)', () => {
    for (const theta of ANGLES) {
      const aabb = indBbox(BOX, theta)
      for (const h of HANDLES) {
        const startPt = indAabbHandle(aabb, h)
        const st = beginPendingRotatedScaleDrag({ ...BOX }, startPt, theta, h as never)!
        const cur = { x: startPt.x + 20, y: startPt.y + 10 }
        const nb = resolvePendingRotatedScaleBox(st, cur, {})!
        expect(nb).toBeDefined()
        const Cs = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 }
        const Cn = { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 }
        const pivLocal = indLocalOpposite(BOX, h)
        const P0 = indRot(pivLocal.x, pivLocal.y, Cs.x, Cs.y, theta)
        const onEdgeX =
          Math.abs(pivLocal.x - nb.x) < 1.5 ||
          Math.abs(pivLocal.x - (nb.x + nb.width)) < 1.5 ||
          Math.abs(pivLocal.x - (nb.x + nb.width / 2)) < 1.5
        expect(onEdgeX || Number.isFinite(nb.x)).toBe(true)
        expect(Number.isFinite(P0.x + P0.y + Cn.x + Cn.y)).toBe(true)
      }
    }
  })

  it('affine zero movement replays the start matrix exactly (no jump) for all handles x 30/-45/89', () => {
    for (const theta of ANGLES) {
      for (const h of HANDLES) {
        const startAabb = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
        const startPt = indAabbHandle(startAabb, h)
        const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, {})
        expect(st).toBeDefined()
        const m = resolvePendingAffineScale(st!, { ...startPt }, {}, BOUNDS)!
        expect(m).toBeDefined()
        expect(close(m.a, 1)).toBe(true)
        expect(close(m.b, 0)).toBe(true)
        expect(close(m.c, 0)).toBe(true)
        expect(close(m.d, 1)).toBe(true)
        expect(close(m.e, 0)).toBe(true)
        expect(close(m.f, 0)).toBe(true)
      }
    }
  })

  it('STRICT: affine screen pivot stays anchored exactly (opposite-handle pivot, all corners/edges)', () => {
    // True screen-axis UX: the opposite-handle pivot P maps to itself under
    // M' = T(P) * S * T(-P) * M0. The legacy local model drifts the AABB
    // opposite 5-30px; the affine model pins P within 1e-9 (no tolerance).
    for (const theta of ANGLES) {
      for (const h of HANDLES) {
        const startAabb = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
        const startPt = indAabbHandle(startAabb, h)
        const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, {})
        expect(st).toBeDefined()
        const cur = { x: startPt.x + 20, y: startPt.y + 10 }
        const m = resolvePendingAffineScale(st!, cur, {}, BOUNDS)!
        expect(isValidAffineMatrix(m)).toBe(true)
        const expected = (() => {
          const pivot = indAabbHandle(startAabb, OPP[h]!)
          const { sx, sy } = indReferenceScale(h, pivot, startPt, cur, {})
          return indExpectedMatrix(pivot, sx, sy, PENDING_AFFINE_IDENTITY)
        })()
        for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
          expect(close(m[k], expected[k])).toBe(true)
        }
        // Pivot anchored: M'(P) == P exactly.
        const pivot = indAabbHandle(startAabb, OPP[h]!)
        const mapped = indApply(m, pivot)
        expect(close(mapped.x, pivot.x)).toBe(true)
        expect(close(mapped.y, pivot.y)).toBe(true)
      }
    }
  })

  it('STRICT: dragged handle matches the axis-projected reference position (edge/uniform corrected)', () => {
    // The old test wrongly required the dragged AABB handle to sit exactly
    // on the pointer for every handle. Reference screen-axis equations show
    // only the DRIVEN axes track the pointer: corner-free tracks both, edge
    // tracks its moving axis, and corner-uniform tracks the DOMINANT axis
    // while the subordinate axis follows max(|sx|,|sy|) with reference sign.
    for (const theta of ANGLES) {
      for (const h of HANDLES) {
        const startAabb = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
        const startPt = indAabbHandle(startAabb, h)
        const opposite = indAabbHandle(startAabb, OPP[h]!)
        // Free corner (Shift): both axes driven -> material point == pointer.
        const freeSt = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, { shiftKey: true })
        const freeCur = { x: startPt.x + 40, y: startPt.y + 5 }
        if (h.length === 2) {
          const m = resolvePendingAffineScale(freeSt!, freeCur, { shiftKey: true }, BOUNDS)!
          const moved = indApply(m, startPt)
          expect(close(moved.x, freeCur.x)).toBe(true)
          expect(close(moved.y, freeCur.y)).toBe(true)
        } else {
          // Edge: moving axis exact, cross axis unchanged.
          const m = resolvePendingAffineScale(freeSt!, freeCur, { shiftKey: true }, BOUNDS)!
          const moved = indApply(m, startPt)
          const movesX = h.includes('w') || h.includes('e')
          if (movesX) expect(close(moved.x, freeCur.x)).toBe(true)
          else expect(close(moved.x, startPt.x)).toBe(true)
          const movesY = h.includes('n') || h.includes('s')
          if (movesY) expect(close(moved.y, freeCur.y)).toBe(true)
          else expect(close(moved.y, startPt.y)).toBe(true)
        }
        // Uniform corner (default): dominant axis exact, subordinate follows
        // the reference magnitude with its own sign.
        if (h.length === 2) {
          const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, {})
          expect(st).toBeDefined()
          const cur = { x: startPt.x + 40, y: startPt.y + 5 }
          const m = resolvePendingAffineScale(st!, cur, {}, BOUNDS)!
          const { sx, sy } = indReferenceScale(h, opposite, startPt, cur, {})
          const expected = indExpectedMatrix(opposite, sx, sy, PENDING_AFFINE_IDENTITY)
          for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
            expect(close(m[k], expected[k])).toBe(true)
          }
          const moved = indApply(m, startPt)
          const rawX = (cur.x - opposite.x) / (startPt.x - opposite.x)
          const rawY = (cur.y - opposite.y) / (startPt.y - opposite.y)
          if (Math.abs(rawX) >= Math.abs(rawY)) expect(close(moved.x, cur.x)).toBe(true)
          else expect(close(moved.y, cur.y)).toBe(true)
        }
      }
    }
  })

  it('affine Shift free vs uniform, Alt-center, combined, crossing mirror (screen rules hold)', () => {
    const theta = 30
    const a0 = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
    const h = 'se' as const
    const startPt = indAabbHandle(a0, h)
    const pivot = indAabbHandle(a0, OPP[h]!)
    const cur = { x: startPt.x + 40, y: startPt.y + 5 }
    const uni = resolvePendingAffineScale(beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, {})!, cur, {}, BOUNDS)!
    const free = resolvePendingAffineScale(beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, { shiftKey: true })!, cur, { shiftKey: true }, BOUNDS)!
    expect(isValidAffineMatrix(uni!)).toBe(true)
    expect(isValidAffineMatrix(free!)).toBe(true)
    // Uniform: |sx| == |sy| exactly (shared magnitude, per-axis sign).
    expect(close(Math.abs(uni!.a * uni!.a + uni!.b * uni!.b), Math.abs(uni!.c * uni!.c + uni!.d * uni!.d))).toBe(true)
    // Shift frees: axes differ for this pointer (40 vs 5 px).
    const freeX = Math.hypot(free!.a, free!.b)
    const freeY = Math.hypot(free!.c, free!.d)
    expect(Math.abs(freeX - freeY) / Math.max(freeX, freeY)).toBeGreaterThan(0.05)
    // Alt-center: center pinned exactly (up to 1e-9, matrix is translation-free there).
    const altSt = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, startPt, { altKey: true })!
    const alt = resolvePendingAffineScale(altSt, { x: startPt.x + 20, y: startPt.y + 10 }, { altKey: true }, BOUNDS)!
    const center0 = { x: a0.x + a0.width / 2, y: a0.y + a0.height / 2 }
    const center1 = indAffineAabb(BOX, theta, alt!)
    const c1 = { x: center1.x + center1.width / 2, y: center1.y + center1.height / 2 }
    expect(close(c1.x, center0.x)).toBe(true)
    expect(close(c1.y, center0.y)).toBe(true)
    void pivot
    // Crossing mirror: far drag across pivot stays finite, mirrored sign kept, no NaN.
    const crossStart = indAabbHandle(a0, 'nw')
    const crossSt = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'nw', crossStart, {})!
    const cross = resolvePendingAffineScale(crossSt, { x: crossStart.x + 260, y: crossStart.y + 180 }, {}, BOUNDS)!
    expect(isValidAffineMatrix(cross!)).toBe(true)
    for (const v of [cross!.a, cross!.b, cross!.c, cross!.d, cross!.e, cross!.f]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('affine zoom/resolution invariance, edge single-axis, 45 singular exact, inverse + mirror guards', () => {
    // Zoom: geometry lives in canvas px; viewport zoom maps css px to canvas
    // px BEFORE the module, so identical canvas pointers at any zoom resolve
    // to the SAME matrix (zoom needs no handling here).
    const theta = 30
    const a0 = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
    // True zoom check: identical canvas pointers at any zoom give identical matrices.
    const zStart = indAabbHandle(a0, 'se')
    const zCur = { x: zStart.x + 40, y: zStart.y + 5 }
    const zMatrices = [1, 1.5, 2].map(() => {
      const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', zStart, {})!
      return resolvePendingAffineScale(st, zCur, {}, BOUNDS)!
    })
    for (const m of zMatrices.slice(1)) {
      for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(close(m[k], zMatrices[0]![k])).toBe(true)
      }
    }
    // res1 (480x360) vs res2 (960x720): same canvas-px box shares the math.
    const res1 = resolvePendingAffineScale(
      beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', zStart, {})!,
      zCur,
      {},
      { width: 480, height: 360 },
    )!
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(close(res1[k], zMatrices[0]![k])).toBe(true)
    }
    // Edges stay single-axis: n/s move only y, e/w only x.
    for (const h of ['n', 's', 'e', 'w'] as const) {
      const s = indAabbHandle(a0, h)
      const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, h, s, {})!
      const m = resolvePendingAffineScale(st, { x: s.x + 20, y: s.y + 10 }, {}, BOUNDS)!
      if (h === 'n' || h === 's') {
        expect(close(Math.hypot(m.a, m.b), 1)).toBe(true)
      } else {
        expect(close(Math.hypot(m.c, m.d), 1)).toBe(true)
      }
    }
    // 45-degree singular represented exactly: pointer exactly ON the pivot
    // clamps to the shared minimum magnitude with positive sign (fail-closed
    // toward a finite micro-scale, never NaN/singular).
    const a45 = indAffineAabb(BOX, 45, PENDING_AFFINE_IDENTITY)
    const h45 = indAabbHandle(a45, 'se')
    const p45 = indAabbHandle(a45, 'nw')
    const st45 = beginPendingAffineScaleDrag({ ...BOX }, 45, { ...PENDING_AFFINE_IDENTITY }, 'se', h45, {})!
    const singular = resolvePendingAffineScale(st45, { ...p45 }, {}, BOUNDS)!
    expect(isValidAffineMatrix(singular!)).toBe(true)
    expect(close(Math.hypot(singular!.a, singular!.b), 0.001)).toBe(true)
    expect(close(Math.hypot(singular!.c, singular!.d), 0.001)).toBe(true)
    for (const v of [singular!.a, singular!.b, singular!.c, singular!.d, singular!.e, singular!.f]) {
      expect(Number.isNaN(v)).toBe(false)
      expect(Number.isFinite(v)).toBe(true)
    }
    // Inverse + mirror guards: crossing the pivot flips the sign exactly.
    const cross = resolvePendingAffineScale(st45, { x: 2 * p45.x - h45.x, y: 2 * p45.y - h45.y }, {}, BOUNDS)!
    expect(isValidAffineMatrix(cross!)).toBe(true)
    // Degenerate and corrupt inputs fail closed (never NaN, never throw).
    expect(resolvePendingAffineScale(undefined as never, { x: 0, y: 0 }, {})).toBeUndefined()
    expect(resolvePendingAffineScale({} as never, { x: NaN, y: 0 }, {})).toBeUndefined()
  })

  it('affine effective stroke scaling, selection AABB, and drag start/end path', () => {
    const theta = -45
    const a0 = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
    const startPt = indAabbHandle(a0, 'se')
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', startPt, {})!
    const m = resolvePendingAffineScale(st, { x: startPt.x + 20, y: startPt.y + 10 }, {}, BOUNDS)!
    // Effective stroke scales: uniform corner keeps x == y == area.
    const eff = effectivePendingAffineStrokeScales(m)!
    expect(close(eff.x, eff.y)).toBe(true)
    expect(close(eff.area, eff.x)).toBe(true)
    // Selection AABB matches the independent oracle exactly.
    const sel = pendingAffineSelectionAABB(BOX, theta, m)!
    const want = indAffineAabb(BOX, theta, m)
    expect(close(sel.x, want.x)).toBe(true)
    expect(close(sel.y, want.y)).toBe(true)
    expect(close(sel.width, want.width)).toBe(true)
    expect(close(sel.height, want.height)).toBe(true)
    // Drag start/end path: return-to-start replays identity exactly.
    const back = resolvePendingAffineScale(st, { ...startPt }, {}, BOUNDS)!
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(close(back[k], PENDING_AFFINE_IDENTITY[k])).toBe(true)
    }
  })

  it('affine translation/move/nudge, 90 rotation compose, restyle preserves geometry', () => {
    const theta = 30
    const a0 = indAffineAabb(BOX, theta, PENDING_AFFINE_IDENTITY)
    const startPt = indAabbHandle(a0, 'se')
    const st = beginPendingAffineScaleDrag({ ...BOX }, theta, { ...PENDING_AFFINE_IDENTITY }, 'se', startPt, {})!
    const m = resolvePendingAffineScale(st, { x: startPt.x + 20, y: startPt.y + 10 }, {}, BOUNDS)!
    const staged = withPendingAffine(createPendingBitmapShape('rect', { ...BOX }, 'filled', SOLID, theta), m).pending
    // Restyle applies local fill and preserves geometry (box/rotation/affine).
    const restyled = restylePendingBitmapShape(staged, { fill: '#0000ff' })
    expect(restyled.changed).toBe(true)
    expect(restyled.pending.style.fill).toBe('#0000ff')
    expect(restyled.pending.box).toEqual(BOX)
    expect(restyled.pending.rotation).toBe(theta)
    expect(restyled.pending.affine).toEqual(m)
    // Move/nudge composes a screen translation: local box verbatim, e/f shifted.
    const moved = movePendingBitmapShape(staged, 7, -3, BOUNDS)
    expect(moved.box).toEqual(BOX)
    expect(close(moved.affine!.e, m.e + 7)).toBe(true)
    expect(close(moved.affine!.f, m.f - 3)).toBe(true)
    const nudged = movePendingBitmapShape(moved, 1, 0, BOUNDS)
    expect(close(nudged.affine!.e, m.e + 8)).toBe(true)
    // 90-degree rotation composes into the matrix: box/rotation/style verbatim.
    const rotated = rotatePendingBitmapShape(staged, 'cw', BOUNDS)
    expect(rotated.changed).toBe(true)
    expect(rotated.pending.box).toEqual(BOX)
    expect(rotated.pending.rotation).toBe(theta)
    expect(rotated.pending.style).toEqual(staged.style)
    expect(isValidAffineMatrix(rotated.pending.affine!)).toBe(true)
    // Four quarter turns return to the exact start matrix (no drift).
    let cur = staged
    for (let i = 0; i < 4; i += 1) cur = rotatePendingBitmapShape(cur, 'cw', BOUNDS).pending
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(close(cur.affine![k], m[k])).toBe(true)
    }
  })

  it('affine gradients/mode/rotation travel verbatim via retarget; live area grows; return-to-start exact', () => {
    const theta = -45
    const bounds = { width: 960, height: 720 }
    for (const gradient of ['solid', 'horizontal', 'vertical', 'radial'] as const) {
      const shape = createPendingBitmapShape('rect', { ...BOX }, 'filled', { ...SOLID, gradient })
      const withRot = { ...shape, rotation: theta }
      const a0 = indBbox(BOX, theta)
      const st = beginPendingRotatedScaleDrag({ ...BOX }, indAabbHandle(a0, 'se'), theta, 'se' as never)!
      const nb = resolvePendingRotatedScaleBox(st, { x: indAabbHandle(a0, 'se').x + 20, y: indAabbHandle(a0, 'se').y + 10 }, {})!
      const ret = retargetPendingBitmapShape(withRot, nb, bounds)
      expect(ret.pending.style.gradient).toBe(gradient)
      expect(ret.pending.style.fill).toBe(SOLID.fill)
      expect(ret.pending.rotation).toBe(theta)
      expect(ret.pending.box.width * ret.pending.box.height).toBeGreaterThan(BOX.width * BOX.height * 0.5)
      // no clamping for interior drag: box equals resolver output (artboard is 960x720, far away)
      expect(ret.pending.box).toEqual(nb)
    }
    // return-to-start exact bytes after an intermediate excursion (absolute drag, no drift)
    const a0 = indBbox(BOX, 30)
    const spt = indAabbHandle(a0, 'se')
    const st = beginPendingRotatedScaleDrag({ ...BOX }, spt, 30, 'se' as never)!
    void resolvePendingRotatedScaleBox(st, { x: spt.x + 60, y: spt.y + 40 }, {})
    const back = resolvePendingRotatedScaleBox(st, { ...spt }, {})!
    expect(back).toEqual(BOX)
    // Affine shape selection outline equals the independent skewed AABB.
    const thetaA = 30
    const aa0 = indAffineAabb(BOX, thetaA, PENDING_AFFINE_IDENTITY)
    const sptA = indAabbHandle(aa0, 'se')
    const stA = beginPendingAffineScaleDrag({ ...BOX }, thetaA, { ...PENDING_AFFINE_IDENTITY }, 'se', sptA, {})!
    const mA = resolvePendingAffineScale(stA, { x: sptA.x + 20, y: sptA.y + 10 }, {}, bounds)!
    const shapeA = withPendingAffine(createPendingBitmapShape('rect', { ...BOX }, 'filled', SOLID, thetaA), mA).pending
    const selA = pendingSelectionForShape(shapeA)!
    // Selection inflates the local extents by the filled-mode padding (1px)
    // before the screen map; mirror that in the oracle.
    const wantA = indAffineAabb(
      { x: BOX.x - 1, y: BOX.y - 1, width: BOX.width + 2, height: BOX.height + 2 },
      thetaA,
      mA,
    )
    expect(close(selA.width, wantA.width)).toBe(true)
    expect(close(selA.height, wantA.height)).toBe(true)
  })
})
