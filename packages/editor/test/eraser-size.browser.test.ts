import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4213'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('eraser size controls in the costume editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4213', '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  for (const mode of ['vector', 'bitmap'] as const) {
    it(`shows synchronized controls and resizes the ${mode} eraser cursor`, async () => {
      if (mode === 'bitmap') {
        await page.getByRole('button', { name: 'ビットマップに変換' }).click()
        await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
      }
      await page.getByTestId(mode === 'bitmap' ? 'bitmap-tool-eraser' : 'vector-shape-eraser').click()
      const slider = page.getByRole('slider', { name: 'Eraser size', exact: true })
      const number = page.getByRole('spinbutton', { name: 'Eraser size value' })
      expect(await slider.isVisible()).toBe(true)
      expect(await number.isVisible()).toBe(true)
      for (const control of [slider, number]) {
        const bounds = await control.boundingBox()
        if (!bounds) throw new Error('Missing eraser control bounds')
        const viewport = page.viewportSize()!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
        expect(await control.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return hit === element
        })).toBe(true)
      }
      await number.fill('20')
      await number.press('Tab')
      expect(await slider.inputValue()).toBe('20')
      const cursorSize = async () => {
        const surface = page.getByTestId('costume-paint-surface')
        const box = await surface.boundingBox()
        if (!box) throw new Error('Missing paint surface')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        const cursor = page.getByTestId('eraser-cursor-preview')
        await cursor.waitFor({ state: 'visible' })
        return cursor.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        })
      }
      const small = await cursorSize()
      await slider.fill('60')
      expect(await number.inputValue()).toBe('60')
      const large = await cursorSize()
      expect(small.width).toBeGreaterThan(0)
      expect(small.height).toBeGreaterThan(0)
      expect(large.width).toBeGreaterThan(small.width)
      expect(large.height).toBeGreaterThan(small.height)
    }, 30_000)
  }

  it('erases vector artwork through the UI', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing vector paint surface')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const preview = page.locator('.vector-preview')
    await preview.waitFor({ state: 'visible' })
    const original = await preview.innerHTML()
    await page.getByTestId('vector-shape-rect').last().click()
    await page.mouse.move(x - 50, y - 40)
    await page.mouse.down()
    await page.mouse.move(x + 50, y + 40, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction((before) => document.querySelector('.vector-preview')?.innerHTML !== before, original)
    const drawn = await preview.innerHTML()
    await page.getByTestId('vector-shape-eraser').click()
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction((before) => document.querySelector('.vector-preview')?.innerHTML !== before, drawn)
    expect(await preview.innerHTML()).not.toBe(drawn)
  }, 30_000)

  it('erases an opaque brush stroke from the bitmap canvas', async () => {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    const canvas = page.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const pixel = () => canvas.evaluate((element: HTMLCanvasElement) => {
      const { width, height } = element
      return Array.from(element.getContext('2d')!.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data)
    })
    await page.getByTestId('bitmap-tool-brush').click()
    await page.getByLabel('Paint color', { exact: true }).fill('#ff00ff')
    await page.mouse.move(x - 8, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b, a] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
      return r > 200 && g < 40 && b > 200 && a === 255
    })
    expect((await pixel())[3]).toBe(255)
    await page.getByTestId('bitmap-tool-eraser').click()
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      return canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3] === 0
    })
    expect((await pixel())[3]).toBe(0)
  }, 30_000)
})
