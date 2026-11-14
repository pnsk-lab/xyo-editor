import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor E2E for the floating bitmap selection wiring
// (`bitmap-floating-session.ts` + `Editor.svelte` / `BitmapEditor.svelte`).
// Drives the actual paint surface: select-tool marquee, inside-selection
// move drags (plain + Alt-duplicate), a partially-offscreen drag (canvas
// clipping, drag path leaves the surface so the pointer-capture flow is
// exercised), toolbar 90-degree rotation scoped to the selection, the SE
// scale handle, Esc cancellation, single-entry Undo/Redo peeling, a move at
// a different zoom (viewport-scale mapping), and a final eyedropper/brush
// sanity check proving the other tools still work.
// Pixel assertions read the live `bitmap-editor-canvas`, covering:
// transparent-hole preservation (source-over), semi-transparent blending,
// untouched far pixels, and exact history behavior.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4245'
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
  // Never label/100 as the scale; use realCssScale() (Paper basis).
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
  // Per-mode Paper floor: sprite conversion yields res2 960-wide canvas,
  // floor UI "67%" (CSS 0.333). Click until the UI label stabilizes.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
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
  console.log(`[floating] zoom-floor ui=${ui} css=${css}`)
  return { ui, css }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function dragCanvas(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const a = await toScreen(from.x, from.y)
  const b = await toScreen(to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

// Pan the viewport (real wheel gesture) so a canvas point lands on the
// paint-surface center, then verify screen-space hittability. At high zoom
// the 455x451 surface shows only a ~227x225 canvas-px window around the
// zoom anchor (canvas center 480,360 at 200%): points outside that window
// map outside the surface/viewport (elementFromPoint null, or a footer
// button/resizer), so the canvas gesture ignores the mousedown and the
// status wait times out. Panning keeps the zoom scale intact while making
// the same canvas coords hittable, so the zoom-mapping + pixel asserts
// below stay meaningful.
async function panCanvasPointToSurfaceCenter(cx: number, cy: number) {
  for (let i = 0; i < 10; i += 1) {
    const pos = await page.evaluate(
      ([px, py]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
        const cr = canvas.getBoundingClientRect()
        const sr = surface.getBoundingClientRect()
        return {
          sx: cr.left + (px / canvas.width) * cr.width,
          sy: cr.top + (py / canvas.height) * cr.height,
          ccx: sr.left + sr.width / 2,
          ccy: sr.top + sr.height / 2,
        }
      },
      [cx, cy] as unknown as undefined,
    )
    const dx = (pos as { sx: number; sy: number; ccx: number; ccy: number }).sx - (pos as { ccx: number }).ccx
    const dy = (pos as { sy: number; ccy: number }).sy - (pos as { ccy: number }).ccy
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) break
    await page.mouse.move((pos as { ccx: number; ccy: number }).ccx, (pos as { ccy: number }).ccy)
    // Plain (non-ctrl) wheel pans the viewport by screen-px deltas
    // (viewportX -= dx, viewportY -= dy), scale unchanged.
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(120)
  }
}

async function expectCanvasHit(cx: number, cy: number) {
  const hit = await page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const surface = document.querySelector('[data-testid="costume-paint-surface"]')!
      const cr = canvas.getBoundingClientRect()
      const sr = surface.getBoundingClientRect()
      const sx = cr.left + (px / canvas.width) * cr.width
      const sy = cr.top + (py / canvas.height) * cr.height
      const el = document.elementFromPoint(sx, sy)
      const testid = (el as HTMLElement | null)?.closest?.('[data-testid]')?.getAttribute('data-testid')
      return {
        sx,
        sy,
        inViewport: sx >= 0 && sx < window.innerWidth && sy >= 0 && sy < window.innerHeight,
        inSurface: sx >= sr.left && sx <= sr.right && sy >= sr.top && sy <= sr.bottom,
        testid: testid ?? null,
      }
    },
    [cx, cy] as unknown as undefined,
  )
  const h = hit as { sx: number; sy: number; inViewport: boolean; inSurface: boolean; testid: string | null }
  if (!h.inViewport || !h.inSurface || h.testid !== 'bitmap-editor-canvas') {
    throw new Error(
      `Canvas point (${cx},${cy}) not hittable: screen=(${h.sx.toFixed(1)},${h.sy.toFixed(1)}) inViewport=${h.inViewport} inSurface=${h.inSurface} testid=${h.testid}`,
    )
  }
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 2) {
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
  // Serializes fire-and-forget commits: every saveBitmapCostume sets `status`
  // only after the VM asset write lands, so the next capture reads settled
  // bytes instead of racing the previous PNG encode.
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 10_000 },
  )
}

async function waitForSelectionSize(width: number, height: number) {  await page.waitForFunction(
    ([wantW, wantH]) => {
      const outline = document.querySelector('[data-testid="bitmap-selection"]')
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      if (!outline) return false
      const outlineBox = outline.getBoundingClientRect()
      const canvasBox = target.getBoundingClientRect()
      return (
        Math.abs(outlineBox.width - (canvasBox.width * (wantW as number)) / target.width) < 5 &&
        Math.abs(outlineBox.height - (canvasBox.height * (wantH as number)) / target.height) < 5
      )
    },
    [width, height] as unknown as undefined,
    { timeout: 10_000 },
  )
}

describe('floating bitmap selection on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4245', '--strictPort'], {
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

  it('moves with transparent holes, duplicates with Alt, clips offscreen, scales, rotates, cancels, and undo/redo as single entries', async () => {
    // Zoom to the res2 Paper reset (UI "100%" = CSS 0.5, 480 CSS px) for the
    // main sequence: even canvas deltas map to integer screen px
    // (+100->50, +40->20, +500->250, +60->30), so the 1px semi pixel never
    // rounds. The floor (UI 67%) is only needed for the later nudge step.
    // Label is UI only; toScreen() uses the live rect (Paper basis).
    for (let i = 0; i < 15; i += 1) {
      const cur = await zoomUiLabel()
      if (cur === '100%') break
      if (cur.includes('67%') || Number.parseFloat(cur) < 100) await page.getByRole('button', { name: 'Zoom in' }).click()
      else await page.getByRole('button', { name: 'Zoom out' }).click()
      await page.waitForTimeout(150)
    }
    {
      const ui0 = await zoomUiLabel()
      const css0 = await realCssScale()
      console.log(`[floating] zoom-reset ui=${ui0} css=${css0}`)
      expect(ui0).toContain('100%')
      expect(Math.abs(css0 - 0.5)).toBeLessThan(0.05)
    }

    // Deterministic artwork near the canvas center: red 60x30 block with a
    // transparent 10x10 hole holding one semi-transparent pixel at its
    // corner (drawn over transparency so it stays semi), and a small green
    // marker where the hole's interior will land after the (+100, +40) move.
    // Canvas coords are artboard pixels (960x720, center 480,360).
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#ff0000'
      context.fillRect(430, 340, 60, 30)
      context.clearRect(450, 348, 10, 10)
      context.fillStyle = 'rgba(255,0,0,0.5)'
      context.fillRect(451, 349, 1, 1)
      context.fillStyle = '#00ff00'
      context.fillRect(554, 392, 6, 6)
    })

    // Commit the setup artwork through a real brush dot so the VM asset and
    // history include it: later Undos restore these pixels (evaluate painting
    // alone never touches the asset store). The dot at (200, 500) stays
    // untouched by every later step, and its horizontal mirror (759, 500)
    // stays empty so the whole-canvas flip check is unambiguous.
    await page.getByTestId('bitmap-tool-brush').click()
    const anchorHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    const anchorRgb = [0, 1, 2].map((i) => parseInt(anchorHex.slice(1 + i * 2, 3 + i * 2), 16))
    const anchor = await toScreen(200, 500)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.up()
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(200, 500, [...anchorRgb, 255], 8)

    await page.getByTestId('bitmap-tool-select').click()
    // Marquee over the block (green marker stays outside the drag rect).
    await dragCanvas({ x: 425, y: 335 }, { x: 495, y: 375 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(60, 30)

    // 1. Partially-offscreen drag (+500, 0): the destination (930, 340)
    // clips to a 30px strip, the drag path leaves the paint surface (the
    // viewport pointer-capture flow keeps it alive), and the source hole is
    // punched. At reset CSS 0.5 the screen delta is exactly 250px.
    await dragCanvas({ x: 460, y: 355 }, { x: 960, y: 355 })
    // (950, 365) is dest-local (25, 25): opaque red, clear of the hole at
    // local (25, 13, 10, 10).
    await waitForStatus('Bitmap selection moved')
    await waitForPixel(950, 365, [255, 0, 0, 255])
    expect(await pixel(950, 365)).toEqual([255, 0, 0, 255])
    expect(await pixel(435, 345)).toEqual([0, 0, 0, 0])
    expect(await pixel(554, 392)).toEqual([0, 255, 0, 255])
    // Single history entry: one Undo restores the block.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(435, 345, [255, 0, 0, 255])
    expect(await pixel(950, 365)).toEqual([0, 0, 0, 0])
    // Deselect, then re-select the restored block for the main sequence.
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    await dragCanvas({ x: 425, y: 335 }, { x: 495, y: 375 })
    await waitForSelectionSize(60, 30)

    // 2. Plain move (+100, +40): opaque pixels replace, transparent patch
    // pixels preserve both the transparent background (hole corner stays
    // transparent) and the green marker (source-over), the semi pixel
    // survives with its alpha over transparency, the source is punched, and
    // far pixels are untouched. At reset CSS 0.5 the screen deltas
    // (50/20px) are exact, so the 1px semi pixel never rounds.
    await dragCanvas({ x: 460, y: 355 }, { x: 560, y: 395 })
    await waitForStatus('Bitmap selection moved')
    await waitForPixel(540, 390, [255, 0, 0, 255])
    expect(await pixel(540, 390)).toEqual([255, 0, 0, 255])
    expect(await pixel(550, 388)).toEqual([0, 0, 0, 0])
    const semi = await pixel(551, 389)
    expect(semi[0]).toBeGreaterThan(200)
    expect(semi[3]).toBeGreaterThan(100)
    expect(semi[3]).toBeLessThan(160)
    expect(await pixel(556, 394)).toEqual([0, 255, 0, 255])
    expect(await pixel(435, 345)).toEqual([0, 0, 0, 0])
    expect(await pixel(0, 0)).toEqual([0, 0, 0, 0])

    // 3. Alt-duplicate (+0, +60): the source stays, the clone moves.
    // At reset CSS 0.5 the screen delta is exactly 30px.
    await page.keyboard.down('Alt')
    try {
      const from = await toScreen(560, 395)
      const to = await toScreen(560, 455)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
    } finally {
      await page.keyboard.up('Alt')
    }
    await waitForStatus('Bitmap selection duplicated')
    await waitForPixel(540, 450, [255, 0, 0, 255])
    expect(await pixel(540, 390)).toEqual([255, 0, 0, 255])
    expect(await pixel(540, 450)).toEqual([255, 0, 0, 255])

    // 4. Toolbar rotate right: the 60x30 selection rotates in place to 30x60
    // around its center (555, 450) -> (540, 420); the canvas size is kept.
    await page.getByRole('button', { name: 'Rotate right' }).click()
    await waitForStatus('Bitmap rotated right')
    await waitForSelectionSize(30, 60)
    expect(await canvasSize()).toEqual({ width: 960, height: 720 })
    expect(await pixel(550, 430)).toEqual([255, 0, 0, 255])

    // 5. SE handle scale to 2x: (540, 420, 30, 60) -> (540, 420, 60, 120).
    const handle = page.getByTestId('bitmap-floating-scale-handle')
    await handle.waitFor({ state: 'visible' })
    const handleBox = await handle.boundingBox()
    if (!handleBox) throw new Error('Missing scale handle')
    const size = await canvasSize()
    const canvasBox = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    if (!canvasBox) throw new Error('Missing bitmap canvas')
    const dxScreen = (30 / size.width) * canvasBox.width
    const dyScreen = (60 / size.height) * canvasBox.height
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + handleBox.width / 2 + dxScreen, handleBox.y + handleBox.height / 2 + dyScreen, { steps: 12 })
    await page.mouse.up()
    await waitForStatus('Bitmap selection scaled')
    await waitForSelectionSize(60, 120)
    expect(await pixel(595, 535)).toEqual([255, 0, 0, 255])

    // 6. Single-entry history: two undos peel scale then rotate, two redos
    // reapply them in order. Pixels (not the outline) prove the peeling:
    // the selection outline is UI state and is not part of asset history.
    // Post-scale: (595,535) red. Pre-scale (post-rotate 30x60): it is
    // transparent while (550,430) stays red. Pre-rotate (post-dup 60x30):
    // (540,450) red while (550,430) is transparent.
    // Undo repaints asynchronously: the canvas is cleared first and redrawn
    // after the PNG decodes, so a transparent pixel proves nothing on its
    // own. Every undo/redo below waits for a status update (set after the
    // redraw lands) plus a red pixel that only the restored state has.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(550, 430, [255, 0, 0, 255])
    expect(await pixel(595, 535)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(540, 450, [255, 0, 0, 255])
    expect(await pixel(550, 430)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(550, 430, [255, 0, 0, 255])
    expect(await pixel(535, 450)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(595, 535, [255, 0, 0, 255])

    // 7. Esc cancels a drag: re-select the scaled block first (undo/redo
    // reloads drop the outline), prove the drag preview is live, then cancel
    // it. The preview is discarded, no history is added, so the next Undo
    // still peels the scale (not a phantom drag entry).
    await dragCanvas({ x: 540, y: 420 }, { x: 610, y: 550 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(60, 120)
    const cancelFrom = await toScreen(575, 485)
    const cancelTo = await toScreen(615, 485)
    await page.mouse.move(cancelFrom.x, cancelFrom.y)
    await page.mouse.down()
    await page.mouse.move(cancelTo.x, cancelTo.y, { steps: 6 })
    // The preview moved the block +40px (20 screen px at reset 0.5):
    // (630, 430) is preview-only.
    await waitForPixel(630, 430, [255, 0, 0, 255])
    await page.keyboard.press('Escape')
    await waitForStatus('Selection cleared')
    await page.mouse.up()
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    expect(await pixel(550, 430)).toEqual([255, 0, 0, 255])
    expect(await pixel(630, 430)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(550, 430, [255, 0, 0, 255])
    expect(await pixel(595, 535)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    await waitForPixel(595, 535, [255, 0, 0, 255])

    // 8. Move at a different zoom: zoom in and verify the canvas mapping.
    // From reset (UI 100% = CSS 0.5) four button steps reach UI 500%
    // (CSS 2.5). Label is UI only; the real CSS scale is measured
    // for the log (Paper basis).
    for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForFunction(() => {
      const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
      return !label.includes('100%')
    }, null, { timeout: 10_000 })
    {
      const ui8 = await zoomUiLabel()
      const css8 = await realCssScale()
      console.log(`[floating] step8 zoom ui=${ui8} css=${css8}`)
      expect(ui8).toContain('500%')
      expect(Math.abs(css8 - 2.5)).toBeLessThan(0.1)
    }
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    // At UI 500% (CSS 2.5) the surface shows only a small canvas-px window
    // around the zoom anchor (canvas center 480,360): marquee end (610,550)
    // maps outside the 800px viewport (elementFromPoint null) and the drag
    // points hit the footer button/resizer, so the gesture is ignored and
    // the status wait times out. Pan canvas (575,485) — the marquee bbox
    // center — to the surface center with a real wheel gesture (scale
    // unchanged), then run the SAME marquee/drag/pixel asserts.
    await panCanvasPointToSurfaceCenter(575, 485)
    await expectCanvasHit(540, 420)
    await expectCanvasHit(610, 550)
    await expectCanvasHit(575, 485)
    await expectCanvasHit(595, 485)
    await dragCanvas({ x: 540, y: 420 }, { x: 610, y: 550 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await waitForSelectionSize(60, 120)
    await dragCanvas({ x: 575, y: 485 }, { x: 595, y: 485 })
    await waitForStatus('Bitmap selection moved')
    await waitForPixel(615, 430, [255, 0, 0, 255])
    expect(await pixel(615, 430)).toEqual([255, 0, 0, 255])

    // 9. The eyedropper and brush still work after the floating wiring.
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'hidden' })
    await page.getByTestId('bitmap-tool-brush').click()
    const paintHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
    // Step 8 panned the UI 500% (CSS 2.5) viewport to (575,485): canvas (780,360) now
    // maps outside the surface (x≈914 > surface right 732), so the mousedown
    // would land off-artwork and no commit follows. Pan it to the surface
    // center first (scale unchanged); the painted bytes/pixel asserts stay.
    await panCanvasPointToSurfaceCenter(780, 360)
    await expectCanvasHit(780, 360)
    const dot = await toScreen(780, 360)
    await page.mouse.move(dot.x, dot.y)
    await page.mouse.down()
    await page.mouse.up()
    const paintRgb = [0, 1, 2].map((i) => parseInt(paintHex.slice(1 + i * 2, 3 + i * 2), 16))
    await waitForStatus('Bitmap edit saved')
    await waitForPixel(780, 360, [...paintRgb, 255], 8)
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    // The redraw lands asynchronously: wait for the anchor dot (red in both
    // states, so it proves the draw) before asserting the erased dot.
    await waitForPixel(200, 500, [...anchorRgb, 255], 8)
    await waitForPixel(780, 360, [0, 0, 0, 0])
    expect(await pixel(780, 360)).toEqual([0, 0, 0, 0])

    // 10. Arrow-key nudge, clipboard paste, and whole-canvas flip also ride
    // the floating helpers (single history entries each). Zoom back out so
    // the anchor dot area is hittable again.
    for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
    {
      const ui10 = await zoomUiLabel()
      const css10 = await realCssScale()
      console.log(`[floating] step10 zoom ui=${ui10} css=${css10}`)
      expect(ui10).toContain('67%')
      expect(Math.abs(css10 - 0.333)).toBeLessThan(0.05)
    }
    // Steps 8-9 panned the viewport at UI 500%; the zoom-out keeps that offset,
    // which can leave the 67% canvas offset from the surface. Re-center the
    // anchor-dot area with a real wheel pan so the same marquee coords below
    // hit the canvas again (all nudge/paste/flip pixel asserts unchanged).
    await panCanvasPointToSurfaceCenter(200, 500)
    await expectCanvasHit(180, 480)
    await expectCanvasHit(220, 520)
    await page.getByTestId('bitmap-tool-select').click()
    await dragCanvas({ x: 180, y: 480 }, { x: 220, y: 520 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    // Screen-constant Shift step at the REAL floor scale (Paper basis):
    // 15 screen px / css canvas px. At res2 floor CSS 0.333 this is +45
    // canvas px, so the dot travels (200,500) -> (245,500) (legacy 25%
    // assumed 0.25 -> +60 -> 260). The step is derived from the live rect,
    // not the UI label; pixel/history asserts keep their exactness.
    const nudgeCss = await realCssScale()
    const shiftDx = Math.round(15 / nudgeCss)
    const nudgeTargetX = 200 + shiftDx
    console.log(`[floating] nudge ui=${await zoomUiLabel()} css=${nudgeCss} shiftDx=${shiftDx}`)
    expect(shiftDx).toBe(45)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await waitForStatus('Bitmap selection moved')
    await waitForPixel(200, 500, [0, 0, 0, 0])
    expect(await pixel(nudgeTargetX, 500)).toEqual([...anchorRgb, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(200, 500, [...anchorRgb, 255])
    expect(await pixel(nudgeTargetX, 500)).toEqual([0, 0, 0, 0])
    // Re-select (undo reloads drop the outline), copy, and paste at the
    // shared +10px offset: the duplicate dot lands near (210, 510).
    await dragCanvas({ x: 180, y: 480 }, { x: 220, y: 520 })
    await page.getByTestId('bitmap-selection').waitFor({ state: 'visible' })
    await page.keyboard.press('Control+c')
    await waitForStatus('Bitmap selection copied')
    await page.keyboard.press('Control+v')
    await waitForStatus('Bitmap selection pasted')
    await waitForPixel(210, 510, [...anchorRgb, 255], 8)
    expect(await pixel(200, 500)).toEqual([...anchorRgb, 255])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(210, 510, [0, 0, 0, 0])
    expect(await pixel(200, 500)).toEqual([...anchorRgb, 255])
    // Whole-canvas flip (no selection): the dot mirrors to (759, 500).
    await page.keyboard.press('Escape')
    await page.getByTestId('bitmap-selection').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Flip horizontal' }).click()
    await waitForStatus('Bitmap flipped horizontally')
    await waitForPixel(759, 500, [...anchorRgb, 255], 8)
    expect(await pixel(200, 500)).toEqual([0, 0, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    await waitForPixel(200, 500, [...anchorRgb, 255], 8)
    expect(await pixel(759, 500)).toEqual([0, 0, 0, 0])
  }, 180_000)
})
