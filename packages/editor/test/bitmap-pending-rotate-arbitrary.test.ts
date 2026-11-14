// Parametric arbitrary-angle rotation for pending bitmap rect/oval shapes.
//
// Covers the free rotate-handle leg: 2D rotation about the shape center with
// Shift 45-degree snap (via `rotation-gesture`), absolute-drag semantics
// (repeat drags from the frozen start angle never drift), gradient/brush
// preservation (style travels verbatim; the preview carries ramps in the
// local frame), corner-resize local-matrix mapping, and fail-closed behavior
// for corrupt angles/boxes/bounds (same object, `changed: false`, never a
// silent raster or stripped color).
//
// No AGPL copy: all expectations are written against own math + the in-repo
// `rotation-gesture` helpers, verified below independently.
import { describe, expect, it, mock } from 'bun:test'
import {
  createPendingBitmapShape,
  movePendingBitmapShape,
  normalizePendingRotationDegrees,
  restylePendingBitmapShape,
  retargetPendingBitmapShape,
} from '../src/features/costumes/bitmap-pending-shape'
import {
  resolvePendingBitmapShapePreview,
  paintPendingBitmapShapePreview,
  resolvePendingShapePreviewStyle,
} from '../src/features/costumes/bitmap-pending-shape-preview'
import {
  rotatePendingBitmapShape,
  rotatePendingBitmapShapeBy,
  rotatePendingBitmapShapeTo,
  rotatePointAroundCenter,
  rotatedPendingBoxBoundingBox,
  unrotatePointForPendingShape,
} from '../src/features/costumes/bitmap-pending-transform'
import { pendingSelectionForShape } from '../src/features/costumes/bitmap-pending-style'

const SOLID = {
  fill: '#ff0000',
  secondary: '#ffffff',
  gradient: 'solid' as const,
  fillTransparent: false,
  secondaryTransparent: false,
  brushSize: 6,
}

const BOUNDS = { width: 960, height: 720 }
const BOX = { x: 280, y: 260, width: 200, height: 100 }
const CENTER = { x: 380, y: 310 }

function approx(actual: number, want: number, epsilon = 1e-9): void {
  expect(Math.abs(actual - want)).toBeLessThan(epsilon)
}

describe('normalizePendingRotationDegrees', () => {
  it('normalizes to (-180, 180] with tiny angles snapped to 0', () => {
    expect(normalizePendingRotationDegrees(45)).toBe(45)
    expect(normalizePendingRotationDegrees(370)).toBe(10)
    expect(normalizePendingRotationDegrees(-190)).toBe(170)
    expect(normalizePendingRotationDegrees(180)).toBe(180)
    expect(normalizePendingRotationDegrees(-180)).toBe(180)
    expect(normalizePendingRotationDegrees(1e-12)).toBe(0)
  })

  it('maps non-finite / non-number input to 0 (creation-time convenience)', () => {
    expect(normalizePendingRotationDegrees(Number.NaN)).toBe(0)
    expect(normalizePendingRotationDegrees(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizePendingRotationDegrees('45')).toBe(0)
    expect(normalizePendingRotationDegrees(undefined)).toBe(0)
  })
})

describe('createPendingBitmapShape rotation default', () => {
  it('defaults to 0 and normalizes explicit angles', () => {
    expect(createPendingBitmapShape('rect', BOX, 'filled', SOLID).rotation).toBe(0)
    expect(createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45).rotation).toBe(45)
    expect(createPendingBitmapShape('rect', BOX, 'filled', SOLID, 370).rotation).toBe(10)
    expect(createPendingBitmapShape('rect', BOX, 'filled', SOLID, Number.NaN).rotation).toBe(0)
  })

  it('restyle / move / retarget preserve rotation verbatim', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    expect(restylePendingBitmapShape(pending, { fill: '#0000ff' }).pending.rotation).toBe(45)
    expect(movePendingBitmapShape(pending, 5, 5, BOUNDS).rotation).toBe(45)
    expect(retargetPendingBitmapShape(pending, { x: 0, y: 0, width: 60, height: 40 }, BOUNDS).pending.rotation).toBe(45)
  })
})

describe('rotatePointAroundCenter (own 2D math, y-down clockwise positive)', () => {
  it('rotates east to south for +90 degrees', () => {
    const out = rotatePointAroundCenter({ x: 1, y: 0 }, { x: 0, y: 0 }, 90)
    expect(out).toBeDefined()
    approx(out!.x, 0)
    approx(out!.y, 1)
  })

  it('is the identity at 0 and inverts with the negated angle', () => {
    const out = rotatePointAroundCenter({ x: 3, y: -2 }, { x: 1, y: 1 }, 0)
    expect(out).toEqual({ x: 3, y: -2 })
    const fwd = rotatePointAroundCenter({ x: 5, y: 1 }, CENTER, 37)!
    const back = rotatePointAroundCenter(fwd, CENTER, -37)!
    approx(back.x, 5)
    approx(back.y, 1)
  })

  it('fails closed (undefined, never throws) on invalid input', () => {
    expect(rotatePointAroundCenter({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }, 45)).toBeUndefined()
    expect(rotatePointAroundCenter({ x: 1, y: 0 }, { x: 0, y: 0 }, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(rotatePointAroundCenter(undefined as never, { x: 0, y: 0 }, 45)).toBeUndefined()
  })
})

describe('rotatedPendingBoxBoundingBox', () => {
  it('is the equal box at 0 degrees', () => {
    expect(rotatedPendingBoxBoundingBox(BOX, 0)).toEqual(BOX)
  })

  it('swaps extents at 90 degrees about the same center', () => {
    const out = rotatedPendingBoxBoundingBox(BOX, 90)!
    expect(out).toBeDefined()
    approx(out.width, 100)
    approx(out.height, 200)
    approx(out.x + out.width / 2, CENTER.x)
    approx(out.y + out.height / 2, CENTER.y)
  })

  it('matches w*cos+h*sin at 45 degrees about the same center', () => {
    const out = rotatedPendingBoxBoundingBox(BOX, 45)!
    const want = (200 + 100) * Math.SQRT1_2
    approx(out.width, want, 1e-9)
    approx(out.height, want, 1e-9)
    approx(out.x + out.width / 2, CENTER.x)
    approx(out.y + out.height / 2, CENTER.y)
  })

  it('fails closed on invalid input', () => {
    expect(rotatedPendingBoxBoundingBox({ x: 0, y: 0, width: 0, height: 10 }, 45)).toBeUndefined()
    expect(rotatedPendingBoxBoundingBox(BOX, Number.NaN)).toBeUndefined()
  })
})

describe('rotatePendingBitmapShapeTo / By (absolute parametric rotation)', () => {
  it('stages the angle keeping box and style values verbatim', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    const { pending: next, changed } = rotatePendingBitmapShapeTo(pending, 45, BOUNDS)
    expect(changed).toBe(true)
    expect(next.rotation).toBe(45)
    expect(next.box).toEqual(pending.box)
    expect(next.style).toEqual(pending.style)
    expect(next.kind).toBe('rect')
    expect(next.mode).toBe('filled')
    expect(pending.rotation).toBe(0)
  })

  it('normalizes the target angle and no-ops on the same angle', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    expect(rotatePendingBitmapShapeTo(pending, 370, BOUNDS).pending.rotation).toBe(10)
    const staged = rotatePendingBitmapShapeTo(pending, 45, BOUNDS).pending
    const repeat = rotatePendingBitmapShapeTo(staged, 45, BOUNDS)
    expect(repeat.changed).toBe(false)
    expect(repeat.pending).toBe(staged)
  })

  it('By composes relatively and treats tiny deltas as no-ops', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    const once = rotatePendingBitmapShapeBy(pending, 30, BOUNDS).pending
    expect(once.rotation).toBe(30)
    const twice = rotatePendingBitmapShapeBy(once, 15, BOUNDS).pending
    expect(twice.rotation).toBe(45)
    // Repeat drag absolute: same pointer twice lands on the same angle.
    const replay = rotatePendingBitmapShapeTo(pending, 30 + 15, BOUNDS).pending
    expect(replay.rotation).toBe(twice.rotation)
    const tiny = rotatePendingBitmapShapeBy(twice, 1e-12, BOUNDS)
    expect(tiny.changed).toBe(false)
    expect(tiny.pending).toBe(twice)
  })

  it('By works on pre-rotation literals missing the field (backward compat)', () => {
    const legacy = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: { ...SOLID } } as never
    const { pending, changed } = rotatePendingBitmapShapeBy(legacy, 45, BOUNDS)
    expect(changed).toBe(true)
    expect((pending as { rotation: number }).rotation).toBe(45)
  })

  it('never strips gradient stops or transparents (verbatim style)', () => {
    const style = { ...SOLID, gradient: 'horizontal' as const, secondary: '#0000ff', fillTransparent: true }
    const pending = createPendingBitmapShape('oval', BOX, 'outlined', style)
    const next = rotatePendingBitmapShapeTo(pending, -30, BOUNDS).pending
    expect(next.style).toEqual(pending.style)
    expect(next.style.gradient).toBe('horizontal')
    expect(next.style.fill).toBe('#ff0000')
    expect(next.style.secondary).toBe('#0000ff')
    expect(next.style.fillTransparent).toBe(true)
    expect(next.style.brushSize).toBe(6)
  })

  it('fails closed with the same object on corrupt input (never silently rasterizes)', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '45' as never]) {
      const result = rotatePendingBitmapShapeTo(pending, bad, BOUNDS)
      expect(result.changed).toBe(false)
      expect(result.pending).toBe(pending)
    }
    expect(rotatePendingBitmapShapeTo(pending, 45, { width: 0, height: 80 }).pending).toBe(pending)
    expect(rotatePendingBitmapShapeTo(undefined as never, 45, BOUNDS).changed).toBe(false)
    expect(rotatePendingBitmapShapeBy(pending, Number.NaN, BOUNDS).changed).toBe(false)
    // Non-finite staged rotation is incompatible: refuse, never invent pixels.
    const corrupt = { ...pending, rotation: Number.NaN }
    expect(rotatePendingBitmapShapeTo(corrupt, 45, BOUNDS).pending).toBe(corrupt)
    expect(rotatePendingBitmapShapeBy(corrupt, 10, BOUNDS).pending).toBe(corrupt)
  })

  it('legacy quarter-turn on a non-axis shape composes instead of box-swapping', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    const { pending: next, changed } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(changed).toBe(true)
    // Exact vector semantic: local extents + style untouched, angle composed.
    expect(next.box).toEqual(BOX)
    expect(next.style).toEqual(pending.style)
    expect(next.rotation).toBe(135)
  })

  it('legacy quarter-turn on axis shapes is untouched (backwards API)', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    const { pending: next } = rotatePendingBitmapShape(pending, 'cw', BOUNDS)
    expect(next.box).toEqual({ x: 330, y: 210, width: 100, height: 200 })
    expect(next.rotation).toBe(0)
  })
})

describe('unrotatePointForPendingShape (corner-resize local matrix)', () => {
  it('is the identity for axis shapes and the inverse rotation otherwise', () => {
    const axis = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    expect(unrotatePointForPendingShape({ x: 400, y: 300 }, axis)).toEqual({ x: 400, y: 300 })
    const rotated = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 90)
    // Screen south of center maps to local east of center under -90.
    const local = unrotatePointForPendingShape({ x: CENTER.x, y: CENTER.y + 25 }, rotated)!
    approx(local.x, CENTER.x + 25)
    approx(local.y, CENTER.y)
  })

  it('round-trips any angle through the forward rotation', () => {
    const rotated = createPendingBitmapShape('rect', BOX, 'filled', SOLID, -30)
    const screen = { x: BOX.x + 10, y: BOX.y + 90 }
    const local = unrotatePointForPendingShape(screen, rotated)!
    const back = rotatePointAroundCenter(local, CENTER, -30)!
    approx(back.x, screen.x)
    approx(back.y, screen.y)
  })

  it('fails closed on corrupt shapes and NaN pointers', () => {
    const rotated = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    expect(unrotatePointForPendingShape({ x: Number.NaN, y: 0 }, rotated)).toBeUndefined()
    expect(unrotatePointForPendingShape({ x: 0, y: 0 }, undefined as never)).toBeUndefined()
    const corrupt = { ...rotated, rotation: Number.POSITIVE_INFINITY }
    expect(unrotatePointForPendingShape({ x: 0, y: 0 }, corrupt)).toBeUndefined()
  })
})

describe('resolvePendingBitmapShapePreview with rotation', () => {
  it('defaults missing rotation to 0 (backward compatible draw)', () => {
    const legacy = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: { ...SOLID } }
    const resolved = resolvePendingBitmapShapePreview(legacy as never, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(resolved.draw.rotation).toBe(0)
    expect(resolved.draw.box).toEqual(BOX)
  })

  it('carries a valid rotation into the draw with the box untouched', () => {
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(resolved.draw.rotation).toBe(45)
    expect(resolved.draw.box).toEqual(BOX)
    expect(resolved.draw.fill).toBe('#ff0000')
  })

  it('refuses corrupt angles fail-closed (never an axis-aligned silent raster)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '45' as never]) {
      const shape = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: { ...SOLID }, rotation: bad }
      expect(resolvePendingBitmapShapePreview(shape as never, BOUNDS)).toEqual({ kind: 'refused', reason: 'bad-input' })
    }
  })
})

describe('pendingSelectionForShape with rotation', () => {
  it('matches the legacy inflated box at 0 degrees', () => {
    const axis = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    // Filled padding is 1.
    expect(pendingSelectionForShape(axis)).toEqual({ x: 279, y: 259, width: 202, height: 102 })
  })

  it('reports the tight rotated bbox of the inflated local box', () => {
    const rotated = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    const selection = pendingSelectionForShape(rotated)!
    const want = (202 + 102) * Math.SQRT1_2
    expect(Math.abs(selection.width - want)).toBeLessThan(1e-9)
    expect(Math.abs(selection.height - want)).toBeLessThan(1e-9)
    expect(Math.abs(selection.x + selection.width / 2 - CENTER.x)).toBeLessThan(1e-9)
    expect(Math.abs(selection.y + selection.height / 2 - CENTER.y)).toBeLessThan(1e-9)
  })

  it('includes the outlined brush padding before rotating', () => {
    const outlined = createPendingBitmapShape('rect', BOX, 'outlined', { ...SOLID, brushSize: 8 }, 90)
    const selection = pendingSelectionForShape(outlined)!
    // Padding 8/2+1 = 5; 90-degree bbox swaps the inflated extents.
    expect(selection.width).toBeCloseTo(110, 9)
    expect(selection.height).toBeCloseTo(210, 9)
  })

  it('fails closed to no outline on a corrupt staged angle (shape retained)', () => {
    const rotated = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    const corrupt = { ...rotated, rotation: Number.NaN }
    expect(pendingSelectionForShape(corrupt)).toBeUndefined()
  })
})

describe('rotated paint resolves gradients in the local frame', () => {
  function mockGradient() {
    return { addColorStop: mock() }
  }

  function mockContext(overrides: Record<string, unknown> = {}) {
    return {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      save: mock(),
      restore: mock(),
      setTransform: mock(),
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

  it('horizontal gradients span the local box after the rotation transform', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape('rect', { x: 280, y: 260, width: 200, height: 100 }, 'filled', {
      ...SOLID,
      gradient: 'horizontal',
      secondary: '#0000ff',
    }, 45)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const context = ctx as unknown as {
      translate: { mock: { calls: unknown[][] } }
      rotate: { mock: { calls: unknown[][] } }
      createLinearGradient: { mock: { calls: unknown[][] } }
      fillRect: { mock: { calls: unknown[][] } }
    }
    expect(context.translate.mock.calls[0]![0]).toBeCloseTo(CENTER.x, 9)
    expect(context.translate.mock.calls[0]![1]).toBeCloseTo(CENTER.y, 9)
    expect(context.rotate.mock.calls[0]![0]).toBeCloseTo(Math.PI / 4, 9)
    // Local horizontal ramp: left (-100,-50) to right (100,-50).
    expect(context.createLinearGradient.mock.calls[0]).toEqual([-100, -50, 100, -50])
    // Centered local paint: the exclusive painter reuses the same path code.
    expect(context.fillRect.mock.calls[0]).toEqual([-100, -50, 200, 100])
  })

  it('radial gradients center on the local origin with the longest-side radius', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape('oval', { x: 10, y: 20, width: 200, height: 100 }, 'filled', {
      ...SOLID,
      gradient: 'radial',
      secondary: '#0000ff',
    }, -30)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const context = ctx as unknown as {
      createRadialGradient: { mock: { calls: unknown[][] } }
      rotate: { mock: { calls: unknown[][] } }
    }
    expect(context.createRadialGradient.mock.calls[0]).toEqual([0, 0, 0, 0, 0, 100])
    expect(context.rotate.mock.calls[0]![0]).toBeCloseTo((-30 * Math.PI) / 180, 9)
  })

  it('outlined keeps the shared brush width under rotation', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape('rect', BOX, 'outlined', SOLID, 45)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const context = ctx as unknown as { strokeRect: { mock: { calls: unknown[][] } }; lineWidth: number }
    expect(context.strokeRect.mock.calls[0]).toEqual([-100, -50, 200, 100])
    expect((ctx as unknown as { lineWidth: number }).lineWidth).toBe(6)
  })

  it('fails closed without translating when the context cannot transform', () => {
    const ctx = mockContext({ translate: undefined, rotate: undefined }) as never
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID, 45)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(false)
  })

  it('direct rotated style resolution uses the centered local box', () => {
    const ctx = mockContext() as never
    const local = {
      kind: 'rect',
      box: { x: -100, y: -50, width: 200, height: 100 },
      mode: 'filled',
      fill: '#ff0000',
      secondary: '#0000ff',
      gradient: 'vertical',
      fillTransparent: false,
      secondaryTransparent: false,
      brushSize: 6,
      rotation: 45,
    } as never
    expect(resolvePendingShapePreviewStyle(ctx, local)).toBeDefined()
    const context = ctx as unknown as { createLinearGradient: { mock: { calls: unknown[][] } } }
    // Vertical local ramp mirrors the screen-space geometry byte-for-byte
    // (left edge x to left edge x + height), so direction is what travels.
    expect(context.createLinearGradient.mock.calls[0]).toEqual([-100, -50, -100, 50])
  })

  it('zero rotation keeps the legacy screen-space paint path', () => {
    const ctx = mockContext() as never
    const pending = createPendingBitmapShape('rect', BOX, 'filled', SOLID)
    const resolved = resolvePendingBitmapShapePreview(pending, BOUNDS)
    expect(resolved.kind).toBe('draw')
    if (resolved.kind !== 'draw') return
    expect(paintPendingBitmapShapePreview(ctx, resolved.draw)).toBe(true)
    const context = ctx as unknown as {
      translate: { mock: { calls: unknown[][] } }
      createLinearGradient: { mock: { calls: unknown[][] } }
      fillRect: { mock: { calls: unknown[][] } }
    }
    expect(context.translate.mock.calls.length).toBe(0)
    expect(context.fillRect.mock.calls[0]).toEqual([BOX.x, BOX.y, BOX.width, BOX.height])
  })
})

// Re-export check: the legacy quarter-turn module still exposes its API.
describe('legacy rotate90 API intact', () => {
  it('still exports the direction-based rotation', () => {
    expect(typeof rotatePendingBitmapShape).toBe('function')
  })
})
