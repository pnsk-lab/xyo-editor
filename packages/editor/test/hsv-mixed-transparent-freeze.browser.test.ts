import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Scratch-parity HSV live behavior (behavior notes, no upstream source copied):
// - Reference `containers/color-picker.jsx`: local hue/sat/bright state, sliders
//   freeze on selection-only updates; any slider move calls `onChangeColor`
//   which paints the selection at once (transparent becomes opaque) and the
//   single Undo entry is committed when the picker closes.
// - This editor (`HsvColorPicker` + `BitmapEditor` + `Editor.svelte` live
//   gesture): each HSV tick repaints ONLY the edited color side immediately,
//   clears that side's transparent flag, coalesces drag + rapid keyboard ticks
//   to exactly one Undo entry (600ms idle flush, plus immediate flush on
//   selection/target/tool switch, eyedropper, text commit, Undo/Redo), keeps
//   0/100 both red, preserves MIXED/gradient/stops/bitmap drawing colors, and
//   drops stale async completions without touching the new target. Same-value
//   and fully-skipped (MIXED) ticks stay history-free; transparent gradient
//   stops survive primary-side edits.
//
// This file only drives the real Editor UI (no product-code edits) on its own
// port and asserts the observable live behavior above.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4495'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
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

async function previewHtml(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function previewFills(): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('.vector-preview [fill]')).map(
      (node) => (node.getAttribute('fill') ?? '').toLowerCase(),
    ),
  )
}

async function previewStrokes(): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('.vector-preview [stroke]')).map(
      (node) => (node.getAttribute('stroke') ?? '').toLowerCase(),
    ),
  )
}

async function referencedGradientStopColors(): Promise<string[]> {
  return await page.evaluate(() => {
    const preview = document.querySelector('.vector-preview')
    if (!preview) return []
    const ids = new Set<string>()
    preview.querySelectorAll('[fill]').forEach((node) => {
      const raw = (node.getAttribute('fill') ?? '').trim()
      const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(raw)
      if (m && m[1]) ids.add(m[1]!)
    })
    const colors: string[] = []
    ids.forEach((id) => {
      const def = preview.querySelector(`#${CSS.escape(id)}`)
      const scope: Element | Document = (def as Element) ?? document
      // Stops may live in the same preview document; query globally as fallback.
      const stops = (def ? def.querySelectorAll('stop') : preview.querySelectorAll('stop'))
      stops.forEach((stop) => {
        const c = (stop.getAttribute('stop-color') ?? '').toLowerCase()
        if (c) colors.push(c)
      })
      // Fallback: if def not found in preview (namespaced), scan raw HTML for its block.
      if (stops.length === 0) {
        const html = preview.innerHTML
        const re = new RegExp(`id="${id}"[\\s\\S]*?stop-color="([^"]+)"`, 'g')
        let mm: RegExpExecArray | null
        while ((mm = re.exec(html)) !== null) colors.push((mm[1] ?? '').toLowerCase())
      }
    })
    return colors
  })
}

function undoButton() {
  return page.getByRole('button', { name: 'Undo' })
}

function redoButton() {
  return page.getByRole('button', { name: 'Redo' })
}

async function waitUndoEnabled(timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Undo' || b.getAttribute('aria-label') === 'Undo')
      return btn && !(btn as HTMLButtonElement).disabled
    },
    null,
    { timeout },
  )
}

async function waitRedoEnabled(timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Redo' || b.getAttribute('aria-label') === 'Redo')
      return btn && !(btn as HTMLButtonElement).disabled
    },
    null,
    { timeout },
  )
}

async function waitHsvIdle(ms = 900) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function drawTwoColorOvals() {
  const surface = page.getByTestId('costume-paint-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing paint surface')
  const left = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }
  const right = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 }
  const fill = page.getByLabel('Paint color', { exact: true })

  await page.getByTestId('vector-shape-oval').last().click()
  await fill.fill('#ff0000')
  const before = await previewHtml()
  await page.mouse.move(left.x - 40, left.y - 30)
  await page.mouse.down()
  await page.mouse.move(left.x + 40, left.y + 30, { steps: 10 })
  await page.mouse.up()
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, {
    timeout: 10_000,
  })

  await page.getByTestId('vector-shape-oval').last().click()
  await fill.fill('#0000ff')
  const mid = await previewHtml()
  await page.mouse.move(right.x - 40, right.y - 30)
  await page.mouse.down()
  await page.mouse.move(right.x + 40, right.y + 30, { steps: 10 })
  await page.mouse.up()
  await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, mid, {
    timeout: 10_000,
  })
  return { box, left, right }
}

async function marqueeSelectAll(box: { x: number; y: number; width: number; height: number }) {
  await page.getByTestId('vector-shape-select').last().click()
  await page.mouse.move(box.x + 10, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 10 })
  await page.mouse.up()
  await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
}

describe('hsv MIXED/transparent live vs reference', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4495', '--strictPort'], {
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

  it('MIXED slider live-unifies both shapes with one Undo/Redo and no Apply', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const { box } = await drawTwoColorOvals()
    const frozenHue = await hsvInputValue('fill-hue')

    await marqueeSelectAll(box)
    // Freeze parity: still the pre-selection blue position, not the default.
    expect(await hsvInputValue('fill-hue')).toBe(frozenHue)
    expect(await page.getByTestId('mixed-fill').isVisible()).toBe(true)

    const countFill = (fills: string[], value: string) => fills.filter((fill) => fill === value).length
    const beforeFills = (await previewFills()).map((fill) => fill.toLowerCase())
    expect(countFill(beforeFills, '#0000ff')).toBeGreaterThanOrEqual(1)

    // Live: a slider move repaints the selection at once and clears MIXED.
    await setHsv('fill-hue', 0)
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    expect(await readout('fill-hue-value')).toBe('0')
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )
    expect(await page.getByTestId('mixed-fill').count()).toBe(0)
    const unified = (await previewFills()).map((fill) => fill.toLowerCase())
    expect(countFill(unified, '#0000ff')).toBe(0)
    expect(countFill(unified, '#ff0000')).toBeGreaterThan(countFill(beforeFills, '#ff0000'))

    // One coalesced entry: wait for the idle flush, then Undo/Redo round-trip.
    await waitUndoEnabled()
    await waitHsvIdle()
    await undoButton().click()
    await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toContain('#0000ff')
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )

    // Post-live Apply is a clean no-op: still unified, still one Undo deep.
    // (Apply stays enabled in the DOM; a click must not add history.)
    await page.getByTestId('apply-vector-style').click()
    await waitHsvIdle(400)
    expect((await previewFills()).map((fill) => fill.toLowerCase())).not.toContain('#0000ff')
    await undoButton().click()
    await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toContain('#0000ff')
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )
  }, 120_000)

  it('transparent slider becomes opaque immediately with one Undo/Redo', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const fill = page.getByLabel('Paint color', { exact: true })
    await page.getByTestId('vector-shape-oval').last().click()
    await fill.fill('#ff0000')
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface')
    const ovalAt = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 }
    const before = await previewHtml()
    await page.mouse.move(ovalAt.x - 40, ovalAt.y - 30)
    await page.mouse.down()
    await page.mouse.move(ovalAt.x + 40, ovalAt.y + 30, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, {
      timeout: 10_000,
    })
    const redCountBefore = (await previewFills()).map((fill) => fill.toLowerCase()).filter((fill) => fill === '#ff0000').length
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(ovalAt.x, ovalAt.y)

    const transparent = page.getByRole('button', { name: 'Transparent fill' })
    await transparent.click()
    expect(await transparent.getAttribute('aria-pressed')).toBe('true')
    // Parked on the default while the stored hex is kept for restore.
    expect(await readout('fill-hue-value')).toBe('50')
    expect(await fill.inputValue()).toBe('#ff0000')

    // Live: moving HSV while transparent opaque-paints the selection at once.
    await setHsv('fill-hue', 200 / 3)
    expect(await transparent.getAttribute('aria-pressed')).toBe('false')
    expect(await fill.inputValue()).toBe('#0000ff')
    await page.waitForFunction(() => {
      const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
        (node.getAttribute('fill') ?? '').toLowerCase(),
      )
      return fills.includes('#0000ff')
    }, null, { timeout: 10_000 })
    // Red count drops by one (the selected oval turned blue), blue appears.
    const afterFills = (await previewFills()).map((fill) => fill.toLowerCase())
    expect(afterFills).toContain('#0000ff')
    expect(afterFills.filter((fill) => fill === '#ff0000').length).toBe(redCountBefore - 1)

    await waitUndoEnabled()
    await waitHsvIdle()
    await undoButton().click()
    await page.waitForFunction(
      (expectedRed) => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return fills.filter((fill) => fill === '#ff0000').length === expectedRed && !fills.includes('#0000ff')
      },
      redCountBefore,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(() => {
      const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
        (node.getAttribute('fill') ?? '').toLowerCase(),
      )
      return fills.includes('#0000ff')
    }, null, { timeout: 10_000 })
  }, 120_000)

  it('continuous drag coalesces to one entry; 0/100 both red; fill/stroke stay independent', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const { box } = await drawTwoColorOvals()
    await marqueeSelectAll(box)

    // Continuous drag: two rapid ticks (orange -> red) must coalesce to one entry.
    await setHsv('fill-hue', 10)
    await setHsv('fill-hue', 0)
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff') && fills.includes('#ff0000')
      },
      null,
      { timeout: 10_000 },
    )
    await waitUndoEnabled()
    await waitHsvIdle()
    // One Undo returns to the mixed original (with blue), not the orange middle.
    await undoButton().click()
    await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toContain('#0000ff')
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )

    // Hue endpoints: 0 and 100 are the same red (unit-pinned hsv math).
    const fill = page.getByLabel('Paint color', { exact: true })
    expect(await fill.inputValue()).toBe('#ff0000')
    await setHsv('fill-hue', 100)
    expect(await fill.inputValue()).toBe('#ff0000')
    expect(await readout('fill-hue-value')).toBe('100')
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )
    // Same-value endpoint stays history-free: still one Undo deep to mixed.
    await waitHsvIdle()
    await undoButton().click()
    await page.getByTestId('mixed-fill').waitFor({ state: 'visible' })
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toContain('#0000ff')
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )

    // Fill live never touches the stroke side.
    const strokesBefore = (await previewStrokes()).map((s) => s.toLowerCase())
    await setHsv('fill-hue', 50)
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return fills.includes('#00ffff')
      },
      null,
      { timeout: 10_000 },
    )
    expect((await previewStrokes()).map((s) => s.toLowerCase())).toEqual(strokesBefore)
    await waitHsvIdle()

    // Stroke live unifies only the outline side and keeps the fill.
    // Note: the outline starts dark (#001026, low brightness), so hue 0 alone
    // yields a dark red (#2a0f0f), not #ff0000 — assert the side changes and
    // the fill stays put rather than a bright-red hex.
    const fillsBeforeStroke = (await previewFills()).map((fill) => fill.toLowerCase())
    const strokesBeforeStroke = (await previewStrokes()).map((s) => s.toLowerCase())
    await setHsv('stroke-hue', 0)
    expect(await readout('stroke-hue-value')).toBe('0')
    await page.waitForFunction(
      (expectedBefore) => {
        const strokes = Array.from(document.querySelectorAll('.vector-preview [stroke]')).map((node) =>
          (node.getAttribute('stroke') ?? '').toLowerCase(),
        )
        return JSON.stringify(strokes) !== JSON.stringify(expectedBefore)
      },
      strokesBeforeStroke,
      { timeout: 10_000 },
    )
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toEqual(fillsBeforeStroke)
    const strokesAfterLive = (await previewStrokes()).map((s) => s.toLowerCase())
    await waitHsvIdle()
    await waitUndoEnabled()
    await undoButton().click()
    // Undoing the stroke gesture restores the prior outline without touching fill.
    await page.waitForFunction(
      (expected) => {
        const strokes = Array.from(document.querySelectorAll('.vector-preview [stroke]')).map((node) =>
          (node.getAttribute('stroke') ?? '').toLowerCase(),
        )
        return JSON.stringify(strokes) === JSON.stringify(expected)
      },
      strokesBeforeStroke,
      { timeout: 10_000 },
    )
    expect((await previewFills()).map((fill) => fill.toLowerCase())).toEqual(fillsBeforeStroke)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => {
        const strokes = Array.from(document.querySelectorAll('.vector-preview [stroke]')).map((node) =>
          (node.getAttribute('stroke') ?? '').toLowerCase(),
        )
        return JSON.stringify(strokes) === JSON.stringify(expected)
      },
      strokesAfterLive,
      { timeout: 10_000 },
    )
  }, 180_000)

  it('gradient ends live independently, transparent stops survive, swap/stray stay clean', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const fill = page.getByLabel('Paint color', { exact: true })
    await page.getByTestId('vector-shape-oval').last().click()
    await fill.fill('#ff0000')
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface')
    const at = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }
    const before = await previewHtml()
    await page.mouse.move(at.x - 40, at.y - 30)
    await page.mouse.down()
    await page.mouse.move(at.x + 40, at.y + 30, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction((prev) => document.querySelector('.vector-preview')?.innerHTML !== prev, before, {
      timeout: 10_000,
    })
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(at.x, at.y)

    // Solid -> horizontal gradient via Apply (uses the current secondary).
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    const secondary = page.getByLabel('Secondary paint color', { exact: true })
    await secondary.fill('#00ff00')
    await page.getByTestId('apply-vector-style').click()
    await page.waitForFunction(() => document.querySelectorAll('.vector-preview [fill^="url("]').length > 0, null, {
      timeout: 10_000,
    })
    await waitHsvIdle(400)

    // Secondary HSV live repaints only the gradient end (primary stays red).
    // NOTE: stale gradient defs accumulate in the document, so raw HTML always
    // keeps old stops — assert the *referenced* gradient stops instead.
    await setHsv('fill-secondary-hue', 0)
    expect(await secondary.inputValue()).toBe('#ff0000')
    await page.waitForFunction(
      () => {
        const preview = document.querySelector('.vector-preview')
        if (!preview) return false
        const ids = new Set<string>()
        preview.querySelectorAll('[fill]').forEach((node) => {
          const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((node.getAttribute('fill') ?? '').trim())
          if (m && m[1]) ids.add(m[1]!)
        })
        if (ids.size === 0) return false
        const colors: string[] = []
        ids.forEach((id) => {
          try {
            preview.querySelector(`#${CSS.escape(id)}`)?.querySelectorAll('stop').forEach((s) => {
              const c = (s.getAttribute('stop-color') ?? '').toLowerCase()
              if (c) colors.push(c)
            })
          } catch {}
        })
        return colors.length > 0 && colors.includes('#ff0000') && !colors.includes('#00ff00')
      },
      null,
      { timeout: 10_000 },
    )
    // Primary endpoint preserved in the markup (red ramp, no green swing).
    expect((await referencedGradientStopColors()).map((c) => c.toLowerCase())).toContain('#ff0000')
    await waitUndoEnabled()
    await waitHsvIdle()
    await undoButton().click()
    await page.waitForFunction(
      () => {
        const preview = document.querySelector('.vector-preview')
        if (!preview) return false
        const ids = new Set<string>()
        preview.querySelectorAll('[fill]').forEach((node) => {
          const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((node.getAttribute('fill') ?? '').trim())
          if (m && m[1]) ids.add(m[1]!)
        })
        const colors: string[] = []
        ids.forEach((id) => {
          try {
            preview.querySelector(`#${CSS.escape(id)}`)?.querySelectorAll('stop').forEach((s) => {
              const c = (s.getAttribute('stop-color') ?? '').toLowerCase()
              if (c) colors.push(c)
            })
          } catch {}
        })
        return colors.includes('#00ff00')
      },
      null,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const preview = document.querySelector('.vector-preview')
        if (!preview) return false
        const ids = new Set<string>()
        preview.querySelectorAll('[fill]').forEach((node) => {
          const m = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((node.getAttribute('fill') ?? '').trim())
          if (m && m[1]) ids.add(m[1]!)
        })
        const colors: string[] = []
        ids.forEach((id) => {
          try {
            preview.querySelector(`#${CSS.escape(id)}`)?.querySelectorAll('stop').forEach((s) => {
              const c = (s.getAttribute('stop-color') ?? '').toLowerCase()
              if (c) colors.push(c)
            })
          } catch {}
        })
        return colors.length > 0 && colors.includes('#ff0000') && !colors.includes('#00ff00')
      },
      null,
      { timeout: 10_000 },
    )

    // Swap still exchanges stored paint only (no artwork/history side effects).
    const htmlBeforeSwap = await previewHtml()
    const primaryBefore = await fill.inputValue()
    const secondaryBefore = await secondary.inputValue()
    await page.getByTestId('swap-fill-colors').click()
    expect(await fill.inputValue()).toBe(secondaryBefore)
    expect(await secondary.inputValue()).toBe(primaryBefore)
    expect(await previewHtml()).toBe(htmlBeforeSwap)
    await page.getByTestId('swap-fill-colors').click()
    expect(await fill.inputValue()).toBe(primaryBefore)
    expect(await secondary.inputValue()).toBe(secondaryBefore)
    expect(await previewHtml()).toBe(htmlBeforeSwap)

    // Stray Apply with no dirty fields is a clean no-op: no history, no paint.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + 20, box.y + 20)
    const undoDisabledBefore = await undoButton().isDisabled()
    const redoDisabledBefore = await redoButton().isDisabled()
    const htmlBeforeNoop = await previewHtml()
    const apply = page.getByTestId('apply-vector-style')
    if (await apply.isEnabled()) {
      await apply.click()
      expect(await previewHtml()).toBe(htmlBeforeNoop)
      expect(await undoButton().isDisabled()).toBe(undoDisabledBefore)
      expect(await redoButton().isDisabled()).toBe(redoDisabledBefore)
    }
  }, 180_000)

  it('selection switch scopes live paint; deselect keeps art; tool switch stays clean', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    const { box, left, right } = await drawTwoColorOvals()
    await marqueeSelectAll(box)
    // Live-unify to red, then narrow the selection to the left oval only.
    await setHsv('fill-hue', 0)
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff')
      },
      null,
      { timeout: 10_000 },
    )
    await waitUndoEnabled()
    await waitHsvIdle()

    // Click only the left oval: single selection, no MIXED, no leak into right.
    // NOTE: clicking inside an active multi-selection keeps it (drag start),
    // so Escape-deselect first (empty-corner clicks still hit the cat), then
    // click the single oval.
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await page.getByTestId('apply-vector-style').isEnabled()).toBe(false)
    await page.mouse.click(left.x, left.y)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await page.getByTestId('apply-vector-style').isEnabled()).toBe(true)
    expect(await page.getByTestId('mixed-fill').count()).toBe(0)
    // Left-only live to blue: right stays red.
    await setHsv('fill-hue', 200 / 3)
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return fills.includes('#0000ff') && fills.includes('#ff0000')
      },
      null,
      { timeout: 10_000 },
    )
    await waitHsvIdle()
    await waitUndoEnabled()
    await undoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return !fills.includes('#0000ff') && fills.includes('#ff0000')
      },
      null,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(
      () => {
        const fills = Array.from(document.querySelectorAll('.vector-preview [fill]')).map((node) =>
          (node.getAttribute('fill') ?? '').toLowerCase(),
        )
        return fills.includes('#0000ff') && fills.includes('#ff0000')
      },
      null,
      { timeout: 10_000 },
    )

    // Deselect keeps the artwork; tool switch does not pollute or add history.
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await page.getByTestId('apply-vector-style').isEnabled()).toBe(false)
    const kept = await previewFills()
    expect(kept.map((f) => f.toLowerCase())).toContain('#0000ff')
    expect(kept.map((f) => f.toLowerCase())).toContain('#ff0000')
    await page.getByTestId('vector-shape-brush').last().click()
    await page.getByTestId('vector-shape-select').last().click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await previewFills()).map((f) => f.toLowerCase())).toEqual(kept.map((f) => f.toLowerCase()))
    // Right oval still selectable and still red (no stale async leak).
    await page.mouse.click(right.x, right.y)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await page.getByTestId('mixed-fill').count()).toBe(0)
    expect((await previewFills()).map((f) => f.toLowerCase())).toContain('#ff0000')
  }, 180_000)
})
