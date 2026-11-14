import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor UI E2E for the inline-text IME guard in BOTH modes (vector and
// bitmap text tools): composition-phase keys dispatched at the REAL overlay
// textarea must keep the textarea open with no save and no history growth,
// then a plain Escape after compositionend commits exactly one history entry.
// Undo/Redo round-trips and the normal (non-IME) Enter newline are verified
// per mode against the live page.
//
// This uses synthetic CompositionEvents + synthetic IME-flagged keydowns
// (isComposing / keyCode 229) plus TRUSTED keyboard Escape/Enter pressed while
// the synthetic composition window is open. It is NOT the true OS IME: there
// is no OS IME in CI, so native IME behaviors (candidate window consuming
// Enter, confirming keystrokes carrying isComposing) cannot be reproduced.
// What this proves is the guard wiring on the real textarea: every defer
// signal reaches the real handler and nothing commits, saves, or records
// history until the plain post-composition Escape.
//
// Dedicated Vite port (4449), unused by every other browser test.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4449'
const CHROME_PATH =
  process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function canvasShot(): Promise<string> {
  return await page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.toDataURL(),
  )
}

describe('inline-text IME guard on the real editor textarea (both modes)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4449', '--strictPort'], {
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

  it('vector: composition keys keep the textarea open, then Escape commits one history entry', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }

    const marker = `imevec${Date.now().toString(36)}`
    const textTool = page.getByTestId('vector-shape-text').last()
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    // The editor focuses the textarea on open (deferred past the opening
    // click); wait for the caret before typing so every keystroke lands.
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    await page.keyboard.type(marker)
    expect(await textarea.inputValue()).toBe(marker)

    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    const undoDisabledBefore = await undoButton.isDisabled()
    const preview = page.locator('.vector-preview')

    // Synthetic compositionstart opens the guard window (no OS IME in CI).
    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    })

    // Synthetic IME-flagged keydowns at the REAL textarea: no commit, no preventDefault.
    const imeDispatch = await textarea.evaluate((node) => {
      const fire = (init: KeyboardEventInit, keyCode?: number) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        if (keyCode !== undefined) {
          Object.defineProperty(event, 'keyCode', { value: keyCode })
          Object.defineProperty(event, 'which', { value: keyCode })
        }
        if ((init as { isComposing?: boolean }).isComposing !== undefined) {
          Object.defineProperty(event, 'isComposing', {
            value: (init as { isComposing?: boolean }).isComposing,
          })
        }
        node.dispatchEvent(event)
        return event.defaultPrevented
      }
      return {
        isComposingEscape: fire({ key: 'Escape', isComposing: true }),
        isComposingEnter: fire({ key: 'Enter', isComposing: true }),
        keyCode229: fire({ key: 'Escape' }, 229),
      }
    })
    expect(imeDispatch).toEqual({ isComposingEscape: false, isComposingEnter: false, keyCode229: false })
    expect(await overlay.isVisible()).toBe(true)

    // TRUSTED Escape while the composition window is open must defer (no commit).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await overlay.isVisible()).toBe(true)
    expect(await textarea.evaluate((node) => document.activeElement === node)).toBe(true)
    expect((await preview.textContent()) ?? '').not.toContain(marker)
    expect(await undoButton.isDisabled()).toBe(undoDisabledBefore)

    // TRUSTED Enter while composing must not commit either (stays open).
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)
    expect((await preview.textContent()) ?? '').not.toContain(marker)
    expect(await undoButton.isDisabled()).toBe(undoDisabledBefore)

    // compositionend alone never commits.
    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)
    expect(await undoButton.isDisabled()).toBe(undoDisabledBefore)

    // Plain Escape after compositionend commits exactly one history entry.
    expect(await textarea.inputValue()).toContain(marker)
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      marker as unknown as undefined,
      { timeout: 10_000 },
    )
    await undoButton.click()
    await page.waitForFunction(
      (want) => !(document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false),
      marker as unknown as undefined,
      { timeout: 10_000 },
    )
    expect((await preview.textContent()) ?? '').not.toContain(marker)
    await redoButton.click()
    await page.waitForFunction(
      (want) => document.querySelector('.vector-preview')?.textContent?.includes(want as string) ?? false,
      marker as unknown as undefined,
      { timeout: 10_000 },
    )
    expect((await preview.textContent()) ?? '').toContain(marker)

    // Normal (non-IME) Enter still inserts a newline in a fresh session.
    await textTool.click()
    const reopenBox = await surface.boundingBox()
    if (!reopenBox) throw new Error('Missing paint surface bounds')
    await page.mouse.click(
      reopenBox.x + reopenBox.width * 0.75,
      reopenBox.y + reopenBox.height * 0.7,
    )
    await overlay.waitFor({ state: 'visible' })
    await textarea.fill('')
    await page.keyboard.type('aa')
    await page.keyboard.press('Enter')
    await page.keyboard.type('bb')
    expect(await textarea.inputValue()).toBe('aa\nbb')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
  }, 120_000)

  it('bitmap: composition keys keep the textarea open, then Escape commits one history entry', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    }
    const canvas = page.getByTestId('bitmap-editor-canvas')
    await canvas.waitFor({ state: 'visible' })
    const preCommit = await canvasShot()

    const textTool = page.getByTestId('bitmap-tool-text')
    await textTool.waitFor({ state: 'visible' })
    await textTool.click()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap canvas bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    const overlay = page.locator('[data-inline-text-editor]')
    await overlay.waitFor({ state: 'visible' })
    const textarea = overlay.locator('textarea')
    await textarea.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
      undefined,
      { timeout: 10_000 },
    )
    await page.keyboard.type('ime-bitmap')
    expect(await textarea.inputValue()).toBe('ime-bitmap')

    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    })

    const imeDispatch = await textarea.evaluate((node) => {
      const fire = (init: KeyboardEventInit, keyCode?: number) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        if (keyCode !== undefined) {
          Object.defineProperty(event, 'keyCode', { value: keyCode })
          Object.defineProperty(event, 'which', { value: keyCode })
        }
        if ((init as { isComposing?: boolean }).isComposing !== undefined) {
          Object.defineProperty(event, 'isComposing', {
            value: (init as { isComposing?: boolean }).isComposing,
          })
        }
        node.dispatchEvent(event)
        return event.defaultPrevented
      }
      return {
        isComposingEscape: fire({ key: 'Escape', isComposing: true }),
        isComposingEnter: fire({ key: 'Enter', isComposing: true }),
        keyCode229: fire({ key: 'Escape' }, 229),
      }
    })
    expect(imeDispatch).toEqual({ isComposingEscape: false, isComposingEnter: false, keyCode229: false })
    expect(await overlay.isVisible()).toBe(true)

    // TRUSTED Escape/Enter while composing: textarea stays, canvas untouched, no save.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await overlay.isVisible()).toBe(true)
    expect(await textarea.evaluate((node) => document.activeElement === node)).toBe(true)
    expect(await canvasShot()).toBe(preCommit)
    const bodyBeforeSave = await page.evaluate(() => document.body.textContent ?? '')
    expect(bodyBeforeSave).not.toContain('Bitmap text saved')

    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)
    expect(await canvasShot()).toBe(preCommit)

    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(300)
    expect(await overlay.isVisible()).toBe(true)
    expect(await canvasShot()).toBe(preCommit)

    // Plain Escape after compositionend commits exactly one history entry.
    expect(await textarea.inputValue()).toContain('ime-bitmap')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.body.textContent?.includes('Bitmap text saved') ?? false,
      undefined,
      { timeout: 10_000 },
    )
    const postCommit = await canvasShot()
    expect(postCommit).not.toBe(preCommit)

    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await page.waitForTimeout(500)
    expect(await canvasShot()).toBe(preCommit)
    await redoButton.click()
    await page.waitForTimeout(500)
    expect(await canvasShot()).toBe(postCommit)

    // Normal (non-IME) Enter still inserts a newline in a fresh session, and
    // that commit is a single Undo entry on top of the IME commit.
    await textTool.click()
    const reopenBox = await canvas.boundingBox()
    if (!reopenBox) throw new Error('Missing bitmap canvas bounds')
    // The canvas is zoom-scaled beyond the viewport: fraction points can land
    // off-screen, so offset from the (visible) center in page pixels instead.
    // Converted sprite canvases are the 960x720 artboard (small sources
    // placed inside it), so the offset is clamped into the box: the legacy
    // +150/+90 would land off-canvas on a small raster and open no session.
    // Assertions below are unchanged.
    const secondDx = Math.min(150, reopenBox.width * 0.25)
    const secondDy = Math.min(90, reopenBox.height * 0.2)
    await page.mouse.click(
      reopenBox.x + reopenBox.width / 2 + secondDx,
      reopenBox.y + reopenBox.height / 2 + secondDy,
    )
    await overlay.waitFor({ state: 'visible' })
    await textarea.fill('')
    await page.keyboard.type('xx')
    await page.keyboard.press('Enter')
    await page.keyboard.type('yy')
    expect(await textarea.inputValue()).toBe('xx\nyy')
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden' })
    await page.waitForTimeout(800)
    const secondCommit = await canvasShot()
    expect(secondCommit).not.toBe(postCommit)
    await undoButton.click()
    await page.waitForTimeout(500)
    expect(await canvasShot()).toBe(postCommit)
  }, 120_000)
})
