import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-screen coverage for the dedicated eyedropper overlay + loupe:
// opaque and transparent picks in both bitmap and vector modes, the live
// magnifier, zoom-aware sampling, Shift+click stroke picking, Escape/outside
// cancel, text-draft priority, and tool preservation after cancel. The full
// Editor mounts in the dev server (same fixture style as
// transparent-fill.browser.test.ts); pixels flow through the real bitmap
// canvas and vector artwork through the real SVG preview + raster cache.
// Clean-room behavior, no reference code paths exercised.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4249'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function openCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function drawVectorDrag(kind: 'rect' | 'oval', dx = 50, dy = 40, center?: { x: number; y: number }) {
  await closePopovers()
  await page.getByTestId(`vector-shape-${kind}`).last().click()
  const surface = page.getByTestId('costume-paint-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing vector paint surface')
  const x = center?.x ?? box.x + box.width / 2
  const y = center?.y ?? box.y + box.height / 2
  await page.mouse.move(x - dx, y - dy)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

function previewHtml() {
  return page.locator('.vector-preview').innerHTML()
}

async function surfaceBox() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface')
  return box
}

// Compact toolbar: Fill/Outline controls live in anchored popovers. Opening is
// idempotent; the dialogs preserve the same paint behavior and history.
async function openFillPopover() {
  const dialog = page.getByTestId('fill-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('fill-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function openOutlinePopover() {
  const dialog = page.getByTestId('outline-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await page.getByTestId('outline-style').click()
  await dialog.waitFor({ state: 'visible' })
}

async function closePopovers() {
  for (let i = 0; i < 2; i += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0 && (await page.getByTestId('outline-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

describe('dedicated eyedropper with loupe on the real costume screen', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4249', '--strictPort'], {
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
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('picks opaque bitmap colors with a live loupe, survives zoom, and reports transparent', async () => {
    await openCostumes()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await canvas.waitFor({ state: 'visible' })
    const fill = page.getByLabel('Paint color', { exact: true })
    await page.getByTestId('bitmap-tool-brush').click()
    await openFillPopover()
    await fill.fill('#ff0000')
    await closePopovers()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x - 30, y)
    await page.mouse.down()
    await page.mouse.move(x + 30, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 200 && g < 40 && b < 40 && a === 255
    })
    // Arm a detectable change, then pick the stroke back with the overlay.
    await openFillPopover()
    await fill.fill('#0000ff')
    await closePopovers()
    await page.getByTestId('bitmap-tool-eyedropper').click()
    expect(await page.getByTestId('bitmap-tool-eyedropper').getAttribute('aria-pressed')).toBe('true')
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    await page.mouse.move(x, y)
    await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
    await page.mouse.click(x, y)
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#ff0000')
    // The overlay deactivates on commit and the brush tool survives it.
    expect(await page.getByTestId('bitmap-tool-eyedropper').getAttribute('aria-pressed')).toBe('false')

    // Zoom-aware: the same artwork pixel resolves through the new transform.
    await openFillPopover()
    await fill.fill('#0000ff')
    await closePopovers()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    const zoomed = await canvas.boundingBox()
    if (!zoomed) throw new Error('Missing zoomed bitmap canvas')
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
    await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
    await page.mouse.click(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#ff0000')

    // Transparent: erase the stroke with a transparent flood fill, untoggle
    // (proving the toggle is settable), then pick the erased pixel and watch
    // the toggle return while the hex is kept for restore.
    // Compact popover floats over the left rail: close it before rail clicks.
    await closePopovers()
    await page.getByTestId('bitmap-tool-fill').click()
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    const fresh = await canvas.boundingBox()
    if (!fresh) throw new Error('Missing bitmap canvas')
    await page.mouse.click(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2)
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('false')
    await closePopovers()
    await page.getByTestId('bitmap-tool-eyedropper').click()
    const erased = await canvas.boundingBox()
    if (!erased) throw new Error('Missing bitmap canvas')
    await page.mouse.click(erased.x + erased.width / 2, erased.y + erased.height / 2)
    await openFillPopover()
    await page.waitForFunction(() => document.querySelector('[aria-label="Transparent fill"]')?.getAttribute('aria-pressed') === 'true')
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#ff0000')

    // Escape cancels without touching colors.
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await fill.fill('#0000ff')
    await page.getByTestId('eyedropper-fill').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    // Swatch triggers stay disabled while armed (no focus trap): the dialog
    // auto-closed on arm and cannot reopen mid-pick.
    expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
    // One Escape cancels the overlay (not just a popup).
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#0000ff')
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('false')
  }, 120_000)

  it('picks vector fill and stroke with a live loupe, survives zoom, and reports transparent', async () => {
    await openCostumes()
    const fill = page.getByLabel('Paint color', { exact: true })
    const stroke = page.getByLabel('Stroke color', { exact: true })
    await openFillPopover()
    await fill.fill('#00ff00')
    await openOutlinePopover()
    await stroke.fill('#123456')
    await closePopovers()
    await drawVectorDrag('rect')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('fill="#00ff00"'))
    // Arm detectable changes on both sides.
    await openFillPopover()
    await fill.fill('#0000ff')
    await openOutlinePopover()
    await stroke.fill('#000000')
    await closePopovers()

    // Fill pick with a live loupe.
    await page.getByTestId('vector-tool-eyedropper').click()
    expect(await page.getByTestId('vector-tool-eyedropper').getAttribute('aria-pressed')).toBe('true')
    const box = await surfaceBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
    await page.mouse.click(cx, cy)
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#00ff00')
    // Stroke untouched by the fill pick.
    await openOutlinePopover()
    expect(await stroke.inputValue()).toBe('#000000')

    // Stroke pick on the rect border (stroke band is centered on the edge).
    await openOutlinePopover()
    await page.getByTestId('eyedropper-stroke').click()
    const border = await surfaceBox()
    // The drag spans +/-50/+/-40 surface px around the center, i.e. about
    // +/-10/+/-8 vector units at scale 5; the top edge sits ~40px above center.
    await page.mouse.click(border.x + border.width / 2, cy - 40)
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openOutlinePopover()
    expect(await stroke.inputValue()).toBe('#123456')

    // Zoom-aware vector pick through the raster cache.
    await openFillPopover()
    await fill.fill('#0000ff')
    await closePopovers()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.getByTestId('vector-tool-eyedropper').click()
    const zoomed = await surfaceBox()
    await page.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
    await page.getByTestId('eyedropper-loupe').waitFor({ state: 'visible' })
    await page.mouse.click(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#00ff00')

    // Transparent vector pick: clear everything, draw a hollow rect over the
    // empty background, untoggle first, then watch the pick restore transparency.
    // Focus the canvas first: with a swatch dialog open the focus sits in its
    // input, where Control+A would select the input text (leaving the base
    // artwork behind and starving the later hollow draw). A canvas click
    // retargets the shortcut to the artwork so select-all + delete empties it.
    await closePopovers()
    await page.getByTestId('costume-paint-surface').click()
    await page.keyboard.press('Control+a')
    await page.getByTestId('delete-editor-selection').click()
    await page.waitForFunction(() => !(document.querySelector('.vector-preview')?.innerHTML.includes('fill="#00ff00"')))
    expect(await previewHtml()).not.toContain('fill="#00ff00"')
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('true')
    await closePopovers()
    await drawVectorDrag('rect')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('fill="none"'))
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('false')
    await closePopovers()
    await page.getByTestId('vector-tool-eyedropper').click()
    const hollow = await surfaceBox()
    await page.mouse.click(hollow.x + hollow.width / 2, hollow.y + hollow.height / 2)
    await openFillPopover()
    await page.waitForFunction(() => document.querySelector('[aria-label="Transparent fill"]')?.getAttribute('aria-pressed') === 'true')
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#00ff00')

    // Escape cancels without touching colors.
    await openFillPopover()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    await fill.fill('#0000ff')
    await page.getByTestId('eyedropper-fill').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    // Swatch triggers stay disabled while armed (no focus trap): the dialog
    // auto-closed on arm and cannot reopen mid-pick.
    expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('outline-style').isDisabled()).toBe(true)
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
    // One Escape cancels the overlay (not just a popup).
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#0000ff')
  }, 150_000)

  it('keeps an open text draft ahead of the picker and cancels cleanly', async () => {
    await openCostumes()
    const fill = page.getByLabel('Paint color', { exact: true })
    await openFillPopover()
    await fill.fill('#0000ff')
    await closePopovers()
    await page.getByTestId('vector-shape-text').last().click()
    const box = await surfaceBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.click(cx, cy)
    const editor = page.locator('[data-inline-text-editor] textarea')
    await editor.waitFor({ state: 'visible' })
    await editor.fill('hi')
    // Activating the picker must not disturb the draft.
    await openFillPopover()
    await page.getByTestId('eyedropper-fill').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    expect(await editor.inputValue()).toBe('hi')
    // The first canvas click commits the text and never picks: no color
    // change, one history entry, overlay still armed for the next click.
    await page.mouse.click(cx + 180, cy + 140)
    await page.locator('[data-inline-text-editor]').waitFor({ state: 'detached' })
    // Swatch triggers stay disabled while the overlay is still armed: the
    // dialog cannot reopen mid-pick, so focus never lands in an input and a
    // single Escape cancels the overlay (the old closePopovers-only loop
    // masked this by spending one Escape on the popup).
    expect(await page.getByTestId('fill-style').isDisabled()).toBe(true)
    await page.getByTestId('fill-style').click({ trial: true }).catch(() => {})
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(0)
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    // Escape now cancels the overlay instead of touching the committed text.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (document.querySelector('[data-testid="eyedropper-hint"]') === null))
    await openFillPopover()
    expect(await fill.inputValue()).toBe('#0000ff')
    expect(await previewHtml()).toContain('hi')
  }, 90_000)
})
