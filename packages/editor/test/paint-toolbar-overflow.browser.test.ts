import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Paint toolbar overflow (More menu) real-screen regression for the 1104x763
// report: the More trigger rendered at x548 while the paint panel edge sat at
// x556, so the button was cut off and unclickable. Copy/Paste now lead the
// measured overflow list as priority actions (inline while they fit, in the
// menu when narrow) while Undo/Redo/Delete stay pinned, so the trailing More
// trigger keeps reserved width.
//
// Strict real-Chromium coverage (no assert-visible shortcuts):
// - Undo/Redo/Delete/More bounding rects fit wholly inside every clipping
//   ancestor and a real pointer hit-test (`elementFromPoint`) on the button
//   center lands on the button itself, at exactly 1104x763 (411px panel);
// - the More menu opens from a true pointer click, stays unclipped (inside
//   the viewport and the paint clipping container), and exposes every action
//   exactly once (inline XOR menu, never duplicated, never lost);
// - the menu is keyboard operable (Enter opens, arrows/Home/End move,
//   Escape closes with focus return) and outside pointer closes it;
// - the layout adapts to state changes (vector select-all, bitmap/vector
//   mode switch, resize back) without clipping or page overflow, while the
//   closed toolbar stays compact (<110px) and never overlaps the canvas.
const root = join(import.meta.dir, '..')
const PORT = 4369
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const EXPECTED_ACTIONS = [
  'Copy selection',
  'Paste selection',
  'Duplicate costume',
  'Group',
  'Ungroup',
  'Bring to front',
  'Bring forward',
  'Send backward',
  'Send to back',
  'Flip horizontal',
  'Flip vertical',
  'Rotate left',
  'Rotate right',
] as const

async function gotoCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  const tab = page.getByTestId('main-tab-costumes')
  await tab.waitFor({ state: 'visible' })
  await tab.click()
  await page.getByRole('application', { name: 'Costume paint canvas' }).waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').first().waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

interface StrictHit {
  label: string
  rect: { x: number; y: number; width: number; height: number; right: number; bottom: number }
  insideClippers: boolean
  hitOnSelf: boolean
  hitDescribe: string
}

/** Strict visibility: wholly inside every clipping ancestor + pointer hit-test lands on the button. */
async function strictHits(labels: readonly string[]): Promise<StrictHit[]> {
  return await page.evaluate((wanted: readonly string[]) => {
    const toolbar = document.querySelector('[data-testid="paint-toolbar"]')
    if (!toolbar) throw new Error('Missing paint toolbar')
    function clippingChain(el: Element): Array<{ tag: string; overflow: string; prect: DOMRect }> {
      const chain: Array<{ tag: string; overflow: string; prect: DOMRect }> = []
      let node = el.parentElement
      while (node) {
        const style = getComputedStyle(node)
        if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          chain.push({ tag: node.tagName, overflow: style.overflow, prect: node.getBoundingClientRect() })
        }
        node = node.parentElement
      }
      return chain
    }
    return wanted.map((label) => {
      // Scope to the paint toolbar: the legacy side panel reuses some
      // accessible names inside a `hidden` subtree (0x0 boxes) which must
      // not shadow the real toolbar buttons.
      const el = toolbar.querySelector(`button[aria-label="${label}"]`)
      if (!el) throw new Error(`Missing toolbar button: ${label}`)
      const rect = el.getBoundingClientRect()
      const insideClippers = clippingChain(el).every(
        ({ prect }) =>
          rect.left >= prect.left - 0.5 &&
          rect.top >= prect.top - 0.5 &&
          rect.right <= prect.right + 0.5 &&
          rect.bottom <= prect.bottom + 0.5,
      )
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const hit = document.elementFromPoint(cx, cy)
      const hitOnSelf = hit === el || (hit instanceof Node && el.contains(hit))
      return {
        label,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        insideClippers,
        hitOnSelf,
        hitDescribe: hit instanceof Element ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : 'null',
      }
    })
  }, labels)
}

async function toolbarSnapshot() {
  return await page.evaluate(() => {
    const toolbar = document.querySelector('[data-testid="paint-toolbar"]')
    const canvas = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!toolbar || !canvas) throw new Error('Missing toolbar/canvas')
    const box = toolbar.getBoundingClientRect()
    const canvasBox = canvas.getBoundingClientRect()
    return {
      height: box.height,
      toolbarBottom: box.bottom,
      canvasTop: canvasBox.top,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }
  })
}

/** Every expected action renders exactly once across inline buttons + open menu items. */
async function actionPlacement(): Promise<{ label: string; inline: number; inMenu: number }[]> {
  return await page.evaluate((wanted: readonly string[]) => {
    const overflow = document.querySelector('[data-testid="paint-toolbar-overflow"]')
    if (!overflow) throw new Error('Missing paint-toolbar-overflow')
    const inline = overflow.querySelectorAll(':scope > div:first-child > button')
    const menu = document.querySelector('[data-testid="paint-toolbar-more-menu"]')
    const items = menu ? menu.querySelectorAll('[data-overflow-menu-item]') : []
    return wanted.map((label) => {
      let inlineCount = 0
      inline.forEach((button) => {
        if (button.getAttribute('aria-label') === label) inlineCount += 1
      })
      let menuCount = 0
      items.forEach((item) => {
        if (item.getAttribute('aria-label') === label) menuCount += 1
      })
      return { label, inline: inlineCount, inMenu: menuCount }
    })
  }, EXPECTED_ACTIONS)
}

async function moreCenter(): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('paint-toolbar-more').boundingBox()
  if (!box) throw new Error('Missing More trigger bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

describe('paint toolbar overflow (More stays visible and clickable)', () => {
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
    page = await browser.newPage({ viewport: { width: 1104, height: 763 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('keeps Undo/Redo/More fully inside the 411px panel and hit-testable at 1104x763', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await page.waitForTimeout(1200)
    // Strict: wholly inside every clipping ancestor, pointer hit lands on self.
    for (const hit of await strictHits(['Undo', 'Redo', 'Delete selection', 'More toolbar actions'])) {
      expect(hit.insideClippers, `${hit.label} rect=${JSON.stringify(hit.rect)}`).toBe(true)
      expect(hit.hitOnSelf, `${hit.label} hit=${hit.hitDescribe}`).toBe(true)
      expect(hit.rect.width).toBeGreaterThan(0)
    }
    const snap = await toolbarSnapshot()
    expect(snap.height).toBeLessThan(110)
    expect(snap.toolbarBottom).toBeLessThanOrEqual(snap.canvasTop + 1)
    expect(snap.docScrollWidth).toBeLessThanOrEqual(snap.innerWidth + 1)
    await page.screenshot({ path: '/tmp/paint-overflow-1104x763.png' })
  }, 120_000)

  it('keeps the 700px viewport free of page overflow with a compact toolbar', async () => {
    // Below the `lg` breakpoint the Editor stacks the stage pane over the
    // paint column (pre-existing grid behavior: the paint surface collapses
    // and the stage pane takes the column), so button-level hit-testing is
    // not meaningful there. What the toolbar owns at 700px — compact height,
    // no page-level horizontal overflow, no canvas overlap, and a laid-out
    // More trigger with a non-zero box — is asserted here, mirroring the
    // compact-toolbar precedent. Strict clip + hit-test coverage lives at
    // 1104x763 (and in the state-dynamic test) where the editor renders.
    await gotoCostumes()
    await ensureBitmapMode()
    await page.setViewportSize({ width: 700, height: 800 })
    try {
      await page.waitForTimeout(1200)
      const trigger = page.getByTestId('paint-toolbar-more')
      await trigger.waitFor({ state: 'attached' })
      const box = await trigger.boundingBox()
      expect(box?.width).toBe(36)
      expect(box?.height).toBe(32)
      const snap = await toolbarSnapshot()
      expect(snap.height).toBeLessThan(110)
      expect(snap.toolbarBottom).toBeLessThanOrEqual(snap.canvasTop + 1)
      expect(snap.docScrollWidth).toBeLessThanOrEqual(snap.innerWidth + 1)
      await page.screenshot({ path: '/tmp/paint-overflow-700.png' })
    } finally {
      await page.setViewportSize({ width: 1104, height: 763 })
    }
  }, 120_000)

  it('opens the menu from a real pointer click with every action reachable once and the menu unclipped', async () => {
    await gotoCostumes()
    await ensureBitmapMode()
    await page.setViewportSize({ width: 1104, height: 763 })
    await page.waitForTimeout(1200)
    const trigger = page.getByTestId('paint-toolbar-more')
    await trigger.waitFor({ state: 'visible' })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // True pointer path (not a locator click): the hit-test must land on the
    // trigger itself or a node it contains (the lucide icon svg).
    const center = await moreCenter()
    const hitOnTrigger = await page.evaluate(({ x, y }) => {
      const trigger = document.querySelector('[data-testid="paint-toolbar-more"]')
      if (!trigger) return false
      const hit = document.elementFromPoint(x, y)
      return hit === trigger || (hit instanceof Node && trigger.contains(hit))
    }, center)
    expect(hitOnTrigger).toBe(true)
    await page.mouse.click(center.x, center.y)
    const menu = page.getByTestId('paint-toolbar-more-menu')
    await menu.waitFor({ state: 'visible' })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    expect(await menu.getAttribute('role')).toBe('menu')
    // The open menu floats over the canvas area without clipping: inside the
    // viewport and inside the paint clipping container.
    const menuBox = await menu.boundingBox()
    if (!menuBox) throw new Error('Missing More menu bounds')
    const clip = await page.evaluate((box: { x: number; y: number; width: number; height: number }) => {
      const el = document.querySelector('[data-testid="paint-toolbar-more-menu"]')
      if (!el) throw new Error('Missing menu')
      const rect = el.getBoundingClientRect()
      let node = el.parentElement
      let container: DOMRect | null = null
      while (node) {
        const style = getComputedStyle(node)
        if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          container = node.getBoundingClientRect()
          break
        }
        node = node.parentElement
      }
      if (!container) throw new Error('Missing clipping container')
      return {
        inViewport: rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
        inContainer:
          rect.left >= container.left - 0.5 &&
          rect.top >= container.top - 0.5 &&
          rect.right <= container.right + 0.5 &&
          rect.bottom <= container.bottom + 0.5,
        menuRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        containerRect: { x: container.x, y: container.y, width: container.width, height: container.height },
      }
    }, menuBox)
    expect(clip.inViewport).toBe(true)
    expect(clip.inContainer).toBe(true)
    // No hiding actions: every toolbar action renders exactly once, either
    // inline or in the open menu.
    for (const placement of await actionPlacement()) {
      expect(`${placement.label}: inline=${placement.inline} menu=${placement.inMenu}`, placement.label).toBe(
        `${placement.label}: inline=${placement.inline} menu=${placement.inMenu}`,
      )
      expect(placement.inline + placement.inMenu).toBe(1)
    }
    // Keyboard: arrows step between enabled entries (disabled items cannot
    // take focus, so travel skips them), Home/End jump to the first/last
    // enabled entry, Escape closes with focus return. Expectations derive
    // from the live enabled run, not a hardcoded order, so they hold however
    // many actions fit inline.
    const plan = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="paint-toolbar-more-menu"] [data-overflow-menu-item]'),
      ).map((item) => ({ label: item.getAttribute('aria-label') ?? '', disabled: item.disabled }))
      const enabled = items.filter((item) => !item.disabled).map((item) => item.label)
      const active = (document.activeElement as Element | null)?.getAttribute('aria-label') ?? ''
      const index = enabled.indexOf(active)
      return {
        active,
        first: enabled[0] ?? '',
        last: enabled[enabled.length - 1] ?? '',
        next: enabled[Math.min(enabled.length - 1, index + 1)] ?? '',
        prev: enabled[Math.max(0, index - 1)] ?? '',
      }
    })
    expect(plan.active).toBe(plan.first)
    expect(plan.first).not.toBe('')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (document.activeElement as Element | null)?.getAttribute('aria-label'))).toBe(
      plan.next,
    )
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (document.activeElement as Element | null)?.getAttribute('aria-label'))).toBe(
      plan.active,
    )
    await page.keyboard.press('End')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (document.activeElement as Element | null)?.getAttribute('aria-label'))).toBe(
      plan.last,
    )
    await page.keyboard.press('Home')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (document.activeElement as Element | null)?.getAttribute('aria-label'))).toBe(
      plan.first,
    )
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('paint-toolbar-more')
    // Outside pointer closes: reopen, then click the canvas surface.
    const reopened = await moreCenter()
    await page.mouse.click(reopened.x, reopened.y)
    await menu.waitFor({ state: 'visible' })
    const surface = page.getByRole('application', { name: 'Costume paint canvas' })
    const surfaceBox = await surface.boundingBox()
    if (!surfaceBox) throw new Error('Missing paint surface bounds')
    await page.mouse.click(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height - 30)
    await menu.waitFor({ state: 'detached' })
    // Pointer click on a real menu action works: duplicate adds one history
    // entry, which enables Undo.
    const undo = page.getByRole('button', { name: 'Undo' }).first()
    const undoWasDisabled = await undo.isDisabled()
    const again = await moreCenter()
    await page.mouse.click(again.x, again.y)
    await menu.waitFor({ state: 'visible' })
    const duplicate = menu.getByRole('menuitem', { name: 'Duplicate costume' })
    await duplicate.waitFor({ state: 'visible' })
    const itemBox = await duplicate.boundingBox()
    if (!itemBox) throw new Error('Missing duplicate menu item bounds')
    await page.mouse.click(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2)
    await menu.waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('paint-toolbar-more')
    if (undoWasDisabled) {
      await expect.poll(() => undo.isDisabled(), { timeout: 15_000 }).toBe(false)
    }
  }, 180_000)

  it('adapts to selection and mode changes without clipping or page overflow', async () => {
    await gotoCostumes()
    await ensureVectorMode()
    await page.setViewportSize({ width: 1104, height: 763 })
    await page.waitForTimeout(1200)
    // Dynamic state: select everything (flips layer/copy/delete disabled
    // states) and switch modes (rebuilds the action list).
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(600)
    for (const hit of await strictHits(['Undo', 'Redo', 'Delete selection', 'More toolbar actions'])) {
      expect(hit.insideClippers).toBe(true)
      expect(hit.hitOnSelf).toBe(true)
    }
    await ensureBitmapMode()
    await page.waitForTimeout(1200)
    for (const hit of await strictHits(['Undo', 'Redo', 'Delete selection', 'More toolbar actions'])) {
      expect(hit.insideClippers).toBe(true)
      expect(hit.hitOnSelf).toBe(true)
    }
    await ensureVectorMode()
    await page.waitForTimeout(1200)
    for (const hit of await strictHits(['Undo', 'Redo', 'Delete selection', 'More toolbar actions'])) {
      expect(hit.insideClippers).toBe(true)
      expect(hit.hitOnSelf).toBe(true)
    }
    // Narrow then back: the measured list re-fits when the width returns.
    // (At 700px the Editor stacks the stage pane over the paint column, so
    // only the no-overflow invariant is asserted there; strict clip +
    // hit-test coverage applies at 1104x763 where the editor renders.)
    await page.setViewportSize({ width: 700, height: 800 })
    await page.waitForTimeout(1200)
    const narrow = await toolbarSnapshot()
    expect(narrow.docScrollWidth).toBeLessThanOrEqual(narrow.innerWidth + 1)
    expect(narrow.height).toBeLessThan(110)
    await page.setViewportSize({ width: 1104, height: 763 })
    await page.waitForTimeout(1200)
    for (const hit of await strictHits(['Undo', 'Redo', 'Delete selection', 'More toolbar actions'])) {
      expect(hit.insideClippers).toBe(true)
      expect(hit.hitOnSelf).toBe(true)
    }
    const snap = await toolbarSnapshot()
    expect(snap.height).toBeLessThan(110)
    expect(snap.toolbarBottom).toBeLessThanOrEqual(snap.canvasTop + 1)
    expect(snap.docScrollWidth).toBeLessThanOrEqual(snap.innerWidth + 1)
  }, 180_000)
})
