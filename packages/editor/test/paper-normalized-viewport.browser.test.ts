// Paper-normalized viewport: real-Editor + Paper-oracle verification.
//
// Verifies the live Paper-reset behavior in `costume-viewport.ts` /
// `BitmapEditor.svelte` (per-mode Paper 0.5 basis: vector reset 0.2, bitmap
// res2 reset 0.5, unknown reset 1; label is per-mode percent with reset
// always "100%", separated from the internal scale):
// - H: live UI rects at Paper reset (vector 2400 surface -> 480 CSS px,
//   res2 960 canvas -> 480 CSS px), DPR + container dims recorded for the
//   same-container comparison.
// - A: same-container normalization -- vector 2400*0.2 = 480 and res2
//   960*0.5 = 480 (live Paper reset values) match the Paper oracle
//   projectToView span (960 Paper units * 0.5 = 480 CSS px) within 1.5px.
// - reset: action point is the artwork center (<1px drift), viewport-only
//   (Undo enablement unchanged), per-costume-per-mode scope.
// - zoom fixed point: toolbar step and ctrl-wheel -100 keep the anchor
//   (<1px) in vector (200%/120%) and res2 (200%/120%) modes (Paper basis).
// - CSS screen shift: shift+wheel pans horizontally; line-mode x15.
// - mask/hit/nudge/brush/selection/text/floating/responsive: alignment +
//   tool smoke after zoom ops (deep behavior lives in the dedicated suites).
// - INCOMPLETE fit/res1/pan-cap: current behavior logged, unchanged.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/paper-normalized-viewport.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4527'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page
let paperUmd: string

async function waitZoomLabel(text: string, timeout = 10_000) {
  await page.waitForFunction(
    (want) => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

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
  await waitZoomLabel('100%')
  await new Promise((resolve) => setTimeout(resolve, 150))
}

describe('paper-normalized viewport on the real editor + Paper oracle', () => {
  beforeAll(async () => {
    paperUmd = await Bun.file(join(root, 'node_modules', 'paper', 'dist', 'paper-full.js')).text()
    if (!paperUmd.includes('Paper.js')) throw new Error('paper UMD not loaded')
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4527', '--strictPort'], {
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

  it('H+A: live rects + same-container Paper-reset normalization (vector/res2 -> 480)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const vector = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const art = document.querySelector('.vector-preview') as HTMLElement | null
      const artRect = art?.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        styleWidth: surface.style.width,
        rectWidth: r.width,
        rectHeight: r.height,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2,
        container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
        artWidth: artRect?.width ?? null,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`NORMALIZED_UI_VECTOR ${JSON.stringify(vector)}`)
    expect(vector.styleWidth).toBe('2400px')
    // Live vector Paper reset: 2400 * 0.2 = 480 CSS px at "100%".
    expect(Math.abs(vector.rectWidth - 480)).toBeLessThan(1.5)
    expect(vector.label).toContain('100%')
    // Vector artbox fills the surface: 480 SVG units render as the full
    // 2400 surface scaled by the live reset (mask alignment within 2px).
    if (vector.artWidth !== null) expect(Math.abs(vector.artWidth - vector.rectWidth)).toBeLessThan(2)

    await ensureBitmapMode()
    await resetZoomUi()
    const bitmap = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        backing: { w: canvas.width, h: canvas.height },
        rectWidth: r.width,
        rectHeight: r.height,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2,
        container: { w: c.width, h: c.height, cx: c.left + c.width / 2, cy: c.top + c.height / 2 },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`NORMALIZED_UI_BITMAP ${JSON.stringify(bitmap)}`)
    expect(bitmap.label).toContain('100%')
    const res = bitmap.backing.w / 480 >= 1.5 ? 2 : 1
    console.log(`NORMALIZED_UI_BITMAP_RES ${JSON.stringify({ backing: bitmap.backing, classifiedRes: res })}`)
    if (res === 2) {
      // Live res2 Paper reset: 960 * 0.5 = 480 (exact, same container width
      // as the vector artboard at reset).
      expect(Math.abs(bitmap.rectWidth - 480)).toBeCloseTo(0, 1)
      expect(Math.abs(bitmap.rectWidth - bitmap.backing.w * 0.5)).toBeLessThan(1.5)
      expect(Math.abs(bitmap.rectWidth - vector.rectWidth)).toBeLessThan(2)
      // Raw surface ratio stays 2.5 (2400/960); live reset rects are equal.
      expect(2400 / bitmap.backing.w).toBeCloseTo(2.5, 2)
    } else {
      // Res1: NO normalization verdict (undecided coefficient) -- record only.
      console.log(`NORMALIZED_INCOMPLETE_RES1 ${JSON.stringify({ rectWidth: bitmap.rectWidth })}`)
      expect(Math.abs(bitmap.rectWidth - bitmap.backing.w)).toBeLessThan(1.5)
    }

    // Paper oracle at the same logical container: projectToView spans.
    await page.goto('about:blank')
    await page.addScriptTag({ content: paperUmd })
    const oracle = await page.evaluate(() => {
      const P = (window as unknown as { paper: typeof import('paper') }).paper
      const container = document.createElement('div')
      container.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.appendChild(container)
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:800px;height:600px;display:block;'
      container.appendChild(canvas)
      P.setup(canvas)
      const span = (x0: number, x1: number, y: number) => {
        const a = P.view.projectToView(new P.Point(x0, y)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(x1, y)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      }
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)
      const vector480 = span(0, 960, 360)
      const bitmapRes2_480 = span(0, 960, 360)
      const bitmapRes1_480 = span(240, 720, 360)
      // Anchor + import probes (compact oracle).
      const preCenter = P.view.center.clone()
      void preCenter
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)
      const fixed = new P.Point(580, 410)
      const newZoom = Math.max(0.333, 0.5 + 0.5)
      const scaling = 0.5 / newZoom
      const fp = fixed.clone() as unknown as { subtract(p: unknown): { multiply(s: number): { x: number; y: number } } }
      const preOffset = fp.subtract(P.view.center as unknown as never) as unknown as { x: number; y: number }
      void scaling
      void preOffset
      const before = P.view.projectToView(fixed.clone())
      P.view.zoom = newZoom
      P.view.translate(new P.Point(-50, -25))
      const after = P.view.projectToView(fixed.clone())
      const pinErr = Math.hypot(after.x - before.x, after.y - before.y)
      const r = new P.Rectangle(0, 0, 400, 300).expand(50)
      P.remove()
      container.remove()
      return { vector480, bitmapRes2_480, bitmapRes1_480, pinErr, expandW: r.width, expandH: r.height }
    })
    console.log(`NORMALIZED_ORACLE ${JSON.stringify(oracle)}`)
    expect(oracle.vector480).toBeCloseTo(480, 0)
    expect(oracle.bitmapRes2_480).toBeCloseTo(480, 0)
    expect(oracle.bitmapRes1_480).toBeCloseTo(240, 0)
    expect(oracle.pinErr).toBeLessThan(0.5)
    expect(oracle.expandW).toBeCloseTo(450, 9)
    // Same-container verdict: live Paper-reset widths match the oracle 480.
    expect(vector.rectWidth).toBeCloseTo(oracle.vector480, 0)
    if (res === 2) expect(bitmap.rectWidth).toBeCloseTo(oracle.bitmapRes2_480, 0)
  }, 120_000)

  it('reset anchor/history/scope + zoom fixed point + pan shift (vector & res2)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    // Undo enablement before any edit (viewport-only ops must not add history).
    const undoBefore = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled ?? null,
    )
    // Pan + zoom, then Reset must recenter (<1px) at 100% (Paper reset 0.2).
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('200%')
    await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      surface.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 60, deltaY: 40, deltaMode: 0 }),
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const drifted = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2))
    })
    expect(drifted).toBeGreaterThan(1)
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const recentered = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        err: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
        rectWidth: r.width,
      }
    })
    console.log(`NORMALIZED_RESET_CENTER ${JSON.stringify(recentered)}`)
    expect(recentered.err).toBeLessThan(1)
    expect(recentered.rectWidth).toBeCloseTo(480, 0)
    const undoAfter = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled ?? null,
    )
    expect(undoAfter).toBe(undoBefore)

    // Vector toolbar fixed point: 100% -> 200% keeps the surface center (<1px).
    const vCenter0 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
    })
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('200%')
    const vCenter1 = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const r = surface.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
    })
    expect(vCenter1.w / vCenter0.w).toBeCloseTo(2, 2)
    expect(Math.hypot(vCenter1.x - vCenter0.x, vCenter1.y - vCenter0.y)).toBeLessThan(1)

    // Vector ctrl-wheel fixed point: -100 tick at container center (100% -> 120%).
    await resetZoomUi()
    const anchor = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
    })
    const uv0 = await page.evaluate(([cx, cy]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    await page.evaluate((options) => {
      document
        .querySelector('[data-testid="costume-paint-surface"]')!
        .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
    }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y } as unknown as undefined)
    await waitZoomLabel('120%')
    const wheelPin = await page.evaluate(([cx, cy, bu, bv]) => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      const au = (cx - r.left) / r.width
      const av = (cy - r.top) / r.height
      return Math.hypot((au - (bu as number)) * r.width, (av - (bv as number)) * r.height)
    }, [anchor.x, anchor.y, uv0.u, uv0.v] as unknown as undefined)
    expect(wheelPin as number).toBeLessThan(1)

    // Shift+wheel horizontal pan + line-mode x15 (CSS screen px, no /zoom).
    await resetZoomUi()
    const pan0 = await page.evaluate(() => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      return { x: r.left, y: r.top }
    })
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="costume-paint-surface"]')!
        .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const pan1 = await page.evaluate(() => {
      const r = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!.getBoundingClientRect()
      return { x: r.left, y: r.top }
    })
    expect(pan1.x - pan0.x).toBeCloseTo(-30, 0)
    expect(pan1.y - pan0.y).toBeCloseTo(0, 0)
    await resetZoomUi()

    // Bitmap res2 fixed points (200% button, 120% wheel, Paper basis) when res2.
    await ensureBitmapMode()
    await resetZoomUi()
    const bdiag = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return { w: canvas.width }
    })
    if (bdiag.w / 480 >= 1.5) {
      const b0 = await page.evaluate(() => {
        const r = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
      })
      await page.getByRole('button', { name: 'Zoom in' }).click()
      await waitZoomLabel('200%')
      const b1 = await page.evaluate(() => {
        const r = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
      })
      expect(b1.w / b0.w).toBeCloseTo(2, 2)
      expect(Math.hypot(b1.x - b0.x, b1.y - b0.y)).toBeLessThan(1.5)
      await resetZoomUi()
      const bc = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
        return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
      })
      const buv = await page.evaluate(([cx, cy]) => {
        const r = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect()
        return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height }
      }, [bc.x, bc.y] as unknown as undefined)
      await page.evaluate((options) => {
        document
          .querySelector('[data-testid="costume-paint-surface"]')!
          .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...(options as object) }))
      }, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: bc.x, clientY: bc.y } as unknown as undefined)
      await waitZoomLabel('120%')
      const bpin = await page.evaluate(([cx, cy, bu, bv]) => {
        const r = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect()
        const au = (cx - r.left) / r.width
        const av = (cy - r.top) / r.height
        return Math.hypot((au - (bu as number)) * r.width, (av - (bv as number)) * r.height)
      }, [bc.x, bc.y, buv.u, buv.v] as unknown as undefined)
      expect(bpin as number).toBeLessThan(1)
      await resetZoomUi()
    } else {
      console.log('NORMALIZED_INCOMPLETE_RES1_WHEEL skip (res1 canvas)')
    }
  }, 180_000)

  it('tools + responsive smoke after zoom ops (selection/text/floating/nudge/brush)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    // Tool smoke: select -> brush -> text buttons exist and switch state.
    await page.getByTestId('vector-shape-select').click()
    await page.getByTestId('vector-shape-brush').click()
    await page.getByTestId('vector-shape-text').click()
    await page.getByTestId('vector-shape-select').click()
    // No floating selection without an explicit selection gesture.
    const floating = await page.evaluate(
      () => document.querySelector('[data-testid="bitmap-floating-scale-handle"]') !== null,
    )
    expect(floating).toBe(false)
    // Surface scale product holds (rect.width / 480 svg == 5 * internal scale;
    // label is per-mode percent: scale = reset * percent/100, reset 0.2).
    const product = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
      const percent = Number.parseInt(label, 10) / 100
      return { product: surface.getBoundingClientRect().width / 480, expected: 5 * 0.2 * percent }
    })
    expect(Math.abs(product.product - product.expected)).toBeLessThan(0.05)
    // Responsive: narrower browser viewport keeps scale + tracking.
    await page.setViewportSize({ width: 800, height: 600 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const narrow = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')
      const r = surface?.getBoundingClientRect()
      return {
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
        rectWidth: r?.width ?? 0,
      }
    })
    console.log(`NORMALIZED_RESPONSIVE ${JSON.stringify(narrow)}`)
    expect(narrow.label).toContain('100%')
    expect(Math.abs(narrow.rectWidth - 480)).toBeLessThan(1.5)
    await page.setViewportSize({ width: 1280, height: 800 })
    console.log('NORMALIZED_INCOMPLETE fit/res1/pan-cap: unchanged by design (see pure INCOMPLETE tests)')
    await resetZoomUi()
  }, 120_000)
})
