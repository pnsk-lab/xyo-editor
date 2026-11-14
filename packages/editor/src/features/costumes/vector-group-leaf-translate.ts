// Single-leaf document-delta -> ancestor-frame translate planner for `<g>` units.
//
// Position: `vector-group-reshape.ts` gives leaf identity + CTM + flat-index
// bridges, but its DOM gate (`classifyGroupUnitForLeafReshape`) and the Paper
// probe (`paperGroupLeafHitAtPoint` in `paper-vector.ts`) decline *the whole
// unit* as soon as any descendant is text/raster/reference/clip content. Its
// leaf collector (`collectGroupLeafDescriptors`) likewise skips non-geometry
// nodes, so a group of "two rects + one text label" has no vocabulary for
// "nudge just this one safe child by a document delta". The anchor movers
// (`moveVectorReshapePoints` / `moveVectorEditablePoint`) rewrite leaf
// geometry through Paper, which is wrong for glyphs/rasters/symbol shadows.
//
// Scratch-parity comparison (behaviour described from observed parity notes
// only; no reference source was copied into this file, AGPL material included):
//
//   - Scratch reshape inside a group works on one child shape at a time and
//     returns to the compound root on select-tool return (the model mirrored
//     by `normalizeLeafSelectionToRoot`).
//   - Scratch geometry children (paths/shapes) expose anchors *and* whole-
//     child moves.
//   - Scratch Text / PointText children are selectable and movable *as a
//     whole*; their glyph outlines are not reshape anchors.
//   - Scratch Raster (`image`) children are movable *as a whole*; their pixels
//     are not reshape anchors.
//   - Scratch symbol/reference (`use` / PlacedSymbol) children move *as a
//     whole*; the shadow definition is never rewritten.
//   - Clip/mask/compound/ambiguous units fail closed: honest status, no
//     history, no selection change.
//
// Current-tree gap: `vector-group-reshape.ts` + `paper-vector.ts` treat the
// text/raster/use cases as unit-wide `unsupported` (correct for anchor
// reshaping, but with no whole-leaf translate alternative), so even a safe
// single-leaf nudge has no pure planner. This module is that planner, and
// nothing else:
//
//   - Pure and dependency-free: no Paper.js import, no DOM mutation (every
//     function only reads attributes/parents/children and returns new
//     objects), no history/sanitizer/editor state. Coordinates are document
//     units unless the name says `Ancestor`.
//   - Sibling-safe by construction: a plan touches exactly one leaf's own
//     `transform` attribute (prepend `translate()` in the leaf-parent frame).
//     No sibling is read for writing, order/Z-order never changes (prepending
//     a transform does not reorder children), and no anchor indices shift.
//   - Ancestor-frame conversion: the document delta is mapped through the
//     *inverse linear part* of `unitWorld * wrapperChain` (the unit root's own
//     transform excluded from the plan, the leaf's own transform excluded by
//     design: prepending puts the translation in the parent frame, so the
//     leaf's own matrix never needs inverting). Singular / non-finite
//     ancestors fail closed (`ok: false`), never through an identity fallback.
//   - `text` / `image` / `use` are admitted only under narrow safe conditions
//     (see `classifyLeafElementForTranslate`): whole-element translate via the
//     same prepend, never per-glyph/per-pixel/per-shadow edits. Anything else
//     (tspan-as-leaf, href-less use/image, clipped/masked leaves, defs-homed
//     leaves, unexpected leaf children) fails closed.
//   - Selection-stale / reindex / Undo: leaf identity here is positional for
//     one document revision. A plan is valid only for the live revision it was
//     computed from. Callers must re-collect descriptors and revalidate with
//     `isLiveLeafSelection` / `matchLeavesAcrossReindex` (or the attached
//     check `isLeafAttachedToUnit`) after any structural edit, import, or
//     undo/redo, apply through exactly one import/serialize pass with exactly
//     one history entry, and refuse no-op deltas (this planner already refuses
//     zero/non-finite deltas so a no-op can never mint a history entry).
//
// What this module deliberately does NOT do (caller / integrator owns it):
//
//   - No DOM writes, no history capture, no selection updates, no network, no
//     `defs` resolution (`use` hrefs and `url(#...)` paints are preserved
//     opaquely, never dereferenced).
//   - No exact hit testing (that stays with Paper.js `hitTest`), no curve
//     handle handling, no per-anchor moves (that stays with the existing
//     anchor writers).
//   - **Unwired by design (2026-11-11): `Editor.svelte`,
//     `BitmapEditor.svelte`, `paper-vector.ts` and `vector-svg.ts` do NOT
//     import this module.** Behavioural proof lives in
//     `test/vector-group-leaf-translate.test.ts` (pure) and
//     `test/vector-group-leaf-translate.browser.test.ts` (real `DOMMatrix` /
//     Paper.js / canvas-pixel oracles + an explicit unwired assertion). Wire-up
//     is a separate, reviewed step: one import/serialize pass, one history
//     entry, Escape-restore parity, and the same fail-closed statuses.
//
// Safety: no untrusted-markup parsing (callers pass Elements), no
// serialization, no mutation of inputs, non-finite coordinates are refused.
// Transform grammar is re-derived from the SVG transform list (kept
// duplicated so this module stays dependency-free), not copied from any
// editor or reference implementation.

export type VectorLeafTranslateMatrix = [number, number, number, number, number, number]

export type VectorLeafTranslateDelta = { dx: number; dy: number }

export type VectorLeafTranslateWarning =
  | 'font-metrics'
  | 'paint-reference'
  | 'shadow-reference'
  | 'raster-content'
  | 'filter-region'

export type LeafTranslateLeafKind = 'geometry' | 'text' | 'image' | 'use'

export type LeafTranslateEligibility =
  | { ok: true; kind: LeafTranslateLeafKind; warnings: VectorLeafTranslateWarning[] }
  | { ok: false; reason: string }

export type LeafTranslatePlan =
  | {
      ok: true
      /** The leaf tag that was planned (for caller logging only). */
      leafTag: string
      /** Translation to prepend in the leaf-parent (ancestor) frame. */
      ancestorDelta: VectorLeafTranslateDelta
      /** Echo of the requested document delta. */
      documentDelta: VectorLeafTranslateDelta
      /** The leaf's previous `transform` attribute (possibly ''). */
      oldTransform: string
      /** Replacement `transform` value: `translate(ax ay) <old>` (or bare). */
      newTransform: string
      /** Non-blocking appearance notes the caller should surface/log. */
      warnings: VectorLeafTranslateWarning[]
    }
  | { ok: false; reason: string }

const LEAF_TRANSLATE_IDENTITY: VectorLeafTranslateMatrix = [1, 0, 0, 1, 0, 0]

const LEAF_TRANSLATE_GEOMETRY_TAGS: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'ellipse',
  'circle',
  'line',
  'polyline',
  'polygon',
])

const LEAF_TRANSLATE_NON_RENDERING_TAGS: ReadonlySet<string> = new Set([
  'defs',
  'mask',
  'clippath',
  'lineargradient',
  'radialgradient',
  'pattern',
  'symbol',
  'metadata',
  'style',
  'script',
])

const LEAF_TRANSLATE_RENDERED_CONTAINERS: ReadonlySet<string> = new Set(['g', 'a', 'switch', 'svg'])

const LEAF_TRANSLATE_NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

function leafTranslateIsElement(node: unknown): node is Element {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as Element).nodeType === 1 &&
    typeof (node as Element).tagName === 'string'
  )
}

function leafTranslateTagOf(element: Element): string {
  try {
    return element.tagName.toLowerCase()
  } catch {
    return ''
  }
}

function leafTranslateParseNumbers(args: string): number[] | undefined {
  const trimmed = args.trim()
  if (trimmed === '') return []
  const tokens = trimmed.split(/[\s,]+/).filter((part) => part.length > 0)
  const values: number[] = []
  for (const token of tokens) {
    if (!LEAF_TRANSLATE_NUMBER_TOKEN.test(token)) return undefined
    const parsed = Number(token)
    if (!Number.isFinite(parsed)) return undefined
    values.push(parsed)
  }
  return values
}

/**
 * Minimal SVG transform-list parser (mirrors the grammar used by
 * `vector-svg.ts` / `vector-group-reshape.ts`; duplicated so this module has
 * no imports). Unknown operations are skipped; malformed argument lists skip
 * just that operation (fail-closed per op); empty/invalid input is identity.
 */
export function parseLeafTranslateTransform(transform: string | null | undefined): VectorLeafTranslateMatrix {
  if (typeof transform !== 'string' || transform.trim() === '') {
    return [...LEAF_TRANSLATE_IDENTITY] as VectorLeafTranslateMatrix
  }
  let matrix: VectorLeafTranslateMatrix = [...LEAF_TRANSLATE_IDENTITY] as VectorLeafTranslateMatrix
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  let found = false
  while ((match = pattern.exec(transform)) !== null) {
    found = true
    const op = match[1]!
    const values = leafTranslateParseNumbers(match[2] ?? '')
    if (!values) continue
    if (op === 'matrix' && values.length >= 6) {
      matrix = multiplyLeafTranslateMatrices(matrix, [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!])
    } else if (op === 'translate') {
      if (values.length < 1) continue
      const tx = values[0]!
      const ty = values.length >= 2 ? values[1]! : 0
      matrix = multiplyLeafTranslateMatrices(matrix, [1, 0, 0, 1, tx, ty])
    } else if (op === 'scale') {
      if (values.length < 1) continue
      const sx = values[0]!
      const sy = values.length >= 2 ? values[1]! : sx
      matrix = multiplyLeafTranslateMatrices(matrix, [sx, 0, 0, sy, 0, 0])
    } else if (op === 'rotate') {
      if (values.length < 1) continue
      const radians = (values[0]! * Math.PI) / 180
      const rotation: VectorLeafTranslateMatrix = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]
      if (values.length >= 3) {
        const cx = values[1]!
        const cy = values[2]!
        matrix = multiplyLeafTranslateMatrices(
          matrix,
          multiplyLeafTranslateMatrices(
            [1, 0, 0, 1, cx, cy],
            multiplyLeafTranslateMatrices(rotation, [1, 0, 0, 1, -cx, -cy]),
          ),
        )
      } else {
        matrix = multiplyLeafTranslateMatrices(matrix, rotation)
      }
    } else if (op === 'skewX') {
      if (values.length < 1) continue
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) continue
      matrix = multiplyLeafTranslateMatrices(matrix, [1, 0, tangent, 1, 0, 0])
    } else if (op === 'skewY') {
      if (values.length < 1) continue
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) continue
      matrix = multiplyLeafTranslateMatrices(matrix, [1, tangent, 0, 1, 0, 0])
    }
  }
  return found ? matrix : ([...LEAF_TRANSLATE_IDENTITY] as VectorLeafTranslateMatrix)
}

export function multiplyLeafTranslateMatrices(
  left: VectorLeafTranslateMatrix,
  right: VectorLeafTranslateMatrix,
): VectorLeafTranslateMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

/**
 * Explicit fail-closed inverse (DOM-write gate). Returns the inverse only
 * when the matrix is finite and non-singular; otherwise `null`. Callers must
 * treat `null` as "refuse the write".
 */
export function tryInvertLeafTranslateMatrix(
  matrix: VectorLeafTranslateMatrix | undefined | null,
): VectorLeafTranslateMatrix | null {
  try {
    if (!matrix || matrix.length < 6) return null
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(matrix[index])) return null
    }
    const determinant = matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!
    if (!Number.isFinite(determinant) || determinant === 0) return null
    const inverse: VectorLeafTranslateMatrix = [
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

function leafTranslateHasBlockingStyle(element: Element): boolean {
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

function leafTranslateFiniteAttr(element: Element, name: string): number | undefined {
  try {
    const raw = element.getAttribute?.(name)
    if (raw === null || raw === undefined) return undefined
    const trimmed = String(raw).trim()
    if (trimmed === '') return undefined
    if (!LEAF_TRANSLATE_NUMBER_TOKEN.test(trimmed)) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function leafTranslateHref(element: Element): string {
  try {
    const href = element.getAttribute?.('href') ?? element.getAttribute?.('xlink:href') ?? ''
    return String(href ?? '').trim()
  } catch {
    return ''
  }
}

function leafTranslatePaintReferencesUrl(element: Element): boolean {
  try {
    for (const name of ['fill', 'stroke', 'filter']) {
      const raw = element.getAttribute?.(name) ?? ''
      if (/url\s*\(/i.test(String(raw))) return true
    }
    const style = element.getAttribute?.('style') ?? ''
    if (/url\s*\(/i.test(String(style))) return true
  } catch {
    return false
  }
  return false
}

function leafTranslateHasFilter(element: Element): boolean {
  try {
    const filter = element.getAttribute?.('filter') ?? ''
    if (String(filter).trim() !== '') return true
    const style = element.getAttribute?.('style') ?? ''
    if (/(^|;)\s*filter\s*:/i.test(String(style))) return true
  } catch {
    return true
  }
  return false
}

function leafTranslateElementChildren(element: Element): Element[] {
  try {
    return Array.from(element.children ?? []).filter(leafTranslateIsElement)
  } catch {
    return []
  }
}

/**
 * Leaf-local eligibility gate. Geometry leaves are always plannable (subject
 * to clip/mask + attachment checks in `planLeafDocumentTranslate`); `text`,
 * `image` and `use` are admitted only under narrow whole-element conditions:
 *
 * - `text`: the leaf itself is `<text>` (a bare `tspan`/`tref` is never a
 *   leaf), translated atomically via its own `transform`. Internal
 *   `tspan` offsets are preserved untouched. Font rendering stays with the
 *   existing stacks, hence the `font-metrics` warning: Paper.js `PointText`
 *   metrics and canvas pixels may differ from the SVG text run, but the
 *   translation itself is reference-preserving.
 * - `image`: finite `x`/`y` (default 0) plus finite positive
 *   `width`/`height` and a non-empty `href`, translated atomically. Raster
 *   pixels are never rewritten, hence the `raster-content` warning.
 * - `use`: non-empty `href`/`xlink:href`, translated atomically without
 *   resolving the shadow tree (defs edits can re-target the shadow, so the
 *   caller must revalidate after reindex/Undo), hence `shadow-reference`.
 *
 * Hard fail-closed (never plannable): `tspan`/`tref`/`foreignObject`,
 * `clipPath`/`mask` companions, `clip-path`/`mask` styling on the leaf,
 * gradients are *warnings* (reference preserved) not blocks, `defs`-family
 * tags are never leaves.
 */
export function classifyLeafElementForTranslate(leaf: Element): LeafTranslateEligibility {
  try {
    if (!leafTranslateIsElement(leaf)) return { ok: false, reason: 'not an element (fail-closed)' }
    const tag = leafTranslateTagOf(leaf)
    if (leafTranslateHasBlockingStyle(leaf)) {
      return { ok: false, reason: 'clip/mask on leaf (fail-closed)' }
    }
    if (LEAF_TRANSLATE_NON_RENDERING_TAGS.has(tag)) {
      return { ok: false, reason: `${tag || 'node'} is not a rendered leaf (fail-closed)` }
    }
    if (LEAF_TRANSLATE_GEOMETRY_TAGS.has(tag)) {
      const kids = leafTranslateElementChildren(leaf)
      if (kids.length > 0) {
        return { ok: false, reason: 'geometry leaf has unexpected children (fail-closed)' }
      }
      const warnings: VectorLeafTranslateWarning[] = []
      if (leafTranslatePaintReferencesUrl(leaf)) warnings.push('paint-reference')
      if (leafTranslateHasFilter(leaf)) warnings.push('filter-region')
      return { ok: true, kind: 'geometry', warnings }
    }
    if (tag === 'text') {
      // Descendants are glyph runs (`tspan`): allowed, because the plan never
      // descends — but clip companions or blocking styles inside fail closed.
      const stack = leafTranslateElementChildren(leaf)
      while (stack.length > 0) {
        const node = stack.pop()!
        const childTag = leafTranslateTagOf(node)
        if (childTag === 'clippath' || childTag === 'mask' || LEAF_TRANSLATE_NON_RENDERING_TAGS.has(childTag)) {
          return { ok: false, reason: 'clip companion in text (fail-closed)' }
        }
        if (leafTranslateHasBlockingStyle(node)) {
          return { ok: false, reason: 'clip/mask in text (fail-closed)' }
        }
        for (const grand of leafTranslateElementChildren(node)) stack.push(grand)
      }
      const warnings: VectorLeafTranslateWarning[] = ['font-metrics']
      if (leafTranslatePaintReferencesUrl(leaf)) warnings.push('paint-reference')
      if (leafTranslateHasFilter(leaf)) warnings.push('filter-region')
      return { ok: true, kind: 'text', warnings }
    }
    if (tag === 'image') {
      const kids = leafTranslateElementChildren(leaf)
      if (kids.length > 0) {
        return { ok: false, reason: 'image leaf has unexpected children (fail-closed)' }
      }
      const href = leafTranslateHref(leaf)
      if (href === '') {
        return { ok: false, reason: 'image without href (fail-closed)' }
      }
      const x = leafTranslateFiniteAttr(leaf, 'x') ?? 0
      const y = leafTranslateFiniteAttr(leaf, 'y') ?? 0
      const width = leafTranslateFiniteAttr(leaf, 'width')
      const height = leafTranslateFiniteAttr(leaf, 'height')
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: 'image position is non-finite (fail-closed)' }
      }
      if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) {
        return { ok: false, reason: 'image size is not finite-positive (fail-closed)' }
      }
      const warnings: VectorLeafTranslateWarning[] = ['raster-content']
      if (leafTranslatePaintReferencesUrl(leaf)) warnings.push('paint-reference')
      if (leafTranslateHasFilter(leaf)) warnings.push('filter-region')
      return { ok: true, kind: 'image', warnings }
    }
    if (tag === 'use') {
      const kids = leafTranslateElementChildren(leaf)
      if (kids.length > 0) {
        return { ok: false, reason: 'use leaf has unexpected children (fail-closed)' }
      }
      if (leafTranslateHref(leaf) === '') {
        return { ok: false, reason: 'use without href (fail-closed)' }
      }
      const warnings: VectorLeafTranslateWarning[] = ['shadow-reference']
      if (leafTranslatePaintReferencesUrl(leaf)) warnings.push('paint-reference')
      if (leafTranslateHasFilter(leaf)) warnings.push('filter-region')
      return { ok: true, kind: 'use', warnings }
    }
    if (tag === 'tspan' || tag === 'tref' || tag === 'foreignobject' || tag === 'video' || tag === 'audio' || tag === 'iframe') {
      return { ok: false, reason: `${tag} is not atomically translatable (fail-closed)` }
    }
    return { ok: false, reason: `${tag || 'node'} is not a translatable leaf (fail-closed)` }
  } catch {
    return { ok: false, reason: 'leaf eligibility probe failed (fail-closed)' }
  }
}

/**
 * True only when `leaf` is a rendered descendant of `unitRoot` (parent chain
 * reaches exactly `unitRoot` through rendered containers, never through a
 * `defs`-family companion). Pure read; never mutates. Stale/detached leaves
 * (removed, reparented, or rehomed under `defs` by an edit/Undo) report
 * `false` so the caller drops the plan instead of moving the wrong node.
 */
export function isLeafAttachedToUnit(unitRoot: Element, leaf: Element): boolean {
  try {
    if (!leafTranslateIsElement(unitRoot) || !leafTranslateIsElement(leaf)) return false
    if (unitRoot === (leaf as unknown as object)) return false
    if (leafTranslateTagOf(unitRoot) !== 'g') return false
    let node: Element | null = leaf
    // Walk up: every hop must be a rendered container until unitRoot.
    while (node !== null && node !== (unitRoot as unknown as object)) {
      const parent: Element | null = (node as Element).parentElement ?? null
      if (parent === null) return false
      const parentTag = leafTranslateTagOf(parent)
      if (LEAF_TRANSLATE_NON_RENDERING_TAGS.has(parentTag)) return false
      if (parent === (unitRoot as unknown as object)) return true
      if (!LEAF_TRANSLATE_RENDERED_CONTAINERS.has(parentTag)) return false
      node = parent
    }
    return node === (unitRoot as unknown as object)
  } catch {
    return false
  }
}

function leafTranslateFormatComponent(value: number): string {
  if (Object.is(value, -0)) return '0'
  return String(value)
}

/**
 * Plan a whole-leaf translate: map the requested *document* delta into the
 * leaf-parent (ancestor) frame and render the replacement `transform`.
 *
 * Inputs are all reads: `unitRoot` (the `<g>` unit), `leaf` (the child to
 * move), `unitWorld` (the unit root's world matrix — unit-own composed with
 * document ancestors above it; `undefined` means identity), and the document
 * delta. The plan prepends `translate(ax ay)` to the leaf's existing
 * transform, so siblings, paint references, Z-order and child order survive
 * untouched, and the leaf's own (possibly singular) matrix never needs
 * inverting.
 *
 * Fail-closed (`ok: false`, reason contains `fail-closed`) when: non-element
 * inputs, non-`g` unit, leaf not attached via a rendered path, `text`-group
 * markers, clip/mask on the leaf/wrappers/unit/ancestors, defs-homed paths,
 * ineligible leaf kinds (see `classifyLeafElementForTranslate`), non-finite
 * or zero document deltas, non-finite/singular ancestor matrices, or a
 * non-finite ancestor delta. No-op deltas are refused so wiring them to a
 * history commit can never mint an empty entry.
 */
export function planLeafDocumentTranslate(
  unitRoot: Element,
  leaf: Element,
  unitWorld: VectorLeafTranslateMatrix | undefined,
  documentDelta: VectorLeafTranslateDelta,
): LeafTranslatePlan {
  try {
    if (!leafTranslateIsElement(unitRoot)) return { ok: false, reason: 'not a group unit (fail-closed)' }
    if (!leafTranslateIsElement(leaf)) return { ok: false, reason: 'not a leaf element (fail-closed)' }
    if (leafTranslateTagOf(unitRoot) !== 'g') return { ok: false, reason: 'not a group unit (fail-closed)' }
    if ((unitRoot as unknown as object) === (leaf as unknown as object)) {
      return { ok: false, reason: 'unit root is not a leaf (fail-closed)' }
    }
    const dx = (documentDelta as VectorLeafTranslateDelta | undefined)?.dx
    const dy = (documentDelta as VectorLeafTranslateDelta | undefined)?.dy
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return { ok: false, reason: 'document delta is non-finite (fail-closed)' }
    }
    if (dx === 0 && dy === 0) {
      return { ok: false, reason: 'no-op delta writes no history (fail-closed)' }
    }
    const eligibility = classifyLeafElementForTranslate(leaf)
    if (!eligibility.ok) return eligibility

    // Text-group markers (Paper text items) are never leaf-translated.
    try {
      if (unitRoot.hasAttribute?.('data-is-pg-text-item')) {
        return { ok: false, reason: 'text group is not leaf-editable (fail-closed)' }
      }
    } catch {
      return { ok: false, reason: 'text group check failed (fail-closed)' }
    }

    // Clip/mask on the unit root itself fails closed.
    if (leafTranslateHasBlockingStyle(unitRoot)) {
      return { ok: false, reason: 'clip/mask on group (fail-closed)' }
    }
    // Clip/mask above the unit would misplace the whole frame: fail closed.
    try {
      let node: Element | null = unitRoot.parentElement
      while (node !== null && leafTranslateTagOf(node) !== 'svg') {
        if (leafTranslateHasBlockingStyle(node)) {
          return { ok: false, reason: 'clip/mask above group (fail-closed)' }
        }
        if (LEAF_TRANSLATE_NON_RENDERING_TAGS.has(leafTranslateTagOf(node))) {
          return { ok: false, reason: 'group inside defs (fail-closed)' }
        }
        node = node.parentElement
      }
    } catch {
      return { ok: false, reason: 'ancestor clip check failed (fail-closed)' }
    }

    // Walk leaf -> unitRoot through rendered containers, collecting wrapper
    // transforms (unitRoot exclusive, leaf-own exclusive) and refusing
    // defs-homed or clipped paths.
    const chain: VectorLeafTranslateMatrix[] = []
    try {
      let node: Element | null = leaf
      while (true) {
        const parent: Element | null = node?.parentElement ?? null
        if (parent === null) {
          return { ok: false, reason: 'leaf is detached from the unit (fail-closed)' }
        }
        if (LEAF_TRANSLATE_NON_RENDERING_TAGS.has(leafTranslateTagOf(parent))) {
          return { ok: false, reason: 'leaf inside defs (fail-closed)' }
        }
        if (parent === (unitRoot as unknown as object)) break
        const parentTag = leafTranslateTagOf(parent)
        if (!LEAF_TRANSLATE_RENDERED_CONTAINERS.has(parentTag)) {
          return { ok: false, reason: 'leaf is not in a rendered path (fail-closed)' }
        }
        if (leafTranslateHasBlockingStyle(parent)) {
          return { ok: false, reason: 'clip/mask on wrapper (fail-closed)' }
        }
        try {
          if (parent.hasAttribute?.('data-is-pg-text-item')) {
            return { ok: false, reason: 'text group is not leaf-editable (fail-closed)' }
          }
        } catch {
          return { ok: false, reason: 'text group check failed (fail-closed)' }
        }
        // Any rendered container may carry a `transform` in SVG; compose it.
        // (This intentionally hardens `collectGroupLeafDescriptors`, which
        // only folds `<g>` levels: an `a`/`switch`/`svg` wrapper with its own
        // transform would otherwise be silently dropped from the frame.)
        try {
          chain.unshift(parseLeafTranslateTransform(parent.getAttribute?.('transform')))
        } catch {
          return { ok: false, reason: 'wrapper transform unreadable (fail-closed)' }
        }
        node = parent
      }
    } catch {
      return { ok: false, reason: 'leaf attachment probe failed (fail-closed)' }
    }

    // Compose the ancestor frame: unitWorld (unit-own + above) then wrappers.
    let ancestors: VectorLeafTranslateMatrix = [...LEAF_TRANSLATE_IDENTITY] as VectorLeafTranslateMatrix
    try {
      if (unitWorld !== undefined) {
        if (unitWorld.length < 6) return { ok: false, reason: 'unit world matrix is malformed (fail-closed)' }
        for (let index = 0; index < 6; index++) {
          if (!Number.isFinite(unitWorld[index])) {
            return { ok: false, reason: 'unit world matrix is non-finite (fail-closed)' }
          }
        }
        ancestors = multiplyLeafTranslateMatrices(
          [unitWorld[0]!, unitWorld[1]!, unitWorld[2]!, unitWorld[3]!, unitWorld[4]!, unitWorld[5]!],
          ancestors,
        )
      }
      for (const local of chain) {
        ancestors = multiplyLeafTranslateMatrices(ancestors, local)
      }
    } catch {
      return { ok: false, reason: 'ancestor composition failed (fail-closed)' }
    }

    // Deltas are vectors: only the linear part matters, but singularity is
    // still fatal (a collapsed frame cannot place the translation).
    const inverse = tryInvertLeafTranslateMatrix(ancestors)
    if (!inverse) {
      return { ok: false, reason: 'singular ancestor matrix (fail-closed)' }
    }
    const ancestorDelta = {
      dx: inverse[0]! * dx! + inverse[2]! * dy!,
      dy: inverse[1]! * dx! + inverse[3]! * dy!,
    }
    if (!Number.isFinite(ancestorDelta.dx) || !Number.isFinite(ancestorDelta.dy)) {
      return { ok: false, reason: 'ancestor delta is non-finite (fail-closed)' }
    }
    if (ancestorDelta.dx === 0 && ancestorDelta.dy === 0) {
      return { ok: false, reason: 'no-op delta writes no history (fail-closed)' }
    }

    let oldTransform = ''
    try {
      oldTransform = (leaf.getAttribute?.('transform') ?? '').trim()
    } catch {
      return { ok: false, reason: 'leaf transform unreadable (fail-closed)' }
    }
    const prefix = `translate(${leafTranslateFormatComponent(ancestorDelta.dx)} ${leafTranslateFormatComponent(ancestorDelta.dy)})`
    const newTransform = oldTransform === '' ? prefix : `${prefix} ${oldTransform}`

    return {
      ok: true,
      leafTag: leafTranslateTagOf(leaf),
      ancestorDelta,
      documentDelta: { dx: dx!, dy: dy! },
      oldTransform,
      newTransform,
      warnings: [...eligibility.warnings],
    }
  } catch {
    return { ok: false, reason: 'leaf translate plan failed (fail-closed)' }
  }
}
