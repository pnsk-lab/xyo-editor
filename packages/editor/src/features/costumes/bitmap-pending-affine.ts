// Exact bounded affine transform model for a pending bitmap rect/oval shape.
//
// Reference model (own-words summary, no source text copied): the staged bit
// rect/oval stays a parametric vector object under the armed shape tool and
// the bounding-box tool scales it with a world-axis scale about the screen
// selection pivot. After a rotation the combined screen map is a non-uniform
// `S * R` (scale after rotation), which shears in the shape's local frame and
// is NOT expressible as an axis-aligned local box plus a scalar rotation.
// This module owns that exact map: the local box + scalar `rotation` stay
// frozen as the shape's local frame (legacy fields untouched) and a bounded
// Canvas 2x3 matrix `M` carries the screen transform. The final screen point
// is `M * R(center) * local`, where `R` is the legacy center rotation and `M`
// starts as identity. A pure scale drag therefore left-composes a pivot
// scale `M' = T(P) * S * T(-P) * M0`, never a local box rewrite, so skew is
// represented exactly instead of being rounded into a box.
//
// Canvas matrix semantics (`setTransform` parity, y-down): a point maps as
// `x' = a * x + c * y + e`, `y' = b * x + d * y + f`. Linear gradients
// resolve AFTER the transform is applied (see the preview module), so ramps
// travel with the shape; the outlined contour keeps the shared local brush
// width and the CTM scales it automatically (effective stroke scaling is the
// CTM itself, pinned by `effectivePendingAffineStrokeScales` below).
//
// Bounds + failure policy (mirrors `bitmap-cropped-save.ts`): never throws.
// Every entry returns `undefined` (or the input shape unchanged for the
// shape-level wrappers) on invalid input: non-finite numbers, degenerate
// spans (handle == pivot, scale undefined), singular determinants, or an
// AABB that is non-finite / empty / beyond the allocation budget. Mirror
// (negative scale) is allowed and sign-preserving; exact-zero spans are
// clamped to the shared minimum-magnitude scale, never NaN.
//
// This module was written independently for this repository without copying
// any third-party source.

import { isBitmapSourceSizeRefused } from './bitmap-artboard'
import { normalizeRotationDegrees } from './rotation-gesture'

function normalizeAffineRotationDegrees(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const normalized = normalizeRotationDegrees(value)
  if (!Number.isFinite(normalized)) return 0
  if (Math.abs(normalized) < 1e-9) return 0
  return normalized
}

/** Canvas 2x3 screen transform (`setTransform(a, b, c, d, e, f)` parity). */
export type PendingAffine2x3 = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export type PendingAffineBox = {
  x: number
  y: number
  width: number
  height: number
}

export type PendingAffinePoint = {
  x: number
  y: number
}

export type PendingAffineScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type PendingAffineScaleModifiers = {
  /** Corner handles free both axes when true (edges always free single-axis). */
  shiftKey?: boolean
  /** Pin the screen AABB center instead of the opposite handle. */
  altKey?: boolean
  /** Explicit uniform override; defaults to corner-without-Shift. */
  uniform?: boolean
}

/** Smallest absolute screen scale kept; tinier drags snap with sign kept. */
export const MIN_PENDING_AFFINE_SCALE_FACTOR = 0.001

/** Span below which a screen scale is degenerate (handle == pivot). */
const PENDING_AFFINE_SPAN_EPSILON = 1e-7

/** Determinant magnitude below which a matrix is treated as singular. */
const PENDING_AFFINE_DET_EPSILON = 1e-12

/** AABB side beyond which a scale is refused (never allocate, fail closed). */
const PENDING_AFFINE_MAX_SIDE = 16384

export const PENDING_AFFINE_IDENTITY: PendingAffine2x3 = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
}

export function isValidAffineMatrix(value: unknown): value is PendingAffine2x3 {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const { a, b, c, d, e, f } = record
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    typeof c === 'number' &&
    typeof d === 'number' &&
    typeof e === 'number' &&
    typeof f === 'number' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    Number.isFinite(d) &&
    Number.isFinite(e) &&
    Number.isFinite(f)
  )
}

export function isAffineIdentity(matrix: PendingAffine2x3): boolean {
  return (
    matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1 && matrix.e === 0 && matrix.f === 0
  )
}

export function cloneAffineMatrix(matrix: PendingAffine2x3): PendingAffine2x3 {
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }
}

function isValidBox(box: unknown): box is PendingAffineBox {
  if (typeof box !== 'object' || box === null) return false
  const record = box as Record<string, unknown>
  const { x, y, width, height } = record
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return false
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return false
  }
  return width > 0 && height > 0
}

function isValidPoint(point: unknown): point is PendingAffinePoint {
  if (typeof point !== 'object' || point === null) return false
  const record = point as Record<string, unknown>
  return (
    typeof record.x === 'number' &&
    typeof record.y === 'number' &&
    Number.isFinite(record.x) &&
    Number.isFinite(record.y)
  )
}

function isValidHandle(handle: unknown): handle is PendingAffineScaleHandle {
  return (
    handle === 'nw' ||
    handle === 'n' ||
    handle === 'ne' ||
    handle === 'e' ||
    handle === 'se' ||
    handle === 's' ||
    handle === 'sw' ||
    handle === 'w'
  )
}

function isValidRotation(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Determinant of the linear part (`a * d - b * c`). */
export function pendingAffineDeterminant(matrix: PendingAffine2x3): number {
  return matrix.a * matrix.d - matrix.b * matrix.c
}

/** Compose `outer` after `inner` (`outer o inner`: apply `inner` first). */
export function composePendingAffine(outer: PendingAffine2x3, inner: PendingAffine2x3): PendingAffine2x3 {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

export function translatePendingAffine(matrix: PendingAffine2x3, dx: number, dy: number): PendingAffine2x3 | undefined {
  try {
    if (!isValidAffineMatrix(matrix)) return undefined
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      return undefined
    }
    if (dx === 0 && dy === 0) return cloneAffineMatrix(matrix)
    return composePendingAffine({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }, matrix)
  } catch {
    return undefined
  }
}

/** Map one local point through `matrix` (Canvas `setTransform` parity). */
export function applyPendingAffineToPoint(
  matrix: PendingAffine2x3,
  point: PendingAffinePoint,
): PendingAffinePoint | undefined {
  try {
    if (!isValidAffineMatrix(matrix) || !isValidPoint(point)) return undefined
    const x = matrix.a * point.x + matrix.c * point.y + matrix.e
    const y = matrix.b * point.x + matrix.d * point.y + matrix.f
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x, y }
  } catch {
    return undefined
  }
}

/**
 * Rotate a screen point about a center by clockwise degrees (y-down
 * positive). Own math: the standard rotation matrix applies unchanged in
 * y-down space because a visual clockwise turn maps east to south, exactly
 * what the matrix yields for +90 degrees.
 */
function rotateScreenPoint(
  point: PendingAffinePoint,
  center: PendingAffinePoint,
  degreesClockwise: number,
): PendingAffinePoint | undefined {
  try {
    if (!isValidPoint(point) || !isValidPoint(center)) return undefined
    if (typeof degreesClockwise !== 'number' || !Number.isFinite(degreesClockwise)) return undefined
    const radians = (degreesClockwise * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    if (!Number.isFinite(cos) || !Number.isFinite(sin)) return undefined
    const dx = point.x - center.x
    const dy = point.y - center.y
    const x = center.x + dx * cos - dy * sin
    const y = center.y + dx * sin + dy * cos
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x, y }
  } catch {
    return undefined
  }
}

/**
 * Map a local shape point to screen space: first the legacy center rotation,
 * then the affine screen transform. With identity affine this reduces exactly
 * to the legacy rotated point; with a scale drag it yields the `S * R` skew.
 */
export function pendingShapeLocalToScreen(
  local: PendingAffinePoint,
  box: PendingAffineBox,
  rotation: number,
  affine: PendingAffine2x3,
): PendingAffinePoint | undefined {
  try {
    if (!isValidPoint(local) || !isValidBox(box)) return undefined
    if (!isValidRotation(rotation) || !isValidAffineMatrix(affine)) return undefined
    const normalized = normalizeAffineRotationDegrees(rotation)
    let x = local.x
    let y = local.y
    if (Math.abs(normalized) >= 1e-9) {
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const rotated = rotateScreenPoint(local, center, normalized)
      if (!rotated) return undefined
      x = rotated.x
      y = rotated.y
    }
    return applyPendingAffineToPoint(affine, { x, y })
  } catch {
    return undefined
  }
}

/**
 * Tight screen axis-aligned bounding box of a pending shape: the AABB of
 * the four local corners mapped through `R` then `M`. Selection handles sit
 * on this box. Returns `undefined` (never throws) on invalid input.
 */
export function pendingAffineSelectionAABB(
  box: PendingAffineBox,
  rotation: number,
  affine: PendingAffine2x3,
): PendingAffineBox | undefined {
  try {
    if (!isValidBox(box) || !isValidRotation(rotation) || !isValidAffineMatrix(affine)) return undefined
    const corners: PendingAffinePoint[] = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ]
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const corner of corners) {
      const mapped = pendingShapeLocalToScreen(corner, box, rotation, affine)
      if (!mapped) return undefined
      if (mapped.x < minX) minX = mapped.x
      if (mapped.y < minY) minY = mapped.y
      if (mapped.x > maxX) maxX = mapped.x
      if (mapped.y > maxY) maxY = mapped.y
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return undefined
    }
    const width = maxX - minX
    const height = maxY - minY
    if (!(width > 0 && height > 0)) return undefined
    if (width > PENDING_AFFINE_MAX_SIDE || height > PENDING_AFFINE_MAX_SIDE) return undefined
    return { x: minX, y: minY, width, height }
  } catch {
    return undefined
  }
}

/** Screen AABB handle position (corners + edge midpoints). */
export function pendingAffineAabbHandle(aabb: PendingAffineBox, handle: PendingAffineScaleHandle): PendingAffinePoint {
  const centerX = aabb.x + aabb.width / 2
  const centerY = aabb.y + aabb.height / 2
  return {
    x: handle.includes('w') ? aabb.x : handle.includes('e') ? aabb.x + aabb.width : centerX,
    y: handle.includes('n') ? aabb.y : handle.includes('s') ? aabb.y + aabb.height : centerY,
  }
}

function pendingAffineOppositeHandle(handle: PendingAffineScaleHandle): PendingAffineScaleHandle {
  switch (handle) {
    case 'n':
      return 's'
    case 's':
      return 'n'
    case 'e':
      return 'w'
    case 'w':
      return 'e'
    case 'nw':
      return 'se'
    case 'ne':
      return 'sw'
    case 'sw':
      return 'ne'
    case 'se':
      return 'nw'
  }
}

function isCornerHandle(handle: PendingAffineScaleHandle): boolean {
  return handle.length === 2
}

function clampScaleFactor(value: number): number {
  if (!Number.isFinite(value)) return 1
  if (Math.abs(value) >= MIN_PENDING_AFFINE_SCALE_FACTOR) return value
  return value < 0 ? -MIN_PENDING_AFFINE_SCALE_FACTOR : MIN_PENDING_AFFINE_SCALE_FACTOR
}

/**
 * Effective stroke scales carried by the CTM: the local brush width is NOT
 * pre-scaled (the painter keeps `lineWidth = brushSize` and lets the
 * transform scale it, so non-uniform drags distort the contour exactly like
 * a vector scale). `x`/`y` are the axis scales (`hypot` of each column);
 * `area` is `sqrt(|det|)` (the uniform-equivalent scale).
 */
export function effectivePendingAffineStrokeScales(matrix: PendingAffine2x3):
  | { x: number; y: number; area: number }
  | undefined {
  try {
    if (!isValidAffineMatrix(matrix)) return undefined
    const x = Math.hypot(matrix.a, matrix.b)
    const y = Math.hypot(matrix.c, matrix.d)
    const det = Math.abs(pendingAffineDeterminant(matrix))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(det)) return undefined
    return { x, y, area: Math.sqrt(det) }
  } catch {
    return undefined
  }
}

/**
 * Frozen drag origin for an exact screen-axis affine scale.
 *
 * Handles sit on the screen AABB, so the drag freezes the START screen box
 * (`startAabb`), its center, the opposite-handle pivot `P` (or the center
 * for Alt), and the pointer-down handle position `H0`. Every move measures
 * the DIRECT screen-axis ratios `sx = (cur.x - P.x) / (H0.x - P.x)` (same
 * for `y`) and left-composes `T(P) * S * T(-P)` onto the frozen START
 * affine `M0`. Zero delta replays `M0` exactly (no jump); the pivot maps to
 * itself exactly (pivot anchored); Alt keeps the center (both sides grow).
 */
export type PendingAffineScaleDragState = {
  localBox: PendingAffineBox
  rotation: number
  startAffine: PendingAffine2x3
  startAabb: PendingAffineBox
  pivot: PendingAffinePoint
  startHandle: PendingAffinePoint
  handle: PendingAffineScaleHandle
}

export function beginPendingAffineScaleDrag(
  localBox: PendingAffineBox,
  rotation: number,
  startAffine: PendingAffine2x3 | undefined,
  handle: PendingAffineScaleHandle,
  startPoint: PendingAffinePoint,
  modifiers: PendingAffineScaleModifiers = {},
): PendingAffineScaleDragState | undefined {
  try {
    if (!isValidBox(localBox) || !isValidRotation(rotation)) return undefined
    const affine = startAffine === undefined ? { ...PENDING_AFFINE_IDENTITY } : startAffine
    if (!isValidAffineMatrix(affine)) return undefined
    if (!isValidHandle(handle) || !isValidPoint(startPoint)) return undefined
    if (typeof modifiers !== 'object' || modifiers === null) return undefined
    const det = pendingAffineDeterminant(affine)
    if (!Number.isFinite(det) || Math.abs(det) < PENDING_AFFINE_DET_EPSILON) return undefined
    const startAabb = pendingAffineSelectionAABB(localBox, rotation, affine)
    if (!startAabb) return undefined
    const centered = modifiers.altKey === true
    const pivot = centered
      ? { x: startAabb.x + startAabb.width / 2, y: startAabb.y + startAabb.height / 2 }
      : pendingAffineAabbHandle(startAabb, pendingAffineOppositeHandle(handle))
    if (!Number.isFinite(pivot.x) || !Number.isFinite(pivot.y)) return undefined
    return {
      localBox: { ...localBox },
      rotation: normalizeAffineRotationDegrees(rotation),
      startAffine: cloneAffineMatrix(affine),
      startAabb: { ...startAabb },
      pivot: { ...pivot },
      startHandle: { x: startPoint.x, y: startPoint.y },
      handle,
    }
  } catch {
    return undefined
  }
}

/**
 * Resolve one screen-axis affine scale move to a new screen matrix.
 *
 * Reference equations (world-axis `S` about the screen pivot `P`):
 * `sx = (cur.x - P.x) / (H0.x - P.x)` on moving axes (`1` elsewhere),
 * `sy` likewise; corner default uniform keeps
 * `mag = max(|sx|, |sy|)` with each axis' own reference sign
 * (`sx = sign(sx) * mag`, `sy = sign(sy) * mag`); Shift frees the corner;
 * edges stay single-axis. Mirror (negative) is preserved; magnitudes below
 * the shared minimum snap with sign kept; degenerate spans, non-finite
 * inputs, singular determinants, and over-budget AABBs fail closed to
 * `undefined`. Returns the composed `M' = T(P) * S * T(-P) * M0`.
 */
export function resolvePendingAffineScale(
  state: PendingAffineScaleDragState,
  currentPoint: PendingAffinePoint,
  modifiers: PendingAffineScaleModifiers = {},
  bounds?: { width: number; height: number },
): PendingAffine2x3 | undefined {
  try {
    if (typeof state !== 'object' || state === null) return undefined
    if (!isValidBox(state.localBox) || !isValidRotation(state.rotation)) return undefined
    if (!isValidAffineMatrix(state.startAffine)) return undefined
    if (!isValidBox(state.startAabb) || !isValidPoint(state.pivot) || !isValidPoint(state.startHandle)) return undefined
    if (!isValidHandle(state.handle) || !isValidPoint(currentPoint)) return undefined
    if (typeof modifiers !== 'object' || modifiers === null) return undefined
    const centered = modifiers.altKey === true
    // Alt toggled mid-drag re-anchors the pivot to the frozen START center
    // (absolute-drag discipline: never the moving box, so no drift).
    const pivot = centered
      ? { x: state.startAabb.x + state.startAabb.width / 2, y: state.startAabb.y + state.startAabb.height / 2 }
      : { ...state.pivot }
    const movesX = state.handle.includes('w') || state.handle.includes('e')
    const movesY = state.handle.includes('n') || state.handle.includes('s')
    const spanX = state.startHandle.x - state.pivot.x
    const spanY = state.startHandle.y - state.pivot.y
    // Centered spans measure double (both sides grow): recompute from pivot.
    const useSpanX = centered && movesX ? state.startHandle.x - pivot.x : spanX
    const useSpanY = centered && movesY ? state.startHandle.y - pivot.y : spanY
    let scaleX = 1
    let scaleY = 1
    if (movesX) {
      if (Math.abs(useSpanX) < PENDING_AFFINE_SPAN_EPSILON) return undefined
      const raw = (currentPoint.x - pivot.x) / useSpanX
      if (!Number.isFinite(raw)) return undefined
      scaleX = raw
    }
    if (movesY) {
      if (Math.abs(useSpanY) < PENDING_AFFINE_SPAN_EPSILON) return undefined
      const raw = (currentPoint.y - pivot.y) / useSpanY
      if (!Number.isFinite(raw)) return undefined
      scaleY = raw
    }
    const corner = isCornerHandle(state.handle)
    const uniform = modifiers.uniform ?? (corner && modifiers.shiftKey !== true)
    if (uniform && corner) {
      const magnitude = Math.max(Math.abs(scaleX), Math.abs(scaleY))
      if (!Number.isFinite(magnitude)) return undefined
      scaleX = (scaleX < 0 ? -1 : 1) * magnitude
      scaleY = (scaleY < 0 ? -1 : 1) * magnitude
    }
    if (movesX) scaleX = clampScaleFactor(scaleX)
    else scaleX = 1
    if (movesY) scaleY = clampScaleFactor(scaleY)
    else scaleY = 1
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return undefined
    if (scaleX === 0 || scaleY === 0) return undefined
    const toPivot: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: pivot.x, f: pivot.y }
    const scale: PendingAffine2x3 = { a: scaleX, b: 0, c: 0, d: scaleY, e: 0, f: 0 }
    const fromPivot: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: -pivot.x, f: -pivot.y }
    const composed = composePendingAffine(toPivot, composePendingAffine(scale, composePendingAffine(fromPivot, state.startAffine)))
    if (!isValidAffineMatrix(composed)) return undefined
    const det = pendingAffineDeterminant(composed)
    if (!Number.isFinite(det) || Math.abs(det) < PENDING_AFFINE_DET_EPSILON) return undefined
    const aabb = pendingAffineSelectionAABB(state.localBox, state.rotation, composed)
    if (!aabb) return undefined
    if (bounds !== undefined) {
      if (typeof bounds !== 'object' || bounds === null) return undefined
      const record = bounds as Record<string, unknown>
      if (!Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height)) return undefined
      const w = record.width as number
      const h = record.height as number
      if (!(w > 0 && h > 0)) return undefined
      if (isBitmapSourceSizeRefused(w, h)) return undefined
      // Bounded: partial overflow clips at draw time, but a scale whose AABB
      // alone would refuse allocation fails closed before any pixel work.
      if (Number.isSafeInteger(Math.ceil(aabb.width)) && Number.isSafeInteger(Math.ceil(aabb.height))) {
        if (aabb.width > 0 && aabb.height > 0 && isBitmapSourceSizeRefused(Math.ceil(aabb.width), Math.ceil(aabb.height))) {
          return undefined
        }
      }
    }
    return composed
  } catch {
    return undefined
  }
}

/**
 * Compose an arbitrary screen rotation (clockwise degrees, y-down) about a
 * screen center into the affine (`M' = T(C) * R * T(-C) * M`). The local
 * box, scalar rotation, and style stay VERBATIM — only `M` changes. Exact
 * quarter turns dispatch to the integer path (no trigonometry); other angles
 * use own cos/sin math and fail closed on non-finite input.
 */
export function rotatePendingAffineBy(
  affine: PendingAffine2x3,
  center: PendingAffinePoint,
  degreesClockwise: number,
): PendingAffine2x3 | undefined {
  try {
    if (!isValidAffineMatrix(affine) || !isValidPoint(center)) return undefined
    if (typeof degreesClockwise !== 'number' || !Number.isFinite(degreesClockwise)) return undefined
    const det = pendingAffineDeterminant(affine)
    if (!Number.isFinite(det) || Math.abs(det) < PENDING_AFFINE_DET_EPSILON) return undefined
    const normalized = ((degreesClockwise % 360) + 360) % 360
    const snapped = Math.round(normalized / 90) * 90 % 360
    // Snap near-quarter turns to the exact integer path (no trig drift).
    if (Math.abs(normalized - snapped) < 1e-9 || Math.abs(Math.abs(normalized - snapped) - 360) < 1e-9) {
      const quarter = ((Math.round(snapped / 90) % 4) + 4) % 4
      if (quarter === 0) return cloneAffineMatrix(affine)
      if (quarter === 1) return rotatePendingAffine90(affine, center, 'cw')
      if (quarter === 3) return rotatePendingAffine90(affine, center, 'ccw')
      const half: PendingAffine2x3 = { a: -1, b: 0, c: 0, d: -1, e: 0, f: 0 }
      const toCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: center.x, f: center.y }
      const fromCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: -center.x, f: -center.y }
      const composed = composePendingAffine(toCenter, composePendingAffine(half, composePendingAffine(fromCenter, affine)))
      if (!isValidAffineMatrix(composed)) return undefined
      return composed
    }
    const radians = (degreesClockwise * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    if (!Number.isFinite(cos) || !Number.isFinite(sin)) return undefined
    const turn: PendingAffine2x3 = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
    const toCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: center.x, f: center.y }
    const fromCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: -center.x, f: -center.y }
    const composed = composePendingAffine(toCenter, composePendingAffine(turn, composePendingAffine(fromCenter, affine)))
    if (!isValidAffineMatrix(composed)) return undefined
    const nextDet = pendingAffineDeterminant(composed)
    if (!Number.isFinite(nextDet) || Math.abs(nextDet) < PENDING_AFFINE_DET_EPSILON) return undefined
    return composed
  } catch {
    return undefined
  }
}

/**
 * Compose an exact quarter turn about a screen center into the affine (`cw`
 * / `ccw`). The local box, scalar rotation, and style stay VERBATIM — only
 * `M` changes — so legacy fields never break and repeated turns never drift
 * (exact integer entries, no trigonometry). Invalid input fails closed to
 * `undefined`.
 */
export function rotatePendingAffine90(
  affine: PendingAffine2x3,
  center: PendingAffinePoint,
  direction: 'cw' | 'ccw',
): PendingAffine2x3 | undefined {
  try {
    if (!isValidAffineMatrix(affine) || !isValidPoint(center)) return undefined
    if (direction !== 'cw' && direction !== 'ccw') return undefined
    const det = pendingAffineDeterminant(affine)
    if (!Number.isFinite(det) || Math.abs(det) < PENDING_AFFINE_DET_EPSILON) return undefined
    // y-down clockwise 90: (dx, dy) -> (-dy, dx); ccw: (dx, dy) -> (dy, -dx).
    const turn: PendingAffine2x3 =
      direction === 'cw' ? { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 } : { a: 0, b: -1, c: 1, d: 0, e: 0, f: 0 }
    const toCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: center.x, f: center.y }
    const fromCenter: PendingAffine2x3 = { a: 1, b: 0, c: 0, d: 1, e: -center.x, f: -center.y }
    const composed = composePendingAffine(toCenter, composePendingAffine(turn, composePendingAffine(fromCenter, affine)))
    if (!isValidAffineMatrix(composed)) return undefined
    const nextDet = pendingAffineDeterminant(composed)
    if (!Number.isFinite(nextDet) || Math.abs(nextDet) < PENDING_AFFINE_DET_EPSILON) return undefined
    return composed
  } catch {
    return undefined
  }
}
