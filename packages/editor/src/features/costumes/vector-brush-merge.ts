// Independent validation + safe union for vector-brush merging.
//
// Goal (from the brush gap): new brush strokes are closed filled shapes that
// should unite with touching same-color shapes. The current brush stores a
// centerline stroke, so merging must wait until the closed fill helper
// (`vector-brush-fill.ts`) is wired in. This module provides the merge side
// without touching existing files:
//
// - Pure DOM checks (`isMergeableBrushCandidate`): same solid fill, no
//   gradients/transparency/groups, leaf shapes only, same parent.
// - Z-order safety (`isBrushMergeOrderSafe`): refuse moves that would lift a
//   lower shape over an overlapping unrelated sibling.
// - Safe Paper.js boolean union (`tryUniteBrushItems`): touching-only unite
//   that never throws and never drops non-touching geometry.
// - Thin DOM orchestration (`mergeBrushElementWithSiblings`): sanitizer-first
//   import/export so untrusted SVG never reaches `importSVG` raw.
//
// Original implementation for this repository (no copied merge code).
// Uncertain points are documented on each function and reported by callers:
// color normalization is strict `fill`-attribute comparison (named colors and
// `style` paint are fail-closed), joins beyond direct brush contact are not
// attempted, and cross-gap Z moves are refused rather than reordered.

import {
  SVG_PLACEHOLDER,
  cleanSvgElementAttributes,
  sanitizeSvgFragmentForPaperImport,
} from './svg-sanitize'

export type VectorBrushMergeReason =
  | 'mergeable'
  | 'group'
  | 'non-shape'
  | 'has-children'
  | 'gradient'
  | 'transparent'
  | 'different-fill'
  | 'visible-stroke'
  | 'clip-or-mask'
  | 'different-parent'
  | 'invalid-brush'

export type VectorBrushMergeCheck = { ok: true; reason: 'mergeable' } | { ok: false; reason: VectorBrushMergeReason }

// Leaf shapes the brush is allowed to merge with. Groups, text, rasters,
// symbols and defs-adjacent nodes are refused so hierarchy and special
// rendering are never flattened by a brush stroke.
const MERGEABLE_TAGS = new Set(['path', 'rect', 'ellipse', 'circle', 'polygon', 'polyline', 'line'])

function getAttr(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name)
  } catch {
    return null
  }
}

function tagOf(element: Element): string {
  try {
    return element.tagName.toLowerCase()
  } catch {
    return ''
  }
}

/** Expand `#rgb` to `#rrggbb` and lowercase; returns undefined for non-solid paint. */
export function normalizeBrushFill(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return undefined
  if (trimmed === 'none' || trimmed === 'transparent') return undefined
  if (trimmed.includes('url(')) return undefined
  // Fail closed on alpha-bearing or computed paint; solid hex/rgb only.
  if (/rgba?\s*\(/.test(trimmed)) {
    const alphaMatch = trimmed.match(/rgba\s*\([^,]+,[^,]+,[^,]+,([^)]+)\)/)
    if (alphaMatch) {
      const alpha = Number(alphaMatch[1])
      if (!Number.isFinite(alpha) || alpha < 0.999) return undefined
      return trimmed.replace(/\s+/g, '')
    }
    return trimmed.replace(/\s+/g, '')
  }
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
    if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`
    // 4/8-digit hex carries alpha: fail closed.
    return undefined
  }
  // Named colors and other forms: keep strict string equality (lowercased).
  // `red` vs `#ff0000` will not match; that misses a merge but never corrupts.
  if (/^[a-z]+$/.test(trimmed)) return trimmed
  return trimmed
}

function opacityOf(value: string | null): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function hasTransparentPaint(element: Element): boolean {
  for (const name of ['opacity', 'fill-opacity', 'stroke-opacity']) {
    const parsed = opacityOf(getAttr(element, name))
    if (parsed !== undefined && parsed < 0.999) return true
  }
  const style = (getAttr(element, 'style') ?? '').toLowerCase()
  if (style.includes('opacity')) return true
  const fill = (getAttr(element, 'fill') ?? '').toLowerCase()
  if (fill.includes('url(')) return true
  if (fill.trim() === 'transparent') return true
  if (/rgba\s*\(/.test(fill)) {
    const alphaMatch = fill.match(/rgba\s*\([^,]+,[^,]+,[^,]+,([^)]+)\)/)
    if (alphaMatch) {
      const alpha = Number(alphaMatch[1])
      if (!Number.isFinite(alpha) || alpha < 0.999) return true
    } else {
      return true
    }
  }
  if (/^#[0-9a-f]{4}$/i.test(fill.trim()) || /^#[0-9a-f]{8}$/i.test(fill.trim())) return true
  return false
}

function hasVisibleStroke(element: Element): boolean {
  const style = (getAttr(element, 'style') ?? '').toLowerCase()
  // Fail closed: inline-style stroke cannot be parsed reliably here.
  if (/(^|;|\s)stroke\s*:/.test(style)) return true
  const stroke = (getAttr(element, 'stroke') ?? '').trim().toLowerCase()
  if (!stroke || stroke === 'none' || stroke === 'transparent') return false
  const widthRaw = getAttr(element, 'stroke-width')
  if (widthRaw != null) {
    const width = Number(widthRaw)
    if (!Number.isFinite(width) || width <= 0) return false
  }
  const strokeOpacity = opacityOf(getAttr(element, 'stroke-opacity'))
  if (strokeOpacity !== undefined && strokeOpacity <= 0) return false
  return true
}

function hasClipOrMask(element: Element): boolean {
  for (const name of ['clip-path', 'mask', 'filter']) {
    const value = getAttr(element, name)
    if (value != null && value.trim() !== '' && value.trim().toLowerCase() !== 'none') return true
  }
  const style = (getAttr(element, 'style') ?? '').toLowerCase()
  if (style.includes('clip-path') || style.includes('mask')) return true
  return false
}

/**
 * Pure eligibility check for one sibling candidate. No Paper.js, no geometry:
 * only tag shape, solid-fill equality, transparency/gradient guards, visible
 * stroke, clip/mask, and same-parent. Intersection and Z-order are separate
 * steps so unit tests can cover this without a browser.
 */
export function isMergeableBrushCandidate(
  candidate: Element,
  brushElement: Element,
  brushFill: string,
): VectorBrushMergeCheck {
  const tag = tagOf(candidate)
  if (tag === 'g') return { ok: false, reason: 'group' }
  if (!MERGEABLE_TAGS.has(tag)) return { ok: false, reason: 'non-shape' }
  try {
    if (candidate.children.length > 0 && tag !== 'polygon' && tag !== 'polyline') {
      // Leaf shapes carry no element children; anything nested is left alone.
      return { ok: false, reason: 'has-children' }
    }
  } catch {
    return { ok: false, reason: 'non-shape' }
  }
  try {
    if (candidate.parentNode !== brushElement.parentNode || !candidate.parentNode) {
      return { ok: false, reason: 'different-parent' }
    }
  } catch {
    return { ok: false, reason: 'different-parent' }
  }
  const brushNormalized = normalizeBrushFill(brushFill)
  const candidateNormalized = normalizeBrushFill(getAttr(candidate, 'fill'))
  if (!brushNormalized || !candidateNormalized || brushNormalized !== candidateNormalized) {
    // Covers `different-fill` and every gradient case (`url(...)` fails to
    // normalize on either side). Gradients never merge, so `gradient` is
    // reported when either side mentions `url(`.
    const mentionsUrl =
      (getAttr(candidate, 'fill') ?? '').toLowerCase().includes('url(') || brushFill.toLowerCase().includes('url(')
    return { ok: false, reason: mentionsUrl ? 'gradient' : 'different-fill' }
  }
  if (hasTransparentPaint(candidate)) return { ok: false, reason: 'transparent' }
  if (hasVisibleStroke(candidate)) return { ok: false, reason: 'visible-stroke' }
  if (hasClipOrMask(candidate)) return { ok: false, reason: 'clip-or-mask' }
  return { ok: true, reason: 'mergeable' }
}

/**
 * Validate that the brush itself may participate in a merge. The brush must
 * be a leaf filled shape with solid paint; group/gradient/transparent brushes
 * are refused rather than merged.
 */
export function checkBrushElementForMerge(brushElement: Element): VectorBrushMergeCheck {
  const tag = tagOf(brushElement)
  if (tag === 'g') return { ok: false, reason: 'group' }
  if (!MERGEABLE_TAGS.has(tag)) return { ok: false, reason: 'non-shape' }
  const fill = getAttr(brushElement, 'fill') ?? ''
  if (!normalizeBrushFill(fill)) {
    return { ok: false, reason: fill.toLowerCase().includes('url(') ? 'gradient' : 'invalid-brush' }
  }
  if (hasTransparentPaint(brushElement)) return { ok: false, reason: 'transparent' }
  if (hasClipOrMask(brushElement)) return { ok: false, reason: 'clip-or-mask' }
  // A closed fill brush carries `stroke="none"`; a visible stroke on the
  // brush would be dropped by a fill union, so refuse it as well.
  if (hasVisibleStroke(brushElement)) return { ok: false, reason: 'visible-stroke' }
  return { ok: true, reason: 'mergeable' }
}

/**
 * Z-order safety: merging moves every merged sibling into one node at the
 * brush position (the topmost index). If an unrelated sibling sits between
 * the lowest merged index and the brush and overlaps the brush bounds, that
 * move would change stacking. Returns false in that case so callers refuse or
 * narrow the merge set instead of reordering unrelated art.
 *
 * `isOverlappingBlocker(index)` should be true for siblings that are NOT part
 * of the merge and whose bounds intersect the brush/union bounds.
 */
export function isBrushMergeOrderSafe(
  brushIndex: number,
  mergedIndices: number[],
  isOverlappingBlocker: (index: number) => boolean,
): boolean {
  if (mergedIndices.length === 0) return true
  const low = Math.min(brushIndex, ...mergedIndices)
  const high = Math.max(brushIndex, ...mergedIndices)
  const merged = new Set(mergedIndices)
  for (let index = low; index <= high; index += 1) {
    if (index === brushIndex || merged.has(index)) continue
    try {
      if (isOverlappingBlocker(index)) return false
    } catch {
      return false
    }
  }
  return true
}

/** Touch test mirroring the eraser helper: intersection or containment either way. */
export function paperItemsTouch(first: paper.Item, second: paper.Item): boolean {
  try {
    if ((first as unknown as paper.PathItem).intersects?.(second as unknown as paper.PathItem)) return true
  } catch {
    // Fall through to containment checks.
  }
  try {
    const a = first as unknown as paper.Path
    const b = second as unknown as paper.Path
    if (Array.isArray(a.segments) && b.firstSegment?.point && a.hitTest?.(b.firstSegment.point)) return true
    if (Array.isArray(b.segments) && a.firstSegment?.point && b.hitTest?.(a.firstSegment.point)) return true
  } catch {
    // Hit testing can throw on degenerate items; treat as non-touching.
  }
  return false
}

function expandShapeItem(item: paper.Item): paper.Item {
  if ((item as unknown as { className?: string }).className !== 'Shape') return item
  const convert = (item as unknown as { toPath?: (insert?: boolean) => paper.Item }).toPath
  if (typeof convert !== 'function') return item
  try {
    const converted = convert.call(item, false)
    if (converted && converted !== (item as unknown as paper.Item)) {
      try {
        ;(item as paper.Item).remove()
      } catch {
        // Already detached.
      }
      return converted
    }
  } catch {
    // Keep the original; the unite below fails soft per candidate.
  }
  return item
}

/**
 * Resolve the single-child `Group` wrapper that sanitized `importSVG` always
 * returns (children:[Path]). Only a chain of single-child Groups is dissolved;
 * a multi-child Group is not a leaf brush shape, so `undefined` is returned
 * fail-closed instead of guessing which child to merge.
 *
 * Wrapper transforms are baked into the leaf (innermost first, then outward)
 * so element-level `transform` and the sanitizer `<svg>` wrapper survive the
 * unwrap without shifting on-screen geometry. Wrapper `Group` containers are
 * removed; the returned leaf is detached and ready for boolean ops. Never
 * throws.
 */
export function resolveImportedBrushLeaf(item: paper.Item): paper.Item | undefined {
  try {
    let current = item as paper.Item | undefined
    if (!current) return undefined
    const wrappers: paper.Item[] = []
    let guard = 0
    while (current && (current as unknown as { className?: string }).className === 'Group') {
      if (guard++ > 32) return undefined
      let children: paper.Item[] | undefined
      try {
        children = (current as unknown as { children?: paper.Item[] }).children
      } catch {
        return undefined
      }
      if (!children || children.length !== 1) return undefined
      wrappers.push(current)
      current = children[0]
      if (!current) return undefined
    }
    if (!current) return undefined
    current = expandShapeItem(current)
    // A Shape expansion never yields a Group, but re-check defensively: a
    // Group here means the import was not a single leaf shape.
    if ((current as unknown as { className?: string }).className === 'Group') return undefined
    // Bake wrapper matrices so unwrapping never drops on-screen geometry.
    // Leaf global = outer * ... * inner * leaf; applying innermost first
    // reproduces that composition on the detached leaf.
    for (let index = wrappers.length - 1; index >= 0; index -= 1) {
      const wrapper = wrappers[index]!
      try {
        const matrix = (wrapper as unknown as { matrix?: unknown }).matrix as
          | { isIdentity?: () => boolean; clone?: () => unknown }
          | undefined
        const transform = (current as unknown as { transform?: (matrix: unknown) => void }).transform
        if (!matrix || typeof transform !== 'function') continue
        if (typeof matrix.isIdentity === 'function' && matrix.isIdentity()) continue
        const argument = typeof matrix.clone === 'function' ? matrix.clone() : matrix
        transform.call(current, argument)
      } catch {
        // Keep the leaf; a failed bake fails soft below (touch/unite guard).
      }
    }
    // Detach the leaf first so dropping the (already detached) wrappers
    // cannot take the leaf with them; detached leaves still support boolean
    // ops (mirrors the eraser's detach-before-subtract). Plain paths with no
    // wrapper are returned untouched so live project items stay in place.
    if (wrappers.length > 0) {
      try {
        ;(current as unknown as { remove?: () => void }).remove?.()
      } catch {
        // Already detached.
      }
      for (const wrapper of wrappers) {
        try {
          ;(wrapper as unknown as { remove?: () => void }).remove?.()
        } catch {
          // Already detached.
        }
      }
    }
    const className = (current as unknown as { className?: string }).className
    if (className !== 'Path' && className !== 'CompoundPath') {
      // Path-like only; anything else (text, raster, nested group) is refused.
      // Allow duck-typed boolean-capable items so Paper version differences
      // do not lock out valid paths.
      const unite = (current as unknown as { unite?: unknown }).unite
      if (typeof unite !== 'function') return undefined
    }
    return current
  } catch {
    return undefined
  }
}

/**
 * Unite a brush item with touching candidate items. Only items that touch the
 * growing union are consumed; non-touching items are left in place and also
 * returned via `skipped`. Never throws: a failed boolean op keeps both inputs
 * and continues with the next candidate.
 */
export function tryUniteBrushItems(
  brushItem: paper.Item,
  candidateItems: paper.Item[],
): { united: paper.Item; skipped: paper.Item[] } {
  const resolvedBrush = resolveImportedBrushLeaf(brushItem) ?? expandShapeItem(brushItem)
  let current = resolvedBrush as unknown as paper.PathItem
  const skipped: paper.Item[] = []
  for (const raw of candidateItems) {
    const candidate = resolveImportedBrushLeaf(raw) ?? expandShapeItem(raw)
    let touching = false
    try {
      touching = paperItemsTouch(current as unknown as paper.Item, candidate)
    } catch {
      touching = false
    }
    if (!touching) {
      skipped.push(candidate)
      continue
    }
    try {
      const united = (current as unknown as paper.Path).unite(candidate as unknown as paper.PathItem)
      try {
        ;(current as unknown as paper.Item).remove()
      } catch {
        // Already detached.
      }
      try {
        ;(candidate as unknown as paper.Item).remove()
      } catch {
        // Already detached.
      }
      current = united as unknown as paper.PathItem
    } catch {
      // Keep both shapes; a failed boolean must never lose geometry.
      skipped.push(candidate)
    }
  }
  return { united: current as unknown as paper.Item, skipped }
}

export type BrushMergeResult = { merged: boolean; mergedCount: number; reason?: string }

function serializeForPaperImport(element: Element): string | undefined {
  try {
    const raw = new XMLSerializer().serializeToString(element)
    const sanitized = sanitizeSvgFragmentForPaperImport(raw)
    if (!sanitized || sanitized === SVG_PLACEHOLDER) return undefined
    return sanitized
  } catch {
    return undefined
  }
}

/**
 * DOM orchestration: unite an already-inserted closed-fill brush element with
 * touching same-color siblings. Sanitizer-first: every element serialized for
 * `importSVG` goes through `sanitizeSvgFragmentForPaperImport`, and exported
 * nodes go through `cleanSvgElementAttributes` before going live. Only merged
 * siblings and the brush are replaced; every other sibling node keeps its
 * identity and order. Strictly fail-closed: any uncertainty refuses the merge
 * instead of reordering or dropping art.
 *
 * Note: requires browser DOM (`XMLSerializer`) and is therefore exercised via
 * browser wiring in the future Editor integration, not via bun unit tests.
 */
export function mergeBrushElementWithSiblings(
  scope: paper.PaperScope,
  brushElement: Element,
): BrushMergeResult {
  try {
    const parent = brushElement.parentNode as Element | null
    if (!parent || typeof parent.children === 'undefined') return { merged: false, mergedCount: 0, reason: 'different-parent' }
    const brushCheck = checkBrushElementForMerge(brushElement)
    if (!brushCheck.ok) return { merged: false, mergedCount: 0, reason: brushCheck.reason }
    const brushFill = getAttr(brushElement, 'fill') ?? ''
    const siblings = Array.from(parent.children) as Element[]
    const brushIndex = siblings.indexOf(brushElement)
    if (brushIndex < 0) return { merged: false, mergedCount: 0, reason: 'different-parent' }

    const eligible = siblings.filter(
      (sibling, index) => index !== brushIndex && isMergeableBrushCandidate(sibling, brushElement, brushFill).ok,
    )
    if (eligible.length === 0) return { merged: false, mergedCount: 0, reason: 'different-fill' }

    const brushSource = serializeForPaperImport(brushElement)
    if (!brushSource) return { merged: false, mergedCount: 0, reason: 'invalid-brush' }
    const brushItem = (
      scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean; expandShapes?: boolean }) => paper.Item }
    ).importSVG(brushSource, { insert: false, expandShapes: true })
    if (!brushItem) return { merged: false, mergedCount: 0, reason: 'invalid-brush' }
    const owned: paper.Item[] = [brushItem]
    // Sanitized `importSVG` wraps every leaf in a single-child Group (no
    // boolean ops on Groups). Resolve it once here so touch/bounds/unite see
    // path geometry with wrapper transforms baked in. Multi-child wrappers
    // are not leaves: fail-closed with no DOM change.
    const brushLeaf = resolveImportedBrushLeaf(brushItem)
    if (!brushLeaf) return { merged: false, mergedCount: 0, reason: 'invalid-brush' }
    if (brushLeaf !== brushItem) owned.push(brushLeaf)
    try {
      const touching: { element: Element; item: paper.Item; index: number }[] = []
      for (const element of eligible) {
        const source = serializeForPaperImport(element)
        if (!source) continue
        let item: paper.Item | undefined
        try {
          item = (
            scope.project as unknown as {
              importSVG: (svg: string, options?: { insert?: boolean; expandShapes?: boolean }) => paper.Item
            }
          ).importSVG(source, { insert: false, expandShapes: true })
        } catch {
          item = undefined
        }
        if (!item) continue
        owned.push(item)
        const leaf = resolveImportedBrushLeaf(item)
        if (!leaf) continue
        if (leaf !== item) owned.push(leaf)
        let touches = false
        try {
          touches = paperItemsTouch(brushLeaf, leaf)
        } catch {
          touches = false
        }
        if (touches) touching.push({ element, item: leaf, index: siblings.indexOf(element) })
      }
      if (touching.length === 0) return { merged: false, mergedCount: 0, reason: 'different-fill' }

      // Z-order guard: an unrelated sibling between the lowest touched index
      // and the brush that overlaps the brush blocks the lower part of the
      // merge instead of lifting art over it.
      const brushBounds = (() => {
        try {
          return (brushLeaf as paper.Path).bounds
        } catch {
          return undefined
        }
      })()
      const blockerOverlapsBrush = (index: number): boolean => {
        const blocker = siblings[index]
        if (!blocker || touching.some((entry) => entry.element === blocker)) return false
        const source = serializeForPaperImport(blocker)
        if (!source) return true
        try {
          const blockerItem = (
            scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }
          ).importSVG(source, { insert: false })
          if (!blockerItem) return true
          try {
            if (!brushBounds) return true
            return brushBounds.intersects((blockerItem as paper.Path).bounds)
          } finally {
            try {
              blockerItem.remove()
            } catch {
              // ignore
            }
          }
        } catch {
          return true
        }
      }
      const safe = touching.filter((entry) => {
        const higherBlockerBetween = (() => {
          const low = Math.min(entry.index, brushIndex)
          for (let i = low; i <= brushIndex; i += 1) {
            if (i === entry.index || i === brushIndex) continue
            if (touching.some((other) => other.index === i)) continue
            if (blockerOverlapsBrush(i)) return true
          }
          return false
        })()
        return !higherBlockerBetween
      })
      if (safe.length === 0) return { merged: false, mergedCount: 0, reason: 'clip-or-mask' }
      if (!isBrushMergeOrderSafe(brushIndex, safe.map((entry) => entry.index), blockerOverlapsBrush)) {
        return { merged: false, mergedCount: 0, reason: 'clip-or-mask' }
      }

      // Unite in ascending Z so the result keeps the topmost position.
      const ordered = [...safe].sort((a, b) => a.index - b.index)
      const { united, skipped } = tryUniteBrushItems(
        brushLeaf,
        ordered.map((entry) => entry.item),
      )
      owned.push(united)
      const skippedSet = new Set(skipped)
      const consumed = ordered.filter((entry) => !skippedSet.has(entry.item))
      if (consumed.length === 0) return { merged: false, mergedCount: 0, reason: 'different-fill' }

      let exported: Element | undefined
      try {
        const node = united.exportSVG({ asString: false }) as Element
        exported = brushElement.ownerDocument.importNode(node, true) as Element
        cleanSvgElementAttributes(exported)
        // Pin the agreed paint explicitly: every input shared it, so this
        // cannot restyle unrelated art, and it heals Paper export variance.
        // `fill-rule` carries holes (evenodd CompoundPaths); keep the brush
        // value when present so donut holes survive the round-trip.
        exported.setAttribute('fill', brushFill)
        exported.setAttribute('stroke', 'none')
        const brushFillRule = getAttr(brushElement, 'fill-rule') ?? getAttr(brushElement, 'fillRule')
        if (brushFillRule != null && brushFillRule.trim() !== '') exported.setAttribute('fill-rule', brushFillRule)
        const brushOpacity = getAttr(brushElement, 'opacity')
        if (brushOpacity != null) exported.setAttribute('opacity', brushOpacity)
        else exported.removeAttribute('opacity')
        cleanSvgElementAttributes(exported)
      } catch {
        return { merged: false, mergedCount: 0, reason: 'invalid-brush' }
      }
      if (!exported) return { merged: false, mergedCount: 0, reason: 'invalid-brush' }

      // Replace: remove consumed siblings (descending to keep indices valid),
      // then swap the brush node in place so unrelated order never shifts.
      for (const entry of [...consumed].sort((a, b) => b.index - a.index)) {
        entry.element.remove()
      }
      brushElement.replaceWith(exported)
      return { merged: true, mergedCount: consumed.length }
    } finally {
      for (const item of owned) {
        try {
          // The united result may already own/replace inputs; removal is
          // best-effort cleanup of the scratch project only.
          if ((item as unknown as { project?: unknown }).project) item.remove()
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return { merged: false, mergedCount: 0, reason: 'invalid-brush' }
  }
}
