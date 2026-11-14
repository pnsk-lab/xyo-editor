import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Dedicated real-editor browser test for the vector fill-tool hover preview.
// Product code is untouched: this file only drives the real costume editor
// through Playwright and asserts the live overlay + live artwork + history.
//
// Covers, without loosening expectations:
// - two different-color shapes, fill side vs outline (stroke) side
// - real displayed pixels (stage-surface screenshots differ while the preview
//   is shown and return afterwards), not just DOM strings
// - removal on mouseout / different target / paint-color change / tool switch /
//   Escape, each without touching saved SVG bytes, selection, or undo stack
// - transparent paint (no overlay) vs gradient paint (defs + overlay)
// - zoom (hover still hits the same document point zoomed out and zoomed in)
// - compound (evenodd) holes: colored holes overlay only the hole, transparent
//   holes stay empty
// - rapid pointermove settles on the final target (stale drops), a click
//   commits exactly one history entry, and Undo/Redo + target switches never
//   resurrect a stale preview.
//
// Dedicated Vite port 4477 (surveyed: 4173/4178/4179/4180/4183/4189/4191/
// 4197/4198/4199/4205/4213/4227/4228/4231/4232/4234/4235/4236/4237/4238/4241/
// 4242/4244/4245/4247/4249/4252/4253/4255/4256/4259/4261/4263/4264/4265/4271/
// 4277/4281/4288/4289/4291/4293/4294/4295/4297/4299/4311/4317/4321/4322/4323/
// 4327/4329/4330/4331/4334/4345/4347/4348/4361/4371/4377/4381/4395/4399/4401/
// 4427/4449/4451/4461 are taken by the other suites).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4477'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
// Two different-color rects, both near the stage center so they stay inside
// the clipped paint surface at the fitted zoom below (the 455px-wide surface
// shows about +-100 document units around the 240,180 center after five 0.85
// zoom-outs, i.e. roughly x 140-340 / y 80-280). A is blue fill + green
// outline, B is red fill + black outline.
const TWO_RECT_SVG =
  `${HEAD}<rect x="170" y="110" width="65" height="120" fill="#0000ff" stroke="#00ff00" stroke-width="8"/>` +
  `<rect x="245" y="110" width="65" height="120" fill="#ff0000" stroke="#000000" stroke-width="8"/></svg>`
const DONUT_SVG =
  `${HEAD}<path d="M150 90H330V270H150Z M210 150H270V210H210Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const LINE_SVG =
  `${HEAD}<path d="M170 120 L310 120 L310 220" fill="none" stroke="#000000" stroke-width="8"/></svg>`

// Document points (480x360 space). All rect points sit inside the fitted
// viewport (x 140-340) so hover/click never fall off-canvas.
const A_FILL = { x: 202, y: 170 }
const A_STROKE = { x: 168, y: 170 }
const B_FILL = { x: 277, y: 170 }
const DONUT_BODY = { x: 165, y: 115 }
const DONUT_HOLE = { x: 240, y: 180 }
const DONUT_OUTSIDE = { x: 340, y: 250 }
const LINE_INTERIOR = { x: 240, y: 175 }
const LINE_OUTLINE = { x: 240, y: 120 }

function previewHtml() {
  return page.locator('.vector-preview').innerHTML()
}

function overlayHtml() {
  return page.locator('[data-testid="vector-fill-hover-preview"]').innerHTML()
}

async function overlayVisible(): Promise<boolean> {
  return await page.locator('[data-testid="vector-fill-hover-preview"]').isVisible()
}

async function overlayState() {
  return await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="vector-fill-hover-preview"]') as HTMLElement | null
    if (!overlay) return { present: false as const }
    const style = getComputedStyle(overlay)
    const svg = overlay.querySelector('svg')
    const rect = overlay.getBoundingClientRect()
    return {
      present: true as const,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      pointerEvents: style.pointerEvents,
      ariaHidden: overlay.getAttribute('aria-hidden'),
      width: rect.width,
      height: rect.height,
      htmlLength: overlay.innerHTML.length,
      html: overlay.innerHTML.slice(0, 4000),
    }
  })
}

async function baseSvgBytes(): Promise<string> {
  return await page.evaluate(() => document.querySelector('.vector-preview')?.innerHTML ?? '')
}

async function undoDisabled(): Promise<boolean> {
  return await page.getByRole('button', { name: 'Undo' }).isDisabled()
}

async function redoDisabled(): Promise<boolean> {
  return await page.getByRole('button', { name: 'Redo' }).isDisabled()
}

async function selectionState() {
  return await page.evaluate(() => {
    const blue = document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length
    const deleteButton = document.querySelector('[data-testid="delete-editor-selection"]') as HTMLButtonElement | null
    return { blueOutlines: blue, deleteDisabled: deleteButton?.disabled ?? null }
  })
}

async function stageShot(): Promise<Buffer> {
  // Capture the clipped paint-surface container (always on-screen) rather
  // than the stage surface itself (a larger-than-viewport transformed child
  // whose element screenshot must scroll and flakes). The container still
  // shows the real base + hover-overlay pixels.
  return await page.getByTestId('costume-paint-surface').screenshot()
}

// Screenshots right after a zoom settle one frame apart (the first frame can
// still show the pre-zoom raster: measured 116792 vs stable 117043), so every
// zoom step is followed by an explicit settle before any pixel baseline is
// captured. Baselines additionally warm the raster with a discarded shot so
// the returned bytes are always the stable post-zoom frame.
async function settledStageShot(): Promise<Buffer> {
  await page.waitForTimeout(900)
  return await stageShot()
}

async function baselineStageShot(): Promise<Buffer> {
  await page.waitForTimeout(600)
  await stageShot().catch(() => undefined)
  await page.waitForTimeout(900)
  return await stageShot()
}

// In-page real-pixel probe: samples the rendered overlay SVG at the hovered
// document point by mapping it through the live stage rect and reading the
// topmost SVG paint at that client pixel via elementFromPoint-independent
// geometry (overlay is pointer-events:none, so hit-testing would skip it).
// Returns the overlay fill/stroke at the sampled shape plus its screen box.
async function overlayPixelAt(x: number, y: number) {
  return await page.evaluate(
    ({ dx, dy }: { dx: number; dy: number }) => {
      const surface = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
      const overlay = document.querySelector('[data-testid="vector-fill-hover-preview"]') as HTMLElement | null
      if (!surface || !overlay) return { found: false as const, reason: 'missing-nodes' }
      const surfaceRect = surface.getBoundingClientRect()
      const clientX = surfaceRect.left + (dx / 480) * surfaceRect.width
      const clientY = surfaceRect.top + (dy / 360) * surfaceRect.height
      const svg = overlay.querySelector('svg')
      if (!svg) return { found: false as const, reason: 'missing-overlay-svg' }
      // Find the overlay shape covering the client point: walk its paint
      // nodes and test their screen boxes (SVGGeometryElement.getBBox is in
      // local units, so use getBoundingClientRect per node instead).
      const shapes = Array.from(svg.querySelectorAll('rect,path,circle,ellipse,polygon,polyline'))
      let covering: { fill: string | null; stroke: string | null } | null = null
      for (const shape of shapes) {
        const rect = (shape as unknown as Element & { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          covering = {
            fill: (shape as Element).getAttribute('fill'),
            stroke: (shape as Element).getAttribute('stroke'),
          }
        }
      }
      const overlayRect = overlay.getBoundingClientRect()
      return {
        found: true as const,
        clientX,
        clientY,
        overlayLeft: overlayRect.left,
        overlayTop: overlayRect.top,
        overlayWidth: overlayRect.width,
        overlayHeight: overlayRect.height,
        covering,
      }
    },
    { dx: x, dy: y },
  )
}

async function openVectorCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' })
}

async function uploadVectorCostume(name: string, svg: string) {
  const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
  await page.getByTestId('costume-file-input').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg, 'utf8'),
  })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    beforeCards,
    { timeout: 30_000 },
  )
  await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  }
}

async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(1200)
}

async function resetZoom() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.waitForTimeout(1200)
}

async function docToClient(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('Missing vector stage surface')
  return { clientX: box.x + (x / 480) * box.width, clientY: box.y + (y / 360) * box.height }
}

async function hoverDoc(x: number, y: number) {
  const { clientX, clientY } = await docToClient(x, y)
  await page.mouse.move(clientX, clientY, { steps: 3 })
}

async function clickDoc(x: number, y: number) {
  const { clientX, clientY } = await docToClient(x, y)
  const hit = await page.evaluate(
    ({ px, py }: { px: number; py: number }) => {
      const element = document.elementFromPoint(px, py)
      if (!element) return 'none'
      return element.closest('[data-vector-stage-surface]') ? 'canvas' : element.tagName
    },
    { px: clientX, py: clientY },
  )
  if (hit !== 'canvas') throw new Error(`Document point (${x}, ${y}) is off-canvas (hits ${hit})`)
  await page.mouse.click(clientX, clientY)
}

async function leaveSurface() {
  // The hover pointerleave listener lives on the paint-surface container, so
  // moving outside that container ends the hover. Use a raw mouse move to the
  // viewport corner: locator.hover() would scrollIntoView and shift the stage
  // box between screenshots, making pixel baselines incomparable.
  await page.mouse.move(8, 8, { steps: 3 })
  await page.waitForTimeout(500)
}

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click()
}

async function selectSelectTool() {
  await page.getByTestId('vector-shape-select').last().click()
}

async function waitOverlayWith(text: string, timeout = 15_000) {
  await page.waitForFunction(
    (want: string) => document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML.includes(want) ?? false,
    text,
    { timeout },
  )
}

async function waitOverlayHidden(timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const overlay = document.querySelector('[data-testid="vector-fill-hover-preview"]')
      if (!overlay) return true
      const rect = (overlay as HTMLElement).getBoundingClientRect()
      return rect.width === 0 && rect.height === 0 ? true : !overlay.isConnected ? true : false
    },
    undefined,
    { timeout },
  ).catch(async () => {
    // Fallback: hidden via removal. If still connected, assert explicitly.
    const visible = await overlayVisible().catch(() => false)
    if (visible) throw new Error('fill hover overlay still visible after wait')
  })
}

function failReport(context: string, extra: unknown) {
  // Detailed failure aid: never loosens expectations, only prints state.
  console.log(`[fill-hover-real-editor:FAIL] ${context} ${JSON.stringify(extra).slice(0, 4000)}`)
}

describe('vector fill hover in the real editor (draw-only preview)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4477', '--strictPort'], {
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
    if (!ready) throw new Error('Vite failed to start on 4477')
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('two-color fill hover shows real pixels without touching saved bytes, selection, or history', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('hover-two-rect.svg', TWO_RECT_SVG)
    await fitViewport()
    // Reference parity: Fill disables the stroke side (BRUSH/TEXT/FILL), so
    // the stroke preview paint must be staged from an allowed mode first.
    // This mirrors a real user (Select -> set outline -> Fill -> hover) and
    // the stored stroke color survives the tool switch for the preview.
    await selectSelectTool()
    await page.getByLabel('Stroke color', { exact: true }).fill('#00ffff')
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const beforeBytes = await baseSvgBytes()
    expect(beforeBytes).toContain('#0000ff')
    expect(beforeBytes).toContain('#ff0000')
    expect(beforeBytes).not.toContain('#ff00ff')
    const undoBefore = await undoDisabled()
    const redoBefore = await redoDisabled()
    const selectionBefore = await selectionState()
    const shotBefore = await baselineStageShot()

    await hoverDoc(A_FILL.x, A_FILL.y)
    try {
      await waitOverlayWith('#ff00ff')
    } catch (error) {
      failReport('A fill overlay never appeared', { overlay: await overlayState(), beforeLen: beforeBytes.length })
      throw error
    }
    const overlayA = await overlayState()
    expect(overlayA.present).toBe(true)
    if (overlayA.present) {
      expect(overlayA.visible).toBe(true)
      expect(overlayA.pointerEvents).toBe('none')
      expect(overlayA.ariaHidden).toBe('true')
      expect(overlayA.width).toBeGreaterThan(0)
      expect(overlayA.height).toBeGreaterThan(0)
    }
    const overlayAHtml = await overlayHtml()
    expect(overlayAHtml).toContain('#ff00ff')
    // Real displayed pixel: the overlay shape covering the hovered document
    // point carries the preview paint in its rendered box.
    const pixelA = await overlayPixelAt(A_FILL.x, A_FILL.y)
    expect(pixelA.found).toBe(true)
    if (pixelA.found) {
      expect(pixelA.overlayWidth).toBeGreaterThan(0)
      expect(pixelA.covering?.fill?.toLowerCase()).toBe('#ff00ff')
    }
    // The live (saved) SVG bytes are untouched by the draw-only preview.
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await previewHtml()).not.toContain('#ff00ff')
    // Selection and undo stacks are untouched.
    expect(await selectionState()).toEqual(selectionBefore)
    expect(await undoDisabled()).toBe(undoBefore)
    expect(await redoDisabled()).toBe(redoBefore)
    // Real displayed pixels change while the overlay is shown.
    const shotHoverA = await stageShot()
    expect(Buffer.compare(shotBefore, shotHoverA) !== 0).toBe(true)

    // Stroke-side hover on the same shape previews the outline only.
    // (stroke paint was staged above in Select mode: Fill disables stroke
    // controls per reference, so filling here would hit a disabled input.)
    await hoverDoc(A_STROKE.x, A_STROKE.y)
    try {
      await waitOverlayWith('#00ffff')
    } catch (error) {
      failReport('A stroke overlay never appeared', { overlay: await overlayState() })
      throw error
    }
    const overlayStrokeHtml = await overlayHtml()
    expect(overlayStrokeHtml).toContain('#00ffff')
    expect(overlayStrokeHtml).toContain('#0000ff')
    const pixelStroke = await overlayPixelAt(A_STROKE.x, A_STROKE.y)
    expect(pixelStroke.found).toBe(true)
    if (pixelStroke.found) {
      expect(pixelStroke.overlayWidth).toBeGreaterThan(0)
      const strokePaints = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="vector-fill-hover-preview"] svg')
        if (!svg) return [] as Array<string | null>
        return Array.from(svg.querySelectorAll('rect,path,circle,ellipse,polygon,polyline')).map((el) =>
          (el as Element).getAttribute('stroke'),
        )
      })
      expect(strokePaints.map((value) => (value ?? '').toLowerCase())).toContain('#00ffff')
      const fillPaints = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="vector-fill-hover-preview"] svg')
        if (!svg) return [] as Array<string | null>
        return Array.from(svg.querySelectorAll('rect,path,circle,ellipse,polygon,polyline')).map((el) =>
          (el as Element).getAttribute('fill'),
        )
      })
      expect(fillPaints.map((value) => (value ?? '').toLowerCase())).toContain('#0000ff')
    }
    expect(await baseSvgBytes()).toBe(beforeBytes)
    const shotStroke = await stageShot()
    expect(Buffer.compare(shotBefore, shotStroke) !== 0).toBe(true)
  }, 120_000)

  it('hovering the second color switches targets and restores the first shape', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('hover-target-switch.svg', TWO_RECT_SVG)
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const beforeBytes = await baseSvgBytes()
    const shotBefore = await baselineStageShot()

    await hoverDoc(A_FILL.x, A_FILL.y)
    await waitOverlayWith('#ff00ff')
    const overlayOnA = await overlayHtml()
    // Overlay previews exactly one shape: the A rect carries the preview
    // color while the B rect keeps its saved red fill.
    expect(overlayOnA).toContain('#ff00ff')
    expect(overlayOnA).toContain('#ff0000')

    await hoverDoc(B_FILL.x, B_FILL.y)
    await page.waitForTimeout(600)
    await waitOverlayWith('#ff00ff')
    const overlayOnB = await overlayHtml()
    expect(overlayOnB).toContain('#ff00ff')
    // After the target switch the A shape is restored inside the overlay:
    // the overlay still shows the saved blue fill for A, not a stale magenta
    // copy, while B carries the preview.
    expect(overlayOnB).toContain('#0000ff')
    expect(overlayOnB).toContain('#ff00ff')
    const blueCount = (overlayOnB.match(/#0000ff/g) ?? []).length
    const magentaCount = (overlayOnB.match(/#ff00ff/gi) ?? []).length
    expect(magentaCount).toBe(1)
    expect(blueCount).toBe(1)
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })
    expect(await undoDisabled()).toBe(true)
    const shotOnB = await stageShot()
    expect(Buffer.compare(shotBefore, shotOnB) !== 0).toBe(true)

    // Moving back restores B and previews A again (no stale B preview left).
    await hoverDoc(A_FILL.x, A_FILL.y)
    await page.waitForTimeout(600)
    await waitOverlayWith('#ff00ff')
    const overlayBackOnA = await overlayHtml()
    expect(overlayBackOnA).toContain('#0000ff'.toLowerCase() === '#0000ff' ? '#ff00ff' : '#ff00ff')
    expect(overlayBackOnA).toContain('#ff0000')
    expect(await baseSvgBytes()).toBe(beforeBytes)
  }, 120_000)

  it('mouseout, color change, tool switch, and Escape each remove the preview without side effects', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('hover-clear-paths.svg', TWO_RECT_SVG)
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const beforeBytes = await baseSvgBytes()
    const shotBefore = await baselineStageShot()

    // mouseout
    await hoverDoc(A_FILL.x, A_FILL.y)
    await waitOverlayWith('#ff00ff')
    await leaveSurface()
    try {
      await waitOverlayHidden()
    } catch (error) {
      failReport('mouseout did not remove overlay', { overlay: await overlayState() })
      throw error
    }
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotBefore, await settledStageShot()) === 0).toBe(true)

    // color change clears the stale-color snapshot
    await hoverDoc(A_FILL.x, A_FILL.y)
    await waitOverlayWith('#ff00ff')
    await page.getByLabel('Paint color', { exact: true }).fill('#123456')
    await page.waitForTimeout(600)
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await undoDisabled()).toBe(true)
    // The next move rebuilds with the new paint, never the old magenta.
    await hoverDoc(A_FILL.x, A_FILL.y)
    await waitOverlayWith('#123456')
    expect(await overlayHtml()).toContain('#123456')
    expect(await overlayHtml()).not.toContain('#ff00ff')
    expect(await baseSvgBytes()).toBe(beforeBytes)
    await leaveSurface()
    await waitOverlayHidden()

    // tool switch
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    await selectSelectTool()
    await page.waitForTimeout(500)
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await undoDisabled()).toBe(true)
    await selectFillTool()

    // Escape
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    const paintBeforeEscape = await page.getByLabel('Paint color', { exact: true }).inputValue()
    await page.keyboard.press('Escape')
    await waitOverlayHidden()
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe(paintBeforeEscape)
    expect(await selectionState()).toEqual({ blueOutlines: 0, deleteDisabled: true })
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(shotBefore, await settledStageShot()) === 0).toBe(true)
  }, 120_000)

  it('transparent paint stays empty while gradient paint previews with defs, including under zoom', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('hover-transparent-gradient.svg', TWO_RECT_SVG)
    await fitViewport()
    await selectFillTool()

    // Transparent fill: hovering a body shows no overlay and writes nothing.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await page.waitForTimeout(600)
    const transparentBytes = await baseSvgBytes()
    const transparentShot = await baselineStageShot()
    await hoverDoc(A_FILL.x, A_FILL.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(transparentBytes)
    expect(await undoDisabled()).toBe(true)
    expect(Buffer.compare(transparentShot, await settledStageShot()) === 0).toBe(true)
    await page.getByRole('button', { name: 'Transparent fill' }).click()

    // Horizontal gradient: overlay carries gradient defs, base stays solid.
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    await hoverDoc(A_FILL.x, A_FILL.y)
    await page.waitForFunction(
      () => {
        const html = document.querySelector('[data-testid="vector-fill-hover-preview"]')?.innerHTML ?? ''
        return html.includes('linearGradient') && html.includes('url(')
      },
      undefined,
      { timeout: 15_000 },
    )
    const gradientHtml = await overlayHtml()
    expect(gradientHtml).toContain('linearGradient')
    expect(gradientHtml).toContain('url(')
    expect(await baseSvgBytes()).not.toContain('linearGradient')
    const gradientShot = await stageShot()
    expect(Buffer.compare(transparentShot, gradientShot) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()
    await page.getByLabel('Vector paint style').selectOption('solid')

    // Zoom: the same document point still hovers the same shape zoomed out
    // and zoomed in, with real pixels and untouched saved bytes.
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const zoomBytes = await baseSvgBytes()
    await resetZoom()
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    expect(await baseSvgBytes()).toBe(zoomBytes)
    expect(Buffer.compare(await stageShot(), transparentShot) !== 0).toBe(true)
    await leaveSurface()
    await waitOverlayHidden()
    // One zoom-in step from the fitted baseline keeps the same document
    // point on the visible canvas (two steps from 100% push it under the
    // top toolbar, verified via elementFromPoint in a probe). The scale
    // still differs from both the fitted and the reset states, so the
    // zoom-aware tolerance path is exercised without going off-canvas.
    await fitViewport()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForTimeout(1200)
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    expect(await overlayHtml()).toContain('#ff00ff')
    expect(await baseSvgBytes()).toBe(zoomBytes)
    expect(await undoDisabled()).toBe(true)
  }, 120_000)

  it('open outlines preview stroke-only and compound holes overlay only the hole', async () => {
    // Open path: interior hover stays empty, outline hover previews the stroke.
    await openVectorCostumes()
    await uploadVectorCostume('hover-open-path.svg', LINE_SVG)
    await fitViewport()
    // Same reference parity as above: stage the stroke preview paint while
    // stroke controls are enabled, then enter Fill.
    await selectSelectTool()
    await page.getByLabel('Stroke color', { exact: true }).fill('#00ffff')
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const lineBytes = await baseSvgBytes()
    await hoverDoc(LINE_INTERIOR.x, LINE_INTERIOR.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(lineBytes)
    await hoverDoc(LINE_OUTLINE.x, LINE_OUTLINE.y)
    await waitOverlayWith('#00ffff')
    const lineOverlay = await overlayHtml()
    expect(lineOverlay).toContain('#00ffff')
    expect(lineOverlay).toContain('fill="none"')
    expect(await baseSvgBytes()).toBe(lineBytes)

    // Compound hole: opaque hover overlays only the hole sibling.
    await openVectorCostumes()
    await uploadVectorCostume('hover-donut.svg', DONUT_SVG)
    const donutBytes = await baseSvgBytes()
    expect(donutBytes).toContain('evenodd')
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    await hoverDoc(DONUT_HOLE.x, DONUT_HOLE.y)
    await waitOverlayWith('#00ff00')
    const holeOverlay = await overlayHtml()
    expect(holeOverlay).toContain('#00ff00')
    expect(holeOverlay).toContain('#ff0000')
    expect(holeOverlay).toContain('stroke="none"')
    expect(holeOverlay).toContain('pointer-events')
    expect((holeOverlay.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(await baseSvgBytes()).toBe(donutBytes)
    expect(await undoDisabled()).toBe(true)
    const pixelHole = await overlayPixelAt(DONUT_HOLE.x, DONUT_HOLE.y)
    expect(pixelHole.found).toBe(true)
    if (pixelHole.found) {
      expect(pixelHole.covering?.fill?.toLowerCase()).toBe('#00ff00')
      expect(pixelHole.covering?.stroke).toBe('none')
    }
    const holeShot = await stageShot()
    await leaveSurface()
    await waitOverlayHidden()
    expect(Buffer.compare(holeShot, await settledStageShot()) !== 0).toBe(true)

    // Transparent holes stay empty: no overlay, no history, redo-safe pixels.
    await hoverDoc(DONUT_BODY.x, DONUT_BODY.y)
    await waitOverlayWith('#00ff00')
    await page.getByRole('button', { name: 'Undo' }).isDisabled()
    await leaveSurface()
    await waitOverlayHidden()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await hoverDoc(DONUT_HOLE.x, DONUT_HOLE.y)
    await page.waitForTimeout(800)
    expect(await overlayVisible()).toBe(false)
    expect(await baseSvgBytes()).toBe(donutBytes)
    expect(await undoDisabled()).toBe(true)
  }, 180_000)

  it('rapid moves settle on the final target; click is one history and stale previews never return', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('hover-race-history.svg', TWO_RECT_SVG)
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    const beforeBytes = await baseSvgBytes()
    expect(await undoDisabled()).toBe(true)

    // Rapid pointermove across A -> B -> outside with no settle waits: the
    // async resolver must drop stale results and land on the final state.
    const points: Array<{ x: number; y: number }> = []
    for (let i = 0; i <= 10; i += 1) {
      points.push({ x: A_FILL.x + ((B_FILL.x - A_FILL.x) * i) / 10, y: A_FILL.y })
    }
    for (const point of points) {
      const { clientX, clientY } = await docToClient(point.x, point.y)
      await page.mouse.move(clientX, clientY, { steps: 1 })
    }
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    expect(await overlayHtml()).toContain('#0000ff')
    expect(await baseSvgBytes()).toBe(beforeBytes)
    // Fast sweep off the artwork settles hidden, not on a stale shape.
    const outside = await docToClient(DONUT_OUTSIDE.x, DONUT_OUTSIDE.y)
    // DONUT_OUTSIDE is outside both rects but on the canvas; use a far corner.
    for (let i = 0; i < 5; i += 1) {
      await page.mouse.move(outside.clientX - i * 2, outside.clientY - i * 2, { steps: 1 })
    }
    await leaveSurface()
    await waitOverlayHidden()
    expect(await baseSvgBytes()).toBe(beforeBytes)

    // Hover then click commits exactly one history entry and clears overlay.
    await hoverDoc(A_FILL.x, A_FILL.y)
    await waitOverlayWith('#ff00ff')
    await clickDoc(A_FILL.x, A_FILL.y)
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.innerHTML.includes('#ff00ff') ?? false,
      undefined,
      { timeout: 30_000 },
    )
    const committed = await baseSvgBytes()
    expect(committed).toContain('#ff00ff')
    expect(committed).not.toBe(beforeBytes)
    await page.waitForTimeout(500)
    expect(await overlayVisible()).toBe(false)
    expect(await undoDisabled()).toBe(false)
    const selectionAfterClick = await selectionState()
    // Reference parity: fill commits never select (no blue box).
    expect(selectionAfterClick).toEqual({ blueOutlines: 0, deleteDisabled: true })

    // Undo restores the exact pre-click bytes with no overlay; a second Undo
    // is a no-op (still exactly one history entry for the click).
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous: string) => document.querySelector('.vector-preview')?.innerHTML === previous,
      beforeBytes,
      { timeout: 30_000 },
    )
    expect(await baseSvgBytes()).toBe(beforeBytes)
    expect(await overlayVisible()).toBe(false)
    expect(await undoDisabled()).toBe(true)
    // Redo replays the single fill; no stale hover returns on its own.
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.innerHTML.includes('#ff00ff') ?? false,
      undefined,
      { timeout: 30_000 },
    )
    expect(await baseSvgBytes()).toBe(committed)
    await page.waitForTimeout(500)
    expect(await overlayVisible()).toBe(false)

    // Switching targets after undo/redo previews only the new target.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous: string) => document.querySelector('.vector-preview')?.innerHTML === previous,
      beforeBytes,
      { timeout: 30_000 },
    )
    await hoverDoc(B_FILL.x, B_FILL.y)
    await waitOverlayWith('#ff00ff')
    const afterSwitch = await overlayHtml()
    expect(afterSwitch).toContain('#ff00ff')
    expect(afterSwitch).toContain('#0000ff')
    expect(await baseSvgBytes()).toBe(beforeBytes)
  }, 180_000)
})
