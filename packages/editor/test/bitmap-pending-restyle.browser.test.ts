import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Fail-first: bitmap rect/oval retention (scratch-paint bit-tools parity).
//
// Reference (verified against .tmp/scratch-editor):
// - bit-tools/rect-tool.js + oval-tool.js `handleMouseUp` does NOT rasterize:
//   the new Paper Shape stays selected under the armed tool (`selected = true`
//   + `setSelectedItems`, no mode change).
// - `setColor` / `setFilled` / `setThickness` restyle the live selected shape
//   in place; only a deselect (blank press, Escape via clearSelection,
//   tool/mode/target/costume/project switch via deactivateTool) commits it to
//   the raster (`commitRectToBitmap` / `commitOvalToBitmap`).
// - Delete removes the pending vector shape without touching the raster.
//
// Product gap under test: `Editor.svelte` `endBitmapPaint` rasterizes
// immediately at mouseUp, so a color / filled<->outlined / brush-size change
// AFTER mouseUp leaves the committed pixels frozen (the new style only applies
// to the NEXT shape).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-restyle.browser.test.ts
const root = join(import.meta.dir, '..')
const PORT = 4297
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }
const TOP_MIDDLE = { x: 380, y: 260 }

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = target.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}

function toolArmed(className: string | null): boolean {
  return (className ?? '').includes('text-white')
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function waitForStatus(text: string, timeout = 10_000) {
  await page.waitForFunction((want) => document.body.textContent?.includes(want as string) ?? false, text as unknown as undefined, {
    timeout,
  })
}

async function openBitmap() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.waitForFunction(() => {
    const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
    return label.includes('100%')
  }, null, { timeout: 15_000 })
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected bitmap res2 960x720 backing, got ${size.width}x${size.height}`)
  }
}

async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

describe('bitmap rect retention: restyle after mouseUp (fail-first)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('restyles the uncommitted shape after mouseUp without a new history entry', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidFill('#ff0000')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // The shape tool stays armed with the new shape selected (retention).
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    expect(toolArmed(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)

    // Reference: the mouseUp shape is still parametric, so changing the fill
    // color restyles it in place (no raster commit, no new history entry).
    await page.getByLabel('Paint color', { exact: true }).fill('#0000ff')
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 0 && g === 0 && b === 255 && a === 255
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])

    // No new history entry for the restyle: a single Undo drops back to the
    // pre-drag raster (not to the red intermediate).
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
  }, 120_000)

  it('restyles filled<->outlined after mouseUp and commits once on deselect', async () => {
    await openBitmap()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidFill('#ff0000')
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    await dragCanvas({ x: BOX.x1, y: BOX.y1 }, { x: BOX.x2, y: BOX.y2 })
    await waitForStatus('Bitmap edit saved')
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])

    // Reference: switching Filled -> Outlined restyles the pending shape, so
    // the interior returns to the pre-drag pixels while the contour stays.
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    const edge = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(edge[0]).toBeGreaterThan(150)

    // Deselect (Escape) commits; the tool stays armed with no selection.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length === 0, null, {
      timeout: 10_000,
    })
    expect(toolArmed(await page.getByTestId('bitmap-tool-rect').getAttribute('class'))).toBe(true)
    // The committed contour survives the deselect; the interior stays clear.
    const edgeAfter = await pixel(TOP_MIDDLE.x, TOP_MIDDLE.y)
    expect(edgeAfter[0]).toBeGreaterThan(150)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
  }, 120_000)
})
