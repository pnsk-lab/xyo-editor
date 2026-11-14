import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Proves the reproduced Scratch-zoom behavior on the real editor UI:
// - toolbar zoom is Paper-parity additive about the selection center
//   (bitmap res2: +0.5 CSS at density 1.0; vector: +0.2 CSS at density 2.5),
// - the minimum-to-reset special step (res2 0.333 -> 0.5, vector
//   0.1332 -> 0.2; UI labels "67%" -> "100%"), not a full step,
// - ctrl-wheel honors the magnitude (-deltaY/1000 per Paper unit, divided by
//   the live density),
// - plain/shift wheel still pans (scroll preserved),
// - bitmap res1/res2 + vector coordinate mapping tracks the REAL computed
//   scale (rect.width / backing width), while the toolbar label stays
//   UI-only per-mode percent (reset always "100%"),
// - brush + color change + Undo/Redo keep working across the zoom ops.
//
// Baseline: Paper reset 0.5 / floor 0.333 / step +0.5 / wheel -dy/1000.
// Legacy `scale == label/100` (100% == scale 1) does NOT hold: res2 reset
// renders the 960 canvas at 480 CSS px (scale 0.5, "100%"), vector reset
// renders the 2400 surface at 480 CSS px (scale 0.2, "100%").
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/zoom-selection-additive.browser.test.ts
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4341'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function waitZoomLabel(text: string, timeout = 10_000) {
  // Strict UI-label equality ('67%' must not match a future '167%').
  await page.waitForFunction(
    (want) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === (want as string),
    text as unknown as undefined,
    { timeout },
  )
}

async function settleAfterOpen() {
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

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

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout: 15_000 },
  )
}

async function waitForStatus(text: string, timeout = 15_000) {
  await page.waitForFunction(
    (want) => document.querySelector('header span[aria-live]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

async function dispatchWheel(init: {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  clientX?: number
  clientY?: number
}) {
  await page.evaluate((options) => {
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
    surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options }))
  }, init as unknown as undefined)
}

async function selectionCenterScreen(): Promise<{ x: number; y: number }> {
  return await page.evaluate(() => {
    const rect = document.querySelector('[data-testid="bitmap-selection"]')!.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
}

describe('additive selection-centered zoom on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4341', '--strictPort'], {
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

  it('maps res1/res2 + vector coordinates, zooms about the selection, and keeps paint/history working', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await settleAfterOpen()
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // --- Coordinate mapping: the live bitmap rect tracks the REAL computed
    // CSS scale (rect.width / canvas.width), and the res1/res2 artboard rule
    // (480x360 stage units x resolution) holds through the shared helper in
    // the same Chromium process. Label is UI-only ("100%" == res2 reset 0.5).
    const mapping = await page.evaluate(async () => {
      const viewport = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      const artboard = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-artboard.ts')
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
      const sprite = artboard.artboardForTarget(false)
      const stage = artboard.artboardForTarget(true)
      const realScale = rect.width / canvas.width
      return {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        rectWidth: rect.width,
        rectHeight: rect.height,
        scaleW: realScale,
        scaleH: rect.height / canvas.height,
        realScale,
        label,
        sprite,
        stage,
        predicted: viewport.predictSurfaceRect(
          { width: canvas.width, height: canvas.height },
          (() => {
            const container = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
            return { x: container.left + container.width / 2, y: container.top + container.height / 2 }
          })(),
          { x: 0, y: 0, scale: realScale },
        ),
      }
    })
    console.log(`ZOOM_MAP_BITMAP ${JSON.stringify(mapping)}`)
    const m = mapping as {
      canvasWidth: number
      canvasHeight: number
      scaleW: number
      scaleH: number
      label: string
      sprite: { width: number; height: number; resolution: number }
      stage: { width: number; height: number; resolution: number }
    }
    // Artboard rule: sprite 960x720 @res2, stage 480x360 @res1.
    expect(m.sprite).toMatchObject({ width: 960, height: 720, resolution: 2 })
    expect(m.stage).toMatchObject({ width: 480, height: 360, resolution: 1 })
    // Live canvas is a resolution-scaled artboard (sprite res2 by default).
    expect(m.canvasWidth).toBe(m.sprite.width)
    expect(m.canvasHeight).toBe(m.sprite.height)
    // At UI "100%" the real computed scale is the res2 Paper reset 0.5
    // (960 canvas -> 480 CSS px), identical on both axes.
    expect(m.scaleW).toBeCloseTo(0.5, 1)
    expect(m.scaleH).toBeCloseTo(0.5, 1)
    expect(Math.abs(m.scaleW - m.scaleH)).toBeLessThan(0.05)
    expect(m.label).toContain('100%')

    // --- Selection-centered additive zoom: marquee a selection, then the
    // toolbar Zoom in must go 100% -> 200% (res2 +0.5 CSS: 0.5 -> 1.0) while
    // the selection center stays.
    await page.getByTestId('bitmap-tool-select').click()
    const size = await canvasSize()
    const from = await toScreen(size.width * 0.44, size.height * 0.44)
    const to = await toScreen(size.width * 0.56, size.height * 0.56)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    const selBefore = await selectionCenterScreen()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('200%')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const selAfter = await selectionCenterScreen()
    console.log(`ZOOM_SELECTION_PIN ${JSON.stringify({ selBefore, selAfter })}`)
    expect(Math.hypot(selAfter.x - selBefore.x, selAfter.y - selBefore.y)).toBeLessThan(2)
    // Rect still tracks the real scale: 200% is 2x the 100% rect (1.0 / 0.5).
    const rect200 = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { w: rect.width, h: rect.height }
    })
    expect((rect200 as { w: number }).w / (mapping as { rectWidth: number }).rectWidth).toBeCloseTo(2, 1)
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })

    // --- Discontinuous small step (per-mode Paper band res2 0.333..5):
    // 0.333 floor ("67%") -> reset 0.5 ("100%") special, not a full +0.5 step.
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await waitZoomLabel('100%')
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await waitZoomLabel('67%')
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await waitZoomLabel('100%')
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // --- Ctrl-wheel magnitude (res2 density 1.0): a -10 tick is +0.01 CSS
    // (0.5 -> 0.51, UI "100%" -> "102%": round(0.51/0.5*100)).
    const surfaceCenter = await page.evaluate(() => {
      const rect = document.querySelector('[data-testid="costume-paint-surface"]')!.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    const sc = surfaceCenter as { x: number; y: number }
    const anchor = { x: sc.x + 40, y: sc.y + 30 }
    const beforeWheel = await page.evaluate(([cx, cy]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { x: ((cx - rect.left) / rect.width) * canvas.width, y: ((cy - rect.top) / rect.height) * canvas.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    await dispatchWheel({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, clientX: anchor.x, clientY: anchor.y })
    await waitZoomLabel('102%')
    const afterWheel = await page.evaluate(([cx, cy]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const rect = canvas.getBoundingClientRect()
      return { x: ((cx - rect.left) / rect.width) * canvas.width, y: ((cy - rect.top) / rect.height) * canvas.height }
    }, [anchor.x, anchor.y] as unknown as undefined)
    console.log(`ZOOM_WHEEL_SMALL ${JSON.stringify({ beforeWheel, afterWheel })}`)
    expect(Math.abs((afterWheel as { x: number }).x - (beforeWheel as { x: number }).x)).toBeLessThan(1)
    expect(Math.abs((afterWheel as { y: number }).y - (beforeWheel as { y: number }).y)).toBeLessThan(1)
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 150))

    // --- Scroll preserved: plain wheel pans 2D, scale unchanged.
    const leftBefore = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return canvas.getBoundingClientRect().left
    })
    await dispatchWheel({ deltaX: 12, deltaY: 20, deltaMode: 0 })
    await page.waitForFunction(
      ([want]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return Math.abs(canvas.getBoundingClientRect().left - (want as number)) < 2
      },
      [leftBefore - 12] as unknown as undefined,
      { timeout: 10_000 },
    )
    await waitZoomLabel('100%')

    // --- Vector mapping: the edit surface is the fixed 2400x1800 workspace
    // box rendered at the vector Paper reset 0.2 (2400*0.2 = 480 CSS px at UI
    // "100%"), with the art box at the 5x offset.
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview') !== null, null, { timeout: 10_000 })
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const vectorMap = await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface]')!
      const rect = surface.getBoundingClientRect()
      const art = document.querySelector('.vector-preview') as HTMLElement | null
      const artRect = art?.getBoundingClientRect()
      return {
        surfaceW: rect.width,
        surfaceH: rect.height,
        artW: artRect?.width ?? 0,
        artH: artRect?.height ?? 0,
      }
    })
    console.log(`ZOOM_MAP_VECTOR ${JSON.stringify(vectorMap)}`)
    const v = vectorMap as { surfaceW: number; surfaceH: number; artW: number; artH: number }
    // Vector reset scale 0.2: 2400 -> 480 CSS px, 1800 -> 360 CSS px.
    expect(v.surfaceW).toBeCloseTo(480, -1)
    expect(v.surfaceH).toBeCloseTo(360, -1)
    expect(v.artW).toBeGreaterThan(0)
    expect(v.artH).toBeGreaterThan(0)

    // --- Paint + color + history regression across the zoom wiring.
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await settleAfterOpen()
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
    })
    await waitZoomLabel('100%')
    const live = await canvasSize()
    const dot1 = { x: Math.floor(live.width * 0.5), y: Math.floor(live.height * 0.5) }
    const dot2 = { x: Math.floor(live.width * 0.54), y: Math.floor(live.height * 0.5) }
    const baseline2 = await pixel(dot2.x, dot2.y)
    await page.getByTestId('bitmap-tool-brush').click()
    const firstHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    const firstRgb = [0, 1, 2].map((i) => parseInt(firstHex.slice(1 + i * 2, 3 + i * 2), 16))
    const screen1 = await toScreen(dot1.x, dot1.y)
    await page.mouse.move(screen1.x, screen1.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(dot1.x, dot1.y, [...firstRgb, 255])
    const secondHex = firstHex.toLowerCase() === '#00c853' ? '#ff0000' : '#00c853'
    await page.getByLabel('Paint color', { exact: true }).fill(secondHex)
    const secondRgb = [0, 1, 2].map((i) => parseInt(secondHex.slice(1 + i * 2, 3 + i * 2), 16))
    const screen2 = await toScreen(dot2.x, dot2.y)
    await page.mouse.move(screen2.x, screen2.y)
    await page.mouse.down()
    await page.mouse.up()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await waitForPixel(dot2.x, dot2.y, [...secondRgb, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(dot2.x, dot2.y, baseline2, 2)
    expect(await pixel(dot1.x, dot1.y)).toEqual([...firstRgb, 255])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(dot2.x, dot2.y, [...secondRgb, 255])
    expect(await pixel(dot1.x, dot1.y)).toEqual([...firstRgb, 255])
  }, 180_000)
})
