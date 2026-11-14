import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Vector nudge parity probe (real editor UI).
//
// Reference (`nudge-tool.js`): one arrow keydown translates by
// `1 / paper.view.zoom` document units (Shift x15) with a 1px-margin clamp,
// and the history entry commits on keyup -- a held key yields N keydown
// translations but a single history entry per press-release cycle.
//
// Current-editor mapping (screen-constant 1px plain / 15px Shift):
// vector SVG units reach the screen as `svg * 5 * realScale`, so one
// screen px is `1 / (5 * realScale)` SVG units, where
// `realScale = surfaceRect.width / 2400` (NOT `label/100`: vector UI "100%"
// == real 0.2, "67%" == floor 0.1332, "500%" == 1.0). Bitmap canvas px map
// as `px * scale` (see the bitmap probe for the integer-pixel truncation).
// This test asserts the measured document deltas, the apparent screen
// travel, the keyup coalescing, and the no-op guards against the new Paper
// baseline (reset 0.5 / floor 0.333 at density 2.5).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4252'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function lastVectorX(svgText: string): Promise<number> {
  return await page.evaluate(async (svg: string) => {
    const { paperVectorObjectList } = await import(
      /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
    )
    const list = await paperVectorObjectList(svg)
    const last = list.at(-1) as any
    return last.boundsX as number
  }, svgText)
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 10_000 },
  )
}

async function waitForPreviewTo(want: string) {
  // Exact-match settle for Undo/Redo: rapid clicks must never overlap the
  // async restore, or two clicks can read the same stack top and lose a step.
  await page.waitForFunction(
    (next) => document.querySelector('.vector-preview')?.innerHTML === next,
    want,
    { timeout: 15_000 },
  )
}

async function zoomLabel(): Promise<string> {
  return (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
}

async function zoomLabelIs(target: number): Promise<boolean> {
  const label = (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
  // Strict equality: '425%' contains '25%' as a substring (same trap as the
  // bitmap probe had when zooming out from 500%).
  return label.trim() === `${target}%`
}

async function setZoom(target: number) {
  if (target === 100) {
    await page.getByRole('button', { name: 'Reset zoom' }).click()
  } else if (target < 100) {
    for (let i = 0; i < 30; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom out' }).click()
    }
  } else {
    for (let i = 0; i < 40; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom in' }).click()
    }
  }
  // Strict UI-label equality: '67%' must not match '167%'.
  await page.waitForFunction(
    (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
    target,
    { timeout: 10_000 },
  )
  // Let the density-aware viewport settle before measuring the real scale.
  await page.waitForTimeout(600)
}

async function realVectorScale(): Promise<number> {
  return await page.evaluate(() => {
    const surface = document.querySelector('[data-vector-stage-surface]')!
    return surface.getBoundingClientRect().width / 2400
  })
}

async function singleNudgeDx(key: 'ArrowRight'): Promise<number> {
  const before = await previewSvg()
  const x0 = await lastVectorX(before)
  await page.keyboard.press(key)
  await waitForPreviewChange(before)
  const after = await previewSvg()
  return (await lastVectorX(after)) - x0
}

async function singleShiftNudgeDx(key: 'ArrowRight'): Promise<number> {
  const before = await previewSvg()
  const x0 = await lastVectorX(before)
  await page.keyboard.down('Shift')
  try {
    await page.keyboard.press(key)
  } finally {
    await page.keyboard.up('Shift')
  }
  await waitForPreviewChange(before)
  const after = await previewSvg()
  return (await lastVectorX(after)) - x0
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

function expectAbs(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected) <= tolerance).toBe(true)
}

describe('nudge-tool parity probe (real editor)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4252', '--strictPort'], {
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
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('measures zoom-aware vector nudge steps (screen-constant 1px / 15px)', async () => {
    const surface = page.getByTestId('costume-paint-surface')
    await page.getByTestId('vector-shape-rect').last().click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const dragTop = box.y + box.height / 2 - 60
    await page.mouse.move(box.x + box.width / 2 - 110, dragTop)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 60, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.innerHTML.includes('<rect'),
      null,
      { timeout: 10_000 },
    )
    await page.getByTestId('vector-shape-select').click()

    const measured: Record<string, number> = {}
    const realScales: Record<string, number> = {}

    // Per-mode Paper band (density 2.5): reset 0.2 ("100%"), floor 0.1332
    // ("67%"), "500%" == 1.0. Legacy "25%" does not exist in vector mode.
    for (const zoom of [100, 67, 500]) {
      await setZoom(zoom)
      realScales[`${zoom}`] = await realVectorScale()
      measured[`plain@${zoom}`] = await singleNudgeDx('ArrowRight')
      measured[`shift@${zoom}`] = await singleShiftNudgeDx('ArrowRight')
    }

    // Zoom-aware steps: 1 screen px plain (15 with Shift) divided by the
    // 5x art-box upscale and the REAL computed scale (Paper baseline:
    // reset 0.5/2.5 = 0.2, floor 0.333/2.5 ~= 0.1332).
    // 100% (0.2): 1.0 / 15; 67% (0.1332): 1.5 / 22.5; 500% (1.0): 0.2 / 3.
    console.log(`NUDGE-MEASURED ${JSON.stringify({ zoomLabel: await zoomLabel(), measured, realScales })}`)
    expect(Math.abs(realScales['100']! - 0.2) < 0.03).toBe(true)
    expect(Math.abs(realScales['67']! - 0.1332) < 0.02).toBe(true)
    expect(Math.abs(realScales['500']! - 1) < 0.05).toBe(true)
    expectAbs(measured['plain@100']!, 1, 0.08)
    expectAbs(measured['shift@100']!, 15, 0.4)
    expectAbs(measured['plain@67']!, 1.5, 0.12)
    expectAbs(measured['shift@67']!, 22.5, 0.6)
    expectAbs(measured['plain@500']!, 0.2, 0.03)
    expectAbs(measured['shift@500']!, 3, 0.08)

    // Apparent travel stays screen-constant: docDelta * 5 * realScale.
    const apparent = (docDelta: number, realScale: number) => docDelta * 5 * realScale
    for (const zoom of [100, 67, 500]) {
      expectAbs(apparent(measured[`plain@${zoom}`]!, realScales[`${zoom}`]!), 1, 0.2)
      expectAbs(apparent(measured[`shift@${zoom}`]!, realScales[`${zoom}`]!), 15, 0.8)
    }
  }, 180_000)

  it('coalesces repeated keydowns into one keyup history entry (long-press Undo/Redo)', async () => {
    await setZoom(100)
    await page.getByTestId('vector-shape-select').click()
    const historyBase = await previewSvg()
    const x0 = await lastVectorX(historyBase)

    // One press-release cycle with 5 keydowns: synthetic repeats share the
    // pending session (no keyup between them), so they commit once.
    await page.evaluate(() => {
      const init = { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new KeyboardEvent('keydown', init))
    })
    await waitForPreviewChange(historyBase)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(800)
    const nudged = await previewSvg()
    expect(nudged).not.toBe(historyBase)
    // 5 repeats x 1.0 SVG units at UI "100%" (real 0.2, Paper baseline).
    expectAbs((await lastVectorX(nudged)) - x0, 5.0, 0.3)

    // A single Undo restores the whole cycle (reference keyup parity);
    // a second Undo must move further back, proving only one entry exists.
    await undoButton().click()
    await waitForPreviewTo(historyBase)
    expect(await previewSvg()).toBe(historyBase)
    await undoButton().click()
    await page.waitForFunction(
      (base) => document.querySelector('.vector-preview')?.innerHTML !== base,
      historyBase,
      { timeout: 15_000 },
    )
    expect(await previewSvg()).not.toBe(historyBase)

    // Redo twice walks forward through both entries again.
    await redoButton().click()
    await waitForPreviewTo(historyBase)
    expect(await previewSvg()).toBe(historyBase)
    await redoButton().click()
    await waitForPreviewTo(nudged)
    expect(await previewSvg()).toBe(nudged)
    console.log('NUDGE-HISTORY single Undo restored the 5-keydown cycle; Redo re-applied it')
  }, 120_000)

  it('ignores inside/outside clicks for history (selection only)', async () => {
    await setZoom(100)
    await page.getByTestId('vector-shape-select').click()
    const historyBase = await previewSvg()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')

    // Inside click hits the rect (selects, no artwork write).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(600)
    expect(await previewSvg()).toBe(historyBase)

    // Outside click misses (deselect marquee, no artwork write).
    await page.mouse.click(box.x + 12, box.y + 12)
    await page.waitForTimeout(600)
    expect(await previewSvg()).toBe(historyBase)

    // Neither click wrote history: Undo reverts the older nudge entry, not
    // a click entry.
    await undoButton().click()
    await page.waitForFunction(
      (base) => document.querySelector('.vector-preview')?.innerHTML !== base,
      historyBase,
      { timeout: 15_000 },
    )
    expect(await previewSvg()).not.toBe(historyBase)
    await redoButton().click()
    await waitForPreviewTo(historyBase)
    expect(await previewSvg()).toBe(historyBase)
  }, 120_000)

  it('adds reshape points with the zoom-aware budget; far clicks stay no-ops', async () => {
    await setZoom(100)
    await page.getByTestId('vector-shape-select').click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    // Re-select the rect (the outside-click probe above deselected it).
    // Container-center click still lands inside the rect (rect is ~48px below
    // the outer-container center due to the toolbar offset, but 220x120 makes
    // the center hit).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(600)
    await page.getByTestId('vector-shape-reshape').click()
    await page.waitForFunction(() => document.querySelector('[data-reshape-curve-layer]') !== null, null, {
      timeout: 10_000,
    })

    // Click the rect's top edge midpoint. Geometry must anchor on the LIVE
    // curve layer (real DOM rect), NOT the outer-container box: the outer
    // `costume-paint-surface` box includes the zoom toolbar (~48px), so the
    // creation drag's screen center maps ~48px below the container center and
    // a container-relative (cx, cy-60) click lands above the hit layer.
    // Edge = layer top + pad (10 SVG units * 5 workspace * realScale).
    const edge = await page.evaluate(() => {
      const layer = document.querySelector('[data-reshape-curve-layer]') as HTMLElement | null
      const stage = document.querySelector('[data-vector-stage-surface]')!
      if (!layer) return null
      const r = layer.getBoundingClientRect()
      const realScale = stage.getBoundingClientRect().width / 2400
      const padScreen = 10 * 5 * realScale
      return { x: r.left + r.width / 2, y: r.top + padScreen + 1, layer: { x: r.x, y: r.y, w: r.width, h: r.height }, realScale }
    })
    if (!edge) throw new Error('Missing reshape curve layer after selecting reshape tool')
    console.log(`RESHAPE-EDGE ${JSON.stringify(edge)}`)
    const before = await previewSvg()
    await page.mouse.click(edge.x, edge.y)
    await waitForPreviewChange(before)
    const added = await previewSvg()
    expect(added).not.toBe(before)

    // A far-away click is too far from any curve: no-op without history.
    await page.mouse.click(box.x + 14, box.y + 14)
    await page.waitForTimeout(800)
    expect(await previewSvg()).toBe(added)

    // Undo reverts the add itself (the far click wrote no entry).
    await undoButton().click()
    await waitForPreviewTo(before)
    expect(await previewSvg()).toBe(before)
    await redoButton().click()
    await waitForPreviewTo(added)
    expect(await previewSvg()).toBe(added)
    await page.getByTestId('vector-shape-select').click()
  }, 120_000)

  it('keeps keyboard input out of the canvas (inline-text cancel parity)', async () => {
    await setZoom(100)
    await page.getByTestId('vector-shape-text').click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 120)
    const editor = page.locator('[data-inline-text-editor]')
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    const before = await previewSvg()
    await editor.pressSequentially('ab')
    // Arrows held by the textarea must not nudge the artwork.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    expect(await previewSvg()).toBe(before)
    // Escape commits the draft exactly once.
    await page.keyboard.press('Escape')
    await waitForPreviewChange(before)
    expect(await previewSvg()).not.toBe(before)
    await undoButton().click()
    await waitForPreviewTo(before)
    expect(await previewSvg()).toBe(before)
    await page.getByTestId('vector-shape-select').click()
  }, 120_000)

  it('checks the pure parity table (reference vs screen-constant steps)', async () => {
    const table = await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ '/src/features/costumes/nudge-parity.ts'
      )
      return mod.buildNudgeParityTable([0.25, 1, 5])
    })
    // Legacy paper-unit reference is unchanged: 25% plain 4 / shift 60;
    // 500% plain 0.2 / shift 3.
    expect(table.find((r: any) => r.zoom === 0.25 && !r.shift)?.reference).toBeCloseTo(4, 5)
    expect(table.find((r: any) => r.zoom === 0.25 && r.shift)?.reference).toBeCloseTo(60, 5)
    expect(table.find((r: any) => r.zoom === 5 && !r.shift)?.reference).toBeCloseTo(0.2, 5)
    expect(table.find((r: any) => r.zoom === 5 && r.shift)?.reference).toBeCloseTo(3, 5)
    // Fixed-step snapshots of the pre-fix implementation stay documented.
    expect(table.find((r: any) => r.zoom === 5 && !r.shift)?.currentVector).toBe(1)
    expect(table.find((r: any) => r.zoom === 1 && r.shift)?.currentBitmap).toBe(10)

    // Screen-constant steps actually used by the editor.
    const steps = await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ '/src/features/costumes/nudge-parity.ts'
      )
      return {
        vectorPlain100: mod.referenceVectorNudgeStep(1, false),
        vectorShift100: mod.referenceVectorNudgeStep(1, true),
        vectorPlain25: mod.referenceVectorNudgeStep(0.25, false),
        bitmapPlain25: mod.referenceBitmapNudgeStep(0.25, false),
        bitmapShift500: mod.referenceBitmapNudgeStep(5, true),
        screenVector: mod.screenPxForVectorStep(0.2, 1),
        screenBitmap: mod.screenPxForBitmapStep(1, 1),
      }
    })
    expect(steps.vectorPlain100).toBeCloseTo(0.2, 5)
    expect(steps.vectorShift100).toBeCloseTo(3, 5)
    expect(steps.vectorPlain25).toBeCloseTo(0.8, 5)
    expect(steps.bitmapPlain25).toBeCloseTo(4, 5)
    expect(steps.bitmapShift500).toBeCloseTo(3, 5)
    // One screen px of apparent travel in each mode's own units.
    expect(steps.screenVector).toBeCloseTo(1, 5)
    expect(steps.screenBitmap).toBeCloseTo(1, 5)
  }, 30_000)
})
