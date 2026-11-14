// Independent oracle for the Paper workspace clamp wiring (NEW tests only, no product change).
//
// Scope (delegated): res2 + vector only. res1/unknown is edited by a separate
// agent, so every res1-shaped input here must fail closed to legacy (density
// undefined => input unchanged) and is pinned as such, never as a winner.
//
// What this file does independently:
// - Traces the reference caller order read-only from
//   `.tmp/scratch-editor/packages/scratch-paint` (view.js
//   setWorkspaceBounds/clampViewBounds order per entry point, especially
//   `resetZoom` = zoom 0.5 + setWorkspaceBounds(true) + clamp; plus
//   scrollable-canvas.jsx wheel/scrollbar event order and paper-canvas.jsx
//   onViewResize/maybeZoomToFit order) by asserting on the source text.
// - Pins the current wiring's clipEmpty map read-only from
//   `BitmapEditor.svelte` source text (pan false / zoom true / reset true /
//   resize true / fit false). Reset/resize match the reference
//   (resetZoom/onViewResize clipEmpty=true); only the post-fit centering
//   keeps clipEmpty=false (centering authoritative, documented in-product).
//   P1 (resize empty res2: false 66.25 vs true 0) and P2 (reset with a
//   (0,0,100,100) item: false 0 vs true +6.25) pin the true branch.
// - Re-derives the workspace + sequential-clamp oracle LOCALLY (re-typed
//   constants, own code, no import of the rule itself) and compares the
//   product wiring across a massive generated matrix of canvas / container /
//   zoom / bitmap-content / per-selection / per-translation scenarios with a
//   ±1px bar on every CSS-px value (Paper-unit values use 1e-9; the CSS bar
//   covers float round-trip only, never a semantic slip).
// - Covers boundary clicks (text/brush/point selection mapping), pointer-fixed
//   zoom clamp priority (clamp WINS at the edge), stage/sprite/huge-union/odd
//   rotation-center shapes. Real-Editor reachability for the same range lives
//   in `viewport-paper-clamp-oracle.browser.test.ts`; where the range cannot
//   be produced in the real Editor this file proves the reference oracle
//   cannot produce it either (unreachable in both).
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  PAPER_CLAMP_RES1_DENSITY,
  PAPER_CLAMP_RES2_DENSITY,
  PAPER_CLAMP_VECTOR_DENSITY,
  clampCssViewportToPaper,
  cssViewportForPaperCenter,
  paperItemRectsForBitmapOpaque,
  paperItemRectsForVectorUnits,
  paperViewBoundsForCssViewport,
  paperWorkspaceForClamp,
} from '../src/features/costumes/viewport-paper-clamp'
import {
  actionBoundsForMode,
  clampViewToWorkspace,
  paperZoomThenClamp,
} from '../src/features/costumes/viewport-scroll-clamp'
import { zoomViewportAtSurfacePoint } from '../src/features/costumes/costume-viewport'
import { hasScratchReference } from './scratch-reference'

// Optional upstream oracle: `.tmp/scratch-editor` is git-ignored and absent
// on clean clones. The caller-order trace below reads reference source, so it
// skips when the checkout is missing; every independent product oracle in this
// file (live wiring, local matrix, boundary, zoom, P1/P2, unreachable proofs)
// keeps running. See `test/scratch-reference.ts`.
const HAS_SCRATCH_REFERENCE = hasScratchReference()

const REF_VIEW = join(import.meta.dir, '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/view.js')
const REF_SCROLLABLE = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/containers/scrollable-canvas.jsx',
)
const REF_PAPER_CANVAS = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/containers/paper-canvas.jsx',
)
const REF_UPDATE_IMAGE = join(import.meta.dir, '../../../.tmp/scratch-editor/packages/scratch-paint/src/hocs/update-image-hoc.jsx')
const LIVE_EDITOR = join(import.meta.dir, '../src/features/CostumeEditor/BitmapEditor.svelte')

async function readText(path: string): Promise<string> {
  return await Bun.file(path).text()
}

// ---------------------------------------------------------------------------
// Local oracle (re-typed constants, own derivation, no rule import).
// ---------------------------------------------------------------------------

type Rect = { left: number; top: number; right: number; bottom: number }

const REF_ART: Rect = { left: 0, top: 0, right: 960, bottom: 720 }
const REF_MAX: Rect = { left: -240, top: -180, right: 1200, bottom: 900 }
const REF_BUFFER = 50

function localExpandTotal(r: Rect, amount: number): Rect {
  const half = amount / 2
  return { left: r.left - half, top: r.top - half, right: r.right + half, bottom: r.bottom + half }
}

function localUnite(a: Rect, b: Rect): Rect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

function localIntersect(a: Rect, b: Rect): Rect {
  const out = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  if (!(out.right > out.left && out.bottom > out.top)) return { ...REF_ART }
  return out
}

/** Independent workspace oracle (own words): board; +view unless clipEmpty; +items+buffer; cap; symmetric widen. */
function localWorkspace(view: Rect | undefined, items: Rect[], clipEmpty: boolean): Rect {
  const maxExpanded = localExpandTotal(REF_MAX, REF_BUFFER)
  let bounds: Rect = { ...REF_ART }
  if (!clipEmpty && view) bounds = localUnite(bounds, view)
  for (const item of items) {
    if (!Number.isFinite(item.left + item.top + item.right + item.bottom)) continue
    if (!(item.right >= item.left && item.bottom >= item.top)) continue
    bounds = localUnite(bounds, localExpandTotal(item, REF_BUFFER))
  }
  bounds = localIntersect(bounds, maxExpanded)
  if (view) {
    const vw = view.right - view.left
    const vh = view.bottom - view.top
    if (vw > 0 && bounds.right - bounds.left < vw) {
      const grow = (vw - (bounds.right - bounds.left)) / 2
      bounds = { left: bounds.left - grow, top: bounds.top, right: bounds.right + grow, bottom: bounds.bottom }
    }
    if (vh > 0 && bounds.bottom - bounds.top < vh) {
      const grow = (vh - (bounds.bottom - bounds.top)) / 2
      bounds = { left: bounds.left, top: bounds.top - grow, right: bounds.right, bottom: bounds.bottom + grow }
    }
  }
  return bounds
}

/** Independent sequential clamp oracle: left/top/bottom/right, one edge at a time. */
function localClamp(view: Rect, ws: Rect): { view: Rect; dx: number; dy: number; edges: string[] } {
  let v = { ...view }
  let dx = 0
  let dy = 0
  const edges: string[] = []
  if (v.left < ws.left) {
    const push = ws.left - v.left
    dx += push
    v = { left: v.left + push, top: v.top, right: v.right + push, bottom: v.bottom }
    edges.push('left')
  }
  if (v.top < ws.top) {
    const push = ws.top - v.top
    dy += push
    v = { left: v.left, top: v.top + push, right: v.right, bottom: v.bottom + push }
    edges.push('top')
  }
  if (v.bottom > ws.bottom) {
    const push = ws.bottom - v.bottom
    dy += push
    v = { left: v.left, top: v.top + push, right: v.right, bottom: v.bottom + push }
    edges.push('bottom')
  }
  if (v.right > ws.right) {
    const push = ws.right - v.right
    dx += push
    v = { left: v.left + push, top: v.top, right: v.right + push, bottom: v.bottom }
    edges.push('right')
  }
  return { view: v, dx, dy, edges }
}

function rectErr(a: Rect, b: Rect): number {
  return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom))
}

describe.skipIf(!HAS_SCRATCH_REFERENCE)('oracle: independent reference caller-order trace (read-only)', () => {
  it('resetZoom is zoom 0.5 then setWorkspaceBounds(true) then clamp (clipEmpty=true)', async () => {
    const src = await readText(REF_VIEW)
    const block = src.slice(src.indexOf('const resetZoom'), src.indexOf('const pan'))
    expect(block).toContain('view.zoom = .5')
    expect(block).toContain('setWorkspaceBounds(true')
    expect(block).toContain('clampViewBounds()')
    expect(block.indexOf('setWorkspaceBounds(true')).toBeLessThan(block.indexOf('clampViewBounds()'))
  })

  it('pan is scrollBy then clamp (workspace refreshed unclipped after)', async () => {
    const src = await readText(REF_VIEW)
    const pan = src.slice(src.indexOf('const pan ='), src.indexOf('const getActionBounds'))
    expect(pan).toContain('scrollBy')
    expect(pan).toContain('clampViewBounds()')
    expect(pan.indexOf('scrollBy')).toBeLessThan(pan.indexOf('clampViewBounds()'))
    const clampTail = src.slice(src.indexOf('const clampViewBounds'), src.indexOf('const resizeCrosshair'))
    expect(clampTail).toContain('setWorkspaceBounds()')
  })

  it('zoomOnFixedPoint is floor-zoom + translate then setWorkspaceBounds(true) + clamp (clamp wins)', async () => {
    const src = await readText(REF_VIEW)
    const block = src.slice(src.indexOf('const zoomOnFixedPoint'), src.indexOf('const zoomOnSelection'))
    expect(block).toContain('OUTERMOST_ZOOM_LEVEL')
    expect(block).toContain('view.zoom = newZoom')
    expect(block).toContain('view.translate(')
    expect(block).toContain('setWorkspaceBounds(true')
    expect(block).toContain('clampViewBounds()')
    expect(block.indexOf('view.translate(')).toBeLessThan(block.indexOf('setWorkspaceBounds(true'))
    expect(block.indexOf('setWorkspaceBounds(true')).toBeLessThan(block.indexOf('clampViewBounds()'))
  })

  it('scrollable-canvas event order: ctrl/meta zoom / shift-x pan / plain pan / scrollbar gain', async () => {
    const src = await readText(REF_SCROLLABLE)
    expect(src).toContain('zoomOnFixedPoint(-deltaY / 1000, fixedPoint)')
    expect(src).toContain('pan(dx, 0)')
    expect(src).toContain('pan(dx, dy)')
    expect(src).toContain('paper.view.matrix.tx = this.initialScreenX + (dx * paper.view.zoom * 2)')
    expect(src).toContain('clampViewBounds()')
    expect(src).toContain('updateViewBounds(paper.view.matrix)')
    // Plain (non-ctrl) pan forwards the event to the active tool; ctrl zoom redraws the selection box instead.
    expect(src).toContain(`paper.tool.view._handleMouseEvent('mousemove', event, fixedPoint)`)
    expect(src).toContain('redrawSelectionBox()')
  })

  it('paper-canvas mount/resize/fit order: setup -> resize-listener -> resetZoom; onViewResize true+clamp; maybeZoomToFit tail unclipped', async () => {
    const src = await readText(REF_PAPER_CANVAS)
    expect(src).toContain(`paper.view.on('resize', this.onViewResize)`)
    const mount = src.slice(src.indexOf('componentDidMount'), src.indexOf('componentWillReceiveProps'))
    expect(mount.indexOf(`paper.view.on('resize'`)).toBeLessThan(mount.indexOf('resetZoom()'))
    const resize = src.slice(src.indexOf('onViewResize ()'), src.indexOf('recalibrateSize (callback)'))
    expect(resize).toContain('setWorkspaceBounds(true')
    expect(resize).toContain('clampViewBounds()')
    expect(resize.indexOf('setWorkspaceBounds(true')).toBeLessThan(resize.indexOf('clampViewBounds()'))
    const fit = src.slice(src.indexOf('maybeZoomToFit (isBitmapMode)'), src.indexOf('importSvg (svg'))
    expect(fit).toContain('zoomToFit(isBitmapMode)')
    expect(fit).toContain('setWorkspaceBounds()')
  })

  it('image updates refresh the workspace unclipped (update-image-hoc)', async () => {
    const src = await readText(REF_UPDATE_IMAGE)
    expect(src).toContain('setWorkspaceBounds()')
    expect(src).not.toContain('setWorkspaceBounds(true')
  })
})

describe('oracle: live wiring clipEmpty map (read-only pin, reference order kept)', () => {
  it('pan=false, fixed-point zoom=true (reference order kept)', async () => {
    const src = await readText(LIVE_EDITOR)
    expect(src).toContain(`if (resolved.kind === 'pan') setViewportWithPaperClamp(resolved.viewport.x, resolved.viewport.y, resolved.viewport.scale, false)`)
    expect(src).toContain(`else setViewportWithPaperClamp(resolved.viewport.x, resolved.viewport.y, resolved.viewport.scale, true)`)
  })

  it('reset=true + resize=true match the reference (resetZoom/onViewResize clipEmpty=true); fit=false stays deliberate', async () => {
    const src = await readText(LIVE_EDITOR)
    // resetZoom reference is clipEmpty=true; live reset recenters (vx=vy=0)
    // then applies the same trimmed workspace (P2: +6.25 CSS px for a
    // (0,0,100,100) item at reset; false would hold 0).
    expect(src).toContain('applyPaperWorkspaceClamp({ x: 0, y: 0, scale: banded }, true)')
    expect(src).not.toContain('applyPaperWorkspaceClamp({ x: 0, y: 0, scale: banded }, false)')
    // onViewResize reference is clipEmpty=true; live resize re-clamps the
    // kept viewport against the trimmed workspace (P1: x=200 at res2 reset
    // re-clamps to 0; cover-view false would stop at 66.25).
    expect(src).toContain('applyPaperWorkspaceClamp({ x: viewportX, y: viewportY, scale: viewportScale }, true)')
    expect(src).not.toContain('applyPaperWorkspaceClamp({ x: viewportX, y: viewportY, scale: viewportScale }, false)')
    // fit tail stays position-preserving: live post-fit covers the fit view
    // (centering authoritative), so only the expanded-MAX edge can clamp.
    expect(src).toContain('setViewportWithPaperClamp(result.viewport.x, result.viewport.y, result.viewport.scale, false)')
    // unknown stays legacy (density undefined => input unchanged); res1
    // clamps on the decided 0.5 density (separate agent owns the res1 band).
    expect(src).toContain('if (density === undefined) return viewport')
  })
})

describe('oracle: massive matrix — workspace + clamp vs local oracle (±1px CSS, exact Paper)', () => {
  // res2/vector only. res1/unknown appears solely as the legacy fail-closed pin below.
  const MODES = [
    { name: 'vector', surface: { width: 2400, height: 1800 }, density: PAPER_CLAMP_VECTOR_DENSITY, canvasCenter: undefined as { x: number; y: number } | undefined, scales: [0.333 / 2.5, 0.5 / 2.5, 0.5, 1, 2, 5] },
    { name: 'res2', surface: { width: 960, height: 720 }, density: PAPER_CLAMP_RES2_DENSITY, canvasCenter: { x: 480, y: 360 }, scales: [0.333, 0.5, 1, 2, 5] },
    { name: 'res2-union1200', surface: { width: 1200, height: 720 }, density: PAPER_CLAMP_RES2_DENSITY, canvasCenter: { x: 480, y: 360 }, scales: [0.333, 0.5, 1, 2, 5] },
    { name: 'res2-union2000', surface: { width: 2000, height: 720 }, density: PAPER_CLAMP_RES2_DENSITY, canvasCenter: { x: 480, y: 360 }, scales: [0.5, 1, 2] },
  ]
  const CONTAINERS = [
    { width: 800, height: 600 },
    { width: 400, height: 300 },
    { width: 1280, height: 800 },
    { width: 320, height: 240 },
    { width: 600, height: 900 },
    { width: 801, height: 601 },
    { width: 3000, height: 2000 },
    { width: 100, height: 100 },
  ]
  const CONTENTS: Array<{ name: string; rects: Rect[] }> = [
    { name: 'empty', rects: [] },
    { name: 'center-box', rects: [{ left: 400, top: 300, right: 560, bottom: 420 }] },
    { name: 'edge-origin-100', rects: [{ left: 0, top: 0, right: 200, bottom: 200 }] },
    { name: 'far-offboard', rects: [{ left: 1100, top: 100, right: 1300, bottom: 200 }] },
    { name: 'negative-offboard', rects: [{ left: -1000, top: -800, right: -900, bottom: -700 }] },
    { name: 'huge-6400', rects: [{ left: 0, top: 0, right: 6400, bottom: 4800 }] },
    { name: 'singular-point', rects: [{ left: 2000, top: 200, right: 2000, bottom: 200 }] },
    { name: 'singular-line', rects: [{ left: 100, top: 100, right: 500, bottom: 100 }] },
    { name: 'two-union', rects: [{ left: 10, top: 20, right: 220, bottom: 140 }, { left: 400, top: 200, right: 500, bottom: 300 }] },
    { name: 'straddle-max', rects: [{ left: 1150, top: 850, right: 1300, bottom: 950 }] },
  ]
  const PANS = [
    { x: 0, y: 0 },
    { x: -30, y: 10 },
    { x: 200, y: -150 },
    { x: 5000, y: 0 },
    { x: 0, y: 5000 },
    { x: -5000, y: -5000 },
  ]

  it('workspace matches the local oracle on every generated scenario', () => {
    let cases = 0
    let worst = 0
    const offenders: string[] = []
    for (const mode of MODES) {
      for (const container of CONTAINERS) {
        for (const scale of mode.scales) {
          for (const content of CONTENTS) {
            for (const pan of PANS) {
              for (const clipEmpty of [false, true]) {
                const mapped = paperViewBoundsForCssViewport(
                  { x: pan.x, y: pan.y, scale },
                  mode.surface,
                  container,
                  mode.density,
                  mode.canvasCenter,
                )
                if (!mapped.viewBounds) continue
                const ours = paperWorkspaceForClamp(mapped.viewBounds, content.rects, clipEmpty)
                const ref = localWorkspace(mapped.viewBounds, content.rects, clipEmpty)
                const err = rectErr(ours, ref)
                worst = Math.max(worst, err)
                cases += 1
                if (!(err < 1e-9)) offenders.push(`${mode.name}/${container.width}x${container.height}/s${scale}/${content.name}/pan${pan.x},${pan.y}/${clipEmpty ? 'clip' : 'cover'} err=${err}`)
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(5000)
    expect(offenders.slice(0, 8)).toEqual([])
    expect(worst).toBeLessThan(1e-9)
  })

  it('sequential clamp matches the local order oracle; CSS round-trip within ±1px', () => {
    let cases = 0
    let worstPaper = 0
    let worstCss = 0
    const offenders: string[] = []
    for (const mode of MODES) {
      for (const container of CONTAINERS) {
        for (const scale of mode.scales) {
          for (const content of CONTENTS) {
            for (const pan of PANS) {
              for (const clipEmpty of [false, true]) {
                const input = { x: pan.x, y: pan.y, scale }
                const mapped = paperViewBoundsForCssViewport(input, mode.surface, container, mode.density, mode.canvasCenter)
                if (!mapped.viewBounds || mapped.center === undefined || mapped.zoom === undefined) continue
                const ws = localWorkspace(mapped.viewBounds, content.rects, clipEmpty)
                const ref = localClamp(mapped.viewBounds, ws)
                const ours = clampCssViewportToPaper({
                  viewport: input,
                  surface: mode.surface,
                  containerSize: container,
                  density: mode.density,
                  canvasCenter: mode.canvasCenter,
                  itemPaperRects: content.rects,
                  clipEmpty,
                })
                // Paper-unit agreement must be exact (same arithmetic, no rounding budget).
                const paperErr = Math.abs(ref.dx - ours.paperDx) + Math.abs(ref.dy - ours.paperDy)
                worstPaper = Math.max(worstPaper, paperErr)
                // CSS-px agreement gets the ±1px bar (float round-trip through the projection).
                if (ours.clamped !== ref.edges.length > 0) {
                  offenders.push(`clamped-flag ${mode.name}/${container.width}x${container.height}/s${scale}/${content.name} pan=${pan.x},${pan.y}`)
                }
                if (JSON.stringify(ours.edges) !== JSON.stringify(ref.edges)) {
                  offenders.push(`edge-order ${mode.name}/${content.name} pan=${pan.x},${pan.y} got=${ours.edges} want=${ref.edges}`)
                }
                // Re-derive the expected CSS viewport from the reference-clamped center and compare ±1px.
                if (ref.edges.length > 0) {
                  const afterCenter = { x: mapped.center.x + ref.dx, y: mapped.center.y + ref.dy }
                  const back = cssViewportForPaperCenter(afterCenter, mapped.zoom, mode.surface, mode.density, mode.canvasCenter)
                  if (back) {
                    const cssErr = Math.max(Math.abs(back.x - ours.viewport.x), Math.abs(back.y - ours.viewport.y))
                    worstCss = Math.max(worstCss, cssErr)
                    if (!(cssErr <= 1)) offenders.push(`css-drift ${mode.name} pan=${pan.x},${pan.y} err=${cssErr}`)
                  }
                }
                // Scale is NEVER changed by the clamp on any scenario.
                if (ours.viewport.scale !== input.scale) offenders.push(`scale-drift ${mode.name} ${input.scale} -> ${ours.viewport.scale}`)
                cases += 1
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(5000)
    expect(offenders.slice(0, 10)).toEqual([])
    expect(worstPaper).toBeLessThan(1e-9)
    expect(worstCss).toBeLessThanOrEqual(1)
  })

  it('generated bitmap opaque + vector unit builders agree with verbatim mapping (odd centers, unions)', () => {
    // Odd rotation center: verbatim mapping still holds through the true center.
    const odd = paperItemRectsForBitmapOpaque(
      { x: 601, y: 101, width: 11, height: 9 },
      { width: 960, height: 720 },
      960,
      720,
      PAPER_CLAMP_RES2_DENSITY,
      { x: 481, y: 363 },
    )
    expect(odd).toEqual([{ left: 600, top: 98, right: 611, bottom: 107 }])
    // Union canvas: far-right ink maps verbatim (tracked true center, not width/2).
    const union = paperItemRectsForBitmapOpaque(
      { x: 1100, y: 100, width: 50, height: 50 },
      { width: 1200, height: 720 },
      1200,
      720,
      PAPER_CLAMP_RES2_DENSITY,
      { x: 480, y: 360 },
    )
    expect(union).toEqual([{ left: 1100, top: 100, right: 1150, bottom: 150 }])
    // Vector units double (svg*2); per-selection singles keep position.
    const singles = paperItemRectsForVectorUnits([
      { boundsX: 10, boundsY: 20, boundsWidth: 100, boundsHeight: 50 },
      { boundsX: 1000, boundsY: 100, boundsWidth: 0, boundsHeight: 0 },
    ])
    expect(singles).toEqual([
      { left: 20, top: 40, right: 220, bottom: 140 },
      { left: 2000, top: 200, right: 2000, bottom: 200 },
    ])
  })

  it('unknown stays legacy on the whole matrix (res1 uses the decided 0.5)', () => {
    for (const container of CONTAINERS.slice(0, 3)) {
      const out = clampCssViewportToPaper({
        viewport: { x: 5000, y: -3000, scale: 1 },
        surface: { width: 480, height: 360 },
        containerSize: container,
        density: undefined,
        clipEmpty: true,
        itemPaperRects: [{ left: 0, top: 0, right: 200, bottom: 200 }],
      })
      expect(out.clamped).toBe(false)
      expect(out.viewport).toEqual({ x: 5000, y: -3000, scale: 1 })
      // Live reason string is 'unknown-density: ... keep legacy' (unknown only;
      // res1 passes the decided 0.5 density and clamps on its band).
      expect(out.reason).toContain('keep legacy')
    }
  })
})

describe('oracle: boundary clicks — text / brush / point selection mapping (res2/vector)', () => {
  const VECTOR_SURFACE = { width: 2400, height: 1800 }
  const RES2_SURFACE = { width: 960, height: 720 }
  const CONTAINER = { width: 800, height: 600 }

  it('bitmap clicks are action-bounded to the artboard (offboard clicks do not select)', () => {
    // getActionBounds(bitmap) = ART always; verify the mapping lands clicks correctly.
    const art = actionBoundsForMode(true)
    expect(art).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
    // Center click maps to the board center; a far pan maps the same screen point offboard.
    const centered = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1 }, RES2_SURFACE, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(centered.center).toEqual({ x: 480, y: 360 })
    const inside = centered.center!.x >= art.left && centered.center!.x <= art.right
    expect(inside).toBe(true)
  })

  it('vector boundary selection: per-item rects at each board edge unite into the workspace', () => {
    const edges = [
      { name: 'left', rect: { left: -300, top: 300, right: -200, bottom: 400 } },
      { name: 'top', rect: { left: 400, top: -300, right: 500, bottom: -200 } },
      { name: 'right', rect: { left: 1100, top: 300, right: 1200, bottom: 400 } },
      { name: 'bottom', rect: { left: 400, top: 800, right: 500, bottom: 900 } },
    ]
    for (const edge of edges) {
      const ws = paperWorkspaceForClamp(undefined, [edge.rect], true)
      // Buffered item (-300-25=-325 .. -175) united with the board then capped
      // at expanded MAX (-265..1225): left pins at the MAX edge, right is the
      // board edge (the item contributes nothing past it).
      if (edge.name === 'left') {
        expect(ws.left).toBe(-265)
        expect(ws.right).toBe(960)
      } else {
        expect(ws.left).toBe(0)
      }
    }
    // Point (singular) selection at the exact board corner keeps position and clamps inside.
    const corner = paperItemRectsForVectorUnits([{ boundsX: 0, boundsY: 0, boundsWidth: 0, boundsHeight: 0 }])
    expect(corner).toEqual([{ left: 0, top: 0, right: 0, bottom: 0 }])
    const clamped = clampViewToWorkspace({ left: -5, top: -5, right: 315, bottom: 235 }, { left: 0, top: 0, right: 960, bottom: 720 })
    expect(clamped.edges).toEqual(['left', 'top'])
  })

  it('text/brush/point at the boundary: screen corners map to deterministic Paper points (±1px)', () => {
    // Container corners at reset map to the readable Paper rect (pinned by the correspondence test).
    const reset = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.2 }, VECTOR_SURFACE, CONTAINER, PAPER_CLAMP_VECTOR_DENSITY)
    expect(reset.viewBounds).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
    // A text click at the container corner is outside ART but inside the symmetric-widened workspace:
    // vector action bounds roam over view unite ART (capped at raw MAX).
    const action = actionBoundsForMode(false, reset.viewBounds)
    expect(action.left).toBeLessThanOrEqual(-240)
    expect(action.right).toBeGreaterThanOrEqual(960)
    // Brush/point at the artboard edge in surface px lands exactly on the board edge in Paper units.
    const atEdge = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.5 }, RES2_SURFACE, CONTAINER, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(atEdge.center).toEqual({ x: 480, y: 360 })
    expect(atEdge.viewBounds).toEqual({ left: -320, top: -240, right: 1280, bottom: 960 })
  })
})

describe('oracle: pointer-fixed zoom — clamp priority at the edge (res2/vector)', () => {
  it('interior fixed-point zoom holds the pin (<1px); edge zoom slips (clamp WINS, scale kept)', () => {
    // Interior: small zoom about the board center from reset stays inside; pure pin drift is 0.
    const interior = paperZoomThenClamp(
      0.5,
      0.1,
      { x: 480, y: 360 },
      { x: 480, y: 360 },
      { width: 800, height: 600 },
      { left: -320, top: -240, right: 1280, bottom: 960 },
    )
    expect(interior.clamped).toBe(false)
    expect(interior.clampPinErrorCssPx).toBeCloseTo(0, 9)
    // Edge: zooming about a far offboard pin with a tight workspace forces the clamp to win.
    const edge = paperZoomThenClamp(
      1,
      1,
      { x: 1200, y: 360 },
      { x: 1150, y: 360 },
      { width: 800, height: 600 },
      { left: 0, top: 0, right: 960, bottom: 720 },
    )
    expect(edge.clamped).toBe(true)
    expect(edge.clampPinErrorCssPx).toBeGreaterThan(0)
    // The live CSS path mirrors the priority: fixed-point first, then the clamp moves the center, scale kept.
    const zoomed = zoomViewportAtSurfacePoint(
      { x: 0, y: 0, scale: 0.5 },
      { width: 960, height: 720 },
      { x: 400, y: 300 },
      { x: 900, y: 360 },
      1,
      PAPER_CLAMP_RES2_DENSITY,
    )
    const clamped = clampCssViewportToPaper({
      viewport: zoomed.viewport,
      surface: { width: 960, height: 720 },
      containerSize: { width: 800, height: 600 },
      density: PAPER_CLAMP_RES2_DENSITY,
      canvasCenter: { x: 480, y: 360 },
      clipEmpty: true,
      itemPaperRects: [],
    })
    expect(clamped.viewport.scale).toBe(zoomed.viewport.scale)
    expect(clamped.reason).toMatch(/inside|clamped/)
  })
})

describe('oracle: stage / sprite / huge union / odd rotation center (res2/vector only)', () => {
  it('stage vs sprite artboard mapping is verbatim under the true center', () => {
    // Sprite res2 (960 canvas, center 480,360) and a stage-wide union (2000
    // canvas, same true center 480,360): centering the ARTBOARD center needs
    // vx=(W/2-480)*scale per surface (0 vs 260 at scale 0.5); both then read
    // Paper (480,360). The apparent middle (W/2) is NOT the anchor.
    const sprite = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 0.5 }, { width: 960, height: 720 }, { width: 800, height: 600 }, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    const union = paperViewBoundsForCssViewport({ x: 260, y: 0, scale: 0.5 }, { width: 2000, height: 720 }, { width: 800, height: 600 }, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    expect(sprite.center).toEqual({ x: 480, y: 360 })
    expect(union.center).toEqual({ x: 480, y: 360 })
  })

  it('huge union content caps at expanded MAX on both clipEmpty paths', () => {
    // No view: unite(board, huge+50) capped at expanded MAX (1490x1130).
    for (const clipEmpty of [false, true]) {
      const ws = paperWorkspaceForClamp(undefined, [{ left: 0, top: 0, right: 6400, bottom: 4800 }], clipEmpty)
      expect(ws.right - ws.left).toBeLessThanOrEqual(1490)
      expect(ws.bottom - ws.top).toBeLessThanOrEqual(1130)
    }
    // With a larger view the reference symmetric-widen grows PAST the cap to
    // the view size (1600x1200 at reset/800x600): cap-then-widen order.
    for (const clipEmpty of [false, true]) {
      const ws = paperWorkspaceForClamp({ left: -320, top: -240, right: 1280, bottom: 960 }, [{ left: 0, top: 0, right: 6400, bottom: 4800 }], clipEmpty)
      expect(ws.right - ws.left).toBe(1600)
      expect(ws.bottom - ws.top).toBe(1200)
    }
  })

  it('odd rotation center (481,363) shifts mapping by exactly the half-px offset', () => {
    const even = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1 }, { width: 960, height: 720 }, { width: 800, height: 600 }, PAPER_CLAMP_RES2_DENSITY, { x: 480, y: 360 })
    const odd = paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1 }, { width: 960, height: 720 }, { width: 800, height: 600 }, PAPER_CLAMP_RES2_DENSITY, { x: 481, y: 363 })
    expect(even.center).toEqual({ x: 480, y: 360 })
    expect(odd.center).toEqual({ x: 479, y: 357 })
  })
})

describe('oracle: unreachable-state proof (cannot hold in Editor => cannot hold in Scratch)', () => {
  it('the 5000-pan-at-reset view is unholdable in both oracles (clamp pulls to the same edge)', () => {
    const raw = { x: 5000, y: 0, scale: 0.2 }
    const live = clampCssViewportToPaper({
      viewport: raw,
      surface: { width: 2400, height: 1800 },
      containerSize: { width: 800, height: 600 },
      density: PAPER_CLAMP_VECTOR_DENSITY,
      clipEmpty: false,
      itemPaperRects: [],
    })
    expect(live.clamped).toBe(true)
    expect(live.viewport.x).toBeCloseTo(66.25, 9)
    // Reference oracle on the same Paper view reaches the identical edge:
    // Paper view at reset is 1600x1200 around center+pan; local clamp must agree on dx.
    const mapped = paperViewBoundsForCssViewport(raw, { width: 2400, height: 1800 }, { width: 800, height: 600 }, PAPER_CLAMP_VECTOR_DENSITY)
    const refWs = localWorkspace(mapped.viewBounds, [], false)
    const ref = localClamp(mapped.viewBounds!, refWs)
    expect(ref.dx).toBeCloseTo(live.paperDx, 9)
    expect(ref.edges).toEqual(live.edges)
    // The pan path workspace is view-dependent (cover-the-view + cap +
    // widen), so one clamp step need not be a fixed point when the view is
    // larger than expanded MAX: both oracles converge by re-clamping (Scratch
    // `clampViewBounds` is likewise re-entered on every scroll event, never a
    // one-shot hold). Assert step-by-step agreement until stable.
    let current = live.viewport
    let stable: typeof live | undefined
    for (let step = 0; step < 5; step += 1) {
      const next = clampCssViewportToPaper({
        viewport: current,
        surface: { width: 2400, height: 1800 },
        containerSize: { width: 800, height: 600 },
        density: PAPER_CLAMP_VECTOR_DENSITY,
        clipEmpty: false,
        itemPaperRects: [],
      })
      expect(next.viewport.scale).toBe(0.2)
      const rm = paperViewBoundsForCssViewport(current, { width: 2400, height: 1800 }, { width: 800, height: 600 }, PAPER_CLAMP_VECTOR_DENSITY)
      const rws = localWorkspace(rm.viewBounds, [], false)
      const rc = localClamp(rm.viewBounds!, rws)
      expect(next.paperDx).toBeCloseTo(rc.dx, 9)
      expect(next.edges).toEqual(rc.edges)
      current = next.viewport
      if (!next.clamped) {
        stable = next
        break
      }
    }
    expect(stable).not.toBeUndefined()
    // The raw 5000-pan view is unholdable in the reference too: local clamp moves it.
    expect(ref.edges.length).toBeGreaterThan(0)
  })
})

describe('oracle: exact order P1/P2 vs local oracle (res1/res2/vector, ±1px CSS only for round-trip)', () => {
  // P1 (resize, empty res2 960x720, container 800x600, scale 0.5, vx=200):
  // reference trims empty (clipEmpty=true) then clamps to 0; covering the
  // view (false) stops at the widened edge 66.25. Live resize wires true.
  it('P1 pins false=66.25 vs true=0 and matches the local oracle exactly', () => {
    const input = { x: 200, y: 0, scale: 0.5 }
    const surface = { width: 960, height: 720 }
    const container = { width: 800, height: 600 }
    const cc = { x: 480, y: 360 }
    for (const [clipEmpty, wantX] of [[false, 66.25], [true, 0]] as Array<[boolean, number]>) {
      const mapped = paperViewBoundsForCssViewport(input, surface, container, PAPER_CLAMP_RES2_DENSITY, cc)
      const ours = clampCssViewportToPaper({ viewport: input, surface, containerSize: container, density: PAPER_CLAMP_RES2_DENSITY, canvasCenter: cc, itemPaperRects: [], clipEmpty })
      const refWs = localWorkspace(mapped.viewBounds, [], clipEmpty)
      const ref = localClamp(mapped.viewBounds!, refWs)
      expect(ours.viewport.x).toBeCloseTo(wantX, 9)
      expect(ours.viewport.scale).toBe(0.5)
      expect(ours.paperDx).toBeCloseTo(ref.dx, 12)
      expect(ours.paperDy).toBeCloseTo(ref.dy, 12)
      expect(ours.edges).toEqual(ref.edges)
      expect(rectErr(ours.workspace!, refWs)).toBeLessThan(1e-9)
      // CSS round-trip against the reference-clamped center stays within ±1px.
      const after = { x: mapped.center!.x + ref.dx, y: mapped.center!.y + ref.dy }
      const back = cssViewportForPaperCenter(after, mapped.zoom!, surface, PAPER_CLAMP_RES2_DENSITY, cc)
      expect(Math.abs(back!.x - ours.viewport.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(back!.y - ours.viewport.y)).toBeLessThanOrEqual(1)
    }
  })

  // P2 (reset, centered, content (0,0,100,100)): false holds 0; true pulls
  // +6.25 (Paper dx/dy -12.5). Live reset wires true. Pinned on
  // res2/vector/res1 (decided 0.5, res1-agent band protected).
  it('P2 pins false=0 vs true=+6.25 on res2/vector/res1 and matches the local oracle', () => {
    const item = [{ left: 0, top: 0, right: 100, bottom: 100 }]
    const cases = [
      { name: 'res2', viewport: { x: 0, y: 0, scale: 0.5 }, surface: { width: 960, height: 720 }, container: { width: 800, height: 600 }, density: PAPER_CLAMP_RES2_DENSITY, cc: { x: 480, y: 360 } as { x: number; y: number } | undefined },
      { name: 'vector', viewport: { x: 0, y: 0, scale: 0.2 }, surface: { width: 2400, height: 1800 }, container: { width: 800, height: 600 }, density: PAPER_CLAMP_VECTOR_DENSITY, cc: undefined },
      { name: 'res1', viewport: { x: 0, y: 0, scale: 1.0 }, surface: { width: 480, height: 360 }, container: { width: 800, height: 600 }, density: PAPER_CLAMP_RES1_DENSITY, cc: { x: 240, y: 180 } as { x: number; y: number } | undefined },
    ]
    for (const c of cases) {
      const covered = clampCssViewportToPaper({ viewport: c.viewport, surface: c.surface, containerSize: c.container, density: c.density, canvasCenter: c.cc, itemPaperRects: item, clipEmpty: false })
      const trimmed = clampCssViewportToPaper({ viewport: c.viewport, surface: c.surface, containerSize: c.container, density: c.density, canvasCenter: c.cc, itemPaperRects: item, clipEmpty: true })
      expect(covered.viewport.x).toBe(0)
      expect(covered.viewport.y).toBe(0)
      expect(trimmed.viewport.x).toBeCloseTo(6.25, 9)
      expect(trimmed.viewport.y).toBeCloseTo(6.25, 9)
      expect(trimmed.viewport.scale).toBe(c.viewport.scale)
      const mapped = paperViewBoundsForCssViewport(c.viewport, c.surface, c.container, c.density, c.cc)
      const refWs = localWorkspace(mapped.viewBounds, item, true)
      const ref = localClamp(mapped.viewBounds!, refWs)
      expect(trimmed.paperDx).toBeCloseTo(ref.dx, 12)
      expect(trimmed.edges).toEqual(ref.edges)
    }
  })

  // Small viewport (401x301, zoomed-in): no invented clamp on either order.
  // Huge/offboard/union/selection: trimmed-workspace pins vs local oracle.
  it('small viewport holds; huge/offboard/union/selection match the local oracle', () => {
    for (const clipEmpty of [false, true]) {
      const r = clampCssViewportToPaper({
        viewport: { x: 10, y: -5, scale: 1 },
        surface: { width: 960, height: 720 },
        containerSize: { width: 401, height: 301 },
        density: PAPER_CLAMP_RES2_DENSITY,
        canvasCenter: { x: 480, y: 360 },
        clipEmpty,
        itemPaperRects: [],
      })
      expect(r.clamped).toBe(false)
      expect(r.viewport).toEqual({ x: 10, y: -5, scale: 1 })
    }
    const extras: Array<{ name: string; view: Rect | undefined; items: Rect[] }> = [
      { name: 'huge', view: { left: -320, top: -240, right: 1280, bottom: 960 }, items: [{ left: 0, top: 0, right: 6400, bottom: 4800 }] },
      { name: 'offboard', view: undefined, items: [{ left: 1100, top: 100, right: 1300, bottom: 200 }] },
      { name: 'negative', view: undefined, items: [{ left: -1000, top: -800, right: -900, bottom: -700 }] },
      { name: 'point-union', view: undefined, items: [{ left: 2000, top: 200, right: 2000, bottom: 200 }] },
      { name: 'two-union', view: undefined, items: [{ left: 10, top: 20, right: 220, bottom: 140 }, { left: 400, top: 200, right: 500, bottom: 300 }] },
    ]
    for (const e of extras) {
      for (const clipEmpty of [false, true]) {
        const ours = paperWorkspaceForClamp(e.view, e.items, clipEmpty)
        const ref = localWorkspace(e.view, e.items, clipEmpty)
        expect(rectErr(ours, ref)).toBeLessThan(1e-9)
      }
    }
    // Per-selection vector singles keep position (union width 480).
    expect(paperItemRectsForVectorUnits([
      { boundsX: 10, boundsY: 20, boundsWidth: 100, boundsHeight: 50 },
      { boundsX: 1000, boundsY: 100, boundsWidth: 0, boundsHeight: 0 },
    ])).toEqual([
      { left: 20, top: 40, right: 220, bottom: 140 },
      { left: 2000, top: 200, right: 2000, bottom: 200 },
    ])
  })
})
