import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the selection-mode Copy/Paste buttons, the Bring to
// front button, and the first/second fill-color swap (`BitmapEditor.svelte` +
// `Editor.svelte` wiring over the existing copyCostumeSelection /
// pasteCostumeSelection / editVectorObject('front') and the paint state).
// Drives the actual paint surface: toolbar enablement with empty vs. filled
// clipboards, button copy/paste with Undo peeling, the eyedropper + inline
// text conflicts (both disable the clipboard buttons while active), the
// vector-mode guard (Bring to front needs a vector selection), and a swap
// that exchanges the hex pickers together with their transparent flags.
//
// Assertions use Playwright's `isVisible`/`isDisabled`/`getAttribute` probes
// with `bun:test` expectations (the pattern the other real-editor browser
// tests use), never Playwright's `expect(...).toBeEnabled()` matchers.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4256'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function zoomUiLabel(): Promise<string> {
  // UI label only (res2 reset "100%" = CSS 0.5, floor "67%" = CSS 0.333).
  // Never label/100 as the scale; use realCssScale() below (Paper basis).
  const label = await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
  return (label as string).trim()
}

async function realCssScale(): Promise<number> {
  // Real computed CSS scale from the live canvas rect (Paper basis):
  // rect.width = backingW * viewportScale.
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  const size = await canvasSize()
  return box && size.width > 0 ? box.width / size.width : 0.5
}

async function zoomToFloor(): Promise<{ ui: string; css: number }> {
  // Per-mode Paper floor: res2 (sprite conversion, 960 canvas) clamps at
  // UI "67%" (CSS 0.333); unknown/res1 clamps at "25%" (CSS 0.25).
  // Click until the UI label stabilizes instead of assuming "25%".
  const zoomOut = page.getByRole('button', { name: 'Zoom out' }).first()
  let prev = ''
  for (let i = 0; i < 15; i += 1) {
    await zoomOut.click()
    await page.waitForTimeout(150)
    const cur = await zoomUiLabel()
    if (cur === prev) break
    prev = cur
  }
  const ui = await zoomUiLabel()
  const css = await realCssScale()
  console.log(`[selection-swap] zoom-floor ui=${ui} css=${css}`)
  return { ui, css }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

/**
 * Center-derived empty spot for paint/clipboard probes (artboard-aware
 * fixture): the edit canvas (sprite 960x720 res2, stage 480x360 res1) shows
 * the converted default costume, so hardcoded pixels can sit on opaque art
 * and a source-over paste then legitimately covers the dot. Spiral outward
 * from the canvas center for an exactly fully-transparent `boxSize` block,
 * keeping a copy-selection margin (20px) plus the shared +10 paste stagger
 * inside the canvas. Throws when none exists instead of weakening asserts.
 */
async function findEmptySpot(boxSize = 60): Promise<{ x: number; y: number }> {
  return await page.evaluate((wanted) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const context = target.getContext('2d')!
    const w = target.width
    const h = target.height
    const half = Math.floor((wanted as number) / 2)
    const data = context.getImageData(0, 0, w, h).data
    const isEmpty = (cx: number, cy: number): boolean => {
      if (cx - half < 20 || cy - half < 20 || cx + half > w - 30 || cy + half > h - 30) return false
      for (let y = cy - half; y < cy + half; y += 1) {
        for (let x = cx - half; x < cx + half; x += 1) {
          if (data[(y * w + x) * 4 + 3] !== 0) return false
        }
      }
      return true
    }
    const cx0 = Math.floor(w / 2)
    const cy0 = Math.floor(h / 2)
    if (isEmpty(cx0, cy0)) return { x: cx0, y: cy0 }
    const maxR = Math.max(w, h)
    for (let r = 1; r < maxR; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (isEmpty(cx0 + dx, cy0 - r)) return { x: cx0 + dx, y: cy0 - r }
        if (isEmpty(cx0 + dx, cy0 + r)) return { x: cx0 + dx, y: cy0 + r }
      }
      for (let dy = -r + 1; dy <= r - 1; dy += 1) {
        if (isEmpty(cx0 - r, cy0 + dy)) return { x: cx0 - r, y: cy0 + dy }
        if (isEmpty(cx0 + r, cy0 + dy)) return { x: cx0 + r, y: cy0 + dy }
      }
    }
    throw new Error(`No empty ${wanted as number}x${wanted as number} block on ${w}x${h} canvas`)
  }, boxSize as unknown as undefined)
}

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
}

describe('selection copy/paste, bring-to-front, and fill swap on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4256', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
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
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('exposes the new toolbar buttons with labels and mode-aware enablement', async () => {
    const copy = page.getByTestId('copy-costume-selection')
    const paste = page.getByTestId('paste-costume-selection')
    const front = page.getByTestId('layer-order-front')
    const swap = page.getByTestId('swap-fill-colors')
    expect(await copy.isVisible()).toBe(true)
    expect(await paste.isVisible()).toBe(true)
    expect(await front.isVisible()).toBe(true)
    expect(await swap.isVisible()).toBe(true)
    expect(await copy.getAttribute('aria-label')).toBe('Copy selection')
    expect(await paste.getAttribute('aria-label')).toBe('Paste selection')
    expect(await front.getAttribute('aria-label')).toBe('Bring to front')
    expect(await swap.getAttribute('aria-label')).toBe('Swap fill colors')
    // Bitmap mode: copy falls back to the trimmed raster (enabled), paste has
    // no clipboard yet (disabled), front needs vector mode + selection.
    expect(await copy.isDisabled()).toBe(false)
    expect(await paste.isDisabled()).toBe(true)
    expect(await front.isDisabled()).toBe(true)
    expect(await swap.isDisabled()).toBe(false)
  }, 30_000)

  it('swaps the hex pickers together with their transparent flags', async () => {
    // Non-solid gradient reveals the secondary color + its toggle.
    await page.getByLabel('Bitmap paint style').selectOption('horizontal')
    const primary = page.getByLabel('Paint color', { exact: true })
    const secondary = page.getByLabel('Secondary paint color', { exact: true })
    await primary.fill('#ff0000')
    await secondary.fill('#0000ff')
    const fillToggle = page.getByRole('button', { name: 'Transparent fill' })
    const secondaryToggle = page.getByRole('button', { name: 'Transparent secondary' })
    // Opaque primary / transparent secondary -> swap -> transparent primary /
    // opaque secondary, with the hex values exchanged too.
    expect(await fillToggle.getAttribute('aria-pressed')).toBe('false')
    await secondaryToggle.click()
    expect(await secondaryToggle.getAttribute('aria-pressed')).toBe('true')
    await page.getByTestId('swap-fill-colors').click()
    expect(await primary.inputValue()).toBe('#0000ff')
    expect(await secondary.inputValue()).toBe('#ff0000')
    expect(await fillToggle.getAttribute('aria-pressed')).toBe('true')
    expect(await secondaryToggle.getAttribute('aria-pressed')).toBe('false')
    // Exact involution: swapping back restores everything.
    await page.getByTestId('swap-fill-colors').click()
    expect(await primary.inputValue()).toBe('#ff0000')
    expect(await secondary.inputValue()).toBe('#0000ff')
    expect(await fillToggle.getAttribute('aria-pressed')).toBe('false')
    expect(await secondaryToggle.getAttribute('aria-pressed')).toBe('true')
    // Leave the editor in a paintable state for the clipboard steps below.
    await secondaryToggle.click()
    await page.getByLabel('Bitmap paint style').selectOption('solid')
  }, 30_000)

  it('copies and pastes through the toolbar buttons with single-entry undo', async () => {
    // Zoom to the per-mode Paper floor so the whole canvas fits the surface:
    // sprite conversion yields a res2 960-wide canvas (floor UI "67%" =
    // CSS 0.333), not legacy "25%". Label is UI only; mapping uses the
    // real computed CSS scale (toScreen already does via the live rect).
    const floor = await zoomToFloor()
    const size0 = await canvasSize()
    // Paper basis: res2 floor CSS 0.333 renders 960*0.333=320 CSS px.
    if (size0.width >= 720) {
      expect(floor.ui).toContain('67%')
      expect(Math.abs(floor.css - 0.333)).toBeLessThan(0.05)
    } else {
      expect(floor.ui).toContain('25%')
    }

    // Real brush dot on a center-derived EMPTY spot, so the selection
    // surround is transparent and the source-over paste cannot cover the
    // source with opaque art (fixture keeps the "source survives" meaning).
    await page.getByTestId('bitmap-tool-brush').click()
    const paintHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    const paintRgb = [0, 1, 2].map((i) => parseInt(paintHex.slice(1 + i * 2, 3 + i * 2), 16))
    const dot = await findEmptySpot(60)
    const dup = { x: dot.x + 10, y: dot.y + 10 }
    // Setup guard (exact, not weakened): the spot must be transparent or the
    // pixel asserts below would be confounded by pre-existing art.
    expect(await pixel(dot.x, dot.y)).toEqual([0, 0, 0, 0])
    expect(await pixel(dup.x, dup.y)).toEqual([0, 0, 0, 0])
    const dotScreen = await toScreen(dot.x, dot.y)
    await page.mouse.move(dotScreen.x, dotScreen.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(dot.x, dot.y, [...paintRgb, 255])

    // Marquee-select the dot, then copy/paste via the new buttons (not keys).
    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: dot.x - 20, y: dot.y - 20 }, { x: dot.x + 20, y: dot.y + 20 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await page.getByTestId('copy-costume-selection').click()
    await waitForStatus('Bitmap selection copied')
    expect(await page.getByTestId('paste-costume-selection').isDisabled()).toBe(false)
    await page.getByTestId('paste-costume-selection').click()
    await waitForStatus('Bitmap selection pasted')
    // Shared +10px paste offset: the duplicate lands at dot+10 while the
    // source survives.
    await waitForPixel(dup.x, dup.y, [...paintRgb, 255])
    expect(await pixel(dot.x, dot.y)).toEqual([...paintRgb, 255])
    // Single history entry: one Undo peels the paste only.
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await waitForStatus('Asset undo')
    await waitForPixel(dup.x, dup.y, [0, 0, 0, 0])
    expect(await pixel(dot.x, dot.y)).toEqual([...paintRgb, 255])
  }, 120_000)

  it('disables clipboard buttons under the eyedropper and text drafts', async () => {
    const copy = page.getByTestId('copy-costume-selection')
    const paste = page.getByTestId('paste-costume-selection')
    // Paste is enabled from the previous step's clipboard; the overlay still
    // wins over both while it owns the canvas.
    expect(await paste.isDisabled()).toBe(false)
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    expect(await copy.isDisabled()).toBe(true)
    expect(await paste.isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'hidden' })
    expect(await copy.isDisabled()).toBe(false)
    expect(await paste.isDisabled()).toBe(false)

    // An open inline text draft owns the keyboard: clipboard buttons stay
    // disabled until the draft commits (Escape commits, matching the editor).
    // The click point is derived from the live canvas center: the old fixed
    // (1200, 900) pixel falls outside the artboard canvas (sprite 960x720),
    // so the click missed the canvas and no draft ever opened.
    await page.getByTestId('bitmap-tool-text').click()
    const size = await canvasSize()
    const center = await toScreen(Math.floor(size.width / 2), Math.floor(size.height / 2))
    await page.mouse.click(center.x, center.y)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'visible' })
    expect(await copy.isDisabled()).toBe(true)
    expect(await paste.isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'hidden' })
    expect(await copy.isDisabled()).toBe(false)
  }, 60_000)

  it('keeps Bring to front guarded in vector mode without a selection', async () => {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.getByTestId('vector-shape-select').waitFor({ state: 'visible' })
    // No vector selection (fresh conversion): front/forward/backward/back all
    // stay disabled instead of running history-writing no-ops.
    expect(await page.getByTestId('layer-order-front').isDisabled()).toBe(true)
    expect(await page.getByTestId('layer-order-forward').isDisabled()).toBe(true)
    expect(await page.getByTestId('layer-order-backward').isDisabled()).toBe(true)
    expect(await page.getByTestId('layer-order-back').isDisabled()).toBe(true)
    // Cross-format clipboard (bitmap -> vector): the previous step's bitmap
    // copy survives the mode switch, so paste stays enabled in vector mode
    // even though the vector clipboard is empty — and running it embeds the
    // bitmap art as a staggered `<image>` instead of no-op.
    expect(await page.getByTestId('paste-costume-selection').isDisabled()).toBe(false)
    await page.getByTestId('paste-costume-selection').click()
    await waitForStatus('Vector selection pasted')
    const images = await page.evaluate(
      () => document.querySelectorAll('.vector-preview svg image').length,
    )
    expect(images).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
