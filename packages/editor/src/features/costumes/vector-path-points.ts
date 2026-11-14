// Independent Paper.js helper for vector reshape point add/delete.
//
// Gap: `paper-vector.ts` can move editable points and `vector-svg.ts` can move
// token-based points, but neither can add a point on a curve nor delete one
// (the reshape entry in scratch-paint-gap-analysis.md). This module fills that
// gap without touching existing files.
//
// Interop contract (shared with `paper-vector.ts` / `VectorReshapeOverlay`):
// - `element` is one editable unit from `editableVectorUnits()` — the same
//   element passed to `moveVectorEditablePoint`.
// - `x` / `y` are SVG document coordinates, the same space
//   `moveVectorEditablePoint` uses. The element is imported on its own (its own
//   transform is kept, ancestors are not), so document points are mapped into
//   the element's native frame with `ancestorWorldMatrix` first — exactly like
//   `moveVectorEditablePoint` / `moveVectorElementBy` in `paper-vector.ts`.
//   Paper.js then resolves the element's own (and children's) transforms
//   internally via `globalToLocal` / `getNearestLocation`.
// - `pointIndex` uses the flattened Paper-scheme ordering from
//   `paper-vector.ts`: paths in document order; per segment an anchor slot,
//   then an `in`-handle slot when non-zero, then an `out`-handle slot when
//   non-zero. This is NOT the SVG `d`-token ordering of `vector-svg.ts`.
// - Mutations are written back surgically: only the edited path's `d` (or a
//   shape-to-path replacement for that single node) is patched. Wrapper group
//   transforms, inherited paint, sibling shapes and styles are left literally
//   untouched, so document geometry is preserved without normalizing
//   `transform` strings. This mirrors `paper-vector.ts` mutation semantics
//   (plain-element import + ancestor-aware coordinate mapping) while avoiding
//   a whole-subtree `exportSVG` replace that would bake/normalize transforms.
//
// Safety rules:
// - Only real path geometry is edited. Text, rasters and other items without
//   path children are refused (`no-path` / `not-editable`).
// - Basic shapes (`rect`, `ellipse`, ...) import as Paper `Shape` items, which
//   have no segments. They are converted to paths first (`toPath`), which is
//   geometry-preserving, mirroring the resize helper.
// - Adding splits the nearest curve with `divideAt`, i.e. Bezier subdivision,
//   so existing curves keep their exact shape including handles.
// - Deleting removes an anchor `Segment`, then re-aims the surviving
//   neighbours across the newly joined curve: each non-zero handle keeps its
//   direction and is re-sized to the joined-curve length times
//   `RESHAPE_DELETE_HANDLE_RATIO`, so the merged curve stays smooth instead
//   of kinking. Zero handles stay zero (straight spans stay straight, and no
//   non-finite scaling can occur). A dangling handle at a new open end has no
//   curve to span, so it is cleared. Control-handle slots and degenerate
//   deletions (open paths must keep 2+ anchors, closed paths 3+) are refused.

import { ensureVectorPaperScope } from './paper-vector'
import { SVG_PLACEHOLDER, cleanSvgElementAttributes, sanitizeSvgFragmentForPaperImport } from './svg-sanitize'
import {
  ancestorWorldMatrix,
  transformVectorPoint,
  tryInvertVectorMatrix,
  worldTransformMatrix,
  type VectorMatrix,
} from './vector-svg'

export const VECTOR_PATH_POINT_ADD_TOLERANCE = 6

// Canonical handle-to-curve-length ratio used when an anchor delete joins two
// curves into one: the surviving neighbours are re-sized to the joined curve
// length times this ratio (direction preserved), matching reshape delete
// smoothing. Zero-length handles are left alone (see below).
const RESHAPE_DELETE_HANDLE_RATIO = 0.3902628565

// Handles with a magnitude at or below this are treated as absent: re-sizing
// them would divide by ~zero and produce non-finite geometry, while the curve
// they span is visually straight anyway.
const RESHAPE_DELETE_ZERO_HANDLE = 1e-9

export type VectorPathPointDeleteReason =
  | 'not-editable'
  | 'import-failed'
  | 'not-found'
  | 'control-point'
  | 'minimum-segments'

export type VectorPathPointAddReason =
  | 'not-editable'
  | 'import-failed'
  | 'no-path'
  | 'too-far'
  | 'already-anchor'
  | 'divide-failed'

export type VectorPathPointDeleteResult = {
  deleted: boolean
  reason?: VectorPathPointDeleteReason
}

export type VectorPathPointAddResult = {
  added: boolean
  /** Flattened Paper-scheme index of the new (or pre-existing) anchor. */
  pointIndex?: number
  reason?: VectorPathPointAddResultReason
}

type VectorPathPointAddResultReason = VectorPathPointAddReason

export type ResolvedPaperPoint =
  | { path: paper.Path; segment: paper.Segment; segmentIndex: number; kind: 'anchor' }
  | {
      path: paper.Path
      segment: paper.Segment
      segmentIndex: number
      kind: 'control'
      controlRole: 'in' | 'out'
    }

// Cheap synchronous pre-check for UI enablement (reshape handles, menu items).
// The authoritative check is the Paper import (`no-path`), which also covers
// groups whose children carry the geometry.
export function isPathPointEditableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  return (
    tag === 'path' ||
    tag === 'g' ||
    tag === 'rect' ||
    tag === 'ellipse' ||
    tag === 'circle' ||
    tag === 'line' ||
    tag === 'polyline' ||
    tag === 'polygon'
  )
}

// Collect editable paths in document order: plain paths plus children of
// groups and compound paths. Mirrors the traversal in `paper-vector.ts` so
// flattened indices stay compatible.
export function collectEditablePaths(item: paper.Item): paper.Path[] {
  const maybePath = item as unknown as { segments?: unknown }
  if (Array.isArray(maybePath.segments)) return [item as paper.Path]
  const children = (item as unknown as { children?: paper.Item[] }).children
  if (!children) return []
  return Array.from(children).flatMap((child) => collectEditablePaths(child))
}

// Convert imported `Shape` items (SVG rect/ellipse/...) to paths in place.
// Geometry-preserving; mirrors the resize helper's Shape handling.
export function expandShapesToPaths(item: paper.Item): paper.Item {
  if ((item as unknown as { className?: string }).className === 'Shape') {
    const toPath = (item as unknown as { toPath?: (insert: boolean) => paper.Path }).toPath
    if (typeof toPath === 'function') {
      try {
        const converted = toPath.call(item, Boolean((item as paper.Item).parent))
        if (converted && converted !== (item as unknown as paper.Item)) {
          try {
            ;(item as paper.Item).remove()
          } catch {
            // Already detached; the converted path is still valid.
          }
          return converted
        }
      } catch {
        // Keep the original shape; callers treat it as having no paths.
      }
    }
    return item
  }
  const children = (item as unknown as { children?: paper.Item[] }).children
  if (children) {
    for (const child of Array.from(children)) {
      const converted = expandShapesToPaths(child)
      if (converted !== (child as paper.Item)) {
        try {
          ;(child as paper.Item).replaceWith(converted)
        } catch {
          // Keep the original child on failure.
        }
      }
    }
  }
  return item
}

export function editableAnchorCount(item: paper.Item): number {
  let count = 0
  for (const path of collectEditablePaths(item)) count += path.segments.length
  return count
}

function isZeroHandle(point: paper.Point): boolean {
  return Math.abs(point.x) < 0.001 && Math.abs(point.y) < 0.001
}

// Map a flattened Paper-scheme index to its segment. Anchor slots resolve to
// `{ kind: 'anchor' }`; handle slots resolve to `{ kind: 'control' }`.
export function resolvePaperPoint(item: paper.Item, pointIndex: number): ResolvedPaperPoint | undefined {
  if (!Number.isInteger(pointIndex) || pointIndex < 0) return undefined
  let index = 0
  for (const path of collectEditablePaths(item)) {
    for (let segmentIndex = 0; segmentIndex < path.segments.length; segmentIndex++) {
      const segment = path.segments[segmentIndex]!
      if (index === pointIndex) return { path, segment, segmentIndex, kind: 'anchor' }
      index += 1
      if (!isZeroHandle(segment.handleIn)) {
        if (index === pointIndex) return { path, segment, segmentIndex, kind: 'control', controlRole: 'in' }
        index += 1
      }
      if (!isZeroHandle(segment.handleOut)) {
        if (index === pointIndex) return { path, segment, segmentIndex, kind: 'control', controlRole: 'out' }
        index += 1
      }
    }
  }
  return undefined
}

function flattenedAnchorIndex(item: paper.Item, target: paper.Segment): number | undefined {
  let index = 0
  for (const path of collectEditablePaths(item)) {
    for (const segment of path.segments) {
      if (segment === (target as paper.Segment)) return index
      index += 1
      if (!isZeroHandle(segment.handleIn)) index += 1
      if (!isZeroHandle(segment.handleOut)) index += 1
    }
  }
  return undefined
}

function minimumAnchorCount(path: paper.Path): number {
  return path.closed ? 3 : 2
}

export function canDeletePaperPoint(item: paper.Item, pointIndex: number): {
  ok: boolean
  reason?: Extract<VectorPathPointDeleteReason, 'not-found' | 'control-point' | 'minimum-segments'>
} {
  const resolved = resolvePaperPoint(item, pointIndex)
  if (!resolved) return { ok: false, reason: 'not-found' }
  if (resolved.kind !== 'anchor') return { ok: false, reason: 'control-point' }
  if (resolved.path.segments.length <= minimumAnchorCount(resolved.path)) {
    return { ok: false, reason: 'minimum-segments' }
  }
  return { ok: true }
}

// Re-aim the neighbours of a freshly removed anchor across the newly joined
// curve. `deletedIndex` is the pre-removal segment index. Each non-zero
// neighbour handle keeps its direction and is re-sized to
// `joinedLength * RESHAPE_DELETE_HANDLE_RATIO`, where `joinedLength` is the
// length of the curve now spanning the gap (`before.curve` after removal). A
// neighbour handle left dangling by a new open end (deleted first/last
// anchor) is cleared, since no curve spans from it anymore. Zero handles are
// never touched. Returns how many flattened slots vanished *beyond* the
// removed segment itself (`below` = cleared handle slot sits before the
// deleted anchor, `above` = after it); at most one of them can be 1.
// Fail-closed: unreadable geometry leaves handles (and the return) untouched.
function reaimDeleteNeighborHandles(
  path: paper.Path,
  deletedIndex: number,
): { below: number; above: number } {
  const untouched = { below: 0, above: 0 }
  try {
    const segments = path.segments
    const before = deletedIndex - 1 >= 0 ? segments[deletedIndex - 1] : undefined
    const after = segments[deletedIndex]
    const joinedLength = before?.curve?.length as unknown
    const usableLength =
      typeof joinedLength === 'number' && Number.isFinite(joinedLength) && joinedLength > 0 ? joinedLength : undefined
    if (before) {
      const length = Math.hypot(before.handleOut.x, before.handleOut.y)
      if (length > RESHAPE_DELETE_ZERO_HANDLE) {
        if (after && usableLength !== undefined) {
          before.handleOut = before.handleOut.multiply((usableLength * RESHAPE_DELETE_HANDLE_RATIO) / length)
        } else if (!after) {
          before.handleOut.set(0, 0)
          untouched.below = 1
        }
      }
    }
    if (after) {
      const length = Math.hypot(after.handleIn.x, after.handleIn.y)
      if (length > RESHAPE_DELETE_ZERO_HANDLE) {
        if (before && usableLength !== undefined) {
          after.handleIn = after.handleIn.multiply((usableLength * RESHAPE_DELETE_HANDLE_RATIO) / length)
        } else if (!before) {
          after.handleIn.set(0, 0)
          untouched.above = 1
        }
      }
    }
    return untouched
  } catch {
    return untouched
  }
}

// Delete the anchor at `pointIndex`. Control slots and degenerate deletions
// are refused; surviving neighbours are re-aimed across the joined curve
// (see `reaimDeleteNeighborHandles`).
export function deletePaperPoint(item: paper.Item, pointIndex: number): boolean {
  const check = canDeletePaperPoint(item, pointIndex)
  if (!check.ok) return false
  const resolved = resolvePaperPoint(item, pointIndex)
  if (!resolved || resolved.kind !== 'anchor') return false
  try {
    resolved.path.removeSegment(resolved.segmentIndex)
    reaimDeleteNeighborHandles(resolved.path, resolved.segmentIndex)
    return true
  } catch {
    return false
  }
}

type NearestCurve = { path: paper.Path; location: paper.CurveLocation; distance: number }

function nearestCurveLocation(
  scope: paper.PaperScope,
  item: paper.Item,
  x: number,
  y: number,
): NearestCurve | undefined {
  const target = new scope.Point(x, y)
  let best: NearestCurve | undefined
  for (const path of collectEditablePaths(item)) {
    let location: paper.CurveLocation | null = null
    try {
      location = path.getNearestLocation(target)
    } catch {
      continue
    }
    if (!location) continue
    const distance = location.point.getDistance(target)
    if (!Number.isFinite(distance)) continue
    if (!best || distance < best.distance) best = { path, location, distance }
  }
  return best
}

function nearestAnchorWithin(
  scope: paper.PaperScope,
  item: paper.Item,
  x: number,
  y: number,
  tolerance: number,
): { pointIndex: number; distance: number } | undefined {
  const target = new scope.Point(x, y)
  let best: { pointIndex: number; distance: number } | undefined
  let index = 0
  for (const path of collectEditablePaths(item)) {
    for (const segment of path.segments) {
      const distance = segment.point.getDistance(target)
      if (Number.isFinite(distance) && distance <= tolerance && (!best || distance < best.distance)) {
        best = { pointIndex: index, distance }
      }
      index += 1
      if (!isZeroHandle(segment.handleIn)) index += 1
      if (!isZeroHandle(segment.handleOut)) index += 1
    }
  }
  return best
}

// Insert an anchor on the nearest curve via Bezier subdivision (`divideAt`),
// preserving the exact shape of existing curves. Clicks landing on an
// existing anchor snap to it instead of stacking a duplicate.
export function addPaperPoint(
  item: paper.Item,
  scope: paper.PaperScope,
  x: number,
  y: number,
  tolerance = VECTOR_PATH_POINT_ADD_TOLERANCE,
): VectorPathPointAddResult {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(tolerance >= 0)) {
    return { added: false, reason: 'too-far' }
  }
  if (collectEditablePaths(item).length === 0) return { added: false, reason: 'no-path' }
  const snapped = nearestAnchorWithin(scope, item, x, y, tolerance)
  if (snapped) return { added: false, pointIndex: snapped.pointIndex, reason: 'already-anchor' }
  const best = nearestCurveLocation(scope, item, x, y)
  if (!best || best.distance > tolerance) return { added: false, reason: 'too-far' }
  let created: paper.Segment | null = null
  try {
    created = best.path.divideAt(best.location)
  } catch {
    created = null
  }
  if (!created) {
    // `divideAt` declines at existing segment boundaries; report the anchor.
    const fallback = nearestAnchorWithin(scope, item, x, y, Math.max(tolerance, 1))
    return { added: false, pointIndex: fallback?.pointIndex, reason: 'already-anchor' }
  }
  return { added: true, pointIndex: flattenedAnchorIndex(item, created) }
}

function importPaperItem(scope: paper.PaperScope, element: Element): paper.Item | undefined {
  try {
    // Trust boundary: the serialized live Element is untrusted SVG markup and
    // must never reach Paper.js `importSVG` raw. Route it through the
    // fragment-safe wrapper (fresh `<svg>` root + full DOMPurify/strict
    // post-pass, including `data-paper-data` removal) so breakout
    // tags/handlers are stripped while the element's own transform and
    // children survive for faithful geometry imports. Placeholder means the
    // fragment was unsalvageable — refuse instead of importing attacker markup.
    const raw = new XMLSerializer().serializeToString(element)
    const svg = sanitizeSvgFragmentForPaperImport(raw)
    if (!svg || svg === SVG_PLACEHOLDER) return undefined
    return (
      scope.project as unknown as {
        importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item
      }
    ).importSVG(svg, { insert: false })
  } catch {
    return undefined
  }
}

function replaceElementWithPaperItem(element: Element, item: paper.Item): void {
  const exported = item.exportSVG({ asString: false }) as Element
  const nextElement = element.ownerDocument.importNode(exported, true) as Element
  // Defense in depth: Paper exports fresh geometry nodes, but run the same
  // post-pass before the node goes live so no import-time attribute survives.
  cleanSvgElementAttributes(nextElement)
  element.replaceWith(nextElement)
}

// Map a document-space point into the element's native frame (the frame of a
// bare Paper.js import, which keeps the element's own transform but not its
// ancestors'). Mirrors `toNativePoint` in `paper-vector.ts`.
// Returns `null` for singular / non-finite ancestors (fail-closed).
function toNativeDocumentPoint(element: Element, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const ancestors = ancestorWorldMatrix(element)
  if (!ancestors) return { x, y }
  const inverse = tryInvertVectorMatrix(ancestors)
  if (!inverse) return null
  const mapped = transformVectorPoint(inverse, x, y)
  if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) return null
  return mapped
}

// Hit tolerance is expressed in document units by callers. Inside the native
// frame distances shrink/grow with ancestor scaling, so scale the tolerance
// the same way coordinate mapping does (uniform-scale approximation).
// Returns `null` for singular / non-finite ancestors (fail-closed).
function toNativeTolerance(element: Element, tolerance: number): number | null {
  const ancestors = ancestorWorldMatrix(element)
  if (!ancestors) return tolerance
  if (!tryInvertVectorMatrix(ancestors)) return null
  const scale = ancestorScale(ancestors)
  if (!Number.isFinite(scale) || scale <= 1e-9) return tolerance
  return tolerance / scale
}

function ancestorScale(matrix: VectorMatrix): number {
  const sx = Math.hypot(matrix[0], matrix[1])
  const sy = Math.hypot(matrix[2], matrix[3])
  return (sx + sy) / 2
}

// DOM counterparts of `collectEditablePaths`, in the same document order:
// leaf shapes (path + basic shapes) depth-first, skipping wrapper groups and
// non-geometry nodes (text/raster/defs). Paper's group traversal visits paths
// in this same order, so index `i` of `collectEditablePaths` corresponds to
// index `i` here. Only the edited leaf is patched, leaving wrapper transforms,
// inherited paint, siblings and styles literally untouched.
function domEditableLeafTargets(element: Element): Element[] {
  const tag = element.tagName.toLowerCase()
  if (tag !== 'g') return [element]
  const out: Element[] = []
  const walk = (node: Element) => {
    const childTag = node.tagName.toLowerCase()
    if (childTag === 'g') {
      for (const child of Array.from(node.children)) walk(child as Element)
      return
    }
    if (
      childTag === 'path' ||
      childTag === 'rect' ||
      childTag === 'ellipse' ||
      childTag === 'circle' ||
      childTag === 'line' ||
      childTag === 'polyline' ||
      childTag === 'polygon'
    ) {
      out.push(node)
    }
  }
  for (const child of Array.from(element.children)) walk(child as Element)
  return out
}

const SHAPE_GEOMETRY_ATTRIBUTES = new Set([
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'd',
])

// Patch a single DOM leaf with its edited Paper path geometry. Paper's
// `importSVG` bakes the element's own transform (and nested/leaf transforms)
// into segment coordinates, leaving item matrices identity — the same reason a
// whole-subtree `exportSVG` drops the wrapper `transform`. The DOM leaf keeps
// its `transform` chain literally, so the baked geometry must be mapped back
// with the inverse of the in-unit matrix (element own + intermediates + leaf
// own) before serializing to `d`. `path` nodes only get a new `d`; basic
// shapes are replaced once by an equivalent `path` carrying the new `d` plus
// the original presentation/wrapper attributes (id, transform, paint, style,
// ...). Returns false when the patch is not applicable (caller falls back to
// a full replace).
function patchDomLeafWithPaperPath(
  scope: paper.PaperScope,
  element: Element,
  dom: Element,
  path: paper.Path,
): boolean {
  try {
    const data = leafLocalPathData(scope, element, dom, path)
    if (!data) return false
    if (dom.tagName.toLowerCase() === 'path') {
      dom.setAttribute('d', data)
      // The leaf keeps its identity (id/transform/paint), so attacker
      // attributes that rode in on the live Element would survive a pure `d`
      // patch. Clean them with the same post-pass the import used.
      cleanSvgElementAttributes(dom)
      return true
    }
    const doc = dom.ownerDocument
    const namespace = dom.namespaceURI ?? 'http://www.w3.org/2000/svg'
    const next = doc.createElementNS(namespace, 'path')
    for (const name of dom.getAttributeNames()) {
      if (SHAPE_GEOMETRY_ATTRIBUTES.has(name)) continue
      const value = dom.getAttribute(name)
      if (value !== null) next.setAttribute(name, value)
    }
    next.setAttribute('d', data)
    cleanSvgElementAttributes(next)
    dom.replaceWith(next)
    return true
  } catch {
    return false
  }
}

// Serialize a Paper path (baked unit-frame geometry) back into its DOM leaf's
// local frame. Without in-unit transforms this is just `pathData`; otherwise
// the inverse matrix is applied to a detached clone so the live item — and
// the flattened index bookkeeping around it — stays untouched.
// Singular / non-finite in-unit matrices return undefined so the caller
// refuses (no whole-subtree fallback, which would bake collapsed geometry).
function leafLocalPathData(
  scope: paper.PaperScope,
  element: Element,
  dom: Element,
  path: paper.Path,
): string | undefined {
  const direct = (path as unknown as { pathData?: unknown }).pathData
  if (typeof direct !== 'string' || !direct) return undefined
  const parent = element.parentElement as Element | null
  const matrix = worldTransformMatrix(dom, parent)
  if (!matrix) return direct
  let clone: paper.Path | undefined
  try {
    const inverse = tryInvertVectorMatrix(matrix)
    if (!inverse) return undefined
    const paperMatrix = new scope.Matrix(inverse[0], inverse[1], inverse[2], inverse[3], inverse[4], inverse[5])
    clone = (path as unknown as { clone?: (options?: { insert?: boolean }) => paper.Path }).clone?.({ insert: false }) as paper.Path | undefined
    if (!clone) return undefined
    clone.transform(paperMatrix)
    const data = (clone as unknown as { pathData?: unknown }).pathData
    return typeof data === 'string' && data ? data : undefined
  } catch {
    return undefined
  } finally {
    try {
      clone?.remove()
    } catch {
      // Detached clone; nothing to clean up.
    }
  }
}

// Write back exactly one edited Paper path into its DOM leaf. Fail-closed:
// ordering divergence or a singular in-unit patch returns false with the DOM
// untouched — never falls back to a whole-subtree replace (which would bake
// collapsed geometry and drop wrapper transforms).
function writeBackSinglePath(
  scope: paper.PaperScope,
  element: Element,
  root: paper.Item,
  editedPath: paper.Path,
): boolean {
  const paperPaths = collectEditablePaths(root)
  const order = paperPaths.indexOf(editedPath)
  const targets = domEditableLeafTargets(element)
  if (order < 0 || paperPaths.length !== targets.length) {
    return false
  }
  const target = targets[order]
  if (!target || !patchDomLeafWithPaperPath(scope, element, target, editedPath)) {
    return false
  }
  return true
}

// Add a point on the nearest curve of one editable unit, saving back to SVG.
// Returns the flattened Paper-scheme anchor index for selection sync.
// Fail-closed: singular / non-finite ancestor or in-unit matrices refuse
// with no DOM write (no history entry).
export async function addVectorPathPoint(
  element: Element,
  x: number,
  y: number,
  options?: { tolerance?: number },
): Promise<VectorPathPointAddResult> {
  if (!isPathPointEditableElement(element)) return { added: false, reason: 'not-editable' }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { added: false, reason: 'too-far' }
  const ancestors = ancestorWorldMatrix(element)
  if (ancestors && !tryInvertVectorMatrix(ancestors)) return { added: false, reason: 'not-editable' }
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) return { added: false, reason: 'import-failed' }
  let root: paper.Item = imported
  try {
    root = expandShapesToPaths(imported)
    const native = toNativeDocumentPoint(element, x, y)
    if (!native) return { added: false, reason: 'not-editable' }
    const nativeTolerance = toNativeTolerance(element, options?.tolerance ?? VECTOR_PATH_POINT_ADD_TOLERANCE)
    if (nativeTolerance === null) return { added: false, reason: 'not-editable' }
    const result = addPaperPoint(root, scope, native.x, native.y, nativeTolerance)
    if (!result.added) return result
    const resolved = result.pointIndex !== undefined ? resolvePaperPoint(root, result.pointIndex) : undefined
    const editedPath = resolved && resolved.kind === 'anchor' ? resolved.path : undefined
    if (!editedPath) {
      return { added: false, reason: 'divide-failed' }
    }
    if (!writeBackSinglePath(scope, element, root, editedPath)) {
      return { added: false, reason: 'not-editable' }
    }
    return result
  } finally {
    try {
      root.remove()
    } catch {
      // Already detached via export; nothing to clean up.
    }
  }
}

export type VectorReshapeMoveTarget = { index: number; x: number; y: number }

export type VectorReshapeMoveResult = {
  moved: boolean
  /** Flattened anchor indices that were moved (pre-mutation numbering; moves never shift slots). */
  movedIndices: number[]
  skipped: Array<{ index: number; reason: 'not-found' | 'control-point' }>
  reason?: 'not-editable' | 'import-failed' | 'no-op'
}

// Bulk anchor translation in one import/serialize pass. Every target resolves
// against the same pre-mutation flattened numbering (moves never add/remove
// slots, so ascending order is safe), each anchor travels with its own handles
// carried rigidly by Paper (`segment.point` assignment preserves handle
// vectors), and only edited paths are written back. Shapes are converted to
// paths first (geometry-preserving, like add/delete) so corners move
// independently instead of sharing rect/ellipse attributes. Control slots are
// refused: bulk translation is anchor-only, leaving foreign handles untouched.
export async function moveVectorReshapePoints(
  element: Element,
  targets: readonly VectorReshapeMoveTarget[],
): Promise<VectorReshapeMoveResult> {
  const wanted = new Map<number, { x: number; y: number }>()
  for (const target of targets) {
    if (!target || !Number.isInteger(target.index) || target.index < 0) continue
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue
    wanted.set(target.index, { x: target.x, y: target.y })
  }
  if (!isPathPointEditableElement(element)) {
    return { moved: false, movedIndices: [], skipped: [], reason: 'not-editable' }
  }
  if (wanted.size === 0) return { moved: false, movedIndices: [], skipped: [], reason: 'no-op' }
  const moveAncestors = ancestorWorldMatrix(element)
  if (moveAncestors && !tryInvertVectorMatrix(moveAncestors)) {
    return { moved: false, movedIndices: [], skipped: [], reason: 'not-editable' }
  }
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) {
    return {
      moved: false,
      movedIndices: [],
      skipped: [...wanted.keys()].map((index) => ({ index, reason: 'not-found' as const })),
      reason: 'import-failed',
    }
  }
  let root: paper.Item = imported
  try {
    root = expandShapesToPaths(imported)
    const movedIndices: number[] = []
    const skipped: Array<{ index: number; reason: 'not-found' | 'control-point' }> = []
    const edited = new Set<paper.Path>()
    const ordered = [...wanted.entries()].sort((a, b) => a[0] - b[0])
    for (const [pointIndex, point] of ordered) {
      const resolved = resolvePaperPoint(root, pointIndex)
      if (!resolved) {
        skipped.push({ index: pointIndex, reason: 'not-found' })
        continue
      }
      if (resolved.kind !== 'anchor') {
        skipped.push({ index: pointIndex, reason: 'control-point' })
        continue
      }
      const native = toNativeDocumentPoint(element, point.x, point.y)
      if (!native) {
        return { moved: false, movedIndices: [], skipped: [], reason: 'not-editable' }
      }
      const local = resolved.path.globalToLocal(new scope.Point(native.x, native.y))
      resolved.segment.point = local as paper.Point
      edited.add(resolved.path)
      movedIndices.push(pointIndex)
    }
    if (movedIndices.length === 0) {
      return { moved: false, movedIndices: [], skipped, reason: 'no-op' }
    }
    if (!writeBackMultiplePaths(scope, element, root, edited)) {
      return { moved: false, movedIndices: [], skipped, reason: 'not-editable' }
    }
    return { moved: true, movedIndices: movedIndices.sort((a, b) => a - b), skipped }
  } finally {
    try {
      root.remove()
    } catch {
      // Already detached via export; nothing to clean up.
    }
  }
}

export type VectorPathPointBulkDeleteReason = VectorPathPointDeleteReason | 'no-selection'

export type VectorPathPointRemovedRange = { index: number; slots: number }

export type VectorPathPointBulkDeleteResult = {
  deleted: boolean
  /** Originally requested flattened indices that were removed, ascending. */
  deletedIndices: number[]
  /**
   * Legacy per-deletion slot accounting in descending application order (for
   * selection remap). Kept for backwards compatibility: each entry reports a
   * single contiguous range starting at the deleted anchor (or one slot
   * below for a cleared trailing handle). For a deleted first anchor whose
   * cleared neighbour handle sits *above* the deletion (vanished slots
   * `{anchor, out, nextIn}` with the survivor anchor in between), this legacy
   * range over-covers the survivor slot — do NOT use it for remap when
   * `removedRanges` / `removedSlots` are present.
   */
  removed: Array<{ index: number; slots: number }>
  /**
   * Precise disjoint contiguous ranges that actually vanished, flattened in
   * descending application order (higher ranges first, both across deletions
   * and within one deletion). Replay each entry with
   * `remapReshapeSelectionAfterSlotDelete` in order for an exact remap.
   * Present whenever `deleted` is true.
   */
  removedRanges?: VectorPathPointRemovedRange[]
  /**
   * Precise per-deletion vanished flat-slot sets, in descending application
   * order (parallel to the deletion order that produced `removed`). Each inner
   * array is sorted ascending and lists every flattened slot that disappeared
   * with that one anchor: its own anchor + non-zero handle slots plus the one
   * cleared neighbour handle slot, if any (`pointIndex - 1` for a cleared
   * handle below, `pointIndex + ownSlots + 1` for a cleared handle above).
   * Present whenever `deleted` is true.
   */
  removedSlots?: Array<readonly number[]>
  skipped: Array<{ index: number; reason: VectorPathPointDeleteReason }>
  reason?: VectorPathPointBulkDeleteReason
}

// Write back every edited Paper path into its DOM leaf. Fail-closed: any
// ordering divergence or singular patch returns false with the DOM untouched
// (no whole-subtree fallback).
function writeBackMultiplePaths(
  scope: paper.PaperScope,
  element: Element,
  root: paper.Item,
  editedPaths: Set<paper.Path>,
): boolean {
  const paperPaths = collectEditablePaths(root)
  const targets = domEditableLeafTargets(element)
  if (paperPaths.length !== targets.length) {
    return false
  }
  for (const editedPath of editedPaths) {
    const order = paperPaths.indexOf(editedPath)
    const target = order >= 0 ? targets[order] : undefined
    if (!target || !patchDomLeafWithPaperPath(scope, element, target, editedPath)) {
      return false
    }
  }
  return true
}

// Delete several anchors in one import/serialize pass. Descending order keeps
// every pending flattened index valid (removing higher slots never shifts a
// lower anchor), so transformed/compound documents resolve exactly like the
// single-point path. Minimum-segment and control guards are re-checked per
// anchor at deletion time, neighbours are re-aimed per deletion, and the
// per-deletion slot bookkeeping includes any cleared end handle. Only edited
// leaves are patched.
export async function deleteVectorPathPoints(
  element: Element,
  pointIndices: readonly number[],
): Promise<VectorPathPointBulkDeleteResult> {
  const requested = Array.from(new Set(pointIndices.filter((index) => Number.isInteger(index) && (index as number) >= 0))).sort(
    (a, b) => (b as number) - (a as number),
  ) as number[]
  if (!isPathPointEditableElement(element)) {
    return { deleted: false, deletedIndices: [], removed: [], skipped: [], reason: 'not-editable' }
  }
  if (requested.length === 0) return { deleted: false, deletedIndices: [], removed: [], skipped: [], reason: 'no-selection' }
  const deleteAncestors = ancestorWorldMatrix(element)
  if (deleteAncestors && !tryInvertVectorMatrix(deleteAncestors)) {
    return {
      deleted: false,
      deletedIndices: [],
      removed: [],
      skipped: requested.map((index) => ({ index, reason: 'not-editable' as const })),
      reason: 'not-editable',
    }
  }
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) {
    return {
      deleted: false,
      deletedIndices: [],
      removed: [],
      skipped: requested.map((index) => ({ index, reason: 'import-failed' as const })),
      reason: 'import-failed',
    }
  }
  let root: paper.Item = imported
  try {
    root = expandShapesToPaths(imported)
    const deletedIndices: number[] = []
    const removed: Array<{ index: number; slots: number }> = []
    const removedSlots: Array<readonly number[]> = []
    const removedRanges: VectorPathPointRemovedRange[] = []
    const skipped: Array<{ index: number; reason: VectorPathPointDeleteReason }> = []
    const edited = new Set<paper.Path>()
    for (const pointIndex of requested) {
      const resolved = resolvePaperPoint(root, pointIndex)
      if (!resolved) {
        skipped.push({ index: pointIndex, reason: 'not-found' })
        continue
      }
      if (resolved.kind !== 'anchor') {
        skipped.push({ index: pointIndex, reason: 'control-point' })
        continue
      }
      if (resolved.path.segments.length <= minimumAnchorCount(resolved.path)) {
        skipped.push({ index: pointIndex, reason: 'minimum-segments' })
        continue
      }
      // Own slots that vanish with this anchor (anchor + its non-zero handle
      // slots): contiguous starting at `pointIndex`.
      // A dangling neighbour handle cleared by the re-aim (new open end) is
      // one more vanished slot: `pointIndex - 1` when the cleared handle sits
      // below the anchor (deleted last anchor, contiguous with the own range),
      // or `pointIndex + ownSlots + 1` when it sits above it (deleted first
      // anchor: the surviving anchor slot sits between, so the vanished set is
      // disjoint and the legacy contiguous range over-covers it).
      const ownSlots = 1 + (isZeroHandle(resolved.segment.handleIn) ? 0 : 1) + (isZeroHandle(resolved.segment.handleOut) ? 0 : 1)
      const segmentIndex = resolved.segmentIndex
      const editedPath = resolved.path
      try {
        editedPath.removeSegment(segmentIndex)
      } catch {
        skipped.push({ index: pointIndex, reason: 'not-found' })
        continue
      }
      const cleared = reaimDeleteNeighborHandles(editedPath, segmentIndex)
      const extra = cleared.below + cleared.above
      deletedIndices.push(pointIndex)
      removed.push({
        index: cleared.below > 0 ? pointIndex - 1 : pointIndex,
        slots: ownSlots + extra,
      })
      // Precise vanished-slot set in this deletion's pre-numbering.
      const vanished: number[] = []
      for (let i = 0; i < ownSlots; i++) vanished.push(pointIndex + i)
      if (cleared.below > 0) vanished.push(pointIndex - 1)
      if (cleared.above > 0) vanished.push(pointIndex + ownSlots + 1)
      vanished.sort((a, b) => a - b)
      removedSlots.push(Object.freeze(vanished.slice()))
      // Disjoint contiguous ranges, highest first so sequential
      // `remapReshapeSelectionAfterSlotDelete` replay is exact.
      const runs: VectorPathPointRemovedRange[] = []
      for (const slot of vanished) {
        const last = runs[runs.length - 1]
        if (last && slot === last.index + last.slots) last.slots += 1
        else runs.push({ index: slot, slots: 1 })
      }
      for (let i = runs.length - 1; i >= 0; i--) removedRanges.push(runs[i]!)
      edited.add(editedPath)
    }
    if (deletedIndices.length === 0) {
      const first = skipped[0]
      return { deleted: false, deletedIndices: [], removed: [], skipped, reason: first?.reason ?? 'not-found' }
    }
    if (!writeBackMultiplePaths(scope, element, root, edited)) {
      return {
        deleted: false,
        deletedIndices: [],
        removed: [],
        skipped: requested.map((index) => ({ index, reason: 'not-editable' as const })),
        reason: 'not-editable',
      }
    }
    return {
      deleted: true,
      deletedIndices: deletedIndices.sort((a, b) => a - b),
      removed,
      removedRanges: removedRanges.map((range) => ({ ...range })),
      removedSlots: removedSlots.map((slots) => Object.freeze(slots.slice()) as readonly number[]),
      skipped,
    }
  } finally {
    try {
      root.remove()
    } catch {
      // Already detached via export; nothing to clean up.
    }
  }
}

// Delete the anchor at a flattened Paper-scheme index, saving back to SVG.
// Fail-closed: singular ancestors or in-unit matrices refuse with no DOM write.
export async function deleteVectorPathPoint(
  element: Element,
  pointIndex: number,
): Promise<VectorPathPointDeleteResult> {
  if (!isPathPointEditableElement(element)) return { deleted: false, reason: 'not-editable' }
  const singleAncestors = ancestorWorldMatrix(element)
  if (singleAncestors && !tryInvertVectorMatrix(singleAncestors)) return { deleted: false, reason: 'not-editable' }
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) return { deleted: false, reason: 'import-failed' }
  let root: paper.Item = imported
  try {
    root = expandShapesToPaths(imported)
    const check = canDeletePaperPoint(root, pointIndex)
    if (!check.ok) return { deleted: false, reason: check.reason ?? 'not-found' }
    const resolved = resolvePaperPoint(root, pointIndex)
    const editedPath = resolved && resolved.kind === 'anchor' ? resolved.path : undefined
    const order = editedPath ? collectEditablePaths(root).indexOf(editedPath) : -1
    const deleted = deletePaperPoint(root, pointIndex)
    if (!deleted) return { deleted: false, reason: 'not-found' }
    if (!editedPath || order < 0) {
      return { deleted: false, reason: 'not-editable' }
    }
    if (!writeBackSinglePath(scope, element, root, editedPath)) {
      return { deleted: false, reason: 'not-editable' }
    }
    return { deleted: true }
  } finally {
    try {
      root.remove()
    } catch {
      // Already detached via export; nothing to clean up.
    }
  }
}
