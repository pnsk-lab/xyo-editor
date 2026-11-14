import type { VectorObjectInfo, VectorPathPointInfo } from '../../lib/editor-types'
import { readVectorTextElementContent } from './vector-text'
import { vectorStrokeSvgToUi, vectorTextUiForSvgElement } from './vector-stroke-scale'

export type VectorNumericField = 'x' | 'y' | 'width' | 'height'

/**
 * Toolbar UI width for a stored SVG width (non-text `*2`, text `*2` on a
 * simple scale-1 chain else verbatim protection for `scale(0.5)`/complex).
 */
function vectorListUiWidth(svgWidth: number | undefined, tag: string, element?: Element): number | undefined {
  if (svgWidth === undefined || !Number.isFinite(svgWidth)) return undefined;
  if (!(svgWidth > 0)) return 0;
  if (tag === 'text') return vectorTextUiForSvgElement(svgWidth, element);
  return vectorStrokeSvgToUi(svgWidth);
}

export function vectorObjectList(svgText: string): VectorObjectInfo[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName.toLowerCase() !== 'svg') return []
  return editableVectorUnits(svg).map((element, index) => {
    const bounds = vectorObjectBounds(element)
    const tag = element.tagName.toLowerCase()
    return {
      index,
      tag,
      label: vectorObjectLabel(element, index),
      fill: element.getAttribute('fill') ?? undefined,
      stroke: element.getAttribute('stroke') ?? undefined,
      // Scratch parity: the toolbar shows UI (Paper) units, not stored SVG.
      // Imported `stroke-width="5"` lists as UI `10` (text `*2` on a simple
      // chain, verbatim protection under `scale(0.5)`/complex); a missing
      // attribute stays `undefined` so the toolbar falls back to the global.
      strokeWidth: vectorListUiWidth(optionalSvgNumber(element.getAttribute('stroke-width')), tag, element),
      opacity: optionalSvgNumber(element.getAttribute('opacity')) ?? 1,
      rotation: vectorObjectRotation(element),
      ...vectorObjectGeometry(element),
      boundsX: bounds.x,
      boundsY: bounds.y,
      boundsWidth: bounds.width,
      boundsHeight: bounds.height,
      points: vectorEditablePoints(element),
      text: tag === 'text' ? (readVectorTextElementContent(element) ?? '') : undefined,
    }
  })
}

export function editableSvgChildren(svg: Element) {
  return Array.from(svg.children).filter((element) => !['defs', 'metadata', 'title', 'desc'].includes(element.tagName.toLowerCase()))
}

// Selectable units mirroring scratch-paint's import normalization
// (`initializeSvg` + `ungroupItems` + `reduce` in scratch-paint): single-child
// `<g>` wrapper chains are transparent, and the children of the first
// multi-child group (or the single non-group node) are the selectable items.
// This is why clicking the cat's face selects the head group, not the whole cat.
//
// Explicit-group identity (`class="... xyo-vector-explicit-group ..."`):
// `<g>` nodes created by the editor's Group action carry this inert class
// token so a group covering every top-level object stays selectable as one
// unit instead of being unwrapped like an import wrapper. Import wrappers
// never carry the token, so existing single-wrapper normalization is
// unchanged. Only the exact token counts (other classes coexist); a forged
// token only affects selection granularity. The token is inert (no
// URL/fetch/script surface, no stylesheet in sanitized costumes) and both
// sanitizers preserve `class` (editor `sanitizeSvgForDisplay` and the VM
// `sanitizeSvgText` persistence boundary, which strips all `data-*`), so
// save/reload, undo/redo history (plain SVG strings), copy/paste
// (`outerHTML` + fragment sanitizer) and duplicate (`cloneNode`) keep the
// identity without extra stores. Paper.js round-trips re-attach it from the
// source node (see `paper-vector.ts`), so resize/rotate round-trips never
// silently drop grouping. The style resolver (`vector-selection-style.ts`)
// exempts exactly this token from its fail-closed `class` rule, so explicit
// groups never force MIXED paint.
//
// Ghost-selection guard (blank-canvas 8px outline): empty `<g>` wrappers
// (no drawing descendants: empty, `<title>`-only, future-data placeholders)
// and explicit non-rendering companions (`clipPath`/`mask` alongside `defs`)
// are filtered from selection only. The DOM is never mutated here, ancestor
// transforms and document order are preserved, and transparent /
// hidden-but-restylable leaves, `<use>`/`<image>` references and zero-area
// strokes stay selectable.
const nonRenderingVectorTags = new Set([
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

function hasRenderableVectorDrawing(root: Element): boolean {
  const stack: Element[] = Array.from(root.children) as Element[]
  while (stack.length > 0) {
    const current = stack.pop()!
    const tag = current.tagName.toLowerCase()
    if (nonRenderingVectorTags.has(tag)) continue
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      for (const child of Array.from(current.children)) stack.push(child as Element)
      continue
    }
    // Any other element (rect/circle/ellipse/line/path/polygon/polyline/text/
    // image/use/...) is a potentially renderable drawing node. Keep it even
    // when its local bounds are zero-area, it is transparent
    // (`opacity="0"`), hidden (`display:none`/`visibility:hidden`), or has a
    // zero-width stroke: it can be restyled into view and `<use>`/`<image>`
    // render through their referenced content.
    return true
  }
  return false
}

export const EXPLICIT_VECTOR_GROUP_CLASS = 'xyo-vector-explicit-group'

function vectorGroupClassTokens(element: Element): string[] {
  try {
    const raw = element.getAttribute('class') ?? ''
    return raw.split(/[\s\u0000-\u0020]+/).filter((token) => token.length > 0)
  } catch {
    return []
  }
}

export function isExplicitVectorGroup(element: Element): boolean {
  try {
    return element.tagName.toLowerCase() === 'g' && vectorGroupClassTokens(element).includes(EXPLICIT_VECTOR_GROUP_CLASS)
  } catch {
    return false
  }
}

export function markExplicitVectorGroup(group: Element): void {
  try {
    const tokens = vectorGroupClassTokens(group)
    if (!tokens.includes(EXPLICIT_VECTOR_GROUP_CLASS)) {
      tokens.push(EXPLICIT_VECTOR_GROUP_CLASS)
      group.setAttribute('class', tokens.join(' '))
    }
  } catch {
    // Best effort: grouping still works, only the full-coverage identity is lost.
  }
}

function isSelectableVectorUnit(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (nonRenderingVectorTags.has(tag)) return false
  if (tag !== 'g') return true
  return hasRenderableVectorDrawing(element)
}

export function editableVectorUnits(svg: Element): Element[] {
  let nodes = editableSvgChildren(svg)
  while (nodes.length === 1 && nodes[0]!.tagName.toLowerCase() === 'g') {
    const sole = nodes[0]!
    // An explicit group keeps its identity even when it covers every
    // top-level object (or has collapsed to a single child): return the group
    // itself instead of unwrapping it like an import wrapper. Empty explicit
    // groups stay filtered (ghost guard) via `isSelectableVectorUnit`.
    if (isExplicitVectorGroup(sole)) return isSelectableVectorUnit(sole) ? [sole] : []
    const kids = editableSvgChildren(sole)
    if (kids.length === 0) return []
    if (kids.length === 1) {
      nodes = kids
      continue
    }
    return kids.filter(isSelectableVectorUnit)
  }
  return nodes.filter(isSelectableVectorUnit)
}

// Inheritable presentation attributes that change Paper.js hit testing.
// Paper.js decides fill hits from the effective fill, so a unit that inherits
// its paint from wrapper groups must carry those values into a standalone
// import; otherwise filled areas would only hit via their stroke.
const inheritedVectorPaintAttributes = [
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
]

function isVectorHidden(element: Element): boolean {
  const display = element.getAttribute('display') ?? /display\s*:\s*([^;]+)/.exec(element.getAttribute('style') ?? '')?.[1]
  if (display?.trim().toLowerCase() === 'none') return true
  const visibility = element.getAttribute('visibility') ?? /visibility\s*:\s*([^;]+)/.exec(element.getAttribute('style') ?? '')?.[1]
  const mode = visibility?.trim().toLowerCase()
  return mode === 'hidden' || mode === 'collapse'
}

// Build a detached clone of a selectable unit that renders (and hit-tests)
// exactly as it does in the full document: ancestor transforms are composed
// into its own transform string, and inherited paint is pushed down onto it.
// Clicks and marquees arrive in document coordinates, while nested units live
// in their local coordinates, so Paper.js must import this baked form.
// Returns undefined when the unit is not under the given svg root or is
// hidden (display:none / visibility hidden), in which case callers fall back
// to a plain import.
export function bakedUnitClone(svg: Element, unit: Element): Element | undefined {
  try {
    if (unit === svg) return unit.cloneNode(true) as Element
    const chain: Element[] = []
    let node: Element | null = unit
    while (node && node !== svg) {
      chain.unshift(node)
      node = node.parentElement
    }
    if (node !== svg) return undefined
    // Effective visibility: hidden ancestors hide the unit unless the unit
    // (or an intermediate group) re-shows its subtree with visibility:visible.
    let hidden: string | undefined
    let explicitlyShown = false
    for (let index = chain.length - 1; index >= 0; index--) {
      const link = chain[index]!
      const visibility = link.getAttribute('visibility') ?? /visibility\s*:\s*([^;]+)/.exec(link.getAttribute('style') ?? '')?.[1]?.trim().toLowerCase()
      if (visibility === 'visible') {
        explicitlyShown = true
        break
      }
      if ((visibility === 'hidden' || visibility === 'collapse') && hidden === undefined) hidden = visibility
    }
    const displayHidden = chain.some((link) => {
      const display = link.getAttribute('display') ?? /display\s*:\s*([^;]+)/.exec(link.getAttribute('style') ?? '')?.[1]?.trim().toLowerCase()
      return display === 'none'
    })
    if (displayHidden || (hidden !== undefined && !explicitlyShown)) return undefined
    const clone = unit.cloneNode(true) as Element
    let outer = ''
    for (const link of chain.slice(0, -1)) outer = combineSvgTransforms(outer, link.getAttribute('transform') ?? '')
    if (outer) {
      const own = clone.getAttribute('transform') ?? ''
      clone.setAttribute('transform', combineSvgTransforms(outer, own))
    }
    const inherited: Record<string, string> = {}
    for (const link of [svg, ...chain.slice(0, -1)]) {
      for (const name of inheritedVectorPaintAttributes) {
        const value = link.getAttribute(name)
        if (value !== null) inherited[name] = value
      }
    }
    for (const [name, value] of Object.entries(inherited)) {
      if (clone.getAttribute(name) === null) clone.setAttribute(name, value)
    }
    return clone
  } catch {
    return undefined
  }
}

// Combine an outer (group) transform with an inner (child) transform so the
// child keeps its on-screen geometry after being moved out of the group.
// Nested `<g transform="outer"><child transform="inner"/></g>` is equivalent
// to `<child transform="outer inner"/>`, so string concatenation preserves the
// composition without precision loss from matrix serialization.
export function combineSvgTransforms(outer: string, inner: string) {
  const normalizedOuter = outer.trim()
  const normalizedInner = inner.trim()
  if (!normalizedOuter) return normalizedInner
  if (!normalizedInner) return normalizedOuter
  return `${normalizedOuter} ${normalizedInner}`
}

// Ungroup the selected `<g>` units wherever they live in the document.
// Mirrors `ungroupItems`/`_ungroupLoop` in scratch-paint (`packages/scratch-paint/src/helper/group.js`):
// children are moved out in place (just below the group within its parent),
// the group transform is baked into each moved child via composition,
// single-child subgroups are reduced (dissolved) first, and empty groups are
// removed. Text-tool groups (`data-is-pg-text-item`) are left untouched,
// matching the `isPGTextItem` guard.
export function ungroupVectorElements(svg: Element, indices: number[]): Element[] {
  const units = editableVectorUnits(svg)
  const groups = [...new Set(indices)]
    .map((index) => units[index])
    .filter((element): element is Element => element?.tagName.toLowerCase() === 'g' && !element.hasAttribute('data-is-pg-text-item'))
  const ungrouped: Element[] = []
  for (const group of groups) {
    // Use parentNode (not parentElement) so lightweight test doubles work too.
    const parent = group.parentNode as Element | null
    if (!parent || typeof parent.insertBefore !== 'function') continue
    const outerTransform = group.getAttribute('transform') ?? ''
    const directChildren = Array.from(group.children) as Element[]
    for (const child of directChildren) {
      let outgoing = child
      // Match scratch-paint's `reduce()` for single-child subgroups: dissolve
      // the intermediate group so its only child moves out directly.
      if (outgoing.tagName.toLowerCase() === 'g' && outgoing.children.length === 1) {
        const onlyChild = outgoing.children[0] as Element
        const collapsed = combineSvgTransforms(outgoing.getAttribute('transform') ?? '', onlyChild.getAttribute('transform') ?? '')
        onlyChild.remove()
        outgoing.remove()
        outgoing = onlyChild
        if (collapsed) outgoing.setAttribute('transform', collapsed)
        else outgoing.removeAttribute('transform')
      }
      const composed = combineSvgTransforms(outerTransform, outgoing.getAttribute('transform') ?? '')
      if (composed) outgoing.setAttribute('transform', composed)
      else outgoing.removeAttribute('transform')
      parent.insertBefore(outgoing, group)
      ungrouped.push(outgoing)
    }
    group.remove()
  }
  return ungrouped
}

export function addTranslate(element: Element, dx: number, dy: number) {
  // Identity translates paint no pixels but pollute the DOM (`transform=
  // "translate(0 0)"`) and break paint-preserve byte comparisons (a
  // characters-only text edit must keep `transform` identical). Skip them so
  // centering/reload stays a same-value no-op with no history entry.
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return
  const transform = element.getAttribute('transform') ?? ''
  const match = /translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(transform)
  if (match) {
    const x = Number(match[1]) + dx
    const y = Number(match[2]) + dy
    element.setAttribute('transform', transform.replace(match[0], `translate(${x} ${y})`))
  } else {
    element.setAttribute('transform', `${transform} translate(${dx} ${dy})`.trim())
  }
}

export function vectorObjectRotation(element: Element) {
  const match = /rotate\(([-\d.]+)/.exec(element.getAttribute('transform') ?? '')
  const degrees = match ? Number(match[1]) : 0
  return Number.isFinite(degrees) ? degrees : 0
}

export function setVectorRotation(element: Element, degrees: number): boolean {
  if (!Number.isFinite(degrees)) return false
  // Invisible-edit guard (mirrors addVectorFlip / moveVectorEditablePoint):
  // under a singular world CTM the leaf renders collapsed, so rewriting the
  // leaf-local rotate() would pollute Undo with no visible change. Refuse
  // with no DOM write; the caller skips history (updateVectorObject treats
  // false as no-op). Near-singular but invertible stays editable by design.
  const world = worldTransformMatrix(element)
  if (world && !tryInvertVectorMatrix(world)) return false
  const current = vectorObjectRotation(element)
  if (Math.abs(current - degrees) < 1e-9) return false
  const transform = element.getAttribute('transform') ?? ''
  const next = /rotate\([^)]+\)/.test(transform)
    ? transform.replace(/rotate\([^)]+\)/, `rotate(${degrees})`)
    : `${transform} rotate(${degrees})`.trim()
  if (next === transform) return false
  element.setAttribute('transform', next)
  return true
}

export function addVectorFlip(element: Element, horizontal: boolean): boolean {
  const center = vectorObjectCenter(element)
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return false
  const matrix = worldTransformMatrix(element)
  let local = center
  if (matrix) {
    const inverse = tryInvertVectorMatrix(matrix)
    // Singular / non-finite CTM: the document-space center has no unique
    // leaf-local preimage. Refuse with no DOM write (no history entry);
    // identity fallback would bake a bogus translate that teleports the leaf
    // when the ancestor is later repaired.
    if (!inverse) return false
    local = transformVectorPoint(inverse, center.x, center.y)
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return false
  }
  const transform = element.getAttribute('transform') ?? ''
  const flip = horizontal
    ? `translate(${local.x * 2} 0) scale(-1 1)`
    : `translate(0 ${local.y * 2}) scale(1 -1)`
  element.setAttribute('transform', `${flip} ${transform}`.trim())
  return true
}

export function vectorObjectBounds(element: Element) {
  const local = localVectorObjectBounds(element)
  const ancestors = ancestorWorldMatrix(element)
  return ancestors ? applyMatrixToBounds(ancestors, local) : local
}

/**
 * Real local bounds for `userSpaceOnUse` gradients (parent user space).
 * Raw geometry plus the element's own `transform`, ancestors excluded, so a
 * `userSpaceOnUse` ramp defined with these coordinates rides ancestor
 * transforms rigidly with the shape. For groups, the union of children's
 * local bounds. Degenerate shapes keep zero spans (callers clamp the radial
 * radius); never throws.
 */
export function localVectorGradientBounds(element: Element) {
  try {
    return localVectorObjectBounds(element)
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
}

/**
 * Convert a document-space click point into the element's parent user space
 * (inverse ancestor transforms) for click-centered radial gradients. The
 * element's own transform stays baked into the bounds, so only ancestors are
 * inverted here. Falls back to the input point when no ancestor transform
 * exists or inversion fails.
 */
export function documentPointToLocalGradientPoint(
  element: Element,
  point: { x: number; y: number },
): { x: number; y: number } {
  try {
    const ancestors = ancestorWorldMatrix(element)
    if (!ancestors) return { x: point.x, y: point.y }
    const inverse = tryInvertVectorMatrix(ancestors)
    if (!inverse) return { x: point.x, y: point.y }
    const local = transformVectorPoint(inverse, point.x, point.y)
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return { x: point.x, y: point.y }
    return { x: local.x, y: local.y }
  } catch {
    return { x: point.x, y: point.y }
  }
}

/**
 * True for vector `<text>` units that render right-anchored: the editor
 * writes RTL blocks as `text-anchor="start" direction="rtl"` (inline-start
 * is the right edge under RTL), so the visible ink extends LEFT from x.
 * LTR/CJK units (`text-anchor="middle"`, no direction) keep the historical
 * centered geometry. Checks only the element's own `direction` attribute
 * (case-insensitive); inherited/document direction does not change the
 * saved geometry, only the overlay draft.
 */
export function isRtlVectorTextElement(element: Element): boolean {
  try {
    if (element.tagName.toLowerCase() !== 'text') return false
    const direction = element.getAttribute('direction')?.trim().toLowerCase()
    return direction === 'rtl'
  } catch {
    return false
  }
}

function localVectorObjectBounds(element: Element) {
  return applyElementTransform(element, rawVectorObjectBounds(element))
}

function rawVectorObjectBounds(element: Element) {
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name)) ?? 0
  if (tag === 'rect' || tag === 'image') {
    return { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
  }
  if (tag === 'ellipse') {
    const rx = number('rx')
    const ry = number('ry')
    return { x: number('cx') - rx, y: number('cy') - ry, width: rx * 2, height: ry * 2 }
  }
  if (tag === 'circle') {
    const r = number('r')
    return { x: number('cx') - r, y: number('cy') - r, width: r * 2, height: r * 2 }
  }
  if (tag === 'line') {
    const x1 = optionalSvgNumber(element.getAttribute('x1'))
    const y1 = optionalSvgNumber(element.getAttribute('y1'))
    const x2 = optionalSvgNumber(element.getAttribute('x2'))
    const y2 = optionalSvgNumber(element.getAttribute('y2'))
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
    }
  }
  if (tag === 'text') {
    const fontSize = optionalSvgNumber(element.getAttribute('font-size')) ?? 24
    const lines = (readVectorTextElementContent(element) ?? element.textContent ?? '').split('\n')
    const maxLength = lines.reduce((max, line) => Math.max(max, line.length), 0)
    const lineCount = Math.max(1, lines.length)
    const width = Math.max(fontSize, maxLength * fontSize * 0.55)
    // RTL blocks (`direction="rtl"` + `text-anchor="start"`) render with
    // their right edge at x (inline-start is the right edge under RTL), so
    // the estimated box extends LEFT from x. LTR keeps the historical
    // centered estimate byte-for-byte.
    if (isRtlVectorTextElement(element)) {
      return { x: number('x') - width, y: number('y') - fontSize, width, height: fontSize * 1.25 * lineCount }
    }
    return { x: number('x') - maxLength * fontSize * 0.25, y: number('y') - fontSize, width, height: fontSize * 1.25 * lineCount }
  }
  if (tag === 'path' || tag === 'polygon' || tag === 'polyline') {
    const points = tag === 'path'
      ? pathEditablePoints(element.getAttribute('d') ?? '')
      : coordinatePairs(element.getAttribute('points') ?? '')
    if (points.length > 0) {
      const left = Math.min(...points.map((point) => point.x))
      const top = Math.min(...points.map((point) => point.y))
      const right = Math.max(...points.map((point) => point.x))
      const bottom = Math.max(...points.map((point) => point.y))
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  const childBounds = Array.from(element.children).map(localVectorObjectBounds).filter((bound) => bound.width || bound.height)
  if (childBounds.length > 0) {
    const left = Math.min(...childBounds.map((bound) => bound.x))
    const top = Math.min(...childBounds.map((bound) => bound.y))
    const right = Math.max(...childBounds.map((bound) => bound.x + bound.width))
    const bottom = Math.max(...childBounds.map((bound) => bound.y + bound.height))
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  return { x: 0, y: 0, width: 0, height: 0 }
}

type VectorBounds = { x: number; y: number; width: number; height: number }
export type VectorMatrix = [number, number, number, number, number, number]

function applyElementTransform(element: Element, bounds: VectorBounds): VectorBounds {
  const matrix = transformMatrix(element.getAttribute('transform') ?? '')
  if (!matrix) return bounds
  return applyMatrixToBounds(matrix, bounds)
}

function applyMatrixToBounds(matrix: VectorMatrix, bounds: VectorBounds): VectorBounds {
  const corners = [
    transformVectorPoint(matrix, bounds.x, bounds.y),
    transformVectorPoint(matrix, bounds.x + bounds.width, bounds.y),
    transformVectorPoint(matrix, bounds.x + bounds.width, bounds.y + bounds.height),
    transformVectorPoint(matrix, bounds.x, bounds.y + bounds.height),
  ]
  const left = Math.min(...corners.map((point) => point.x))
  const top = Math.min(...corners.map((point) => point.y))
  const right = Math.max(...corners.map((point) => point.x))
  const bottom = Math.max(...corners.map((point) => point.y))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// Compose the transforms of the ancestors between the svg root and the given
// element (exclusive of both ends). Nested selectable units live in their local
// coordinates while clicks, marquees and overlays use document coordinates,
// so both directions need this mapping. Returns undefined when no ancestor
// carries a transform, letting callers skip the conversion.
export function ancestorWorldMatrix(unit: Element, stopAt?: Element | null): VectorMatrix | undefined {
  const chain: Element[] = []
  let node = unit.parentElement
  while (node && node !== stopAt && node.nodeName.toLowerCase() !== 'svg') {
    chain.unshift(node)
    node = node.parentElement
  }
  let matrix: VectorMatrix | undefined
  for (const ancestor of chain) {
    const local = transformMatrix(ancestor.getAttribute('transform') ?? '')
    if (!local) continue
    matrix = matrix ? multiplyMatrix(matrix, local) : local
  }
  return matrix
}

// Compose the full document-space transform of an element (ancestors first,
// then its own transform). Returns undefined when nothing transforms it.
export function worldTransformMatrix(element: Element, stopAt?: Element | null): VectorMatrix | undefined {
  const ancestors = ancestorWorldMatrix(element, stopAt)
  const own = transformMatrix(element.getAttribute('transform') ?? '')
  if (!ancestors) return own
  return own ? multiplyMatrix(ancestors, own) : ancestors
}

// SVG transform-list parser (SVG 1.1 section 7.6 / SVG2 transform presentation
// attribute): `matrix(a b c d e f)`, `translate(tx [ty])`, `scale(sx [sy])`,
// `rotate(angle [cx cy])`, `skewX(angle)`, `skewY(angle)`. Angles are degrees.
// Operations compose left-to-right (`transform="outer inner"` means the outer
// matrix post-multiplies the inner one, matching nested `<g>` composition),
// which is why the fold below is `multiplyMatrix(accumulated, local)`.
// Numbers follow the SVG number grammar (optional sign, decimal point,
// exponent); anything else in an operation's argument list fails closed by
// skipping just that operation, never corrupting the matrix with NaN.
const svgTransformNumberToken = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

function parseSvgTransformNumbers(args: string): number[] | undefined {
  const trimmed = args.trim()
  if (trimmed === '') return []
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean)
  const values: number[] = []
  for (const token of tokens) {
    if (!svgTransformNumberToken.test(token)) return undefined
    const parsed = Number(token)
    if (!Number.isFinite(parsed)) return undefined
    values.push(parsed)
  }
  return values
}

export function transformMatrix(transform: string): VectorMatrix | undefined {
  const operations = [...transform.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g)]
  if (operations.length === 0) return undefined
  return operations.reduce<VectorMatrix>((matrix, operation) => {
    const type = operation[1]
    const values = parseSvgTransformNumbers(operation[2] ?? '')
    // Malformed argument list: skip this operation (fail-closed), keeping the
    // accumulated matrix and the historical rotate/translate/scale ordering.
    if (!values) return matrix
    if (type === 'matrix') {
      if (values.length < 6) return matrix
      return multiplyMatrix(matrix, values.slice(0, 6) as VectorMatrix)
    }
    if (type === 'translate') {
      if (values.length < 1) return matrix
      const tx = values[0]!
      const ty = values.length >= 2 ? values[1]! : 0
      return multiplyMatrix(matrix, [1, 0, 0, 1, tx, ty])
    }
    if (type === 'scale') {
      if (values.length < 1) return matrix
      const sx = values[0]!
      const sy = values.length >= 2 ? values[1]! : sx
      return multiplyMatrix(matrix, [sx, 0, 0, sy, 0, 0])
    }
    if (type === 'rotate') {
      if (values.length < 1) return matrix
      const radians = (values[0]! * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: VectorMatrix = [cos, sin, -sin, cos, 0, 0]
      if (values.length >= 3) {
        const cx = values[1]!
        const cy = values[2]!
        return multiplyMatrix(matrix, multiplyMatrix([1, 0, 0, 1, cx, cy], multiplyMatrix(rotation, [1, 0, 0, 1, -cx, -cy])))
      }
      return multiplyMatrix(matrix, rotation)
    }
    if (type === 'skewX') {
      if (values.length < 1) return matrix
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) return matrix
      return multiplyMatrix(matrix, [1, 0, tangent, 1, 0, 0])
    }
    if (type === 'skewY') {
      if (values.length < 1) return matrix
      const tangent = Math.tan((values[0]! * Math.PI) / 180)
      if (!Number.isFinite(tangent)) return matrix
      return multiplyMatrix(matrix, [1, tangent, 0, 1, 0, 0])
    }
    return matrix
  }, [1, 0, 0, 1, 0, 0])
}

function multiplyMatrix(left: VectorMatrix, right: VectorMatrix): VectorMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

export function invertVectorMatrix(matrix: VectorMatrix): VectorMatrix {
  const inverted = tryInvertVectorMatrix(matrix)
  // Legacy identity fallback for display-only mappers. DOM-writing callers
  // must branch on `tryInvertVectorMatrix` (null = refuse) instead of using
  // this, otherwise singular ancestors silently bake document coords as
  // leaf-local geometry (teleport on ancestor repair + Undo pollution).
  if (!inverted) return [1, 0, 0, 1, 0, 0]
  return inverted
}

/**
 * Explicit fail-closed inversion for DOM-writing callers.
 * Returns the inverse when `matrix` is safely invertible, otherwise `null`
 * (singular det==0, non-finite entries/determinant, or non-finite inverse
 * from overflow). Callers must treat `null` as "refuse the write with no
 * DOM/history/selection change" and never fall back to identity mapping.
 * Near-singular but invertible matrices (e.g. `scale(1e-12)`, det=1e-24)
 * intentionally return a finite inverse: the edit is representable, only
 * amplified. That amplification is a documented design decision, not a
 * silent fallback.
 */
export function tryInvertVectorMatrix(matrix: VectorMatrix | undefined | null): VectorMatrix | null {
  try {
    if (!matrix || matrix.length < 6) return null
    for (let index = 0; index < 6; index++) {
      if (!Number.isFinite(matrix[index])) return null
    }
    const determinant = matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!
    if (!Number.isFinite(determinant) || determinant === 0) return null
    const inverse: VectorMatrix = [
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

export function transformVectorPoint(matrix: VectorMatrix, x: number, y: number) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }
}

export function optionalSvgNumber(value: string | null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const svgNumberPattern = /[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi

export function vectorEditablePoints(element: Element): VectorPathPointInfo[] {
  const matrix = worldTransformMatrix(element)
  const points = rawVectorEditablePoints(element)
  if (!matrix) return points
  return points.map((point) => ({ ...point, ...transformVectorPoint(matrix, point.x, point.y) }))
}

function rawVectorEditablePoints(element: Element): VectorPathPointInfo[] {
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') {
    const x = optionalSvgNumber(element.getAttribute('x')) ?? 0
    const y = optionalSvgNumber(element.getAttribute('y')) ?? 0
    const width = optionalSvgNumber(element.getAttribute('width')) ?? 0
    const height = optionalSvgNumber(element.getAttribute('height')) ?? 0
    return [
      { index: 0, x, y, kind: 'anchor' },
      { index: 1, x: x + width, y, kind: 'anchor' },
      { index: 2, x: x + width, y: y + height, kind: 'anchor' },
      { index: 3, x, y: y + height, kind: 'anchor' },
    ]
  }
  if (tag === 'ellipse' || tag === 'circle') {
    const cx = optionalSvgNumber(element.getAttribute('cx')) ?? 0
    const cy = optionalSvgNumber(element.getAttribute('cy')) ?? 0
    const rx = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('rx')) ?? 0
    const ry = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('ry')) ?? 0
    return [
      { index: 0, x: cx - rx, y: cy, kind: 'anchor' },
      { index: 1, x: cx, y: cy - ry, kind: 'anchor' },
      { index: 2, x: cx + rx, y: cy, kind: 'anchor' },
      { index: 3, x: cx, y: cy + ry, kind: 'anchor' },
    ]
  }
  if (tag === 'line') {
    const x1 = optionalSvgNumber(element.getAttribute('x1'))
    const y1 = optionalSvgNumber(element.getAttribute('y1'))
    const x2 = optionalSvgNumber(element.getAttribute('x2'))
    const y2 = optionalSvgNumber(element.getAttribute('y2'))
    return [x1 !== undefined && y1 !== undefined ? { index: 0, x: x1, y: y1 } : undefined, x2 !== undefined && y2 !== undefined ? { index: 1, x: x2, y: y2 } : undefined].filter((point): point is VectorPathPointInfo => Boolean(point))
  }
  if (tag === 'polyline' || tag === 'polygon') return coordinatePairs(element.getAttribute('points') ?? '')
  if (tag !== 'path') return []
  return pathEditablePoints(element.getAttribute('d') ?? '')
}

export function moveVectorEditablePoint(element: Element, pointIndex: number, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const matrix = worldTransformMatrix(element)
  if (matrix) {
    const inverse = tryInvertVectorMatrix(matrix)
    // Singular / non-finite CTM (collapsed ancestor, overflow, NaN): the
    // document point has no unique leaf-local preimage. Refuse with no DOM
    // write so Undo stays clean; identity fallback would bake document
    // coords as local geometry and teleport the leaf on ancestor repair.
    // Transform-free zero-area shapes have no matrix and stay editable.
    if (!inverse) return false
    const local = transformVectorPoint(inverse, x, y)
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return false
    x = local.x
    y = local.y
  }
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') {
    moveRectEditablePoint(element, pointIndex, x, y)
    return true
  }
  if (tag === 'ellipse' || tag === 'circle') {
    moveEllipseEditablePoint(element, pointIndex, x, y)
    return true
  }
  if (tag === 'line') {
    if (pointIndex === 0) {
      element.setAttribute('x1', String(x))
      element.setAttribute('y1', String(y))
    } else if (pointIndex === 1) {
      element.setAttribute('x2', String(x))
      element.setAttribute('y2', String(y))
    }
    return true
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const value = element.getAttribute('points') ?? ''
    const next = replaceCoordinatePair(value, pointIndex, x, y)
    element.setAttribute('points', next)
    return true
  }
  if (tag === 'path') {
    const value = element.getAttribute('d') ?? ''
    element.setAttribute('d', replacePathEditablePoint(value, pointIndex, x, y))
    return true
  }
  return true
}

function moveRectEditablePoint(element: Element, pointIndex: number, x: number, y: number) {
  const currentX = optionalSvgNumber(element.getAttribute('x')) ?? 0
  const currentY = optionalSvgNumber(element.getAttribute('y')) ?? 0
  const currentWidth = optionalSvgNumber(element.getAttribute('width')) ?? 0
  const currentHeight = optionalSvgNumber(element.getAttribute('height')) ?? 0
  const left = currentX
  const top = currentY
  const right = currentX + currentWidth
  const bottom = currentY + currentHeight
  const nextLeft = pointIndex === 0 || pointIndex === 3 ? x : left
  const nextRight = pointIndex === 1 || pointIndex === 2 ? x : right
  const nextTop = pointIndex === 0 || pointIndex === 1 ? y : top
  const nextBottom = pointIndex === 2 || pointIndex === 3 ? y : bottom
  const normalizedLeft = Math.min(nextLeft, nextRight)
  const normalizedTop = Math.min(nextTop, nextBottom)
  element.setAttribute('x', formatSvgNumber(normalizedLeft))
  element.setAttribute('y', formatSvgNumber(normalizedTop))
  element.setAttribute('width', formatSvgNumber(Math.max(1, Math.abs(nextRight - nextLeft))))
  element.setAttribute('height', formatSvgNumber(Math.max(1, Math.abs(nextBottom - nextTop))))
}

function moveEllipseEditablePoint(element: Element, pointIndex: number, x: number, y: number) {
  const tag = element.tagName.toLowerCase()
  const cx = optionalSvgNumber(element.getAttribute('cx')) ?? 0
  const cy = optionalSvgNumber(element.getAttribute('cy')) ?? 0
  const rx = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('rx')) ?? 0
  const ry = tag === 'circle' ? optionalSvgNumber(element.getAttribute('r')) ?? 0 : optionalSvgNumber(element.getAttribute('ry')) ?? 0
  const left = cx - rx
  const right = cx + rx
  const top = cy - ry
  const bottom = cy + ry
  const nextLeft = pointIndex === 0 ? x : left
  const nextRight = pointIndex === 2 ? x : right
  const nextTop = pointIndex === 1 ? y : top
  const nextBottom = pointIndex === 3 ? y : bottom
  const nextCx = (nextLeft + nextRight) / 2
  const nextCy = (nextTop + nextBottom) / 2
  const nextRx = Math.max(1, Math.abs(nextRight - nextLeft) / 2)
  const nextRy = Math.max(1, Math.abs(nextBottom - nextTop) / 2)
  element.setAttribute('cx', formatSvgNumber(nextCx))
  element.setAttribute('cy', formatSvgNumber(nextCy))
  if (tag === 'circle') {
    element.setAttribute('r', formatSvgNumber(Math.max(nextRx, nextRy)))
  } else {
    element.setAttribute('rx', formatSvgNumber(nextRx))
    element.setAttribute('ry', formatSvgNumber(nextRy))
  }
}

function coordinatePairs(value: string): VectorPathPointInfo[] {
  const values = [...value.matchAll(svgNumberPattern)].map((match) => Number(match[0])).filter(Number.isFinite)
  const points: VectorPathPointInfo[] = []
  for (let index = 0; index < values.length - 1; index += 2) {
    points.push({ index: index / 2, x: values[index]!, y: values[index + 1]! })
  }
  return points
}

function replaceCoordinatePair(value: string, pointIndex: number, x: number, y: number) {
  const matches = [...value.matchAll(svgNumberPattern)].map((match) => ({ index: match.index ?? 0, text: match[0] }))
  const xMatch = matches[pointIndex * 2]
  const yMatch = matches[pointIndex * 2 + 1]
  if (!xMatch || !yMatch) return value
  const replacements = [
    { start: xMatch.index, end: xMatch.index + xMatch.text.length, value: String(x) },
    { start: yMatch.index, end: yMatch.index + yMatch.text.length, value: String(y) },
  ].sort((left, right) => right.start - left.start)
  let next = value
  for (const replacement of replacements) next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`
  return next
}

type PathNumberToken = { start: number; end: number; value: number }
type PathCommandToken = { command: string; start: number; end: number; numbers: PathNumberToken[] }
type PathPointToken = VectorPathPointInfo & { xToken?: PathNumberToken; yToken?: PathNumberToken; relative?: boolean }

function pathEditablePoints(value: string): VectorPathPointInfo[] {
  return pathPointTokens(value).map(({ xToken, yToken, relative, ...point }) => point)
}

function replacePathEditablePoint(value: string, pointIndex: number, x: number, y: number) {
  const point = pathPointTokens(value).find((item) => item.index === pointIndex)
  if (!point || (!point.xToken && !point.yToken)) return value
  const dx = x - point.x
  const dy = y - point.y
  const replacements = []
  if (point.xToken) {
    const nextX = point.relative ? point.xToken.value + dx : x
    replacements.push({ start: point.xToken.start, end: point.xToken.end, value: formatSvgNumber(nextX) })
  }
  if (point.yToken) {
    const nextY = point.relative ? point.yToken.value + dy : y
    replacements.push({ start: point.yToken.start, end: point.yToken.end, value: formatSvgNumber(nextY) })
  }
  replacements.sort((left, right) => right.start - left.start)
  let next = value
  for (const replacement of replacements) next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`
  return next
}

function pathPointTokens(value: string): PathPointToken[] {
  const commands = pathCommandTokens(value)
  const points: PathPointToken[] = []
  let current = { x: 0, y: 0 }
  let subpathStart = { x: 0, y: 0 }
  let pointIndex = 0
  for (const token of commands) {
    const command = token.command
    const lower = command.toLowerCase()
    const relative = command === lower
    const numbers = token.numbers
    if (lower === 'z') {
      current = { ...subpathStart }
      continue
    }
    const stride = pathCommandStride(lower)
    if (!stride) continue
    for (let offset = 0; offset + stride - 1 < numbers.length; offset += stride) {
      const commandForSegment = lower === 'm' && offset > 0 ? (relative ? 'l' : 'L') : command
      const lowerForSegment = commandForSegment.toLowerCase()
      const segment = numbers.slice(offset, offset + stride)
      const pointForPair = (pairOffset: number, kind: 'anchor' | 'control', relatedAnchorIndex?: number) => {
        const xToken = segment[pairOffset]
        const yToken = segment[pairOffset + 1]
        if (!xToken || !yToken) return undefined
        const point = {
          index: pointIndex++,
          x: relative ? current.x + xToken.value : xToken.value,
          y: relative ? current.y + yToken.value : yToken.value,
          kind,
          pairIndex: pairOffset / 2,
          command: commandForSegment,
          relatedAnchorIndex,
          xToken,
          yToken,
          relative,
        } satisfies PathPointToken
        points.push(point)
        return point
      }
      if (lowerForSegment === 'h') {
        const xToken = segment[0]
        if (xToken) {
          const next = { x: relative ? current.x + xToken.value : xToken.value, y: current.y }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 0, command: commandForSegment, xToken, relative })
          current = next
        }
        continue
      }
      if (lowerForSegment === 'v') {
        const yToken = segment[0]
        if (yToken) {
          const next = { x: current.x, y: relative ? current.y + yToken.value : yToken.value }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 0, command: commandForSegment, yToken, relative })
          current = next
        }
        continue
      }
      if (lowerForSegment === 'c') {
        const anchorIndex = pointIndex + 2
        pointForPair(0, 'control', anchorIndex)
        pointForPair(2, 'control', anchorIndex)
        const anchor = pointForPair(4, 'anchor')
        if (anchor) current = { x: anchor.x, y: anchor.y }
      } else if (lowerForSegment === 's' || lowerForSegment === 'q') {
        const anchorIndex = pointIndex + 1
        pointForPair(0, 'control', anchorIndex)
        const anchor = pointForPair(2, 'anchor')
        if (anchor) current = { x: anchor.x, y: anchor.y }
      } else if (lowerForSegment === 't' || lowerForSegment === 'm' || lowerForSegment === 'l') {
        const anchor = pointForPair(0, 'anchor')
        if (anchor) {
          current = { x: anchor.x, y: anchor.y }
          if (lowerForSegment === 'm') subpathStart = { ...current }
        }
      } else if (lowerForSegment === 'a') {
        const xToken = segment[5]
        const yToken = segment[6]
        if (xToken && yToken) {
          const next = { x: relative ? current.x + xToken.value : xToken.value, y: relative ? current.y + yToken.value : yToken.value }
          points.push({ index: pointIndex++, x: next.x, y: next.y, kind: 'anchor', pairIndex: 2, command: commandForSegment, xToken, yToken, relative })
          current = next
        }
      }
    }
  }
  return points
}

function pathCommandTokens(value: string): PathCommandToken[] {
  const commandMatches = [...value.matchAll(/[a-zA-Z]/g)].map((match) => ({ command: match[0], start: match.index ?? 0 }))
  return commandMatches.map((match, index) => {
    const end = commandMatches[index + 1]?.start ?? value.length
    const body = value.slice(match.start + 1, end)
    const numbers = [...body.matchAll(svgNumberPattern)].map((numberMatch) => {
      const text = numberMatch[0]
      const start = match.start + 1 + (numberMatch.index ?? 0)
      return { start, end: start + text.length, value: Number(text) }
    }).filter((number) => Number.isFinite(number.value))
    return { command: match.command, start: match.start, end, numbers }
  })
}

function pathCommandStride(command: string) {
  if (command === 'm' || command === 'l' || command === 't') return 2
  if (command === 'h' || command === 'v') return 1
  if (command === 's' || command === 'q') return 4
  if (command === 'c') return 6
  if (command === 'a') return 7
  return 0
}

function formatSvgNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

const VECTOR_NUMERIC_EPS = 1e-9

// Axis-aligned ancestors (translate + scale + mirror only, no rotate/skew)
// preserve axis-aligned scaling under conjugation, so a world-width factor
// maps 1:1 to a parent-space factor about the parent top-left. Anything with
// a non-trivial off-diagonal (rotate/skew/matrix) makes an AABB width/height
// ill-defined as a single scale, so W/H there is an explicit no-op (false).
function vectorNumericAxisAligned(matrix: VectorMatrix): boolean {
  return Math.abs(matrix[1]!) < 1e-12 && Math.abs(matrix[2]!) < 1e-12
}

function prependVectorTranslate(element: Element, tx: number, ty: number) {
  // Full-precision (String) deltas: the ancestor-inverse-mapped delta must
  // round-trip exactly, otherwise a skewed/non-uniform mapping leaves a
  // sub-1e-3 residue and the re-input idempotency check (1e-9) would see a
  // phantom difference and append again. Attribute writers above keep their
  // historical String(value) form for the same reason.
  const existing = element.getAttribute('transform') ?? ''
  const next = `translate(${String(tx)} ${String(ty)})${existing ? ` ${existing}` : ''}`
  element.setAttribute('transform', next)
}

function prependVectorScaleAbout(element: Element, px: number, py: number, fx: number, fy: number) {
  const existing = element.getAttribute('transform') ?? ''
  const head = `translate(${String(px)} ${String(py)}) scale(${String(fx)} ${String(fy)}) translate(${String(-px)} ${String(-py)})`
  element.setAttribute('transform', existing ? `${head} ${existing}` : head)
}

// Sidebar X/Y/W/H writer. Semantics are ABSOLUTE in the same coordinates the
// sidebar displays (vectorObjectGeometry + the UI 0/0/100/100 fallbacks), and
// the return value drives history: true = DOM changed (commit one entry),
// false = no-op / refused (caller must skip history so Undo/Redo stay clean).
//
// - rect/image/ellipse/circle/text keep their historical LOCAL attribute
//   coordinates (x/cx/...), set absolutely (never cumulative). Same-value and
//   singular-world inputs return false with no DOM write.
// - Every other tag (path/g/line/polygon/polyline/use/...) is a WORLD-bounds
//   editor (vectorObjectGeometry returns world bounds for them, matching the
//   group unit): X/Y prepend a parent-space translate mapped through the
//   ancestor inverse (exact under any invertible ancestor/own transform),
//   W/H prepend a parent-space scale-about-top-left (exact when ancestors are
//   axis-aligned; skew/rotated ancestors, zero spans and non-positive targets
//   are explicit no-ops). Appending (addTranslate/addScale) would accumulate
//   and drift from the displayed value, so it is NOT used here; those helpers
//   stay untouched for their delta callers (duplicate/paste/centering).
export function setVectorNumericAttribute(element: Element, field: VectorNumericField, value: number): boolean {
  if (!Number.isFinite(value)) return false
  // Fail-closed invisibility guard: under a singular world CTM the leaf
  // renders collapsed, so any local rewrite would be an invisible edit that
  // only pollutes Undo (and teleports on ancestor repair). Covers singular
  // ancestors (scale(0), scale(0 1), rank-1, ...) and singular own frames.
  // Near-singular but invertible (e.g. scale(1e-12)) stays editable by design.
  const world = worldTransformMatrix(element)
  if (world && !tryInvertVectorMatrix(world)) return false
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect' || tag === 'image') {
    const current = optionalSvgNumber(element.getAttribute(field))
    const shown = current ?? (field === 'x' || field === 'y' ? 0 : 100)
    if (Math.abs(shown - value) < VECTOR_NUMERIC_EPS) return false
    if (current !== undefined && Math.abs(current - value) < VECTOR_NUMERIC_EPS) return false
    element.setAttribute(field, String(value))
    return true
  }
  if (tag === 'text') {
    if (field !== 'x' && field !== 'y') return false
    const current = optionalSvgNumber(element.getAttribute(field))
    const shown = current ?? 0
    if (Math.abs(shown - value) < VECTOR_NUMERIC_EPS) return false
    element.setAttribute(field, String(value))
    return true
  }
  if (tag === 'ellipse') {
    if (field === 'x' || field === 'y') {
      const name = field === 'x' ? 'cx' : 'cy'
      const current = optionalSvgNumber(element.getAttribute(name))
      const shown = current ?? 0
      if (Math.abs(shown - value) < VECTOR_NUMERIC_EPS) return false
      element.setAttribute(name, String(value))
      return true
    }
    const name = field === 'width' ? 'rx' : 'ry'
    const next = Math.max(1, value / 2)
    if (!Number.isFinite(next)) return false
    const current = optionalSvgNumber(element.getAttribute(name))
    // Clamp-aware idempotency: W=0 twice must not rewrite rx=1 twice. When
    // the attribute is missing the sidebar shows 100, so an explicit 100 is
    // also a no-op.
    if (current !== undefined) {
      if (Math.abs(current - next) < VECTOR_NUMERIC_EPS) return false
    } else if (Math.abs(100 - value) < VECTOR_NUMERIC_EPS) {
      return false
    }
    element.setAttribute(name, String(next))
    return true
  }
  if (tag === 'circle') {
    if (field === 'x' || field === 'y') {
      const name = field === 'x' ? 'cx' : 'cy'
      const current = optionalSvgNumber(element.getAttribute(name))
      const shown = current ?? 0
      if (Math.abs(shown - value) < VECTOR_NUMERIC_EPS) return false
      element.setAttribute(name, String(value))
      return true
    }
    const next = Math.max(1, value / 2)
    if (!Number.isFinite(next)) return false
    const current = optionalSvgNumber(element.getAttribute('r'))
    if (current !== undefined) {
      if (Math.abs(current - next) < VECTOR_NUMERIC_EPS) return false
    } else if (Math.abs(100 - value) < VECTOR_NUMERIC_EPS) {
      return false
    }
    element.setAttribute('r', String(next))
    return true
  }
  // Bounds editors: absolute WORLD coordinates (matches vectorObjectGeometry
  // for these tags and the group unit).
  const current = vectorObjectBounds(element)
  if (!Number.isFinite(current.x) || !Number.isFinite(current.y) || !Number.isFinite(current.width) || !Number.isFinite(current.height)) return false
  const ancestors = ancestorWorldMatrix(element)
  const inverse = ancestors ? tryInvertVectorMatrix(ancestors) : ([1, 0, 0, 1, 0, 0] as VectorMatrix)
  if (!inverse) return false
  if (field === 'x' || field === 'y') {
    const shown = field === 'x' ? current.x : current.y
    if (Math.abs(shown - value) < VECTOR_NUMERIC_EPS) return false
    const dx = field === 'x' ? value - current.x : 0
    const dy = field === 'y' ? value - current.y : 0
    // Deltas map through the LINEAR part of the ancestor inverse only
    // (translation cancels for differences).
    const px = inverse[0]! * dx + inverse[2]! * dy
    const py = inverse[1]! * dx + inverse[3]! * dy
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false
    if (Math.abs(px) < VECTOR_NUMERIC_EPS && Math.abs(py) < VECTOR_NUMERIC_EPS) return false
    prependVectorTranslate(element, px, py)
    return true
  }
  // W/H: explicit no-ops for zero spans (unscalable), non-positive targets
  // (would collapse/mirror into a singular trap) and skew/rotated ancestors
  // (AABB width is not a single scale there).
  const span = field === 'width' ? current.width : current.height
  if (!(span > 1e-12)) return false
  if (!(value > 1e-12)) return false
  if (Math.abs(span - value) < VECTOR_NUMERIC_EPS) return false
  if (ancestors && !vectorNumericAxisAligned(ancestors)) return false
  const factor = value / span
  if (!Number.isFinite(factor) || factor <= 0) return false
  if (Math.abs(factor - 1) < VECTOR_NUMERIC_EPS) return false
  const pivot = ancestors
    ? transformVectorPoint(inverse, current.x, current.y)
    : { x: current.x, y: current.y }
  if (!Number.isFinite(pivot.x) || !Number.isFinite(pivot.y)) return false
  if (field === 'width') prependVectorScaleAbout(element, pivot.x, pivot.y, factor, 1)
  else prependVectorScaleAbout(element, pivot.x, pivot.y, 1, factor)
  return true
}

export function addScale(element: Element, factor: number) {
  const transform = element.getAttribute('transform') ?? ''
  const match = /scale\(([-\d.]+)\)/.exec(transform)
  if (match) {
    const next = Math.max(0.05, Number(match[1]) * factor)
    element.setAttribute('transform', transform.replace(match[0], `scale(${next})`))
  } else {
    element.setAttribute('transform', `${transform} scale(${factor})`.trim())
  }
}

function vectorObjectLabel(element: Element, index: number) {
  const tag = element.tagName.toLowerCase()
  // Flatten line breaks so a multiline item keeps a single-line list label.
  const text = tag === 'text'
    ? (readVectorTextElementContent(element) ?? '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ')
    : ''
  return text ? `${index + 1}. ${tag}: ${text.slice(0, 18)}` : `${index + 1}. ${tag}`
}

function vectorObjectCenter(element: Element) {
  const bounds = vectorObjectBounds(element)
  if (bounds.width || bounds.height) return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name)) ?? 0
  if (tag === 'rect' || tag === 'image') return { x: number('x') + number('width') / 2, y: number('y') + number('height') / 2 }
  if (tag === 'ellipse' || tag === 'circle') return { x: number('cx'), y: number('cy') }
  if (tag === 'text') return { x: number('x'), y: number('y') }
  return { x: 48, y: 48 }
}

export function vectorObjectGeometry(element: Element) {
  const tag = element.tagName.toLowerCase()
  const number = (name: string) => optionalSvgNumber(element.getAttribute(name))
  if (tag === 'rect' || tag === 'image') return { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
  if (tag === 'text') return { x: number('x'), y: number('y') }
  if (tag === 'ellipse') {
    const rx = number('rx')
    const ry = number('ry')
    return { x: number('cx'), y: number('cy'), width: rx === undefined ? undefined : rx * 2, height: ry === undefined ? undefined : ry * 2 }
  }
  if (tag === 'circle') {
    const r = number('r')
    return { x: number('cx'), y: number('cy'), width: r === undefined ? undefined : r * 2, height: r === undefined ? undefined : r * 2 }
  }
  if (tag === 'g' || tag === 'svg') return vectorObjectBounds(element)
  // Path-like and miscellaneous tags (path/polygon/polyline/line/use/...)
  // have no single x/y/width/height attribute. The sidebar still shows X/Y/W/H
  // inputs for them, so expose the WORLD bounds here (same coordinates the
  // group unit already used). This keeps the displayed value and the absolute
  // setVectorNumericAttribute writer in the same frame: typing the displayed
  // bounds moves/scales the bounds there instead of accumulating an unrelated
  // translate/scale. Zero-span bounds (e.g. bare lines) report 0 sizes, and
  // W/H there is an explicit no-op in the writer.
  return vectorObjectBounds(element)
}
