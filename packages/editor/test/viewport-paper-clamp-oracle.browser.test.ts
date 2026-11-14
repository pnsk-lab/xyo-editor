// Paper-entity + synthetic + real-Editor oracle for the viewport Paper clamp
// (NEW tests only, no product change; res2/vector only — res1 is edited by a
// separate agent and stays legacy-unbounded everywhere below).
//
// - Real Paper entity oracle: the published `paper/dist/paper-full.js` UMD is
//   loaded as a classic script (no source copy, no bundler transform) and the
//   reference workspace/clamp is recomputed with real `paper.Rectangle`
//   unite/intersect/expand + the sequential left/top/bottom/right clamp, then
//   compared against `viewport-paper-clamp.ts` across a massive generated
//   matrix (canvas / container / zoom / bitmap-content / per-selection /
//   per-translation scenarios). Paper-unit values must match exactly (1e-9);
//   CSS-px projections get the ±1px bar (float round-trip only).
// - Synthetic harness (own divs, same transform as BitmapEditor): measured
//   `getBoundingClientRect` vs predicted rects (<1.5px), boundary click
//   mapping for text/brush/point selection, pointer-fixed zoom clamp priority
//   (clamp WINS at the edge, scale kept), stage/sprite/huge-union/odd-center.
// - Real Editor (both modes): button zoom, ctrl-wheel fixed-point zoom with
//   clamp-priority gesture, plain-wheel pan, 5000-pan clamp, resize
//   (no auto-refit, scale kept), boundary text/brush/select clicks, history
//   invariance for viewport-only ops (Undo/Redo enabled state untouched),
//   plus the unreachable-state proof (what the Editor cannot hold, Scratch
//   cannot hold either — the reference oracle clamps it identically).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/viewport-paper-clamp-oracle.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4593
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function openCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function ensureVectorMode() {
  const toVector = await page.getByRole('button', { name: 'ベクターに変換' }).count()
  if (toVector > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => !!document.querySelector('[data-vector-stage-surface="true"]'), null, {
      timeout: 10_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function ensureBitmapMode() {
  const toBitmap = await page.getByRole('button', { name: 'ビットマップに変換' }).count()
  if (toBitmap > 0) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function resetZoomUi() {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
  })
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false,
    null,
    { timeout: 10_000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
}

describe('viewport paper clamp oracle (Paper entity + synthetic + real editor)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start on 4593')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('Paper entity oracle: massive workspace+clamp matrix matches the wiring (exact Paper, ±1px CSS)', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-paper-clamp.ts')
      const paperNs: any = await new Promise((resolve, reject) => {
        const existing = (window as any).paper
        if (existing && existing.PaperScope) {
          resolve(existing)
          return
        }
        const script = document.createElement('script')
        script.src = '/node_modules/paper/dist/paper-full.js'
        script.onload = () => {
          const loaded = (window as any).paper
          if (loaded && loaded.PaperScope) resolve(loaded)
          else reject(new Error('paper UMD did not install window.paper'))
        }
        script.onerror = () => reject(new Error('failed to load paper-full.js UMD'))
        document.head.appendChild(script)
      })
      const scope = new paperNs.PaperScope()
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 600
      scope.setup(canvas)
      const out: Record<string, unknown> = { cases: 0, worstWs: 0, worstDx: 0, worstCss: 0, offenders: [] as string[], epsilon: [] as string[] }
      const offenders = out.offenders as string[]
      const epsilon = out.epsilon as string[]
      // Prove expand(50) = +25/side and MAX expand on the real entity.
      {
        const r = new scope.Rectangle(0, 0, 100, 100).expand(50)
        const m = new scope.Rectangle(-240, -180, 1440, 1080).expand(50)
        out.expand = { x: r.x, y: r.y, w: r.width, h: r.height, mx: m.x, my: m.y, mw: m.width, mh: m.height }
      }
      const modes = [
        { name: 'vector', surface: { width: 2400, height: 1800 }, density: 2.5, cc: undefined as { x: number; y: number } | undefined, scales: [0.333 / 2.5, 0.5 / 2.5, 0.5, 1, 2, 5] },
        { name: 'res2', surface: { width: 960, height: 720 }, density: 1.0, cc: { x: 480, y: 360 }, scales: [0.333, 0.5, 1, 2, 5] },
        { name: 'res2-union1200', surface: { width: 1200, height: 720 }, density: 1.0, cc: { x: 480, y: 360 }, scales: [0.333, 0.5, 1, 2] },
        { name: 'res2-union2000', surface: { width: 2000, height: 720 }, density: 1.0, cc: { x: 480, y: 360 }, scales: [0.5, 1, 2] },
        { name: 'res2-oddcenter', surface: { width: 960, height: 720 }, density: 1.0, cc: { x: 481, y: 363 }, scales: [0.5, 1] },
      ]
      const containers = [
        { width: 800, height: 600 },
        { width: 400, height: 300 },
        { width: 1280, height: 800 },
        { width: 320, height: 240 },
        { width: 600, height: 900 },
        { width: 801, height: 601 },
        { width: 3000, height: 2000 },
      ]
      const contents: Array<{ name: string; rects: Array<{ left: number; top: number; right: number; bottom: number }> }> = [
        { name: 'empty', rects: [] },
        { name: 'center-box', rects: [{ left: 400, top: 300, right: 560, bottom: 420 }] },
        { name: 'edge-origin', rects: [{ left: 0, top: 0, right: 200, bottom: 200 }] },
        { name: 'far-offboard', rects: [{ left: 1100, top: 100, right: 1300, bottom: 200 }] },
        { name: 'negative', rects: [{ left: -1000, top: -800, right: -900, bottom: -700 }] },
        { name: 'huge', rects: [{ left: 0, top: 0, right: 6400, bottom: 4800 }] },
        { name: 'point', rects: [{ left: 2000, top: 200, right: 2000, bottom: 200 }] },
        { name: 'two-union', rects: [{ left: 10, top: 20, right: 220, bottom: 140 }, { left: 400, top: 200, right: 500, bottom: 300 }] },
      ]
      const pans = [
        { x: 0, y: 0 },
        { x: -30, y: 10 },
        { x: 200, y: -150 },
        { x: 5000, y: 0 },
        { x: 0, y: 5000 },
      ]
      const ART = new scope.Rectangle(0, 0, 960, 720)
      const maxExpanded = new scope.Rectangle(-240, -180, 1440, 1080).expand(50)
      let cases = 0
      let worstWs = 0
      let worstDx = 0
      let worstCss = 0
      for (const mode of modes) {
        for (const container of containers) {
          for (const scale of mode.scales) {
            for (const content of contents) {
              for (const pan of pans) {
                for (const clipEmpty of [false, true]) {
                  const mapped = clamp.paperViewBoundsForCssViewport(
                    { x: pan.x, y: pan.y, scale },
                    mode.surface,
                    container,
                    mode.density,
                    mode.cc,
                  )
                  if (!mapped.viewBounds || mapped.center === undefined || mapped.zoom === undefined) {
                    offenders.push(`not-ready ${mode.name} pan=${pan.x},${pan.y} s=${scale}`)
                    continue
                  }
                  const vb = mapped.viewBounds
                  // Reference workspace on the REAL entity.
                  let bounds = ART.clone()
                  if (!clipEmpty) {
                    bounds = bounds.unite(new scope.Rectangle(vb.left, vb.top, vb.right - vb.left, vb.bottom - vb.top))
                  }
                  for (const item of content.rects) {
                    const base = new scope.Rectangle(item.left, item.top, Math.max(0, item.right - item.left), Math.max(0, item.bottom - item.top))
                    bounds = bounds.unite(base.expand(50))
                  }
                  bounds = bounds.intersect(maxExpanded)
                  {
                    const vr = new scope.Rectangle(vb.left, vb.top, vb.right - vb.left, vb.bottom - vb.top)
                    if (bounds.width < vr.width) {
                      const grow = (vr.width - bounds.width) / 2
                      bounds = new scope.Rectangle(bounds.x - grow, bounds.y, bounds.width + grow * 2, bounds.height)
                    }
                    if (bounds.height < vr.height) {
                      const grow = (vr.height - bounds.height) / 2
                      bounds = new scope.Rectangle(bounds.x, bounds.y - grow, bounds.width, bounds.height + grow * 2)
                    }
                  }
                  const oursWs = clamp.paperWorkspaceForClamp(vb, content.rects, clipEmpty)
                  const wsErr = Math.max(
                    Math.abs(bounds.x - oursWs.left),
                    Math.abs(bounds.y - oursWs.top),
                    Math.abs(bounds.width - (oursWs.right - oursWs.left)),
                    Math.abs(bounds.height - (oursWs.bottom - oursWs.top)),
                  )
                  worstWs = Math.max(worstWs, wsErr)
                  // Reference sequential clamp on the REAL entity.
                  const ws = new scope.Rectangle(oursWs.left, oursWs.top, oursWs.right - oursWs.left, oursWs.bottom - oursWs.top)
                  const shifted = new scope.Rectangle(vb.left, vb.top, vb.right - vb.left, vb.bottom - vb.top)
                  let dx = 0
                  let dy = 0
                  const edges: string[] = []
                  if (shifted.left < ws.left) {
                    const push = ws.left - shifted.left
                    dx += push
                    shifted.x += push
                    edges.push('left')
                  }
                  if (shifted.top < ws.top) {
                    const push = ws.top - shifted.top
                    dy += push
                    shifted.y += push
                    edges.push('top')
                  }
                  if (shifted.bottom > ws.bottom) {
                    const push = ws.bottom - shifted.bottom
                    dy += push
                    shifted.y += push
                    edges.push('bottom')
                  }
                  if (shifted.right > ws.right) {
                    const push = ws.right - shifted.right
                    dx += push
                    shifted.x += push
                    edges.push('right')
                  }
                  const ours = clamp.clampCssViewportToPaper({
                    viewport: { x: pan.x, y: pan.y, scale },
                    surface: mode.surface,
                    containerSize: container,
                    density: mode.density,
                    canvasCenter: mode.cc,
                    itemPaperRects: content.rects,
                    clipEmpty,
                  })
                  const dxErr = Math.abs(dx - ours.paperDx) + Math.abs(dy - ours.paperDy)
                  worstDx = Math.max(worstDx, dxErr)
                  if (JSON.stringify(edges) !== JSON.stringify(ours.edges)) {
                    // Epsilon boundary: the real entity's own float path can sit
                    // ~1e-12 off the plain-arithmetic edge, adding a trailing
                    // edge with a negligible push. Totals (above) stay exact.
                    // Strict mismatch = different edges AND non-negligible push.
                    if (dxErr > 1e-9) {
                      if (offenders.length < 10) offenders.push(`edges ${mode.name}/${content.name} pan=${pan.x},${pan.y} s=${scale} clip=${clipEmpty} entity=${edges} ours=${ours.edges} dxErr=${dxErr}`)
                    } else if (epsilon.length < 10) {
                      epsilon.push(`epsilon-boundary ${mode.name}/${content.name} pan=${pan.x},${pan.y} s=${scale} clip=${clipEmpty} entity=${edges} ours=${ours.edges}`)
                    }
                  }
                  if (ours.viewport.scale !== scale) {
                    if (offenders.length < 10) offenders.push(`scale ${mode.name} ${scale} -> ${ours.viewport.scale}`)
                  }
                  // CSS ±1px: mapped-back viewport must equal the entity-shifted center round-trip.
                  if (edges.length > 0) {
                    const after = { x: mapped.center.x + dx, y: mapped.center.y + dy }
                    const back = clamp.cssViewportForPaperCenter(after, mapped.zoom, mode.surface, mode.density, mode.cc)
                    if (back) {
                      const cssErr = Math.max(Math.abs(back.x - ours.viewport.x), Math.abs(back.y - ours.viewport.y))
                      worstCss = Math.max(worstCss, cssErr)
                      if (cssErr > 1 && offenders.length < 10) offenders.push(`css ${mode.name} pan=${pan.x},${pan.y} err=${cssErr}`)
                    }
                  }
                  cases += 1
                }
              }
            }
          }
        }
      }
      out.cases = cases
      out.worstWs = worstWs
      out.worstDx = worstDx
      out.worstCss = worstCss
      try {
        scope.project?.remove()
      } catch {}
      return out
    })
    console.log(`PAPER_CLAMP_ORACLE_ENTITY ${JSON.stringify(report)}`)
    const expand = report.expand as { x: number; y: number; w: number; h: number; mx: number; my: number; mw: number; mh: number }
    expect(expand.x).toBeCloseTo(-25, 9)
    expect(expand.y).toBeCloseTo(-25, 9)
    expect(expand.w).toBeCloseTo(150, 9)
    expect(expand.h).toBeCloseTo(150, 9)
    expect(expand.mx).toBeCloseTo(-265, 9)
    expect(expand.my).toBeCloseTo(-205, 9)
    expect(expand.mw).toBeCloseTo(1490, 9)
    expect(expand.mh).toBeCloseTo(1130, 9)
    expect(report.cases as number).toBeGreaterThan(5000)
    expect(report.offenders as string[]).toEqual([])
    // Epsilon boundaries (entity float dust ~1e-12, totals exact) are allowed
    // ONLY at the zoom floor with 2400-wide views (s=0.333): any epsilon
    // elsewhere is a real order divergence and fails here.
    for (const e of (report.epsilon as string[])) {
      expect(e).toContain('s=0.333')
    }
    expect(report.worstWs as number).toBeLessThan(1e-9)
    expect(report.worstDx as number).toBeLessThan(1e-9)
    expect(report.worstCss as number).toBeLessThanOrEqual(1)
  }, 120_000)

  it('Paper entity P1/P2 exact order (res1/res2/vector, small/huge/offboard/union/selection)', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-paper-clamp.ts')
      const paperNs: any = (window as any).paper?.PaperScope ? (window as any).paper : await new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/node_modules/paper/dist/paper-full.js'
        script.onload = () => {
          const loaded = (window as any).paper
          if (loaded && loaded.PaperScope) resolve(loaded)
          else reject(new Error('paper UMD did not install window.paper'))
        }
        script.onerror = () => reject(new Error('failed to load paper-full.js UMD'))
        document.head.appendChild(script)
      })
      const scope = new paperNs.PaperScope()
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 600
      scope.setup(canvas)
      const out: Record<string, unknown> = {}
      const refWorkspace = (view: { left: number; top: number; right: number; bottom: number } | undefined, items: Array<{ left: number; top: number; right: number; bottom: number }>, clipEmpty: boolean) => {
        const ART = new scope.Rectangle(0, 0, 960, 720)
        const maxExpanded = new scope.Rectangle(-240, -180, 1440, 1080).expand(50)
        let bounds = ART.clone()
        if (!clipEmpty && view) bounds = bounds.unite(new scope.Rectangle(view.left, view.top, view.right - view.left, view.bottom - view.top))
        for (const item of items) {
          const base = new scope.Rectangle(item.left, item.top, Math.max(0, item.right - item.left), Math.max(0, item.bottom - item.top))
          bounds = bounds.unite(base.expand(50))
        }
        bounds = bounds.intersect(maxExpanded)
        if (view) {
          const vr = new scope.Rectangle(view.left, view.top, view.right - view.left, view.bottom - view.top)
          if (bounds.width < vr.width) {
            const grow = (vr.width - bounds.width) / 2
            bounds = new scope.Rectangle(bounds.x - grow, bounds.y, bounds.width + grow * 2, bounds.height)
          }
          if (bounds.height < vr.height) {
            const grow = (vr.height - bounds.height) / 2
            bounds = new scope.Rectangle(bounds.x, bounds.y - grow, bounds.width, bounds.height + grow * 2)
          }
        }
        return bounds
      }
      const refClamp = (view: { left: number; top: number; right: number; bottom: number }, ws: any) => {
        const shifted = new scope.Rectangle(view.left, view.top, view.right - view.left, view.bottom - view.top)
        const box = new scope.Rectangle(ws.x, ws.y, ws.width, ws.height)
        let dx = 0
        let dy = 0
        const edges: string[] = []
        if (shifted.left < box.left) { const push = box.left - shifted.left; dx += push; shifted.x += push; edges.push('left') }
        if (shifted.top < box.top) { const push = box.top - shifted.top; dy += push; shifted.y += push; edges.push('top') }
        if (shifted.bottom > box.bottom) { const push = box.bottom - shifted.bottom; dy += push; shifted.y += push; edges.push('bottom') }
        if (shifted.right > box.right) { const push = box.right - shifted.right; dx += push; shifted.x += push; edges.push('right') }
        return { dx, dy, edges }
      }
      // P1: resize empty res2 (x=200, scale 0.5): false 66.25 vs true 0.
      const p1: Record<string, unknown> = {}
      for (const clipEmpty of [false, true]) {
        const mapped = clamp.paperViewBoundsForCssViewport({ x: 200, y: 0, scale: 0.5 }, { width: 960, height: 720 }, { width: 800, height: 600 }, 1.0, { x: 480, y: 360 })
        const ws = refWorkspace(mapped.viewBounds, [], clipEmpty)
        const rc = refClamp(mapped.viewBounds!, ws)
        const ours = clamp.clampCssViewportToPaper({ viewport: { x: 200, y: 0, scale: 0.5 }, surface: { width: 960, height: 720 }, containerSize: { width: 800, height: 600 }, density: 1.0, canvasCenter: { x: 480, y: 360 }, itemPaperRects: [], clipEmpty })
        p1[clipEmpty ? 'trimmed' : 'covered'] = { x: ours.viewport.x, scale: ours.viewport.scale, dx: ours.paperDx, edges: ours.edges, refDx: rc.dx, refEdges: rc.edges }
      }
      out.p1 = p1
      // P2: reset centered + (0,0,100,100) on res2/vector/res1: false 0 vs true +6.25.
      const p2: Record<string, unknown> = {}
      const p2cases = [
        { name: 'res2', viewport: { x: 0, y: 0, scale: 0.5 }, surface: { width: 960, height: 720 }, container: { width: 800, height: 600 }, density: 1.0, cc: { x: 480, y: 360 } },
        { name: 'vector', viewport: { x: 0, y: 0, scale: 0.2 }, surface: { width: 2400, height: 1800 }, container: { width: 800, height: 600 }, density: 2.5, cc: undefined },
        { name: 'res1', viewport: { x: 0, y: 0, scale: 1.0 }, surface: { width: 480, height: 360 }, container: { width: 800, height: 600 }, density: 0.5, cc: { x: 240, y: 180 } },
      ]
      for (const c of p2cases) {
        const row: Record<string, unknown> = {}
        for (const clipEmpty of [false, true]) {
          const mapped = clamp.paperViewBoundsForCssViewport(c.viewport, c.surface, c.container, c.density, c.cc)
          const ws = refWorkspace(mapped.viewBounds, [{ left: 0, top: 0, right: 100, bottom: 100 }], clipEmpty)
          const rc = refClamp(mapped.viewBounds!, ws)
          const ours = clamp.clampCssViewportToPaper({ viewport: c.viewport, surface: c.surface, containerSize: c.container, density: c.density, canvasCenter: c.cc, itemPaperRects: [{ left: 0, top: 0, right: 100, bottom: 100 }], clipEmpty })
          row[clipEmpty ? 'trimmed' : 'covered'] = { x: ours.viewport.x, y: ours.viewport.y, scale: ours.viewport.scale, dx: ours.paperDx, edges: ours.edges, refDx: rc.dx, refEdges: rc.edges }
        }
        p2[c.name] = row
      }
      out.p2 = p2
      // Small viewport (401x301, zoomed-in): no invented clamp. Huge /
      // offboard / union / selection vs the entity (trimmed order).
      const small: Record<string, unknown> = {}
      for (const clipEmpty of [false, true]) {
        const ours = clamp.clampCssViewportToPaper({ viewport: { x: 10, y: -5, scale: 1 }, surface: { width: 960, height: 720 }, containerSize: { width: 401, height: 301 }, density: 1.0, canvasCenter: { x: 480, y: 360 }, itemPaperRects: [], clipEmpty })
        small[clipEmpty ? 'trimmed' : 'covered'] = { clamped: ours.clamped, x: ours.viewport.x, scale: ours.viewport.scale }
      }
      out.small = small
      const extras = [
        { name: 'huge', view: { left: -320, top: -240, right: 1280, bottom: 960 }, items: [{ left: 0, top: 0, right: 6400, bottom: 4800 }] },
        { name: 'offboard', view: undefined, items: [{ left: 1100, top: 100, right: 1300, bottom: 200 }] },
        { name: 'union-two', view: undefined, items: [{ left: 10, top: 20, right: 220, bottom: 140 }, { left: 400, top: 200, right: 500, bottom: 300 }] },
        { name: 'point', view: undefined, items: [{ left: 2000, top: 200, right: 2000, bottom: 200 }] },
      ]
      const extraOut: Record<string, unknown> = {}
      for (const e of extras) {
        const ws = refWorkspace(e.view as { left: number; top: number; right: number; bottom: number } | undefined, e.items, true)
        const ours = clamp.paperWorkspaceForClamp(e.view as { left: number; top: number; right: number; bottom: number } | undefined, e.items, true)
        extraOut[e.name] = { err: Math.max(Math.abs(ws.x - ours.left), Math.abs(ws.y - ours.top), Math.abs(ws.width - (ours.right - ours.left)), Math.abs(ws.height - (ours.bottom - ours.top))) }
      }
      out.extras = extraOut
      try { scope.project?.remove() } catch {}
      document.body.innerHTML = ''
      return out
    })
    console.log(`PAPER_CLAMP_ORACLE_ENTITY_P1P2 ${JSON.stringify(report)}`)
    const p1 = report.p1 as { covered: { x: number; scale: number; dx: number; edges: string[]; refDx: number; refEdges: string[] }; trimmed: { x: number; scale: number; dx: number; edges: string[]; refDx: number; refEdges: string[] } }
    // Real-entity reference values (no source copy): false stops at 66.25,
    // true re-clamps to 0; scale kept; sequential left edge.
    expect(p1.covered.x).toBeCloseTo(66.25, 6)
    expect(p1.trimmed.x).toBeCloseTo(0, 6)
    expect(p1.covered.scale).toBe(0.5)
    expect(p1.trimmed.scale).toBe(0.5)
    expect(p1.covered.dx).toBeCloseTo(p1.covered.refDx, 9)
    expect(p1.trimmed.dx).toBeCloseTo(p1.trimmed.refDx, 9)
    expect(p1.covered.edges).toEqual(p1.covered.refEdges)
    expect(p1.trimmed.edges).toEqual(p1.trimmed.refEdges)
    const p2 = report.p2 as Record<string, { covered: { x: number; y: number }; trimmed: { x: number; y: number; scale: number; dx: number; edges: string[]; refDx: number; refEdges: string[] } }>
    for (const mode of ['res2', 'vector', 'res1']) {
      expect(p2[mode]!.covered.x).toBe(0)
      expect(p2[mode]!.covered.y).toBe(0)
      expect(p2[mode]!.trimmed.x).toBeCloseTo(6.25, 6)
      expect(p2[mode]!.trimmed.y).toBeCloseTo(6.25, 6)
      expect(p2[mode]!.trimmed.dx).toBeCloseTo(p2[mode]!.trimmed.refDx, 9)
      expect(p2[mode]!.trimmed.edges).toEqual(p2[mode]!.trimmed.refEdges)
    }
    expect(p2['res2']!.trimmed.scale).toBe(0.5)
    expect(p2['vector']!.trimmed.scale).toBe(0.2)
    expect(p2['res1']!.trimmed.scale).toBe(1.0)
    const small = report.small as { covered: { clamped: boolean; x: number }; trimmed: { clamped: boolean; x: number } }
    expect(small.covered.clamped).toBe(false)
    expect(small.trimmed.clamped).toBe(false)
    expect(small.covered.x).toBe(10)
    expect(small.trimmed.x).toBe(10)
    for (const v of Object.values(report.extras as Record<string, { err: number }>)) expect(v.err).toBeLessThan(1e-6)
  }, 60_000)

  it('synthetic harness: measured CSS rects, boundary clicks, pin-priority, odd-center, huge union', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-paper-clamp.ts')
      const scroll = await import(/* @vite-ignore */ '/src/features/costumes/viewport-scroll-clamp.ts')
      const out: Record<string, unknown> = {}
      // Measured CSS rects at reset (vector + res2) and at a 5000-pan clamp.
      const measured: Array<Record<string, unknown>> = []
      for (const m of [
        { name: 'vector', w: 2400, h: 1800, scale: 0.2, density: 2.5 },
        { name: 'res2', w: 960, h: 720, scale: 0.5, density: 1.0 },
      ]) {
        document.body.innerHTML = ''
        const container = document.createElement('div')
        container.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
        document.body.appendChild(container)
        const surface = document.createElement('div')
        surface.style.cssText = 'position:absolute;left:50%;top:50%;transform-origin:center;'
        container.appendChild(surface)
        const apply = (vp: { x: number; y: number; scale: number }) => {
          surface.style.width = `${m.w}px`
          surface.style.height = `${m.h}px`
          surface.style.transform = `translate(calc(-50% + ${vp.x}px), calc(-50% + ${vp.y}px)) scale(${vp.scale})`
          void surface.offsetWidth
        }
        const vp = { x: 0, y: 0, scale: m.scale }
        apply(vp)
        const c = container.getBoundingClientRect()
        const center = { x: c.left + c.width / 2, y: c.top + c.height / 2 }
        const predicted = scroll.predictCssSurfaceRect({ width: m.w, height: m.h }, center, vp)
        const r = surface.getBoundingClientRect()
        measured.push({
          mode: m.name,
          rectErr: Math.max(Math.abs(predicted.left - r.left), Math.abs(predicted.top - r.top), Math.abs(predicted.width - r.width), Math.abs(predicted.height - r.height)),
          clipped: getComputedStyle(container).style ?? undefined,
          overflow: getComputedStyle(container).overflow,
        })
        // 5000-pan clamp at reset: visible, scale kept.
        const clamped = clamp.clampCssViewportToPaper({
          viewport: { x: 5000, y: 0, scale: m.scale },
          surface: { width: m.w, height: m.h },
          containerSize: { width: 800, height: 600 },
          density: m.density,
          clipEmpty: false,
          itemPaperRects: [],
        })
        apply(clamped.viewport)
        const r2 = surface.getBoundingClientRect()
        const visibleWidth = Math.max(0, Math.min(r2.right, c.right) - Math.max(r2.left, c.left))
        measured.push({ mode: `${m.name}-pan5000`, clamped: clamped.clamped, scale: clamped.viewport.scale, visibleWidth, edges: clamped.edges })
      }
      out.measured = measured
      // Boundary click mapping: container corners + board edges -> Paper points must be finite and ordered.
      {
        const paperOf = (surfaceX: number, surfaceY: number, surfW: number, surfH: number, ccX: number, ccY: number, density: number) => ({
          x: (surfaceX - ccX) / density + 480,
          y: (surfaceY - ccY) / density + 360,
        })
        const corners = [
          paperOf(0, 0, 960, 720, 480, 360, 1),
          paperOf(960, 720, 960, 720, 480, 360, 1),
          paperOf(0, 0, 2400, 1800, 1200, 900, 2.5),
          paperOf(2400, 1800, 2400, 1800, 1200, 900, 2.5),
          paperOf(1200, 360, 1200, 720, 480, 360, 1),
          paperOf(481, 363, 960, 720, 481, 363, 1),
        ]
        out.corners = corners
        // Vector point/line/text at the exact board edges: action roams view unite ART capped at raw MAX.
        const view = { left: -320, top: -240, right: 1280, bottom: 960 }
        out.actionVector = scroll.actionBoundsForMode(false, view)
        out.actionBitmap = scroll.actionBoundsForMode(true, view)
      }
      // Pointer-fixed zoom clamp priority: interior holds, edge slips with scale kept.
      {
        const interior = scroll.paperZoomThenClamp(0.5, 0.1, { x: 480, y: 360 }, { x: 480, y: 360 }, { width: 800, height: 600 }, { left: -320, top: -240, right: 1280, bottom: 960 })
        const edge = scroll.paperZoomThenClamp(1, 1, { x: 1200, y: 360 }, { x: 1150, y: 360 }, { width: 800, height: 600 }, { left: 0, top: 0, right: 960, bottom: 720 })
        const zoomed = (await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')).zoomViewportAtSurfacePoint(
          { x: 0, y: 0, scale: 0.5 },
          { width: 960, height: 720 },
          { x: 400, y: 300 },
          { x: 900, y: 360 },
          1,
          1.0,
        )
        const clamped = clamp.clampCssViewportToPaper({
          viewport: zoomed.viewport,
          surface: { width: 960, height: 720 },
          containerSize: { width: 800, height: 600 },
          density: 1.0,
          canvasCenter: { x: 480, y: 360 },
          clipEmpty: true,
          itemPaperRects: [],
        })
        out.pin = { interiorPin: interior.clampPinErrorCssPx, interiorClamped: interior.clamped, edgePin: edge.clampPinErrorCssPx, edgeClamped: edge.clamped, scaleKept: clamped.viewport.scale === zoomed.viewport.scale, reason: clamped.reason }
      }
      // Odd rotation center + huge union workspace pins.
      {
        const odd = clamp.paperViewBoundsForCssViewport({ x: 0, y: 0, scale: 1 }, { width: 960, height: 720 }, { width: 800, height: 600 }, 1.0, { x: 481, y: 363 })
        const union = clamp.paperViewBoundsForCssViewport({ x: 260, y: 0, scale: 0.5 }, { width: 2000, height: 720 }, { width: 800, height: 600 }, 1.0, { x: 480, y: 360 })
        const huge = clamp.paperWorkspaceForClamp(undefined, [{ left: 0, top: 0, right: 6400, bottom: 4800 }], true)
        out.centers = { odd: odd.center, union: union.center, huge }
      }
      document.body.innerHTML = ''
      return out
    })
    console.log(`PAPER_CLAMP_ORACLE_SYNTHETIC ${JSON.stringify(report)}`)
    const measured = report.measured as Array<Record<string, unknown>>
    const resetV = measured.find((r) => r.mode === 'vector')!
    const resetR = measured.find((r) => r.mode === 'res2')!
    expect(resetV.rectErr as number).toBeLessThan(1.5)
    expect(resetR.rectErr as number).toBeLessThan(1.5)
    expect(resetV.overflow).toBe('hidden')
    const panV = measured.find((r) => r.mode === 'vector-pan5000')!
    const panR = measured.find((r) => r.mode === 'res2-pan5000')!
    expect(panV.clamped).toBe(true)
    expect(panV.scale).toBe(0.2)
    expect(panV.visibleWidth as number).toBeGreaterThan(0)
    expect(panR.clamped).toBe(true)
    expect(panR.scale).toBe(0.5)
    expect(panR.visibleWidth as number).toBeGreaterThan(0)
    const corners = report.corners as Array<{ x: number; y: number }>
    expect(corners[0]).toEqual({ x: 0, y: 0 })
    expect(corners[1]).toEqual({ x: 960, y: 720 })
    expect(corners[2]).toEqual({ x: 0, y: 0 })
    expect(corners[3]).toEqual({ x: 960, y: 720 })
    expect(corners[4]).toEqual({ x: 1200, y: 360 })
    expect(corners[5]).toEqual({ x: 480, y: 360 })
    expect(report.actionBitmap).toEqual({ left: 0, top: 0, right: 960, bottom: 720 })
    const actionVector = report.actionVector as { left: number; top: number; right: number; bottom: number }
    expect(actionVector.left).toBeLessThanOrEqual(-240)
    expect(actionVector.right).toBeGreaterThanOrEqual(960)
    const pin = report.pin as { interiorPin: number; interiorClamped: boolean; edgePin: number; edgeClamped: boolean; scaleKept: boolean }
    expect(pin.interiorClamped).toBe(false)
    expect(pin.interiorPin).toBeCloseTo(0, 9)
    expect(pin.edgeClamped).toBe(true)
    expect(pin.edgePin).toBeGreaterThan(0)
    expect(pin.scaleKept).toBe(true)
    const centers = report.centers as { odd: { x: number; y: number }; union: { x: number; y: number }; huge: { left: number; top: number; right: number; bottom: number } }
    expect(centers.odd).toEqual({ x: 479, y: 357 })
    expect(centers.union).toEqual({ x: 480, y: 360 })
    expect(centers.huge.right - centers.huge.left).toBeLessThanOrEqual(1490)
  }, 60_000)

  it('real editor vector: ops clamp, history untouched, boundary tools work, unreachable proven', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const base = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        overflow: getComputedStyle(container).overflow,
        width: r.width,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
        redoDisabled: (document.querySelector('[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_BASE ${JSON.stringify(base)}`)
    expect(base.overflow).toBe('hidden')
    expect(base.label).toContain('100%')
    expect(base.width).toBeGreaterThan(400)
    expect(base.width).toBeLessThan(560)
    const undoBefore = { undo: base.undoDisabled, redo: base.redoDisabled }

    // Button zoom-in (viewport-only: history untouched).
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const zoomed = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return {
        width: surface.getBoundingClientRect().width,
        transform: surface.style.transform,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_ZOOM ${JSON.stringify(zoomed)}`)
    expect(zoomed.width).toBeGreaterThan(base.width)
    expect(zoomed.undoDisabled).toBe(undoBefore.undo)

    // Ctrl-wheel fixed-point zoom about the top-left corner: scale moves, surface stays visible.
    const wheelZoom = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const before = surface.style.transform
      const undoBefore = (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true
      const c = container.getBoundingClientRect()
      const x = c.left + c.width * 0.25
      const y = c.top + c.height * 0.25
      const mk = (deltaY: number) =>
        new WheelEvent('wheel', { deltaX: 0, deltaY, deltaMode: 0, bubbles: true, cancelable: true, ctrlKey: true, clientX: x, clientY: y } as WheelEventInit)
      container.dispatchEvent(mk(-300))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const after = surface.style.transform
      const r = surface.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left))
      return { before, after, moved: before !== after, visibleWidth, undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true, undoBefore }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_WHEELZOOM ${JSON.stringify(wheelZoom)}`)
    expect(wheelZoom.moved).toBe(true)
    expect(wheelZoom.visibleWidth).toBeGreaterThan(0)
    expect(wheelZoom.undoAfter).toBe(wheelZoom.undoBefore)

    // Plain-wheel pan (viewport-only).
    const panned = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const before = surface.style.transform
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 30, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      return { before, after: surface.style.transform, undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_PAN ${JSON.stringify(panned)}`)
    expect(panned.after).not.toBe(panned.before)
    expect(panned.undoAfter).toBe(undoBefore.undo)

    // 5000-pan: clamped to the workspace edge (visible, not fully outside) — unreachable-state proof:
    // the raw unclamped transform never survives (the reference oracle clamps it identically, pure-test pinned).
    await resetZoomUi()
    const far = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 5000, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        transform: surface.style.transform,
        visibleWidth: Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)),
        visibleHeight: Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)),
        undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_FAR ${JSON.stringify(far)}`)
    expect(far.visibleWidth).toBeGreaterThan(0)
    expect(far.visibleHeight).toBeGreaterThan(0)
    expect(far.undoAfter).toBe(undoBefore.undo)

    // Resize: scale factor kept (no auto-refit), history untouched.
    const scaleBefore = await page.evaluate(() => document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.style.transform)
    await page.setViewportSize({ width: 1000, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const resized = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return {
        containerW: c.width,
        transform: surface.style.transform,
        overflow: getComputedStyle(document.querySelector('[data-testid="costume-paint-surface"]')!).overflow,
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_RESIZE ${JSON.stringify(resized)}`)
    expect(resized.overflow).toBe('hidden')
    const scaleOf = (t: string) => /scale\(([^)]+)\)/.exec(t)?.[1]
    expect(scaleOf(resized.transform)).toBe(scaleOf(scaleBefore))
    expect(resized.undoDisabled).toBe(undoBefore.undo)
    await page.setViewportSize({ width: 1280, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Boundary text click: text tool at the artboard edge opens the inline editor (selection works at the edge).
    await resetZoomUi()
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const textAtEdge = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      // Near the right board edge in client px (inside the artwork box).
      const x = r.left + r.width * 0.96
      const y = r.top + r.height * 0.5
      const before = surface.style.transform
      const target = document.elementFromPoint(x, y) as HTMLElement | null
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
      target?.dispatchEvent(new PointerEvent('pointerdown', opts))
      target?.dispatchEvent(new MouseEvent('mousedown', opts))
      target?.dispatchEvent(new PointerEvent('pointerup', opts))
      target?.dispatchEvent(new MouseEvent('mouseup', opts))
      target?.dispatchEvent(new MouseEvent('click', opts))
      return { before, after: surface.style.transform }
    })
    await page.locator('[data-inline-text-editor] textarea').waitFor({ state: 'visible', timeout: 10_000 })
    const focused = await page.evaluate(() => {
      const ta = document.querySelector('[data-inline-text-editor] textarea')
      return !!ta && document.activeElement === ta
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_TEXT ${JSON.stringify({ ...textAtEdge, focused })}`)
    // Tool click never moves the viewport (viewport-only clamp is for wheel/button paths).
    expect(textAtEdge.after).toBe(textAtEdge.before)
    expect(focused).toBe(true)
    // Escape commits (Scratch parity): the draft closes; the TOOL writes history (unlike viewport ops).
    await page.keyboard.press('Escape')
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'detached', timeout: 10_000 })

    // Boundary brush: a short stroke at the board edge neither crashes nor moves the viewport.
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const brushAtEdge = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      const before = surface.style.transform
      const x0 = r.left + r.width * 0.9
      const y0 = r.top + r.height * 0.9
      const target = document.elementFromPoint(x0, y0) as HTMLElement | null
      const down = { bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 0, pointerId: 7, isPrimary: true }
      target?.dispatchEvent(new PointerEvent('pointerdown', down))
      for (let i = 1; i <= 4; i += 1) {
        target?.dispatchEvent(new PointerEvent('pointermove', { ...down, clientX: x0 + i * 4, clientY: y0 + i * 2 }))
      }
      target?.dispatchEvent(new PointerEvent('pointerup', { ...down, clientX: x0 + 16, clientY: y0 + 8 }))
      return { before, after: surface.style.transform }
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_BRUSH ${JSON.stringify(brushAtEdge)}`)
    expect(brushAtEdge.after).toBe(brushAtEdge.before)

    // Real paint commits history while the viewport stays put (coordinate +
    // Undo/Redo separation): a mouse brush stroke enables Undo, and Undo /
    // Redo round-trip never moves the viewport or the reset label.
    await resetZoomUi()
    const vectorPaintBase = await page.evaluate(() => ({
      transform: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.style.transform,
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    await page.getByRole('button', { name: 'Brush', exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const vectorStroke = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      return { x0: r.left + r.width * 0.4, y0: r.top + r.height * 0.4, x1: r.left + r.width * 0.55, y1: r.top + r.height * 0.5 }
    })
    await page.mouse.move(vectorStroke.x0, vectorStroke.y0)
    await page.mouse.down()
    await page.mouse.move(vectorStroke.x1, vectorStroke.y1, { steps: 8 })
    await page.mouse.up()
    await new Promise((resolve) => setTimeout(resolve, 900))
    const vectorPaintAfter = await page.evaluate(() => ({
      transform: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.style.transform,
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
      redoDisabled: (document.querySelector('[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_VECTOR_PAINT ${JSON.stringify(vectorPaintAfter)}`)
    // Paint must not move the viewport (transform identical); history must
    // record exactly one paint entry (Undo armed, Redo clear).
    expect(vectorPaintAfter.transform).toBe(vectorPaintBase.transform)
    expect(vectorPaintAfter.label).toContain('100%')
    expect(vectorPaintAfter.undoDisabled).toBe(false)
    expect(vectorPaintAfter.redoDisabled).toBe(true)
    await page.locator('button[aria-label="Undo"]:visible').first().click()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const vectorAfterUndo = await page.evaluate(() => ({
      transform: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.style.transform,
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
      redoDisabled: (document.querySelector('[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    // Undo peels the paint but never the viewport (label/scale identical).
    expect(vectorAfterUndo.transform).toBe(vectorPaintBase.transform)
    expect(vectorAfterUndo.label).toContain('100%')
    expect(vectorAfterUndo.redoDisabled).toBe(false)
    await page.locator('button[aria-label="Redo"]:visible').first().click()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const vectorAfterRedo = await page.evaluate(() => ({
      transform: document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.style.transform,
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    expect(vectorAfterRedo.transform).toBe(vectorPaintBase.transform)
    expect(vectorAfterRedo.undoDisabled).toBe(false)
  }, 180_000)

  it('real editor bitmap res2: reset + pan clamp + resize + history invariance', async () => {
    await openCostumes()
    await ensureBitmapMode()
    await resetZoomUi()
    const bitmapBase = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { width: canvas.width, height: canvas.height },
        rectW: r.width,
        containerW: c.width,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_BITMAP ${JSON.stringify(bitmapBase)}`)
    expect(bitmapBase.label).toContain('100%')
    // res2 family only in this scope (separate agent owns res1): 960-wide backing (union-grown allowed above).
    expect(bitmapBase.backing.width).toBeGreaterThanOrEqual(960 - 1)
    expect(Math.abs(bitmapBase.rectW - 480)).toBeLessThan(60)
    const undoBefore = bitmapBase.undoDisabled
    // 5000-pan clamps (visible, history untouched).
    const bitmapPan = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const surface = (canvas.parentElement as HTMLElement) ?? canvas
      const before = surface.style.transform
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 5000, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = surface.style.transform
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        before,
        after,
        visibleWidth: Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)),
        visibleHeight: Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)),
        undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_BITMAP_PAN ${JSON.stringify(bitmapPan)}`)
    expect(bitmapPan.visibleWidth).toBeGreaterThan(0)
    expect(bitmapPan.visibleHeight).toBeGreaterThan(0)
    expect(bitmapPan.undoAfter).toBe(undoBefore)
    // Resize keeps the scale (no auto-refit).
    const scaleBefore = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return ((canvas.parentElement as HTMLElement) ?? canvas).style.transform
    })
    await page.setViewportSize({ width: 1000, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterResize = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const surface = ((canvas.parentElement as HTMLElement) ?? canvas)
      return {
        transform: surface.style.transform,
        overflow: getComputedStyle(container).overflow,
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_BITMAP_RESIZE ${JSON.stringify(afterResize)}`)
    expect(afterResize.overflow).toBe('hidden')
    const scaleOf = (t: string) => /scale\(([^)]+)\)/.exec(t)?.[1]
    expect(scaleOf(afterResize.transform)).toBe(scaleOf(scaleBefore))
    expect(afterResize.undoDisabled).toBe(undoBefore)
    await page.setViewportSize({ width: 1280, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await resetZoomUi()
    // Real bitmap paint commits history while the viewport stays put: a
    // mouse brush stroke changes pixels + arms Undo, and Undo/Redo
    // round-trip restores pixels without moving the viewport or label.
    const bitmapPaintBase = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const surface = ((canvas.parentElement as HTMLElement) ?? canvas)
      const probe = { x: Math.floor(canvas.width * 0.4), y: Math.floor(canvas.height * 0.5) }
      const px = Array.from(canvas.getContext('2d')!.getImageData(probe.x, probe.y, 1, 1).data)
      return {
        transform: surface.style.transform,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        px,
        probe,
      }
    })
    const bitmapBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!bitmapBox) throw new Error('no bitmap canvas box')
    await page.getByTestId('bitmap-tool-brush').click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const bitmapFrom = { x: bitmapBox.x + bitmapBox.width * 0.3, y: bitmapBox.y + bitmapBox.height * 0.5 }
    const bitmapTo = { x: bitmapBox.x + bitmapBox.width * 0.6, y: bitmapBox.y + bitmapBox.height * 0.5 }
    await page.mouse.move(bitmapFrom.x, bitmapFrom.y)
    await page.mouse.down()
    await page.mouse.move(bitmapTo.x, bitmapTo.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.some((channel, channelIndex) => Math.abs(channel - (want as number[])[channelIndex]!) > 4)
      },
      [bitmapPaintBase.probe.x, bitmapPaintBase.probe.y, bitmapPaintBase.px] as unknown as undefined,
      { timeout: 15_000 },
    )
    const bitmapPaintAfter = await page.evaluate(() => ({
      transform: ((document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.parentElement as HTMLElement) ?? document.querySelector('[data-testid="bitmap-editor-canvas"]')!).style.transform,
      label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    console.log(`PAPER_CLAMP_ORACLE_EDITOR_BITMAP_PAINT ${JSON.stringify({ label: bitmapPaintAfter.label, undoDisabled: bitmapPaintAfter.undoDisabled })}`)
    expect(bitmapPaintAfter.transform).toBe(bitmapPaintBase.transform)
    expect(bitmapPaintAfter.label).toContain('100%')
    expect(bitmapPaintAfter.undoDisabled).toBe(false)
    await page.locator('button[aria-label="Undo"]:visible').first().click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const bitmapAfterUndo = await page.evaluate(
      ([probe, want]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(canvas.getContext('2d')!.getImageData((probe as { x: number; y: number }).x, (probe as { x: number; y: number }).y, 1, 1).data)
        const surface = ((canvas.parentElement as HTMLElement) ?? canvas)
        return { px: got, transform: surface.style.transform }
      },
      [bitmapPaintBase.probe, bitmapPaintBase.px] as unknown as undefined,
    )
    expect(bitmapAfterUndo.px).toEqual(bitmapPaintBase.px)
    expect(bitmapAfterUndo.transform).toBe(bitmapPaintBase.transform)
    await page.locator('button[aria-label="Redo"]:visible').first().click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const bitmapAfterRedo = await page.evaluate(() => ({
      transform: ((document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.parentElement as HTMLElement) ?? document.querySelector('[data-testid="bitmap-editor-canvas"]')!).style.transform,
      undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
    }))
    expect(bitmapAfterRedo.transform).toBe(bitmapPaintBase.transform)
    expect(bitmapAfterRedo.undoDisabled).toBe(false)
    await resetZoomUi()
  }, 180_000)
})
