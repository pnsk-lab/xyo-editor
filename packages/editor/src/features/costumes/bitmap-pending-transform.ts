import { normalizePendingRotationDegrees, type PendingBitmapShape, type PendingBitmapShapeStyle } from './bitmap-pending-shape'
import { getPendingAffineOrIdentity } from './bitmap-pending-shape'
import { isBitmapSourceSizeRefused } from './bitmap-artboard'
import {
  isValidAffineMatrix,
  pendingAffineSelectionAABB,
  rotatePendingAffine90,
  rotatePendingAffineBy,
} from './bitmap-pending-affine'
import {
  isRotationNoop,
  ROTATION_SNAP_STEP_DEGREES,
  snapRotationDegrees,
} from './rotation-gesture'

/**
 * Pure parametric 90-degree rotation for a pending bitmap rect/oval shape.
 *
 * Reference model (own-words summary, no source text copied): in scratch-paint
 * the bit rect/oval `mouseUp` does NOT rasterize — the new vector shape stays
 * selected under the armed shape tool and the bounding-box handle moves,
 * scales and ROTATES it parametrically; only a later deselect (blank press,
 * Escape, tool/mode/target/costume/project switch) commits the raster via
 * `commitRectToBitmap` / `commitOvalToBitmap`. This helper owns the ROTATE leg
 * of that parametric side: exact box math plus the gradient-kind rotation, no
 * pixels, no VM, no canvas, no history.
 *
 * Vector choice (deliberate, documented): rotation is a parametric box swap
 * about the shape's own center with the pre-stroke base left frozen; the
 * overlay re-renders as the same single-pass `base + shape` the preview
 * already pins (`compositePendingBitmapShapePreview`). The alternative —
 * rotating already-painted raster pixels (the committed-path `rotateFloating…
 * ` brush-pixel permutation) — would bake pixels before commit, break the
 * `base + shape` single-pass invariant (double composition on re-render), and
 * contradict the reference keep-vector-until-deselect behavior, so it is NOT
 * used here. For exact quarter turns both routes agree pixel-for-pixel on
 * solid fills (a 90° pixel permutation of a solid box equals the re-painted
 * swapped box); the gradient stop-order rule below closes the only place the
 * two routes can visibly differ (two reversing direction×kind cases swap
 * stops, verified against an independent Canvas pixel oracle).
 *
 * Geometry (canvas px, resolution-independent): the box lives in canvas px,
 * so res1 (1 canvas px = 2 Paper units) and res2 (1 canvas px = 1 Paper unit)
 * share the identical rotation — resolution changes only the commit gate
 * (`shouldCommitBitmapShapeDrag` k-factor), never this math. Rotation is
 * about the shape's OWN center (`cx = x + w / 2`, `cy = y + h / 2`), never
 * the artboard center: `newW = h`, `newH = w`,
 * `newX = cx - newW / 2`, `newY = cy - newH / 2`. A square (`w == h`) keeps
 * its box exactly (center included); only a horizontal/vertical gradient kind
 * still flips.
 *
 * Snapped integer rules: canvas raster boxes are integer-aligned (a `.5`
 * `fillRect`/`ellipse` origin antialiases instead of painting crisp stage
 * pixels). Asymmetric odd sizes put the center on a half pixel
 * (e.g. `w = 101` → `cx = x + 50.5`), so the exact rotated origin can be
 * `.5`. All four of `x / y / width / height` are snapped with `Math.round`
 * (round-half-up) AFTER the exact center computation, so the painted box is
 * always integer-aligned with at most a 0.5px center drift. Integer inputs
 * with even sizes are unaffected (round is a no-op); integer inputs with odd
 * sizes shift by exactly 0.5px to the nearest integer origin.
 *
 * Bounds + clamping (mirrors `retargetPendingBitmapShape` and the preview
 * resolver): `bounds` is the live canvas size in integer canvas px and MUST
 * be validated finite (safe integers `> 0`, inside the raster side/area
 * budget — oversized workspaces are refused before any copy, never
 * allocated). The snapped box is clamped to the canvas address range:
 * `width = min(bounds.width, snappedW)`,
 * `height = min(bounds.height, snappedH)`,
 * `x = clamp(snappedX, -width, bounds.width)`,
 * `y = clamp(snappedY, -height, bounds.height)`. Partial overflow still clips
 * naturally at draw time (like the reference matrix path); an oversized
 * rotated box can never force an allocation.
 *
 * Style + gradients: `kind` (`rect`/`oval`), `mode` (`filled`/`outlined`),
 * colors, transparents and `brushSize` are preserved verbatim. Gradient kinds
 * rotate with the shape: `horizontal <-> vertical` swap on every quarter turn
 * (a left→right ramp becomes a top→bottom ramp); `solid` and `radial` are
 * rotation-invariant and kept as-is. The preview re-resolves the paint from
 * the NEW box at draw time, so blend/clipping stay identical to a freshly
 * staged shape with that box (no extra pass, no extra blend).
 *
 * Gradient stop-order parity (pixel-verified, Canvas 2d reference): a true
 * vector rotation carries the gradient WITH the shape. Canvas 2d uses a
 * y-down space, so a visual clockwise turn maps `(dx, dy) -> (-dy, dx)` about
 * the shape center. For a horizontal source (`t = (x - box.x) / w`):
 * cw maps `t_s = (dy' + w/2) / w = t_c` (no reversal), ccw maps
 * `t_s = 1 - t_c` (reversal). For a vertical source
 * (`t = (y - box.y) / h`): cw maps `t_s = 1 - t_c` (reversal), ccw maps
 * `t_s = t_c` (no reversal). Hence exactly two of the four
 * (direction × kind) cases reverse the stop order:
 * `ccw horizontal→vertical` and `cw vertical→horizontal` swap
 * `fill`/`secondary` (with their `fillTransparent`/`secondaryTransparent`
 * flags, never lossy hex restoration); the other two keep stop order and
 * only swap the KIND. Solid fills (the proven path, pinned by the session
 * fixtures) are unaffected either way. Reversal preserves every other
 * style/mode field and never introduces NaNs (pure finite box math +
 * string/boolean swaps only).
 *
 * Failure policy (mirrors `bitmap-cropped-save.ts`): never throws. Any invalid
 * input (bad shape, bad direction, invalid bounds) returns the SAME pending
 * object with `changed: false` so the session skips the re-render AND the
 * render invalidation (and writes no history either way), exactly like the
 * restyle/move/retarget no-op fast paths.
 */
export type PendingBitmapRotateDirection = 'cw' | 'ccw'

export type PendingBitmapRotateBounds = {
  width: number
  height: number
}

export type PendingBitmapRotateResult = {
  pending: PendingBitmapShape
  changed: boolean
}

function isValidRotateDirection(value: unknown): value is PendingBitmapRotateDirection {
  return value === 'cw' || value === 'ccw'
}

function isValidRotateBounds(bounds: unknown): bounds is PendingBitmapRotateBounds {
  if (typeof bounds !== 'object' || bounds === null) return false
  const record = bounds as Record<string, unknown>
  const { width, height } = record
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false
  const w = width as number
  const h = height as number
  if (!(w > 0 && h > 0)) return false
  if (isBitmapSourceSizeRefused(w, h)) return false
  return true
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Rotate a pending rect/oval shape 90 degrees clockwise (`'cw'`) or
 * counter-clockwise (`'ccw'`) about its own center within `bounds`.
 * Pure box + gradient-kind math: the input is never mutated, no VM/canvas/
 * history side effect can occur before commit (there is none in this module
 * at all). Returns the SAME object with `changed: false` when the rotation
 * is a no-op or any input is invalid (never throws).
 */
export function rotatePendingBitmapShape(
  pending: PendingBitmapShape,
  direction: PendingBitmapRotateDirection,
  bounds: PendingBitmapRotateBounds,
): PendingBitmapRotateResult {
  try {
    if (!isValidRotateDirection(direction)) return { pending, changed: false }
    if (!isValidRotateBounds(bounds)) return { pending, changed: false }
    if (typeof pending !== 'object' || pending === null) return { pending, changed: false }
    const record = pending as unknown as Record<string, unknown>
    const kind = record.kind
    if (kind !== 'rect' && kind !== 'oval') return { pending, changed: false }
    const boxRecord = record.box
    if (typeof boxRecord !== 'object' || boxRecord === null) return { pending, changed: false }
    const box = boxRecord as Record<string, unknown>
    const { x, y, width, height } = box
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      return { pending, changed: false }
    }
    if (!(width > 0 && height > 0)) return { pending, changed: false }

    // Non-axis staged shape: the box-swap model below is incompatible (it
    // would shear the rotated frame). Fail closed toward the exact vector
    // semantic instead — compose the quarter turn into `rotation` and keep
    // the local box + style verbatim (the preview carries gradients in the
    // local frame, which equals the legacy stop-swap for 90-degree steps).
    const stagedRotation = readPendingRotation(pending)
    if (stagedRotation === undefined) return { pending, changed: false }
    // Exact-affine staged shape: the screen map already carries `S * R`
    // skew (`affine` non-identity). A box swap would collapse the skew, so
    // compose the screen turn about the SELECTION center into the matrix
    // instead — local box, scalar rotation, and style stay VERBATIM and the
    // CTM keeps carrying gradients (no stop/color rewrite, never NaN).
    const stagedAffine = getPendingAffineOrIdentity(pending)
    if (isValidAffineMatrix(stagedAffine)) {
      const isIdentity =
        stagedAffine.a === 1 &&
        stagedAffine.b === 0 &&
        stagedAffine.c === 0 &&
        stagedAffine.d === 1 &&
        stagedAffine.e === 0 &&
        stagedAffine.f === 0
      if (!isIdentity) {
        const shapeBox = readValidPendingBox(pending)
        if (!shapeBox) return { pending, changed: false }
        const aabb = pendingAffineSelectionAABB(shapeBox, stagedRotation, stagedAffine)
        if (!aabb) return { pending, changed: false }
        const center = { x: aabb.x + aabb.width / 2, y: aabb.y + aabb.height / 2 }
        const composed = rotatePendingAffine90(stagedAffine, center, direction)
        if (!composed) return { pending, changed: false }
        const shape = pending as PendingBitmapShape
        return { pending: { ...shape, affine: composed }, changed: true }
      }
    }
    if (Math.abs(stagedRotation) > 1e-9) {
      return rotatePendingBitmapShapeBy(pending, direction === 'cw' ? 90 : -90, bounds)
    }

    // Exact center in canvas px (resolution-independent), then exact swap,
    // then integer snap. Direction does not affect the box for quarter turns
    // (cw and ccw share the same swapped box); it is still validated so a
    // typo can never silently become a rotation.
    void direction
    const centerX = x + width / 2
    const centerY = y + height / 2
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      return { pending, changed: false }
    }
    const snappedWidth = Math.round(height)
    const snappedHeight = Math.round(width)
    if (!(snappedWidth > 0 && snappedHeight > 0)) return { pending, changed: false }
    const snappedX = Math.round(centerX - height / 2)
    const snappedY = Math.round(centerY - width / 2)
    if (!Number.isFinite(snappedX) || !Number.isFinite(snappedY)) {
      return { pending, changed: false }
    }

    // Same clamp as `retargetPendingBitmapShape` / preview resolver.
    const clampedWidth = Math.max(0, Math.min(bounds.width, snappedWidth))
    const clampedHeight = Math.max(0, Math.min(bounds.height, snappedHeight))
    const clampedX = clampNumber(snappedX, -clampedWidth, Math.max(0, bounds.width))
    const clampedY = clampNumber(snappedY, -clampedHeight, Math.max(0, bounds.height))

    const shape = pending as PendingBitmapShape
    const currentBox = shape.box
    const style = (shape as { style?: unknown }).style as
      | PendingBitmapShapeStyle
      | undefined
    const currentGradient = (style as { gradient?: unknown } | undefined)?.gradient
    let nextGradient: PendingBitmapShapeStyle['gradient'] | undefined =
      currentGradient as PendingBitmapShapeStyle['gradient'] | undefined
    if (nextGradient === 'horizontal') nextGradient = 'vertical'
    else if (nextGradient === 'vertical') nextGradient = 'horizontal'
    else nextGradient = currentGradient as PendingBitmapShapeStyle['gradient'] | undefined

    // Pixel-exact stop parity: reverse stops in the two cases where the
    // y-down cw mapping sends t -> 1 - t (ccw from horizontal, cw from
    // vertical). Flag pairs travel with their hex (transparent ends reuse the
    // surviving RGB at draw time, so flags must swap — never bake alpha into
    // hex). No numeric math on colors: NaN-impossible by construction.
    const needsStopReversal =
      (direction === 'ccw' && currentGradient === 'horizontal') ||
      (direction === 'cw' && currentGradient === 'vertical')
    let nextFill: string | undefined
    let nextSecondary: string | undefined
    let nextFillTransparent: boolean | undefined
    let nextSecondaryTransparent: boolean | undefined
    if (
      needsStopReversal &&
      typeof style === 'object' &&
      style !== null &&
      (nextGradient === 'horizontal' || nextGradient === 'vertical')
    ) {
      nextFill = style.secondary
      nextSecondary = style.fill
      nextFillTransparent = style.secondaryTransparent
      nextSecondaryTransparent = style.fillTransparent
    }

    const gradientUnchanged =
      nextGradient === undefined || nextGradient === currentGradient
    // A reversal always implies a kind swap (h<->v), so gradientUnchanged is
    // already false there; the explicit check below keeps the intent pinned
    // even if a future kind table changes.
    const stopsUnchanged = nextFill === undefined
    const boxUnchanged =
      clampedX === currentBox.x &&
      clampedY === currentBox.y &&
      clampedWidth === currentBox.width &&
      clampedHeight === currentBox.height
    if (boxUnchanged && gradientUnchanged && stopsUnchanged) {
      return { pending, changed: false }
    }

    const styleUnchanged = gradientUnchanged && stopsUnchanged
    const nextStyle: PendingBitmapShapeStyle =
      !styleUnchanged && typeof style === 'object' && style !== null
        ? {
            ...shape.style,
            gradient: nextGradient as PendingBitmapShapeStyle['gradient'],
            ...(stopsUnchanged
              ? {}
              : {
                  fill: nextFill as string,
                  secondary: nextSecondary as string,
                  fillTransparent: nextFillTransparent as boolean,
                  secondaryTransparent: nextSecondaryTransparent as boolean,
                }),
          }
        : shape.style
    return {
      pending: {
        ...shape,
        box: { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight },
        style: nextStyle,
      },
      changed: true,
    }
  } catch {
    return { pending, changed: false }
  }
}

/**
 * Arbitrary-angle rotation for a pending bitmap rect/oval shape (free
 * rotate-handle parity, own math, no AGPL copy).
 *
 * Reference model (own-words summary): in scratch-paint the staged bit
 * rect/oval stays a selected vector shape under the armed shape tool and the
 * bounding-box tool rotates it by an ARBITRARY angle about its own center;
 * holding Shift snaps the gesture to 45-degree steps. Commit still happens
 * exactly once at deselect through the same raster path. This module owns the
 * parametric side of that gesture: the box stays the UNROTATED local extents
 * (so restyle / move / retarget / commit never bake pixels early) and only
 * `rotation` (clockwise degrees, y-down positive, normalized to (-180, 180])
 * changes. Gradients, transparents and brush size travel VERBATIM — the
 * preview resolves the paint in the rotated local frame at draw time, which
 * carries linear ramps with the shape exactly like a true vector rotation
 * (and equals the legacy quarter-turn stop-swap for 90-degree steps). No
 * stop/color stripping can occur here: style is never rewritten, only the
 * scalar angle.
 *
 * Absolute-drag discipline: every pointermove restarts from the frozen drag
 * START rotation plus the gesture delta (`startRotation + appliedDelta`, see
 * `resolveRotationGesture`), never from the previous preview, so repeated
 * drags and replays cannot drift. `rotatePendingBitmapShapeTo` is that
 * absolute setter; `rotatePendingBitmapShapeBy` is the relative convenience.
 * Corner resize after rotation maps the screen pointer into the local frame
 * (`unrotatePointForPendingShape`) and reuses the axis-aligned resolver, so
 * uniform / Alt-center / mirror rules hold in local axes.
 *
 * Failure policy (mirrors the quarter-turn leg): never throws. Any invalid
 * input (bad shape, non-finite angle, invalid bounds) returns the SAME
 * pending object with `changed: false` — the staged shape is retained, the
 * overlay is untouched, and no history or VM write can occur.
 */

function readPendingRotation(pending: PendingBitmapShape): number | undefined {
  if (typeof pending !== 'object' || pending === null) return undefined
  const raw = (pending as unknown as { rotation?: unknown }).rotation
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return raw
}

function readValidPendingBox(pending: PendingBitmapShape):
  | { x: number; y: number; width: number; height: number }
  | undefined {
  if (typeof pending !== 'object' || pending === null) return undefined
  const record = pending as unknown as Record<string, unknown>
  if (record.kind !== 'rect' && record.kind !== 'oval') return undefined
  const box = record.box
  if (typeof box !== 'object' || box === null) return undefined
  const { x, y, width, height } = box as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return undefined
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined
  }
  if (!(width > 0 && height > 0)) return undefined
  return { x, y, width, height }
}

/**
 * Rotate a 2d point about a center by clockwise degrees (screen y-down
 * positive, matching `rotationAngleOfPoint`). Own math: the standard rotation
 * matrix applies unchanged in y-down space because a visual clockwise turn
 * maps `(1, 0)` (east) to `(0, 1)` (south), exactly what the matrix yields
 * for +90 degrees. Returns `undefined` (never throws) on invalid input.
 */
export function rotatePointAroundCenter(
  point: { x: number; y: number },
  center: { x: number; y: number },
  degreesClockwise: number,
): { x: number; y: number } | undefined {
  try {
    if (typeof point !== 'object' || point === null || typeof center !== 'object' || center === null) return undefined
    const { x: px, y: py } = point as { x: unknown; y: unknown }
    const { x: cx, y: cy } = center as { x: unknown; y: unknown }
    if (typeof px !== 'number' || typeof py !== 'number' || typeof cx !== 'number' || typeof cy !== 'number') return undefined
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(cx) || !Number.isFinite(cy)) return undefined
    if (typeof degreesClockwise !== 'number' || !Number.isFinite(degreesClockwise)) return undefined
    const radians = (degreesClockwise * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    if (!Number.isFinite(cos) || !Number.isFinite(sin)) return undefined
    const dx = (px as number) - (cx as number)
    const dy = (py as number) - (cy as number)
    const x = (cx as number) + dx * cos - dy * sin
    const y = (cy as number) + dx * sin + dy * cos
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x, y }
  } catch {
    return undefined
  }
}

/**
 * Tight axis-aligned bounding box of a local box rotated about its own
 * center (the selection-outline geometry). Returns `undefined` (never
 * throws) on invalid input. A 0-degree rotation returns the equal box.
 */
export function rotatedPendingBoxBoundingBox(
  box: { x: number; y: number; width: number; height: number },
  rotationDegrees: number,
): { x: number; y: number; width: number; height: number } | undefined {
  try {
    if (typeof box !== 'object' || box === null) return undefined
    const { x, y, width, height } = box as { x: unknown; y: unknown; width: unknown; height: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      return undefined
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return undefined
    }
    if (!(width > 0 && height > 0)) return undefined
    // Corrupt angles fail closed (never silently treated as axis-aligned):
    // creation-time normalization maps them to 0, but the geometric helpers
    // must not invent an outline for an unpaintable angle.
    if (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees)) return undefined
    const rotation = normalizePendingRotationDegrees(rotationDegrees)
    if (Math.abs(rotation) < 1e-9) return { x, y, width, height }
    const centerX = x + width / 2
    const centerY = y + height / 2
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return undefined
    const corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ]
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const corner of corners) {
      const rotated = rotatePointAroundCenter(corner, { x: centerX, y: centerY }, rotation)
      if (!rotated) return undefined
      if (rotated.x < minX) minX = rotated.x
      if (rotated.y < minY) minY = rotated.y
      if (rotated.x > maxX) maxX = rotated.x
      if (rotated.y > maxY) maxY = rotated.y
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return undefined
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  } catch {
    return undefined
  }
}

/**
 * Absolute rotation setter: stage `rotationDegrees` (clockwise, normalized to
 * (-180, 180]) about the shape's own center, keeping the local box and the
 * style (kind / mode / colors / transparents / brush) VERBATIM. The box is
 * intentionally NOT snapped or swapped — the center stays exact so repeated
 * drags from the frozen start angle cannot drift.
 */
export function rotatePendingBitmapShapeTo(
  pending: PendingBitmapShape,
  rotationDegrees: number,
  bounds: PendingBitmapRotateBounds,
): PendingBitmapRotateResult {
  try {
    if (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees)) {
      return { pending, changed: false }
    }
    if (!isValidRotateBounds(bounds)) return { pending, changed: false }
    const box = readValidPendingBox(pending)
    if (!box) return { pending, changed: false }
    const current = readPendingRotation(pending)
    if (current === undefined) return { pending, changed: false }
    const target = normalizePendingRotationDegrees(rotationDegrees)
    if (Math.abs(target - current) < 1e-9) return { pending, changed: false }
    const shape = pending as PendingBitmapShape
    return {
      pending: { ...shape, box: { ...box }, style: { ...shape.style }, rotation: target },
      changed: true,
    }
  } catch {
    return { pending, changed: false }
  }
}

/**
 * Relative rotation: stage `current + deltaDegrees`. Deltas below the shared
 * rotation no-op epsilon (see `isRotationNoop`) keep the same object so
 * snapped-to-zero / center-press previews stay history-free.
 */
export function rotatePendingBitmapShapeBy(
  pending: PendingBitmapShape,
  deltaDegrees: number,
  bounds: PendingBitmapRotateBounds,
): PendingBitmapRotateResult {
  try {
    if (typeof deltaDegrees !== 'number' || !Number.isFinite(deltaDegrees)) {
      return { pending, changed: false }
    }
    if (isRotationNoop(deltaDegrees)) return { pending, changed: false }
    const current = readPendingRotation(pending)
    if (current === undefined) return { pending, changed: false }
    // Exact-affine staged shape: compose the screen turn about the
    // SELECTION center into the matrix (local box + scalar rotation + style
    // stay verbatim, gradients travel via the CTM). Legacy shapes keep the
    // scalar-angle path below.
    const stagedAffine = getPendingAffineOrIdentity(pending)
    const isIdentity =
      stagedAffine.a === 1 &&
      stagedAffine.b === 0 &&
      stagedAffine.c === 0 &&
      stagedAffine.d === 1 &&
      stagedAffine.e === 0 &&
      stagedAffine.f === 0
    if (!isIdentity) {
      if (!isValidRotateBounds(bounds)) return { pending, changed: false }
      const box = readValidPendingBox(pending)
      if (!box) return { pending, changed: false }
      const aabb = pendingAffineSelectionAABB(box, current, stagedAffine)
      if (!aabb) return { pending, changed: false }
      const center = { x: aabb.x + aabb.width / 2, y: aabb.y + aabb.height / 2 }
      const composed = rotatePendingAffineBy(stagedAffine, center, deltaDegrees)
      if (!composed) return { pending, changed: false }
      const shape = pending as PendingBitmapShape
      return { pending: { ...shape, affine: composed }, changed: true }
    }
    return rotatePendingBitmapShapeTo(pending, current + deltaDegrees, bounds)
  } catch {
    return { pending, changed: false }
  }
}

/**
 * Map a screen-space (canvas px) pointer into the pending shape's local
 * (unrotated) frame by inverse-rotating about the shape center. Corner
 * resize after rotation resolves the scale in this frame, so the uniform /
 * Alt-center / mirror rules stay exact in local axes. Returns `undefined`
 * (never throws) when the shape rotation or geometry is unusable — the
 * caller then keeps the staged shape and drops only the drag.
 */
export function unrotatePointForPendingShape(
  point: { x: number; y: number },
  shape: PendingBitmapShape,
): { x: number; y: number } | undefined {
  try {
    const box = readValidPendingBox(shape)
    if (!box) return undefined
    const rotation = readPendingRotation(shape)
    if (rotation === undefined) return undefined
    // Exact-affine staged shape: the screen map is `M * R` (skewed), so a
    // pure inverse-rotation no longer reaches the local frame. Fail closed
    // (callers use the direct screen-axis affine drag instead); never invent
    // a local point.
    const stagedAffine = getPendingAffineOrIdentity(shape)
    if (
      stagedAffine.a !== 1 ||
      stagedAffine.b !== 0 ||
      stagedAffine.c !== 0 ||
      stagedAffine.d !== 1 ||
      stagedAffine.e !== 0 ||
      stagedAffine.f !== 0
    ) {
      return undefined
    }
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    if (Math.abs(rotation) < 1e-9) {
      // Still validate through the point helper so NaN pointers fail closed.
      return rotatePointAroundCenter(point, center, 0)
    }
    return rotatePointAroundCenter(point, center, -rotation)
  } catch {
    return undefined
  }
}

export { ROTATION_SNAP_STEP_DEGREES, snapRotationDegrees }

export type { BitmapFloatingScaleHandle } from './bitmap-floating-session'

import {
  resolveBitmapFloatingScaleForHandle,
  type BitmapFloatingScaleHandle as PendingScaleHandle,
  type BitmapFloatingScaleModifiers as PendingScaleModifiers,
} from './bitmap-floating-session'

function isValidScaleBox(box: unknown): box is { x: number; y: number; width: number; height: number } {
  if (typeof box !== 'object' || box === null) return false
  const record = box as Record<string, unknown>
  const { x, y, width, height } = record
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return false
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return false
  return width > 0 && height > 0
}

function isValidScalePoint(point: unknown): point is { x: number; y: number } {
  if (typeof point !== 'object' || point === null) return false
  const record = point as Record<string, unknown>
  return typeof record.x === 'number' && typeof record.y === 'number' && Number.isFinite(record.x) && Number.isFinite(record.y)
}

function isValidScaleHandle(handle: unknown): handle is PendingScaleHandle {
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

function pendingScaleGrabbedPoint(
  box: { x: number; y: number; width: number; height: number },
  handle: PendingScaleHandle,
): { x: number; y: number } {
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  return {
    x: handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.width : centerX,
    y: handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.height : centerY,
  }
}

/**
 * Frozen drag origin for a rotated pending-shape scale.
 *
 * The selection handles sit on the tight axis-aligned bounding box, NOT on
 * the unrotated local box, so feeding the raw screen pointer into the
 * axis-aligned resolver pins the wrong anchor (initial jump + inverted edge
 * growth). Freeze the pointer-down in the local frame (`startLocal`,
 * inverse-rotated about the frozen `startCenter`) alongside the handle's
 * true local anchor (`grabbed`). Every move then maps the screen delta
 * through the frozen frame (`synth = grabbed + (currentLocal - startLocal)`)
 * so the start position resolves to exactly scale 1 (no jump) and edge /
 * corner / Alt-center / Shift-uniform / mirror rules hold in local axes.
 */
export type PendingRotatedScaleDragState = {
  startBox: { x: number; y: number; width: number; height: number }
  startCenter: { x: number; y: number }
  startLocal: { x: number; y: number }
  grabbed: { x: number; y: number }
  rotation: number
  handle: PendingScaleHandle
}

export function beginPendingRotatedScaleDrag(
  startBox: { x: number; y: number; width: number; height: number },
  startPoint: { x: number; y: number },
  rotation: number,
  handle: PendingScaleHandle,
): PendingRotatedScaleDragState | undefined {
  try {
    if (!isValidScaleBox(startBox) || !isValidScalePoint(startPoint) || !isValidScaleHandle(handle)) return undefined
    if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return undefined
    const normalized = normalizePendingRotationDegrees(rotation)
    const startCenter = { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 }
    if (!Number.isFinite(startCenter.x) || !Number.isFinite(startCenter.y)) return undefined
    const startLocal =
      Math.abs(normalized) < 1e-9
        ? { x: startPoint.x, y: startPoint.y }
        : rotatePointAroundCenter(startPoint, startCenter, -normalized)
    if (!startLocal) return undefined
    const grabbed = pendingScaleGrabbedPoint(startBox, handle)
    return { startBox: { ...startBox }, startCenter, startLocal, grabbed, rotation: normalized, handle }
  } catch {
    return undefined
  }
}

/**
 * Resolve one rotated scale move to a local box.
 *
 * 1. Map the current screen pointer into the FROZEN local frame (same
 *    `startCenter`, never the moving box center, so center drift cannot feed
 *    back into the delta).
 * 2. Synthesize the resolver pointer as `grabbed + (currentLocal - startLocal)`
 *    (delta mapping: zero delta replays the anchor exactly, so no initial
 *    jump; Shift-uniform / Alt-center / mirror stay inside the shared
 *    axis-aligned resolver).
 * 3. Keep the opposite screen anchor pinned: the resolver pins the opposite
 *    anchor in LOCAL space, but under rotation a local center shift `D`
 *    rotates the screen anchor. Re-anchor with `Cn = Cs + R * (Cn0 - Cs)`
 *    (equivalently shift the box by `(R - I) * D`, derived from
 *    `Cn + R * (P - Cn) == Cs + R * (P - Cs)`). Alt-center drags already keep
 *    the center (`D == 0` up to rounding), so no correction applies there.
 *
 * Returns `undefined` (never throws) when the drag is unusable; the caller
 * keeps the staged shape and drops only the move.
 */
export function resolvePendingRotatedScaleBox(
  state: PendingRotatedScaleDragState,
  currentPoint: { x: number; y: number },
  modifiers: PendingScaleModifiers = {},
): { x: number; y: number; width: number; height: number } | undefined {
  try {
    if (typeof state !== 'object' || state === null) return undefined
    if (!isValidScaleBox(state.startBox) || !isValidScalePoint(state.startCenter) || !isValidScalePoint(state.startLocal)) return undefined
    if (!isValidScalePoint(state.grabbed) || !isValidScaleHandle(state.handle)) return undefined
    if (!isValidScalePoint(currentPoint)) return undefined
    if (typeof state.rotation !== 'number' || !Number.isFinite(state.rotation)) return undefined
    const rotation = normalizePendingRotationDegrees(state.rotation)
    const currentLocal =
      Math.abs(rotation) < 1e-9
        ? { x: currentPoint.x, y: currentPoint.y }
        : rotatePointAroundCenter(currentPoint, state.startCenter, -rotation)
    if (!currentLocal) return undefined
    const synth = {
      x: state.grabbed.x + (currentLocal.x - state.startLocal.x),
      y: state.grabbed.y + (currentLocal.y - state.startLocal.y),
    }
    if (!Number.isFinite(synth.x) || !Number.isFinite(synth.y)) return undefined
    const resolved = resolveBitmapFloatingScaleForHandle(
      { sourceRect: { ...state.startBox } } as never,
      state.handle,
      synth.x,
      synth.y,
      { shiftKey: modifiers.shiftKey === true, altKey: modifiers.altKey === true, uniform: modifiers.uniform },
    )
    if (!resolved) return undefined
    if (!Number.isFinite(resolved.destX) || !Number.isFinite(resolved.destY)) return undefined
    if (!(resolved.width > 0 && resolved.height > 0)) return undefined
    const nextBox0 = { x: resolved.destX, y: resolved.destY, width: resolved.width, height: resolved.height }
    if (resolved.isCentered) return nextBox0
    if (Math.abs(rotation) < 1e-9) return nextBox0
    const center0 = { x: nextBox0.x + nextBox0.width / 2, y: nextBox0.y + nextBox0.height / 2 }
    const correctedCenter = rotatePointAroundCenter(center0, state.startCenter, rotation)
    if (!correctedCenter) return nextBox0
    const shiftX = correctedCenter.x - center0.x
    const shiftY = correctedCenter.y - center0.y
    if (!Number.isFinite(shiftX) || !Number.isFinite(shiftY)) return nextBox0
    if (Math.abs(shiftX) < 1e-9 && Math.abs(shiftY) < 1e-9) return nextBox0
    const corrected = { x: nextBox0.x + shiftX, y: nextBox0.y + shiftY, width: nextBox0.width, height: nextBox0.height }
    if (!Number.isFinite(corrected.x) || !Number.isFinite(corrected.y)) return nextBox0
    return corrected
  } catch {
    return undefined
  }
}
