// Independent fixtures for the Paper workspace clamp wiring (no thresholds weakened).
//
// - Synthetic harness (own divs, same transform as BitmapEditor): per-mode
//   reset rects + 5000-pan clamp (vector/res2/res1-decided clamped to the
//   workspace edge, unknown legacy stays unbounded), resize 800x600->400x300
//   re-clamp (scale unchanged), large-viewport widen (no edge pin), P1/P2
//   exact-order pins (resize false 66.25 vs true 0; reset false 0 vs true
//   +6.25), boundary edges, and the res1 fork (both readings pinned).
// - Real Paper entity oracle (paper-core geometry, no source copy): the
//   reference workspace/clamp is recomputed with real `paper.Rectangle`
//   unite/intersect/expand (expand(50) proven +25/side) and the sequential
//   left/top/bottom/right clamp, then compared to the pure wiring. Uses the
//   live `paper/dist/paper-core` dependency as the entity, not vendored code.
// - Real editor (both modes): button zoom, ctrl-wheel fixed-point zoom,
//   plain-wheel pan, 5000-pan clamp, resize (no auto-refit), reset, history
//   invariance (Undo/Redo enabled state untouched: viewport-only), and the
//   overflow:hidden clip record (visible, DPR-independent CSS px).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/viewport-paper-clamp.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4570
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

describe('viewport paper clamp wiring (independent fixtures)', () => {
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
    if (!ready) throw new Error('Vite failed to start on 4570')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('synthetic harness: per-mode clamp, 5000-pan, resize, large viewport, res1 fork', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-paper-clamp.ts')
      const scroll = await import(/* @vite-ignore */ '/src/features/costumes/viewport-scroll-clamp.ts')
      const mk = (cw: number, ch: number) => {
        document.body.innerHTML = ''
        const container = document.createElement('div')
        container.style.cssText = `position:relative;width:${cw}px;height:${ch}px;overflow:hidden;margin:0;padding:0;`
        document.body.appendChild(container)
        const surface = document.createElement('div')
        surface.style.cssText = 'position:absolute;left:50%;top:50%;transform-origin:center;'
        container.appendChild(surface)
        return { container, surface }
      }
      const apply = (surface: HTMLElement, w: number, h: number, vp: { x: number; y: number; scale: number }) => {
        surface.style.width = `${w}px`
        surface.style.height = `${h}px`
        surface.style.transform = `translate(calc(-50% + ${vp.x}px), calc(-50% + ${vp.y}px)) scale(${vp.scale})`
        void surface.offsetWidth
      }
      const centerOf = (container: HTMLElement) => {
        const r = container.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }
      }
      const out: Record<string, unknown> = {}
      // Per-mode reset rects (formula holds <1.5px, overflow:hidden).
      // res1 uses the decided 0.5 density (res1-agent band protected);
      // unknown (no stored resolution) stays legacy (density undefined).
      const modes = [
        { name: 'vector', w: 2400, h: 1800, scale: 0.2, density: 2.5 as number | undefined, cc: undefined as { x: number; y: number } | undefined },
        { name: 'res2', w: 960, h: 720, scale: 0.5, density: 1.0 as number | undefined, cc: { x: 480, y: 360 } as { x: number; y: number } | undefined },
        { name: 'res1', w: 480, h: 360, scale: 1, density: 0.5 as number | undefined, cc: { x: 240, y: 180 } as { x: number; y: number } | undefined },
        { name: 'unknown', w: 480, h: 360, scale: 1, density: undefined as number | undefined, cc: undefined as { x: number; y: number } | undefined },
      ]
      const rows: Array<Record<string, unknown>> = []
      for (const m of modes) {
        const { container, surface } = mk(800, 600)
        const vp = { x: 0, y: 0, scale: m.scale }
        apply(surface, m.w, m.h, vp)
        const c = centerOf(container)
        const predicted = scroll.predictCssSurfaceRect({ width: m.w, height: m.h }, { x: c.x, y: c.y }, vp)
        const measured = surface.getBoundingClientRect()
        rows.push({
          mode: m.name,
          rectErr: Math.max(
            Math.abs(predicted.left - measured.left),
            Math.abs(predicted.top - measured.top),
            Math.abs(predicted.width - measured.width),
            Math.abs(predicted.height - measured.height),
          ),
          clipped: getComputedStyle(container).overflow === 'hidden',
        })
      }
      out.perMode = rows
      // 5000-pan: vector/res2/res1 clamp to the workspace edge (visible,
      // not fullyOutside) on the decided densities; unknown legacy stays
      // unbounded (fullyOutside, 現状維持).
      const panCases: Array<Record<string, unknown>> = []
      for (const m of modes) {
        const { container, surface } = mk(800, 600)
        const raw = { x: 5000, y: 0, scale: m.scale }
        const clamped = (clamp as typeof import('/src/features/costumes/viewport-paper-clamp.ts')).clampCssViewportToPaper({
          viewport: raw,
          surface: { width: m.w, height: m.h },
          containerSize: { width: 800, height: 600 },
          density: m.density,
          canvasCenter: m.cc,
          clipEmpty: false,
          itemPaperRects: [],
        })
        apply(surface, m.w, m.h, clamped.viewport)
        const c = centerOf(container)
        const measured = surface.getBoundingClientRect()
        const over = scroll.cssOutOfRangeAmount(
          { left: measured.left, top: measured.top, width: measured.width, height: measured.height },
          c.rect,
        )
        panCases.push({
          mode: m.name,
          clampedX: clamped.viewport.x,
          clamped: clamped.clamped,
          scale: clamped.viewport.scale,
          fullyOutside: over.fullyOutside,
          visibleRatio: over.visibleRatio,
          edges: clamped.edges,
        })
      }
      out.pan5000 = panCases
      // Resize: same vector viewport re-clamped 800x600 -> 400x300 (scale keeps).
      {
        const raw = { x: -30, y: 10, scale: 1 }
        const wide = clamp.clampCssViewportToPaper({
          viewport: raw,
          surface: { width: 2400, height: 1800 },
          containerSize: { width: 800, height: 600 },
          density: 2.5,
          clipEmpty: true,
          itemPaperRects: [],
        })
        const narrow = clamp.clampCssViewportToPaper({
          viewport: raw,
          surface: { width: 2400, height: 1800 },
          containerSize: { width: 400, height: 300 },
          density: 2.5,
          clipEmpty: true,
          itemPaperRects: [],
        })
        const { container, surface } = mk(400, 300)
        apply(surface, 2400, 1800, narrow.viewport)
        const measured = surface.getBoundingClientRect()
        const predicted = scroll.predictCssSurfaceRect(
          { width: 2400, height: 1800 },
          (() => {
            const r = container.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          })(),
          narrow.viewport,
        )
        out.resized = {
          wideX: wide.viewport.x,
          narrowX: narrow.viewport.x,
          scale: narrow.viewport.scale,
          rectErr: Math.max(Math.abs(predicted.left - measured.left), Math.abs(predicted.width - measured.width)),
        }
      }
      // Large viewport: 3000x2000 container at reset stays centered (widen).
      {
        const large = clamp.clampCssViewportToPaper({
          viewport: { x: 0, y: 0, scale: 0.2 },
          surface: { width: 2400, height: 1800 },
          containerSize: { width: 3000, height: 2000 },
          density: 2.5,
          clipEmpty: true,
          itemPaperRects: [],
        })
        out.large = { clamped: large.clamped, x: large.viewport.x, scale: large.viewport.scale }
      }
      // res1 fork stays pinned side-by-side (neither wins).
      out.res1fork = scroll.res1DensityReadings(480)
      // P1 resize empty (x=200, res2 reset): false 66.25 vs true 0 (live
      // resize wires true). P2 reset centered + (0,0,100,100): false 0 vs
      // true +6.25 (live reset wires true). Both keep the scale.
      {
        const p1Covered = clamp.clampCssViewportToPaper({
          viewport: { x: 200, y: 0, scale: 0.5 },
          surface: { width: 960, height: 720 },
          containerSize: { width: 800, height: 600 },
          density: 1.0,
          canvasCenter: { x: 480, y: 360 },
          clipEmpty: false,
          itemPaperRects: [],
        })
        const p1Trimmed = clamp.clampCssViewportToPaper({
          viewport: { x: 200, y: 0, scale: 0.5 },
          surface: { width: 960, height: 720 },
          containerSize: { width: 800, height: 600 },
          density: 1.0,
          canvasCenter: { x: 480, y: 360 },
          clipEmpty: true,
          itemPaperRects: [],
        })
        const p2Covered = clamp.clampCssViewportToPaper({
          viewport: { x: 0, y: 0, scale: 0.5 },
          surface: { width: 960, height: 720 },
          containerSize: { width: 800, height: 600 },
          density: 1.0,
          canvasCenter: { x: 480, y: 360 },
          clipEmpty: false,
          itemPaperRects: [{ left: 0, top: 0, right: 100, bottom: 100 }],
        })
        const p2Trimmed = clamp.clampCssViewportToPaper({
          viewport: { x: 0, y: 0, scale: 0.5 },
          surface: { width: 960, height: 720 },
          containerSize: { width: 800, height: 600 },
          density: 1.0,
          canvasCenter: { x: 480, y: 360 },
          clipEmpty: true,
          itemPaperRects: [{ left: 0, top: 0, right: 100, bottom: 100 }],
        })
        out.p1p2 = {
          p1CoveredX: p1Covered.viewport.x,
          p1TrimmedX: p1Trimmed.viewport.x,
          p1Scale: p1Trimmed.viewport.scale,
          p2CoveredX: p2Covered.viewport.x,
          p2TrimmedX: p2Trimmed.viewport.x,
          p2Scale: p2Trimmed.viewport.scale,
        }
      }
      // Boundary edges: each direction triggers its own edge first.
      out.boundary = {
        left: clamp.clampCssViewportToPaper({
          viewport: { x: 5000, y: 0, scale: 1 },
          surface: { width: 2400, height: 1800 },
          containerSize: { width: 800, height: 600 },
          density: 2.5,
          clipEmpty: false,
          itemPaperRects: [],
        }).edges,
        top: clamp.clampCssViewportToPaper({
          viewport: { x: 0, y: 5000, scale: 1 },
          surface: { width: 2400, height: 1800 },
          containerSize: { width: 800, height: 600 },
          density: 2.5,
          clipEmpty: false,
          itemPaperRects: [],
        }).edges,
      }
      document.body.innerHTML = ''
      return out
    })
    console.log(`PAPER_CLAMP_SYNTHETIC ${JSON.stringify(report)}`)
    const perMode = report.perMode as Array<{ mode: string; rectErr: number; clipped: boolean }>
    for (const row of perMode) {
      expect(row.rectErr).toBeLessThan(1.5)
      expect(row.clipped).toBe(true)
    }
    const pan = report.pan5000 as Array<{ mode: string; clampedX: number; clamped: boolean; scale: number; fullyOutside: boolean; visibleRatio: number }>
    const vector = pan.find((r) => r.mode === 'vector')!
    // Pan path (clipEmpty=false) stops at the MAX edge, not the center.
    expect(vector.clamped).toBe(true)
    expect(vector.clampedX).toBeCloseTo(66.25, 6)
    expect(vector.scale).toBe(0.2)
    expect(vector.fullyOutside).toBe(false)
    expect(vector.visibleRatio).toBe(1)
    const res2 = pan.find((r) => r.mode === 'res2')!
    expect(res2.clamped).toBe(true)
    expect(res2.scale).toBe(0.5)
    expect(res2.fullyOutside).toBe(false)
    expect(res2.visibleRatio).toBe(1)
    const res1 = pan.find((r) => r.mode === 'res1')!
    // Res1 decided density 0.5 (res1-agent band protected): clamps like
    // res2 (Paper zoom 0.5), never legacy-unbounded.
    expect(res1.clamped).toBe(true)
    expect(res1.scale).toBe(1)
    expect(res1.fullyOutside).toBe(false)
    expect(res1.visibleRatio).toBe(1)
    const unknown = pan.find((r) => r.mode === 'unknown')!
    // Unknown (no stored resolution) stays legacy: unbounded (現状維持, 明記).
    expect(unknown.clamped).toBe(false)
    expect(unknown.clampedX).toBe(5000)
    expect(unknown.fullyOutside).toBe(true)
    expect(unknown.visibleRatio).toBe(0)
    const p1p2 = report.p1p2 as { p1CoveredX: number; p1TrimmedX: number; p1Scale: number; p2CoveredX: number; p2TrimmedX: number; p2Scale: number }
    // Reference order (clipEmpty=true): P1 trims to 0, P2 pulls +6.25.
    expect(p1p2.p1CoveredX).toBeCloseTo(66.25, 6)
    expect(p1p2.p1TrimmedX).toBeCloseTo(0, 6)
    expect(p1p2.p1Scale).toBe(0.5)
    expect(p1p2.p2CoveredX).toBe(0)
    expect(p1p2.p2TrimmedX).toBeCloseTo(6.25, 6)
    expect(p1p2.p2Scale).toBe(0.5)
    const resized = report.resized as { scale: number; rectErr: number }
    expect(resized.scale).toBe(1)
    expect(resized.rectErr).toBeLessThan(1.5)
    const large = report.large as { clamped: boolean; x: number; scale: number }
    expect(large.clamped).toBe(false)
    expect(large.x).toBe(0)
    expect(large.scale).toBe(0.2)
    const fork = report.res1fork as { board: number; own: number }
    expect(fork.board).toBeCloseTo(0.5, 12)
    expect(fork.own).toBeCloseTo(1.0, 12)
    const boundary = report.boundary as { left: string[]; top: string[] }
    expect(boundary.left).toContain('left')
    expect(boundary.top).toContain('top')
  }, 60_000)

  it('real Paper entity oracle: paper-core Rectangle workspace+clamp matches the pure wiring', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-paper-clamp.ts')
      // Real Paper entity via the published UMD bundle (no source copy, no
      // bundler transform): load `paper/dist/paper-full.js` as a classic
      // script and drive `window.paper` geometry directly.
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
      const results: Array<Record<string, unknown>> = []
      // Prove expand(50): +25 per side on the real entity (no source copy).
      {
        const rect = new scope.Rectangle(0, 0, 100, 100)
        const expanded = rect.expand(50)
        results.push({
          case: 'expand50',
          left: expanded.x,
          top: expanded.y,
          width: expanded.width,
          height: expanded.height,
        })
      }
      const cases: Array<{ name: string; view?: { left: number; top: number; right: number; bottom: number }; items: Array<{ left: number; top: number; right: number; bottom: number }>; clipEmpty: boolean }> = [
        { name: 'empty-unclipped', view: undefined, items: [], clipEmpty: true },
        { name: 'view-wide', view: { left: -500, top: -400, right: 1400, bottom: 1100 }, items: [], clipEmpty: false },
        { name: 'item-far', view: undefined, items: [{ left: 1100, top: 100, right: 1300, bottom: 200 }], clipEmpty: true },
        { name: 'singular-line', view: undefined, items: [{ left: 2000, top: 200, right: 2000, bottom: 200 }], clipEmpty: true },
        { name: 'huge', view: undefined, items: [{ left: 0, top: 0, right: 6400, bottom: 4800 }], clipEmpty: true },
        { name: 'offboard-negative', view: undefined, items: [{ left: -1000, top: -800, right: -900, bottom: -700 }], clipEmpty: true },
      ]
      const ART = new scope.Rectangle(0, 0, 960, 720)
      // MAX expand(50): -265,-205,1490x1130 on the real entity.
      const maxExpanded = new scope.Rectangle(-240, -180, 1440, 1080).expand(50)
      for (const c of cases) {
        // Reference recomputed with the real entity only.
        let bounds: paper.Rectangle = ART.clone()
        if (!c.clipEmpty && c.view) {
          bounds = bounds.unite(new scope.Rectangle(c.view.left, c.view.top, c.view.right - c.view.left, c.view.bottom - c.view.top))
        }
        for (const item of c.items) {
          const w = item.right - item.left
          const h = item.bottom - item.top
          const base = new scope.Rectangle(item.left, item.top, Math.max(0, w), Math.max(0, h))
          // Singular (w/h 0): Paper unite keeps the point; expand(50) still
          // grows it to 50x50. Mirror that without branching on our helper.
          bounds = bounds.unite(base.expand(50))
        }
        bounds = bounds.intersect(maxExpanded)
        if (c.view) {
          const vb = new scope.Rectangle(c.view.left, c.view.top, c.view.right - c.view.left, c.view.bottom - c.view.top)
          if (bounds.width < vb.width) {
            const grow = (vb.width - bounds.width) / 2
            bounds = new scope.Rectangle(bounds.x - grow, bounds.y, bounds.width + grow * 2, bounds.height)
          }
          if (bounds.height < vb.height) {
            const grow = (vb.height - bounds.height) / 2
            bounds = new scope.Rectangle(bounds.x, bounds.y - grow, bounds.width, bounds.height + grow * 2)
          }
        }
        const viewRect = c.view ? { left: c.view.left, top: c.view.top, right: c.view.right, bottom: c.view.bottom } : undefined
        const ours = clamp.paperWorkspaceForClamp(viewRect, c.items, c.clipEmpty)
        const err = Math.max(Math.abs(bounds.x - ours.left), Math.abs(bounds.y - ours.top), Math.abs(bounds.width - (ours.right - ours.left)), Math.abs(bounds.height - (ours.bottom - ours.top)))
        // Sequential clamp order on the real entity vs our oracle.
        let clampErr = 0
        if (c.view) {
          const ws = new scope.Rectangle(ours.left, ours.top, ours.right - ours.left, ours.bottom - ours.top)
          const vb = new scope.Rectangle(c.view.left, c.view.top, c.view.right - c.view.left, c.view.bottom - c.view.top)
          let dx = 0
          let dy = 0
          const shifted = vb.clone()
          if (shifted.left < ws.left) {
            const push = ws.left - shifted.left
            dx += push
            shifted.x += push
          }
          if (shifted.top < ws.top) {
            const push = ws.top - shifted.top
            dy += push
            shifted.y += push
          }
          if (shifted.bottom > ws.bottom) {
            const push = ws.bottom - shifted.bottom
            dy += push
            shifted.y += push
          }
          if (shifted.right > ws.right) {
            const push = ws.right - shifted.right
            dx += push
            shifted.x += push
          }
          const oursClamp = (clamp as typeof import('/src/features/costumes/viewport-paper-clamp.ts')).clampCssViewportToPaper({
            viewport: { x: 0, y: 0, scale: 1 },
            surface: { width: 2400, height: 1800 },
            containerSize: { width: 800, height: 600 },
            density: 2.5,
            clipEmpty: c.clipEmpty,
            itemPaperRects: c.items,
          })
          void oursClamp
          // Compare the entity shift against our scroll oracle directly.
          const { clampViewToWorkspace } = await import(/* @vite-ignore */ '/src/features/costumes/viewport-scroll-clamp.ts')
          const oracle = clampViewToWorkspace(c.view, { left: ws.x, top: ws.y, right: ws.x + ws.width, bottom: ws.y + ws.height })
          clampErr = Math.abs(dx - oracle.dx) + Math.abs(dy - oracle.dy)
        }
        results.push({ case: c.name, wsErr: err, clampErr, maxExpanded: { x: maxExpanded.x, y: maxExpanded.y, w: maxExpanded.width, h: maxExpanded.height } })
      }
      try {
        scope.project?.remove()
      } catch {}
      return results
    })
    console.log(`PAPER_CLAMP_ENTITY ${JSON.stringify(report)}`)
    const expand = (report as Array<Record<string, unknown>>).find((r) => r.case === 'expand50')!
    // Real expand(50) = +25 per side (proven on the entity).
    expect(expand.left).toBeCloseTo(-25, 9)
    expect(expand.top).toBeCloseTo(-25, 9)
    expect(expand.width).toBeCloseTo(150, 9)
    expect(expand.height).toBeCloseTo(150, 9)
    for (const row of report as Array<{ case: string; wsErr?: number; clampErr?: number; maxExpanded?: { x: number; y: number; w: number; h: number } }>) {
      if (row.case === 'expand50') continue
      expect(row.wsErr ?? 999).toBeLessThan(1e-6)
      expect(row.clampErr ?? 999).toBeLessThan(1e-9)
      if (row.maxExpanded) {
        expect(row.maxExpanded.x).toBeCloseTo(-265, 9)
        expect(row.maxExpanded.y).toBeCloseTo(-205, 9)
        expect(row.maxExpanded.w).toBeCloseTo(1490, 9)
        expect(row.maxExpanded.h).toBeCloseTo(1130, 9)
      }
    }
  }, 60_000)

  it('real editor: vector/res2 operations keep history, clip pixels, and clamp the 5000-pan', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const vectorBase = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        overflow: getComputedStyle(container).overflow,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        transform: surface.style.transform,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
        redoDisabled: (document.querySelector('[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_VECTOR_BASE ${JSON.stringify(vectorBase)}`)
    expect(vectorBase.overflow).toBe('hidden')
    expect(vectorBase.label).toContain('100%')
    expect(vectorBase.rect.width).toBeGreaterThan(400)
    expect(vectorBase.rect.width).toBeLessThan(560)
    const undoBefore = { undo: vectorBase.undoDisabled, redo: vectorBase.redoDisabled }

    // Button zoom-in about the selection/artwork center (viewport-only).
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const zoomed = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      return {
        width: r.width,
        transform: surface.style.transform,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_VECTOR_ZOOM ${JSON.stringify(zoomed)}`)
    expect(zoomed.width).toBeGreaterThan(vectorBase.rect.width)
    expect(zoomed.label).not.toContain('100%')
    expect(zoomed.undoDisabled).toBe(undoBefore.undo)

    // Plain-wheel pan at the zoomed-in level (inside the board: exact pan).
    const panInside = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const before = surface.style.transform
      const undoBefore = (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 30, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = surface.style.transform
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left))
      return {
        before,
        after,
        moved: before !== after,
        visibleWidth,
        containerW: c.width,
        undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
        undoBefore,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_VECTOR_PAN ${JSON.stringify(panInside)}`)
    expect(panInside.moved).toBe(true)
    expect(panInside.visibleWidth).toBeGreaterThan(0)
    expect(panInside.undoAfter).toBe(panInside.undoBefore)

    // 5000-pan: clamped to the workspace edge (visible, not fully outside).
    await resetZoomUi()
    const panFar = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 5000, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left))
      const visibleHeight = Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top))
      return {
        transform: surface.style.transform,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        visibleWidth,
        visibleHeight,
        undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_VECTOR_FAR ${JSON.stringify(panFar)}`)
    expect(panFar.visibleWidth).toBeGreaterThan(0)
    expect(panFar.visibleHeight).toBeGreaterThan(0)

    // Resize: the container flexes, the scale stays (no auto-refit), history untouched.
    const scaleBeforeResize = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      return surface.style.transform
    })
    await page.setViewportSize({ width: 1000, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterResize = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const c = container.getBoundingClientRect()
      return {
        containerW: c.width,
        transform: surface.style.transform,
        overflow: getComputedStyle(container).overflow,
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_VECTOR_RESIZE ${JSON.stringify(afterResize)}`)
    expect(afterResize.containerW).toBeGreaterThan(50)
    expect(afterResize.overflow).toBe('hidden')
    // No auto-refit: the scale factor in the transform is unchanged.
    const scaleOf = (t: string) => /scale\(([^)]+)\)/.exec(t)?.[1]
    expect(scaleOf(afterResize.transform)).toBe(scaleOf(scaleBeforeResize))
    await page.setViewportSize({ width: 1280, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Bitmap res2: reset + pan clamp + history/clip invariance.
    await ensureBitmapMode()
    await resetZoomUi()
    const bitmapBase = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { width: canvas.width, height: canvas.height },
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        undoDisabled: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true,
      }
    })
    console.log(`PAPER_CLAMP_EDITOR_BITMAP ${JSON.stringify(bitmapBase)}`)
    expect(bitmapBase.label).toContain('100%')
    const backingW = bitmapBase.backing.width as number
    const res = backingW / 480 >= 1.5 ? 2 : 1
    const expectedW = res === 2 ? 480 : 480
    expect(Math.abs(bitmapBase.rect.width - expectedW)).toBeLessThan(60)
    const bitmapPan = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const surface = (canvas.parentElement as HTMLElement) ?? canvas
      const before = surface.style.transform
      const undoBefore = (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true
      container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 5000, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = surface.style.transform
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left))
      const visibleHeight = Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top))
      return { before, after, moved: before !== after, visibleWidth, visibleHeight, undoBefore, undoAfter: (document.querySelector('[aria-label="Undo"]') as HTMLButtonElement)?.disabled ?? true }
    })
    console.log(`PAPER_CLAMP_EDITOR_BITMAP_PAN ${JSON.stringify(bitmapPan)}`)
    expect(bitmapPan.moved).toBe(true)
    expect(bitmapPan.visibleWidth).toBeGreaterThan(0)
    expect(bitmapPan.visibleHeight).toBeGreaterThan(0)
    expect(bitmapPan.undoAfter).toBe(bitmapPan.undoBefore)
    await resetZoomUi()
  }, 180_000)
})
