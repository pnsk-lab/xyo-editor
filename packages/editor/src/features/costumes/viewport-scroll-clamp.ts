// Viewport scroll-clamp oracle (clean-room, pure, DOM-free, no Paper.js).
//
// Purpose: pin the *observable* difference between the reference Paper
// workspace clamp and the current CSS camera without touching
// `Editor.svelte`, `BitmapEditor.svelte`, or `costume-viewport.ts`
// (all owned by other work) and without copying any third-party source.
//
// Reference numbers below are re-typed as plain facts observed read-only
// under `.tmp/scratch-editor/packages/scratch-paint` (line refs are survey
// pins, not quotations):
// - helper/view.js: ART 960x720, MAX workspace (-240,-180,1440,1080),
//   BUFFER 50, OUTERMOST 0.333, reset zoom 0.5, setWorkspaceBounds(clipEmpty)
//   + clampViewBounds order left/top/bottom/right, pan scrollBy+clamp,
//   zoomOnFixedPoint newZoom+translate then setWorkspaceBounds(true)+clamp,
//   resetZoom zoom=0.5 then setWorkspaceBounds(true)+clamp,
//   getActionBounds bitmap=ART / vector=(view unite ART) intersect MAX,
//   zoomToFit path (owned by another agent, NOT wired here).
// - containers/scrollable-canvas.jsx: ctrl/meta wheel -deltaY/1000 about the
//   cursor project point, shift+vertical => horizontal pan dx=deltaY/zoom,
//   plain pan dx=deltaX/zoom dy=deltaY/zoom, line mode x15, scrollbar drag
//   matrix tx += dx*zoom*2 then clamp, touch via getEventXY anchoring.
// - containers/paper-canvas.jsx + helper/layer.js: 960x720 raster at CENTER,
//   vector 2x import (480 units => 960 Paper units), overflow model is a
//   Paper view (no CSS clip); current UI is overflow:hidden CSS clip.
//
// Current UI facts (read-only observation of BitmapEditor.svelte):
// - surface is W x H px (vector fixed 2400x1800, bitmap = canvas backing,
//   res2 960x720 / res1 480x360 / union-grown huge up to 4096 side / 16M area)
//   centered on the container center C, shifted by (vx,vy) screen px, scaled
//   by s around that anchor:
//     rect = { left: Cx+vx-W*s/2, top: Cy+vy-H*s/2, w: W*s, h: H*s }.
// - pan is screen-px (vx -= dx, no /zoom division); scale clamps per-mode
//   (vector 0.1332..5, res2 0.333..5, unknown/res1 0.25..5, ceiling 5 is OUR
//   bound); vx/vy are UNBOUNDED (no workspace clamp); container is
//   overflow:hidden so the apparent span is min(rect, container).
// - fit path is owned by another agent (未完了 fit): this module only
//   measures/resolves clamp gaps, never computes a fit target.
//
// LEGEND: [確定] = survey pin / [仮定] = mapping introduced here (bounds the
// numbers only) / 未完了 = explicitly undecided (res1 density, fit target).
//
// This module decides nothing about wiring. All functions are total:
// non-finite inputs fail closed to a documented fallback, never throw.

export type ScrollPoint = { x: number; y: number }

export type ScrollSize = { width: number; height: number }

export type ScrollRect = { left: number; top: number; right: number; bottom: number }

export type CssCamera = { x: number; y: number; scale: number }

/** Reference art board in Paper document units [確定]. */
export const SCROLL_ART_BOARD: ScrollSize = { width: 960, height: 720 }

/** Reference art center [確定]. */
export const SCROLL_ART_CENTER: ScrollPoint = { x: 480, y: 360 }

/**
 * Reference max workspace as a rect [確定]:
 * left -240 (-960/4), top -180 (-720/4), right 1200, bottom 900
 * (1440x1080).
 */
export const SCROLL_MAX_WORKSPACE: ScrollRect = { left: -240, top: -180, right: 1200, bottom: 900 }

/** Workspace buffer around drawn items [確定]. */
export const SCROLL_WORKSPACE_BUFFER = 50

/** Reference zoom floor [確定]. */
export const SCROLL_OUTERMOST_ZOOM = 0.333

/** Reference reset zoom [確定]. */
export const SCROLL_RESET_ZOOM = 0.5

/** Reference wheel divisor [確定]. */
export const SCROLL_WHEEL_DIVISOR = 1000

/** Line-mode wheel multiplier [確定]. */
export const SCROLL_LINE_MULTIPLIER = 15

/** Current UI per-mode scale bands (read-only pins of costume-viewport). */
export const SCROLL_CSS_VECTOR_MIN = 0.333 / 2.5
export const SCROLL_CSS_RES2_MIN = 0.333
export const SCROLL_CSS_RES1_MIN = 0.333 / 0.5
export const SCROLL_CSS_RES1_RESET = 0.5 / 0.5
export const SCROLL_CSS_UNKNOWN_MIN = 0.25
export const SCROLL_CSS_MAX = 5

/** Current bitmap union-workspace memory caps (read-only pins). */
export const SCROLL_BITMAP_MAX_SIDE = 4096
export const SCROLL_BITMAP_MAX_AREA = 16_777_216

/** Huge-artboard probe surface used by the DOM table (6400x4800) [仮定]. */
export const SCROLL_HUGE_PROBE_SURFACE: ScrollSize = { width: 6400, height: 4800 }

/**
 * Bitmap res1 density (decided): the 480-wide canvas stands for the 960-unit
 * Paper board (density 0.5), because the reference VM loader doubles stored
 * res1 PNG pixels/center to res2 before paint while this repo keeps the
 * stored res1 bytes non-destructively. Both canvas-width readings now agree
 * on the decided board: R-board 480/960 = 0.5 wins; the R-own 480/480 = 1.0
 * reading described the doubled-then-divided camera path, not the stored
 * canvas. Live res1 paths pass 0.5 explicitly; unknown widths stay legacy.
 */
export const SCROLL_RES1_DENSITY = 480 / 960

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizePoint(p: ScrollPoint | undefined, fx = 0, fy = 0): ScrollPoint {
  return {
    x: isFiniteNumber(p?.x) ? (p as ScrollPoint).x : fx,
    y: isFiniteNumber(p?.y) ? (p as ScrollPoint).y : fy,
  }
}

function sanitizeSize(s: ScrollSize | undefined, fallback: ScrollSize): ScrollSize {
  const w = isFiniteNumber(s?.width) && (s as ScrollSize).width > 0 ? (s as ScrollSize).width : fallback.width
  const h = isFiniteNumber(s?.height) && (s as ScrollSize).height > 0 ? (s as ScrollSize).height : fallback.height
  return { width: w, height: h }
}

function sanitizeRect(r: ScrollRect | undefined, fallback: ScrollRect): ScrollRect {
  const left = isFiniteNumber(r?.left) ? (r as ScrollRect).left : fallback.left
  const top = isFiniteNumber(r?.top) ? (r as ScrollRect).top : fallback.top
  const right = isFiniteNumber(r?.right) ? (r as ScrollRect).right : fallback.right
  const bottom = isFiniteNumber(r?.bottom) ? (r as ScrollRect).bottom : fallback.bottom
  if (!(right > left && bottom > top)) return { ...fallback }
  return { left, top, right, bottom }
}

function rectWidth(r: ScrollRect): number {
  return r.right - r.left
}

function rectHeight(r: ScrollRect): number {
  return r.bottom - r.top
}

/** Expand a rect by a TOTAL amount (+amount to each extent, +amount/2 per side). */
export function expandRectTotal(rect: ScrollRect, amount: number): ScrollRect {
  const safe = sanitizeRect(rect, { left: 0, top: 0, right: 960, bottom: 720 })
  if (!isFiniteNumber(amount) || amount <= 0) return { ...safe }
  const half = amount / 2
  return {
    left: safe.left - half,
    top: safe.top - half,
    right: safe.right + half,
    bottom: safe.bottom + half,
  }
}

/** Unite two rects (bounding box of both). */
export function uniteRects(a: ScrollRect, b: ScrollRect): ScrollRect {
  const ra = sanitizeRect(a, { left: 0, top: 0, right: 960, bottom: 720 })
  const rb = sanitizeRect(b, { left: 0, top: 0, right: 960, bottom: 720 })
  return {
    left: Math.min(ra.left, rb.left),
    top: Math.min(ra.top, rb.top),
    right: Math.max(ra.right, rb.right),
    bottom: Math.max(ra.bottom, rb.bottom),
  }
}

/** Intersect two rects; empty intersection fails closed to the art board. */
export function intersectRects(a: ScrollRect, b: ScrollRect): ScrollRect {
  const ra = sanitizeRect(a, { left: 0, top: 0, right: 960, bottom: 720 })
  const rb = sanitizeRect(b, { left: 0, top: 0, right: 960, bottom: 720 })
  const out = {
    left: Math.max(ra.left, rb.left),
    top: Math.max(ra.top, rb.top),
    right: Math.min(ra.right, rb.right),
    bottom: Math.min(ra.bottom, rb.bottom),
  }
  if (!(out.right > out.left && out.bottom > out.top)) return { left: 0, top: 0, right: 960, bottom: 720 }
  return out
}

export type WorkspaceInput = {
  /** Drawn item bounds in Paper units (each united after +BUFFER expand). */
  itemBounds?: readonly ScrollRect[]
  /** Current Paper view bounds in Paper units. */
  viewBounds?: ScrollRect
  /** True trims empty space even if the viewport jumps (zoom/reset path). */
  clipEmpty?: boolean
}

/**
 * Pure model of the reference workspace-bounds rule, in own words:
 * start from the art board; unless clipEmpty, also cover what is currently
 * visible; cover every drawn item plus a buffer ring; never exceed the
 * buffer-expanded max workspace; when the result is narrower than the view,
 * widen it symmetrically around itself so a zoomed-out view stays centered
 * instead of clamping to one edge. Non-finite inputs fail closed to the
 * art board.
 */
export function workspaceBoundsForContent(input: WorkspaceInput = {}): ScrollRect {
  const art: ScrollRect = { left: 0, top: 0, right: SCROLL_ART_BOARD.width, bottom: SCROLL_ART_BOARD.height }
  const maxExpanded = expandRectTotal(
    { left: SCROLL_MAX_WORKSPACE.left, top: SCROLL_MAX_WORKSPACE.top, right: SCROLL_MAX_WORKSPACE.right, bottom: SCROLL_MAX_WORKSPACE.bottom },
    SCROLL_WORKSPACE_BUFFER,
  )
  const clipEmpty = input.clipEmpty === true
  let bounds: ScrollRect = { ...art }
  if (!clipEmpty && input.viewBounds) {
    const vb = sanitizeRect(input.viewBounds, art)
    bounds = uniteRects(bounds, vb)
  }
  const items = Array.isArray(input.itemBounds) ? input.itemBounds : []
  for (const item of items) {
    if (!item) continue
    const safe = sanitizeRect(item, art)
    bounds = uniteRects(bounds, expandRectTotal(safe, SCROLL_WORKSPACE_BUFFER))
  }
  bounds = intersectRects(bounds, maxExpanded)
  // Center-in-view expansion when the viewport is larger than the workspace.
  if (input.viewBounds) {
    const vb = sanitizeRect(input.viewBounds, art)
    const vw = rectWidth(vb)
    const vh = rectHeight(vb)
    if (isFiniteNumber(vw) && vw > 0 && rectWidth(bounds) < vw) {
      const grow = (vw - rectWidth(bounds)) / 2
      bounds = { left: bounds.left - grow, top: bounds.top, right: bounds.right + grow, bottom: bounds.bottom }
    }
    if (isFiniteNumber(vh) && vh > 0 && rectHeight(bounds) < vh) {
      const grow = (vh - rectHeight(bounds)) / 2
      bounds = { left: bounds.left, top: bounds.top - grow, right: bounds.right, bottom: bounds.bottom + grow }
    }
  }
  return bounds
}

export type ClampViewResult = {
  /** View bounds after the sequential edge corrections. */
  viewBounds: ScrollRect
  /** Total scrollBy applied (Paper world units). */
  dx: number
  /** Total scrollBy applied (Paper world units). */
  dy: number
  /** True when at least one edge was outside the workspace. */
  clamped: boolean
  /** Which edges triggered (survey order left/top/bottom/right). */
  edges: Array<'left' | 'top' | 'bottom' | 'right'>
}

/**
 * Pure model of the reference view-clamp order, in own words: compare the
 * current view edges against the workspace edges in left/top/bottom/right
 * order, nudging the view back inside one edge at a time; each nudge moves
 * the view before the next edge is tested. Finishes by recomputing the
 * workspace without trimming empty space (that refresh is recorded as
 * `workspaceAfter`, not applied here so tests can assert both steps).
 */
export function clampViewToWorkspace(viewBounds: ScrollRect, workspace: ScrollRect): ClampViewResult {
  const art: ScrollRect = { left: 0, top: 0, right: 960, bottom: 720 }
  let view = sanitizeRect(viewBounds, art)
  const ws = sanitizeRect(workspace, art)
  let dx = 0
  let dy = 0
  const edges: Array<'left' | 'top' | 'bottom' | 'right'> = []
  if (view.left < ws.left) {
    const push = ws.left - view.left
    dx += push
    view = { left: view.left + push, top: view.top, right: view.right + push, bottom: view.bottom }
    edges.push('left')
  }
  if (view.top < ws.top) {
    const push = ws.top - view.top
    dy += push
    view = { left: view.left, top: view.top + push, right: view.right, bottom: view.bottom + push }
    edges.push('top')
  }
  if (view.bottom > ws.bottom) {
    const push = ws.bottom - view.bottom
    dy += push
    view = { left: view.left, top: view.top + push, right: view.right, bottom: view.bottom + push }
    edges.push('bottom')
  }
  if (view.right > ws.right) {
    const push = ws.right - view.right
    dx += push
    view = { left: view.left + push, top: view.top, right: view.right + push, bottom: view.bottom }
    edges.push('right')
  }
  return { viewBounds: view, dx, dy, clamped: edges.length > 0, edges }
}

/**
 * Pure model of the reference mouse-action bounds, in own words: bitmap
 * tools stay on the art board; vector tools may roam over whatever is
 * visible plus the board, but never past the raw (unexpanded) max workspace.
 */
export function actionBoundsForMode(isBitmap: boolean, viewBounds?: ScrollRect): ScrollRect {
  const art: ScrollRect = { left: 0, top: 0, right: 960, bottom: 720 }
  if (isBitmap) return { ...art }
  const vb = viewBounds ? sanitizeRect(viewBounds, art) : { ...art }
  const united = uniteRects(vb, art)
  return intersectRects(united, { ...SCROLL_MAX_WORKSPACE })
}

// ---------------------------------------------------------------------------
// Wheel / pan / scrollbar gains (own derivations of the surveyed factors).
// ---------------------------------------------------------------------------

/** Normalize one wheel delta (line mode x15) [確定]. Non-finite => 0. */
export function normalizeScrollDelta(delta: number, deltaMode: number): number {
  if (!isFiniteNumber(delta)) return 0
  if (deltaMode === 1) return delta * SCROLL_LINE_MULTIPLIER
  return delta
}

/** Reference ctrl-wheel Paper gain: -deltaY/1000 Paper zoom units [確定]. */
export function paperWheelGain(normalizedDeltaY: number): number {
  if (!isFiniteNumber(normalizedDeltaY) || normalizedDeltaY === 0) return 0
  return -normalizedDeltaY / SCROLL_WHEEL_DIVISOR
}

/**
 * Reference pan world distance for a CSS-px wheel delta at this zoom
 * [確定]: world = deltaCss / zoom. The current CSS UI deliberately does NOT
 * divide (offsets are already screen px) -- tests assert both numbers
 * side-by-side so the fork stays visible.
 */
export function paperPanWorldForDelta(deltaCssPx: number, paperZoom: number): number {
  if (!isFiniteNumber(deltaCssPx)) return 0
  const zoom = isFiniteNumber(paperZoom) && paperZoom > 0 ? paperZoom : SCROLL_RESET_ZOOM
  return deltaCssPx / zoom
}

/** Current CSS pan screen distance: the delta itself (no division). */
export function cssPanScreenForDelta(deltaCssPx: number): number {
  if (!isFiniteNumber(deltaCssPx)) return 0
  return deltaCssPx
}

/**
 * Reference scrollbar matrix gain [確定]: dragging the custom scrollbar by
 * dx CSS px moves matrix.tx by dx*zoom*2 (the x2 undoes the Paper
 * view-matrix 0.5 factor). Clamp runs after. Non-finite => 0.
 */
export function paperScrollbarMatrixForDrag(dragDxCssPx: number, paperZoom: number): number {
  if (!isFiniteNumber(dragDxCssPx)) return 0
  const zoom = isFiniteNumber(paperZoom) && paperZoom > 0 ? paperZoom : SCROLL_RESET_ZOOM
  const out = dragDxCssPx * zoom * 2
  return isFiniteNumber(out) ? out : 0
}

// ---------------------------------------------------------------------------
// Current CSS camera <-> Paper coordinate conversion (own derivation).
// ---------------------------------------------------------------------------

/**
 * Actual-size density: CSS px per 1 Paper unit at this CSS scale.
 * density = (surfaceW / paperW) * clampedScale. Fail-closed 0.
 * `paperW` is the EXPLICIT board (vector 960, res2 960, res1 960 decided;
 * res1 480-wide canvas stands for the 960-unit board because the reference
 * loader doubles stored res1 before paint).
 */
export function cssPxPerPaperUnitForSurface(
  surfaceWidthPx: number,
  paperWidthUnitsAssumption: number,
  cssScale: number,
): number {
  if (!isFiniteNumber(surfaceWidthPx) || surfaceWidthPx <= 0) return 0
  if (!isFiniteNumber(paperWidthUnitsAssumption) || paperWidthUnitsAssumption <= 0) return 0
  const scale = isFiniteNumber(cssScale) && cssScale > 0 ? cssScale : 1
  const clamped = Math.max(SCROLL_CSS_VECTOR_MIN, Math.min(SCROLL_CSS_MAX, scale))
  const out = (surfaceWidthPx / paperWidthUnitsAssumption) * clamped
  return isFiniteNumber(out) && out > 0 ? out : 0
}

/** Res1 density readings (decided: board 0.5 wins; own kept for audit). */
export function res1DensityReadings(canvasWidthPx: number): { board: number; own: number; decided: number } {
  const w = isFiniteNumber(canvasWidthPx) && canvasWidthPx > 0 ? canvasWidthPx : 480
  return { board: w / 960, own: w / 480, decided: w / 960 }
}

/**
 * Predict the CSS surface rect from the style binding inputs (same math as
 * the live transform, kept local so this module is standalone):
 * unscaled W x H box centered on C, shifted by (vx,vy), scaled by s.
 */
export function predictCssSurfaceRect(
  surface: ScrollSize,
  containerCenter: ScrollPoint,
  viewport: CssCamera,
): { left: number; top: number; width: number; height: number } {
  const safeSurface = sanitizeSize(surface, { width: 2400, height: 1800 })
  const safeCenter = sanitizePoint(containerCenter)
  const vx = isFiniteNumber(viewport?.x) ? viewport.x : 0
  const vy = isFiniteNumber(viewport?.y) ? viewport.y : 0
  const rawScale = isFiniteNumber(viewport?.scale) ? (viewport as CssCamera).scale : 1
  const scale = Math.max(SCROLL_CSS_VECTOR_MIN, Math.min(SCROLL_CSS_MAX, rawScale))
  const width = safeSurface.width * scale
  const height = safeSurface.height * scale
  return {
    left: safeCenter.x + vx - width / 2,
    top: safeCenter.y + vy - height / 2,
    width,
    height,
  }
}

/** Map a surface point (0..W,0..H) to client coordinates. */
export function cssSurfaceToScreen(
  surfacePoint: ScrollPoint,
  surface: ScrollSize,
  containerCenter: ScrollPoint,
  viewport: CssCamera,
): ScrollPoint {
  const safeSurface = sanitizeSize(surface, { width: 2400, height: 1800 })
  const safeCenter = sanitizePoint(containerCenter)
  const safePoint = sanitizePoint(surfacePoint)
  const vx = isFiniteNumber(viewport?.x) ? viewport.x : 0
  const vy = isFiniteNumber(viewport?.y) ? viewport.y : 0
  const rawScale = isFiniteNumber(viewport?.scale) ? (viewport as CssCamera).scale : 1
  const scale = Math.max(SCROLL_CSS_VECTOR_MIN, Math.min(SCROLL_CSS_MAX, rawScale))
  return {
    x: safeCenter.x + vx + (safePoint.x - safeSurface.width / 2) * scale,
    y: safeCenter.y + vy + (safePoint.y - safeSurface.height / 2) * scale,
  }
}

export type OverhangReport = {
  /** Surface px beyond each container edge (>0 means sticking out). */
  left: number
  right: number
  top: number
  bottom: number
  /** Largest single-edge overhang (surface px). */
  max: number
  /** True when the surface rect does not intersect the container at all. */
  fullyOutside: boolean
  /** Visible (clipped) width/height in CSS px. */
  visibleWidth: number
  visibleHeight: number
  /** Visible area ratio in [0,1] (0 = fully panned out). */
  visibleRatio: number
}

/**
 * How far the user has actually moved out of range (DOM-measurable):
 * compare a measured surface rect against the measured container rect.
 * The current UI never clamps vx/vy, so `max` grows without bound; the
 * reference would have clamped the Paper center instead (see
 * `clampViewToWorkspace`). `visibleRatio` is the overflow:hidden clip record
 * (apparent span = intersection, DPR-independent CSS px).
 */
export function cssOutOfRangeAmount(
  surfaceRect: { left: number; top: number; width: number; height: number },
  containerRect: { left: number; top: number; width: number; height: number },
): OverhangReport {
  const sr = {
    left: isFiniteNumber(surfaceRect?.left) ? surfaceRect.left : 0,
    top: isFiniteNumber(surfaceRect?.top) ? surfaceRect.top : 0,
    width: isFiniteNumber(surfaceRect?.width) && surfaceRect.width > 0 ? surfaceRect.width : 0,
    height: isFiniteNumber(surfaceRect?.height) && surfaceRect.height > 0 ? surfaceRect.height : 0,
  }
  const cr = {
    left: isFiniteNumber(containerRect?.left) ? containerRect.left : 0,
    top: isFiniteNumber(containerRect?.top) ? containerRect.top : 0,
    width: isFiniteNumber(containerRect?.width) && containerRect.width > 0 ? containerRect.width : 0,
    height: isFiniteNumber(containerRect?.height) && containerRect.height > 0 ? containerRect.height : 0,
  }
  const sRight = sr.left + sr.width
  const sBottom = sr.top + sr.height
  const cRight = cr.left + cr.width
  const cBottom = cr.top + cr.height
  const left = cr.left - sr.left
  const top = cr.top - sr.top
  const right = sRight - cRight
  const bottom = sBottom - cBottom
  const max = Math.max(left, right, top, bottom)
  const visibleWidth = Math.max(0, Math.min(sRight, cRight) - Math.max(sr.left, cr.left))
  const visibleHeight = Math.max(0, Math.min(sBottom, cBottom) - Math.max(sr.top, cr.top))
  const surfaceArea = sr.width * sr.height
  const visibleRatio = surfaceArea > 0 ? (visibleWidth * visibleHeight) / surfaceArea : 0
  const fullyOutside = visibleWidth <= 0 || visibleHeight <= 0
  return { left, right, top, bottom, max, fullyOutside, visibleWidth, visibleHeight, visibleRatio }
}

// ---------------------------------------------------------------------------
// Fixed-point maintenance vs clamp priority (the explanation, pinned).
// ---------------------------------------------------------------------------

export type PaperZoomThenClamp = {
  /** Zoom actually applied (floored at 0.333, overflow-guarded). */
  appliedZoom: number
  /** View center holding the fixed point BEFORE the workspace clamp. */
  preClampCenter: ScrollPoint
  /** View center AFTER the workspace clamp (what the user sees). */
  postClampCenter: ScrollPoint
  /** Screen drift (CSS px) the clamp introduces on the fixed point (>=0). */
  clampPinErrorCssPx: number
  /** True when the floor or the workspace clamp moved something. */
  clamped: boolean
}

/**
 * Reference order, in own words: pick the floored zoom, translate the view
 * so the fixed Paper point stays on the same screen pixel, THEN widen the
 * workspace to the drawn content (clipEmpty) and clamp the view back inside
 * it. The clamp WINS: at the workspace edge the fixed point visibly slips
 * (clampPinErrorCssPx > 0). Screen drift is measured as
 * |postCenter - preCenter| * appliedZoom.
 */
export function paperZoomThenClamp(
  prevZoom: number,
  deltaZoom: number,
  fixedPoint: ScrollPoint,
  prevCenter: ScrollPoint,
  viewSizeCssPx: ScrollSize,
  workspace: ScrollRect,
): PaperZoomThenClamp {
  const safePrevZoom = isFiniteNumber(prevZoom) && prevZoom > 0 ? prevZoom : SCROLL_RESET_ZOOM
  const safeDelta = isFiniteNumber(deltaZoom) ? deltaZoom : 0
  const fp = sanitizePoint(fixedPoint, SCROLL_ART_CENTER.x, SCROLL_ART_CENTER.y)
  const pc = sanitizePoint(prevCenter, SCROLL_ART_CENTER.x, SCROLL_ART_CENTER.y)
  const requested = safePrevZoom + safeDelta
  const appliedZoom = Math.max(SCROLL_OUTERMOST_ZOOM, Math.min(1_000_000, isFiniteNumber(requested) ? requested : safePrevZoom))
  const scaling = safePrevZoom / appliedZoom
  const preOffset = { x: fp.x - pc.x, y: fp.y - pc.y }
  const postOffset = {
    x: fp.x - preOffset.x * scaling - pc.x,
    y: fp.y - preOffset.y * scaling - pc.y,
  }
  const preClampCenter = { x: pc.x - postOffset.x, y: pc.y - postOffset.y }
  // View bounds around the pre-clamp center for the clamp step.
  const vs = sanitizeSize(viewSizeCssPx, { width: 800, height: 600 })
  const halfW = vs.width / appliedZoom / 2
  const halfH = vs.height / appliedZoom / 2
  const preView: ScrollRect = {
    left: preClampCenter.x - halfW,
    top: preClampCenter.y - halfH,
    right: preClampCenter.x + halfW,
    bottom: preClampCenter.y + halfH,
  }
  const clamped = clampViewToWorkspace(preView, workspace)
  const postClampCenter = {
    x: preClampCenter.x + clamped.dx,
    y: preClampCenter.y + clamped.dy,
  }
  const clampPinErrorCssPx = Math.hypot(postClampCenter.x - preClampCenter.x, postClampCenter.y - preClampCenter.y) * appliedZoom
  const floorClamped = appliedZoom !== requested
  return {
    appliedZoom,
    preClampCenter,
    postClampCenter,
    clampPinErrorCssPx: isFiniteNumber(clampPinErrorCssPx) ? clampPinErrorCssPx : 0,
    clamped: floorClamped || clamped.clamped,
  }
}

export type CssPinResult = {
  viewport: CssCamera
  appliedScale: number
  /** Screen drift of the fixed surface point (always <1px incl. band clamp). */
  pinErrorCssPx: number
  clamped: boolean
}

/**
 * Current UI order, in own words: clamp the requested scale to the per-mode
 * band FIRST, then translate (vx,vy) so the surface point under the cursor
 * maps back to the same screen pixel using the CLAMPED scale. The pin WINS:
 * even at the 0.1332/0.333/0.25 floor or the 5 ceiling the cursor does not
 * slip (there is no workspace clamp to overrule it).
 */
export function cssPinAfterClamp(
  viewport: CssCamera,
  surface: ScrollSize,
  containerCenter: ScrollPoint,
  screenPoint: ScrollPoint,
  factor: number,
  minScale: number = SCROLL_CSS_UNKNOWN_MIN,
): CssPinResult {
  const safeSurface = sanitizeSize(surface, { width: 2400, height: 1800 })
  const safeCenter = sanitizePoint(containerCenter)
  const safeScreen = sanitizePoint(screenPoint)
  const vx = isFiniteNumber(viewport?.x) ? viewport.x : 0
  const vy = isFiniteNumber(viewport?.y) ? viewport.y : 0
  const rawPrev = isFiniteNumber(viewport?.scale) ? (viewport as CssCamera).scale : 1
  const min = isFiniteNumber(minScale) && minScale > 0 ? minScale : SCROLL_CSS_UNKNOWN_MIN
  const prev = Math.max(min, Math.min(SCROLL_CSS_MAX, rawPrev))
  if (!isFiniteNumber(factor) || factor <= 0) {
    return { viewport: { x: vx, y: vy, scale: prev }, appliedScale: prev, pinErrorCssPx: 0, clamped: false }
  }
  const requested = prev * factor
  const appliedScale = Math.max(min, Math.min(SCROLL_CSS_MAX, requested))
  const clamped = appliedScale !== requested
  // Surface point under the cursor before the zoom.
  const fixedSurface: ScrollPoint = {
    x: safeSurface.width / 2 + (safeScreen.x - safeCenter.x - vx) / prev,
    y: safeSurface.height / 2 + (safeScreen.y - safeCenter.y - vy) / prev,
  }
  const x = safeScreen.x - safeCenter.x - (fixedSurface.x - safeSurface.width / 2) * appliedScale
  const y = safeScreen.y - safeCenter.y - (fixedSurface.y - safeSurface.height / 2) * appliedScale
  const after = cssSurfaceToScreen(
    fixedSurface,
    safeSurface,
    safeCenter,
    { x, y, scale: appliedScale },
  )
  const pinErrorCssPx = Math.hypot(after.x - safeScreen.x, after.y - safeScreen.y)
  return {
    viewport: { x, y, scale: appliedScale },
    appliedScale,
    pinErrorCssPx: isFiniteNumber(pinErrorCssPx) ? pinErrorCssPx : 0,
    clamped,
  }
}
