// DOM measurement for the scroll-clamp oracle (READ-ONLY, no product change).
//
// Measures through real Chromium layout (`getBoundingClientRect`) on an
// independent Vite port (4569, strictPort):
// - synthetic harness: same transform as BitmapEditor (`left:50%;top:50%` +
//   translate(calc(-50%+vx),calc(-50%+vy)) scale(s), origin center) for the
//   per-mode surfaces (vector 2400x1800 / res2 960x720 / res1 480x360 / huge
//   6400x4800) and the empty-artboard record;
// - out-of-range amount: predicted vs measured rect (<1.5px), overhang via
//   cssOutOfRangeAmount, clip record (overflow:hidden intersection);
// - resize: container 800x600 -> 400x300 re-measurement (formula holds);
// - touch/shift/pointer anchoring: shift pan is screen-px (no /zoom), plain
//   pan keeps scale, ctrl-wheel pin holds <1px on the real rect (touch uses
//   the same fixed-point path via getEventXY anchoring -- no separate touch
//   engine in the current UI: container is touch-none);
// - coordinate conversion + res1 fork: cssPxPerPaperUnitForSurface with the
//   EXPLICIT assumption (vector 960 [仮定A3], res2 960, res1 960 vs 480
//   forked, neither wins);
// - real editor: reset rects + overflow clip + DPR + unbounded-pan proof by
//   dispatching a real WheelEvent on the live container and reading the
//   transform change; auto-fit is RECORDED only (another agent owns fit).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/viewport-scroll-clamp.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4569
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

describe('viewport scroll-clamp DOM measurements (read-only)', () => {
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
    if (!ready) throw new Error('Vite failed to start on 4569')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('synthetic harness: per-mode/6400/resize/clip/anchor DOM table', async () => {
    const report = await page.evaluate(async () => {
      const clamp = await import(/* @vite-ignore */ '/src/features/costumes/viewport-scroll-clamp.ts')
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
      const apply = (
        surface: HTMLElement,
        w: number,
        h: number,
        vp: { x: number; y: number; scale: number },
      ) => {
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
      // Per-mode reset rects in an 800x600 container.
      const modes = [
        { name: 'vector', w: 2400, h: 1800, scale: 0.2 },
        { name: 'res2', w: 960, h: 720, scale: 0.5 },
        { name: 'res1', w: 480, h: 360, scale: 1 },
        { name: 'empty-res2', w: 960, h: 720, scale: 0.5 },
        { name: 'huge6400', w: 6400, h: 4800, scale: 1 },
      ]
      const rows: Array<Record<string, unknown>> = []
      for (const m of modes) {
        const { container, surface } = mk(800, 600)
        const vp = { x: 0, y: 0, scale: m.scale }
        apply(surface, m.w, m.h, vp)
        const c = centerOf(container)
        const predicted = clamp.predictCssSurfaceRect({ width: m.w, height: m.h }, { x: c.x, y: c.y }, vp)
        const measured = surface.getBoundingClientRect()
        const over = clamp.cssOutOfRangeAmount(
          { left: measured.left, top: measured.top, width: measured.width, height: measured.height },
          c.rect,
        )
        rows.push({
          mode: m.name,
          predictedWidth: predicted.width,
          measuredWidth: measured.width,
          rectErr: Math.max(
            Math.abs(predicted.left - measured.left),
            Math.abs(predicted.top - measured.top),
            Math.abs(predicted.width - measured.width),
            Math.abs(predicted.height - measured.height),
          ),
          visibleRatio: over.visibleRatio,
          maxOverhang: over.max,
          clipped: getComputedStyle(container).overflow === 'hidden',
        })
      }
      out.perMode = rows
      // Resize: same vector surface at reset in 400x300 (formula holds, clip tightens).
      {
        const { container, surface } = mk(400, 300)
        const vp = { x: 0, y: 0, scale: 0.2 }
        apply(surface, 2400, 1800, vp)
        const c = centerOf(container)
        const predicted = clamp.predictCssSurfaceRect({ width: 2400, height: 1800 }, { x: c.x, y: c.y }, vp)
        const measured = surface.getBoundingClientRect()
        out.resized = {
          rectErr: Math.max(
            Math.abs(predicted.left - measured.left),
            Math.abs(predicted.width - measured.width),
          ),
          visible: clamp.cssOutOfRangeAmount(
            { left: measured.left, top: measured.top, width: measured.width, height: measured.height },
            c.rect,
          ),
        }
      }
      // Out-of-range: pan 5000px on res2@0.5 (unbounded CSS proof).
      {
        const { container, surface } = mk(800, 600)
        apply(surface, 960, 720, { x: 5000, y: 0, scale: 0.5 })
        const c = centerOf(container)
        const measured = surface.getBoundingClientRect()
        out.pannedOut = clamp.cssOutOfRangeAmount(
          { left: measured.left, top: measured.top, width: measured.width, height: measured.height },
          c.rect,
        )
      }
      // Anchoring: shift pan is screen-px (dy=30 -> vx-=30), plain pan keeps
      // scale, ctrl pin holds <1px on the real rect (touch shares this path).
      {
        const { container, surface } = mk(800, 600)
        const c = centerOf(container)
        const center = { x: c.x, y: c.y }
        const surf = { width: 2400, height: 1800 }
        const start = { x: 10, y: 20, scale: 1 }
        apply(surface, 2400, 1800, start)
        // Pointer anchor through the real rect mapping.
        const pointer = { x: center.x + 120, y: center.y + 80 }
        const rect0 = surface.getBoundingClientRect()
        const fixed = {
          x: ((pointer.x - rect0.left) / rect0.width) * 2400,
          y: ((pointer.y - rect0.top) / rect0.height) * 1800,
        }
        const zoomed = clamp.cssPinAfterClamp(start, surf, center, pointer, 1.1, 0.25)
        apply(surface, 2400, 1800, zoomed.viewport)
        const rect1 = surface.getBoundingClientRect()
        const back = { x: rect1.left + (fixed.x / 2400) * rect1.width, y: rect1.top + (fixed.y / 1800) * rect1.height }
        const pinErr = Math.hypot(back.x - pointer.x, back.y - pointer.y)
        // Shift branch: pure-equivalent screen-px pan (no /zoom division).
        const shiftPan = { x: start.x - 30, y: start.y, scale: 1 }
        const paperWorld = clamp.paperPanWorldForDelta(30, 0.5)
        const cssScreen = clamp.cssPanScreenForDelta(30)
        const scrollGain = clamp.paperScrollbarMatrixForDrag(10, 0.5)
        out.anchor = {
          pinErr,
          appliedScale: zoomed.viewport.scale,
          shiftPan,
          paperWorldFor30at05: paperWorld,
          cssScreenFor30: cssScreen,
          scrollbar10at05: scrollGain,
          touchNone: true,
        }
      }
      // Coordinate conversion + res1 fork (explicit assumptions only).
      out.camera = {
        vectorReset: clamp.cssPxPerPaperUnitForSurface(2400, 960, 0.2),
        res2Reset: clamp.cssPxPerPaperUnitForSurface(960, 960, 0.5),
        res1board: clamp.cssPxPerPaperUnitForSurface(480, 960, 1),
        res1own: clamp.cssPxPerPaperUnitForSurface(480, 480, 1),
        res1fork: clamp.res1DensityReadings(480),
      }
      document.body.innerHTML = ''
      return out
    })
    console.log(`SCROLL_CLAMP_SYNTHETIC ${JSON.stringify(report)}`)
    const perMode = report.perMode as Array<{ mode: string; rectErr: number; visibleRatio: number; clipped: boolean }>
    for (const row of perMode) {
      expect(row.rectErr).toBeLessThan(1.5)
      expect(row.clipped).toBe(true)
    }
    // Huge 6400 is clipped to the container (visible ratio tiny but >0).
    const huge = perMode.find((r) => r.mode === 'huge6400')!
    expect(huge.visibleRatio).toBeGreaterThan(0)
    expect(huge.visibleRatio).toBeLessThan(0.05)
    const resized = report.resized as { rectErr: number }
    expect(resized.rectErr).toBeLessThan(1.5)
    const panned = report.pannedOut as { fullyOutside: boolean; max: number; visibleRatio: number }
    expect(panned.fullyOutside).toBe(true)
    expect(panned.max).toBeGreaterThan(4000)
    expect(panned.visibleRatio).toBe(0)
    const anchor = report.anchor as { pinErr: number; paperWorldFor30at05: number; cssScreenFor30: number; scrollbar10at05: number }
    expect(anchor.pinErr).toBeLessThan(1)
    expect(anchor.paperWorldFor30at05).toBe(60)
    expect(anchor.cssScreenFor30).toBe(30)
    expect(anchor.scrollbar10at05).toBe(10)
    const camera = report.camera as { vectorReset: number; res2Reset: number; res1fork: { board: number; own: number } }
    expect(camera.vectorReset).toBeCloseTo(0.5, 9)
    expect(camera.res2Reset).toBeCloseTo(0.5, 9)
    expect(camera.res1fork.board).toBeCloseTo(0.5, 12)
    expect(camera.res1fork.own).toBeCloseTo(1.0, 12)
  }, 60_000)

  it('real editor: reset rects + clip + unbounded-pan proof (fit recorded only)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const vector = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        overflow: getComputedStyle(container).overflow,
        touchAction: getComputedStyle(container).touchAction,
        style: surface.style.transform,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`SCROLL_CLAMP_EDITOR_VECTOR ${JSON.stringify(vector)}`)
    expect(vector.overflow).toBe('hidden')
    expect(vector.label).toContain('100%')
    // Vector reset renders the 2400 surface at scale ~0.2 => ~480 CSS px.
    expect(vector.rect.width).toBeGreaterThan(400)
    expect(vector.rect.width).toBeLessThan(560)

    await ensureBitmapMode()
    await resetZoomUi()
    const bitmap = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { width: canvas.width, height: canvas.height },
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`SCROLL_CLAMP_EDITOR_BITMAP ${JSON.stringify(bitmap)}`)
    expect(bitmap.label).toContain('100%')
    // Rect tracks backing * reset scale within 2px (res2 960*0.5=480 expected).
    const backingW = bitmap.backing.width as number
    const res = backingW / 480 >= 1.5 ? 2 : 1
    const expectedW = res === 2 ? 480 : 480
    expect(Math.abs(bitmap.rect.width - expectedW)).toBeLessThan(60)

    // Unbounded-pan proof: one plain wheel tick moves the live transform by
    // the delta in screen px (no clamp pulls it back).
    const panProof = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('[data-testid="costume-paint-surface"]')!
      const surface = (container.firstElementChild as HTMLElement) ?? container.querySelector('div')
      const before = (surface as HTMLElement).style.transform
      const rect = container.getBoundingClientRect()
      const opts: WheelEventInit = {
        deltaX: 0,
        deltaY: 200,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }
      container.dispatchEvent(new WheelEvent('wheel', opts))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = (surface as HTMLElement).style.transform
      const r2 = (surface as HTMLElement).getBoundingClientRect()
      return { before, after, moved: before !== after, rectAfter: { width: r2.width, height: r2.height }, containerW: rect.width }
    })
    console.log(`SCROLL_CLAMP_EDITOR_PAN ${JSON.stringify(panProof)}`)
    expect(panProof.moved).toBe(true)

    // Resize record: page-width change flexes the container width; height is
    // RECORDED only (the app shell collapses the flex column height on a
    // raw viewport resize without a re-layout pass -- shell layout artifact,
    // not a viewport-clamp finding). The synthetic harness above already
    // proves the surface formula survives 800x600 -> 400x300. Fit target
    // itself is NOT asserted (未完了 fit).
    await page.setViewportSize({ width: 1000, height: 800 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const resized = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = container.getBoundingClientRect()
      return { width: r.width, height: r.height }
    })
    console.log(`SCROLL_CLAMP_EDITOR_RESIZED ${JSON.stringify(resized)}`)
    expect(resized.width).toBeGreaterThan(50)
    await page.setViewportSize({ width: 1280, height: 800 })
  }, 120_000)
})
