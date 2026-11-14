import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Bitmap-side nudge parity probe (real editor UI).
//
// Reference (`nudge-tool.js`): step = (shift ? 15 : 1) / zoom, clamped into
// getActionBounds() with a 1px margin, one history entry per keyup cycle.
// Current-editor mapping (screen-constant 1px plain / 15px Shift): bitmap
// canvas px reach the screen as `px * realScale`, so one screen px is
// `1 / realScale` canvas px, where `realScale = rect.width / canvas.width`
// (NOT `label/100`: res2 UI "100%" == real 0.5, "67%" == floor 0.333,
// "500%" == 2.5). The integer raster preview truncates toward zero:
// sub-pixel totals accumulate across repeats in one cycle, and a fully
// sub-pixel single press (plain at 500%) stays a history-free no-op.
//
// Harness notes (all learned the hard way):
// - The outline style attribute is browser-serialized with a space after the
//   colon (`left: 47.9167%; ...`); the reader must tolerate `\s*`.
// - A marquee drag issued right after zoom-button clicks intermittently lands
//   off-canvas, so this probe drags exactly twice with no zoom clicks pending
//   and rides one live selection across all zoom levels with chained arrow
//   presses (nudges keep the outline alive).
// - Zoom labels need strict equality: '425%' contains '25%'.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4253'
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

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8, timeout = 15_000) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout },
  )
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function selectionLeftPx(): Promise<number> {
  return await page.evaluate(async () => {
    const outline = document.querySelector('[data-testid="bitmap-selection"]')!
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const style = outline.getAttribute('style') ?? ''
    // The browser serializes the style with a space after the colon.
    const match = /left:\s*([\d.]+)%/.exec(style)
    return (parseFloat(match?.[1] ?? 'NaN') / 100) * target.width
  })
}

async function hasSelection(): Promise<boolean> {
  return await page.evaluate(() => Boolean(document.querySelector('[data-testid="bitmap-selection"]')))
}

async function zoomLabelIs(target: number): Promise<boolean> {
  const label = (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
  return label.trim() === `${target}%`
}

async function setZoom(target: number) {
  const resetZoom = page.getByRole('button', { name: 'Reset zoom' })
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  if (target === 100) {
    await resetZoom.scrollIntoViewIfNeeded().catch(() => {})
    await resetZoom.click()
  } else if (target < 100) {
    for (let i = 0; i < 30; i += 1) {
      if (await zoomLabelIs(target)) break
      await zoomOut.scrollIntoViewIfNeeded().catch(() => {})
      await zoomOut.click()
    }
  } else {
    for (let i = 0; i < 40; i += 1) {
      if (await zoomLabelIs(target)) break
      await zoomIn.scrollIntoViewIfNeeded().catch(() => {})
      await zoomIn.click()
    }
  }
  await page.waitForFunction(
    (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
    target,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(1000)
}

async function selectBlock() {
  await page.getByTestId('bitmap-tool-select').click()
  // Artboard coords (960x720 sprite artboard, center 480,360): 60x30 block
  // at (430,340) with a 5px marquee margin, mirroring the floating suites.
  await dragCanvas({ x: 425, y: 335 }, { x: 495, y: 375 })
  await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 15_000 })
}

async function selectBlockRetry(attempts = 3) {
  // A marquee drag issued right after zoom-button clicks intermittently
  // lands off-canvas; retry the drag until the outline is visible.
  for (let i = 0; i < attempts; i += 1) {
    try {
      await selectBlock()
      return
    } catch {
      if (i === attempts - 1) throw new Error('selectBlock failed after retries')
      await page.waitForTimeout(800)
    }
  }
}

async function diagnoseCanvasPoint(canvasX: number, canvasY: number, tag: string) {
  // Real-DOM evidence for an artwork click target: canvas/surface rects in
  // client coords, the mapped screen point, viewport containment, and the
  // actual element at that point plus zoom/status strings.
  const diag = await page.evaluate(([cx, cy]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
    const canvasRect = canvas.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const x = canvasRect.left + (cx / canvas.width) * canvasRect.width
    const y = canvasRect.top + (cy / canvas.height) * canvasRect.height
    const raw = document.elementFromPoint(x, y) as HTMLElement | null
    const describe = (el: HTMLElement | null) => {
      if (!el) return 'null'
      const testid = el.getAttribute?.('data-testid') ?? el.closest?.('[data-testid]')?.getAttribute('data-testid')
      const cls = typeof el.className === 'string' ? el.className : ''
      return `${el.tagName}${el.id ? `#${el.id}` : ''}${testid ? `[testid=${testid}]` : ''}.${cls.slice(0, 80)}`
    }
    return {
      point: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 },
      canvasRect: { x: Math.round(canvasRect.left), y: Math.round(canvasRect.top), w: Math.round(canvasRect.width), h: Math.round(canvasRect.height) },
      surfaceRect: { x: Math.round(surfaceRect.left), y: Math.round(surfaceRect.top), w: Math.round(surfaceRect.width), h: Math.round(surfaceRect.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      inCanvas: x >= canvasRect.left && x <= canvasRect.right && y >= canvasRect.top && y <= canvasRect.bottom,
      inSurface: x >= surfaceRect.left && x <= surfaceRect.right && y >= surfaceRect.top && y <= surfaceRect.bottom,
      inViewport: x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight,
      elementAtPoint: describe(raw),
      zoomLabel: (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim(),
      hasSelection: Boolean(document.querySelector('[data-testid="bitmap-selection"]')),
      status: (document.body.textContent ?? '').slice(-200),
    }
  }, [canvasX, canvasY])
  console.log(`BITMAP-CLICK-DIAG ${tag} ${JSON.stringify(diag)}`)
  return diag
}

async function resetFixture(tag: string) {
  // Explicit per-case isolation that never touches artworks, costumes,
  // targets, or history: Reset zoom re-centers the viewport (x/y = 0,
  // scale = 1) and Escape clears any live selection/inline draft focus.
  // No reload, no costume/target switch, no history clear.
  const resetZoom = page.getByRole('button', { name: 'Reset zoom' })
  await resetZoom.scrollIntoViewIfNeeded().catch(() => {})
  await resetZoom.click()
  await page.waitForFunction(
    (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
    100,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(600)
  for (let i = 0; i < 3; i += 1) {
    const draft = await page.locator('[data-inline-text-editor]').count()
    if (!(await hasSelection()) && draft === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const label = (await resetZoom.textContent()) ?? ''
  console.log(
    `BITMAP-FIXTURE-RESET ${tag} label:${label.trim()} selection:${await hasSelection()} ` +
      `canvas:${JSON.stringify(await page.getByTestId('bitmap-editor-canvas').boundingBox())} ` +
      `surface:${JSON.stringify(await page.getByTestId('costume-paint-surface').boundingBox())}`,
  )
}

const HOME_X = 430
const PROBE_Y = 345
const RED = [255, 0, 0, 255]
const CLEAR = [0, 0, 0, 0]

async function drawHomeBlock() {
  // Self-contained setup per test: clears the canvas and draws the probe
  // block at HOME, then saves once (brush dot) so later nudges and undos
  // never depend on a previous test's end state.
  await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const context = target.getContext('2d')!
    context.clearRect(0, 0, target.width, target.height)
    context.fillStyle = '#ff0000'
    context.fillRect(430, 340, 60, 30)
  })
  await page.getByTestId('bitmap-tool-brush').click()
  // The anchor dot must land on the live canvas: verify real-DOM viewport
  // bounds + elementFromPoint before clicking. A leftover 500% viewport pans
  // the canvas so (400,400) maps outside the paint surface; recover once via
  // Reset zoom (fit) and re-diagnose. If it is still not clickable, throw
  // with the DOM evidence (zoom-UI bug -> report, do not fix product code).
  let anchorDiag = await diagnoseCanvasPoint(400, 400, 'drawHomeBlock-anchor')
  if (!anchorDiag.inSurface || !anchorDiag.inViewport) {
    console.log(`BITMAP-ANCHOR-RECOVER anchor outside surface/viewport, resetting fit once`)
    await page.getByRole('button', { name: 'Reset zoom' }).click()
    await page.waitForFunction(
      (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
      100,
      { timeout: 10_000 },
    )
    await page.waitForTimeout(600)
    await page.getByTestId('bitmap-tool-brush').click()
    anchorDiag = await diagnoseCanvasPoint(400, 400, 'drawHomeBlock-anchor-retry')
  }
  if (!anchorDiag.inSurface || !anchorDiag.inViewport) {
    throw new Error(
      `drawHomeBlock anchor not clickable after fit reset (zoom UI keeps canvas off-screen?): ${JSON.stringify(anchorDiag)}`,
    )
  }
  const anchor = await toScreen(400, 400)
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.down()
  await page.mouse.up()
  await waitForStatus('Bitmap edit saved')
}

async function pressPlain() {
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(2500)
}

async function pressShift() {
  await page.keyboard.down('Shift')
  try {
    await page.keyboard.press('ArrowRight')
  } finally {
    await page.keyboard.up('Shift')
  }
  await page.waitForTimeout(2500)
}

async function waitForSelectionLeft(expected: number, tolerance = 0.7) {
  // State-based settle (not a fixed sleep): under load the preview chain
  // can land later than the post-press sleep, which used to flake exactly
  // one zoom step and cascade into the entry-count restore below.
  await page.waitForFunction(
    ([want, tol]) => {
      const outline = document.querySelector('[data-testid="bitmap-selection"]')
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
      if (!outline || !target) return false
      const match = /left:\s*([\d.]+)%/.exec(outline.getAttribute('style') ?? '')
      if (!match) return false
      return Math.abs((parseFloat(match[1] ?? 'NaN') / 100) * target.width - (want as number)) <= (tol as number)
    },
    [expected, tolerance] as unknown as undefined,
    { timeout: 15_000 },
  )
}

function expectAbs(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected) <= tolerance).toBe(true)
}

describe('bitmap nudge parity probe (real editor)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4253', '--strictPort'], {
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
    page.on('pageerror', (err) => console.log(`BITMAP-PAGEERROR ${String(err).slice(0, 300)}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`BITMAP-CONSOLE-ERROR ${msg.text().slice(0, 300)}`)
    })
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

  it('measures zoom-aware bitmap nudge steps (screen-constant, integer raster)', async () => {
    // Explicit fit + deselect isolation: the previous case may leave a 500%
    // viewport (anchored pan) that pushes later draw targets off-screen.
    await resetFixture('zoom-ladder')
    // Zoom first: the anchor dot below targets canvas (400, 400), which is
    // only on-screen at low zoom (the canvas overflows the viewport at 100%).
    // Res2 floor is UI "67%" (real 0.333), NOT legacy "25%".
    await setZoom(67)
    await drawHomeBlock()

    // Drag #1 (no zoom clicks pending): the only selection source for the
    // discrete-history check below.
    await selectBlock()
    expectAbs(await selectionLeftPx(), HOME_X, 0.6)

    // Discrete presses are separate press-release cycles, so each commits.
    // At floor "67%" (real 0.333) one screen px is ~3 canvas px: 3 presses
    // move +9 and a single Undo steps back exactly one 3px tick.
    const historyBase = await selectionLeftPx()
    await pressPlain()
    await pressPlain()
    await pressPlain()
    await waitForSelectionLeft(historyBase + 9)
    expect(await hasSelection()).toBe(true)
    const nudged = await selectionLeftPx()
    expectAbs(nudged - historyBase, 9, 0.8)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForPixel(HOME_X + 6, PROBE_Y, RED)
    // +6 (one tick undone), not +0: per-cycle history stays intact.
    expect(await pixel(HOME_X, PROBE_Y)).toEqual(CLEAR)
    console.log(`BITMAP-NUDGE-HISTORY base:${historyBase} nudged:${nudged} (single Undo -> HOME+6)`)

    // Drag #2 (still no zoom clicks since page load apart from the initial
    // setZoom(67)): reselect the +6-offset block for the zoom loop.
    await selectBlock()
    expectAbs(await selectionLeftPx(), HOME_X + 6, 0.8)

    // Zoom loop on one live selection: nudges keep the outline alive, so no
    // reselect (and no post-zoom drag) is needed at any level.
    // Screen-constant 1px plain / 15px Shift divided by the REAL computed
    // scale (rect.width / canvas.width), truncated toward zero for the
    // integer raster (Paper baseline: res2 reset 0.5 / floor 0.333):
    // 100% (0.5): 2 / 30; 67% (0.333): 3 / 45; 500% (2.5): 0 / 6.
    const measured: Record<string, number> = {}
    const apparent: Record<string, number> = {}
    const REAL_SCALE: Record<number, number> = { 100: 0.5, 67: 0.333, 500: 2.5 }
    for (const zoom of [100, 67, 500]) {
      await setZoom(zoom)
      expect(await hasSelection()).toBe(true)
      // Real computed scale from the live rect (label is UI-only).
      const liveScale = await page.evaluate(() => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        return target.getBoundingClientRect().width / target.width
      })
      const scale = liveScale as number
      expect(Math.abs(scale - REAL_SCALE[zoom]!) < 0.05).toBe(true)
      const step = zoom === 500 ? 0 : Math.trunc(1 / scale)
      const shiftStep = Math.trunc(15 / scale)
      const x0 = await selectionLeftPx()
      await pressPlain()
      await waitForSelectionLeft(x0 + step)
      expect(await hasSelection()).toBe(true)
      const x1 = await selectionLeftPx()
      measured[`plain@${zoom}`] = x1 - x0
      apparent[`plain@${zoom}`] = (x1 - x0) * scale
      await pressShift()
      await waitForSelectionLeft(x1 + shiftStep)
      expect(await hasSelection()).toBe(true)
      measured[`shift@${zoom}`] = (await selectionLeftPx()) - x1
      apparent[`shift@${zoom}`] = ((await selectionLeftPx()) - x1) * scale
    }

    console.log(`BITMAP-NUDGE-MEASURED ${JSON.stringify({ measured, apparent })}`)
    expectAbs(measured['plain@100']!, 2, 0.6)
    expectAbs(measured['plain@67']!, 3, 0.6)
    // Plain at 500% is a 0.4px request on an integer raster: no visible move
    // and no history entry (integer-pixel limitation).
    expectAbs(measured['plain@500']!, 0, 0.6)
    expectAbs(measured['shift@100']!, 30, 0.8)
    expectAbs(measured['shift@67']!, 45, 0.8)
    expectAbs(measured['shift@500']!, 6, 0.6)
    // Apparent travel is screen-constant wherever the raster can represent it.
    expectAbs(apparent['plain@100']!, 1, 0.6)
    expectAbs(apparent['plain@67']!, 1, 0.6)
    expectAbs(apparent['shift@100']!, 15, 1)
    expectAbs(apparent['shift@67']!, 15, 1)
    expectAbs(apparent['shift@500']!, 15, 1)

    // Entry granularity for the loop: one Undo steps back exactly the last
    // press (shift@500, 6px) and one Redo re-applies it. (A deeper unwind is
    // covered on the vector side, where state is not subject to the bitmap
    // canvas reload ordering.)
    // Totals: start HOME+6=436; 100%: +2=438, +30=468; 67%: +3=471, +45=516;
    // 500%: +0=516, +6=522 = HOME+92. Undo -> 516 (HOME+86).
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForPixel(HOME_X + 86, PROBE_Y, RED, 8, 30_000)
    expect(await pixel(HOME_X + 86, PROBE_Y)).toEqual(RED)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForPixel(HOME_X + 92, PROBE_Y, RED, 8, 30_000)
    expect(await pixel(HOME_X + 92, PROBE_Y)).toEqual(RED)
  }, 240_000)

  it('coalesces repeated keydowns into one keyup history entry (long-press)', async () => {
    // Explicit fit + deselect isolation: the zoom loop above ends at 500%,
    // so the draw anchor below would map outside the paint surface without
    // a deterministic fit reset first.
    await resetFixture('long-press')
    // Same zoom-first setup: the anchor dot needs an on-screen target.
    // Res2 floor is UI "67%" (real 0.333).
    await setZoom(67)
    await drawHomeBlock()
    await setZoom(100)
    await selectBlockRetry()
    const historyBase = await selectionLeftPx()

    // One press-release cycle with 5 keydowns at UI "100%" (real 0.5): each
    // requests 2 canvas px, all share the pending session and commit once on
    // keyup (+10 total).
    await page.evaluate(() => {
      const init = { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new KeyboardEvent('keydown', init))
    })
    await waitForSelectionLeft(historyBase + 10)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(1500)
    expect(await hasSelection()).toBe(true)
    const nudged = await selectionLeftPx()
    expectAbs(nudged - historyBase, 10, 0.8)

    // A single Undo restores the whole cycle; Redo re-applies it. Undo
    // reloads the canvas (clearing the outline), so the round-trip is
    // pixel-synchronized rather than outline-synchronized.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForPixel(Math.round(historyBase), PROBE_Y, RED)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForPixel(Math.round(nudged), PROBE_Y, RED)
    console.log(`BITMAP-NUDGE-COALESCE base:${historyBase} nudged:${nudged} (single Undo/Redo round-trip)`)
  }, 120_000)

  it('keeps keyboard input out of the canvas (inline-text cancel parity)', async () => {
    // Explicit fit + deselect isolation: never inherit the long-press zoom
    // or a live outline; the text click below needs a centered canvas.
    await resetFixture('inline-text')
    await setZoom(100)
    await page.getByTestId('bitmap-tool-text').click()
    const textDiag = await diagnoseCanvasPoint(480, 360, 'inline-text-center')
    if (!textDiag.inSurface || !textDiag.inViewport) {
      throw new Error(`inline-text center not clickable after fit reset: ${JSON.stringify(textDiag)}`)
    }
    const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!canvasBox) throw new Error('Missing bitmap canvas')
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
    const editor = page.locator('[data-inline-text-editor]')
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await editor.pressSequentially('ab')
    expect(await hasSelection()).toBe(false)
    // Arrows held by the textarea must not move or create any selection.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    expect(await hasSelection()).toBe(false)
    // Escape commits the draft (exactly one history entry for the text).
    await page.keyboard.press('Escape')
    await waitForStatus('Bitmap text saved')
    expect(await hasSelection()).toBe(false)
  }, 120_000)
})
