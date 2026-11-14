import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real page E2E for costume inline text (vector mode):
// tool click -> canvas click -> real textarea newline input -> Escape commit
// -> Undo/Redo -> re-edit the existing text.
// Uses the external Chrome binary and a port unused by the other browser tests
// (4173/4178/4179/4180/4183/4189/4197/4198/4213/4227/4231).
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4237'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('costume inline text editor on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4237', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('tool click, canvas click, newline, Escape commit, Undo/Redo', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })

    // Vector mode is the default; convert back if a previous run left bitmap.
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()

    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    // Tool click -> canvas click opens the real overlay textarea.
    await page.mouse.click(x, y)
    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })

    // The editor focuses the textarea on open.
    expect(await textarea.evaluate((node) => document.activeElement === node)).toBe(true)

    // Real textarea input with a newline via Enter.
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')
    await page.keyboard.type('world')
    expect(await textarea.inputValue()).toBe('hello\nworld')

    // Escape commits (Scratch TEXT_EDIT_MODE parity).
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })

    const preview = page.locator('.vector-preview')
    await preview.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.textContent?.includes('hello') ?? false,
    )
    expect(await preview.textContent()).toContain('hello')
    expect(await preview.textContent()).toContain('world')
    // The committed artwork itself keeps both lines (tspan round-trip).
    expect(await preview.innerHTML()).toContain('<tspan')

    // Undo removes the committed text, Redo restores it.
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await page.waitForFunction(
      () => !(document.querySelector('.vector-preview')?.textContent?.includes('hello') ?? false),
    )
    expect(await preview.textContent()).not.toContain('hello')
    await redoButton.click()
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.textContent?.includes('hello') ?? false,
    )
    expect(await preview.textContent()).toContain('hello')
    expect(await preview.textContent()).toContain('world')
  }, 60_000)

  it('re-edits the existing text with its newline intact', async () => {
    const surface = page.getByTestId('costume-paint-surface')
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    // Clicking the committed text re-opens the overlay prefilled with it.
    const overlay = page.locator('[data-inline-text-editor]')
    await page.mouse.click(x, y)
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    const draft = await textarea.inputValue()
    // Multiline round-trip: the re-edit draft must keep the newline so the
    // second commit is an update of "hello\nworld", not a collapsed string.
    expect(draft).toBe('hello\nworld')
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    const preview = page.locator('.vector-preview')
    await page.waitForFunction(
      () => document.querySelector('.vector-preview')?.textContent?.includes('world!') ?? false,
    )
    expect(await preview.textContent()).toContain('world!')
  }, 60_000)
})
