// Scratch-parity helper for reshape inside `<g>` vector units.
//
// Position: the current group reshape path exposes one flattened Paper-scheme
// index list for the whole `<g>` unit (`paper-vector.ts` /
// `vector-path-points.ts` / `VectorReshapeOverlay.svelte`). That list can move
// individual anchors, but it cannot name *which child shape* an anchor belongs
// to, so "move this whole child shape independently" has no address, and the
// editor has no vocabulary for the Scratch behaviour this file models:
//
//   - reshape works on one leaf (child shape) inside the group;
//   - returning to the select tool normalizes the leaf selection back to the
//     compound/group root (one selectable unit), preserving document order.
//
// This module is intentionally pure and dependency-free:
//
//   - No Paper.js import (no `paper` / `paper-vector.ts` import, so no import
//     cycle with the Paper wrappers and no canvas needed for unit tests).
//   - No DOM mutation: every function only reads attributes/children and
//     returns new arrays/objects. Selection helpers never touch render state,
//     and render helpers never touch selection state (selection/render
//     separation is structural, not a convention comment).
//   - No history, no sanitizer, no editor state. Coordinates are document
//     (world) coordinates unless the name says `Local`.
//
// What this module owns (and the existing files deliberately keep owning):
//
//   - Ancestor path / leaf identity: `collectGroupLeafDescriptors` walks a
//     `<g>` unit depth-first in document order (the same order the existing
//     surgical write-backs use: `domEditableLeafTargets` in
//     `vector-path-points.ts`, `groupDomLeafTargets` in `paper-vector.ts`).
//     Each leaf gets a positional `ancestorPath` (child-index chain from the
//     unit root), a stable string `leafKey`, paint-order `zOrder` (document
//     order; later = on top), and the leaf's own + ancestor CTM. Identity is
//     positional, so it is exact for one loaded document and must be
//     re-resolved after any structural edit (see `matchLeavesAcrossReindex`).
//   - CTM: minimal SVG `transform` parsing (`translate` / `scale` / `rotate` /
//     `skewX` / `skewY` / `matrix`, written from the SVG transform grammar,
//     not copied from any editor or reference implementation) plus `multiply/invert/apply` and the
//     `documentPointToLeafLocal` / `leafLocalPointToDocument` converters. The
//     existing wrappers map document points with `ancestorWorldMatrix`; this
//     module gives the pure equivalent for a single leaf so a future
//     whole-leaf move can stay in document coordinates at the call site.
//   - Compound-root normalization: `normalizeLeafSelectionToRoot` collapses
//     any leaf set back to its unit root for the select tool, while reshape
//     keeps operating on `leafIndex` values. No DOM is touched.
//   - Overlap Z-order: document order is the paint order. `comparePaintOrder`
//     / `topmostLeafForPoint` (bounding-box pre-filter; exact hit testing
//     stays with Paper.js `hitTest`) / `partitionSelectionAndRender` keep the
//     topmost-wins rule explicit and keep selection arrays disjoint from
//     render arrays.
//   - Flat-index bridge: the existing Paper lists are flat across the whole
//     group. Given per-leaf anchor counts (which only the Paper side knows,
//     because handle slots depend on non-zero handles), `flatRangesForLeaves`,
//     `leafIndexForFlatIndex`, and `flatIndicesForLeaves` translate between
//     "anchor 7 of the unit" and "anchor 1 of leaf 2", which is the missing
//     address for whole-child-shape moves (`expandLeafSelectionToFlatIndices`).
//
// Contracts the (future) integrator must keep (this module cannot enforce):
//
//   - Call `collectGroupLeafDescriptors` on the live unit Element (the same
//     `editableVectorUnits(svg)[index]` element the Paper helpers receive).
//     Do not call it on a detached clone with different ancestors: the CTM
//     includes the ancestor chain up to (excluding) the `<svg>` root.
//   - Whole-leaf moves must go through one import/serialize pass with exactly
//     one history entry (the `peekCostumeHistory` / `commitAssetHistory`
//     pattern used by add/delete/move). Do not capture history per leaf.
//   - After add/delete/style/undo/redo/import, flattened indices and
//     `ancestorPath` positions may shift. Re-collect descriptors and
//     revalidate with `isLiveLeafSelection` / `matchLeavesAcrossReindex`
//     instead of trusting a stored array (same rule as
//     `normalizeReshapeSelection` / `isReshapeAnchorLive`).
//   - Sanitizers strip unknown `data-*` on save/reload (persistence
//     boundary), so never use a `data-*` attribute as the long-term leaf
//     identity. `leafKey` here is positional for one document revision; cross-
//     revision matching uses tag+paint+geometry signatures
//     (`matchLeavesAcrossReindex`), which is best-effort by design.
//
// Safety: no parsing of untrusted markup (callers pass Elements), no
// serialization, no mutation of inputs, non-finite coordinates are ignored.
// AGPL note: behaviour described from observed Scratch-parity notes only; no
// reference source was copied into this file.

export type VectorGroupMatrix = [number, number, number, number, number, number]

export type VectorGroupLeafTag =
  | 'path'
  | 'rect'
  | 'ellipse'
  | 'circle'
  | 'line'
  | 'polyline'
  | 'polygon'

export type VectorGroupLeafDescriptor = {
  /** Zero-based position in document/paint order among leaves of this unit. Later = painted on top. */
  leafIndex: number
  /** Child-index chain from the unit root to the leaf's parent (e.g. `[1, 0]`). Empty for direct children. */
  ancestorPath: number[]
  /** Stable string form of the chain plus leaf position (e.g. `"g/1/0:2"`). Positional within one revision. */
  leafKey: string
  tag: VectorGroupLeafTag
  /** Depth of the leaf below the unit root (direct child = 1). */
  depth: number
  /** Paint order rank; equals `leafIndex` (kept explicit so callers do not re-derive it). */
  zOrder: number
  /** The leaf Element itself (read-only; never mutated by this module). */
  element: Element
  /** Composed ancestor CTM (unit root exclusive, `<svg>` exclusive). Identity when no ancestor transforms. */
  ancestorMatrix: VectorGroupMatrix
  /** Leaf's own `transform` as a matrix. Identity when absent/unparseable. */
  ownMatrix: VectorGroupMatrix
  /** Full document CTM for the leaf: `ancestorMatrix * ownMatrix`. */
  ctm: VectorGroupMatrix
}

export type VectorGroupUnitSummary = {
  /** The `<g>` unit root element (read-only). */
  root: Element
  leaves: VectorGroupLeafDescriptor[]
  /** True when the unit carries the explicit-group identity token. */
  isExplicitGroup: boolean
  /** Number of editable leaves (0 = ghost: filtered from selection, DOM untouched). */
  leafCount: number
}

export type LeafFlatRange = {
  leafIndex: number
  /** First flattened anchor slot of this leaf. */
  start: number
  /** Number of flattened anchor slots owned by this leaf. */
  count: number
}

const GROUP_LEAF_TAGS: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'ellipse',
  'circle',
  'line',
  'polyline',
  'polygon',
])

const GROUP_WRAPPER_TAGS: ReadonlySet<string> = new Set(['g', 'svg', 'a', 'switch'])

const NON_RENDERING_TAGS: ReadonlySet<string> = new Set([
  'defs',
  'metadata',
  'title',
  'desc',
  'clippath',
  'mask',
  'lineargradient',
  'radialgradient',
  'pattern',
  'symbol',
  'style',
  'script',
])

const IDENTITY_MATRIX: VectorGroupMatrix = [1, 0, 0, 1, 0, 0]

// SVG number token (optional sign, decimal point, exponent). Shared grammar
// with `vector-svg.ts` (kept duplicated so this module stays dependency-free):
// a token that is not a plain SVG number makes the whole operation malformed.
const GROUP_TRANSFORM_NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

function parseGroupTransformNumbers(args: string): number[] | undefined {
  const trimmed = args.trim()
  if (trimmed === '') return []
  const tokens = trimmed.split(/[\s,]+/).filter((part) => part.length > 0)
  const values: number[] = []
  for (const token of tokens) {
    if (!GROUP_TRANSFORM_NUMBER_TOKEN.test(token)) return undefined
    const parsed = Number(token)
    if (!Number.isFinite(parsed)) return undefined
    values.push(parsed)
  }
  return values
}

/**
 * Parse a `transform` attribute into a 2D matrix. Supports the SVG
 * transform-list (`matrix` / `translate` / `scale` / `rotate` / `skewX` /
 * `skewY`, angles in degrees) composed left-to-right, mirroring
 * `transformMatrix` in `vector-svg.ts`. Unknown operations are skipped;
 * malformed argument lists fail closed by skipping just that operation;
 * empty/invalid input yields identity.
 */
export function parseSvgTransformAttribute(transform: string | null | undefined): VectorGroupMatrix {
  if (typeof transform !== 'string' || transform.trim() === '') return [...IDENTITY_MATRIX] as VectorGroupMatrix
  let matrix: VectorGroupMatrix = [...IDENTITY_MATRIX] as VectorGroupMatrix
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  let found = false
  while ((match = pattern.exec(transform)) !== null) {
    found = true
    const op = match[1]!
    const values = parseGroupTransformNumbers(match[2] ?? '')
    // Malformed arguments: skip this operation (fail-closed).
    if (!values) continue
    if (op === 'matrix' && values.length >= 6) {
      matrix = multiplyGroupMatrices(matrix, [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!])
    } else if (op === 'translate') {
      if (values.length < 1) continue
      const tx = values[0]!
      const ty = values.length >= 2 ? values[1]! : 0
      matrix = multiplyGroupMatrices(matrix, [1, 0, 0, 1, tx, ty])
    } else if (op === 'scale') {
      if (values.length < 1) continue
      const sx = values[0]!
      const sy = values.length >= 2 ? values[1]! : sx
      matrix = multiplyGroupMatrices(matrix, [sx, 0, 0, sy, 0, 0])
    } else if (op === 'rotate') {
      if (values.length < 1) continue
      const degrees = values[0]!
      const radians = (degrees * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: VectorGroupMatrix = [cos, sin, -sin, cos, 0, 0]
      if (values.length >= 3) {
        const cx = values[1]!
        const cy = values[2]!
        const toOrigin: VectorGroupMatrix = [1, 0, 0, 1, -cx, -cy]
        const back: VectorGroupMatrix = [1, 0, 0, 1, cx, cy]
        matrix = multiplyGroupMatrices(matrix, multiplyGroupMatrices(back, multiplyGroupMatrices(rotation, toOrigin)))
      } else {
        matrix = multiplyGroupMatrices(matrix, rotation)
      }
    } else if (op === 'skewX') {
      if (values.length < 1) continue
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) continue
      matrix = multiplyGroupMatrices(matrix, [1, 0, tangent, 1, 0, 0])
    } else if (op === 'skewY') {
      if (values.length < 1) continue
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) continue
      matrix = multiplyGroupMatrices(matrix, [1, tangent, 0, 1, 0, 0])
    }
  }
  return found ? matrix : ([...IDENTITY_MATRIX] as VectorGroupMatrix)
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as Element).nodeType === 1 &&
    typeof (node as Element).tagName === 'string'
  )
}

function tagOf(element: Element): string {
  try {
    return element.tagName.toLowerCase()
  } catch {
    return ''
  }
}

export function isGroupLeafTag(tag: string): tag is VectorGroupLeafTag {
  return GROUP_LEAF_TAGS.has(tag.toLowerCase())
}

function isNonRenderingTag(tag: string): boolean {
  return NON_RENDERING_TAGS.has(tag.toLowerCase())
}

export function multiplyGroupMatrices(left: VectorGroupMatrix, right: VectorGroupMatrix): VectorGroupMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

export function invertGroupMatrix(matrix: VectorGroupMatrix): VectorGroupMatrix {
  const inverted = tryInvertGroupMatrix(matrix)
  if (!inverted) return [...IDENTITY_MATRIX] as VectorGroupMatrix
  return inverted
}

/**
 * 明示的な fail-closed 逆行列 (DOM 書込用)。安全に可逆な場合のみ逆行列を
 * 返し、特異・非有限では `null` を返す。呼出側は `null` を拒否として扱う。
 */
export function tryInvertGroupMatrix(matrix: VectorGroupMatrix | undefined | null): VectorGroupMatrix | null {
  try {
    if (!matrix || matrix.length < 6) return null
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(matrix[index])) return null
    }
    const determinant = matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!
    if (!Number.isFinite(determinant) || determinant === 0) return null
    const inverse: VectorGroupMatrix = [
      matrix[3]! / determinant,
      -matrix[1]! / determinant,
      -matrix[2]! / determinant,
      matrix[0]! / determinant,
      (matrix[2]! * matrix[5]! - matrix[3]! * matrix[4]!) / determinant,
      (matrix[1]! * matrix[4]! - matrix[0]! * matrix[5]!) / determinant,
    ]
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(inverse[index])) return null
    }
    return inverse
  } catch {
    return null
  }
}

export function applyGroupMatrix(matrix: VectorGroupMatrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }
}

function childElementIndex(parent: Element, child: Element): number {
  const kids = Array.from(parent.children).filter(isElement)
  return kids.indexOf(child)
}

/**
 * Collect editable leaf descriptors for one `<g>` unit root, depth-first in
 * document order (paint order). Wrapper `<g>` nodes are descended into;
 * non-rendering companions (`defs`, `mask`, ...) and non-geometry nodes
 * (text/raster/use/...) are skipped without touching the DOM. A bare leaf
 * passed as root yields a single descriptor. Anything else yields `[]`.
 */
export function collectGroupLeafDescriptors(unitRoot: Element): VectorGroupLeafDescriptor[] {
  if (!isElement(unitRoot)) return []
  const rootTag = tagOf(unitRoot)
  if (isGroupLeafTag(rootTag)) {
    const own = parseSvgTransformAttribute(unitRoot.getAttribute('transform'))
    return [
      {
        leafIndex: 0,
        ancestorPath: [],
        leafKey: leafKeyFor([], 0),
        tag: rootTag as VectorGroupLeafTag,
        depth: 0,
        zOrder: 0,
        element: unitRoot,
        ancestorMatrix: [...IDENTITY_MATRIX] as VectorGroupMatrix,
        ownMatrix: own,
        ctm: multiplyGroupMatrices([...IDENTITY_MATRIX] as VectorGroupMatrix, own),
      },
    ]
  }
  if (rootTag !== 'g') return []
  const out: VectorGroupLeafDescriptor[] = []
  const ancestorTransforms: VectorGroupMatrix[] = []
  const walk = (node: Element, ancestorPath: number[], depth: number) => {
    const kids = Array.from(node.children).filter(isElement)
    kids.forEach((child, childOffset) => {
      const tag = tagOf(child)
      if (isNonRenderingTag(tag)) return
      if (tag === 'g') {
        const local = parseSvgTransformAttribute(child.getAttribute('transform'))
        ancestorTransforms.push(local)
        const nextPath = [...ancestorPath, childOffset]
        walk(child, nextPath, depth + 1)
        ancestorTransforms.pop()
        return
      }
      if (GROUP_WRAPPER_TAGS.has(tag)) {
        // Transparent wrappers (`a`/`switch`/`svg` nesting): descend without
        // recording a group level in the ancestor path.
        walk(child, ancestorPath, depth)
        return
      }
      if (!isGroupLeafTag(tag)) return
      let ancestors: VectorGroupMatrix = [...IDENTITY_MATRIX] as VectorGroupMatrix
      for (const local of ancestorTransforms) ancestors = multiplyGroupMatrices(ancestors, local)
      // Include transforms of intermediate wrappers between the unit root and
      // the leaf's direct parent chain is already represented by the pushed
      // `<g>` levels; the unit root's own transform is deliberately excluded
      // here (it belongs to the unit, not the leaf) so the CTM stays
      // leaf-relative inside the unit. Document-space callers compose the
      // unit/world matrix separately via `composeUnitWorldMatrix`.
      const own = parseSvgTransformAttribute(child.getAttribute('transform'))
      out.push({
        leafIndex: -1,
        ancestorPath: [...ancestorPath],
        leafKey: '',
        tag: tag as VectorGroupLeafTag,
        depth: depth + 1,
        zOrder: -1,
        element: child,
        ancestorMatrix: ancestors,
        ownMatrix: own,
        ctm: multiplyGroupMatrices(ancestors, own),
      })
    })
  }
  walk(unitRoot, [], 0)
  out.forEach((leaf, order) => {
    leaf.leafIndex = order
    leaf.zOrder = order
    leaf.leafKey = leafKeyFor(leaf.ancestorPath, order)
  })
  return out
}

function leafKeyFor(ancestorPath: number[], order: number): string {
  const chain = ancestorPath.map((index) => String(index)).join('/')
  return chain.length > 0 ? `g/${chain}:${order}` : `g:${order}`
}

/** Summarize one selectable unit root for reshape-vs-select decisions. */
export function summarizeGroupUnit(unitRoot: Element): VectorGroupUnitSummary {
  const leaves = collectGroupLeafDescriptors(unitRoot)
  let isExplicitGroup = false
  try {
    const tokens = (unitRoot.getAttribute('class') ?? '').split(/[\s\u0000-\u0020]+/).filter((token) => token.length > 0)
    isExplicitGroup = tagOf(unitRoot) === 'g' && tokens.includes('xyo-vector-explicit-group')
  } catch {
    isExplicitGroup = false
  }
  return { root: unitRoot, leaves, isExplicitGroup, leafCount: leaves.length }
}

/** Compose the unit root's own transform with the document ancestors above it (caller supplies both). */
export function composeUnitWorldMatrix(
  unitOwnTransform: string | null | undefined,
  ancestorMatrix: VectorGroupMatrix | undefined,
): VectorGroupMatrix {
  const own = parseSvgTransformAttribute(unitOwnTransform)
  if (!ancestorMatrix) return own
  return multiplyGroupMatrices(ancestorMatrix, own)
}

/** Document-space CTM for a leaf: `unitWorld * leaf.ctm`. */
export function documentCtmForLeaf(
  leaf: VectorGroupLeafDescriptor,
  unitWorld: VectorGroupMatrix | undefined,
): VectorGroupMatrix {
  if (!unitWorld) return [...leaf.ctm] as VectorGroupMatrix
  return multiplyGroupMatrices(unitWorld, leaf.ctm)
}

/** Map a document-space point into a leaf's local frame (inverse CTM). Falls back to the input on degenerate CTMs. */
export function documentPointToLeafLocal(
  leaf: VectorGroupLeafDescriptor,
  unitWorld: VectorGroupMatrix | undefined,
  point: { x: number; y: number },
): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { x: point.x, y: point.y }
  const ctm = documentCtmForLeaf(leaf, unitWorld)
  const inverse = invertGroupMatrix(ctm)
  // A degenerate CTM inverts to identity; detect it so callers can tell the
  // fallback apart from a real conversion (identity CTM is also possible, so
  // compare against the original instead of the result).
  const determinant = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (!Number.isFinite(determinant) || determinant === 0) return { x: point.x, y: point.y }
  return applyGroupMatrix(inverse, point.x, point.y)
}

/** Map a leaf-local point back to document space. */
export function leafLocalPointToDocument(
  leaf: VectorGroupLeafDescriptor,
  unitWorld: VectorGroupMatrix | undefined,
  point: { x: number; y: number },
): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { x: point.x, y: point.y }
  return applyGroupMatrix(documentCtmForLeaf(leaf, unitWorld), point.x, point.y)
}

// ---------------------------------------------------------------------------
// Compound-root normalization (reshape leaf <-> select root).
// ---------------------------------------------------------------------------

export type NormalizedRootSelection = {
  /** Selectable-unit index that the select tool must show (the compound root). */
  rootIndex: number
  /** Leaf indices inside the root that reshape was operating on (empty after normalization). */
  leafIndices: number[]
  /** True when the input actually named leaves of this root. */
  normalized: boolean
}

/**
 * Normalize a reshape leaf selection back to its compound root for the select
 * tool: the select tool shows one unit (the `<g>` root), reshape keeps the
 * per-leaf addresses. Pure index arithmetic; no DOM access.
 */
export function normalizeLeafSelectionToRoot(rootIndex: number, leafIndices: readonly number[]): NormalizedRootSelection {
  const clean = [...new Set(leafIndices.filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b)
  if (!Number.isInteger(rootIndex) || rootIndex < 0) return { rootIndex: -1, leafIndices: clean, normalized: false }
  if (clean.length === 0) return { rootIndex, leafIndices: [], normalized: false }
  return { rootIndex, leafIndices: [], normalized: true }
}

/** True when every selected leaf index still names a live leaf of this unit revision. */
export function isLiveLeafSelection(leaves: readonly VectorGroupLeafDescriptor[], selection: readonly number[]): boolean {
  if (selection.length === 0) return true
  const live = new Set(leaves.map((leaf) => leaf.leafIndex))
  return selection.every((index) => live.has(index))
}

/** Filter a leaf selection down to live leaves (dedupe + sort), mirroring `normalizeReshapeSelection`. */
export function normalizeLeafSelection(leaves: readonly VectorGroupLeafDescriptor[], selection: readonly number[]): number[] {
  const live = new Set(leaves.map((leaf) => leaf.leafIndex))
  return [...new Set(selection.filter((index) => Number.isInteger(index) && index >= 0 && live.has(index)))].sort(
    (a, b) => a - b,
  )
}

// ---------------------------------------------------------------------------
// Flat-index bridge (unit-wide Paper indices <-> per-leaf addresses).
// ---------------------------------------------------------------------------

/**
 * Build per-leaf flat ranges from per-leaf anchor counts. `anchorCounts[i]`
 * is the number of flattened *anchor* slots leaf `i` owns (handle slots are
 * expanded by the caller when known; when unknown, pass anchor counts and
 * treat the mapping as anchor-granular). Returns ranges in leaf order.
 */
export function flatRangesForLeaves(anchorCounts: readonly number[]): LeafFlatRange[] {
  const ranges: LeafFlatRange[] = []
  let start = 0
  anchorCounts.forEach((count, leafIndex) => {
    const safe = Number.isInteger(count) && count > 0 ? count : 0
    ranges.push({ leafIndex, start, count: safe })
    start += safe
  })
  return ranges
}

/** Which leaf owns a unit-wide flattened index? `undefined` when out of range. */
export function leafIndexForFlatIndex(ranges: readonly LeafFlatRange[], flatIndex: number): number | undefined {
  if (!Number.isInteger(flatIndex) || flatIndex < 0) return undefined
  for (const range of ranges) {
    if (flatIndex >= range.start && flatIndex < range.start + range.count) return range.leafIndex
  }
  return undefined
}

/** All flattened indices owned by the given leaves (ascending). Enables whole-child-shape moves. */
export function flatIndicesForLeaves(ranges: readonly LeafFlatRange[], leafIndices: readonly number[]): number[] {
  const wanted = new Set(leafIndices.filter((index) => Number.isInteger(index) && index >= 0))
  const out: number[] = []
  for (const range of ranges) {
    if (!wanted.has(range.leafIndex)) continue
    for (let offset = 0; offset < range.count; offset++) out.push(range.start + offset)
  }
  return out.sort((a, b) => a - b)
}

/** Local anchor slot of a flat index inside its leaf (`flat - range.start`). */
export function localIndexForFlatIndex(ranges: readonly LeafFlatRange[], flatIndex: number): number | undefined {
  const leafIndex = leafIndexForFlatIndex(ranges, flatIndex)
  if (leafIndex === undefined) return undefined
  const range = ranges.find((entry) => entry.leafIndex === leafIndex)
  if (!range) return undefined
  return flatIndex - range.start
}

/**
 * Expand a leaf selection to every flattened anchor of those leaves: the
 * missing "move this whole child shape" address. Unknown/empty leaves
 * contribute nothing; output is ascending so sequential application never
 * invalidates a later index (moves add/remove no slots).
 */
export function expandLeafSelectionToFlatIndices(
  anchorCounts: readonly number[],
  selectedLeaves: readonly number[],
): number[] {
  return flatIndicesForLeaves(flatRangesForLeaves(anchorCounts), selectedLeaves)
}

// ---------------------------------------------------------------------------
// Overlap Z-order + selection/render separation.
// ---------------------------------------------------------------------------

/** Paint-order comparator: lower `zOrder` paints first (is underneath). Later document order wins. */
export function comparePaintOrder(left: VectorGroupLeafDescriptor, right: VectorGroupLeafDescriptor): number {
  return left.zOrder - right.zOrder
}

/** Sort descriptors bottom-to-top without mutating the input. */
export function sortLeavesByPaintOrder(leaves: readonly VectorGroupLeafDescriptor[]): VectorGroupLeafDescriptor[] {
  return [...leaves].sort(comparePaintOrder)
}

export type LeafBounds = { x: number; y: number; width: number; height: number }

/** Inclusive bounding-box hit pre-filter for Z-order tests (exact shape hits stay with Paper.js `hitTest`). */
export function leafBoundsContains(bounds: LeafBounds, point: { x: number; y: number }): boolean {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return false
  }
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  return point.x >= Math.min(bounds.x, right) && point.x <= Math.max(bounds.x, right) && point.y >= Math.min(bounds.y, bottom) && point.y <= Math.max(bounds.y, bottom)
}

/**
 * Topmost (last in paint order) leaf whose bounds contain the point.
 * Returns the leaf descriptor or `undefined`. This is a pre-filter only:
 * callers must confirm with a real Paper.js `hitTest` (fill/stroke/curve),
 * which is why the browser test pairs this helper with Paper hits.
 */
export function topmostLeafForPoint(
  leaves: readonly VectorGroupLeafDescriptor[],
  boundsOf: (leaf: VectorGroupLeafDescriptor) => LeafBounds | undefined,
  point: { x: number; y: number },
): VectorGroupLeafDescriptor | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  const ordered = sortLeavesByPaintOrder(leaves)
  for (let index = ordered.length - 1; index >= 0; index--) {
    const leaf = ordered[index]!
    let bounds: LeafBounds | undefined
    try {
      bounds = boundsOf(leaf)
    } catch {
      continue
    }
    if (!bounds) continue
    if (leafBoundsContains(bounds, point)) return leaf
  }
  return undefined
}

export type SelectionRenderSplit<T> = {
  /** Copies of the selected leaves (same element refs, new array). Mutating this array never affects `renderOrder`. */
  selected: T[]
  /** Copies of the unselected leaves in paint order (new array). */
  renderOrder: T[]
}

/**
 * Split leaves into selection vs render lists. Both outputs are new arrays;
 * inputs are never mutated and the two outputs share no array identity, so a
 * selection highlight/write can never alias the render traversal (Z-order
 * stays exactly document order in `renderOrder`).
 */
export function partitionSelectionAndRender<T extends { leafIndex: number }>(
  leaves: readonly T[],
  selectedLeafIndices: readonly number[],
): SelectionRenderSplit<T> {
  const wanted = new Set(selectedLeafIndices.filter((index) => Number.isInteger(index) && index >= 0))
  const selected: T[] = []
  const renderOrder: T[] = []
  for (const leaf of leaves) {
    if (wanted.has(leaf.leafIndex)) selected.push(leaf)
    else renderOrder.push(leaf)
  }
  return { selected: [...selected], renderOrder: [...renderOrder] }
}

// ---------------------------------------------------------------------------
// Import / save / reindex safety.
// ---------------------------------------------------------------------------

export type LeafSignature = {
  leafIndex: number
  tag: string
  paint: string
  geometry: string
}

function paintSignature(element: Element): string {
  try {
    const names = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'opacity', 'transform']
    return names.map((name) => `${name}=${element.getAttribute(name) ?? ''}`).join(';')
  } catch {
    return ''
  }
}

function geometrySignature(element: Element): string {
  try {
    const tag = tagOf(element)
    const names =
      tag === 'path'
        ? ['d']
        : tag === 'rect' || tag === 'image'
          ? ['x', 'y', 'width', 'height', 'rx', 'ry']
          : tag === 'ellipse'
            ? ['cx', 'cy', 'rx', 'ry']
            : tag === 'circle'
              ? ['cx', 'cy', 'r']
              : tag === 'line'
                ? ['x1', 'y1', 'x2', 'y2']
                : ['points', 'x', 'y']
    return `${tag}|${names.map((name) => `${name}=${element.getAttribute(name) ?? ''}`).join(';')}`
  } catch {
    return tagOf(element)
  }
}

/** Best-effort cross-revision signatures (tag + paint + geometry). Caller decides the match threshold. */
export function leafSignatures(leaves: readonly VectorGroupLeafDescriptor[]): LeafSignature[] {
  return leaves.map((leaf) => ({
    leafIndex: leaf.leafIndex,
    tag: leaf.tag,
    paint: paintSignature(leaf.element),
    geometry: geometrySignature(leaf.element),
  }))
}

export type LeafReindexMatch = {
  beforeLeafIndex: number
  afterLeafIndex: number | undefined
  /** True when exactly one after-leaf shares tag+paint+geometry. */
  unique: boolean
}

/**
 * Best-effort leaf matching across an import/save/reindex boundary. Exact
 * positional identity (`ancestorPath`/`leafKey`) is only valid within one
 * revision; after undo/redo/import the document may reorder leaves, so this
 * matches by tag+paint+geometry signature. Ambiguous (0 or 2+ candidates) or
 * changed leaves yield `afterLeafIndex: undefined` so callers drop the
 * selection instead of moving the wrong child shape. Never throws.
 */
export function matchLeavesAcrossReindex(
  before: readonly VectorGroupLeafDescriptor[],
  after: readonly VectorGroupLeafDescriptor[],
): LeafReindexMatch[] {
  try {
    const afterSigs = leafSignatures(after)
    const beforeSigs = leafSignatures(before)
    return beforeSigs.map((sig) => {
      const candidates = afterSigs.filter(
        (afterSig) => afterSig.tag === sig.tag && afterSig.paint === sig.paint && afterSig.geometry === sig.geometry,
      )
      if (candidates.length === 1) {
        return { beforeLeafIndex: sig.leafIndex, afterLeafIndex: candidates[0]!.leafIndex, unique: true }
      }
      return { beforeLeafIndex: sig.leafIndex, afterLeafIndex: undefined, unique: false }
    })
  } catch {
    return before.map((leaf) => ({ beforeLeafIndex: leaf.leafIndex, afterLeafIndex: undefined, unique: false }))
  }
}

/** Rebase a leaf selection through a reindex match table; ambiguous leaves are dropped (fail-closed). */
export function rebaseLeafSelectionAfterReindex(
  selection: readonly number[],
  matches: readonly LeafReindexMatch[],
): number[] {
  const byBefore = new Map(matches.map((match) => [match.beforeLeafIndex, match] as const))
  const out: number[] = []
  for (const index of selection) {
    if (!Number.isInteger(index) || index < 0) continue
    const match = byBefore.get(index)
    if (match?.afterLeafIndex !== undefined) out.push(match.afterLeafIndex)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

export function __testOnly_childElementIndex(parent: Element, child: Element): number {
  return childElementIndex(parent, child)
}

// ---------------------------------------------------------------------------
// Fail-closed leaf-reshape eligibility (pure DOM check, no Paper.js).
// ---------------------------------------------------------------------------
//
// The real Paper hit probe (`paperGroupLeafHitAtPoint` in `paper-vector.ts`)
// re-checks geometry identity, but the editor gates leaf subselection on this
// cheaper DOM classifier first so unsupported units get an explicit status
// without ever importing: text/raster/reference/clip content and empty units
// are declined here. Supported units still go through the Paper probe, which
// remains authoritative for compound/ambiguous identity.

export type GroupLeafReshapeEligibility = { ok: true } | { ok: false; reason: string }

const LEAF_RESHAPE_BLOCKED_TAGS: ReadonlySet<string> = new Set([
  'text',
  'tspan',
  'tref',
  'image',
  'use',
  'foreignobject',
  'clippath',
  'mask',
  'video',
  'audio',
  'iframe',
])

function hasLeafReshapeBlockingStyle(element: Element): boolean {
  try {
    if (element.hasAttribute?.('clip-path') || element.hasAttribute?.('mask')) return true
    const style = element.getAttribute?.('style') ?? ''
    if (/clip-path\s*:/i.test(style)) return true
    if (/(^|;)\s*mask\s*:/i.test(style)) return true
  } catch {
    return true
  }
  return false
}

/**
 * DOM-only gate for leaf subselection inside a `<g>` unit. Returns
 * `{ ok: true }` only for groups whose descendants are all plain geometry
 * leaves (possibly nested in plain `<g>` wrappers). Anything else —
 * non-groups, empty groups, text/raster/reference/clip content, clip/mask
 * styling on the unit or its descendants — returns `{ ok: false, reason }`
 * so callers can report explicitly and leave history/selection untouched.
 * Compound/ambiguous identity is decided by the Paper probe, not here.
 */
export function classifyGroupUnitForLeafReshape(unitRoot: Element): GroupLeafReshapeEligibility {
  try {
    if (!isElement(unitRoot)) return { ok: false, reason: 'not an element (fail-closed)' }
    if (tagOf(unitRoot) !== 'g') return { ok: false, reason: 'not a group unit (fail-closed)' }
    try {
      if (unitRoot.hasAttribute?.('data-is-pg-text-item')) {
        return { ok: false, reason: 'text group is not leaf-editable (fail-closed)' }
      }
    } catch {
      return { ok: false, reason: 'text group check failed (fail-closed)' }
    }
    if (hasLeafReshapeBlockingStyle(unitRoot)) {
      return { ok: false, reason: 'clip/mask on group (fail-closed)' }
    }
    try {
      let node = unitRoot.parentElement
      while (node && node.tagName?.toLowerCase?.() !== 'svg') {
        if (hasLeafReshapeBlockingStyle(node)) {
          return { ok: false, reason: 'clip/mask above group (fail-closed)' }
        }
        node = node.parentElement
      }
    } catch {
      return { ok: false, reason: 'ancestor clip check failed (fail-closed)' }
    }
    let leaves = 0
    const walk = (node: Element): GroupLeafReshapeEligibility | undefined => {
      for (const child of Array.from(node.children)) {
        if (!isElement(child)) continue
        const tag = tagOf(child)
        if (LEAF_RESHAPE_BLOCKED_TAGS.has(tag)) {
          return { ok: false, reason: `${tag} in group is not leaf-editable (fail-closed)` }
        }
        if (tag === 'clippath' || tag === 'mask') {
          return { ok: false, reason: 'clip companion in group (fail-closed)' }
        }
        if (hasLeafReshapeBlockingStyle(child)) {
          return { ok: false, reason: 'clip/mask in group (fail-closed)' }
        }
        if (tag === 'g') {
          try {
            if (child.hasAttribute?.('data-is-pg-text-item')) {
              return { ok: false, reason: 'text group is not leaf-editable (fail-closed)' }
            }
          } catch {
            return { ok: false, reason: 'text group check failed (fail-closed)' }
          }
          const nested = walk(child)
          if (nested) return nested
          continue
        }
        if (isGroupLeafTag(tag)) {
          leaves += 1
          continue
        }
        if (tag === 'a' || tag === 'switch' || tag === 'svg' || tag === 'defs' || tag === 'metadata' || tag === 'title' || tag === 'desc') {
          if (child.children.length > 0) {
            const nested = walk(child)
            if (nested) return nested
          }
          continue
        }
        if (child.children.length > 0) {
          const nested = walk(child)
          if (nested) return nested
          continue
        }
        // Childless unknown nodes (`desc`, `title`, ...) carry no geometry.
      }
      return undefined
    }
    const blocked = walk(unitRoot)
    if (blocked) return blocked
    if (leaves === 0) return { ok: false, reason: 'empty group has no leaf (fail-closed)' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'group eligibility probe failed (fail-closed)' }
  }
}
