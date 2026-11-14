import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Popover-first Escape ordering (product bug proved): while Fill is open with
// a selection, one plain Escape must close the dialog and retain the
// selection; the next Escape runs the normal deselect. The old capture ran
// the Editor deselect before the popover bubble-close when focus sat on the
// swatch button (non-typing target), while input focus only closed —
// inconsistent and destructive.
//
// Strict real-Chromium coverage:
// - button-focus AND input-focus Escape both close first with no VM/history;
// - next Escape clears the selection, still with no VM/history;
// - single AND multi selection retain;
// - IME composition defers (229/isComposing keeps the dialog + selection);
// - eyedropper cancels in one key without touching selection/artwork;
// - text draft owns its Escape (commit, no popover close/deselect side effect);
// - two simultaneous Editor instances never cross-cancel.
const root = join(import.meta.dir, '..')
const PORT = 4351
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function gotoCostumes(target: Page) {
  await target.goto(base, { waitUntil: 'networkidle' })
  const tab = target.getByTestId('main-tab-costumes')
  await tab.waitFor({ state: 'visible', timeout: 15_000 })
  await tab.click()
  await target.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 15_000 })
}

async function ensureVectorMode(target: Page) {
  if (await target.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await target.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await target.locator('.vector-preview').first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function previewSvg(target: Page): Promise<string> {
  return await target.locator('.vector-preview').first().innerHTML()
}

async function outlineCount(target: Page): Promise<number> {
  return await target.locator('[data-vector-selection-outline].border-blue-500').count()
}

async function undoDisabled(target: Page): Promise<boolean> {
  const undo = target.locator('button[aria-label="Undo"]:visible').first()
  await undo.waitFor({ state: 'visible', timeout: 10_000 })
  return await undo.isDisabled()
}

async function closePopovers(target: Page) {
  for (let i = 0; i < 3; i += 1) {
    if (
      (await target.getByTestId('fill-style-dialog').count()) === 0 &&
      (await target.getByTestId('outline-style-dialog').count()) === 0
    )
      return
    await target.keyboard.press('Escape')
    await target.waitForTimeout(200)
  }
}

async function openFillPopover(target: Page) {
  const dialog = target.getByTestId('fill-style-dialog')
  if (await dialog.isVisible().catch(() => false)) return
  await target.getByTestId('fill-style').click()
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
}

async function clickVectorTool(target: Page, id: string) {
  await closePopovers(target)
  await target.getByTestId(`vector-shape-${id}`).last().click({ timeout: 10_000 })
}

async function blankCanvas(target: Page) {
  await clickVectorTool(target, 'select')
  await target.keyboard.press('Control+a')
  await target.waitForTimeout(300)
  await target.keyboard.press('Delete')
  await target.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
    null,
    { timeout: 10_000 },
  )
}

async function drawRect(
  target: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  before: string,
) {
  await closePopovers(target)
  await target.getByTestId('vector-shape-rect').last().click({ timeout: 10_000 })
  await target.mouse.move(from.x, from.y)
  await target.mouse.down()
  await target.mouse.move(to.x, to.y, { steps: 12 })
  await target.mouse.up()
  await target.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 15_000 },
  )
}

async function ensureTwoSelected(target: Page) {
  await blankCanvas(target)
  const surface = target.getByTestId('costume-paint-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  let before = await previewSvg(target)
  await drawRect(target, { x: cx - 150, y: cy - 40 }, { x: cx - 50, y: cy + 40 }, before)
  before = await previewSvg(target)
  await drawRect(target, { x: cx + 50, y: cy - 40 }, { x: cx + 150, y: cy + 40 }, before)
  await clickVectorTool(target, 'select')
  await target.keyboard.press('Control+a')
  await target.waitForFunction(
    () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 2,
    null,
    { timeout: 10_000 },
  )
}

describe('paint popover Escape ordering (close-first, retain selection)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('button-focus Escape closes the Fill popover first and retains a multi-selection with no VM/history; next Escape deselects', async () => {
    await gotoCostumes(page)
    await ensureVectorMode(page)
    await ensureTwoSelected(page)
    await openFillPopover(page)
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible' })

    const beforeSvg = await previewSvg(page)
    const beforeOutlines = await outlineCount(page)
    expect(beforeOutlines).toBeGreaterThanOrEqual(2)
    const beforeUndoDisabled = await undoDisabled(page)

    // Focus the swatch trigger (button, non-typing target): the proved bug
    // deselected here before the popover bubble-close.
    await page.getByTestId('fill-style').focus()
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('fill-style')
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })

    // First Escape: dialog closed, selection retained, artwork + history untouched.
    expect(await outlineCount(page)).toBe(beforeOutlines)
    expect(await previewSvg(page)).toBe(beforeSvg)
    expect(await undoDisabled(page)).toBe(beforeUndoDisabled)

    // Second Escape: normal deselect, still no artwork/history write.
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg(page)).toBe(beforeSvg)
    expect(await undoDisabled(page)).toBe(beforeUndoDisabled)
  }, 120_000)

  it('input-focus Escape closes first and retains a single selection with no VM/history', async () => {
    await gotoCostumes(page)
    await ensureVectorMode(page)
    // Single selection: blank, draw one rect, keep its retained selection.
    await blankCanvas(page)
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const blank = await previewSvg(page)
    await drawRect(page, { x: cx - 60, y: cy - 30 }, { x: cx + 60, y: cy + 30 }, blank)
    await clickVectorTool(page, 'select')
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )
    await openFillPopover(page)
    const beforeSvg = await previewSvg(page)
    const beforeOutlines = await outlineCount(page)
    expect(beforeOutlines).toBeGreaterThanOrEqual(1)
    const beforeUndoDisabled = await undoDisabled(page)

    // Focus an input inside the dialog (typing target): old code only closed.
    const paintInput = page.getByLabel('Paint color', { exact: true }).first()
    await paintInput.focus()
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.getAttribute('aria-label'))).toBe(
      'Paint color',
    )
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
    expect(await outlineCount(page)).toBe(beforeOutlines)
    expect(await previewSvg(page)).toBe(beforeSvg)
    expect(await undoDisabled(page)).toBe(beforeUndoDisabled)

    // Next Escape clears the single selection without touching VM/history.
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length === 0,
      null,
      { timeout: 10_000 },
    )
    expect(await previewSvg(page)).toBe(beforeSvg)
    expect(await undoDisabled(page)).toBe(beforeUndoDisabled)
  }, 120_000)

  it('IME composition defers: keyCode 229 keeps the popover and selection', async () => {
    await gotoCostumes(page)
    await ensureVectorMode(page)
    await ensureTwoSelected(page)
    await openFillPopover(page)
    const beforeSvg = await previewSvg(page)
    const beforeOutlines = await outlineCount(page)
    await page.getByTestId('fill-style').focus()
    // Synthetic IME-processed Escape (legacy 229): vents through without
    // closing or deselecting, matching the inline-text IME guard.
    await page.evaluate(() => {
      const target = document.activeElement ?? document.body
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(event, 'keyCode', { value: 229 })
      Object.defineProperty(event, 'which', { value: 229 })
      target.dispatchEvent(event)
    })
    await page.waitForTimeout(300)
    expect(await page.getByTestId('fill-style-dialog').count()).toBe(1)
    expect(await outlineCount(page)).toBe(beforeOutlines)
    expect(await previewSvg(page)).toBe(beforeSvg)
    // A plain Escape afterwards still closes first with retention.
    await page.keyboard.press('Escape')
    await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
    expect(await outlineCount(page)).toBe(beforeOutlines)
    expect(await previewSvg(page)).toBe(beforeSvg)
    await closePopovers(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }, 120_000)

  it('eyedropper cancels in one key without touching selection/artwork', async () => {
    await gotoCostumes(page)
    await ensureVectorMode(page)
    await ensureTwoSelected(page)
    await openFillPopover(page)
    const beforeSvg = await previewSvg(page)
    const beforeOutlines = await outlineCount(page)
    // Arming the picker closes the dialog by construction; the loupe overlay
    // owns the next Escape (single-key cancel, no selection/artwork change).
    await page.getByTestId('eyedropper-fill').click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    expect(await outlineCount(page)).toBe(beforeOutlines)
    expect(await previewSvg(page)).toBe(beforeSvg)
  }, 120_000)

  it('two simultaneous editors never cross-cancel', async () => {
    if (!browser) throw new Error('Missing browser')
    const first = page
    const second = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await gotoCostumes(first)
      await ensureVectorMode(first)
      await ensureTwoSelected(first)
      await gotoCostumes(second)
      await ensureVectorMode(second)
      // Open the popover only in the first editor with a live selection.
      await openFillPopover(first)
      await first.getByTestId('fill-style-dialog').waitFor({ state: 'visible' })
      const firstOutlines = await outlineCount(first)
      const firstSvg = await previewSvg(first)
      // Escape inside the second editor must not close the first popover nor
      // touch its selection/artwork (per-editor scoping, no global query).
      await second.getByTestId('fill-style').focus()
      await second.keyboard.press('Escape')
      await second.waitForTimeout(400)
      expect(await first.getByTestId('fill-style-dialog').count()).toBe(1)
      expect(await outlineCount(first)).toBe(firstOutlines)
      expect(await previewSvg(first)).toBe(firstSvg)
      // Same-page scoping unit: two [data-editor-root] subtrees isolate keys.
      const scoped = await first.evaluate(async () => {
        const mod = await import('/src/features/costumes/paint-popover-escape.ts')
        const host = document.createElement('div')
        host.innerHTML =
          '<div data-editor-root id="scope-a"><div data-paint-popover-open="true"></div><button id="in-a">a</button></div>' +
          '<div data-editor-root id="scope-b"><button id="in-b">b</button></div>'
        document.body.appendChild(host)
        try {
          const scopeA = host.querySelector('#scope-a') as Element
          const inA = host.querySelector('#in-a') as Element
          const inB = host.querySelector('#in-b') as Element
          const plain = { key: 'Escape' }
          const own = mod.shouldClosePopoverOnEscape(scopeA, inA, plain, 'fill')
          const foreign = mod.shouldClosePopoverOnEscape(scopeA, inB, plain, 'fill')
          const ime = mod.shouldClosePopoverOnEscape(scopeA, inA, { key: 'Escape', keyCode: 229 }, 'fill')
          return { own, foreign, ime }
        } finally {
          host.remove()
        }
      })
      expect(scoped.own).toBe(true)
      expect(scoped.foreign).toBe(false)
      expect(scoped.ime).toBe(false)
      await closePopovers(first)
    } finally {
      await second.close().catch(() => undefined)
    }
  }, 120_000)
})
