import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor coverage for the vector fill tool (Scratch `fill-tool.js`
// behavior, reimplemented from behavior notes without copying upstream
// source): side-scoped commits (fill vs outline), open-path gating,
// transparent paint, hole overlays (colored holes add a fill-only shape,
// transparent holes stay a no-op), outside no-ops without history pollution,
// nested transforms, and undo/redo round-trips. Hover previews stay
// unimplemented (see `fillVectorObjectAtPoint` in Editor.svelte).
//
// Fixtures carry an explicit 480x360 viewBox so the upload path keeps their
// geometry (otherwise it recenters the art with a translate), and all click
// points sit near the stage center so they stay inside the clipped paint
// surface at the fitted zoom below.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4327'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const RECT_SVG =
  `${HEAD}<rect x="170" y="110" width="140" height="120" fill="#0000ff" stroke="#00ff00" stroke-width="8"/></svg>`
const DONUT_SVG =
  `${HEAD}<path d="M150 90H330V270H150Z M210 150H270V210H210Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></svg>`
const NESTED_DONUT_SVG =
  `${HEAD}<g transform="translate(20 10)"><path d="M150 90H330V270H150Z M210 150H270V210H210Z" fill="#ff0000" fill-rule="evenodd" stroke="none"/></g></svg>`
const LINE_SVG =
  `${HEAD}<path d="M170 120 L310 120 L310 220" fill="none" stroke="#000000" stroke-width="8"/></svg>`

function previewHtml() {
  return page.locator('.vector-preview').innerHTML()
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

// Centered viewport zoomed out until the near-center fixtures are clickable
// through the clipped paint surface (the 455px-wide surface shows only about
// ±60 document units at 100%; five 0.85 steps widen it to about ±100).
async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
}

// The vector art fills the stage surface exactly (480x360 documents at 5x),
// so document points map linearly onto its box. The hit spot must be on the
// canvas itself (not covered by side panels), otherwise the click would land
// on unrelated UI.
async function clickDocumentPoint(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('Missing vector stage surface')
  const clientX = box.x + (x / 480) * box.width
  const clientY = box.y + (y / 360) * box.height
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

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click()
}

describe('vector fill tool in the real editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4327', '--strictPort'], {
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

  it('paints fill-only on interior clicks and stroke-only on outline clicks, with undo/redo', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('fill-rect.svg', RECT_SVG)
    await fitViewport()
    // Stage the stroke color while Select is active: the stroke side is
    // disabled under Fill (reference parity), so it is typed first.
    await page.getByLabel('Stroke color', { exact: true }).fill('#ff00ff')
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    const before = await previewHtml()
    expect(before).toContain('#0000ff')
    // Interior click recolors the fill; the outline is untouched.
    await clickDocumentPoint(240, 170)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'))
    const afterFill = await previewHtml()
    expect(afterFill).toContain('#ff0000')
    expect(afterFill).toContain('#00ff00')
    // Outline click (just outside the fill edge, inside the stroke) recolors
    // the stroke; the fill is untouched.
    await clickDocumentPoint(167, 170)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff00ff'))
    const afterStroke = await previewHtml()
    expect(afterStroke).toContain('#ff00ff')
    expect(afterStroke).toContain('#ff0000')
    // Undo restores the stroke, then the fill; redo replays both.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      afterFill,
    )
    expect(await previewHtml()).toBe(afterFill)
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      before,
    )
    expect(await previewHtml()).toBe(before)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff0000'))
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#ff00ff'))
    expect(await previewHtml()).toContain('#ff00ff')
  }, 120_000)

  it('fills donut bodies, overlays colored holes without recoloring the parent, and keeps transparent holes empty', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('fill-donut.svg', DONUT_SVG)
    const uploaded = await previewHtml()
    expect(uploaded).toContain('evenodd')
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    // Body click recolors the whole donut.
    await clickDocumentPoint(165, 115)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'))
    const filledBody = await previewHtml()
    expect(filledBody).toContain('#00ff00')
    // Undo banks the fill on the redo stack; a transparent hole click must
    // not disturb it (any history push, even an empty one, would clear redo).
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await clickDocumentPoint(240, 180)
    await page.waitForTimeout(500)
    expect(await previewHtml()).toBe(uploaded)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'))
    expect(await previewHtml()).toBe(filledBody)
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
    // Opaque hole click adds a fill-only sibling covering only the hole:
    // the parent stays red while the new shape is green.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await clickDocumentPoint(240, 180)
    await page.waitForFunction(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      return html.includes('#00ff00') && html.includes('#ff0000')
    })
    const holed = await previewHtml()
    expect(holed).toContain('#00ff00')
    expect(holed).toContain('#ff0000')
    expect(holed).toContain('stroke="none"')
    expect((holed.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // Outside click stays a no-op without touching history (redo survives).
    await clickDocumentPoint(340, 250)
    await page.waitForTimeout(500)
    expect(await previewHtml()).toBe(holed)
    // Undo removes the overlay, redo restores it.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      holed,
    )
    expect(await previewHtml()).toBe(holed)
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
  }, 120_000)

  it('honors nested transforms for hole overlays (hole/body/outside pixels + history)', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('fill-nested-donut.svg', NESTED_DONUT_SVG)
    const uploaded = await previewHtml()
    expect(uploaded).toContain('evenodd')
    await fitViewport()
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    // Hole center shifted by translate(20 10): (240,180) -> (260,190).
    await clickDocumentPoint(260, 190)
    await page.waitForFunction(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      return html.includes('#00ff00') && html.includes('#ff0000')
    })
    const holed = await previewHtml()
    expect(holed).toContain('#00ff00')
    expect(holed).toContain('#ff0000')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
    // Body pixel shifted the same way: (165,115) -> (185,125).
    await clickDocumentPoint(185, 125)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'))
    expect(await previewHtml()).toContain('#00ff00')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    // Outside pixel stays a no-op.
    await clickDocumentPoint(160, 250)
    await page.waitForTimeout(500)
    expect(await previewHtml()).toBe(uploaded)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#00ff00'))
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
  }, 120_000)

  it('rejects open-path interiors, paints open outlines stroke-only, and honors transparent/outside no-ops', async () => {
    await openVectorCostumes()
    await uploadVectorCostume('fill-line.svg', LINE_SVG)
    const uploaded = await previewHtml()
    await fitViewport()
    // Stage the stroke color while Select is active (disabled under Fill).
    await page.getByLabel('Stroke color', { exact: true }).fill('#0000ff')
    await selectFillTool()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    // Open interior: rejected fill stays a no-op (still `none`, no history).
    await clickDocumentPoint(240, 175)
    await page.waitForTimeout(500)
    expect(await previewHtml()).toBe(uploaded)
    // Outline click paints the stroke only: no fill is added.
    await clickDocumentPoint(240, 120)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('#0000ff'))
    const stroked = await previewHtml()
    expect(stroked).toContain('#0000ff')
    expect(stroked).toContain('fill="none"')
    // Transparent stroke is disabled under Fill (Scratch parity: stroke side
    // disabled on BRUSH/TEXT/FILL, asserted by
    // vector-fill-stroke-disabled-guard.browser.test.ts), so stage it while
    // Select is active, then return to Fill for the outline click.
    expect(await page.getByRole('button', { name: 'Transparent stroke' }).isDisabled()).toBe(true)
    await page.getByTestId('vector-shape-select').last().click()
    await page.getByRole('button', { name: 'Transparent stroke' }).click()
    await selectFillTool()
    await clickDocumentPoint(240, 120)
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stroke="none"'))
    expect(await previewHtml()).toContain('stroke="none"')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      stroked,
    )
    expect(await previewHtml()).toBe(stroked)
    // Outside click: no-op without history (redo still replays the clear).
    await clickDocumentPoint(150, 230)
    await page.waitForTimeout(500)
    expect(await previewHtml()).toBe(stroked)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stroke="none"'))
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      stroked,
    )
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(
      (previous) => document.querySelector('.vector-preview')?.innerHTML === previous,
      uploaded,
    )
    expect(await previewHtml()).toBe(uploaded)
  }, 120_000)
})
