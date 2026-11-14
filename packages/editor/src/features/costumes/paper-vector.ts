import type paperCore from 'paper/dist/paper-core'
import type { VectorObjectInfo, VectorPathPointInfo, VectorResizeHandle } from '../../lib/editor-types'
import { ancestorWorldMatrix, bakedUnitClone, combineSvgTransforms, editableVectorUnits, isRtlVectorTextElement, moveVectorEditablePoint as moveVectorEditablePointFallback, optionalSvgNumber, transformVectorPoint, tryInvertVectorMatrix, vectorObjectBounds, vectorObjectList, worldTransformMatrix, isExplicitVectorGroup, markExplicitVectorGroup, type VectorMatrix } from './vector-svg'
import { classifyLeafElementForTranslate } from './vector-group-leaf-translate'
import { SVG_PLACEHOLDER, cleanSvgElementAttributes, sanitizeSvgFragmentForPaperImport, sanitizeSvgForPaperImport } from './svg-sanitize'
import { resolveVectorScale } from './vector-scale-modifiers'
import { resolveCommonVectorScale } from './vector-multi-scale'
import {
  classifyHolePoint,
  containingContourIndices,
  contourArea,
  contourBounds,
  distanceToContours,
  isPathDataSafeForHoleGeometry,
  isPointFilled,
  isUnitEligibleForHoleGeometry,
  localToleranceForHoleMatrix,
  normalizeFillRule,
  parseStraightContours,
} from './vector-fill-hole-geometry'
import { auditStraightNesting, resolveNestedHole } from './vector-fill-hole-nested'
import {
  classifyOuterIslandHolePoint,
  resolveOuterHoleWithIsland,
} from './vector-fill-hole-outer-island'
import {
  CURVED_FLATTEN_TOLERANCE,
  curvedLocalMarginFor,
  flattenCurvedContours,
  gateCurvedWorldMatrix,
  isPathDataSafeForCurvedHoleGeometry,
} from './vector-fill-hole-curves'
import {
  classifyHoleEffectiveFill,
  documentBoundsForHole,
  hasHoleBlockingClipOrMask,
  holeContourToPathData,
  isHolePathDataSafe,
  resolveEffectiveHoleFillRule,
  resolveHoleVisibility,
  resolveInheritedHoleProperty,
  safePaperArea,
  safePaperContains,
  safePaperIntersectionsCount,
  type HolePaintState,
  type VectorHoleProbe,
  type VectorHoleTarget,
} from './vector-hole-probe-shared'
import { probeCurvedFallbackHole } from './vector-curved-hole-probe'
import { classifyStraightForegroundCover } from './vector-fill-hole-cover'

// Re-exported so existing `from './paper-vector'` importers keep working; the
// implementation lives in `vector-hole-probe-shared.ts`.
export { isHolePathDataSafe, type VectorHoleProbe, type VectorHoleTarget } from './vector-hole-probe-shared'

type VectorBounds = { x: number; y: number; width: number; height: number }

let paperModule: typeof paperCore | undefined
let paperScope: paper.PaperScope | undefined

export async function ensureVectorPaperScope() {
  if (!paperModule) {
    const imported = await import('paper/dist/paper-core')
    paperModule = ('default' in imported ? imported.default : imported) as typeof paperCore
  }
  if (!paperScope) {
    paperScope = new paperModule.PaperScope()
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 360
    paperScope.setup(canvas)
  }
  return paperScope
}

export function disposeVectorPaperScope() {
  paperScope?.project?.remove()
  paperScope = undefined
}

export async function paperVectorObjectList(svgText: string) {
  // Trust boundary: Paper.js `importSVG` parses markup; feed it only
  // sanitized SVG so a stored payload cannot re-arm via editing.
  const clean = sanitizeSvgForPaperImport(svgText)
  const fallback = vectorObjectList(clean)
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName.toLowerCase() !== 'svg') return fallback
  try {
    const scope = await ensureVectorPaperScope()
    return editableVectorUnits(svg).map((element, index) => {
      const base = fallback[index]
      const bounds = paperBoundsForElement(scope, element)
      const points = paperEditablePointsForElement(scope, element)
      return {
        ...(base ?? {
          index,
          tag: element.tagName.toLowerCase(),
          label: `${index + 1}. ${element.tagName.toLowerCase()}`,
        }),
        boundsX: bounds?.x ?? base?.boundsX ?? base?.x ?? 0,
        boundsY: bounds?.y ?? base?.boundsY ?? base?.y ?? 0,
        boundsWidth: bounds?.width ?? base?.boundsWidth ?? base?.width ?? 0,
        boundsHeight: bounds?.height ?? base?.boundsHeight ?? base?.height ?? 0,
        points: points.length > 0 ? points : base?.points,
      }
    }) as VectorObjectInfo[]
  } catch {
    return fallback
  }
}

function paperEditablePointsForElement(scope: paper.PaperScope, element: Element) {
  const item = importPaperUnit(scope, element)
  if (!item) return []
  try {
    // Group reshape parity (Scratch: reshape reaches Shape/Path points inside
    // a group): leaf Shapes (rect/ellipse/...) import as Paper `Shape` with no
    // segments, so a group of two rects reported 0 handles. Expand Shapes to
    // paths in the detached import only (DOM untouched), then collect the same
    // flattened Paper-scheme ordering `vector-path-points.ts` mutates. Single
    // leaves keep the legacy token corners (`vector-svg.ts` fallback), so only
    // `<g>` units expand here — singleton rect/ellipse behavior is unchanged.
    // Compound children stay flattened (no per-child subselection UI); text /
    // raster / use units still report no points.
    try {
      const root = element.tagName.toLowerCase() === 'g' ? expandPaperShapesToPaths(item) : item
      const points: VectorPathPointInfo[] = []
      const paths = paperPathItems(root)
      countPaperSegmentsOrThrow(paths)
      for (const path of paths) {
        appendPaperPathPoints(path, points)
      }
      return points
    } catch (error) {
      // Over-budget/unreadable import: refuse Paper points so callers fall back
      // to the DOM list instead of a partial flattened scheme.
      if (!isPaperTreeTooLarge(error)) throw error
      return []
    }
  } finally {
    item.remove()
  }
}

// Convert detached-import `Shape` items (SVG rect/ellipse/...) to paths in
// place. Geometry-preserving; mirrors `expandShapesToPaths` in
// `vector-path-points.ts` (duplicated to avoid a paper-vector <-> path-points
// import cycle). Only the ephemeral Paper import is mutated — the live DOM,
// wrapper transforms, paint and siblings are untouched. `toPath` with the
// parent flag keeps converted children inside their group so document order
// (and flattened indices) match the surgical write-back.
function expandPaperShapesToPaths(item: paper.Item): paper.Item {
  // Iterative with the same traversal budget: deep `<g>` nesting must refuse
  // instead of overflowing the call stack, and an unreadable child list must
  // refuse instead of silently keeping a partial expansion.
  const expandOne = (target: paper.Item): paper.Item => {
    if ((target as unknown as { className?: string }).className !== 'Shape') return target
    const toPath = (target as unknown as { toPath?: (insert: boolean) => paper.Path }).toPath
    if (typeof toPath !== 'function') return target
    try {
      const converted = toPath.call(target, Boolean((target as paper.Item).parent))
      if (converted && converted !== (target as unknown as paper.Item)) {
        try {
          ;(target as paper.Item).remove()
        } catch {
          // Already detached; the converted path is still valid.
        }
        return converted
      }
    } catch {
      // Keep the original shape; callers treat it as having no paths.
    }
    return target
  }
  const rootConverted = expandOne(item)
  if (rootConverted !== item) return rootConverted
  const stack: paper.Item[] = [item]
  let visited = 0
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    if (++visited > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    const current = stack.pop()!
    let children: unknown
    try {
      children = (current as unknown as { children?: unknown }).children
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (!Array.isArray(children) || (children as unknown[]).length === 0) continue
    for (const child of Array.from(children as paper.Item[])) {
      const converted = expandOne(child as paper.Item)
      if (converted !== (child as paper.Item)) {
        try {
          ;(child as paper.Item).replaceWith(converted)
        } catch {
          // Keep the original child on failure.
        }
      } else {
        stack.push(child as paper.Item)
      }
    }
  }
  return item
}

// Fail-closed traversal budget (DoS guard): a stored payload can nest thousands
// of groups or carry huge segment counts. Every walk below is iterative with an
// explicit stack and a shared node cap. Past the cap (or on any unreadable
// Paper accessor) traversal throws the private `PaperTreeTooLargeError` sentinel
// instead of returning a partial array — returning collected-so-far as if
// complete would silently corrupt selection/reshape/erase (miss a tail child
// and mutate a partial). Every operation catches the sentinel and returns an
// explicit no-op/unsupported with no DOM write, never a partial edited asset.
const PAPER_TRAVERSAL_MAX_NODES = 5000
const PAPER_TRAVERSAL_MAX_LEAVES = 1000
const PAPER_TRAVERSAL_MAX_SEGMENTS = 50000

class PaperTreeTooLargeError extends Error {
  readonly __paperTreeTooLarge = true as const
  constructor(reason = 'paper tree exceeds traversal budget (fail-closed)') {
    super(reason)
    this.name = 'PaperTreeTooLargeError'
  }
}

function isPaperTreeTooLarge(error: unknown): boolean {
  try {
    return error instanceof PaperTreeTooLargeError ||
      (typeof error === 'object' && error !== null &&
        (error as { __paperTreeTooLarge?: unknown }).__paperTreeTooLarge === true)
  } catch {
    return false
  }
}

type PaperTraversalBudget = { remaining: number }

function traversalBudget(budget?: PaperTraversalBudget): PaperTraversalBudget {
  return budget ?? { remaining: PAPER_TRAVERSAL_MAX_NODES }
}

function consumeTraversalNode(budget: PaperTraversalBudget): void {
  budget.remaining -= 1
  if (budget.remaining < 0) throw new PaperTreeTooLargeError()
}

function readPaperChildren(current: paper.Item): paper.Item[] | undefined {
  let children: unknown
  try {
    children = (current as unknown as { children?: unknown }).children
  } catch {
    // An unreadable child list has no safe partial: refuse the whole unit.
    throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
  }
  if (children === undefined) return undefined
  if (!Array.isArray(children)) return undefined
  return children as paper.Item[]
}

function readPaperSegments(current: paper.Item): paper.Segment[] | undefined {
  let segments: unknown
  try {
    segments = (current as unknown as { segments?: unknown }).segments
  } catch {
    throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
  }
  if (segments === undefined) return undefined
  if (!Array.isArray(segments)) return undefined
  return segments as paper.Segment[]
}

// Single shared walk collecting both path items and non-path bounds leaves in
// one pass, so overlapping callers (`paperItemIntersectsRect`) spend one
// per-tree budget instead of two independent 5000-node caps that could each
// pass while the combined tree is adversarial.
function collectPaperTreePathsAndLeaves(
  item: paper.Item,
  budget?: PaperTraversalBudget,
): { paths: paper.Path[]; leaves: paper.Item[] } {
  const shared = traversalBudget(budget)
  const paths: paper.Path[] = []
  const leaves: paper.Item[] = []
  const stack: paper.Item[] = [item]
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    consumeTraversalNode(shared)
    const current = stack.pop()!
    const segments = readPaperSegments(current)
    if (segments) {
      paths.push(current as paper.Path)
      continue
    }
    const children = readPaperChildren(current)
    if (children && children.length > 0) {
      for (let index = children.length - 1; index >= 0; index--) {
        if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
        stack.push(children[index]!)
      }
      continue
    }
    if (leaves.length >= PAPER_TRAVERSAL_MAX_LEAVES) throw new PaperTreeTooLargeError()
    leaves.push(current)
  }
  return { paths, leaves }
}

function paperPathItems(item: paper.Item, budget?: PaperTraversalBudget): paper.Path[] {
  return collectPaperTreePathsAndLeaves(item, budget).paths
}

// Count flattened segments with an explicit cap. A single `<path>` with tens
// of thousands of segments imports as ONE Paper path (node cap never fires),
// so reshape/selection must refuse explicitly instead of hanging the UI.
function countPaperSegmentsOrThrow(paths: paper.Path[]): number {
  let total = 0
  for (const path of paths) {
    let segments: unknown
    try {
      segments = (path as unknown as { segments?: unknown }).segments
    } catch {
      throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    }
    if (!Array.isArray(segments)) throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    total += (segments as unknown[]).length
    if (total > PAPER_TRAVERSAL_MAX_SEGMENTS) throw new PaperTreeTooLargeError()
  }
  return total
}

function appendPaperPathPoints(path: paper.Path, points: VectorPathPointInfo[]) {
  for (const segment of path.segments) {
    const anchorIndex = points.length
    const anchor = projectPoint(path, segment.point)
    points.push({ index: anchorIndex, x: anchor.x, y: anchor.y, kind: 'anchor' })
    if (!isZeroPaperPoint(segment.handleIn)) {
      const handle = projectPoint(path, segment.point.add(segment.handleIn))
      points.push({ index: points.length, x: handle.x, y: handle.y, kind: 'control', controlRole: 'in', relatedAnchorIndex: anchorIndex })
    }
    if (!isZeroPaperPoint(segment.handleOut)) {
      const handle = projectPoint(path, segment.point.add(segment.handleOut))
      points.push({ index: points.length, x: handle.x, y: handle.y, kind: 'control', controlRole: 'out', relatedAnchorIndex: anchorIndex })
    }
  }
}

function projectPoint(path: paper.Path, point: paper.Point) {
  // Map path-local coordinates up to the document (world) frame, following
  // ancestor transforms of nested units. (Paper.js has no localToProject;
  // localToGlobal walks the same parent chain.)
  return path.localToGlobal(point)
}

function localPoint(path: paper.Path, point: paper.Point) {
  return path.globalToLocal(point)
}

function isZeroPaperPoint(point: paper.Point) {
  return Math.abs(point.x) < 0.001 && Math.abs(point.y) < 0.001
}

/**
 * Paper.js ignores `direction="rtl"` on `<text>` (it lays the glyphs out
 * LTR-imagined, at/right of x), while the browser renders the same
 * `text-anchor="start" direction="rtl"` block LEFT of x (inline-start is
 * the right edge under RTL). All Paper-side text geometry therefore goes
 * through this RTL correction so hit testing, marquee selection, and the
 * selection frames match the visible SVG pixels. LTR/CJK units pass
 * through untouched; ancestor transforms ride the shared baked import, and
 * the width/height stay Paper-measured (only the x origin is mirrored
 * around the document-space anchor).
 */
function rtlTextAnchorDocumentX(element: Element): number | undefined {
  try {
    const localX = optionalSvgNumber(element.getAttribute('x'))
    if (localX === undefined) return undefined
    const matrix = worldTransformMatrix(element)
    if (!matrix) return localX
    return transformVectorPoint(matrix, localX, 0).x
  } catch {
    return undefined
  }
}

function correctedRtlTextBounds(element: Element, paperBounds: VectorBounds): VectorBounds | undefined {
  const anchorX = rtlTextAnchorDocumentX(element)
  if (anchorX === undefined || !Number.isFinite(anchorX)) return undefined
  if (!Number.isFinite(paperBounds.width) || !Number.isFinite(paperBounds.y) || !Number.isFinite(paperBounds.height)) return undefined
  return { x: anchorX - paperBounds.width, y: paperBounds.y, width: paperBounds.width, height: paperBounds.height }
}

/**
 * Mirror a document-space hit point across the element's local RTL anchor
 * so a Paper.js hit test (which lays RTL text out LTR-imagined) probes the
 * visible glyph side. The mirror runs in the element's local frame and back
 * through the world matrix, so translated / scaled / rotated ancestors stay
 * exact; without a world transform it degrades to a plain x mirror.
 */
function rtlMirroredHitPoint(element: Element, point: { x: number; y: number }): { x: number; y: number } {
  try {
    const localX = optionalSvgNumber(element.getAttribute('x'))
    if (localX === undefined) return point
    const matrix = worldTransformMatrix(element)
    if (!matrix) return { x: 2 * localX - point.x, y: point.y }
    const inverse = tryInvertVectorMatrix(matrix)
    if (!inverse) return point
    const local = transformVectorPoint(inverse, point.x, point.y)
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return point
    const mirroredLocal = { x: 2 * localX - local.x, y: local.y }
    return transformVectorPoint(matrix, mirroredLocal.x, mirroredLocal.y)
  } catch {
    return point
  }
}

function paperBoundsForElement(scope: paper.PaperScope, element: Element) {
  const item = importPaperUnit(scope, element)
  if (!item) return undefined
  try {
    const bounds = item.bounds
    const paperBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    if (isRtlVectorTextElement(element)) {
      return correctedRtlTextBounds(element, paperBounds) ?? paperBounds
    }
    return paperBounds
  } finally {
    item.remove()
  }
}

// Hit tolerance in SVG units. The vector canvas is scaled up for display, so a
// small SVG-unit tolerance keeps the on-screen tolerance close to scratch-paint.
const VECTOR_HIT_TOLERANCE = 0.5

// Fill-tool hit target (scratch-paint `fill-tool.js` behavior, reimplemented
// from behavior notes without copying upstream source).
//
// Differences from `paperVectorHitIndex` (select-tool parity: fill + stroke +
// curves + segments): the fill tool hits fill + stroke only (no segments or
// curve interiors) with a zoom-aware tolerance (`2 / zoom`, callers convert
// screen px to SVG units). The result carries the hit side plus the metadata
// the `match` gate needs (closed / hasFill / almost-closed / text), so
// callers can apply `shouldAcceptFillHoverHit` (`vector-fill-hover.ts`) and
// commit exactly one side. Stock Paper.js (`paper` 0.12.18) has no
// `hitUnfilledPaths` / `hitUnstrokedPaths` fork options and never reports
// compound-hole children, so an open-path interior or a hole interior is a
// clean miss here (`null`): callers must treat a miss as a no-op and never
// fall back to a bounding-box hit (that fallback would recolor the whole
// parent when the pointer is over a hole). Hole-overlay generation and hover
// previews are deliberately not implemented here (see `vector-fill-hover.ts`).
export type VectorFillHitType = 'fill' | 'stroke'

export type VectorFillHitTarget = {
  /** Selectable-unit index in `editableVectorUnits(svg)`. */
  index: number;
  /** Which part of the shape was hit (commit only this side). */
  hitType: VectorFillHitType;
  /** True for `<text>` units / PointText hits (always accepted). */
  isText: boolean;
  /** Whether the shape effectively paints a fill. */
  hasFill: boolean;
  /** Whether the contour is closed. */
  closed: boolean;
  /** Open path with > 2 segments whose ends are closer than 8 units. */
  almostClosed: boolean;
  /** True when the hit child sits directly under a CompoundPath. */
  parentIsCompoundPath: boolean;
  /** Negative for hole children (stock Paper never yields these; kept for fork parity). */
  childArea: number | undefined;
}

function fillHitHasFill(element: Element, item: paper.Item): boolean {
  // Effective fill (style-first, root-inclusive, inherited): a `fill="none"`
  // presentation attribute is overridden by `style="fill:red"`, an inherited
  // group `fill="none"` empties the leaf, and `fill="none"` on the `<svg>`
  // root empties everything. Paper's `hasFill()` already reflects the baked
  // import (ancestor attributes pushed down), so prefer it; the DOM fallback
  // below mirrors the same cascade for imports that lost paint.
  // Class/stylesheet-driven paint cannot be computed detached: assume filled
  // here (the hole probe separately returns `unsupported` for classed units,
  // so no false hole overlay arises from this assumption).
  try {
    const paint = classifyHoleEffectiveFill(element);
    if (paint.kind === 'none') return false;
    if (paint.kind === 'unsupported') {
      try {
        const maybePath = item as unknown as { hasFill?: () => boolean };
        if (typeof maybePath.hasFill === 'function') return maybePath.hasFill();
      } catch {
        // Fall through to painted assumption below.
      }
      return true;
    }
    return true;
  } catch {
    try {
      const maybePath = item as unknown as { hasFill?: () => boolean };
      if (typeof maybePath.hasFill === 'function') return maybePath.hasFill();
    } catch {
      // Fall through.
    }
    const fill = element.getAttribute('fill');
    if (fill === null) return true;
    return fill.trim().toLowerCase() !== 'none';
  }
}

function fillHitClosed(element: Element, item: paper.Item): boolean {
  const className = (item as unknown as { className?: string }).className;
  if (className === 'CompoundPath' || className === 'Shape') return true;
  const maybePath = item as unknown as { closed?: boolean };
  if (typeof maybePath.closed === 'boolean') return maybePath.closed;
  const tag = element.tagName.toLowerCase();
  if (tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon') return true;
  if (tag === 'path') {
    const data = element.getAttribute('d') ?? '';
    return /z\s*$/i.test(data.trim());
  }
  return false;
}

function fillHitAlmostClosed(item: paper.Item): boolean {
  try {
    const maybePath = item as unknown as {
      segments?: Array<{ point: { x: number; y: number; getDistance: (other: { x: number; y: number }) => number } }>;
    };
    const segments = maybePath.segments;
    if (!segments || segments.length < 3) return false;
    const first = segments[0]?.point;
    const last = segments[segments.length - 1]?.point;
    if (!first || !last) return false;
    return first.getDistance(last) < 8;
  } catch {
    return false;
  }
}

/**
 * Definite invisibility for hit probes (`display:none` on any ancestor,
 * `visibility:hidden|collapse` effective, or `opacity:0` product). Hidden
 * units render nothing: body hits skip them and hole probes report `none`.
 * Stylesheet-unknown visibility (`class`) is NOT hidden here — callers
 * fail-closed via the hole post-guard instead, so far-outside points on
 * classed units stay `none` and existing safe SVG (no class) is unaffected.
 */
function isDefinitelyHoleHidden(element: Element): boolean {
  try {
    return resolveHoleVisibility(element).hidden;
  } catch {
    return false;
  }
}

export async function paperVectorFillTargetAtPoint(
  elements: Element[],
  point: { x: number; y: number },
  tolerance = VECTOR_HIT_TOLERANCE,
): Promise<VectorFillHitTarget | null> {
  if (elements.length === 0) return null;
  const scope = await ensureVectorPaperScope();
  const target = new scope.Point(point.x, point.y);
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    // Invisible units paint no pixels: skip them so a hidden cover never
    // steals a body hit from the visible unit below. Unknown (class-driven)
    // visibility still probes normally here; the hole path separately
    // fail-closes, preserving existing safe-SVG behavior.
    try {
      if (isDefinitelyHoleHidden(element)) continue;
    } catch {
      // Fall through to the import below.
    }
    const item = importPaperUnit(scope, element);
    if (!item) continue;
    try {
      const probe = isRtlVectorTextElement(element)
        ? (() => {
            const mirrored = rtlMirroredHitPoint(element, point)
            return new scope.Point(mirrored.x, mirrored.y)
          })()
        : target;
      const hit = item.hitTest(probe, { fill: true, stroke: true, tolerance, guide: false }) as unknown as {
        type?: string;
        item?: paper.Item;
      } | null;
      if (!hit) continue;
      const hitType: VectorFillHitType = hit.type === 'fill' ? 'fill' : 'stroke';
      const hitItem = (hit.item ?? item) as paper.Item;
      const tag = element.tagName.toLowerCase();
      const isText = tag === 'text' || (hitItem as unknown as { className?: string }).className === 'PointText';
      const parentClass = (hitItem as unknown as { parent?: { className?: string } }).parent?.className;
      const rawArea = (hitItem as unknown as { area?: unknown }).area;
      return {
        index,
        hitType,
        isText,
        hasFill: isText ? true : fillHitHasFill(element, hitItem),
        closed: isText ? true : fillHitClosed(element, hitItem),
        almostClosed: isText ? false : fillHitAlmostClosed(hitItem),
        parentIsCompoundPath: parentClass === 'CompoundPath',
        childArea: typeof rawArea === 'number' && Number.isFinite(rawArea) ? rawArea : undefined,
      };
    } finally {
      item.remove();
    }
  }
  return null;
}

// Vector fill-tool hole overlay target (Scratch `fill-tool.js` hole parity,
// reimplemented from behavior notes without copying upstream source).
//
// Stock Paper.js (`paper` 0.12.18) never reports compound-hole children: a
// hole interior yields no `hitTest` target at all, while the outer area hits
// the CompoundPath itself. The reference instead fills only the hole shape
// as a new overlay (transparent paint stays a no-op). This helper identifies
// that hole region from the real compound children, winding, and `fill-rule`
// (`evenodd` / `nonzero`) via Paper's own `contains` (which already respects
// the imported `fill-rule`), without guessing.
//
// Fail-closed contract (callers must treat `ambiguous` / `unsupported` as a
// no-op with an honest status, never as a parent recolor):
// - Only top-level `<path>` units with a multi-subpath CompoundPath are
//   overlay-capable. `<g>` nesting (hole inside a group child), text, raster,
//   `<use>`, single-contour paths/shapes, and clip/mask units report
//   `unsupported` (nested) or `none` instead of guessing geometry.
// - Overlap / nesting / order are checked: more than one hole candidate, a
//   hole containing an island, hole/hole or hole/outer boundary crossings,
//   degenerate bounds, `contains`/`hitTest` mismatches, and unsafe `pathData`
//   all report `ambiguous` (no history, no selection change).
// - Transforms ride the shared baked import (`bakedUnitClone` + fragment
//   sanitizer), so nested wrapper transforms are honored without moving
//   ancestors or siblings. Clip/mask units are declined: the baked import
//   does not apply ancestor clipping, so a hole under clipping would be
//   misplaced.
// - Boundary points are already fail-safe: a fill/stroke `hitTest` with the
//   zoom-aware tolerance runs first per unit, so a miss means the point sits
//   at least `tolerance` away from any painted edge. Remaining `contains`
//   checks are exact geometry.

/**
 * Nested-island Paper wiring (limited straight/curved subset, fail-closed).
 *
 * Stock Paper.js never reports compound-hole children, and the previous probe
 * refused every `containing.length !== 2` as `ambiguous`. The pure helpers
 * (`vector-fill-hole-geometry.ts` + flattened `vector-fill-hole-curves.ts`)
 * already classify the exact laminar subset (disjoint or strictly nested,
 * never touching; self-touch/crossings/partial overlap refuse; outer rings
 * containing an island stay `ambiguous`). This helper replays that exact
 * subset against the REAL Paper entities so Canvas 2D pixels, Paper
 * `contains`, and the pure geometry all agree before a nested inner hole is
 * allowed:
 * - similarity only (translation / rotation / uniform-scale): mirror,
 *   non-uniform, skew, and singular frames refuse (stricter than the straight
 *   helper's widened tolerance; same as the curved helper's gate);
 * - laminar audit on local (or flattened) contours with the same 1e-9 EPS;
 * - edge exclusion in local space (`tolerance / sMin` + flatten margin);
 * - both fill rules honored (Paper `contains` + pure parity/winding must
 *   agree on the containing set; `isPointFilled` must be unfilled);
 * - areas strictly decreasing, chain strictly nested, hole child-free;
 * - every Paper pair boundary-disjoint (`getIntersections` == 0);
 * - Paper hole/outer indices equal the pure hole/outer indices (unsorted `d`
 *   order is resolved by area rank, never by position);
 * - Paper hole bounds agree with the pure hole bounds mapped to document
 *   space within the edge margin (no shifted overlay).
 * Anything else stays fail-closed (`ambiguous`, island-bearing holes as
 * `unsupported`), never a hole. DOM/SVG bytes, Paper project, z-order,
 * history, and selection are untouched (pure inputs only + ephemeral Paper
 * entities owned by callers).
 */
type PureNestedResolution =
  | {
      ok: true;
      contours: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>;
      containing: number[];
      areas: number[];
      holeIndex: number;
      outerIndex: number;
      isCurved: boolean;
      uniformScale: number;
    }
  | { ok: false; reason: string; verdict: 'ambiguous' | 'unsupported' };

function paperTargetToDocument(target: unknown): { x: number; y: number } | undefined {
  try {
    const pt = target as { x?: unknown; y?: unknown };
    if (typeof pt.x === 'number' && typeof pt.y === 'number' && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      return { x: pt.x, y: pt.y };
    }
  } catch {
    // Fall through to undefined below.
  }
  return undefined;
}

function pureNestedResolutionForPaper(options: {
  data: string;
  documentPoint: { x: number; y: number };
  fillRuleValue: string;
  world: VectorMatrix | undefined;
  tolerance: number;
}): PureNestedResolution {
  const { data, documentPoint, fillRuleValue, world, tolerance } = options;
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
  const fillRule = normalizeFillRule(fillRuleValue);
  // Strict similarity for nested overlays (translation / rotation /
  // uniform-scale only). Mirrors, non-uniform scales, skews, and singular
  // frames refuse here even though the straight helper would widen the edge
  // zone for them: a nested overlay must place exactly, never approximately.
  let uniformScale = 1;
  if (world) {
    try {
      const gate = gateCurvedWorldMatrix(world as [number, number, number, number, number, number]);
      if (!gate.ok) return { ok: false, reason: `${gate.reason} (fail-closed)`, verdict: 'ambiguous' };
      uniformScale = gate.uniformScale;
    } catch {
      return { ok: false, reason: 'hole transform is unreadable (fail-closed)', verdict: 'ambiguous' };
    }
  }
  let contours:
    | Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>
    | undefined;
  let isCurved = false;
  try {
    if (isPathDataSafeForHoleGeometry(data)) {
      contours = parseStraightContours(data) ?? undefined;
      isCurved = false;
    } else if (isPathDataSafeForCurvedHoleGeometry(data)) {
      const flat = flattenCurvedContours(data, CURVED_FLATTEN_TOLERANCE);
      if (!flat) return { ok: false, reason: 'hole geometry is unreadable (fail-closed)', verdict: 'ambiguous' };
      contours = flat;
      isCurved = true;
    } else {
      return { ok: false, reason: 'hole geometry failed validation (fail-closed)', verdict: 'ambiguous' };
    }
  } catch {
    return { ok: false, reason: 'hole geometry is unreadable (fail-closed)', verdict: 'ambiguous' };
  }
  if (!contours || contours.length < 2) {
    return { ok: false, reason: 'hole geometry is unavailable (fail-closed)', verdict: 'ambiguous' };
  }
  // Exact laminar subset (same 1e-9 EPS as the straight helper): crossings,
  // contact (shared vertices included), self-touch, partial overlap, and
  // duplicates refuse here.
  try {
    const laminar = auditStraightNesting(contours as never);
    if (!laminar.ok) return { ok: false, reason: laminar.reason, verdict: 'ambiguous' };
  } catch {
    return { ok: false, reason: 'hole topology check failed (fail-closed)', verdict: 'ambiguous' };
  }
  let local = documentPoint;
  if (world) {
    try {
      const inverse = tryInvertVectorMatrix(world);
      if (!inverse) return { ok: false, reason: 'hole transform is unreadable (fail-closed)', verdict: 'ambiguous' };
      local = transformVectorPoint(inverse, documentPoint.x, documentPoint.y);
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
        return { ok: false, reason: 'hole transform maps point out of range (fail-closed)', verdict: 'ambiguous' };
      }
    } catch {
      return { ok: false, reason: 'hole transform is unreadable (fail-closed)', verdict: 'ambiguous' };
    }
  }
  // Boundary exclusion (same widening as the classifiers): a point within the
  // edge zone is never a hole, even for the innermost level.
  try {
    if (isCurved) {
      const docBase = Number.isFinite(safeTolerance) && safeTolerance > 0 ? safeTolerance : 0;
      const localBase = world
        ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], docBase)
        : docBase;
      if (!Number.isFinite(localBase)) {
        return { ok: false, reason: 'singular/unreadable transform (fail-closed)', verdict: 'ambiguous' };
      }
      const margin = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE);
      const localTolerance = localBase + margin;
      if (!Number.isFinite(localTolerance)) {
        return { ok: false, reason: 'singular/unreadable transform (fail-closed)', verdict: 'ambiguous' };
      }
      const edgeDistance = distanceToContours(contours as never, local as never);
      if (!Number.isFinite(edgeDistance) || !(edgeDistance > localTolerance)) {
        return { ok: false, reason: 'point is on/near a painted edge (fail-closed)', verdict: 'ambiguous' };
      }
    } else {
      const localTolerance = world
        ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], safeTolerance)
        : safeTolerance;
      const edgeDistance = distanceToContours(contours as never, local as never);
      if (!(edgeDistance > localTolerance)) {
        return { ok: false, reason: 'point is on/near a painted edge (fail-closed)', verdict: 'ambiguous' };
      }
    }
  } catch {
    return { ok: false, reason: 'hole boundary check failed (fail-closed)', verdict: 'ambiguous' };
  }
  let areas: number[] = [];
  try {
    areas = (contours as Array<{ points: Array<{ x: number; y: number }> }>).map((c) =>
      contourArea(c as never),
    );
  } catch {
    return { ok: false, reason: 'hole winding area is unreadable (fail-closed)', verdict: 'ambiguous' };
  }
  if (areas.some((area) => !Number.isFinite(area) || Math.abs(area) <= 1e-9)) {
    return { ok: false, reason: 'degenerate hole contour (fail-closed)', verdict: 'ambiguous' };
  }
  let containing: number[] = [];
  try {
    containing = containingContourIndices(contours as never, local as never, fillRule as never);
  } catch {
    return { ok: false, reason: 'hole probe failed (fail-closed)', verdict: 'ambiguous' };
  }
  if (containing.length === 0) {
    return { ok: false, reason: 'hole overlaps 0 contours (fail-closed)', verdict: 'ambiguous' };
  }
  try {
    if (isPointFilled(contours as never, local as never, fillRule as never)) {
      return { ok: false, reason: 'hole contains/hit mismatch at the painted edge (fail-closed)', verdict: 'ambiguous' };
    }
  } catch {
    return { ok: false, reason: 'hole probe failed (fail-closed)', verdict: 'ambiguous' };
  }
  try {
    const resolved = resolveNestedHole({ contours: contours as never, containing, areas });
    if (!resolved.ok) {
      // An outer ring containing an island surfaces here as
      // `hole contains an island contour`: keep the historical `unsupported`
      // verdict for that case so status surfaces stay stable.
      if (resolved.reason.includes('hole contains an island')) {
        return { ok: false, reason: resolved.reason, verdict: 'unsupported' };
      }
      return { ok: false, reason: resolved.reason, verdict: 'ambiguous' };
    }
    return {
      ok: true,
      contours,
      containing,
      areas,
      holeIndex: resolved.holeIndex,
      outerIndex: resolved.outerIndex,
      isCurved,
      uniformScale: Number.isFinite(uniformScale) && uniformScale > 0 ? uniformScale : 1,
    };
  } catch {
    return { ok: false, reason: 'hole probe failed (fail-closed)', verdict: 'ambiguous' };
  }
}

function collectCompoundPaths(item: unknown, out: Array<unknown> = []): Array<unknown> {
  // Iterative with the shared traversal budget: recursion overflowed the stack
  // on adversarial nesting, and returning collected-so-far as if complete
  // would miss a hole-bearing compound. Over-budget/unreadable throws the
  // private sentinel; callers map it to `ambiguous`.
  const stack: Array<unknown> = [item]
  let visited = 0
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    if (++visited > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    const current = stack.pop()!
    let holder: { className?: unknown; children?: unknown }
    try {
      holder = current as { className?: unknown; children?: unknown }
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (!holder) continue
    if (holder.className === 'CompoundPath') out.push(current)
    let children: unknown
    try {
      children = holder.children
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (Array.isArray(children)) {
      for (const child of children as Array<unknown>) stack.push(child)
    }
  }
  return out
}

type PathHoleProbe =
  | { kind: 'hole'; target: Omit<VectorHoleTarget, 'parentIndex'> }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

/**
 * Split an SVG `d` into subpath strings (each starting with `M`/`m`).
 * Returns `undefined` when the data cannot be split fail-closed (empty,
 * single contour, relative hole starts, or unsafe length). Relative `m`
 * hole starts are declined: their coords depend on the previous subpath,
 * so a standalone extraction would misplace the hole.
 */
/**
 * Nested resolution for real Paper `CompoundPath` children (fail-closed).
 * Only the innermost child-free unfilled level becomes a hole; outer rings
 * with an island child refuse via the pure resolver (`unsupported`), and
 * every Paper pair must be boundary-disjoint. Paper hole/outer indices must
 * equal the pure hole/outer indices and Paper bounds must agree with the
 * pure bounds mapped to document space.
 */
function probeNestedCompoundPathHole(
  children: Array<unknown>,
  containing: Array<unknown>,
  target: unknown,
  sourceElement: Element,
  tolerance: number,
): PathHoleProbe {
  try {
    const docPt = paperTargetToDocument(target);
    if (!docPt) return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
    const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
    // Strict laminar topology on the Paper entities first: every pair of
    // contours (not just the containing ones) must be boundary-disjoint.
    // Touching / crossing / coincident walls are renderer-dependent fill.
    for (let i = 0; i < children.length; i += 1) {
      for (let j = i + 1; j < children.length; j += 1) {
        let crossings: number | undefined;
        try {
          crossings = safePaperIntersectionsCount(children[i], children[j]);
        } catch {
          return { kind: 'ambiguous', reason: 'hole overlap check failed (fail-closed)' };
        }
        if (crossings === undefined) {
          return { kind: 'ambiguous', reason: 'hole boundary check failed (fail-closed)' };
        }
        if (crossings > 0) {
          return { kind: 'ambiguous', reason: 'hole touches another contour (fail-closed)' };
        }
      }
    }
    const paperAreas = containing.map((child) => safePaperArea(child));
    if (paperAreas.some((area) => area === undefined)) {
      return { kind: 'ambiguous', reason: 'hole winding area is unreadable (fail-closed)' };
    }
    const paperAbsolute = (paperAreas as Array<number>).map((area) => Math.abs(area));
    if (paperAbsolute.some((area) => !(area > 1e-9))) {
      return { kind: 'ambiguous', reason: 'degenerate hole contour (fail-closed)' };
    }
    const order = containing.map((_, slot) => slot).sort((a, b) => paperAbsolute[b]! - paperAbsolute[a]!);
    for (let k = 0; k + 1 < order.length; k += 1) {
      if (!(paperAbsolute[order[k]!]! > paperAbsolute[order[k + 1]!]!)) {
        return { kind: 'ambiguous', reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
      }
    }
    const paperHoleSlot = order[order.length - 1]!;
    const paperOuterSlot = order[order.length - 2]!;
    const hole = containing[paperHoleSlot]!;
    const outer = containing[paperOuterSlot]!;
    // Pure exact-subset confirmation on the DOM `d` (same 1e-9 EPS,
    // same winding/island rules, same edge zone). Without a readable local
    // `d` the nesting is unverifiable -> fail closed.
    let data = '';
    try {
      data = sourceElement.getAttribute('d') ?? '';
    } catch {
      return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
    }
    if (!data.trim()) {
      return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
    }
    let fillRuleValue = '';
    try {
      const resolved = resolveEffectiveHoleFillRule(sourceElement);
      if (resolved.kind === 'unknown') return { kind: 'unsupported', reason: resolved.reason };
      fillRuleValue = resolved.value;
    } catch {
      return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
    }
    let world: VectorMatrix | undefined;
    try {
      world = worldTransformMatrix(sourceElement) ?? undefined;
    } catch {
      return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
    }
    const pure = pureNestedResolutionForPaper({
      data,
      documentPoint: docPt,
      fillRuleValue,
      world,
      tolerance: safeTolerance,
    });
    if (!pure.ok) {
      return pure.verdict === 'unsupported'
        ? { kind: 'unsupported', reason: pure.reason }
        : { kind: 'ambiguous', reason: pure.reason };
    }
    // The Paper import must expose the same contour count as the DOM `d`
    // (one child per subpath); otherwise the index mapping below is unsafe.
    if (children.length !== pure.contours.length) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    if (pure.containing.length !== containing.length) {
      return { kind: 'ambiguous', reason: `hole overlaps ${containing.length} contours (fail-closed)` };
    }
    const paperChildIndices = containing.map((child) => children.indexOf(child));
    if (paperChildIndices.some((idx) => idx < 0)) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    const sortedPaper = [...paperChildIndices].sort((a, b) => a - b);
    const sortedPure = [...pure.containing].sort((a, b) => a - b);
    if (sortedPaper.length !== sortedPure.length || sortedPaper.some((v, i) => v !== sortedPure[i])) {
      return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
    }
    if (pure.holeIndex !== paperChildIndices[paperHoleSlot]! || pure.outerIndex !== paperChildIndices[paperOuterSlot]!) {
      return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
    }
    // No other contour may sit inside the claimed (innermost) hole; the
    // pure resolver already proved the hole child-free, this replays it on
    // the Paper entities (bounds + no-intersection above implies geometry).
    try {
      const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!holeBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      for (let i = 0; i < children.length; i += 1) {
        const other = children[i]!;
        if (other === hole || other === outer) continue;
        const otherBounds = (other as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
        if (
          otherBounds &&
          Number.isFinite(otherBounds.x) &&
          Number.isFinite(otherBounds.width) &&
          holeBounds.x <= otherBounds.x &&
          holeBounds.y <= otherBounds.y &&
          holeBounds.x + holeBounds.width >= otherBounds.x + otherBounds.width &&
          holeBounds.y + holeBounds.height >= otherBounds.y + otherBounds.height &&
          otherBounds.width > 0 &&
          otherBounds.height > 0
        ) {
          return { kind: 'unsupported', reason: 'hole contains an island contour (fail-closed)' };
        }
      }
      const outerBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!outerBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      const strictlyInside =
        outerBounds.x <= holeBounds.x &&
        outerBounds.y <= holeBounds.y &&
        outerBounds.x + outerBounds.width >= holeBounds.x + holeBounds.width &&
        outerBounds.y + outerBounds.height >= holeBounds.y + holeBounds.height;
      if (!strictlyInside) {
        return { kind: 'ambiguous', reason: 'hole is not strictly inside its outer contour (fail-closed)' };
      }
      // Target-local outer-inner confirmation: the mapped pure hole bounds
      // must agree with the Paper hole bounds within the edge margin.
      try {
        const pureHoleContour = pure.contours[pure.holeIndex]! as never;
        const pureDoc = documentBoundsForHole(pureHoleContour as never, world);
        const margin = pure.isCurved
          ? curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE) + safeTolerance + 1e-6
          : safeTolerance + 0.1 + 1e-6;
        const scale = Number.isFinite(pure.uniformScale) && pure.uniformScale > 0 ? pure.uniformScale : 1;
        const allowed = margin * scale;
        if (!Number.isFinite(allowed)) {
          return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
        }
        const centerDx = Math.abs(pureDoc.x + pureDoc.width / 2 - (holeBounds.x + holeBounds.width / 2));
        const centerDy = Math.abs(pureDoc.y + pureDoc.height / 2 - (holeBounds.y + holeBounds.height / 2));
        const sizeDx = Math.abs(pureDoc.width - holeBounds.width);
        const sizeDy = Math.abs(pureDoc.height - holeBounds.height);
        if (!Number.isFinite(centerDx) || !Number.isFinite(centerDy) || !Number.isFinite(sizeDx) || !Number.isFinite(sizeDy)) {
          return { kind: 'ambiguous', reason: 'hole geometry is unavailable (fail-closed)' };
        }
        if (!(centerDx <= allowed && centerDy <= allowed && sizeDx <= allowed && sizeDy <= allowed)) {
          return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
        }
      } catch {
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
    } catch {
      return { kind: 'ambiguous', reason: 'hole bounds check failed (fail-closed)' };
    }
    const rawPathData = (hole as { pathData?: unknown }).pathData;
    if (typeof rawPathData !== 'string' || !isHolePathDataSafe(rawPathData)) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    const documentBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds!;
    if (!Number.isFinite(documentBounds.x) || !Number.isFinite(documentBounds.y) || !(documentBounds.width > 0) || !(documentBounds.height > 0)) {
      return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
    }
    return {
      kind: 'hole',
      target: {
        holePathData: rawPathData,
        holeDocumentBounds: { x: documentBounds.x, y: documentBounds.y, width: documentBounds.width, height: documentBounds.height },
        parentTransform: sourceElement.getAttribute('transform') ?? '',
        parentFillRule: sourceElement.getAttribute('fill-rule') ?? '',
      },
    };
  } catch {
    return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
  }
}

/**
 * Outer-hole-with-island Paper confirmation (exact 3-contour straight subset).
 *
 * The pure classifier (`classifyOuterIslandHolePoint`) proves the laminar
 * triple on the DOM `d`; this helper replays the same triple against the real
 * Paper entities so Canvas 2D pixels, Paper `contains`, and pure geometry all
 * agree before an island-excluding overlay is allowed. Anything else stays
 * fail-closed (`ambiguous` / `unsupported`), never a hole.
 */
function confirmOuterIslandAgainstPaper(options: {
  data: string;
  documentPoint: { x: number; y: number };
  fillRuleValue: string;
  world: VectorMatrix | undefined;
  tolerance: number;
  paperHoleBounds: { x: number; y: number; width: number; height: number };
  paperOuterBounds: { x: number; y: number; width: number; height: number };
  paperChildIndices: number[];
  paperHoleDomIndex: number;
  paperOuterDomIndex: number;
  sourceElement: Element;
}): PathHoleProbe {
  const {
    data,
    documentPoint,
    fillRuleValue,
    world,
    tolerance,
    paperHoleBounds,
    paperOuterBounds,
    paperChildIndices,
    paperHoleDomIndex,
    paperOuterDomIndex,
    sourceElement,
  } = options;
  let pure: ReturnType<typeof classifyOuterIslandHolePoint>;
  try {
    pure = classifyOuterIslandHolePoint({
      pathData: data,
      point: documentPoint,
      fillRule: fillRuleValue,
      worldMatrix: (world ?? null) as [number, number, number, number, number, number] | null,
      tolerance,
    });
  } catch {
    return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
  }
  if (pure.kind !== 'hole') {
    if (pure.kind === 'unsupported') return { kind: 'unsupported', reason: pure.reason };
    if (pure.kind === 'filled' || pure.kind === 'outside') {
      return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
    }
    return { kind: 'ambiguous', reason: pure.reason };
  }
  const sortedPaper = [...paperChildIndices].sort((a, b) => a - b);
  const sortedPure = [...pure.containing].sort((a, b) => a - b);
  if (sortedPaper.length !== sortedPure.length || sortedPaper.some((v, i) => v !== sortedPure[i])) {
    return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
  }
  if (pure.holeIndex !== paperHoleDomIndex || pure.outerIndex !== paperOuterDomIndex) {
    return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
  }
  // The single non-containing contour must be the pure island.
  const allDom = [0, 1, 2];
  const paperIsland = allDom.find((i) => !paperChildIndices.includes(i));
  if (paperIsland === undefined || !pure.islandIndices.includes(paperIsland)) {
    return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
  }
  if (!pure.overlayPathData || !isHolePathDataSafe(pure.overlayPathData)) {
    return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
  }
  // Paper hole/outer bounds must agree with the pure hole bounds mapped to
  // document space (same margin as the nested probe: tolerance + 0.1).
  try {
    const pureDoc = documentBoundsForHole(
      { points: parseStraightContours(data)![pure.holeIndex]!.points, closed: true } as never,
      world,
    );
    const margin = tolerance + 0.1 + 1e-6;
    const centerDx = Math.abs(pureDoc.x + pureDoc.width / 2 - (paperHoleBounds.x + paperHoleBounds.width / 2));
    const centerDy = Math.abs(pureDoc.y + pureDoc.height / 2 - (paperHoleBounds.y + paperHoleBounds.height / 2));
    const sizeDx = Math.abs(pureDoc.width - paperHoleBounds.width);
    const sizeDy = Math.abs(pureDoc.height - paperHoleBounds.height);
    if (!Number.isFinite(centerDx) || !Number.isFinite(centerDy) || !Number.isFinite(sizeDx) || !Number.isFinite(sizeDy)) {
      return { kind: 'ambiguous', reason: 'hole geometry is unavailable (fail-closed)' };
    }
    if (!(centerDx <= margin && centerDy <= margin && sizeDx <= margin && sizeDy <= margin)) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    const strictlyInside =
      paperOuterBounds.x <= paperHoleBounds.x &&
      paperOuterBounds.y <= paperHoleBounds.y &&
      paperOuterBounds.x + paperOuterBounds.width >= paperHoleBounds.x + paperHoleBounds.width &&
      paperOuterBounds.y + paperOuterBounds.height >= paperHoleBounds.y + paperHoleBounds.height;
    if (!strictlyInside) {
      return { kind: 'ambiguous', reason: 'hole is not strictly inside its outer contour (fail-closed)' };
    }
  } catch {
    return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
  }
  if (!(paperHoleBounds.width > 0 && paperHoleBounds.height > 0)) {
    return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
  }
  return {
    kind: 'hole',
    target: {
      holePathData: pure.overlayPathData,
      holeDocumentBounds: { x: paperHoleBounds.x, y: paperHoleBounds.y, width: paperHoleBounds.width, height: paperHoleBounds.height },
      parentTransform: sourceElement.getAttribute('transform') ?? '',
      parentFillRule: sourceElement.getAttribute('fill-rule') ?? '',
    },
  };
}

function splitPathDataIntoSubpaths(data: string): string[] | undefined {
  if (typeof data !== 'string') return undefined;
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed.length > 20000) return undefined;
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === 'M' || ch === 'm') starts.push(i);
  }
  if (starts.length < 2) return undefined;
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1]! : trimmed.length;
    const part = trimmed.slice(starts[i]!, end).trim();
    if (!part) return undefined;
    parts.push(part);
  }
  // Fail-closed for relative hole starts (all but the first must be absolute
  // `M`; a leading `m` is treated as absolute per SVG, so allow it once).
  for (let i = 0; i < parts.length; i += 1) {
    const first = parts[i]![0];
    if (first !== 'M' && first !== 'm') return undefined;
    if (i > 0 && first !== 'M') return undefined;
  }
  return parts;
}

function probeCompoundPathHole(
  compound: unknown,
  target: unknown,
  sourceElement: Element,
  tolerance = 0.5,
): PathHoleProbe {
  try {
    const holder = compound as {
      children?: Array<unknown>;
      contains?: (point: unknown) => boolean;
      bounds?: { x: number; y: number; width: number; height: number };
    };
    const children = Array.isArray(holder.children) ? holder.children : [];
    if (children.length < 2) return { kind: 'none' };
    const compoundContains = safePaperContains(compound, target);
    if (compoundContains) {
      // `contains` says filled but the fill/stroke `hitTest` missed: treat as
      // a boundary/mismatch case instead of inventing a hole.
      return { kind: 'ambiguous', reason: 'hole contains/hit mismatch at the painted edge (fail-closed)' };
    }
    const containing = children.filter((child) => safePaperContains(child, target));
    if (containing.length === 0) return { kind: 'none' };
    // Nested islands: an unfilled point inside >2 contours is the innermost
    // child-free hole of a strictly laminar family (outer -> hole -> island
    // -> hole). Only that level becomes an overlay; outer rings containing an
    // island stay fail-closed. Anything outside the exact subset refuses.
    if (containing.length > 2) {
      return probeNestedCompoundPathHole(children, containing, target, sourceElement, tolerance);
    }
    // A true donut hole contains exactly the outer contour plus the hole
    // contour (outer + one hole). A single containing contour with an
    // unfilled interior is overlap/nesting ambiguity, never a hole.
    if (containing.length !== 2) {
      return { kind: 'ambiguous', reason: `hole overlaps ${containing.length} contours (fail-closed)` };
    }
    const areas = containing.map((child) => safePaperArea(child));
    if (areas.some((area) => area === undefined)) {
      return { kind: 'ambiguous', reason: 'hole winding area is unreadable (fail-closed)' };
    }
    const absolute = (areas as Array<number>).map((area) => Math.abs(area));
    if (absolute.some((area) => !(area > 1e-9))) {
      return { kind: 'ambiguous', reason: 'degenerate hole contour (fail-closed)' };
    }
    let holeIndex = 0;
    let outerIndex = 1;
    if (absolute[1]! < absolute[0]!) {
      holeIndex = 1;
      outerIndex = 0;
    }
    if (absolute[holeIndex]! >= absolute[outerIndex]!) {
      return { kind: 'ambiguous', reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
    }
    const hole = containing[holeIndex]!;
    const outer = containing[outerIndex]!;
    const holeOuterCrossings = safePaperIntersectionsCount(hole, outer);
    if (holeOuterCrossings === undefined) {
      return { kind: 'ambiguous', reason: 'hole boundary check failed (fail-closed)' };
    }
    if (holeOuterCrossings > 0) {
      return { kind: 'ambiguous', reason: 'hole boundary crosses its outer contour (fail-closed)' };
    }
    // No other contour may touch the hole (overlapping holes) or sit
    // strictly inside it (island that the single-path overlay would cover).
    const allChildren = children;
    for (const other of allChildren) {
      if (other === hole) continue;
      const crossings = safePaperIntersectionsCount(hole, other);
      if (crossings === undefined) {
        return { kind: 'ambiguous', reason: 'hole overlap check failed (fail-closed)' };
      }
      if (crossings > 0) {
        return { kind: 'ambiguous', reason: 'hole touches another contour (fail-closed)' };
      }
    }
    for (const other of allChildren) {
      if (other === hole || other === outer) continue;
      try {
        const otherBounds = (other as { bounds?: { x: number; y: number; width: number; height: number; center?: unknown } }).bounds;
        const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
        if (
          otherBounds &&
          holeBounds &&
          Number.isFinite(otherBounds.x) &&
          Number.isFinite(otherBounds.width) &&
          holeBounds.x <= otherBounds.x &&
          holeBounds.y <= otherBounds.y &&
          holeBounds.x + holeBounds.width >= otherBounds.x + otherBounds.width &&
          holeBounds.y + holeBounds.height >= otherBounds.y + otherBounds.height &&
          otherBounds.width > 0 &&
          otherBounds.height > 0
        ) {
          // Well-formed safe subset: exactly 3 laminar contours where the
          // outer hole contains a single island. A solid single-path overlay
          // would bleed over the island, so prove the island-excluding
          // compound (hole + island, opposite winding) against the DOM `d`
          // and the Paper entities. Anything else stays fail-closed.
          if (children.length === 3) {
            try {
              const docPt = paperTargetToDocument(target);
              if (!docPt) return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
              let outerData = '';
              try {
                outerData = sourceElement.getAttribute('d') ?? '';
              } catch {
                return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
              }
              if (!outerData.trim()) return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
              let outerFillRule = '';
              try {
                const resolved = resolveEffectiveHoleFillRule(sourceElement);
                if (resolved.kind === 'unknown') return { kind: 'unsupported', reason: resolved.reason };
                outerFillRule = resolved.value;
              } catch {
                return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
              }
              let outerWorld: VectorMatrix | undefined;
              try {
                outerWorld = worldTransformMatrix(sourceElement) ?? undefined;
              } catch {
                return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
              }
              const safeOuterTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
              // All three Paper pairs must be boundary-disjoint (laminar).
              let outerIslandOk = true;
              for (let a = 0; a < children.length; a += 1) {
                for (let b = a + 1; b < children.length; b += 1) {
                  let cross: number | undefined;
                  try {
                    cross = safePaperIntersectionsCount(children[a], children[b]);
                  } catch {
                    cross = undefined;
                  }
                  if (cross === undefined || cross > 0) outerIslandOk = false;
                }
              }
              if (outerIslandOk) {
                const paperHoleBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds!;
                const paperOuterBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds!;
                if (paperHoleBounds && paperOuterBounds) {
                  const paperChildIndices = containing.map((child) => children.indexOf(child));
                  if (!paperChildIndices.some((idx) => idx < 0)) {
                    const childHoleDom = children.indexOf(hole);
                    const childOuterDom = children.indexOf(outer);
                    const confirmed = confirmOuterIslandAgainstPaper({
                      data: outerData,
                      documentPoint: docPt,
                      fillRuleValue: outerFillRule,
                      world: outerWorld,
                      tolerance: safeOuterTolerance,
                      paperHoleBounds,
                      paperOuterBounds,
                      paperChildIndices,
                      paperHoleDomIndex: childHoleDom,
                      paperOuterDomIndex: childOuterDom,
                      sourceElement,
                    });
                    if (confirmed.kind === 'hole') return confirmed;
                    if (confirmed.kind === 'unsupported') return confirmed;
                  }
                }
              }
            } catch {
              // Fall through to the historical fail-closed verdict below.
            }
          }
          return { kind: 'unsupported', reason: 'hole contains an island contour (fail-closed)' };
        }
      } catch {
        return { kind: 'ambiguous', reason: 'hole island check failed (fail-closed)' };
      }
    }
    // Outer must strictly contain the hole bounds (no protruding holes).
    try {
      const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      const outerBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!holeBounds || !outerBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      const strictlyInside =
        outerBounds.x <= holeBounds.x &&
        outerBounds.y <= holeBounds.y &&
        outerBounds.x + outerBounds.width >= holeBounds.x + holeBounds.width &&
        outerBounds.y + outerBounds.height >= holeBounds.y + holeBounds.height;
      if (!strictlyInside) {
        return { kind: 'ambiguous', reason: 'hole is not strictly inside its outer contour (fail-closed)' };
      }
    } catch {
      return { kind: 'ambiguous', reason: 'hole bounds check failed (fail-closed)' };
    }
    const rawPathData = (hole as { pathData?: unknown }).pathData;
    if (typeof rawPathData !== 'string' || !isHolePathDataSafe(rawPathData)) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    const documentBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds!;
    if (!Number.isFinite(documentBounds.x) || !Number.isFinite(documentBounds.y) || !(documentBounds.width > 0) || !(documentBounds.height > 0)) {
      return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
    }
    return {
      kind: 'hole',
      target: {
        holePathData: rawPathData,
        holeDocumentBounds: { x: documentBounds.x, y: documentBounds.y, width: documentBounds.width, height: documentBounds.height },
        parentTransform: sourceElement.getAttribute('transform') ?? '',
        parentFillRule: sourceElement.getAttribute('fill-rule') ?? '',
      },
    };
  } catch {
    return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
  }
}

/**
 * Nested resolution for stock single-`Path` subpath temps (fail-closed).
 * Mirrors `probeNestedCompoundPathHole` but operates on the document-space
 * temps: global laminar disjointness, strictly decreasing Paper areas, pure
 * exact-subset confirmation on the DOM `d`, index-equality between Paper and
 * pure containing sets, hole/outer equality, island/outer bounds, and
 * document-bounds agreement. Only the innermost child-free level becomes a
 * hole.
 */
function probeNestedSubpathHole(
  temps: Array<{ path: unknown; localPathData: string }>,
  containingIndices: number[],
  target: unknown,
  sourceElement: Element,
  tolerance: number,
): PathHoleProbe {
  try {
    const docPt = paperTargetToDocument(target);
    if (!docPt) return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
    const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
    for (let i = 0; i < temps.length; i += 1) {
      for (let j = i + 1; j < temps.length; j += 1) {
        let crossings: number | undefined;
        try {
          crossings = safePaperIntersectionsCount(temps[i]!.path, temps[j]!.path);
        } catch {
          return { kind: 'ambiguous', reason: 'hole overlap check failed (fail-closed)' };
        }
        if (crossings === undefined) {
          return { kind: 'ambiguous', reason: 'hole boundary check failed (fail-closed)' };
        }
        if (crossings > 0) {
          return { kind: 'ambiguous', reason: 'hole touches another contour (fail-closed)' };
        }
      }
    }
    const areas = containingIndices.map((idx) => {
      try {
        return Math.abs((temps[idx]!.path as { area?: number }).area ?? Number.NaN);
      } catch {
        return Number.NaN;
      }
    });
    const resolvedAreas = areas.map((area, k) => {
      if (Number.isFinite(area) && (area as number) > 1e-9) return area as number;
      try {
        const b = (temps[containingIndices[k]!]!.path as { bounds?: { width: number; height: number } }).bounds;
        if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return Math.abs(b.width * b.height);
      } catch {
        // Fall through to NaN below.
      }
      return Number.NaN;
    });
    if (resolvedAreas.some((area) => !Number.isFinite(area) || !(area > 1e-9))) {
      return { kind: 'ambiguous', reason: 'hole winding area is unreadable (fail-closed)' };
    }
    const order = containingIndices.map((_, slot) => slot).sort((a, b) => resolvedAreas[b]! - resolvedAreas[a]!);
    for (let k = 0; k + 1 < order.length; k += 1) {
      if (!(resolvedAreas[order[k]!]! > resolvedAreas[order[k + 1]!]!)) {
        return { kind: 'ambiguous', reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
      }
    }
    const paperHoleSlot = order[order.length - 1]!;
    const paperOuterSlot = order[order.length - 2]!;
    const holeIdx = containingIndices[paperHoleSlot]!;
    const outerIdx = containingIndices[paperOuterSlot]!;
    const hole = temps[holeIdx]!.path;
    const outer = temps[outerIdx]!.path;
    let data = '';
    try {
      data = sourceElement.getAttribute('d') ?? '';
    } catch {
      return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
    }
    let fillRuleValue = '';
    try {
      const resolved = resolveEffectiveHoleFillRule(sourceElement);
      if (resolved.kind === 'unknown') return { kind: 'unsupported', reason: resolved.reason };
      fillRuleValue = resolved.value;
    } catch {
      return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
    }
    let world: VectorMatrix | undefined;
    try {
      world = worldTransformMatrix(sourceElement) ?? undefined;
    } catch {
      return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
    }
    const pure = pureNestedResolutionForPaper({
      data,
      documentPoint: docPt,
      fillRuleValue,
      world,
      tolerance: safeTolerance,
    });
    if (!pure.ok) {
      return pure.verdict === 'unsupported'
        ? { kind: 'unsupported', reason: pure.reason }
        : { kind: 'ambiguous', reason: pure.reason };
    }
    if (pure.contours.length !== temps.length) {
      return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
    }
    if (pure.containing.length !== containingIndices.length) {
      return { kind: 'ambiguous', reason: `hole overlaps ${containingIndices.length} contours (fail-closed)` };
    }
    const sortedPaper = [...containingIndices].sort((a, b) => a - b);
    const sortedPure = [...pure.containing].sort((a, b) => a - b);
    if (sortedPaper.length !== sortedPure.length || sortedPaper.some((v, i) => v !== sortedPure[i])) {
      return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
    }
    if (pure.holeIndex !== holeIdx || pure.outerIndex !== outerIdx) {
      return { kind: 'ambiguous', reason: 'Canvas and Paper disagree on hole contour (fail-closed)' };
    }
    try {
      const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!holeBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      for (let i = 0; i < temps.length; i += 1) {
        if (i === holeIdx || i === outerIdx) continue;
        const otherBounds = (temps[i]!.path as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
        if (
          otherBounds &&
          holeBounds.x <= otherBounds.x &&
          holeBounds.y <= otherBounds.y &&
          holeBounds.x + holeBounds.width >= otherBounds.x + otherBounds.width &&
          holeBounds.y + holeBounds.height >= otherBounds.y + otherBounds.height &&
          otherBounds.width > 0 &&
          otherBounds.height > 0
        ) {
          return { kind: 'unsupported', reason: 'hole contains an island contour (fail-closed)' };
        }
      }
      const outerBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!outerBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      const strictlyInside =
        outerBounds.x <= holeBounds.x &&
        outerBounds.y <= holeBounds.y &&
        outerBounds.x + outerBounds.width >= holeBounds.x + holeBounds.width &&
        outerBounds.y + outerBounds.height >= holeBounds.y + holeBounds.height;
      if (!strictlyInside) {
        return { kind: 'ambiguous', reason: 'hole is not strictly inside its outer contour (fail-closed)' };
      }
      try {
        const pureHoleContour = pure.contours[pure.holeIndex]! as never;
        const pureDoc = documentBoundsForHole(pureHoleContour as never, world);
        const margin = pure.isCurved
          ? curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE) + safeTolerance + 1e-6
          : safeTolerance + 0.1 + 1e-6;
        const scale = Number.isFinite(pure.uniformScale) && pure.uniformScale > 0 ? pure.uniformScale : 1;
        const allowed = margin * scale;
        if (!Number.isFinite(allowed)) {
          return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
        }
        const centerDx = Math.abs(pureDoc.x + pureDoc.width / 2 - (holeBounds.x + holeBounds.width / 2));
        const centerDy = Math.abs(pureDoc.y + pureDoc.height / 2 - (holeBounds.y + holeBounds.height / 2));
        const sizeDx = Math.abs(pureDoc.width - holeBounds.width);
        const sizeDy = Math.abs(pureDoc.height - holeBounds.height);
        if (!Number.isFinite(centerDx) || !Number.isFinite(centerDy) || !Number.isFinite(sizeDx) || !Number.isFinite(sizeDy)) {
          return { kind: 'ambiguous', reason: 'hole geometry is unavailable (fail-closed)' };
        }
        if (!(centerDx <= allowed && centerDy <= allowed && sizeDx <= allowed && sizeDy <= allowed)) {
          return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
        }
      } catch {
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
      const holeDocumentBounds = { x: holeBounds.x, y: holeBounds.y, width: holeBounds.width, height: holeBounds.height };
      if (!(holeDocumentBounds.width > 0 && holeDocumentBounds.height > 0)) {
        return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
      }
      const localPathData = temps[holeIdx]!.localPathData;
      if (!isHolePathDataSafe(localPathData)) {
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
      return {
        kind: 'hole',
        target: {
          holePathData: localPathData,
          holeDocumentBounds,
          parentTransform: sourceElement.getAttribute('transform') ?? '',
          parentFillRule: sourceElement.getAttribute('fill-rule') ?? '',
        },
      };
    } catch {
      return { kind: 'ambiguous', reason: 'hole bounds check failed (fail-closed)' };
    }
  } catch {
    return { kind: 'ambiguous', reason: 'hole probe failed (fail-closed)' };
  }
}

/**
 * Subpath-based hole probe for stock Paper.js single-`Path` imports.
 * Stock `importSVG` for `<path d="outer inner">` yields a `Group` holding one
 * multi-subpath `Path` (not a `CompoundPath`), so the child-based probe above
 * never runs. This splits the real `d` into subpaths and tests each contour
 * in document coords (global matrix baked in), honoring `evenodd`/`nonzero`
 * via the original item's `contains` and ancestor transforms via the shared
 * baked import.
 */
function probeSubpathHole(
  scope: paper.PaperScope,
  sourceElement: Element,
  item: paper.Item,
  target: unknown,
  tolerance = 0.5,
): PathHoleProbe {
  const data = sourceElement.getAttribute('d') ?? '';
  const subpaths = splitPathDataIntoSubpaths(data);
  if (!subpaths) return { kind: 'none' };
  // Map local subpaths to document coords with the DOM world matrix
  // (`worldTransformMatrix`), never Paper's `globalMatrix`: Paper bakes
  // nonuniform scales into geometry (leaving an identity matrix), so the
  // Paper matrix would leave temps in local coords and misplace holes.
  // The DOM matrix always reflects ancestors + own transform.
  let documentMatrix: VectorMatrix | undefined;
  try {
    documentMatrix = worldTransformMatrix(sourceElement) ?? [1, 0, 0, 1, 0, 0];
  } catch {
    return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
  }
  let globalMatrix: unknown;
  try {
    globalMatrix = new scope.Matrix(
      documentMatrix[0],
      documentMatrix[1],
      documentMatrix[2],
      documentMatrix[3],
      documentMatrix[4],
      documentMatrix[5],
    );
    if (!globalMatrix) return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
  } catch {
    return { kind: 'ambiguous', reason: 'hole transform is unreadable (fail-closed)' };
  }
  const temps: Array<{ path: unknown; localPathData: string }> = [];
  try {
    for (const part of subpaths) {
      if (!isHolePathDataSafe(part)) {
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
      let temp: unknown;
      try {
        const created = new scope.Path() as unknown as { pathData?: string };
        created.pathData = part;
        temp = created;
      } catch {
        return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
      }
      let localPathData: string;
      try {
        localPathData = (temp as { pathData?: unknown }).pathData as string;
      } catch {
        try {
          (temp as { remove?: () => void }).remove?.();
        } catch {
          // Ignore cleanup failure.
        }
        return { kind: 'ambiguous', reason: 'hole geometry is unreadable (fail-closed)' };
      }
      if (typeof localPathData !== 'string' || !isHolePathDataSafe(localPathData)) {
        try {
          (temp as { remove?: () => void }).remove?.();
        } catch {
          // Ignore cleanup failure.
        }
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
      try {
        (temp as { transform?: (matrix: unknown) => void }).transform?.(globalMatrix as never);
      } catch {
        try {
          (temp as { remove?: () => void }).remove?.();
        } catch {
          // Ignore cleanup failure.
        }
        return { kind: 'ambiguous', reason: 'hole transform failed (fail-closed)' };
      }
      temps.push({ path: temp, localPathData });
    }
    const compoundContains = safePaperContains(item, target);
    if (compoundContains) {
      return { kind: 'ambiguous', reason: 'hole contains/hit mismatch at the painted edge (fail-closed)' };
    }
    const containingIndices: number[] = [];
    for (let i = 0; i < temps.length; i += 1) {
      if (safePaperContains(temps[i]!.path, target)) containingIndices.push(i);
    }
    if (containingIndices.length === 0) return { kind: 'none' };
    if (containingIndices.length > 2) {
      const nested = probeNestedSubpathHole(temps, containingIndices, target, sourceElement, tolerance);
      // `probeNestedSubpathHole` owns its fail-closed verdicts; a `hole`
      // carries the local subpath outline + document bounds for the overlay.
      // Anything else preserves the previous fail-closed contract (never a
      // parent recolor). Temps are still owned by this function (cleaned in
      // `finally` below), so return directly.
      return nested;
    }
    if (containingIndices.length !== 2) {
      return { kind: 'ambiguous', reason: `hole overlaps ${containingIndices.length} contours (fail-closed)` };
    }
    const areas = containingIndices.map((idx) => {
      try {
        return Math.abs((temps[idx]!.path as { length?: number; area?: number }).area ?? Number.NaN);
      } catch {
        return Number.NaN;
      }
    });
    // `area` on a transformed temp is in document units; fall back to bounds
    // area when unreadable (still fail-closed below on degenerate).
    const resolved = areas.map((area, k) => {
      if (Number.isFinite(area) && area > 1e-9) return area;
      try {
        const b = (temps[containingIndices[k]!]!.path as { bounds?: { width: number; height: number } }).bounds;
        if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return Math.abs(b.width * b.height);
      } catch {
        // Fall through to NaN below.
      }
      return Number.NaN;
    });
    if (resolved.some((area) => !Number.isFinite(area) || !(area > 1e-9))) {
      return { kind: 'ambiguous', reason: 'hole winding area is unreadable (fail-closed)' };
    }
    let holeSlot = 0;
    let outerSlot = 1;
    if (resolved[1]! < resolved[0]!) {
      holeSlot = 1;
      outerSlot = 0;
    }
    if (resolved[holeSlot]! >= resolved[outerSlot]!) {
      return { kind: 'ambiguous', reason: 'hole is not strictly smaller than its outer contour (fail-closed)' };
    }
    const holeIdx = containingIndices[holeSlot]!;
    const outerIdx = containingIndices[outerSlot]!;
    const hole = temps[holeIdx]!.path;
    const outer = temps[outerIdx]!.path;
    const holeOuterCrossings = safePaperIntersectionsCount(hole, outer);
    if (holeOuterCrossings === undefined) {
      return { kind: 'ambiguous', reason: 'hole boundary check failed (fail-closed)' };
    }
    if (holeOuterCrossings > 0) {
      return { kind: 'ambiguous', reason: 'hole boundary crosses its outer contour (fail-closed)' };
    }
    for (let i = 0; i < temps.length; i += 1) {
      if (i === holeIdx) continue;
      const crossings = safePaperIntersectionsCount(hole, temps[i]!.path);
      if (crossings === undefined) {
        return { kind: 'ambiguous', reason: 'hole overlap check failed (fail-closed)' };
      }
      if (crossings > 0) {
        return { kind: 'ambiguous', reason: 'hole touches another contour (fail-closed)' };
      }
    }
    // Island check: any other contour strictly inside the hole bounds.
    try {
      const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!holeBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      for (let i = 0; i < temps.length; i += 1) {
        if (i === holeIdx || i === outerIdx) continue;
        const otherBounds = (temps[i]!.path as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
        if (
          otherBounds &&
          holeBounds.x <= otherBounds.x &&
          holeBounds.y <= otherBounds.y &&
          holeBounds.x + holeBounds.width >= otherBounds.x + otherBounds.width &&
          holeBounds.y + holeBounds.height >= otherBounds.y + otherBounds.height &&
          otherBounds.width > 0 &&
          otherBounds.height > 0
        ) {
          if (temps.length === 3) {
            try {
              const docPt = paperTargetToDocument(target);
              if (docPt) {
                const subData = sourceElement.getAttribute('d') ?? '';
                if (subData.trim()) {
                  let subFillRule = '';
                  let subUnknown = false;
                  try {
                    const resolved = resolveEffectiveHoleFillRule(sourceElement);
                    if (resolved.kind === 'unknown') subUnknown = true;
                    else subFillRule = resolved.value;
                  } catch {
                    subUnknown = true;
                  }
                  if (!subUnknown) {
                    let subWorld: VectorMatrix | undefined;
                    try {
                      subWorld = worldTransformMatrix(sourceElement) ?? undefined;
                    } catch {
                      subWorld = undefined;
                    }
                    const safeSubTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
                    let tempsDisjoint = true;
                    for (let a = 0; a < temps.length; a += 1) {
                      for (let b = a + 1; b < temps.length; b += 1) {
                        let cross: number | undefined;
                        try {
                          cross = safePaperIntersectionsCount(temps[a]!.path, temps[b]!.path);
                        } catch {
                          cross = undefined;
                        }
                        if (cross === undefined || cross > 0) tempsDisjoint = false;
                      }
                    }
                    if (tempsDisjoint) {
                      const subOuterBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds!;
                      if (subOuterBounds) {
                        const confirmed = confirmOuterIslandAgainstPaper({
                          data: subData,
                          documentPoint: docPt,
                          fillRuleValue: subFillRule,
                          world: subWorld,
                          tolerance: safeSubTolerance,
                          paperHoleBounds: holeBounds,
                          paperOuterBounds: subOuterBounds,
                          paperChildIndices: [...containingIndices],
                          paperHoleDomIndex: holeIdx,
                          paperOuterDomIndex: outerIdx,
                          sourceElement,
                        });
                        if (confirmed.kind === 'hole') return confirmed;
                        if (confirmed.kind === 'unsupported') return confirmed;
                      }
                    }
                  }
                }
              }
            } catch {
            }
          }
          return { kind: 'unsupported', reason: 'hole contains an island contour (fail-closed)' };
        }
      }
      const outerBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
      if (!outerBounds) return { kind: 'ambiguous', reason: 'hole bounds are unreadable (fail-closed)' };
      const strictlyInside =
        outerBounds.x <= holeBounds.x &&
        outerBounds.y <= holeBounds.y &&
        outerBounds.x + outerBounds.width >= holeBounds.x + holeBounds.width &&
        outerBounds.y + outerBounds.height >= holeBounds.y + holeBounds.height;
      if (!strictlyInside) {
        return { kind: 'ambiguous', reason: 'hole is not strictly inside its outer contour (fail-closed)' };
      }
      const holeDocumentBounds = { x: holeBounds.x, y: holeBounds.y, width: holeBounds.width, height: holeBounds.height };
      if (!(holeDocumentBounds.width > 0 && holeDocumentBounds.height > 0)) {
        return { kind: 'ambiguous', reason: 'degenerate hole bounds (fail-closed)' };
      }
      const localPathData = temps[holeIdx]!.localPathData;
      if (!isHolePathDataSafe(localPathData)) {
        return { kind: 'ambiguous', reason: 'hole geometry failed validation (fail-closed)' };
      }
      return {
        kind: 'hole',
        target: {
          holePathData: localPathData,
          holeDocumentBounds,
          parentTransform: sourceElement.getAttribute('transform') ?? '',
          parentFillRule: sourceElement.getAttribute('fill-rule') ?? '',
        },
      };
    } catch {
      return { kind: 'ambiguous', reason: 'hole bounds check failed (fail-closed)' };
    }
  } finally {
    for (const temp of temps) {
      try {
        (temp.path as { remove?: () => void }).remove?.();
      } catch {
        // Best effort cleanup for ephemeral probes.
      }
    }
  }
}

/**
 * Post-guard for a Paper-claimed hole: the geometric `contains` above used
 * the baked import (attributes + baked style paint), but stylesheet-driven
 * (`class`) paint / `fill-rule` / visibility / opacity and inherited
 * `url()` paint cannot be computed detached. A detached `getComputedStyle`
 * is unreliable (no cascade, no layout), so any such unknown downgrades the
 * hole to `unsupported` (never a parent recolor, never an overlay). Definite
 * invisibility (`display:none` / hidden / opacity 0) or definite `fill:none`
 * downgrades to `none` (nothing rendered). Far-outside points never reach
 * here (Paper returned `none`), so existing safe SVG is unaffected.
 */
function guardPaperHoleWithComputedSemantics(element: Element, probe: PathHoleProbe): PathHoleProbe {
  if (probe.kind !== 'hole') return probe;
  try {
    const paint = classifyHoleEffectiveFill(element);
    if (paint.kind === 'none') return { kind: 'none' };
    if (paint.kind === 'unsupported') return { kind: 'unsupported', reason: paint.reason };
    const rule = resolveEffectiveHoleFillRule(element);
    if (rule.kind === 'unknown') return { kind: 'unsupported', reason: rule.reason };
    const stroke = resolveInheritedHoleProperty(element, 'stroke');
    if (stroke.status === 'unknown') {
      return { kind: 'unsupported', reason: (stroke as { reason: string }).reason };
    }
    if (stroke.status === 'value' && /url\s*\(/i.test(stroke.value)) {
      return { kind: 'unsupported', reason: 'inherited url(#...) stroke needs defs resolution (fail-closed)' };
    }
  } catch {
    return { kind: 'unsupported', reason: 'unreadable computed paint (fail-closed)' };
  }
  return probe;
}

async function probePathElementHole(
  scope: paper.PaperScope,
  element: Element,
  target: unknown,
  tolerance: number,
): Promise<PathHoleProbe> {
  const data = element.getAttribute('d') ?? '';
  if (!data.trim()) return { kind: 'none' };
  // Definite invisibility or definite empty fill: no hole without importing.
  try {
    if (isDefinitelyHoleHidden(element)) return { kind: 'none' };
    const paint = classifyHoleEffectiveFill(element);
    if (paint.kind === 'none') return { kind: 'none' };
  } catch {
    // Fall through to the Paper import below.
  }
  const item = importPaperUnit(scope, element);
  if (!item) return { kind: 'none' };
  try {
    // Unfilled parents have no hole: their interior is already empty.
    // Prefer the computed (style-first, inherited) fill so
    // `style="fill:none"` / inherited `fill="none"` (which Paper's
    // `hasFill()` may miss when the baked import drops style) is honored;
    // fall back to Paper's `hasFill()` only for stylesheet-unknown paint.
    try {
      const paint = classifyHoleEffectiveFill(element);
      if (paint.kind === 'none') return { kind: 'none' };
      if (paint.kind === 'unsupported') {
        const maybeHasFill = (item as unknown as { hasFill?: () => boolean }).hasFill;
        if (typeof maybeHasFill === 'function' && !maybeHasFill.call(item)) return { kind: 'none' };
      } else {
        const maybeHasFill = (item as unknown as { hasFill?: () => boolean }).hasFill;
        if (typeof maybeHasFill === 'function') {
          try {
            if (!maybeHasFill.call(item)) {
              // Paper agrees the parent is unfilled; honor the computed
              // painted state (Paper may miss style-driven fill, so only
              // treat as empty when both agree).
              const computedPainted = paint.kind === 'painted';
              if (!computedPainted) return { kind: 'none' };
            }
          } catch {
            return { kind: 'ambiguous', reason: 'hole fill check failed (fail-closed)' };
          }
        }
      }
    } catch {
      return { kind: 'ambiguous', reason: 'hole fill check failed (fail-closed)' };
    }
    if ((item as unknown as { clipMask?: boolean }).clipMask) {
      return { kind: 'unsupported', reason: 'clip-mask hole (fail-closed)' };
    }
    const hit = (item as unknown as { hitTest?: (point: unknown, options: unknown) => unknown }).hitTest?.(target, {
      fill: true,
      stroke: true,
      tolerance,
      guide: false,
    });
    if (hit) return { kind: 'none' };
    // Prefer the subpath probe for multi-subpath `d`: it keeps the hole
    // outline in unit-local coords (`parentTransform` = own transform), so
    // the sibling overlay never double-applies a baked document-space
    // outline. The CompoundPath branch below can carry Paper-baked
    // document coords (nonuniform scales bake geometry into `pathData`),
    // which would misplace the overlay when combined with the own
    // transform again.
    if (splitPathDataIntoSubpaths(data)) {
      const subpath = probeSubpathHole(scope, element, item, target, tolerance);
      if (subpath.kind !== 'none') return guardPaperHoleWithComputedSemantics(element, subpath);
    }
    const className = (item as unknown as { className?: string }).className;
    if (className === 'CompoundPath') return guardPaperHoleWithComputedSemantics(element, probeCompoundPathHole(item, target, element, tolerance));
    // Stock Paper.js imports `<path d="outer inner">` as a Group holding one
    // multi-subpath Path (not a CompoundPath). Fall back to the subpath probe
    // so evenodd/nonzero donuts still resolve without guessing.
    return guardPaperHoleWithComputedSemantics(element, probeSubpathHole(scope, element, item, target, tolerance));
  } finally {
    try {
      item.remove();
    } catch {
      // Best effort cleanup for the ephemeral import.
    }
  }
}

async function probeGroupElementHole(
  scope: paper.PaperScope,
  element: Element,
  target: unknown,
  tolerance: number,
): Promise<'none' | 'hole' | 'ambiguous'> {
  try {
    if (isDefinitelyHoleHidden(element)) return 'none';
  } catch {
    // Fall through to the import below.
  }
  const item = importPaperUnit(scope, element);
  if (!item) return 'none';
  try {
    const hit = (item as unknown as { hitTest?: (point: unknown, options: unknown) => unknown }).hitTest?.(target, {
      fill: true,
      stroke: true,
      tolerance,
      guide: false,
    });
    if (hit) return 'none';
    const compounds = collectCompoundPaths(item);    let holes = 0;
    for (const compound of compounds) {
      const probe = probeCompoundPathHole(compound, target, element, tolerance);
      if (probe.kind === 'hole') holes += 1;
      else if (probe.kind === 'ambiguous' || probe.kind === 'unsupported') return 'ambiguous';
    }
    // Stock Paper.js single-Path donuts (Group holding one multi-subpath
    // Path) have no CompoundPath. Detect their holes via subpath parity so
    // nested groups still fail-closed honestly instead of silently none.
    try {
      const leaves = paperPathItems(item as paper.Item);
      for (const leaf of leaves) {
        const raw = (leaf as unknown as { pathData?: unknown }).pathData;
        if (typeof raw !== 'string') continue;
        const parts = splitPathDataIntoSubpaths(raw);
        if (!parts) continue;
        let leafGlobal: unknown;
        try {
          leafGlobal = (leaf as unknown as { globalMatrix?: unknown }).globalMatrix;
        } catch {
          return 'ambiguous';
        }
        if (!leafGlobal) continue;
        if (safePaperContains(leaf, target)) continue;
        const temps: unknown[] = [];
        try {
          for (const part of parts) {
            let temp: unknown;
            try {
              const created = new scope.Path() as unknown as { pathData?: string };
              created.pathData = part;
              temp = created;
              (temp as { transform?: (m: unknown) => void }).transform?.(leafGlobal as never);
            } catch {
              temp = undefined;
            }
            if (temp) temps.push(temp);
          }
          const containing = temps.filter((t) => safePaperContains(t, target)).length;
          if (containing === 2) holes += 1;
          else if (containing > 2) return 'ambiguous';
        } finally {
          for (const t of temps) {
            try {
              (t as { remove?: () => void }).remove?.();
            } catch {
              // Ignore cleanup failure.
            }
          }
        }
      }
    } catch {
      return 'ambiguous';
    }
    if (holes === 0) return 'none';
    return holes === 1 ? 'hole' : 'ambiguous';
  } finally {
    try {
      item.remove();
    } catch {
      // Best effort cleanup for the ephemeral import.
    }
  }
}

/**
 * Conservative geometry fallback for straight-segment multi-hole paths.
 *
 * The Paper entity probe above declines relative-`m` hole starts
 * (`splitPathDataIntoSubpaths` refuses them so a standalone extraction cannot
 * misplace the hole). The pure helper (`vector-fill-hole-geometry.ts`)
 * resolves those offsets arithmetically, so a donut whose second hole starts
 * with `m` is still two unfilled interiors on Canvas/Paper. This fallback
 * runs ONLY when the Paper probe reports `none` (never overriding a Paper
 * `hole` / `ambiguous` / `unsupported`): existing safe Paper cases are
 * never degraded, and curves / overlaps / islands-in-holes / clip-mask /
 * defs-url paint stay fail-closed here as well.
 *
 * Per-unit rules: `<path>` only, effective fill must not be `none`
 * (unfilled parents have no hole), ancestor clip/mask + defs-url paint are
 * declined when the point is geometrically a hole, the document point is
 * mapped through the full DOM world matrix (ancestors + own, mirror-safe),
 * and only the clicked hole contour is rebuilt as an absolute `M...L...Z`
 * sibling outline (never the whole `d`, never a parent recolor). Z-order
 * mirrors the Paper probe: top-down iteration, >1 hole candidates is
 * `ambiguous`, and an opaque straight-path foreground covering the point
 * hides lower holes immediately (`none` via `vector-fill-hole-cover.ts`;
 * semitransparency / gradient / invalid paint / clip-mask / class / unknown
 * rules stay fail-closed when near). Far-outside points never turn a
 * distant unit's internal overlap into a global `ambiguous` (bounds gate
 * below).
 */

export function geometryFallbackHoleProbe(
  elements: Element[],
  point: { x: number; y: number },
  tolerance: number,
): VectorHoleProbe {
  const candidates: Array<VectorHoleTarget> = [];
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : VECTOR_HIT_TOLERANCE;
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    let tag = '';
    try {
      tag = element.tagName.toLowerCase();
    } catch {
      continue;
    }
    if (tag !== 'path') continue;
    let data = '';
    try {
      data = element.getAttribute('d') ?? '';
    } catch {
      continue;
    }
    if (!data.trim()) continue;
    // Effective paint (style-first, root-inclusive, inherited url included,
    // invisible treated as no-fill). `unsupported` (class/stylesheet/url) is
    // deferred until a geometric hole is found below, so far-outside points
    // stay `none` instead of poisoning other units.
    let paintState: HolePaintState;
    try {
      paintState = classifyHoleEffectiveFill(element);
    } catch {
      continue;
    }
    if (paintState.kind === 'none') continue;
    const blocked = hasHoleBlockingClipOrMask(element);
    let insideDefs = false;
    try {
      insideDefs = typeof element.closest === 'function' ? element.closest('defs') !== null : false;
    } catch {
      insideDefs = true;
    }
    let fillAttr: string | null = null;
    let strokeAttr: string | null = null;
    let clipAttr: string | null = null;
    let maskAttr: string | null = null;
    let styleAttr: string | null = null;
    let classAttr: string | null = null;
    try {
      fillAttr = element.getAttribute('fill');
      strokeAttr = element.getAttribute('stroke');
      clipAttr = element.getAttribute('clip-path');
      maskAttr = element.getAttribute('mask');
      styleAttr = element.getAttribute('style');
      classAttr = element.getAttribute('class');
    } catch {
      continue;
    }
    const eligibility = isUnitEligibleForHoleGeometry({
      tag,
      fill: fillAttr,
      stroke: strokeAttr,
      clipPath: clipAttr,
      mask: maskAttr,
      style: styleAttr,
      classAttr,
      insideDefs,
    });
    let world: VectorMatrix | undefined;
    try {
      world = worldTransformMatrix(element) ?? undefined;
    } catch {
      return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
    }
    let fillRule = '';
    let fillRuleUnknown: string | undefined;
    try {
      const resolvedRule = resolveEffectiveHoleFillRule(element);
      if (resolvedRule.kind === 'unknown') fillRuleUnknown = resolvedRule.reason;
      else fillRule = resolvedRule.value;
    } catch {
      fillRule = '';
    }
    // Fail-closed unknowns (clip/class/url/rule) must block near points even
    // when the guessed-rule classification would say `filled`: the true rule
    // could still be a hole. Far-outside points stay `none` so distant
    // unknowns never poison other units.
    if (blocked || !eligibility.eligible || paintState.kind === 'unsupported' || fillRuleUnknown !== undefined) {
      try {
        const nearContours = parseStraightContours(data);
        if (nearContours) {
          let localNear = point;
          if (world) {
            const inv = tryInvertVectorMatrix(world);
            if (!inv) {
              return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
            }
            localNear = transformVectorPoint(inv, point.x, point.y);
          }
          if (Number.isFinite(localNear.x) && Number.isFinite(localNear.y)) {
            const lt = world
              ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], safeTolerance)
              : safeTolerance;
            const isNear = nearContours.some((c) => {
              const b = contourBounds(c);
              return (
                localNear.x >= b.x - lt &&
                localNear.x <= b.x + b.width + lt &&
                localNear.y >= b.y - lt &&
                localNear.y <= b.y + b.height + lt
              );
            });
            if (isNear) {
              if (blocked) return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
              if (!eligibility.eligible) {
                return { kind: eligibility.verdict, reason: `${eligibility.reason} at unit ${index} (fail-closed)` };
              }
              if (paintState.kind === 'unsupported') {
                return { kind: 'unsupported', reason: `${paintState.reason} at unit ${index} (fail-closed)` };
              }
              if (fillRuleUnknown) {
                return { kind: 'unsupported', reason: `${fillRuleUnknown} at unit ${index} (fail-closed)` };
              }
            }
          }
        }
      } catch {
        // Fall through to classification below.
      }
    }
    // Z-order cover: an opaque straight-path foreground hides lower holes.
    // Runs before hole classification so a filled top unit never leaks the
    // hole below (`none`); transparent stays transmissive, fail-closed stays
    // fail-closed when near and transmissive when far.
    try {
      const cover = classifyStraightForegroundCover({
        element,
        index,
        point,
        world,
        safeTolerance,
        fillRule,
        data,
      });
      if (cover.kind === 'cover') return { kind: 'none' };
      if (cover.kind === 'ambiguous' || cover.kind === 'unsupported') return cover;
    } catch {
      // Fall through to classification below: the cover gate never blocks.
    }
    let verdict: ReturnType<typeof classifyHolePoint>;
    try {
      verdict = classifyHolePoint({
        pathData: data,
        point,
        fillRule,
        worldMatrix: (world ?? null) as [number, number, number, number, number, number] | null,
        tolerance: safeTolerance,
      });
    } catch {
      continue;
    }
    if (verdict.kind === 'hole') {
      if (blocked) {
        return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
      }
      if (!eligibility.eligible) {
        return { kind: eligibility.verdict, reason: `${eligibility.reason} at unit ${index} (fail-closed)` };
      }
      if (paintState.kind === 'unsupported') {
        return { kind: 'unsupported', reason: `${paintState.reason} at unit ${index} (fail-closed)` };
      }
      if (fillRuleUnknown) {
        return { kind: 'unsupported', reason: `${fillRuleUnknown} at unit ${index} (fail-closed)` };
      }
      // Inherited stroke `url()` / class-driven stroke cannot be resolved
      // detached; a hole claim with an unknown edge is unsafe.
      try {
        const strokeState = resolveInheritedHoleProperty(element, 'stroke');
        if (strokeState.status === 'unknown') {
          return { kind: 'unsupported', reason: `${(strokeState as { reason: string }).reason} at unit ${index} (fail-closed)` };
        }
        if (strokeState.status === 'value' && /url\s*\(/i.test(strokeState.value)) {
          return { kind: 'unsupported', reason: `inherited url(#...) stroke needs defs resolution at unit ${index} (fail-closed)` };
        }
      } catch {
        return { kind: 'unsupported', reason: `unreadable stroke at unit ${index} (fail-closed)` };
      }
      const contours = parseStraightContours(data);
      const contour = contours?.[verdict.holeIndex];
      if (!contour) {
        return { kind: 'ambiguous', reason: `hole geometry is unavailable at unit ${index} (fail-closed)` };
      }
      const holePathData = holeContourToPathData(contour);
      if (!isHolePathDataSafe(holePathData) || !isPathDataSafeForHoleGeometry(holePathData)) {
        return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
      }
      const holeDocumentBounds = documentBoundsForHole(contour, world);
      if (
        !(holeDocumentBounds.width > 0 && holeDocumentBounds.height > 0) ||
        !Number.isFinite(holeDocumentBounds.x) ||
        !Number.isFinite(holeDocumentBounds.y) ||
        !Number.isFinite(holeDocumentBounds.width) ||
        !Number.isFinite(holeDocumentBounds.height)
      ) {
        return { kind: 'ambiguous', reason: `degenerate hole bounds at unit ${index} (fail-closed)` };
      }
      let parentTransform = '';
      let parentFillRule = '';
      try {
        parentTransform = element.getAttribute('transform') ?? '';
        parentFillRule = element.getAttribute('fill-rule') ?? '';
      } catch {
        return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
      }
      candidates.push({ parentIndex: index, holePathData, holeDocumentBounds, parentTransform, parentFillRule });
    } else if (verdict.kind === 'ambiguous' && verdict.reason.includes('hole contains an island')) {
      // Well-formed safe subset: outer hole with a single island exclusion.
      // The pure outer-island classifier proves the 3-contour laminar triple
      // and builds the island-excluding compound `d`; the same fail-closed
      // paint/clip/rule/stroke gates as the single-hole branch apply.
      try {
        const outerVerdict = classifyOuterIslandHolePoint({
          pathData: data,
          point,
          fillRule,
          worldMatrix: (world ?? null) as [number, number, number, number, number, number] | null,
          tolerance: safeTolerance,
        });
        if (outerVerdict.kind === 'hole') {
          if (blocked) {
            return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
          }
          if (!eligibility.eligible) {
            return { kind: eligibility.verdict, reason: `${eligibility.reason} at unit ${index} (fail-closed)` };
          }
          if (paintState.kind === 'unsupported') {
            return { kind: 'unsupported', reason: `${paintState.reason} at unit ${index} (fail-closed)` };
          }
          if (fillRuleUnknown) {
            return { kind: 'unsupported', reason: `${fillRuleUnknown} at unit ${index} (fail-closed)` };
          }
          try {
            const strokeState = resolveInheritedHoleProperty(element, 'stroke');
            if (strokeState.status === 'unknown') {
              return { kind: 'unsupported', reason: `${(strokeState as { reason: string }).reason} at unit ${index} (fail-closed)` };
            }
            if (strokeState.status === 'value' && /url\s*\(/i.test(strokeState.value)) {
              return { kind: 'unsupported', reason: `inherited url(#...) stroke needs defs resolution at unit ${index} (fail-closed)` };
            }
          } catch {
            return { kind: 'unsupported', reason: `unreadable stroke at unit ${index} (fail-closed)` };
          }
          const outerContours = parseStraightContours(data);
          const outerHole = outerContours?.[outerVerdict.holeIndex];
          if (!outerHole) {
            return { kind: 'ambiguous', reason: `hole geometry is unavailable at unit ${index} (fail-closed)` };
          }
          if (!isHolePathDataSafe(outerVerdict.overlayPathData)) {
            return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
          }
          const outerHoleDocumentBounds = documentBoundsForHole(outerHole as never, world);
          if (
            !(outerHoleDocumentBounds.width > 0 && outerHoleDocumentBounds.height > 0) ||
            !Number.isFinite(outerHoleDocumentBounds.x) ||
            !Number.isFinite(outerHoleDocumentBounds.y) ||
            !Number.isFinite(outerHoleDocumentBounds.width) ||
            !Number.isFinite(outerHoleDocumentBounds.height)
          ) {
            return { kind: 'ambiguous', reason: `degenerate hole bounds at unit ${index} (fail-closed)` };
          }
          let outerParentTransform = '';
          let outerParentFillRule = '';
          try {
            outerParentTransform = element.getAttribute('transform') ?? '';
            outerParentFillRule = element.getAttribute('fill-rule') ?? '';
          } catch {
            return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
          }
          candidates.push({
            parentIndex: index,
            holePathData: outerVerdict.overlayPathData,
            holeDocumentBounds: outerHoleDocumentBounds,
            parentTransform: outerParentTransform,
            parentFillRule: outerParentFillRule,
          });
          continue;
        }
      } catch {
        // Fall through to the generic ambiguous handling below.
      }
    }
    if (verdict.kind === 'ambiguous') {
      // A distant unit's internal overlap must not poison outside clicks:
      // only propagate when the point sits inside (or within tolerance of)
      // this unit's bounds. Far-outside stays `none` so body hits and
      // outside no-ops on other units are preserved.
      try {
        const contours = parseStraightContours(data);
        if (contours) {
          let local = point;
          if (world) {
            const inverse = tryInvertVectorMatrix(world);
            if (!inverse) {
              return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
            }
            local = transformVectorPoint(inverse, point.x, point.y);
            if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
              return { kind: 'ambiguous', reason: `hole transform maps point out of range at unit ${index} (fail-closed)` };
            }
          }
          // Non-uniform world CTMs widen the local exclusion zone to
          // `tolerance / sMin` (same as `classifyHolePoint`); the bounds
          // gate uses the same widened radius so a near-edge ambiguous is
          // never downgraded to far-outside `none`.
          const localTolerance = world
            ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], safeTolerance)
            : safeTolerance;
          const near = contours.some((contour) => {
            const bounds = contourBounds(contour);
            return (
              local.x >= bounds.x - localTolerance &&
              local.x <= bounds.x + bounds.width + localTolerance &&
              local.y >= bounds.y - localTolerance &&
              local.y <= bounds.y + bounds.height + localTolerance
            );
          });
          if (!near) continue;
          // Z-order cover (audit fix): a filled overlap interior is painted,
          // so the foreground hides lower holes. The cover gate above already
          // returned `none` for opaque covers and fail-closed for
          // semitransparency / invalid paint; this re-checks through the same
          // gate so a skipped/exceptional gate never leaks a lower hole.
          // Edge-adjacent points stay `ambiguous` even when filled
          // (anti-alias zone, existing gate in `classifyHolePoint`).
          try {
            if (
              verdict.reason.includes('contours overlap') &&
              isPointFilled(contours as never, local as never, normalizeFillRule(fillRule) as never)
            ) {
              try {
                const cover = classifyStraightForegroundCover({
                  element,
                  index,
                  point,
                  world,
                  safeTolerance,
                  fillRule,
                  data,
                });
                if (cover.kind === 'cover') return { kind: 'none' };
                if (cover.kind === 'ambiguous' || cover.kind === 'unsupported') return cover;
              } catch {
                // Fall through to fail-closed propagation below.
              }
              return { kind: 'ambiguous', reason: `${verdict.reason} at unit ${index} (fail-closed)` };
            }
          } catch {
            // Fall through to fail-closed propagation below.
          }
        }
      } catch {
        // Fall through to fail-closed propagation below.
      }
      return { kind: 'ambiguous', reason: `${verdict.reason} at unit ${index} (fail-closed)` };
    } else if (verdict.kind === 'filled') {
      // Z-order cover: an opaque filled foreground hides lower holes
      // (`none`, never a background hole). The pre-verdict cover gate above
      // already fail-closed semitransparent/invalid paint when near, but the
      // geometry verdict itself is paint-blind (e.g. `rgba(...,0)` fills
      // geometrically while painting nothing). Re-run the cover gate here so
      // a definitely-transparent `filled` stays transmissive (`continue`)
      // instead of hiding a visible lower hole; only a proven opaque cover
      // stops the scan. This preserves the long-standing body/outside `none`
      // behavior for single-unit bodies/islands.
      try {
        const cover = classifyStraightForegroundCover({
          element,
          index,
          point,
          world,
          safeTolerance,
          fillRule,
          data,
        });
        if (cover.kind === 'transparent') continue;
        if (cover.kind === 'ambiguous' || cover.kind === 'unsupported') return cover;
      } catch {
        return { kind: 'ambiguous', reason: `hole cover check failed at unit ${index} (fail-closed)` };
      }
      return { kind: 'none' };
    }
    // `filled` / `outside` / `unsupported` (curves owned by the Paper probe)
    // are not this unit's hole: keep scanning lower units for Z-order.
  }
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', reason: `overlapping holes at units ${candidates.map((candidate) => candidate.parentIndex).join(', ')} (fail-closed)` };
  }
  return { kind: 'hole', target: candidates[0]! };
}

/**
 * Topmost hole probe for the fill tool. Iterates selectable units top-down so
 * document order is honored: the first (topmost) hole candidate wins, and
 * more than one candidate (overlapping holes across units) is `ambiguous`.
 * Body hits are *not* returned here; callers compare the hole index against
 * `paperVectorFillTargetAtPoint` (topmost body) to honor other-object order:
 * a hole above a body is an overlap (fail-closed), a body above a hole hides
 * the hole (body wins), and a lone hole becomes the overlay target.
 */
export async function paperVectorHoleTargetAtPoint(
  elements: Element[],
  point: { x: number; y: number },
  tolerance = VECTOR_HIT_TOLERANCE,
): Promise<VectorHoleProbe> {
  if (elements.length === 0) return { kind: 'none' };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'none' };
  const scope = await ensureVectorPaperScope();
  const target = new scope.Point(point.x, point.y);
  const candidates: Array<VectorHoleTarget> = [];
  let nestedHoleReason: string | undefined;
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    const tag = element.tagName.toLowerCase();
    if (tag !== 'path') {
      if (tag === 'g') {
        const groupProbe = await probeGroupElementHole(scope, element, target, tolerance);
        if (groupProbe === 'hole') {
          nestedHoleReason = `nested group hole at unit ${index} is not filled (fail-closed)`;
        } else if (groupProbe === 'ambiguous') {
          return { kind: 'ambiguous', reason: `overlapping nested holes at unit ${index} (fail-closed)` };
        }
      }
      continue;
    }
    if (hasHoleBlockingClipOrMask(element)) {
      const clipProbe = await probePathElementHole(scope, element, target, tolerance);
      if (clipProbe.kind === 'hole') {
        return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
      }
      if (clipProbe.kind === 'ambiguous' || clipProbe.kind === 'unsupported') {
        return clipProbe.kind === 'ambiguous'
          ? { kind: 'ambiguous', reason: clipProbe.reason }
          : { kind: 'unsupported', reason: clipProbe.reason };
      }
      continue;
    }
    const probe = await probePathElementHole(scope, element, target, tolerance);
    if (probe.kind === 'hole') {
      candidates.push({ parentIndex: index, ...probe.target });
    } else if (probe.kind === 'ambiguous') {
      return { kind: 'ambiguous', reason: probe.reason };
    } else if (probe.kind === 'unsupported') {
      return { kind: 'unsupported', reason: probe.reason };
    }
  }
  if (candidates.length === 0) {
    if (nestedHoleReason) return { kind: 'unsupported', reason: nestedHoleReason };
    // Straight-segment fallback for relative-`m` multi-holes (Paper `none`
    // only; Paper hole/ambiguous/unsupported above already returned). Curves,
    // overlaps, islands, clip/mask, and defs-url paint stay fail-closed
    // inside the fallback, and far-outside points stay `none`.
    try {
      const fallback = geometryFallbackHoleProbe(elements, point, tolerance);
      if (fallback.kind === 'hole' || fallback.kind === 'ambiguous' || fallback.kind === 'unsupported') {
        return fallback;
      }
    } catch {
      // Fall through to `none`: the fallback never blocks the Paper verdict.
    }
    // Curved fallback, last and conservative: only `<path>` units whose `d`
    // contains a curve command (`C/S/Q/T/A`) are considered, and only when
    // both the Paper probe and the straight fallback report `none`. A Paper
    // `hole` / `ambiguous` / `unsupported` above, or a straight-fallback
    // `hole` / `ambiguous` / `unsupported`, is never overridden here. A
    // helper `hole` additionally requires independent Paper-outline
    // confirmation (Canvas-vs-Paper conflicts, notably the 2-segment lens,
    // never become holes); extraction / coordinate / paint failures refuse
    // as `ambiguous`/`unsupported`, never as holes.
    try {
      const curved = await probeCurvedFallbackHole(scope, elements, target, point, tolerance, { importUnit: importPaperUnit });
      if (curved.kind === 'hole' || curved.kind === 'ambiguous' || curved.kind === 'unsupported') {
        return curved;
      }
    } catch {
      // Fall through to `none`: the curved fallback never blocks the Paper verdict.
    }
    return { kind: 'none' };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', reason: `overlapping holes at units ${candidates.map((candidate) => candidate.parentIndex).join(', ')} (fail-closed)` };
  }
  return { kind: 'hole', target: candidates[0]! };
}

// Mirror scratch-paint's select-tool hit options: filled areas, strokes, curves
// and segments all count, so clicks hit the drawn shape instead of its bounding box.
export async function paperVectorHitIndex(elements: Element[], point: { x: number; y: number }, tolerance = VECTOR_HIT_TOLERANCE): Promise<number> {
  if (elements.length === 0) return -1
  const scope = await ensureVectorPaperScope()
  const target = new scope.Point(point.x, point.y)
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!
    const item = importPaperUnit(scope, element)
    if (!item) continue
    try {
      const probe = isRtlVectorTextElement(element)
        ? (() => {
            const mirrored = rtlMirroredHitPoint(element, point)
            return new scope.Point(mirrored.x, mirrored.y)
          })()
        : target
      const hit = item.hitTest(probe, { fill: true, stroke: true, curves: true, segments: true, tolerance, guide: false })
      if (hit) return index
    } finally {
      item.remove()
    }
  }
  return -1
}

// Mirror scratch-paint's processRectangularSelection: path items match when a
// segment point sits inside the marquee or the outline crosses it, while
// bounds items (text, shapes without segments, rasters) match when a bounds
// corner sits inside or the bounds border crosses the marquee.
export async function paperVectorIndicesInRect(elements: Element[], rect: { x: number; y: number; width: number; height: number }): Promise<number[]> {
  const matches: number[] = []
  if (elements.length === 0) return matches
  const scope = await ensureVectorPaperScope()
  const selectionRect = new scope.Path.Rectangle(new scope.Rectangle(rect.x, rect.y, rect.width, rect.height))
  try {
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]!
      // Baked Paper imports ignore clipping, so a clipped unit would report
      // its unclipped geometry. Fail closed (no match) unless clipping is
      // provably absent on the unit, its descendants, and its ancestors.
      try {
        if (isMarqueeClipBlocked(element)) continue
      } catch {
        continue
      }
      const item = importPaperUnit(scope, element)
      if (!item) continue
      try {
        if (isRtlVectorTextElement(element)) {
          const corrected = correctedRtlTextBounds(element, {
            x: item.bounds.x,
            y: item.bounds.y,
            width: item.bounds.width,
            height: item.bounds.height,
          })
          if (corrected && paperBoundsIntersectsRect(scope, corrected, selectionRect)) {
            matches.push(index)
          }
          continue
        }
        if (paperItemIntersectsRect(scope, item, selectionRect)) matches.push(index)
      } finally {
        item.remove()
      }
    }
  } finally {
    selectionRect.remove()
  }
  return matches
}

function paperBoundsIntersectsRect(scope: paper.PaperScope, bounds: VectorBounds, selectionRect: paper.Path): boolean {
  const boundsPath = new scope.Path.Rectangle(new scope.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height))
  try {
    for (const segment of boundsPath.segments) {
      if (selectionRect.contains(segment.point)) return true
    }
    return selectionRect.getIntersections(boundsPath).length > 0
  } finally {
    boundsPath.remove()
  }
}

// Selection traversal budgets (DoS guard): a stored payload can nest thousands
// of groups or carry huge segment counts. Both walks share ONE per-tree budget
// (see `collectPaperTreePathsAndLeaves`): the unit is collected once, so
// overlapping path/leaf arrays can never double-spend the cap. Over-budget or
// unreadable throws the private sentinel and the unit reports no match
// (fail-closed, no partial selection) instead of hanging.
const PAPER_SELECTION_MAX_NODES = PAPER_TRAVERSAL_MAX_NODES
const PAPER_SELECTION_MAX_SEGMENTS = PAPER_TRAVERSAL_MAX_SEGMENTS
const PAPER_SELECTION_MAX_LEAVES = PAPER_TRAVERSAL_MAX_LEAVES

function paperItemIntersectsRect(scope: paper.PaperScope, item: paper.Item, selectionRect: paper.Path): boolean {
  let paths: paper.Path[]
  let leaves: paper.Item[]
  try {
    // One shared walk: path leaves and bounds leaves spend the same per-tree
    // budget, so a tree that is adversarial in aggregate refuses as a whole.
    const collected = collectPaperTreePathsAndLeaves(item)
    paths = collected.paths
    leaves = collected.leaves
    countPaperSegmentsOrThrow(paths)
  } catch (error) {
    // Over-budget/unreadable unit: no match (fail-closed). Callers add no
    // index, so a partial tree never changes the selection.
    if (isPaperTreeTooLarge(error)) return false
    return false
  }
  for (const path of paths) {
    let segments: unknown
    try {
      segments = (path as unknown as { segments?: unknown }).segments
    } catch {
      // Unreadable geometry is fail-closed for the whole unit (no partial
      // match): the collection pass already validated readability, so reaching
      // here means a hostile mutation mid-probe.
      return false
    }
    if (!Array.isArray(segments)) return false
    for (const segment of segments as Array<{ point: paper.Point }>) {
      // Segment points live in the path's local frame; the marquee lives in
      // document coordinates, so map them up (Paper.js contains() only
      // applies the tested path's own matrix).
      try {
        if (selectionRect.contains(path.localToGlobal(segment.point))) return true
      } catch {
        // An unreadable point never matches; keep scanning.
      }
    }
  }
  for (const path of paths) {
    try {
      if (path.getIntersections(selectionRect).length > 0) return true
    } catch {
      // An unreadable outline never matches; keep scanning.
    }
  }
  // Bounds leaves (Shape/Raster/PointText/...) inside the same unit, if any.
  // A group holding both paths and shapes must still match a marquee over
  // the shape child (reference drills into every child and selects the
  // root on any match); previously any path child short-circuited the whole
  // unit to path-only testing and shape-only marquees missed.
  //
  // The tight shape is the internalBounds polygon mapped via localToGlobal
  // (equivalently getGlobalMatrix applied to the local rect), not the
  // axis-aligned global `bounds` AABB. Under rotation/skew the AABB can be
  // much larger than the ink (a 45-degree square's AABB is ~2x the area),
  // so testing the AABB over-selects marquees that only touch the corner
  // triangle. The reference builds its bounds helper the same way (local rect
  // with the global matrix appended) and matches on polygon corners inside
  // the marquee or polygon-border crossings.
  for (const leaf of leaves) {
    try {
      // Empty groups carry no ink: never select on their (possibly stale)
      // union bounds. Real leaves (Shape/Raster/PointText) continue below.
      try {
        if ((leaf as unknown as { className?: string }).className === 'Group') continue
      } catch {
        continue
      }
      const polygon = paperLeafDocumentPolygon(scope, leaf)
      if (polygon) {
        if (paperPolygonIntersectsRect(scope, polygon, selectionRect)) return true
        // Tight polygon decided: do NOT fall back to the over-selecting AABB.
        continue
      }
      // Degenerate/unreadable local geometry (notably async Raster/`image`
      // whose Paper bounds are still 0x0): preserve the historical AABB-point
      // behavior so an enclosing marquee still selects instead of vanishing.
      try {
        const bounds = (leaf as unknown as { bounds?: { x: number; y: number; width: number; height: number } }).bounds
        if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) continue
        if (paperBoundsIntersectsRect(scope, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, selectionRect)) return true
      } catch {
        // A single unreadable leaf never vetoes the remaining children.
      }
    } catch {
      // A single unreadable leaf never vetoes the remaining children.
    }
  }
  return false
}

// Tight document-space polygon for a bounds leaf: the leaf-local
// `internalBounds` rect (Shape/Raster/PointText geometry in its own frame)
// mapped through the full ancestor chain via localToGlobal. Returns undefined
// when the leaf has no readable, finite, positive-area local bounds or the
// mapping leaves document range (fail-closed for that leaf only).
function paperLeafDocumentPolygon(scope: paper.PaperScope, leaf: paper.Item): Array<{ x: number; y: number }> | undefined {
  try {
    const internal = (leaf as unknown as { internalBounds?: { x: number; y: number; width: number; height: number } }).internalBounds
    if (!internal) return undefined
    if (
      !Number.isFinite(internal.x) || !Number.isFinite(internal.y) ||
      !Number.isFinite(internal.width) || !Number.isFinite(internal.height)
    ) return undefined
    if (!(internal.width > 0) || !(internal.height > 0)) return undefined
    // Absurd magnitudes (serialization garbage / DoS) never become a polygon:
    // the corners would be non-finite after the matrix anyway, so refuse early.
    if (Math.abs(internal.x) > 1e7 || Math.abs(internal.y) > 1e7 || internal.width > 1e7 || internal.height > 1e7) return undefined
    const localToGlobal = (leaf as unknown as { localToGlobal?: (point: paper.Point) => paper.Point }).localToGlobal
    if (typeof localToGlobal !== 'function') return undefined
    const corners = [
      new scope.Point(internal.x, internal.y),
      new scope.Point(internal.x + internal.width, internal.y),
      new scope.Point(internal.x + internal.width, internal.y + internal.height),
      new scope.Point(internal.x, internal.y + internal.height),
    ]
    const mapped = corners.map((corner) => {
      const global = localToGlobal.call(leaf, corner)
      return { x: (global as unknown as { x: number }).x, y: (global as unknown as { y: number }).y }
    })
    if (mapped.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return undefined
    if (mapped.some((point) => Math.abs(point.x) > 1e8 || Math.abs(point.y) > 1e8)) return undefined
    return mapped
  } catch {
    return undefined
  }
}

// Crossing test for a tight leaf polygon: any polygon corner inside the
// marquee, or any polygon edge crossing the marquee border. Enclosure (a
// marquee strictly inside the polygon with no corner inside and no crossing)
// matches nothing, mirroring the reference and the existing AABB helper.
function paperPolygonIntersectsRect(scope: paper.PaperScope, polygon: Array<{ x: number; y: number }>, selectionRect: paper.Path): boolean {
  try {
    if (polygon.length < 3) return false
    for (const point of polygon) {
      try {
        if (selectionRect.contains(new scope.Point(point.x, point.y))) return true
      } catch {
        // An unreadable corner never matches; keep scanning.
      }
    }
    let polygonPath: paper.Path | undefined
    try {
      polygonPath = new scope.Path({
        segments: polygon.map((point) => new scope.Point(point.x, point.y)),
        closed: true,
      })
    } catch {
      return false
    }
    try {
      return selectionRect.getIntersections(polygonPath).length > 0
    } catch {
      return false
    } finally {
      try {
        polygonPath.remove()
      } catch {
        // Best effort: the project is cleaned per-unit by callers.
      }
    }
  } catch {
    return false
  }
}

// Clip/mask gate for marquee selection (read-only, no DOM writes). The baked
// Paper import deliberately ignores clipping (ancestor transforms and paint
// are baked, clipping is not), so any `clip-path`/`mask` on the unit, inside
// it, or on an ancestor above it would make unclipped geometry report a hit
// over clipped-away pixels. Fail closed (caller skips the unit) unless the
// whole chain is provably free of clipping. Unreadable attributes fail closed
// the same way; huge subtrees fail closed via the node cap (DoS guard).
function isMarqueeClipBlocked(element: Element): boolean {
  try {
    let node: Element | null = element
    while (node) {
      try {
        const tag = node.tagName?.toLowerCase()
        if (tag === 'svg') break
        if (typeof node.hasAttribute === 'function') {
          if (node.hasAttribute('clip-path') || node.hasAttribute('mask')) return true
        }
        const style = typeof node.getAttribute === 'function' ? (node.getAttribute('style') ?? '') : ''
        if (/clip-path\s*:/i.test(style) || /(^|;)\s*mask\s*:/i.test(style)) return true
        if (tag === 'clippath' || tag === 'mask') return true
      } catch {
        return true
      }
      try {
        node = node.parentElement
      } catch {
        return true
      }
    }
  } catch {
    return true
  }
  try {
    const stack: Element[] = []
    try {
      for (const child of Array.from(element.children)) {
        if ((child as Element).nodeType === 1) stack.push(child as Element)
      }
    } catch {
      return true
    }
    let visited = 0
    while (stack.length > 0) {
      if (++visited > PAPER_SELECTION_MAX_NODES) return true
      const current = stack.pop()!
      try {
        const tag = current.tagName?.toLowerCase()
        if (tag === 'clippath' || tag === 'mask') return true
        if (typeof current.hasAttribute === 'function') {
          if (current.hasAttribute('clip-path') || current.hasAttribute('mask')) return true
        }
        const style = typeof current.getAttribute === 'function' ? (current.getAttribute('style') ?? '') : ''
        if (/clip-path\s*:/i.test(style) || /(^|;)\s*mask\s*:/i.test(style)) return true
        for (const child of Array.from(current.children)) {
          if ((child as Element).nodeType === 1) {
            if (stack.length > PAPER_SELECTION_MAX_NODES) return true
            stack.push(child as Element)
          }
        }
      } catch {
        return true
      }
    }
  } catch {
    return true
  }
  return false
}

// Reshape marquee match for one selected unit (read-only, no DOM writes).
//
// Mirrors scratch-paint's reshape rectangular selection (runtime oracle, no
// reference code copied): per Paper path, anchors whose document point sits
// inside the marquee select individually; when a path has no anchor inside,
// each outline crossing selects that curve's two endpoint anchors as a unit
// (`curve.selected` selects exactly the endpoints plus adjacent handles, so
// the product maps a curve to its endpoint pair with no extra state).
// Shift handling lives in the pure merge (`vector-multi-point-selection.ts`);
// this helper only reports matches. Per-path suppression (anchors win over
// curves on the same path), text skip (no anchors/curves), clip gate, and
// traversal budgets are enforced fail-closed: over-budget/unreadable units
// return `undefined` so callers fall back to the DOM anchor-only marquee.
export type PaperReshapeMarqueeMatch = {
  anchorFlats: number[]
  curvePairs: Array<[number, number]>
}

export async function paperReshapeMarqueeFlatsInRect(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
): Promise<PaperReshapeMarqueeMatch | undefined> {
  try {
    if (!element || element.nodeType !== 1) return undefined
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
      return undefined
    }
    const tag = (() => {
      try {
        return element.tagName.toLowerCase()
      } catch {
        return ''
      }
    })()
    if (tag === 'text' || tag === 'tspan' || tag === 'tref') return { anchorFlats: [], curvePairs: [] }
    try {
      if (typeof element.hasAttribute === 'function' && element.hasAttribute('data-is-pg-text-item')) {
        return { anchorFlats: [], curvePairs: [] }
      }
    } catch {
      return undefined
    }
    try {
      if (isMarqueeClipBlocked(element)) return undefined
    } catch {
      return undefined
    }
    const scope = await ensureVectorPaperScope()
    const item = importPaperUnit(scope, element)
    if (!item) return undefined
    try {
      const root = tag === 'g' ? expandPaperShapesToPaths(item) : item
      let paths: paper.Path[]
      try {
        paths = paperPathItems(root)
        countPaperSegmentsOrThrow(paths)
      } catch (error) {
        if (isPaperTreeTooLarge(error)) return undefined
        return undefined
      }
      if (paths.length === 0) return undefined
      // Flattened anchor slots in the exact `paperEditablePointsForElement`
      // order (anchor, then its non-zero in/out handles per segment).
      const pathAnchorFlats: number[][] = []
      let flat = 0
      for (const path of paths) {
        let segments: unknown
        try {
          segments = (path as unknown as { segments?: unknown }).segments
        } catch {
          return undefined
        }
        if (!Array.isArray(segments)) return undefined
        const flats: number[] = []
        for (const segment of segments as paper.Segment[]) {
          flats.push(flat)
          flat += 1
          try {
            const handleIn = (segment as unknown as { handleIn?: paper.Point }).handleIn
            const handleOut = (segment as unknown as { handleOut?: paper.Point }).handleOut
            if (handleIn && !isZeroPaperPoint(handleIn)) flat += 1
            if (handleOut && !isZeroPaperPoint(handleOut)) flat += 1
          } catch {
            return undefined
          }
        }
        pathAnchorFlats.push(flats)
      }
      const x2 = rect.x + rect.width
      const y2 = rect.y + rect.height
      const left = Math.min(rect.x, x2)
      const right = Math.max(rect.x, x2)
      const top = Math.min(rect.y, y2)
      const bottom = Math.max(rect.y, y2)
      const hasArea = right > left && bottom > top
      let selectionRect: paper.Path | undefined
      try {
        selectionRect = new scope.Path.Rectangle(new scope.Rectangle(left, top, right - left, bottom - top))
      } catch {
        return undefined
      }
      try {
        const anchorFlats: number[] = []
        const curvePairs: Array<[number, number]> = []
        for (let pathOrder = 0; pathOrder < paths.length; pathOrder += 1) {
          const path = paths[pathOrder]!
          const flats = pathAnchorFlats[pathOrder]!
          let segments: paper.Segment[]
          try {
            const raw = (path as unknown as { segments?: unknown }).segments
            if (!Array.isArray(raw)) return undefined
            segments = raw as paper.Segment[]
          } catch {
            return undefined
          }
          const inside: number[] = []
          for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
            try {
              const global = path.localToGlobal(segments[segIndex]!.point)
              if (selectionRect.contains(global)) inside.push(segIndex)
            } catch {
              // An unreadable point never matches; keep scanning.
            }
          }
          if (inside.length > 0) {
            for (const segIndex of inside) anchorFlats.push(flats[segIndex]!)
            continue
          }
          if (!hasArea) continue
          let intersections: Array<{
            curve: { index?: unknown; segment1?: { index?: unknown }; segment2?: { index?: unknown } }
            point?: unknown
          }>
          try {
            intersections = path.getIntersections(selectionRect) as unknown as typeof intersections
          } catch {
            continue
          }
          if (!Array.isArray(intersections) || intersections.length === 0) continue
          // Reference-exact: the reshape rectangular selection keeps every
          // other intersection in Paper order (`k % 2 === 0`), because a
          // straight crossing reports twice on the same curve. A V shape
          // whose two arms each cross once therefore selects only the first
          // arm; dedupe-by-curve would incorrectly select both. Keep the
          // order and the parity, mapping each kept curve to its endpoint
          // anchor pair (`curve.selected` parity: both ends, never handles).
          for (let k = 0; k < intersections.length; k += 1) {
            if (k % 2 === 1) continue
            const location = intersections[k]!
            let curveIndex: unknown
            try {
              curveIndex = location?.curve?.index
            } catch {
              continue
            }
            if (!Number.isInteger(curveIndex)) continue
            const curveIdx = curveIndex as number
            let rawA: unknown
            let rawB: unknown
            try {
              rawA = location?.curve?.segment1?.index
              rawB = location?.curve?.segment2?.index
            } catch {
              continue
            }
            let segA = Number.isInteger(rawA) ? (rawA as number) : curveIdx
            let segB = Number.isInteger(rawB) ? (rawB as number) : -1
            if (!Number.isInteger(segB) || (segB as number) < 0) {
              try {
                const closed = (path as unknown as { closed?: boolean }).closed === true
                segB = closed ? (segA + 1) % segments.length : segA + 1
              } catch {
                continue
              }
            }
            if (segA < 0 || segB < 0 || segA >= flats.length || segB >= flats.length) continue
            const flatA = flats[segA]!
            const flatB = flats[segB]!
            if (flatA === flatB) continue
            // No pair dedupe: the reference toggles per kept intersection
            // in order, so the same curve appearing on two even slots
            // toggles twice (net no change with Shift). Dropping the second
            // occurrence would incorrectly leave it selected.
            curvePairs.push([flatA, flatB])
          }
        }
        return {
          anchorFlats: [...new Set(anchorFlats)].sort((a, b) => a - b),
          curvePairs,
        }
      } finally {
        try {
          selectionRect.remove()
        } catch {
          // Best effort: the project is cleaned per unit by callers.
        }
      }
    } finally {
      try {
        item.remove()
      } catch {
        // Detached import; nothing to clean up.
      }
    }
  } catch {
    return undefined
  }
}

// Non-path leaves of an imported unit (Shape/Raster/PointText/empty groups
// have no segments). Shares the single per-tree walk above so overlapping
// path/leaf callers spend one budget. Throws the private sentinel on any
// limit/unreadability instead of returning a partial leaf list.
function paperBoundsLeaves(item: paper.Item, budget?: PaperTraversalBudget): paper.Item[] {
  return collectPaperTreePathsAndLeaves(item, budget).leaves
}

/**
 * Bake computed (style-first, root-inclusive) paint onto a detached clone
 * so Paper.js `importSVG` observes the same `fill` / `fill-rule` the
 * browser renders, even when Paper ignores inline `style` or ancestor
 * inheritance. Only the detached clone is mutated (never the live DOM).
 * Stylesheet-driven (`class`) values cannot be baked detached and are left
 * alone — callers must have already returned `unsupported` for classed
 * units, so this never invents paint for them.
 */
function bakeHoleComputedPaintIntoClone(source: Element, clone: Element): void {
  try {
    for (const property of ['fill', 'fill-rule'] as const) {
      const resolved = resolveInheritedHoleProperty(source, property);
      if (resolved.status !== 'value') continue;
      // Overwrite the presentation attribute with the computed value: when
      // Paper respects `style` this is redundant (style still wins); when it
      // ignores `style` the attribute carries the win. The clone's own
      // `style` is preserved untouched.
      try {
        clone.setAttribute(property, resolved.value);
      } catch {
        // Best effort: the import below still runs with original paint.
      }
    }
  } catch {
    // Best effort: fall back to the unbaked clone.
  }
}

function importPaperUnit(scope: paper.PaperScope, unit: Element) {
  try {
    // Import the unit with its ancestor transforms and inherited paint baked
    // in, so hit tests and measurements run in document coordinates even when
    // the unit is nested (e.g. a centered group wrapper). Falls back to a
    // plain import when the unit cannot be anchored to an svg root.
    // Trust boundary: single-element serialization is an SVG fragment, so it
    // must go through the fragment-safe wrapper (never raw) before Paper.js
    // `importSVG`; the wrapper preserves group/transform/styles and
    // same-document (#) internal refs.
    // In the editor the unit lives inside an HTML document (the `<svg>`
    // preview is embedded in the page), so the owner-document root is
    // `<html>`, not `<svg>`. Anchor to the closest ancestor `<svg>` instead,
    // otherwise nested wrapper transforms are silently dropped and document
    // points hit-test against local geometry.
    // Inline-style priority: `bakedUnitClone` copies ancestor *attributes*
    // only, so `style="fill:..."` / `style="fill-rule:..."` (own, ancestor,
    // or svg-root) is additionally baked into the clone's attributes here.
    // Stylesheet (`class`) paint cannot be baked detached and must be
    // fail-closed by callers before importing.
    const root = typeof unit.closest === 'function' ? unit.closest('svg') : undefined
    const baked = root ? bakedUnitClone(root, unit) : undefined
    if (baked) {
      try {
        bakeHoleComputedPaintIntoClone(unit, baked);
      } catch {
        // Best effort: use the unbaked clone.
      }
    }
    const source = baked ?? unit
    const serialized = sanitizeSvgFragmentForPaperImport(new XMLSerializer().serializeToString(source))
    if (!serialized || serialized === SVG_PLACEHOLDER) return undefined
    return (scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }).importSVG(serialized, { insert: false })
  } catch {
    return undefined
  }
}

function importPaperItem(scope: paper.PaperScope, element: Element) {
  try {
    // Same fragment-safe wrapper as importPaperUnit: bare `<rect>`/`<g>`/
    // `<path>` serialization is not a full `<svg>` document and must not be
    // fed raw (or as a placeholder) to Paper.js.
    const svg = sanitizeSvgFragmentForPaperImport(new XMLSerializer().serializeToString(element))
    if (!svg || svg === SVG_PLACEHOLDER) return undefined
    return (scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }).importSVG(svg, { insert: false })
  } catch {
    return undefined
  }
}

function replaceElementWithPaperItem(element: Element, item: paper.Item) {
  const exported = item.exportSVG({ asString: false }) as Element
  const nextElement = element.ownerDocument.importNode(exported, true) as Element
  const normalized = normalizePaperLeafExport(element, nextElement)
  // Explicit-group identity survives Paper round-trips (resize/rotate/flip):
  // Paper's SVG export does not guarantee class passthrough, so re-attach
  // the inert token from the source node. Non-group leaves never gain it.
  try {
    if (isExplicitVectorGroup(element) && normalized.tagName.toLowerCase() === 'g') {
      markExplicitVectorGroup(normalized)
    }
  } catch {
    // Best effort: geometry write-back still wins without the marker.
  }
  element.replaceWith(normalized)
  return normalized
}

// A full-document `<svg>` import makes Paper.js wrap a lone leaf
// (`<rect>`/`<path>`/...) in a single-child `<g>` carrying the default paint,
// while a bare-fragment import used to round-trip the leaf itself. Unwrap that
// synthetic wrapper so selectable units keep their tag (and `x`/`transform`
// callers keep working). Group units stay as `<g>`; multi-child exports pass
// through untouched.
function normalizePaperLeafExport(original: Element, exported: Element): Element {
  try {
    if (original.tagName.toLowerCase() === 'g') return exported
    if (exported.tagName.toLowerCase() !== 'g') return exported
    const kids = Array.from(exported.children).filter((node): node is Element => node.nodeType === 1)
    if (kids.length !== 1) return exported
    const child = kids[0]!
    const wrapperTransform = exported.getAttribute('transform') ?? ''
    if (wrapperTransform) {
      child.setAttribute('transform', combineSvgTransforms(wrapperTransform, child.getAttribute('transform') ?? ''))
    }
    for (const attr of Array.from(exported.attributes)) {
      if (attr.name === 'transform') continue
      if (child.getAttribute(attr.name) === null) child.setAttribute(attr.name, attr.value)
    }
    return child
  } catch {
    return exported
  }
}

async function updateElementWithPaper(element: Element, mutator: (item: paper.Item, scope: paper.PaperScope) => void, prepare?: (item: paper.Item) => paper.Item) {
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  const item = imported && prepare ? prepare(imported) : imported
  if (!item) return element
  try {
    mutator(item, scope)
    return replaceElementWithPaperItem(element, item)
  } finally {
    item.remove()
  }
}

export async function vectorBrushPathData(points: Array<{ x: number; y: number }>, strokeColor: string, strokeWidth: number) {
  const scope = await ensureVectorPaperScope()
  scope.project.clear()
  const path = new scope.Path()
  path.strokeColor = new scope.Color(strokeColor)
  path.strokeWidth = Math.max(1, strokeWidth)
  path.strokeCap = 'round'
  path.strokeJoin = 'round'
  for (const point of points) path.add(new scope.Point(point.x, point.y))
  if (path.segments.length > 2) {
    path.simplify(Math.max(0.5, strokeWidth * 0.45))
    path.smooth({ type: 'continuous' })
  }
  const exported = path.exportSVG({ asString: false }) as SVGPathElement
  const data = exported.getAttribute('d') ?? points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`).join(' ')
  path.remove()
  return data
}

function formatSvgNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(3))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

export async function alignVectorElements(elements: Element[], action: string): Promise<boolean> {
  if (elements.length < 2) return false
  const scope = await ensureVectorPaperScope()
  const bounds = elements.map((element) => paperBoundsForElement(scope, element) ?? vectorObjectBounds(element))
  const left = Math.min(...bounds.map((bound) => bound.x))
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width))
  const top = Math.min(...bounds.map((bound) => bound.y))
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height))
  const centerX = left + (right - left) / 2
  const centerY = top + (bottom - top) / 2
  const results = await Promise.all(elements.map(async (element, index) => {
    const bound = bounds[index]
    if (!bound) return false
    if (action === 'align-left') return moveVectorElementBy(element, left - bound.x, 0)
    else if (action === 'align-center') return moveVectorElementBy(element, centerX - (bound.x + bound.width / 2), 0)
    else if (action === 'align-right') return moveVectorElementBy(element, right - (bound.x + bound.width), 0)
    else if (action === 'align-top') return moveVectorElementBy(element, 0, top - bound.y)
    else if (action === 'align-middle') return moveVectorElementBy(element, 0, centerY - (bound.y + bound.height / 2))
    else if (action === 'align-bottom') return moveVectorElementBy(element, 0, bottom - (bound.y + bound.height))
    return false
  }))
  return results.some(Boolean)
}

export async function moveVectorElementBy(element: Element, dx: number, dy: number): Promise<boolean> {
  if (!dx && !dy) return false
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  // Unified geometry-translation semantics (preview == commit): prepend a
  // parent-frame `translate` so `userSpaceOnUse` gradients/clips ride with
  // the artwork (no pointerup snap). The legacy leaf path baked geometry
  // through Paper.js, leaving `userSpaceOnUse` defs fixed in canvas space
  // while the preview carried them — a visible snap on gradient/clip art.
  // Paper baking is skipped for moves because translation preserves
  // export/runtime dimensions (viewBox/rotationCenter recomputed from
  // `vectorObjectBounds`, which folds `transform`), rotation center
  // (`rotate()` preserved), inherited style (no attribute rewrite) and
  // cross-refs (only the unit's own `transform` is touched; `defs` and
  // `url(#...)`/`href` are never rewritten). Singular / non-finite
  // ancestors have no unique preimage: refuse with no DOM write so a later
  // ancestor repair cannot teleport the leaf and no empty history is needed.
  // Groups and leaves share the same path (group parity: node preserved,
  // children untouched, document order stable).
  const native = toNativeDelta(element, dx, dy)
  if (!native) return false
  if (!native.dx && !native.dy) return false
  if (Math.abs(native.dx) < 1e-12 && Math.abs(native.dy) < 1e-12) return true
  const existing = element.getAttribute('transform') ?? ''
  try {
    element.setAttribute(
      'transform',
      combineSvgTransforms(`translate(${formatSvgNumber(native.dx)} ${formatSvgNumber(native.dy)})`, existing),
    )
  } catch {
    return false
  }
  return true
}

// Map a world-space delta/vector into the element's native frame (the frame
// of a bare Paper.js import, which includes the element's own transform but
// not its ancestors'). Translation parts are ignored: deltas have no position.
// Returns `null` for singular / non-finite ancestors (fail-closed: caller
// refuses the write).
function toNativeDelta(element: Element, dx: number, dy: number): { dx: number; dy: number } | null {
  const ancestors = ancestorWorldMatrix(element)
  if (!ancestors) return { dx, dy }
  const inverse = tryInvertVectorMatrix(ancestors)
  if (!inverse) return null
  const mapped = {
    dx: inverse[0] * dx + inverse[2] * dy,
    dy: inverse[1] * dx + inverse[3] * dy,
  }
  if (!Number.isFinite(mapped.dx) || !Number.isFinite(mapped.dy)) return null
  return mapped
}

// Map a world-space point into the element's native frame.
// Returns `null` for singular / non-finite ancestors (fail-closed).
function toNativePoint(element: Element, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const ancestors = ancestorWorldMatrix(element)
  if (!ancestors) return { x, y }
  const inverse = tryInvertVectorMatrix(ancestors)
  if (!inverse) return null
  const mapped = transformVectorPoint(inverse, x, y)
  if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) return null
  return mapped
}

export async function moveVectorEditablePoint(element: Element, pointIndex: number, x: number, y: number, splitHandles = false): Promise<boolean> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (!hasPaperEditablePath(element)) {
    return moveVectorEditablePointFallback(element, pointIndex, x, y)
  }
  // Group units use the surgical single-leaf write-back below (same contract
  // as `vector-path-points.ts`): only the edited leaf's `d` (or a one-time
  // shape→path swap) is patched, so wrapper transforms, inherited paint,
  // siblings, Z-order and the explicit-group marker survive. Single `<path>`
  // units keep the legacy whole-subtree export.
  if (element.tagName.toLowerCase() === 'g') {
    return moveGroupEditablePointSurgically(element, pointIndex, x, y, splitHandles)
  }
  const native = toNativePoint(element, x, y)
  // Singular / non-finite ancestors: refuse with no DOM write (fail-closed).
  if (!native) return false
  let applied = false
  try {
    await updateElementWithPaper(element, (item, scope) => {
      const target = new scope.Point(native.x, native.y)
      const editable = paperEditablePathPoint(item, pointIndex)
      if (!editable) return
    const localTarget = localPoint(editable.path, target)
    if (editable.kind === 'anchor') {
      editable.segment.point = localTarget
      applied = true
      return
    }
    const nextHandle = localTarget.subtract(editable.segment.point)
    if (editable.controlRole === 'in') {
      const mirror = shouldMirrorHandles(editable.segment.handleIn, editable.segment.handleOut, splitHandles)
      const oppositeLength = editable.segment.handleOut.length
      editable.segment.handleIn = nextHandle
      if (mirror) editable.segment.handleOut = mirroredHandle(nextHandle, oppositeLength)
    } else {
      const mirror = shouldMirrorHandles(editable.segment.handleOut, editable.segment.handleIn, splitHandles)
      const oppositeLength = editable.segment.handleIn.length
      editable.segment.handleOut = nextHandle
      if (mirror) editable.segment.handleIn = mirroredHandle(nextHandle, oppositeLength)
    }
    applied = true
    })
  } catch (error) {
    // Over-budget/unreadable tree: no DOM write happened (the mutator threw
    // before any export), so refuse with no history.
    if (isPaperTreeTooLarge(error)) return false
    return false
  }
  return applied
}

// Group single-point (anchor or control) move with user-data-first surgical
// write-back. The detached import expands leaf Shapes so flattened indices
// match the display list (`paperEditablePointsForElement`) and the bulk mover
// (`moveVectorReshapePoints`); only the edited Paper path is written back to
// its DOM leaf. Fail-closed: a patch failure (singular in-unit matrix or
// ordering divergence) returns false with the DOM untouched — never falls
// back to a whole-subtree replace, which would bake collapsed geometry and
// drop wrapper transforms. Compound children stay flattened — no per-child
// subselection.
async function moveGroupEditablePointSurgically(element: Element, pointIndex: number, x: number, y: number, splitHandles: boolean): Promise<boolean> {
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) return false
  let root: paper.Item = imported
  try {
    root = expandPaperShapesToPaths(imported)
    const editable = paperEditablePathPoint(root, pointIndex)
    if (!editable) return false
    const native = toNativePoint(element, x, y)
    if (!native) return false
    const localTarget = localPoint(editable.path, new scope.Point(native.x, native.y))
    if (editable.kind === 'anchor') {
      editable.segment.point = localTarget
    } else {
      const nextHandle = localTarget.subtract(editable.segment.point)
      if (editable.controlRole === 'in') {
        const mirror = shouldMirrorHandles(editable.segment.handleIn, editable.segment.handleOut, splitHandles)
        const oppositeLength = editable.segment.handleOut.length
        editable.segment.handleIn = nextHandle
        if (mirror) editable.segment.handleOut = mirroredHandle(nextHandle, oppositeLength)
      } else {
        const mirror = shouldMirrorHandles(editable.segment.handleOut, editable.segment.handleIn, splitHandles)
        const oppositeLength = editable.segment.handleIn.length
        editable.segment.handleOut = nextHandle
        if (mirror) editable.segment.handleIn = mirroredHandle(nextHandle, oppositeLength)
      }
    }
    return writeBackSingleGroupPath(scope, element, root, editable.path)
  } catch (error) {
    // Over-budget/unreadable tree (expansion, point scan, or write-back
    // identity): the DOM is untouched — never a partial write-back.
    if (isPaperTreeTooLarge(error)) return false
    return false
  } finally {
    try {
      root.remove()
    } catch {
      // Already detached via export; nothing to clean up.
    }
  }
}

const GROUP_LEAF_GEOMETRY_ATTRIBUTES = new Set([
  'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r',
  'x1', 'y1', 'x2', 'y2', 'points', 'd',
])

// DOM counterparts of `paperPathItems` for `<g>` units, in the same document
// order: leaf shapes depth-first, skipping wrapper groups and non-geometry
// nodes. Index `i` of `paperPathItems` (post-expansion) corresponds to index
// `i` here, mirroring `vector-path-points.ts`.
function groupDomLeafTargets(element: Element): Element[] {
  const out: Element[] = []
  const walk = (node: Element) => {
    const childTag = node.tagName.toLowerCase()
    if (childTag === 'g') {
      for (const child of Array.from(node.children)) walk(child as Element)
      return
    }
    if (
      childTag === 'path' || childTag === 'rect' || childTag === 'ellipse' ||
      childTag === 'circle' || childTag === 'line' || childTag === 'polyline' ||
      childTag === 'polygon'
    ) {
      out.push(node)
    }
  }
  for (const child of Array.from(element.children)) walk(child as Element)
  return out
}

function groupLeafLocalPathData(scope: paper.PaperScope, element: Element, dom: Element, path: paper.Path): string | undefined {
  const direct = (path as unknown as { pathData?: unknown }).pathData
  if (typeof direct !== 'string' || !direct) return undefined
  const parent = element.parentElement as Element | null
  const matrix = worldTransformMatrix(dom, parent)
  if (!matrix) return direct
  let clone: paper.Path | undefined
  try {
    // Singular / non-finite in-unit matrix: the baked unit-frame geometry has
    // no unique leaf-local preimage. Return undefined so the caller refuses
    // (no whole-subtree fallback, which would bake collapsed geometry).
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

function patchGroupDomLeaf(scope: paper.PaperScope, element: Element, dom: Element, path: paper.Path): boolean {
  try {
    const data = groupLeafLocalPathData(scope, element, dom, path)
    if (!data) return false
    if (dom.tagName.toLowerCase() === 'path') {
      dom.setAttribute('d', data)
      cleanSvgElementAttributes(dom)
      return true
    }
    const doc = dom.ownerDocument
    const namespace = dom.namespaceURI ?? 'http://www.w3.org/2000/svg'
    const next = doc.createElementNS(namespace, 'path')
    for (const name of dom.getAttributeNames()) {
      if (GROUP_LEAF_GEOMETRY_ATTRIBUTES.has(name)) continue
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

function writeBackSingleGroupPath(scope: paper.PaperScope, element: Element, root: paper.Item, editedPath: paper.Path): boolean {
  try {
    // Identity is exact-or-refuse: a truncated Paper list must never patch the
    // wrong DOM leaf. The sentinel (not a length mismatch) is the refusal
    // signal; both map to false with the DOM untouched.
    const paperPaths = paperPathItems(root)
    const targets = groupDomLeafTargets(element)
    if (paperPaths.indexOf(editedPath) < 0 || paperPaths.length !== targets.length) {
      return false
    }
    const target = targets[paperPaths.indexOf(editedPath)]
    if (!target || !patchGroupDomLeaf(scope, element, target, editedPath)) {
      return false
    }
    return true
  } catch (error) {
    if (isPaperTreeTooLarge(error)) return false
    return false
  }
}

function hasPaperEditablePath(element: Element) {
  const tag = element.tagName.toLowerCase()
  return tag === 'path' || tag === 'g'
}

function paperEditablePathPoint(item: paper.Item, pointIndex: number) {
  // Throws the private sentinel on over-budget/unreadable trees (never a
  // partial scan): callers refuse the edit with the DOM untouched.
  const paths = paperPathItems(item)
  countPaperSegmentsOrThrow(paths)
  let index = 0
  for (const path of paths) {
    let segments: paper.Segment[]
    try {
      segments = path.segments as paper.Segment[]
    } catch {
      throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    }
    if (!Array.isArray(segments)) throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    for (const segment of segments) {
      if (index === pointIndex) return { path, segment, kind: 'anchor' as const }
      index += 1
      if (!isZeroPaperPoint(segment.handleIn)) {
        if (index === pointIndex) return { path, segment, kind: 'control' as const, controlRole: 'in' as const }
        index += 1
      }
      if (!isZeroPaperPoint(segment.handleOut)) {
        if (index === pointIndex) return { path, segment, kind: 'control' as const, controlRole: 'out' as const }
        index += 1
      }
    }
  }
  return undefined
}

function shouldMirrorHandles(moved: paper.Point, opposite: paper.Point, splitHandles: boolean) {
  if (splitHandles || isZeroPaperPoint(moved) || isZeroPaperPoint(opposite)) return false
  return areColinear(moved, opposite)
}

function areColinear(left: paper.Point, right: paper.Point) {
  const cross = left.x * right.y - left.y * right.x
  return Math.abs(cross) <= Math.max(0.001, left.length * right.length * 0.001)
}

function mirroredHandle(handle: paper.Point, length: number) {
  if (isZeroPaperPoint(handle) || length <= 0) return handle.multiply(0)
  return handle.normalize(length).multiply(-1)
}

export type VectorResizeModifiers = {
  /** true で角ハンドルを自由比にする (辺ハンドルは常に自由比)。 */
  shiftKey?: boolean
  /** true で基準点をバウンズ中心にする。 */
  altKey?: boolean
}

function resizeScaleForHandle(handle: VectorResizeHandle, bounds: VectorBounds, dx: number, dy: number, modifiers: VectorResizeModifiers = {}) {
  // Scratch 互換: 角は通常等比・Shift 自由比、Alt は中心基準、辺は片軸、反転可。
  // 純粋計算は vector-scale-modifiers.ts に集約し、ここでは Paper 適用だけ行う。
  const { pivot, scaleX, scaleY } = resolveVectorScale(handle, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }, dx, dy, modifiers)
  return { fixed: new PointLike(pivot.x, pivot.y), sx: scaleX, sy: scaleY }
}

class PointLike {
  constructor(public x: number, public y: number) {}
}

// Paper Shapes retain a scale transform on SVG export, which also scales the stroke.
// Convert them to paths so Paper applies resizing to the geometry, as in Scratch's scale tool.
function prepareForGeometryScaling(item: paper.Item): paper.Item {
  if (item.className === 'Shape') {
    const path = (item as paper.Shape).toPath(false)
    item.remove()
    return path
  }
  const children = (item as paper.Group).children
  if (children) {
    for (const child of Array.from(children)) {
      if (child.className === 'Shape') {
        const path = (child as paper.Shape).toPath(false)
        child.replaceWith(path)
      } else {
        prepareForGeometryScaling(child)
      }
    }
  }
  return item
}

// Fail-closed gate for single-unit Paper geometry edits (Grow / Rotate /
// Flip via `updateElementWithPaper`, single-handle resize, and the multi
// arrangement conjugations below). Every matrix the edit depends on is
// inverted explicitly before any DOM write:
// - ancestor chain (`ancestorWorldMatrix`): the world delta/point has no
//   unique native preimage when collapsed,
// - full document matrix (`worldTransformMatrix`: ancestors + own): an own
//   `scale(0)` collapses the unit even with clean ancestors,
// - in-unit chain (unit root -> descendant): a nested `scale(0)` inside a
//   `<g>` unit collapses the baked Paper import for that leaf, so scaling or
//   rotating the import would bake collapsed geometry.
// Reversible non-uniform / skew / rotate / mirror ancestors stay invertible
// and remain editable; only singular / non-finite frames refuse with no DOM
// write so callers can skip the history commit.
function vectorUnitHasSingularInUnitTransform(element: Element): boolean {
  try {
    if (element.tagName.toLowerCase() !== 'g') return false
    const stack: Element[] = []
    for (const child of Array.from(element.children)) {
      if ((child as Element).nodeType === 1) stack.push(child as Element)
    }
    while (stack.length > 0) {
      const node = stack.pop()!
      let relative: VectorMatrix | undefined
      try {
        relative = worldTransformMatrix(node, element)
      } catch {
        return true
      }
      if (relative && !tryInvertVectorMatrix(relative)) return true
      for (const child of Array.from(node.children)) {
        if ((child as Element).nodeType === 1) stack.push(child as Element)
      }
    }
    return false
  } catch {
    return true
  }
}

function canApplyPaperGeometryEdit(element: Element): boolean {
  try {
    const ancestors = ancestorWorldMatrix(element)
    if (ancestors && !tryInvertVectorMatrix(ancestors)) return false
    const world = worldTransformMatrix(element)
    if (world && !tryInvertVectorMatrix(world)) return false
    if (vectorUnitHasSingularInUnitTransform(element)) return false
    return true
  } catch {
    return false
  }
}

export async function resizeVectorElementBy(element: Element, handle: VectorResizeHandle, dx: number, dy: number, modifiers: VectorResizeModifiers = {}): Promise<boolean> {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  if (!canApplyPaperGeometryEdit(element)) return false
  const native = toNativeDelta(element, dx, dy)
  // Singular / non-finite ancestors: the world delta has no unique native
  // preimage. Refuse with no DOM write (fail-closed) so no empty history is
  // needed; identity fallback would move the leaf in the wrong frame.
  if (!native) return false
  const scope = await ensureVectorPaperScope()
  const imported = importPaperItem(scope, element)
  if (!imported) return false
  // prepareForGeometryScaling が Shape を Path 化した場合は元 item を破棄して
  // 新 item を返すため、finally では返却値だけを remove する。
  const target = prepareForGeometryScaling(imported)
  try {
    const bounds = target.bounds
    const { fixed, sx, sy } = resizeScaleForHandle(handle, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }, native.dx, native.dy, modifiers)
    // 等倍 (操作軸なし・微小移動の丸め結果を含む) は DOM を触らず no-op 扱いに
    // することで、呼び出し側が空の Undo を積まないようにできる。
    if (sx === 1 && sy === 1) return false
    target.scale(sx, sy, new scope.Point(fixed.x, fixed.y))
    replaceElementWithPaperItem(element, target)
    return true
  } finally {
    try {
      target.remove()
    } catch {
      // 既に破棄済みの場合は無視する。
    }
  }
}

export async function applyPaperScale(element: Element, factor: number): Promise<boolean> {
  if (!Number.isFinite(factor) || factor === 1) return false
  if (!canApplyPaperGeometryEdit(element)) return false
  await updateElementWithPaper(element, (item) => item.scale(Math.max(0.05, factor)), prepareForGeometryScaling)
  return true
}

export async function applyPaperRotation(element: Element, degrees: number): Promise<boolean> {
  if (!Number.isFinite(degrees) || degrees === 0) return false
  if (!canApplyPaperGeometryEdit(element)) return false
  await updateElementWithPaper(element, (item) => item.rotate(degrees))
  return true
}

export async function applyPaperFlip(element: Element, horizontal: boolean): Promise<boolean> {
  if (!canApplyPaperGeometryEdit(element)) return false
  await updateElementWithPaper(element, (item) => item.scale(horizontal ? -1 : 1, horizontal ? 1 : -1))
  return true
}

export type VectorSelectionBounds = { x: number; y: number; width: number; height: number; centerX: number; centerY: number }

// Union of the document-space bounds of the given units. Geometric bounds
// include ancestor transforms, so the shared center stays correct for nested
// groups without moving any ancestor or sibling.
export async function vectorSelectionBounds(elements: Element[]): Promise<VectorSelectionBounds | undefined> {
  if (elements.length === 0) return undefined
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const element of elements) {
    const bounds = vectorObjectBounds(element)
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) continue
    if (bounds.width <= 0 && bounds.height <= 0) continue
    left = Math.min(left, bounds.x)
    top = Math.min(top, bounds.y)
    right = Math.max(right, bounds.x + bounds.width)
    bottom = Math.max(bottom, bounds.y + bounds.height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return undefined
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return { x: left, y: top, width, height, centerX: left + width / 2, centerY: top + height / 2 }
}

function multiplyVectorMatrices(left: VectorMatrix, right: VectorMatrix): VectorMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function formatMatrixNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const fixed = Number(value.toFixed(4))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

// Mirror `vectorSelectionBounds` for detached source snapshots: the union is
// derived from document-space geometric bounds (ancestor transforms included)
// so the shared pivot/center matches the live document without moving any
// ancestor or sibling.
function unionElementBounds(elements: Element[]): VectorBounds | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const element of elements) {
    let bounds: VectorBounds
    try {
      bounds = vectorObjectBounds(element)
    } catch {
      continue
    }
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) continue
    if (bounds.width <= 0 && bounds.height <= 0) continue
    left = Math.min(left, bounds.x)
    top = Math.min(top, bounds.y)
    right = Math.max(right, bounds.x + bounds.width)
    bottom = Math.max(bottom, bounds.y + bounds.height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return undefined
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

// Scale a multi-selection through one shared world matrix (`vector-multi-scale`
// semantics: corners uniform by default / Shift free, edges single-axis,
// Alt centered, negative factors flip). Each unit receives the conjugated
// local matrix via `applyWorldMatrixToVectorElement`, so ancestors and
// document order are untouched and every unit travels with the same `W`.
//
// The `matrix(...)` prefix scales the rendered stroke through the SVG CTM,
// matching the single-unit Paper resize (geometry + stroke grow together).
// Per-element `item.scale(sx, sy, pivot)` is intentionally not used: scaling
// around each unit's own bounds would break the shared arrangement.
// Identity results are a no-op (returns false, DOM untouched) so callers can
// skip empty undo entries, mirroring `resizeVectorElementBy`.
export function scaleVectorElementsByCommonBounds(
  elements: Element[],
  handle: VectorResizeHandle,
  dx: number,
  dy: number,
  modifiers: VectorResizeModifiers = {},
): boolean {
  if (elements.length === 0) return false
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  const union = unionElementBounds(elements)
  if (!union) return false
  const resolved = resolveCommonVectorScale(handle, union, dx, dy, modifiers)
  if (resolved.noop) return false
  if (!resolved.world.every((value) => Number.isFinite(value))) return false
  if (!tryInvertVectorMatrix(resolved.world as VectorMatrix)) return false
  // Fail-closed: any singular / non-finite ancestor, own world, or nested
  // in-unit frame refuses the whole operation with no DOM write (empty
  // history prevention).
  for (const element of elements) {
    if (!canApplyPaperGeometryEdit(element)) return false
  }
  for (const element of elements) {
    if (!applyWorldMatrixToVectorElement(element, resolved.world as VectorMatrix)) return false
  }
  return true
}

// Document-space rotation about the shared center.
export function worldRotateMatrix(centerX: number, centerY: number, degrees: number): VectorMatrix {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [
    cos,
    sin,
    -sin,
    cos,
    centerX - cos * centerX + sin * centerY,
    centerY - sin * centerX - cos * centerY,
  ]
}

// Document-space mirror about the shared center line.
export function worldFlipMatrix(centerX: number, centerY: number, horizontal: boolean): VectorMatrix {
  return horizontal ? [-1, 0, 0, 1, centerX * 2, 0] : [1, 0, 0, -1, 0, centerY * 2]
}

// Apply a document-space matrix to one unit without touching its ancestors
// or siblings. The local matrix L = A^-1 * W * A keeps the on-screen result
// equal to W while the ancestor chain A stays in place, so nested groups
// keep their transforms and the document order never changes.
// Fail-closed: singular / non-finite ancestors, own world, in-unit frames,
// or world matrices return false with the DOM untouched (identity-fallback
// `W*A` would write a bogus prefix that teleports the leaf on ancestor
// repair).
export function applyWorldMatrixToVectorElement(element: Element, world: VectorMatrix): boolean {
  try {
    if (!world || world.length < 6 || !world.every((value) => Number.isFinite(value))) return false
    if (!tryInvertVectorMatrix(world)) return false
    if (!canApplyPaperGeometryEdit(element)) return false
    const ancestors = ancestorWorldMatrix(element)
    let local: VectorMatrix = world
    if (ancestors) {
      const inverse = tryInvertVectorMatrix(ancestors)
      if (!inverse) return false
      local = multiplyVectorMatrices(multiplyVectorMatrices(inverse, world), ancestors)
      if (!local.every((value) => Number.isFinite(value))) return false
    }
    const matrix = `matrix(${local.map(formatMatrixNumber).join(' ')})`
    const existing = element.getAttribute('transform') ?? ''
    element.setAttribute('transform', existing ? `${matrix} ${existing}` : matrix)
    return true
  } catch {
    return false
  }
}

// Rotate every unit around the same document-space center. Positions travel
// around the center while each shape keeps its own orientation change.
// Fail-closed: any singular ancestor, own world, or nested in-unit frame
// refuses the whole arrangement with no DOM write (returns false) so history
// stays clean.
export function rotateVectorElementsAroundCenter(elements: Element[], degrees: number, center: { x: number; y: number }): boolean {
  if (elements.length === 0 || !Number.isFinite(degrees) || !degrees) return false
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return false
  const world = worldRotateMatrix(center.x, center.y, degrees)
  for (const element of elements) {
    if (!canApplyPaperGeometryEdit(element)) return false
  }
  for (const element of elements) {
    if (!applyWorldMatrixToVectorElement(element, world)) return false
  }
  return true
}

// Mirror every unit as a single arrangement around the same center line.
// Each shape is mirrored and its position is mirrored, matching a grouped flip.
// Fail-closed: any singular ancestor, own world, or nested in-unit frame
// refuses the whole arrangement.
export function flipVectorElementsAroundCenter(elements: Element[], horizontal: boolean, center: { x: number; y: number }): boolean {
  if (elements.length === 0) return false
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return false
  const world = worldFlipMatrix(center.x, center.y, horizontal)
  for (const element of elements) {
    if (!canApplyPaperGeometryEdit(element)) return false
  }
  for (const element of elements) {
    if (!applyWorldMatrixToVectorElement(element, world)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Group-leaf reshape hit testing (reshape subselect inside `<g>` units).
// ---------------------------------------------------------------------------
//
// Scratch reshape resolves a click to one child shape inside a group via a
// real Paper.js `hitTest` (fill/stroke/curve/segment, topmost wins) and then
// operates on that leaf while siblings, Z-order and ancestor transforms stay
// untouched. A bounding-box pre-filter alone is dangerous for overlaps: the
// topmost box can name the wrong child. These helpers provide the real-hit
// path for this editor:
//
// - `paperGroupLeafHitAtPoint` imports the unit once (ancestor transforms and
//   inherited paint baked, same as the select-tool hit path), expands leaf
//   Shapes to paths in the detached import only, and maps the topmost Paper
//   hit back to the DOM leaf index in document order.
// - `paperFlatAnchorIndicesForGroupLeaves` / `paperLeafIndexForFlatAnchor`
//   translate between DOM leaf indices and the flattened Paper-scheme anchor
//   slots the reshape movers use, so a leaf click can select exactly its own
//   anchors (anchor-only; control slots are never bulk-moved).
//
// Fail-closed contract (callers must treat `unsupported` as an explicit
// no-op: honest status, no history, no selection change):
// - Only `<g>` units whose descendants are all plain geometry leaves
//   (`path`/`rect`/`ellipse`/`circle`/`line`/`polyline`/`polygon`, possibly
//   nested in plain `<g>` wrappers) are supported. Text (`text`/`tspan`),
//   raster (`image`), references (`use`), embedded content
//   (`foreignObject`), clip/mask companions or `clip-path`/`mask` styling on
//   the unit or its descendants report `unsupported`.
// - Compound content (an imported `CompoundPath`, or a single leaf whose
//   `pathData` carries 2+ subpaths) reports `unsupported`: hole/overlap
//   resolution would be a guess.
// - When the Paper path count diverges from the DOM leaf count, identity is
//   ambiguous and the probe reports `unsupported` instead of moving the wrong
//   child. Stock Paper.js items that are not paths (`PointText`, `Raster`,
//   `PlacedSymbol`, unexpanded `Shape`) also report `unsupported`.
// - The live DOM is never mutated here; only the detached Paper import is
//   expanded/removed. Non-finite points and failed imports are `miss`/`import-failed`.

export type PaperGroupLeafHit =
  | { kind: 'hit'; leafIndex: number; hitType: string }
  | { kind: 'miss' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'import-failed'; reason: string }

const GROUP_LEAF_HIT_TAGS = new Set([
  'path',
  'rect',
  'ellipse',
  'circle',
  'line',
  'polyline',
  'polygon',
])

const GROUP_LEAF_BLOCKED_TAGS = new Set([
  'text',
  'tspan',
  'tref',
  'image',
  'use',
  'foreignobject',
  'clipPath',
  'mask',
  'foreignobject',
])

function groupLeafHasBlockingStyle(element: Element): boolean {
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

function groupLeafDomTargetsInOrder(element: Element): Element[] | undefined {
  try {
    const tag = element.tagName.toLowerCase()
    if (tag !== 'g') return undefined
    const out: Element[] = []
    const walk = (node: Element): boolean => {
      for (const child of Array.from(node.children)) {
        const childElement = child as Element
        if (childElement.nodeType !== 1) continue
        const childTag = childElement.tagName.toLowerCase()
        if (childTag === 'g') {
          if (groupLeafHasBlockingStyle(childElement)) return false
          if (!walk(childElement)) return false
          continue
        }
        if (GROUP_LEAF_BLOCKED_TAGS.has(childTag)) return false
        if (childTag === 'clippath' || childTag === 'mask') return false
        if (groupLeafHasBlockingStyle(childElement)) return false
        if (GROUP_LEAF_HIT_TAGS.has(childTag)) {
          out.push(childElement)
          continue
        }
        // Transparent wrappers (`a`/`switch`/nested `svg`) carry no geometry:
        // descend without recording a level. Anything else with children is
        // descended for blocked-tag detection; childless unknowns (e.g.
        // `desc`, `title`, `defs`) are skipped as non-geometry.
        if (childTag === 'a' || childTag === 'switch' || childTag === 'svg' || childTag === 'defs' || childTag === 'metadata' || childTag === 'title' || childTag === 'desc') {
          if (childElement.children.length > 0 && !walk(childElement)) return false
          continue
        }
        if (childElement.children.length > 0) {
          if (!walk(childElement)) return false
          continue
        }
      }
      return true
    }
    if (groupLeafHasBlockingStyle(element)) return undefined
    // Ancestor clip/mask above the unit would misplace a baked hit: decline.
    try {
      let node = element.parentElement
      while (node && node.nodeName.toLowerCase() !== 'svg') {
        if (groupLeafHasBlockingStyle(node)) return undefined
        node = node.parentElement
      }
    } catch {
      return undefined
    }
    if (!walk(element)) return undefined
    return out
  } catch {
    return undefined
  }
}

function groupLeafPaperPaths(root: paper.Item): paper.Path[] {
  const paths = paperPathItems(root)
  return paths
}

function groupLeafPathDataHasMultipleSubpaths(path: paper.Path): boolean {
  try {
    const raw = (path as unknown as { pathData?: unknown }).pathData
    if (typeof raw !== 'string' || raw.length === 0) return false
    let moves = 0
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i]
      if (ch === 'M' || ch === 'm') {
        moves += 1
        if (moves > 1) return true
      }
    }
    return false
  } catch {
    return false
  }
}

function groupLeafImportHasCompound(root: paper.Item): boolean {
  // Iterative with the shared budget: over-budget/unreadable throws the
  // private sentinel (callers map it to `unsupported`), never a partial scan.
  const stack: paper.Item[] = [root]
  let visited = 0
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    if (++visited > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    const current = stack.pop()!
    let className: unknown
    try {
      className = (current as unknown as { className?: unknown }).className
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (className === 'CompoundPath') return true
    let children: unknown
    try {
      children = (current as unknown as { children?: unknown }).children
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (Array.isArray(children)) {
      for (const child of children as paper.Item[]) stack.push(child)
    }
  }
  return false
}

function importGroupLeafRoot(scope: paper.PaperScope, element: Element): paper.Item | undefined {
  try {
    const root = typeof element.closest === 'function' ? element.closest('svg') : undefined
    const baked = root ? bakedUnitClone(root, element) : undefined
    const source = baked ?? element
    const serialized = sanitizeSvgFragmentForPaperImport(new XMLSerializer().serializeToString(source))
    if (!serialized || serialized === SVG_PLACEHOLDER) return undefined
    const imported = (scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }).importSVG(serialized, { insert: false })
    if (!imported) return undefined
    return expandPaperShapesToPaths(imported)
  } catch {
    return undefined
  }
}

/**
 * Resolve a document-space point to one DOM leaf index inside a `<g>` unit
 * with a real Paper.js `hitTest` (topmost wins, so overlaps resolve to the
 * painted-top child). Returns `miss` for clean misses and `unsupported` for
 * text/raster/clip/compound/ambiguous units (fail-closed: no history, no
 * selection change, honest status).
 */
export async function paperGroupLeafHitAtPoint(
  element: Element,
  point: { x: number; y: number },
  tolerance = VECTOR_HIT_TOLERANCE,
): Promise<PaperGroupLeafHit> {
  try {
    if (!element || element.tagName.toLowerCase() !== 'g') {
      return { kind: 'unsupported', reason: 'not a group unit (fail-closed)' }
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'miss' }
    const domLeaves = groupLeafDomTargetsInOrder(element)
    if (domLeaves === undefined) {
      return { kind: 'unsupported', reason: 'text/raster/clip content in group (fail-closed)' }
    }
    if (domLeaves.length === 0) {
      return { kind: 'unsupported', reason: 'empty group has no leaf (fail-closed)' }
    }
    const scope = await ensureVectorPaperScope()
    const root = importGroupLeafRoot(scope, element)
    if (!root) return { kind: 'import-failed', reason: 'paper import failed (fail-closed)' }
    try {
      if (groupLeafImportHasCompound(root)) {
        return { kind: 'unsupported', reason: 'compound path in group (fail-closed)' }
      }
      const paperPaths = groupLeafPaperPaths(root)
      if (paperPaths.length !== domLeaves.length) {
        return { kind: 'unsupported', reason: `ambiguous group identity: ${paperPaths.length} paper paths vs ${domLeaves.length} dom leaves (fail-closed)` }
      }
      for (const path of paperPaths) {
        if (groupLeafPathDataHasMultipleSubpaths(path)) {
          return { kind: 'unsupported', reason: 'multi-subpath leaf in group (fail-closed)' }
        }
      }
      const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : VECTOR_HIT_TOLERANCE
      const target = new scope.Point(point.x, point.y)
      let hit: { type?: string; item?: paper.Item } | null = null
      try {
        hit = (root as unknown as { hitTest?: (point: unknown, options: unknown) => unknown }).hitTest?.(target, {
          fill: true,
          stroke: true,
          curves: true,
          segments: true,
          tolerance: safeTolerance,
          guide: false,
        }) as { type?: string; item?: paper.Item } | null
      } catch {
        return { kind: 'miss' }
      }
      if (!hit) return { kind: 'miss' }
      const hitItem = hit.item as paper.Item | undefined
      if (!hitItem) return { kind: 'miss' }
      const hitClass = (hitItem as unknown as { className?: string }).className ?? ''
      if (hitClass === 'PointText' || hitClass === 'TextItem' || hitClass === 'Raster' || hitClass === 'PlacedSymbol' || hitClass === 'Shape') {
        return { kind: 'unsupported', reason: `non-geometry hit (${hitClass}) in group (fail-closed)` }
      }
      const order = paperPaths.indexOf(hitItem as paper.Path)
      if (order < 0) {
        // A hit on a wrapper/group itself (or a compound child): no leaf owns it.
        return { kind: 'unsupported', reason: 'hit did not resolve to one leaf (fail-closed)' }
      }
      return { kind: 'hit', leafIndex: order, hitType: hit.type ?? 'fill' }
    } finally {
      try {
        root.remove()
      } catch {
        // Detached import; nothing to clean up.
      }
    }
  } catch {
    return { kind: 'unsupported', reason: 'group leaf probe failed (fail-closed)' }
  }
}

function flattenedAnchorSlots(item: paper.Item): Array<{ pathOrder: number; flatIndex: number }> {
  // Throws the private sentinel on over-budget/unreadable trees (never a
  // partial slot list): callers keep the existing selection.
  const out: Array<{ pathOrder: number; flatIndex: number }> = []
  let flat = 0
  const paths = groupLeafPaperPaths(item)
  countPaperSegmentsOrThrow(paths)
  paths.forEach((path, pathOrder) => {
    let segments: unknown
    try {
      segments = (path as unknown as { segments?: unknown }).segments
    } catch {
      throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    }
    if (!Array.isArray(segments)) throw new PaperTreeTooLargeError('paper segments unreadable (fail-closed)')
    for (const segment of segments as paper.Segment[]) {
      out.push({ pathOrder, flatIndex: flat })
      flat += 1
      if (!isZeroPaperPoint(segment.handleIn)) flat += 1
      if (!isZeroPaperPoint(segment.handleOut)) flat += 1
    }
  })
  return out
}

/**
 * Flattened Paper-scheme *anchor* slots owned by the given DOM leaf indices.
 * Control slots are excluded (bulk translation is anchor-only). Returns
 * `undefined` when the unit is not leaf-editable or identity is ambiguous
 * (fail-closed: caller keeps the existing selection).
 */
export async function paperFlatAnchorIndicesForGroupLeaves(
  element: Element,
  leafIndices: readonly number[],
): Promise<number[] | undefined> {
  try {
    const wanted = new Set(leafIndices.filter((index) => Number.isInteger(index) && index >= 0))
    if (wanted.size === 0) return []
    if (!element || element.tagName.toLowerCase() !== 'g') return undefined
    const domLeaves = groupLeafDomTargetsInOrder(element)
    if (domLeaves === undefined || domLeaves.length === 0) return undefined
    if ([...wanted].some((index) => index >= domLeaves.length)) return undefined
    const scope = await ensureVectorPaperScope()
    const root = importGroupLeafRoot(scope, element)
    if (!root) return undefined
    try {
      if (groupLeafImportHasCompound(root)) return undefined
      const paperPaths = groupLeafPaperPaths(root)
      if (paperPaths.length !== domLeaves.length) return undefined
      for (const path of paperPaths) {
        if (groupLeafPathDataHasMultipleSubpaths(path)) return undefined
      }
      return flattenedAnchorSlots(root)
        .filter((slot) => wanted.has(slot.pathOrder))
        .map((slot) => slot.flatIndex)
        .sort((a, b) => a - b)
    } finally {
      try {
        root.remove()
      } catch {
        // Detached import; nothing to clean up.
      }
    }
  } catch {
    return undefined
  }
}

/**
 * Which DOM leaf owns a flattened Paper-scheme anchor slot? Returns
 * `undefined` for control slots, out-of-range slots, and ambiguous units
 * (fail-closed).
 */
export async function paperLeafIndexForFlatAnchor(element: Element, flatIndex: number): Promise<number | undefined> {
  try {
    if (!Number.isInteger(flatIndex) || flatIndex < 0) return undefined
    if (!element || element.tagName.toLowerCase() !== 'g') return undefined
    const domLeaves = groupLeafDomTargetsInOrder(element)
    if (domLeaves === undefined || domLeaves.length === 0) return undefined
    const scope = await ensureVectorPaperScope()
    const root = importGroupLeafRoot(scope, element)
    if (!root) return undefined
    try {
      if (groupLeafImportHasCompound(root)) return undefined
      const paperPaths = groupLeafPaperPaths(root)
      if (paperPaths.length !== domLeaves.length) return undefined
      const slot = flattenedAnchorSlots(root).find((entry) => entry.flatIndex === flatIndex)
      return slot?.pathOrder
    } finally {
      try {
        root.remove()
      } catch {
        // Detached import; nothing to clean up.
      }
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Group-leaf whole-translate hit testing (text/image + geometry, `use` closed).
// ---------------------------------------------------------------------------
//
// Scratch reshape moves one child shape inside a group as a whole. The
// geometry-only probe above declines the whole unit as soon as any
// text/raster/reference content appears. This translate probe admits the safe
// subset — geometry + `text` + `image` leaves moved atomically via
// `planLeafDocumentTranslate` — while `use` (shadow/filter complexity, no
// live evidence), `foreignObject`, clip/mask companions and clip/mask styling
// stay fail-closed with an explicit `unsupported` status and no DOM write.
//
// Safety: DOM gate first (cheap, no import), then per-leaf Paper imports with
// baked ancestor transforms (nested `translate`/`scale`/`rotate`/`skew`
// honored). Per-leaf imports keep RTL text (`direction="rtl"` mirrored via
// the shared `rtlMirroredHitPoint`), text bounding and matrix errors exact:
// a leaf Paper cannot import (hidden, compound, multi-subpath, PlacedSymbol,
// unexpanded Shape, sanitize placeholder) makes the whole unit `unsupported`
// instead of guessing via bounds. Topmost wins (reverse document order), so
// overlaps name the painted-top child, never a bbox guess.

export type PaperGroupTranslateLeafHit =
  | { kind: 'hit'; leafIndex: number; leafTag: string; hitType: string }
  | { kind: 'miss' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'import-failed'; reason: string }

const GROUP_TRANSLATE_GEOMETRY_TAGS = new Set([
  'path',
  'rect',
  'ellipse',
  'circle',
  'line',
  'polyline',
  'polygon',
])

const GROUP_TRANSLATE_HARD_BLOCKED_TAGS = new Set([
  'use',
  'tspan',
  'tref',
  'foreignobject',
  'video',
  'audio',
  'iframe',
  'clipPath',
  'mask',
  'clippath',
])

function groupTranslateHasBlockingStyle(element: Element): boolean {
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

function groupTranslateLeafTag(element: Element): string {
  try {
    return element.tagName.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * DOM-only gate for whole-leaf translate subselection. Returns `ok:true`
 * only for `<g>` units whose rendered descendants are all geometry / `text` /
 * `image` leaves (possibly nested in plain `<g>` wrappers). `use`,
 * `foreignObject`, clip/mask companions, clip/mask styling, `data-is-pg-text-item`
 * markers and defs-homed paths fail closed. Geometry/text/image leaves are
 * validated through `classifyLeafElementForTranslate` so href/size/tspan/clip
 * rules stay single-sourced with the planner.
 */
export function classifyGroupUnitForLeafTranslate(unitRoot: Element): { ok: true } | { ok: false; reason: string } {
  try {
    if (!unitRoot || (unitRoot as Element).nodeType !== 1) return { ok: false, reason: 'not an element (fail-closed)' }
    if (groupTranslateLeafTag(unitRoot) !== 'g') return { ok: false, reason: 'not a group unit (fail-closed)' }
    try {
      if ((unitRoot as Element).hasAttribute?.('data-is-pg-text-item')) {
        return { ok: false, reason: 'text group is not leaf-editable (fail-closed)' }
      }
    } catch {
      return { ok: false, reason: 'text group check failed (fail-closed)' }
    }
    if (groupTranslateHasBlockingStyle(unitRoot)) {
      return { ok: false, reason: 'clip/mask on group (fail-closed)' }
    }
    try {
      let node = (unitRoot as Element).parentElement
      while (node && groupTranslateLeafTag(node) !== 'svg') {
        if (groupTranslateHasBlockingStyle(node)) {
          return { ok: false, reason: 'clip/mask above group (fail-closed)' }
        }
        if (groupTranslateLeafTag(node) === 'defs') {
          return { ok: false, reason: 'group inside defs (fail-closed)' }
        }
        node = node.parentElement
      }
    } catch {
      return { ok: false, reason: 'ancestor clip check failed (fail-closed)' }
    }
    const targets = groupTranslateLeafTargetsInOrder(unitRoot)
    if (targets === undefined) {
      return { ok: false, reason: 'use/clip/content in group is not translatable (fail-closed)' }
    }
    if (targets.length === 0) {
      return { ok: false, reason: 'empty group has no leaf (fail-closed)' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'group translate probe failed (fail-closed)' }
  }
}

/**
 * Collect translatable leaves (`geometry` + `text` + `image`) in document
 * order. Returns `undefined` when the unit contains any hard-blocked content
 * (`use`, `foreignObject`, clip/mask companions, clip/mask styling,
 * `data-is-pg-text-item`, defs-homed leaves) or when a leaf fails
 * `classifyLeafElementForTranslate`. Pure read; never mutates.
 */
export function groupTranslateLeafTargetsInOrder(element: Element): Element[] | undefined {
  try {
    if (!element || groupTranslateLeafTag(element) !== 'g') return undefined
    if (groupTranslateHasBlockingStyle(element)) return undefined
    try {
      if (element.hasAttribute?.('data-is-pg-text-item')) return undefined
    } catch {
      return undefined
    }
    try {
      let node = element.parentElement
      while (node && groupTranslateLeafTag(node) !== 'svg') {
        if (groupTranslateHasBlockingStyle(node)) return undefined
        if (groupTranslateLeafTag(node) === 'defs') return undefined
        node = node.parentElement
      }
    } catch {
      return undefined
    }
    const out: Element[] = []
    const walk = (node: Element): boolean => {
      for (const child of Array.from(node.children)) {
        const childElement = child as Element
        if (childElement.nodeType !== 1) continue
        const childTag = groupTranslateLeafTag(childElement)
        if (childTag === 'g') {
          if (groupTranslateHasBlockingStyle(childElement)) return false
          try {
            if (childElement.hasAttribute?.('data-is-pg-text-item')) return false
          } catch {
            return false
          }
          if (!walk(childElement)) return false
          continue
        }
        if (GROUP_TRANSLATE_HARD_BLOCKED_TAGS.has(childTag)) return false
        if (childTag === 'clippath' || childTag === 'mask') return false
        if (groupTranslateHasBlockingStyle(childElement)) return false
        if (GROUP_TRANSLATE_GEOMETRY_TAGS.has(childTag) || childTag === 'text' || childTag === 'image') {
          // Single-sourced eligibility: href/size/tspan/clip/defs rules live
          // in the planner helper. `use` never reaches here (hard-blocked
          // above); geometry/text/image refusals (href-less image, clipped
          // text, geometry with children) fail the whole unit closed.
          const eligibility = classifyLeafElementForTranslate(childElement)
          if (!eligibility.ok) return false
          // The planner admits `use`, but this translate gate never does:
          // shadow/filter complexity has no live evidence, so even a
          // planner-ok `use` stays unsupported here.
          if ((eligibility as { kind?: string }).kind === 'use') return false
          out.push(childElement)
          continue
        }
        if (
          childTag === 'a' ||
          childTag === 'switch' ||
          childTag === 'svg' ||
          childTag === 'defs' ||
          childTag === 'metadata' ||
          childTag === 'title' ||
          childTag === 'desc'
        ) {
          if (childElement.children.length > 0 && !walk(childElement)) return false
          continue
        }
        if (childElement.children.length > 0) {
          if (!walk(childElement)) return false
          continue
        }
      }
      return true
    }
    if (!walk(element)) return undefined
    return out
  } catch {
    return undefined
  }
}

function groupTranslatePaperLeafItems(root: paper.Item): paper.Item[] {
  // Iterative with the shared budget: over-budget/unreadable throws the
  // private sentinel (callers map it to `unsupported`), never a partial list.
  const out: paper.Item[] = []
  const stack: paper.Item[] = [root]
  let visited = 0
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    if (++visited > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    const current = stack.pop()!
    let className: unknown
    try {
      className = (current as unknown as { className?: unknown }).className ?? ''
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (className === 'CompoundPath') {
      out.push(current)
      continue
    }
    let children: unknown
    try {
      children = (current as unknown as { children?: unknown }).children
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (Array.isArray(children) && (children as unknown[]).length > 0) {
      for (let index = (children as paper.Item[]).length - 1; index >= 0; index--) stack.push((children as paper.Item[])[index]!)
      continue
    }
    out.push(current)
  }
  return out
}

function groupTranslateImportHasCompound(root: paper.Item): boolean {
  const stack: paper.Item[] = [root]
  let visited = 0
  while (stack.length > 0) {
    if (stack.length > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    if (++visited > PAPER_TRAVERSAL_MAX_NODES) throw new PaperTreeTooLargeError()
    const current = stack.pop()!
    let className: unknown
    try {
      className = (current as unknown as { className?: unknown }).className
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (className === 'CompoundPath') return true
    let children: unknown
    try {
      children = (current as unknown as { children?: unknown }).children
    } catch {
      throw new PaperTreeTooLargeError('paper children unreadable (fail-closed)')
    }
    if (Array.isArray(children)) {
      for (const child of children as paper.Item[]) stack.push(child)
    }
  }
  return false
}

function importSingleTranslateLeaf(scope: paper.PaperScope, svgRoot: Element | undefined, leaf: Element): paper.Item | undefined {
  try {
    const baked = svgRoot ? bakedUnitClone(svgRoot, leaf) : undefined
    const source = baked ?? leaf
    const serialized = sanitizeSvgFragmentForPaperImport(new XMLSerializer().serializeToString(source))
    if (!serialized || serialized === SVG_PLACEHOLDER) return undefined
    const imported = (scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean }) => paper.Item }).importSVG(serialized, { insert: false })
    if (!imported) return undefined
    return expandPaperShapesToPaths(imported)
  } catch {
    return undefined
  }
}

/**
 * Resolve a document-space point to one translatable DOM leaf index with real
 * Paper.js `hitTest` (topmost wins). Geometry leaves hit as `Path`, text as
 * `PointText`, raster as `Raster`; `PlacedSymbol`/`Shape`/`CompoundPath` and
 * Paper-unimportable leaves report `unsupported` (fail-closed, never a bounds
 * guess). RTL text probes the mirrored hit point so the visible glyph side
 * wins. Misses and failed imports are explicit; the live DOM is never mutated.
 */
export async function paperGroupTranslateLeafHitAtPoint(
  element: Element,
  point: { x: number; y: number },
  tolerance = VECTOR_HIT_TOLERANCE,
): Promise<PaperGroupTranslateLeafHit> {
  try {
    if (!element || groupTranslateLeafTag(element) !== 'g') {
      return { kind: 'unsupported', reason: 'not a group unit (fail-closed)' }
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'miss' }
    const domLeaves = groupTranslateLeafTargetsInOrder(element)
    if (domLeaves === undefined) {
      return { kind: 'unsupported', reason: 'use/clip/content in group is not translatable (fail-closed)' }
    }
    if (domLeaves.length === 0) {
      return { kind: 'unsupported', reason: 'empty group has no leaf (fail-closed)' }
    }
    const scope = await ensureVectorPaperScope()
    const svgRoot = typeof element.closest === 'function' ? (element.closest('svg') as Element | null) ?? undefined : undefined
    const safeTolerance = Number.isFinite(tolerance) && (tolerance as number) >= 0 ? (tolerance as number) : VECTOR_HIT_TOLERANCE
    // Validate every leaf imports cleanly first: a Paper-unimportable leaf
    // (hidden, compound, multi-subpath, PlacedSymbol, Shape, placeholder)
    // fails the whole unit closed so a lower leaf can never shadow it.
    const importedRoots: Array<{ leafIndex: number; root: paper.Item } | { leafIndex: number; failed: true }> = []
    try {
      for (let leafIndex = 0; leafIndex < domLeaves.length; leafIndex++) {
        const leaf = domLeaves[leafIndex]!
        const root = importSingleTranslateLeaf(scope, svgRoot, leaf)
        if (!root) {
          return { kind: 'unsupported', reason: `paper import unsupported for ${groupTranslateLeafTag(leaf) || 'leaf'} (fail-closed)` }
        }
        importedRoots.push({ leafIndex, root })
      }
      for (const entry of importedRoots) {
        if ('failed' in entry) continue
        const root = (entry as { root: paper.Item }).root
        if (groupTranslateImportHasCompound(root)) {
          return { kind: 'unsupported', reason: 'compound path in group (fail-closed)' }
        }
        const items = groupTranslatePaperLeafItems(root)
        for (const item of items) {
          const className = (item as unknown as { className?: string }).className ?? ''
          if (className === 'PlacedSymbol' || className === 'CompoundPath' || className === 'Shape') {
            return { kind: 'unsupported', reason: `non-geometry hit (${className}) in group (fail-closed)` }
          }
        }
        // A single baked leaf must resolve to exactly one Paper leaf item
        // (Path / PointText / Raster). Zero or 2+ means the import is
        // ambiguous (multi-subpath, split text runs) — fail closed.
        const leafItems = items.filter((item) => {
          const className = (item as unknown as { className?: string }).className ?? ''
          return className === 'Path' || className === 'PointText' || className === 'TextItem' || className === 'Raster'
        })
        if (leafItems.length !== 1) {
          return { kind: 'unsupported', reason: 'ambiguous group identity (fail-closed)' }
        }
        const only = leafItems[0] as paper.Path
        if ((only as unknown as { className?: string }).className === 'Path' && groupLeafPathDataHasMultipleSubpaths(only)) {
          return { kind: 'unsupported', reason: 'multi-subpath leaf in group (fail-closed)' }
        }
      }
      // Topmost wins: reverse document order, per-leaf baked frame, RTL-aware.
      // `image` leaves hit via exact document bounds (rectangular raster):
      // Paper `Raster` hitTest needs async image decode and misses on detached
      // imports, while bounds are exact for rectangles and already include
      // ancestor transforms via `vectorObjectBounds`. Geometry/text stay on
      // the real Paper hitTest (no bbox guess for overlaps).
      for (let leafIndex = domLeaves.length - 1; leafIndex >= 0; leafIndex--) {
        const leaf = domLeaves[leafIndex]!
        const leafTag = groupTranslateLeafTag(leaf)
        if (leafTag === 'image') {
          try {
            const bounds = vectorObjectBounds(leaf)
            if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
              continue
            }
            const pad = Number.isFinite(safeTolerance) && safeTolerance >= 0 ? safeTolerance : 0
            if (point.x >= bounds.x - pad && point.x <= bounds.x + bounds.width + pad && point.y >= bounds.y - pad && point.y <= bounds.y + bounds.height + pad) {
              return { kind: 'hit', leafIndex, leafTag, hitType: 'fill' }
            }
          } catch {
            continue
          }
          continue
        }
        const entry = importedRoots[leafIndex] as { root: paper.Item }
        const root = entry.root
        const probe = isRtlVectorTextElement(leaf) ? rtlMirroredHitPoint(leaf, point) : point
        let hit: { type?: string; item?: paper.Item } | null = null
        try {
          hit = (root as unknown as { hitTest?: (point: unknown, options: unknown) => unknown }).hitTest?.(new scope.Point(probe.x, probe.y), {
            fill: true,
            stroke: true,
            curves: true,
            segments: true,
            tolerance: safeTolerance,
            guide: false,
          }) as { type?: string; item?: paper.Item } | null
        } catch {
          continue
        }
        if (!hit || !hit.item) continue
        const hitClass = (hit.item as unknown as { className?: string }).className ?? ''
        if (hitClass === 'PlacedSymbol' || hitClass === 'CompoundPath' || hitClass === 'Shape') {
          return { kind: 'unsupported', reason: `non-geometry hit (${hitClass}) in group (fail-closed)` }
        }
        if (hitClass !== 'Path' && hitClass !== 'PointText' && hitClass !== 'TextItem' && hitClass !== 'Raster') {
          continue
        }
        // A Raster hit here is a geometry/text import that Paper mapped to a
        // raster (should not happen for rect/text); treat image-tag leaves via
        // bounds above so async decode can never shadow the topmost order.
        if (hitClass === 'Raster' && leafTag !== 'image') {
          continue
        }
        return { kind: 'hit', leafIndex, leafTag, hitType: hit.type ?? 'fill' }
      }
      return { kind: 'miss' }
    } finally {
      for (const entry of importedRoots) {
        if ('failed' in entry) continue
        try {
          ;(entry as { root: paper.Item }).root.remove()
        } catch {
          // Detached import; nothing to clean up.
        }
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? '')
    const suffix = detail ? `: ${detail.slice(0, 160)}` : ''
    return { kind: 'unsupported', reason: `group translate probe failed${suffix} (fail-closed)` }
  }
}
