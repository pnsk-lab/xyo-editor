// Paper workspace clamp for the CSS viewport (clean-room, pure, DOM-free).
//
// Wires the independent `viewport-scroll-clamp.ts` oracle into the live CSS
// camera (`BitmapEditor.svelte` style binding
// `translate(calc(-50% + vx), calc(-50% + vy)) scale(s)` on a W x H surface
// centered on the container center). Svelte owns all DOM/VM/history; this
// module only derives clamped `(vx, vy, scale)` values.
//
// Reference model (own words, numbers re-typed, no third-party copy):
// ART=(0,0,960,720), MAX=(-240,-180,1440,1080) as rect (-240,-180,1200,900),
// BUFFER=50 total per extent, OUTERMOST=0.333, reset=0.5, wheel -deltaY/1000,
// pan scrollBy then clamp (workspace updated AFTER the scroll, unclipped),
// zoomOnFixedPoint newZoom+translate then setWorkspaceBounds(clipEmpty=true)
// then clamp (clamp WINS over the pin), resetZoom zoom=0.5 then
// setWorkspaceBounds(true)+clamp, onViewResize setWorkspaceBounds(true)+clamp,
// zoomToFit reset+expand(50)+x1.5+ratio clamp then center/zoom then clamp.
// Clamp order is left/top/bottom/right, one edge at a time. When the
// viewport is larger than the workspace the workspace widens symmetrically
// around itself instead of pinning to one edge.
//
// Paper <-> CSS correspondence (own derivation, explicit assumptions):
// - Let the surface be W x H surface px, the container center C (CSS px),
//   the viewport V=(vx,vy,s), density d = surface px per Paper unit at s=1.
//   Surface point S maps to screen P = C+(vx,vy)+(S-W/2)*s.
// - Paper zoom z and CSS scale s share on-screen density: z = d*s, s = z/d.
// - The surface point at the screen center is Sc = W/2-(vx,vy)/s. It maps to
//   the Paper center Pc:
//     vector (2400x1800 for 960x720, d=2.5 [A3]): Pc = Sc/d.
//       Origin aligns (surface 0,0 = Paper 0,0); center 1200,900 = 480,360.
//       SVG document units map as Paper = svg*2 (surface = svg*5, /2.5).
//       Offcenter imports keep document coords (no CENTER translation is
//       applied in CSS; the VM rotationCenter is metadata, not a display
//       shift). Documented as [A-vector-origin].
//     bitmap res2 (canvas W x H for 960x720, d=1.0 [確実]): Paper =
//       (S-cc)/d + (480,360), where cc is the true artboard center in canvas
//       px (tracked `canvasCenterX/Y`; union canvases shift cc, e.g. 1200px
//       union true center 480 vs width/2 600). Non-union cc=W/2,H/2 gives
//       Paper = S verbatim. Negative rotationCenter / offboard / huge flow
//       through the same formula (finite negatives allowed, capped at
//       expanded MAX by the workspace intersect).
// - Visible Paper size is containerCss/z (DPR-independent CSS px; DPR never
//   enters the math, 明記).
// - res1 (density 0.5 = 480 canvas / 960 Paper, decided): Paper =
//   (S-cc)/0.5 + (480,360), where cc is the true artboard center in canvas
//   px (tracked `canvasCenterX/Y`; union canvases shift cc, e.g. 640px
//   res1 union true center 240 vs width/2 320). Non-union cc=W/2,H/2 gives
//   Paper = S*2 verbatim (canvas 0..480 -> Paper 0..960).
// - unknown (no explicit stored resolution) fails closed: density is
//   undefined, this module returns the input unchanged (legacy band +
//   unbounded pan preserved, 明記). Callers must NOT guess from canvas width.
//   Survey pin (read-only, no behavior change here): the reference VM loader
//   upscales stored res1 bitmaps 2x at load (doubling pixels/rotationCenter,
//   rewriting resolution to 2) before paint, so the stored res1 asset and the
//   live 960-unit Paper board must not be conflated (density comes only from
//   the explicit stored-resolution prop).
//
// What this module does NOT do (explicit non-goals, 明記):
// - No fit target computation (owned by `costume-viewport.ts`
//   `resolveInitialFitViewport`); only the post-fit clamp lives here.
// - No tool action-bounds clamp (bitmap stays on the board via existing
//   point clamps; vector tools already roam). Only the viewport is clamped.
// - No history/VM/data writes: pure viewport math only. Undo/redo never
//   calls here.
// - No scale changes: the Paper clamp only scrolls (center), never zooms.
//   Scale stays as the caller band-clamped it; this module only adjusts
//   (vx,vy). A clamp that would change zoom fails closed to no scale change.

import {
  SCROLL_ART_BOARD,
  SCROLL_MAX_WORKSPACE,
  SCROLL_WORKSPACE_BUFFER,
  clampViewToWorkspace,
  expandRectTotal,
  intersectRects,
  uniteRects,
  type ScrollRect,
} from './viewport-scroll-clamp'

export type PaperClampViewport = { x: number; y: number; scale: number }
export type PaperClampSize = { width: number; height: number }
export type PaperClampPoint = { x: number; y: number }
export type PaperClampCenter = { x: number; y: number }

export const PAPER_CLAMP_ART: ScrollRect = { left: 0, top: 0, right: 960, bottom: 720 }
export const PAPER_CLAMP_MAX: ScrollRect = { ...SCROLL_MAX_WORKSPACE }
export const PAPER_CLAMP_BUFFER = SCROLL_WORKSPACE_BUFFER
export const PAPER_CLAMP_RESET_ZOOM = 0.5

/** Vector density [A3]: 2400 surface / 960 Paper. */
export const PAPER_CLAMP_VECTOR_DENSITY = 2400 / 960
/** Bitmap res2 density [確実]: 960 canvas / 960 Paper. */
export const PAPER_CLAMP_RES2_DENSITY = 960 / 960
/** Bitmap res1 density (decided): 480 canvas / 960 Paper = 0.5. */
export const PAPER_CLAMP_RES1_DENSITY = 480 / 960

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizeViewport(v: PaperClampViewport | undefined): PaperClampViewport {
  return {
    x: isFiniteNumber(v?.x) ? (v as PaperClampViewport).x : 0,
    y: isFiniteNumber(v?.y) ? (v as PaperClampViewport).y : 0,
    scale: isFiniteNumber(v?.scale) && (v as PaperClampViewport).scale > 0 ? (v as PaperClampViewport).scale : 1,
  }
}

function sanitizeSize(s: PaperClampSize | undefined): PaperClampSize | undefined {
  if (!s) return undefined
  if (!isFiniteNumber(s.width) || !isFiniteNumber(s.height)) return undefined
  if (!(s.width > 0) || !(s.height > 0)) return undefined
  return { width: s.width, height: s.height }
}

function sanitizeDensity(d: number | undefined): number | undefined {
  if (!isFiniteNumber(d) || (d as number) <= 0) return undefined
  return d as number
}

function sanitizeCenter(c: PaperClampCenter | undefined, fx: number, fy: number): PaperClampCenter {
  return {
    x: isFiniteNumber(c?.x) ? (c as PaperClampCenter).x : fx,
    y: isFiniteNumber(c?.y) ? (c as PaperClampCenter).y : fy,
  }
}

function sanitizePaperRect(r: ScrollRect | undefined): ScrollRect | undefined {
  if (!r) return undefined
  if (!isFiniteNumber(r.left) || !isFiniteNumber(r.top) || !isFiniteNumber(r.right) || !isFiniteNumber(r.bottom)) {
    return undefined
  }
  if (!(r.right >= r.left) || !(r.bottom >= r.top)) return undefined
  if (!isFiniteNumber(r.right - r.left) || !isFiniteNumber(r.bottom - r.top)) return undefined
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** Expand allowing zero-area (singular line/point) inputs; non-finite fails closed to undefined. */
function expandPaperRectTotal(rect: ScrollRect, amount: number): ScrollRect | undefined {
  const safe = sanitizePaperRect(rect)
  if (!safe) return undefined
  if (!isFiniteNumber(amount) || amount <= 0) return { ...safe }
  const half = amount / 2
  const out = { left: safe.left - half, top: safe.top - half, right: safe.right + half, bottom: safe.bottom + half }
  if (!isFiniteNumber(out.left) || !isFiniteNumber(out.top) || !isFiniteNumber(out.right) || !isFiniteNumber(out.bottom)) {
    return undefined
  }
  return out
}

export type PaperViewBoundsResult = {
  /** Visible Paper rect for this CSS viewport (undefined when not clampable/not-ready). */
  viewBounds: ScrollRect | undefined
  /** Paper center and zoom behind it (undefined alongside viewBounds). */
  center: PaperClampPoint | undefined
  zoom: number | undefined
  reason: string
}

/**
 * CSS viewport -> Paper view bounds. Fails closed to undefined (caller keeps
 * the legacy unclamped viewport) when the density is undecided (res1/unknown),
 * the surface/container is not laid out, or any input is non-finite.
 * `canvasCenter` is the true artboard center in surface px (bitmap res2
 * union tracking); vector callers omit it (surface center is the board
 * center). Fallback when omitted/non-finite is W/2,H/2 (verbatim mapping).
 */
export function paperViewBoundsForCssViewport(
  viewport: PaperClampViewport,
  surface: PaperClampSize,
  containerSize: PaperClampSize,
  density: number | undefined,
  canvasCenter?: PaperClampCenter,
): PaperViewBoundsResult {
  const d = sanitizeDensity(density)
  if (d === undefined) return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'unknown-density: unknown Paper mapping, keep legacy' }
  const surf = sanitizeSize(surface)
  const cont = sanitizeSize(containerSize)
  if (!surf || !cont) return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad surface or container size' }
  const v = sanitizeViewport(viewport)
  if (!(v.scale > 0)) return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad scale' }
  const zoom = v.scale * d
  if (!isFiniteNumber(zoom) || !(zoom > 0)) return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad zoom' }
  // Surface point at the screen center.
  const scx = surf.width / 2 - v.x / v.scale
  const scy = surf.height / 2 - v.y / v.scale
  if (!isFiniteNumber(scx) || !isFiniteNumber(scy)) {
    return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad pan' }
  }
  const cc = sanitizeCenter(canvasCenter, surf.width / 2, surf.height / 2)
  // Vector origin aligns (cc == surface center => Pc = Sc/d); bitmap res2
  // offsets through the true center: Pc = (Sc-cc)/d + (480,360).
  // Both collapse to one formula with the board-center anchor: when cc is the
  // surface center and d=2.5, (Sc-cc)/d+480 == Sc/d (since cc/d == 480).
  const pcx = (scx - cc.x) / d + SCROLL_ART_BOARD.width / 2
  const pcy = (scy - cc.y) / d + SCROLL_ART_BOARD.height / 2
  if (!isFiniteNumber(pcx) || !isFiniteNumber(pcy)) {
    return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad center' }
  }
  const vw = cont.width / zoom
  const vh = cont.height / zoom
  if (!isFiniteNumber(vw) || !isFiniteNumber(vh) || !(vw > 0) || !(vh > 0)) {
    return { viewBounds: undefined, center: undefined, zoom: undefined, reason: 'not-ready: bad visible size' }
  }
  // Overflow guard: container up to ~1e6 CSS px at tiny zoom could overflow
  // the Paper extent; cap the visible size so downstream math stays finite.
  const cappedW = Math.min(vw, 1_000_000)
  const cappedH = Math.min(vh, 1_000_000)
  return {
    viewBounds: { left: pcx - cappedW / 2, top: pcy - cappedH / 2, right: pcx + cappedW / 2, bottom: pcy + cappedH / 2 },
    center: { x: pcx, y: pcy },
    zoom,
    reason: 'ok',
  }
}

/**
 * Paper center/zoom -> CSS viewport (inverse of the above). Scale is
 * zoom/density (callers already band-clamp; this function does NOT clamp so
 * the clamp step never changes zoom). Fails closed to undefined.
 */
export function cssViewportForPaperCenter(
  paperCenter: PaperClampPoint,
  paperZoom: number,
  surface: PaperClampSize,
  density: number | undefined,
  canvasCenter?: PaperClampCenter,
): PaperClampViewport | undefined {
  const d = sanitizeDensity(density)
  if (d === undefined) return undefined
  const surf = sanitizeSize(surface)
  if (!surf) return undefined
  if (!isFiniteNumber(paperZoom) || !(paperZoom > 0)) return undefined
  if (!isFiniteNumber(paperCenter?.x) || !isFiniteNumber(paperCenter?.y)) return undefined
  const cc = sanitizeCenter(canvasCenter, surf.width / 2, surf.height / 2)
  const scx = (paperCenter.x - SCROLL_ART_BOARD.width / 2) * d + cc.x
  const scy = (paperCenter.y - SCROLL_ART_BOARD.height / 2) * d + cc.y
  if (!isFiniteNumber(scx) || !isFiniteNumber(scy)) return undefined
  const scale = paperZoom / d
  if (!isFiniteNumber(scale) || !(scale > 0)) return undefined
  const x = (surf.width / 2 - scx) * scale
  const y = (surf.height / 2 - scy) * scale
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined
  return { x, y, scale }
}

export type VectorUnitBounds = { x: number; y: number; width: number; height: number }

/**
 * Vector unit bounds (SVG document units, `vectorObjects` boundsX/Y/Width/
 * Height) -> Paper rects. Mapping is Paper = svg*2 (surface = svg*5 via
 * VECTOR_WORKSPACE_SCALE, /2.5 density). Zero-area (bare line/point) is KEPT
 * as a degenerate rect so the workspace unite keeps its position (the oracle
 * `sanitizeRect` would drop it to the board; this builder preserves it per
 * the reference unite semantics). Non-finite entries are skipped.
 */
export function paperItemRectsForVectorUnits(
  objects: ReadonlyArray<{ boundsX?: number; x?: number; boundsY?: number; y?: number; boundsWidth?: number; width?: number; boundsHeight?: number; height?: number }> | undefined,
): ScrollRect[] {
  if (!Array.isArray(objects)) return []
  const out: ScrollRect[] = []
  for (const object of objects) {
    if (!object) continue
    const left = object.boundsX ?? object.x ?? 0
    const top = object.boundsY ?? object.y ?? 0
    const width = object.boundsWidth ?? object.width ?? 0
    const height = object.boundsHeight ?? object.height ?? 0
    if (!isFiniteNumber(left) || !isFiniteNumber(top) || !isFiniteNumber(width) || !isFiniteNumber(height)) continue
    // Width/height from Paper bounds may be 0 (line) or tiny; negative spans
    // are invalid data (fail-closed: skip, never teleport the workspace).
    if (!(width >= 0) || !(height >= 0)) continue
    if (!isFiniteNumber(left + width) || !isFiniteNumber(top + height)) continue
    out.push({ left: left * 2, top: top * 2, right: (left + width) * 2, bottom: (top + height) * 2 })
  }
  return out
}

export type BitmapOpaqueRect = { x: number; y: number; width: number; height: number }

/**
 * Settled bitmap opaque rect (canvas px, `bitmapFitState.bounds`) -> Paper
 * rect. Requires the fit surface size to match the live surface (stale
 * serial/revision or an untracked resize fails closed to undefined so a
 * stale rect can never teleport the clamp). Empty (null) yields [] (no
 * items). Singular (zero-area, should not happen from the scan but guarded)
 * is kept as a degenerate rect. `canvasCenter` is the true center in live
 * canvas px; omitted/non-finite falls back to the live middle.
 */
export function paperItemRectsForBitmapOpaque(
  opaque: BitmapOpaqueRect | null | undefined,
  liveSurface: PaperClampSize,
  fitSurfaceWidth: number | undefined,
  fitSurfaceHeight: number | undefined,
  density: number | undefined,
  canvasCenter?: PaperClampCenter,
): ScrollRect[] | undefined {
  if (opaque === null || opaque === undefined) return []
  const d = sanitizeDensity(density)
  if (d === undefined) return undefined
  const surf = sanitizeSize(liveSurface)
  if (!surf) return undefined
  // Fit/live surface mismatch (resize race, stale owner): fail closed to no
  // clamp items rather than mapping stale canvas px into the live surface.
  if (!isFiniteNumber(fitSurfaceWidth) || !isFiniteNumber(fitSurfaceHeight)) return undefined
  if (Math.round(fitSurfaceWidth as number) !== Math.round(surf.width) || Math.round(fitSurfaceHeight as number) !== Math.round(surf.height)) {
    return undefined
  }
  if (!isFiniteNumber(opaque.x) || !isFiniteNumber(opaque.y) || !isFiniteNumber(opaque.width) || !isFiniteNumber(opaque.height)) {
    return undefined
  }
  if (!(opaque.width >= 0) || !(opaque.height >= 0)) return undefined
  const cc = sanitizeCenter(canvasCenter, surf.width / 2, surf.height / 2)
  const left = (opaque.x - cc.x) / d + SCROLL_ART_BOARD.width / 2
  const top = (opaque.y - cc.y) / d + SCROLL_ART_BOARD.height / 2
  const right = (opaque.x + opaque.width - cc.x) / d + SCROLL_ART_BOARD.width / 2
  const bottom = (opaque.y + opaque.height - cc.y) / d + SCROLL_ART_BOARD.height / 2
  const rect = sanitizePaperRect({ left, top, right, bottom })
  if (!rect) return undefined
  return [rect]
}

/**
 * Paper workspace for the clamp step (own words): start from the art board;
 * unless clipEmpty, also cover the current view; cover every drawn item plus
 * a buffer ring; never exceed the buffer-expanded max workspace; when the
 * view is larger than the workspace, widen it symmetrically around itself so
 * a zoomed-out view stays centered instead of clamping to one edge.
 * Zero-area items are united by position (reference unite includes a bare
 * line). Non-finite inputs fail closed to the art board.
 */
export function paperWorkspaceForClamp(
  viewBounds: ScrollRect | undefined,
  itemBounds: ReadonlyArray<ScrollRect> | undefined,
  clipEmpty: boolean,
): ScrollRect {
  const art: ScrollRect = { left: 0, top: 0, right: SCROLL_ART_BOARD.width, bottom: SCROLL_ART_BOARD.height }
  const maxExpanded = expandRectTotal(
    { left: PAPER_CLAMP_MAX.left, top: PAPER_CLAMP_MAX.top, right: PAPER_CLAMP_MAX.right, bottom: PAPER_CLAMP_MAX.bottom },
    PAPER_CLAMP_BUFFER,
  )
  let bounds: ScrollRect = { ...art }
  if (!clipEmpty && viewBounds) {
    const vb = sanitizePaperRect(viewBounds)
    if (vb) bounds = uniteRects(bounds, vb)
  }
  const items = Array.isArray(itemBounds) ? itemBounds : []
  for (const item of items) {
    const safe = sanitizePaperRect(item)
    if (!safe) continue
    const expanded = expandPaperRectTotal(safe, PAPER_CLAMP_BUFFER)
    if (!expanded) continue
    bounds = uniteRects(bounds, expanded)
  }
  bounds = intersectRects(bounds, maxExpanded)
  if (viewBounds) {
    const vb = sanitizePaperRect(viewBounds)
    if (vb) {
      const vw = vb.right - vb.left
      const vh = vb.bottom - vb.top
      if (isFiniteNumber(vw) && vw > 0 && bounds.right - bounds.left < vw) {
        const grow = (vw - (bounds.right - bounds.left)) / 2
        bounds = { left: bounds.left - grow, top: bounds.top, right: bounds.right + grow, bottom: bounds.bottom }
      }
      if (isFiniteNumber(vh) && vh > 0 && bounds.bottom - bounds.top < vh) {
        const grow = (vh - (bounds.bottom - bounds.top)) / 2
        bounds = { left: bounds.left, top: bounds.top - grow, right: bounds.right, bottom: bounds.bottom + grow }
      }
    }
  }
  return bounds
}

export type ClampCssViewportInput = {
  viewport: PaperClampViewport
  surface: PaperClampSize
  containerSize: PaperClampSize
  /** Explicit density (vector 2.5 / res2 1.0; undefined = res1/unknown legacy). */
  density: number | undefined
  /** True artboard center in surface px (bitmap res2 union tracking). */
  canvasCenter?: PaperClampCenter
  /** Drawn item bounds in Paper units (vector units or bitmap opaque). */
  itemPaperRects?: ReadonlyArray<ScrollRect>
  /**
   * Reference order flag:
   * - pan/resize-keep (general pan): false (workspace covers the new view;
   *   only the expanded-MAX edge clamps). Matches `pan` (scrollBy then
   *   clamp, workspace updated after).
   * - fixed-point zoom / reset / resize / fit: true (workspace trims empty
   *   space first, then the clamp WINS over the pin). Matches
   *   `zoomOnFixedPoint` / `resetZoom` / `onViewResize` / `zoomToFit`.
   */
  clipEmpty: boolean
}

export type ClampCssViewportResult = {
  viewport: PaperClampViewport
  /** True when the Paper clamp moved the center. */
  clamped: boolean
  /** Paper scrollBy applied (world units, sequential left/top/bottom/right). */
  paperDx: number
  paperDy: number
  /** Edges that triggered (survey order left/top/bottom/right). */
  edges: Array<'left' | 'top' | 'bottom' | 'right'>
  /** Workspace behind the clamp (for tests/reports). */
  workspace: ScrollRect | undefined
  /** Paper view before/after (for tests/reports). */
  viewBefore: ScrollRect | undefined
  viewAfter: ScrollRect | undefined
  reason: string
}

/**
 * Clamp a CSS viewport to the Paper workspace. Total, never throws:
 * unclampable (res1/unknown) or not-ready (unlaid-out, non-finite) inputs
 * return the input viewport unchanged with clamped=false (legacy preserved).
 * Otherwise the Paper center moves inside the workspace (sequential edge
 * order) and maps back to (vx,vy); scale is NEVER changed here (the Paper
 * clamp only scrolls).
 */
export function clampCssViewportToPaper(input: ClampCssViewportInput): ClampCssViewportResult {
  const fallbackViewport = sanitizeViewport(input.viewport)
  const fail = (reason: string): ClampCssViewportResult => ({
    viewport: fallbackViewport,
    clamped: false,
    paperDx: 0,
    paperDy: 0,
    edges: [],
    workspace: undefined,
    viewBefore: undefined,
    viewAfter: undefined,
    reason,
  })
  try {
    const d = sanitizeDensity(input.density)
    if (d === undefined) return { ...fail('unknown-density: unknown Paper mapping, keep legacy'), viewport: { ...fallbackViewport } }
    const surf = sanitizeSize(input.surface)
    const cont = sanitizeSize(input.containerSize)
    if (!surf || !cont) return fail('not-ready: bad surface or container size')
    const mapped = paperViewBoundsForCssViewport(fallbackViewport, surf, cont, d, input.canvasCenter)
    if (!mapped.viewBounds || mapped.center === undefined || mapped.zoom === undefined) {
      return fail(mapped.reason)
    }
    const workspace = paperWorkspaceForClamp(mapped.viewBounds, input.itemPaperRects, input.clipEmpty === true)
    const clamped = clampViewToWorkspace(mapped.viewBounds, workspace)
    if (!clamped.clamped) {
      return {
        viewport: { ...fallbackViewport },
        clamped: false,
        paperDx: 0,
        paperDy: 0,
        edges: [],
        workspace,
        viewBefore: mapped.viewBounds,
        viewAfter: clamped.viewBounds,
        reason: 'inside: no clamp needed',
      }
    }
    const afterCenter = {
      x: (mapped.center as PaperClampPoint).x + clamped.dx,
      y: (mapped.center as PaperClampPoint).y + clamped.dy,
    }
    const back = cssViewportForPaperCenter(afterCenter, mapped.zoom as number, surf, d, input.canvasCenter)
    if (!back) return fail('not-ready: clamp mapping failed')
    // The clamp never changes zoom: force the input scale back (round-trip
    // guard) so a float wobble can never drift the zoom level.
    return {
      viewport: { x: back.x, y: back.y, scale: fallbackViewport.scale },
      clamped: true,
      paperDx: clamped.dx,
      paperDy: clamped.dy,
      edges: clamped.edges,
      workspace,
      viewBefore: mapped.viewBounds,
      viewAfter: clamped.viewBounds,
      reason: input.clipEmpty === true ? 'clamped: fixed-point then workspace clamp wins' : 'clamped: pan then workspace clamp',
    }
  } catch {
    return fail('not-ready: exception fail-closed')
  }
}
