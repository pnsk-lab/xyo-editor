import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-screen coverage for the transparent bitmap brush: a transparent
// (`null`) brush erases with destination-out at the same brush size
// (reference brush-tool.js draws a null-color brush with destination-out),
// reusing the existing eraser stamp path. Flow: opaque stroke, transparent
// toggle, erase drag, center-pixel alpha 0, Undo restores, Redo erases,
// untoggle restores the hex and opaque painting works again.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4235'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function openBitmapCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

describe('transparent bitmap brush on the real costume screen', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4235', '--strictPort'], {
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

  it('erases with a transparent brush and round-trips undo/redo plus opaque restore', async () => {
    await openBitmapCostumes()
    const canvas = page.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const pixel = () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const { width, height } = element
        return Array.from(element.getContext('2d')!.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data)
      })

    // Opaque baseline stroke through the real brush tool.
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
    expect((await pixel())[3]).toBe(255)

    // Transparent toggle keeps the hex, then the same brush erases the stroke.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    await page.mouse.move(x - 8, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 8 })
    await page.mouse.up()
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
    expect((await pixel())[3]).toBe(255)
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data[3] === 0
    })
    expect((await pixel())[3]).toBe(0)

    // Untoggling restores the hex and opaque painting works again.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByLabel('Paint color', { exact: true }).inputValue()).toBe('#ff0000')
    await page.mouse.move(x - 8, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = target.getContext('2d')!.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
      return r > 200 && g < 40 && b < 40 && a === 255
    })
    expect((await pixel())[3]).toBe(255)
  }, 90_000)
})
