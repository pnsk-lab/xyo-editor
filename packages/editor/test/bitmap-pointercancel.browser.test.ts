import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor verification for the bitmap interruption cancel.
//
// Vector gestures discard the local draft on `pointercancel` /
// `lostpointercapture` (no history, no artwork write); bitmap used to commit
// the partial stroke through the normal end path. This test drives the real
// costume screen and verifies:
// - a synthetic brush pointerdown + move paints preview pixels, then
//   `pointercancel` restores the pre-stroke pixels with no Undo entry,
// - the next real mouse brush stroke still commits exactly one history entry
//   (Undo/Redo round-trip), so the cancel leaves no stuck gesture,
// - a rect-shape drag cancelled the same way paints nothing and leaves no
//   selection, and a select-marquee drag cancelled the same way selects
//   nothing.
// No reference-paint code is copied here; all assertions go through the UI.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4378'
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

async function samplePixels(points: Array<{ x: number; y: number }>): Promise<number[][]> {
  return await page.evaluate((list) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const context = target.getContext('2d')!
    return (list as Array<{ x: number; y: number }>).map(({ x, y }) =>
      Array.from(context.getImageData(Math.max(0, Math.min(target.width - 1, Math.round(x))), Math.max(0, Math.min(target.height - 1, Math.round(y))), 1, 1).data),
    )
  }, points as unknown as undefined)
}

function linePoints(from: { x: number; y: number }, to: { x: number; y: number }, count = 9): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0 : index / (count - 1)
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  })
}

async function undoEnabled(): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]').first().isEnabled()
}

async function dispatchOnCanvas(type: string, init: Record<string, unknown>) {
  await page.evaluate(([eventType, pointer]: [string, Record<string, unknown>]) => {
    const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
    const rect = target.getBoundingClientRect()
    const x = rect.left + rect.width / 2 + (pointer.dx as number)
    const y = rect.top + rect.height / 2 + (pointer.dy as number)
    target.dispatchEvent(
      new PointerEvent(eventType, {
        pointerType: (pointer.pointerType as string) ?? 'pen',
        pointerId: pointer.pointerId as number,
        button: (pointer.button as number) ?? 0,
        buttons: (pointer.buttons as number) ?? 1,
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
        isPrimary: true,
      }),
    )
  }, [type, init] as unknown as undefined)
}

describe('bitmap interruption cancel on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4378', '--strictPort'], {
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
    if (await page.getByTestId('bitmap-editor-canvas').isHidden()) {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    }
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    await page.getByTestId('bitmap-tool-brush').click()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('pointercancel discards a partial brush stroke without history, then mouse painting still commits', async () => {
    await page.getByTestId('bitmap-tool-brush').click()
    // Fit may put these canvas-relative points outside the clipped surface.
    // Reset to the reference zoom so both real mouse endpoints are visible.
    await page.getByRole('button', { name: 'Reset zoom' }).click()
    const size = await canvasSize()
    const from = { x: size.width * 0.3, y: size.height * 0.5 }
    const to = { x: size.width * 0.7, y: size.height * 0.5 }
    const probes = linePoints(from, to)
    const before = await samplePixels(probes)
    const undoBefore = await undoEnabled()

    await dispatchOnCanvas('pointerdown', { pointerId: 501, dx: -60, dy: 0 })
    await dispatchOnCanvas('pointermove', { pointerId: 501, dx: 0, dy: 0 })
    await dispatchOnCanvas('pointermove', { pointerId: 501, dx: 60, dy: 0 })
    await page.waitForTimeout(400)
    const mid = await samplePixels(probes)
    // The interrupted stroke visibly painted before the cancel arrived.
    expect(mid.some((pixel, index) => pixel.some((channel, channelIndex) => Math.abs(channel - before[index]![channelIndex]!) > 4))).toBe(true)

    await dispatchOnCanvas('pointercancel', { pointerId: 501, buttons: 0, dx: 60, dy: 0 })
    await page.waitForTimeout(400)
    const after = await samplePixels(probes)
    for (let index = 0; index < after.length; index += 1) {
      expect(after[index]).toEqual(before[index])
    }
    expect(await undoEnabled()).toBe(undoBefore)

    // The cancel leaves no stuck gesture: a real mouse stroke commits.
    const a = await toScreen(from.x, from.y)
    const b = await toScreen(to.x, to.y)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.some((channel, channelIndex) => Math.abs(channel - (want as number[])[channelIndex]!) > 4)
      },
      [Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2), before[Math.floor(before.length / 2)]!] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await undoEnabled()).toBe(true)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForTimeout(800)
    const undone = await samplePixels(probes)
    for (let index = 0; index < undone.length; index += 1) {
      expect(undone[index]).toEqual(before[index])
    }
  }, 120_000)

  it('pointercancel discards shape and selection drafts without history', async () => {
    const undoBefore = await undoEnabled()
    const size = await canvasSize()
    const from = { x: size.width * 0.3, y: size.height * 0.3 }
    const to = { x: size.width * 0.6, y: size.height * 0.6 }
    const probes = linePoints(from, to)
    const before = await samplePixels(probes)

    await page.getByTestId('bitmap-tool-rect').click()
    await dispatchOnCanvas('pointerdown', { pointerId: 502, dx: -50, dy: -40 })
    await dispatchOnCanvas('pointermove', { pointerId: 502, dx: 50, dy: 40 })
    await page.waitForTimeout(400)
    await dispatchOnCanvas('pointercancel', { pointerId: 502, buttons: 0, dx: 50, dy: 40 })
    await page.waitForTimeout(400)
    const afterShape = await samplePixels(probes)
    for (let index = 0; index < afterShape.length; index += 1) {
      expect(afterShape[index]).toEqual(before[index])
    }
    expect(await page.locator('[data-testid="bitmap-selection"]').count()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)

    await page.getByTestId('bitmap-tool-select').click()
    await dispatchOnCanvas('pointerdown', { pointerId: 503, dx: -50, dy: -40 })
    await dispatchOnCanvas('pointermove', { pointerId: 503, dx: 50, dy: 40 })
    await page.waitForTimeout(300)
    await dispatchOnCanvas('pointercancel', { pointerId: 503, buttons: 0, dx: 50, dy: 40 })
    await page.waitForTimeout(400)
    expect(await page.locator('[data-testid="bitmap-selection"]').count()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)
  }, 120_000)
})
