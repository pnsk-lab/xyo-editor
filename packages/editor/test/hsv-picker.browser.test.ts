import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-screen coverage for the Scratch-parity HSV pickers in BitmapEditor:
// native `<input type=color>` controls are kept untouched, and one
// HsvColorPicker (hue/saturation/brightness 0-100 + numeric readouts) is bound
// to each paint (fill, stroke, both gradient ends).
// - RGB -> HSV endpoints: native hex sets the slider positions + readouts;
//   stroke stays independent from fill.
// - HSV -> RGB continuous + keyboard/a11y: slider input rewrites the hex live
//   (before change), Arrow keys move it, every slider has an accessible name.
// - Transparent + history: toggling transparent parks the sliders on the
//   default without clearing the stored hex; moving a slider while transparent
//   rewrites the stored hex but keeps transparency; color-only edits never
//   create an Undo entry; paint/Undo/Redo still round-trip.
// - Vector MIXED + swap + gradient stop + RTL: a two-color selection shows the
//   MIXED badge while the HSV sliders freeze; swap still exchanges the stored
//   hexes; the secondary HSV drives the gradient end through Apply/Undo/Redo;
//   under dir=rtl the sliders stay visible and functional.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4478'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function setHsv(testId: string, value: number) {
  await page
    .getByTestId(testId)
    .evaluate(
      (node: HTMLInputElement, next: number) => {
        node.value = String(next)
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      },
      value,
    )
}

async function hsvInputValue(testId: string): Promise<number> {
  return Number(await page.getByTestId(testId).inputValue())
}

async function readout(testId: string): Promise<string> {
  return ((await page.getByTestId(testId).textContent()) ?? '').trim()
}

function undoButton() {
  return page.getByRole('button', { name: 'Undo' })
}

function redoButton() {
  return page.getByRole('button', { name: 'Redo' })
}

async function bitmapCenterPixel(): Promise<number[]> {
  return page.getByTestId('bitmap-editor-canvas').evaluate((element: HTMLCanvasElement) => {
    const { width, height } = element
    return Array.from(element.getContext('2d')!.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data)
  })
}

// The bitmap conversion rasterizes asynchronously after the canvas appears;
// wait until two consecutive pixel samples agree so baseline pixels are
// stable (1px samples, not dataURL: cheap enough to poll).
async function waitBitmapSettled() {
  let last = ''
  for (let i = 0; i < 60; i++) {
    const sample = await page
      .getByTestId('bitmap-editor-canvas')
      .evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d')!
        const corner = Array.from(context.getImageData(0, 0, 1, 1).data)
        const center = Array.from(
          context.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data,
        )
        return JSON.stringify([corner, center])
      })
    if (sample === last) return
    last = sample
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Bitmap canvas never settled')
}

describe('hsv picker on the real costume screen', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4478', '--strictPort'], {
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
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('maps native RGB to HSV endpoints and keeps stroke independent', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    const fill = page.getByLabel('Paint color', { exact: true })
    await fill.fill('#ff0000')
    expect(await hsvInputValue('fill-hue')).toBe(0)
    expect(await hsvInputValue('fill-saturation')).toBe(100)
    expect(await hsvInputValue('fill-brightness')).toBe(100)
    expect(await readout('fill-hue-value')).toBe('0')
    expect(await readout('fill-saturation-value')).toBe('100')
    expect(await readout('fill-brightness-value')).toBe('100')

    await fill.fill('#00ff00')
    expect(await hsvInputValue('fill-hue')).toBeCloseTo(100 / 3, 1)
    expect(await readout('fill-hue-value')).toBe('33')

    // Stroke is a second independent picker: moving it never moves the fill.
    await page.getByLabel('Stroke color', { exact: true }).fill('#0000ff')
    expect(await hsvInputValue('stroke-hue')).toBeCloseTo(200 / 3, 1)
    expect(await hsvInputValue('fill-hue')).toBeCloseTo(100 / 3, 1)
  }, 120_000)

  it('rewrites RGB continuously with keyboard support and accessible names', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    const fill = page.getByLabel('Paint color', { exact: true })
    await fill.fill('#00ff00')

    // Accessible names on all three fill sliders.
    for (const name of ['Fill hue', 'Fill saturation', 'Fill brightness']) {
      await page.getByLabel(name, { exact: true }).waitFor({ state: 'visible' })
    }

    // Keyboard: Home parks hue at red, arrows step it.
    const hue = page.getByLabel('Fill hue', { exact: true })
    await hue.focus()
    await page.keyboard.press('Home')
    expect(await fill.inputValue()).toBe('#ff0000')
    expect(await readout('fill-hue-value')).toBe('0')
    await page.keyboard.press('ArrowRight')
    expect(await hsvInputValue('fill-hue')).toBeGreaterThan(0)
    expect(await fill.inputValue()).not.toBe('#ff0000')

    // Continuous: an `input` event alone (no change yet) already rewrites hex.
    await page.getByTestId('fill-hue').evaluate((node: HTMLInputElement) => {
      node.value = '0'
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(await fill.inputValue()).toBe('#ff0000')

    // Brightness endpoint halves the red channel; the brush paints it.
    await setHsv('fill-brightness', 50)
    expect(await fill.inputValue()).toBe('#800000')
    expect(await readout('fill-brightness-value')).toBe('50')
    await page.getByTestId('bitmap-tool-brush').click()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 100 && r < 160 && g < 40 && b < 40 && a === 255
    })
  }, 120_000)

  it('parks on transparent without history and round-trips paint undo/redo', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    const fill = page.getByLabel('Paint color', { exact: true })
    await fill.fill('#ff0000')

    // One real paint entry, then Undo so the Redo stack is armed: any history
    // write from the color-only edits below would clear Redo (observable),
    // while behavior-preserving edits leave both stacks alone.
    await page.getByTestId('bitmap-tool-brush').click()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    // The converted costume already has artwork: settle the async raster,
    // then compare against the captured pixels instead of assuming blank.
    await waitBitmapSettled()
    const basePixel = await bitmapCenterPixel()
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 200 && g < 40 && b < 40 && a === 255
    })
    await undoButton().click()
    // The dot is gone (exact bytes can include a hover preview stamped after
    // the baseline capture, so compare color, not bytes).
    const undonePixel = await bitmapCenterPixel()
    expect(
      (undonePixel[0] as number) > 200 && (undonePixel[1] as number) < 40 && (undonePixel[2] as number) < 40,
    ).toBe(false)
    expect(await redoButton().isDisabled()).toBe(false)

    const transparent = page.getByRole('button', { name: 'Transparent fill' })
    await transparent.click()
    expect(await transparent.getAttribute('aria-pressed')).toBe('true')
    // Parked on the default, stored hex kept for restore.
    expect(await readout('fill-hue-value')).toBe('50')
    expect(await readout('fill-saturation-value')).toBe('100')
    expect(await readout('fill-brightness-value')).toBe('100')
    expect(await fill.inputValue()).toBe('#ff0000')

    // Moving a slider while transparent becomes opaque at once (Scratch
    // parity): the stored hex is rewritten AND the transparent flag clears,
    // so the next stamp paints. Color-only edits still write no history.
    await setHsv('fill-hue', 200 / 3)
    expect(await transparent.getAttribute('aria-pressed')).toBe('false')
    expect(await fill.inputValue()).toBe('#0000ff')
    // Color-only edits (toggle + sliders) write no history: both stacks stay
    // armed exactly as before.
    expect(await undoButton().isDisabled()).toBe(false)
    expect(await redoButton().isDisabled()).toBe(false)

    // An opaque blue brush paints (same stamp path as before) and commits its
    // own history entry: the center turns blue and the Redo stack resets.
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return b > 200 && r < 40 && g < 40 && a === 255
    })
    expect(await undoButton().isDisabled()).toBe(false)
    expect(await redoButton().isDisabled()).toBe(true)
    // Undo the blue dot: back to the pre-paint artwork (the red dot was already
    // undone before, so its redo was truncated by the new entry).
    await undoButton().click()
    await page.waitForFunction(
      (baseAlpha) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
        const isBlue = b > 200 && r < 40 && g < 40;
        return !isBlue && a === baseAlpha
      },
      basePixel[3],
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return b > 200 && r < 40 && g < 40 && a === 255
    })
    // Re-enabling transparent keeps the rewritten hex for restore; a stamp now
    // erases again. Then untoggling restores blue and paints opaque on top.
    await transparent.click()
    expect(await transparent.getAttribute('aria-pressed')).toBe('true')
    expect(await fill.inputValue()).toBe('#0000ff')
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    await undoButton().click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return b > 200 && r < 40 && g < 40 && a === 255
    })
    await redoButton().click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    await transparent.click()
    expect(await transparent.getAttribute('aria-pressed')).toBe('false')
    expect(await fill.inputValue()).toBe('#0000ff')
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return b > 200 && r < 40 && g < 40 && a === 255
    })
    await undoButton().click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    await redoButton().click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return b > 200 && r < 40 && g < 40 && a === 255
    })
  }, 120_000)

  it('freezes on vector MIXED, swaps, drives gradient stops, and works in RTL', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface')
    const left = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }
    const right = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 }

    const fill = page.getByLabel('Paint color', { exact: true })
    await page.getByTestId('vector-shape-oval').last().click()
    await fill.fill('#ff0000')
    const previewBefore = await page.locator('.vector-preview').innerHTML()
    await page.mouse.move(left.x - 40, left.y - 30)
    await page.mouse.down()
    await page.mouse.move(left.x + 40, left.y + 30, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previewBefore, {
      timeout: 10_000,
    })

    await page.getByTestId('vector-shape-oval').last().click()
    await fill.fill('#0000ff')
    const previewMid = await page.locator('.vector-preview').innerHTML()
    await page.mouse.move(right.x - 40, right.y - 30)
    await page.mouse.down()
    await page.mouse.move(right.x + 40, right.y + 30, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, previewMid, {
      timeout: 10_000,
    })
    const frozenHue = await hsvInputValue('fill-hue')

    // Marquee-select both: MIXED badge shows, HSV sliders freeze in place.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 10 })
    await page.mouse.up()
    await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
    expect(await hsvInputValue('fill-hue')).toBe(frozenHue)

    // Swap still exchanges the stored hexes (needs a visible secondary first).
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    const secondary = page.getByLabel('Secondary paint color', { exact: true })
    await secondary.fill('#00ff00')
    const primaryBefore = await fill.inputValue()
    await page.getByTestId('swap-fill-colors').click()
    expect(await fill.inputValue()).toBe('#00ff00')
    expect(await secondary.inputValue()).toBe(primaryBefore)

    // The secondary HSV drives the gradient end through Apply/Undo/Redo.
    // (Stale gradient defs accumulate in the document, so the check follows
    // the shapes' own fill refs instead of the raw markup.)
    const gradientFills = () =>
      page.evaluate(
        () => document.querySelectorAll('.vector-preview [fill^="url("]').length,
      )
    await setHsv('fill-secondary-hue', 0)
    expect(await secondary.inputValue()).not.toBe(primaryBefore)
    await page.getByTestId('apply-vector-style').click()
    await page.waitForFunction(() => document.querySelectorAll('.vector-preview [fill^="url("]').length > 0, null, {
      timeout: 10_000,
    })
    expect(await gradientFills()).toBeGreaterThan(0)
    await undoButton().click()
    await page.waitForFunction(() => document.querySelectorAll('.vector-preview [fill^="url("]').length === 0, null, {
      timeout: 10_000,
    })
    await redoButton().click()
    await page.waitForFunction(() => document.querySelectorAll('.vector-preview [fill^="url("]').length > 0, null, {
      timeout: 10_000,
    })

    // RTL: sliders stay visible and functional under dir=rtl.
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
    await page.getByLabel('Stroke hue', { exact: true }).waitFor({ state: 'visible' })
    const strokeBefore = await page.getByLabel('Stroke color', { exact: true }).inputValue()
    await setHsv('stroke-hue', 0)
    expect(await readout('stroke-hue-value')).toBe('0')
    expect(await page.getByLabel('Stroke color', { exact: true }).inputValue()).not.toBe(strokeBefore)
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'ltr'))
  }, 120_000)
})
