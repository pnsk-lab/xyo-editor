import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-screen coverage for the transparent (`null`) fill/stroke feature:
// toggle enable/disable per gradient mode, SVG `none` output, bitmap alpha-0
// flood erase, gradient one-end transparency, undo/redo round-trips,
// transparent-to-color restore, and non-destructive opaque painting after the
// transparent operations. The full Editor mounts in the dev server (same
// fixture style as eraser-size.browser.test.ts); pixels flow through the real
// bitmap canvas and vector artwork through the real SVG preview.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4231'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function openCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function drawVectorDrag(kind: 'rect' | 'oval', dx = 50, dy = 40) {
  await page.getByTestId(`vector-shape-${kind}`).last().click()
  const surface = page.getByTestId('costume-paint-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing vector paint surface')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x - dx, y - dy)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

function previewHtml() {
  return page.locator('.vector-preview').innerHTML()
}

describe('transparent paint on the real costume screen', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4231', '--strictPort'], {
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

  it('shows fill/stroke toggles and gates the secondary toggle on the gradient mode', async () => {
    await openCostumes()
    const fill = page.getByRole('button', { name: 'Transparent fill' })
    const stroke = page.getByRole('button', { name: 'Transparent stroke' })
    const secondaryMissing = page.getByRole('button', { name: 'Transparent secondary' })
    expect(await fill.isVisible()).toBe(true)
    expect(await stroke.isVisible()).toBe(true)
    expect(await fill.getAttribute('aria-pressed')).toBe('false')
    // Solid mode has no gradient end toggle.
    expect(await secondaryMissing.count()).toBe(0)
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    const secondary = page.getByRole('button', { name: 'Transparent secondary' })
    expect(await secondary.isVisible()).toBe(true)
    expect(await secondary.getAttribute('aria-pressed')).toBe('false')
    await secondary.click()
    expect(await secondary.getAttribute('aria-pressed')).toBe('true')
    await secondary.click()
    expect(await secondary.getAttribute('aria-pressed')).toBe('false')
    // Back to solid hides it again.
    await page.getByLabel('Vector paint style').selectOption('solid')
    expect(await page.getByRole('button', { name: 'Transparent secondary' }).count()).toBe(0)
  }, 60_000)

  it('paints a vector rect with fill none, round-trips undo/redo, and restores the hex', async () => {
    await openCostumes()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    const before = await previewHtml()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    // The hex picker keeps its value while transparent is on.
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    await drawVectorDrag('rect')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('fill="none"'))
    const drawn = await previewHtml()
    expect(drawn).toContain('fill="none"')
    expect(drawn).not.toBe(before)
    // Undo removes the transparent shape; redo brings it back.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction((previous) => document.querySelector('.vector-preview')?.innerHTML === previous, before)
    expect(await previewHtml()).toBe(before)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('fill="none"'))
    expect(await previewHtml()).toContain('fill="none"')
    // Untoggling restores the exact previous color (no reset to a default).
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    // Existing behavior is intact: an opaque rect still paints its hex.
    await drawVectorDrag('rect')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('fill="#ff0000"'))
    expect(await previewHtml()).toContain('fill="#ff0000"')
  }, 60_000)

  it('fades only opacity for a one-end-transparent vector gradient', async () => {
    await openCostumes()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    await page.getByLabel('Vector paint style').selectOption('horizontal')
    await page.getByRole('button', { name: 'Transparent secondary' }).click()
    await drawVectorDrag('rect')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stop-opacity="0"'))
    const drawn = await previewHtml()
    // Surviving red RGB reused with alpha 0: no blue end, no black swing.
    expect(drawn).toContain('stop-color="#ff0000"')
    expect(drawn).toContain('stop-opacity="0"')
    expect(drawn.toLowerCase()).not.toContain('#0000ff')
    expect(drawn).not.toContain('#000000')
  }, 60_000)

  it('paints a vector oval with stroke none when the stroke toggle is on', async () => {
    await openCostumes()
    await page.getByRole('button', { name: 'Transparent stroke' }).click()
    await drawVectorDrag('oval')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stroke="none"'))
    expect(await previewHtml()).toContain('stroke="none"')
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.getByRole('button', { name: 'Transparent stroke' }).click()
    // Non-destructive: opaque strokes still work after the transparent operation.
    await drawVectorDrag('oval')
    await page.waitForFunction(() => document.querySelector('.vector-preview')?.innerHTML.includes('stroke="#0f172a"'))
    expect(await previewHtml()).toContain('stroke="#0f172a"')
  }, 60_000)

  it('erases a bitmap stroke with transparent flood fill and round-trips undo/redo', async () => {
    await openCostumes()
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await canvas.waitFor({ state: 'visible' })
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const pixel = () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const { width, height } = element
        return Array.from(element.getContext('2d')!.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data)
      })
    await page.getByTestId('bitmap-tool-brush').click()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    await page.mouse.move(x - 8, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 200 && g < 40 && b < 40 && a === 255
    })
    // Transparent flood fill erases the connected stroke to alpha 0.
    await page.getByTestId('bitmap-tool-fill').click()
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    await page.mouse.click(x, y)
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    expect((await pixel())[3]).toBe(0)
    // Undo restores the opaque stroke; redo erases again.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 200 && g < 40 && b < 40 && a === 255
    })
    const restored = await pixel()
    expect(restored[3]).toBe(255)
    expect(restored[0]).toBeGreaterThan(200)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    expect((await pixel())[3]).toBe(0)
    // Transparent-to-color restore: the hex survived the transparent fill.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
  }, 90_000)
})
