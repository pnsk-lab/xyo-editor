// Pending affine scale UI glue (AGENTS split: Editor.svelte stays thin).
//
// Owns the Editor's handle-drag integration for the exact affine model
// (`bitmap-pending-affine.ts`): frozen source affine / rotation preserving
// cross-transform. The handles sit on the screen AABB, so every drag freezes
// the START screen box (`startAabb`), its center, the opposite-handle pivot
// `P` (or the center for Alt), and the pointer-down handle position `H0`.
// Every move measures the DIRECT screen-axis ratios `sx/sy` and left-composes
// `T(P) * S * T(-P)` onto the frozen START affine `M0` — never a local box
// rewrite, so `S * R` skew is exact.
//
// Rules (mirroring the pure model, no AGPL copy):
// - corner default is uniform (`mag = max(|sx|, |sy|)` with each axis' own
//   reference sign); Shift frees the corner to both screen axes; edges stay
//   single-axis; Alt pins the START center (both sides grow); mirror
//   (negative scale) is preserved; magnitudes snap to the shared minimum
//   with sign kept; degenerate spans / singular determinants / over-budget
//   AABBs fail closed to `undefined` (caller drops only the move).
// - zero delta replays `M0` exactly (pivot anchored); the caller skips the
//   session call when the resolved matrix equals the staged matrix, so no
//   repaint / renderRev / VM / history can occur late.
// - repeated drags never drift: the state is frozen at pointer-down and never
//   updated by moves; the session applies each matrix absolutely via
//   `stageAffine` (frozen base + single-pass repaint, no history, no VM).
import {
  beginPendingAffineScaleDrag,
  isValidAffineMatrix,
  PENDING_AFFINE_IDENTITY,
  pendingAffineSelectionAABB,
  resolvePendingAffineScale,
  type PendingAffine2x3,
  type PendingAffineScaleDragState,
  type PendingAffineScaleHandle,
  type PendingAffineScaleModifiers,
} from './bitmap-pending-affine'
import { getPendingAffineOrIdentity, type PendingBitmapShape } from './bitmap-pending-shape'

export type { PendingAffineScaleDragState, PendingAffineScaleHandle }

export type PendingScaleUiBegin =
  | {
      kind: 'affine'
      state: PendingAffineScaleDragState
      startAffine: PendingAffine2x3 | undefined
      startBox: { x: number; y: number; width: number; height: number }
      startRotation: number
    }
  | { kind: 'legacy' }

function readRotation(shape: PendingBitmapShape): number {
  const raw = (shape as { rotation?: unknown }).rotation
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function isIdentityAffine(affine: PendingAffine2x3): boolean {
  return (
    affine.a === 1 &&
    affine.b === 0 &&
    affine.c === 0 &&
    affine.d === 1 &&
    affine.e === 0 &&
    affine.f === 0
  )
}

/** True when the staged shape needs the exact affine path (rotated/skewed). */
export function shouldUseAffineScale(shape: PendingBitmapShape): boolean {
  try {
    const rotation = readRotation(shape)
    if (Math.abs(rotation) >= 1e-9) return true
    const affine = getPendingAffineOrIdentity(shape)
    return !isIdentityAffine(affine)
  } catch {
    return false
  }
}

/**
 * Begin a scale drag from the frozen staged shape. Returns the affine state
 * when the pure model accepts the drag (rotated or skewed shapes), otherwise
 * `{ kind: 'legacy' }` so the caller keeps the axis-aligned retarget path
 * byte-for-byte. Never throws.
 */
export function beginPendingScaleUi(
  shape: PendingBitmapShape,
  handle: PendingAffineScaleHandle,
  startPoint: { x: number; y: number },
  modifiers: PendingAffineScaleModifiers = {},
): PendingScaleUiBegin {
  try {
    if (!shouldUseAffineScale(shape)) return { kind: 'legacy' }
    const box = shape.box
    if (!box || typeof box.x !== 'number') return { kind: 'legacy' }
    const rotation = readRotation(shape)
    const rawAffine = (shape as { affine?: unknown }).affine
    const startAffine =
      rawAffine === undefined
        ? { ...PENDING_AFFINE_IDENTITY }
        : isValidAffineMatrix(rawAffine)
          ? { ...(rawAffine as PendingAffine2x3) }
          : { ...PENDING_AFFINE_IDENTITY }
    const state = beginPendingAffineScaleDrag(
      { x: box.x, y: box.y, width: box.width, height: box.height },
      rotation,
      startAffine,
      handle,
      { x: startPoint.x, y: startPoint.y },
      { altKey: modifiers.altKey === true },
    )
    if (!state) return { kind: 'legacy' }
    const originalAffine =
      rawAffine === undefined ? undefined : isValidAffineMatrix(rawAffine) ? { ...(rawAffine as PendingAffine2x3) } : undefined
    return {
      kind: 'affine',
      state,
      startAffine: originalAffine,
      startBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      startRotation: rotation,
    }
  } catch {
    return { kind: 'legacy' }
  }
}

/**
 * Resolve one affine scale move to a new screen matrix. Returns `undefined`
 * (never throws) when the drag is unusable — the caller keeps the staged
 * shape and drops only the move. The caller must compare the result against
 * the staged affine and skip `stageAffine` on equality (zero-delta exact,
 * no late writes).
 */
export function resolvePendingScaleUi(
  state: PendingAffineScaleDragState,
  currentPoint: { x: number; y: number },
  modifiers: { shiftKey?: boolean; altKey?: boolean },
  bounds?: { width: number; height: number },
): PendingAffine2x3 | undefined {
  try {
    return resolvePendingAffineScale(
      state,
      { x: currentPoint.x, y: currentPoint.y },
      { shiftKey: modifiers.shiftKey === true, altKey: modifiers.altKey === true },
      bounds,
    )
  } catch {
    return undefined
  }
}

/** Exact affine equality (zero-delta / no-op detection, no epsilon drift). */
export function isSameAffine(a: PendingAffine2x3 | undefined, b: PendingAffine2x3 | undefined): boolean {
  const norm = (m: PendingAffine2x3 | undefined): PendingAffine2x3 | undefined => {
    if (m === undefined) return undefined
    // Legacy `undefined` reads as identity: treat an explicit identity matrix
    // as equal so zero-delta replays skip the session call entirely.
    if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0) return undefined
    return m
  }
  const na = norm(a)
  const nb = norm(b)
  if (na === undefined && nb === undefined) return true
  if (na === undefined || nb === undefined) return false
  return na.a === nb.a && na.b === nb.b && na.c === nb.c && na.d === nb.d && na.e === nb.e && na.f === nb.f
}

/** Read the staged affine for exact comparison (`undefined` = legacy identity). */
export function readStagedAffine(shape: PendingBitmapShape | undefined): PendingAffine2x3 | undefined {
  if (!shape) return undefined
  const raw = (shape as { affine?: unknown }).affine
  if (raw === undefined) return undefined
  if (!isValidAffineMatrix(raw)) return undefined
  return { ...(raw as PendingAffine2x3) }
}

/** Selection AABB for the staged shape (handles sit on this box). */
export function pendingScaleUiSelectionAabb(shape: PendingBitmapShape):
  | { x: number; y: number; width: number; height: number }
  | undefined {
  try {
    const rotation = readRotation(shape)
    const affine = getPendingAffineOrIdentity(shape)
    return pendingAffineSelectionAABB({ ...shape.box }, rotation, affine)
  } catch {
    return undefined
  }
}
