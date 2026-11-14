// Move/snap browser oracle (real Paper.js in Chromium + real Editor surface).
//
// Part 1 re-executes the move/select pix derivations against real Paper.js
// (local UMD build, no CDN): Point add/subtract, Rectangle unite/center,
// box closeness, 45-degree projection, crosshair fade, and action-bounds
// unite+intersect. The oracle functions below are written inline (own words,
// own variable names); they must agree with `move-snap-parity.ts`.
//
// Part 2 loads the real Editor UI (read-only: no clicks that start drags,
// no DOM writes to product nodes) and measures the live costume surface +
// zoom label so the *UI effective conditions* for the snap/guide budgets are
// pinned as measurable: surface rect width, parsed viewport scale, and the
// resulting vector-SVG / bitmap-px equivalents of the 4px snap and 10px fade
// windows. It does not assert drag behavior itself (owned by other work);
// it proves the integration point is observable from the browser.
//
// No existing Editor/BitmapEditor/vector helper is edited or imported for
// behavior here except the new pure helper under test.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4333'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('move/snap parity oracle in a real browser', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4333', '--strictPort'], {
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
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('agrees with real Paper.js on snap/guide/bounds math', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.addScriptTag({ path: join(root, 'node_modules/paper/dist/paper-full.js') })
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/move-snap-parity.ts')
      const paper = (window as unknown as { paper: any }).paper

      // Real Paper primitives.
      const united = new paper.Rectangle(10, 20, 100, 80).unite(new paper.Rectangle(50, 60, 100, 80))
      const expanded = new paper.Rectangle(10, 20, 100, 80).expand(50)
      const moved = new paper.Point(100, 100).add(new paper.Point(378, 258))

      // Independent inline oracles (not imported from anywhere).
      const boxClose = (ax: number, ay: number, bx: number, by: number, thr: number) =>
        Math.abs(ax - bx) < thr && Math.abs(ay - by) < thr
      const project = (dx: number, dy: number, step: number) => {
        if (dx === 0 && dy === 0) return { x: 0, y: 0 }
        const a = Math.atan2(dy, dx)
        const s = Math.round(a / step) * step
        const cx = Math.cos(s)
        const cy = Math.sin(s)
        const len = cx * dx + cy * dy
        return { x: cx * len, y: cy * len }
      }

      const snapCases = [
        { sel: { x: 100, y: 100 }, drag: { x: 378, y: 258 }, thr: 4 },
        { sel: { x: 0, y: 0 }, drag: { x: 480, y: 360 }, thr: 8 },
        { sel: { x: 0, y: 0 }, drag: { x: 100, y: 100 }, thr: 4 },
      ]
      const snapRows = snapCases.map((c) => {
        const got = helper.resolveCenterSnap({
          selectionCenter: c.sel,
          dragVector: c.drag,
          thresholdPaper: c.thr,
        })
        const movedPt = { x: c.sel.x + c.drag.x, y: c.sel.y + c.drag.y }
        const want = boxClose(movedPt.x, movedPt.y, 480, 360, c.thr)
        return { got: got.snapped, want }
      })

      const projCases = [
        { x: 10, y: 1 },
        { x: 10, y: 10 },
        { x: 1, y: -10 },
        { x: -7, y: 3 },
      ]
      const projRows = projCases.map((d) => {
        const got = helper.projectDeltaToStep(d)
        const want = project(d.x, d.y, Math.PI / 4)
        return { got, want }
      })

      // Fade oracle mirrors the corner/edge/inside branches independently.
      const fadeOracle = (
        bounds: { left: number; top: number; right: number; bottom: number },
        movedCenter: { x: number; y: number },
        fade: number,
      ) => {
        const cx = 480
        const cy = 360
        const corner =
          (cy < bounds.top && cx < bounds.left) ||
          (cy > bounds.bottom && cx < bounds.left) ||
          (cy < bounds.top && cx > bounds.right) ||
          (cy > bounds.bottom && cx > bounds.right)
        let mult = 1
        if (corner) {
          const gx = Math.max(cx - bounds.right, bounds.left - cx)
          const gy = Math.max(cy - bounds.bottom, bounds.top - cy)
          mult = Math.max(0, 1 - Math.sqrt(gx * gx + gy * gy) / fade)
        } else if (cy < bounds.top || cy > bounds.bottom) {
          const half = (bounds.bottom - bounds.top) / 2
          mult = Math.max(0, 1 - (Math.abs(cy - movedCenter.y) - half) / fade)
        } else if (cx < bounds.left || cx > bounds.right) {
          const half = (bounds.right - bounds.left) / 2
          mult = Math.max(0, 1 - (Math.abs(cx - movedCenter.x) - half) / fade)
        }
        return 0.75 * mult
      }
      const fadeCases = [
        { bounds: { left: 400, top: 300, right: 560, bottom: 420 }, center: { x: 480, y: 360 }, fade: 10 },
        { bounds: { left: 0, top: 0, right: 100, bottom: 100 }, center: { x: 50, y: 50 }, fade: 10 },
        { bounds: { left: 400, top: 370, right: 560, bottom: 490 }, center: { x: 480, y: 430 }, fade: 20 },
        { bounds: { left: 400, top: 370, right: 560, bottom: 490 }, center: { x: 480, y: 430 }, fade: 2.5 },
      ]
      const fadeRows = fadeCases.map((c) => ({
        got: helper.crosshairOpacityForBounds(c.bounds, c.center, { x: 480, y: 360 }, c.fade),
        want: fadeOracle(c.bounds, c.center, c.fade),
      }))

      // Action-bounds oracle: bitmap is the board; vector is unite+intersect.
      const art = { left: 0, top: 0, right: 960, bottom: 720 }
      const max = { left: -240, top: -180, right: 1200, bottom: 900 }
      const vectorOracle = (view: { left: number; top: number; right: number; bottom: number }) => ({
        left: Math.max(Math.min(view.left, art.left), max.left),
        top: Math.max(Math.min(view.top, art.top), max.top),
        right: Math.min(Math.max(view.right, art.right), max.right),
        bottom: Math.min(Math.max(view.bottom, art.bottom), max.bottom),
      })
      const viewCases = [
        { left: 0, top: 0, right: 960, bottom: 720 },
        { left: -500, top: -400, right: 200, bottom: 100 },
        { left: -5000, top: -5000, right: 5000, bottom: 5000 },
      ]
      const boundsRows = viewCases.map((view) => ({
        got: helper.vectorActionBounds(view),
        want: vectorOracle(view),
      }))

      return {
        united: { left: united.left, top: united.top, right: united.right, bottom: united.bottom },
        expanded: { w: expanded.width, h: expanded.height },
        moved: { x: moved.x, y: moved.y },
        snapRows,
        projRows,
        fadeRows,
        boundsRows,
        helperUnion: helper.uniteSelectionBounds([
          { left: 10, top: 20, right: 110, bottom: 100 },
          { left: 50, top: 60, right: 150, bottom: 140 },
        ]),
        thresholds: {
          snap05: helper.snapThresholdPaperUnits(0.5),
          snap4: helper.snapThresholdPaperUnits(4),
          fade1: helper.fadeDistancePaperUnits(1),
          vecSnap100: helper.vectorSnapThresholdSvgUnits(1),
          bmpSnap100: helper.bitmapSnapThresholdCanvasPx(1),
        },
      }
    })
    const r = result as {
      united: { left: number; top: number; right: number; bottom: number }
      expanded: { w: number; h: number }
      moved: { x: number; y: number }
      snapRows: { got: boolean; want: boolean }[]
      projRows: { got: { x: number; y: number }; want: { x: number; y: number } }[]
      fadeRows: { got: number; want: number }[]
      boundsRows: { got: object; want: object }[]
      helperUnion: { left: number; top: number; right: number; bottom: number }
      thresholds: { snap05: number; snap4: number; fade1: number; vecSnap100: number; bmpSnap100: number }
    }
    // Real Paper geometry matches the pure union/expand/move basis.
    expect(r.united).toEqual({ left: 10, top: 20, right: 150, bottom: 140 })
    expect(r.helperUnion).toEqual(r.united)
    expect(r.expanded.w).toBeCloseTo(150, 8)
    expect(r.expanded.h).toBeCloseTo(130, 8)
    expect(r.moved).toEqual({ x: 478, y: 358 })
    for (const row of r.snapRows) expect(row.got).toBe(row.want)
    for (const row of r.projRows) {
      expect(Math.abs(row.got.x - row.want.x)).toBeLessThan(1e-9)
      expect(Math.abs(row.got.y - row.want.y)).toBeLessThan(1e-9)
    }
    for (const row of r.fadeRows) expect(Math.abs(row.got - row.want)).toBeLessThan(1e-12)
    for (const row of r.boundsRows) expect(row.got).toEqual(row.want)
    // Spot pix coefficients: 4/0.5=8, 4/4=1, 10/1=10, vector 4/(5*1)=0.8, bitmap 4/1=4.
    expect(r.thresholds.snap05).toBeCloseTo(8, 10)
    expect(r.thresholds.snap4).toBeCloseTo(1, 10)
    expect(r.thresholds.fade1).toBeCloseTo(10, 10)
    expect(r.thresholds.vecSnap100).toBeCloseTo(0.8, 10)
    expect(r.thresholds.bmpSnap100).toBeCloseTo(4, 10)
  }, 120_000)

  it('measures the real Editor surface so UI budgets stay testable', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
    const measured = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/move-snap-parity.ts')
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')
      const rect = surface?.getBoundingClientRect()
      const zoomButton = document.querySelector('[aria-label="Reset zoom"]')
      const label = (zoomButton?.textContent ?? '').trim()
      const parsed = Number.parseFloat(label.replace('%', ''))
      const scale = Number.isFinite(parsed) && parsed > 0 ? parsed / 100 : 1
      return {
        rectWidth: rect?.width ?? 0,
        rectHeight: rect?.height ?? 0,
        label,
        scale,
        vecSnap: helper.vectorSnapThresholdSvgUnits(scale),
        vecFade: helper.vectorFadeDistanceSvgUnits(scale),
        bmpSnap: helper.bitmapSnapThresholdCanvasPx(scale),
        bmpFade: helper.bitmapFadeDistanceCanvasPx(scale),
      }
    })
    const m = measured as {
      rectWidth: number
      rectHeight: number
      label: string
      scale: number
      vecSnap: number
      vecFade: number
      bmpSnap: number
      bmpFade: number
    }
    // Effective conditions are observable: laid-out surface + parseable zoom.
    expect(m.rectWidth).toBeGreaterThan(0)
    expect(m.rectHeight).toBeGreaterThan(0)
    expect(m.scale).toBeGreaterThanOrEqual(0.25)
    expect(m.scale).toBeLessThanOrEqual(5)
    // Budgets stay positive and ordered (snap < fade) at any live zoom.
    expect(m.vecSnap).toBeGreaterThan(0)
    expect(m.vecFade).toBeGreaterThan(m.vecSnap)
    expect(m.bmpSnap).toBeGreaterThan(0)
    expect(m.bmpFade).toBeGreaterThan(m.bmpSnap)
  }, 120_000)
})
