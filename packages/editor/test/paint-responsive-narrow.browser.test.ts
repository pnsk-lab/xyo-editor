import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Responsive narrow paint layout (390px phone report): the 145px costume rail
// + 132px two-column tool rail left a 98px paint surface with a tall blank
// costume list and tool column. Below 640px the costume rail narrows to a
// 68px icon strip and the tool rail collapses to one 56px column, so the
// canvas keeps >=200px (>=240px at 390px) while every tool, the More menu and
// the costume list stay available. Desktop (1104px) is untouched.
//
// Real-Chromium coverage (no assert-visible shortcuts):
// - canvas width is MEASURED (getBoundingClientRect) at 1104/700/390 and
//   across a live page resize (1104 -> 390 -> 1104), with desktop rail/sidebar
//   geometry restored afterwards;
// - a real pointer drag draws on the bitmap canvas and Undo/Redo round-trip
//   the pixels;
// - every tool button is clicked in both edit modes (eyedropper toggles off);
// - the More trigger passes a strict hit-test (wholly inside every clipping
//   ancestor + elementFromPoint lands on it), opens from a real click without
//   leaving the viewport, lists every action exactly once (inline XOR menu),
//   and closes on Escape with focus return;
// - the costume is changed by clicking a real card (duplicated first through
//   the More menu when the project ships a single costume), with thumbnails
//   and selected numbers still visible at 390px;
// - no page-level horizontal overflow at any width, every visible paint/sidebar
//   button has an accessible name and a >=24px target, and no rail button is
//   clipped (scroll + hit-test per button).
const root = join(import.meta.dir, '..')
const PORT = 4375
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

const BITMAP_TOOLS = ['select', 'brush', 'eraser', 'fill', 'text', 'line', 'oval', 'rect'] as const

async function gotoCostumes(width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto(base, { waitUntil: 'networkidle' })
  const tab = page.getByTestId('main-tab-costumes')
  await tab.waitFor({ state: 'visible' })
  await tab.click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
}

async function ensureBitmapMode() {
  if (!(await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
}

async function ensureVectorMode() {
  if (await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').first().waitFor({ state: 'visible' })
}

async function layoutSnapshot() {
  return await page.evaluate(() => {
    const rectOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
    const surface = rectOf('[data-testid="costume-paint-surface"]')
    const rail = document.querySelector('[data-testid="paint-tool-rail"]')
    const railBox = rail?.getBoundingClientRect()
    const aside = document.querySelector('[data-testid="editor-workspace"] > div > aside')?.getBoundingClientRect()
    if (!surface || !railBox || !aside) throw new Error('Missing paint layout nodes')
    const tracks = getComputedStyle(rail as Element).gridTemplateColumns.split(' ').filter(Boolean).length
    return {
      canvasWidth: surface.width,
      canvasHeight: surface.height,
      railWidth: railBox.width,
      railColumns: tracks,
      sidebarWidth: aside.width,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }
  })
}

async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0
    for (let i = 0; i < data.length; i += 997) hash = ((hash * 31 + (data[i] ?? 0)) >>> 0)
    return `${hash.toString(16)}:${data.length}`
  })
}

async function costumeCount(): Promise<number> {
  return await page.locator('[data-testid^="costume-card-"]').count()
}

describe('responsive narrow paint layout (390px phone)', () => {
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
    page = await browser.newPage({ viewport: { width: 1104, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('measures a usable canvas at 1104/700/390 with no page overflow', async () => {
    for (const viewport of [
      { width: 1104, height: 800 },
      { width: 700, height: 800 },
      { width: 390, height: 844 },
    ] as const) {
      await gotoCostumes(viewport.width, viewport.height)
      await ensureBitmapMode()
      const snap = await layoutSnapshot()
      // No page-level horizontal overflow at any goal width.
      expect(snap.docScrollWidth).toBeLessThanOrEqual(snap.innerWidth + 1)
      // The canvas stays usable everywhere, roomy at narrow widths.
      expect(snap.canvasWidth).toBeGreaterThanOrEqual(200)
      if (viewport.width === 390) {
        expect(snap.canvasWidth).toBeGreaterThanOrEqual(240)
        expect(snap.railWidth).toBeLessThanOrEqual(64)
        expect(snap.sidebarWidth).toBeLessThanOrEqual(80)
      } else {
        // Desktop/tablet geometry is preserved (145px picker, 132px rail).
        expect(snap.sidebarWidth).toBeGreaterThanOrEqual(140)
        expect(snap.sidebarWidth).toBeLessThanOrEqual(160)
        expect(snap.railWidth).toBeGreaterThanOrEqual(120)
      }
      await page.screenshot({ path: `/tmp/paint-responsive-${viewport.width}.png` })
    }
  }, 180_000)

  it('collapses to one column at 390 and restores desktop on resize-back', async () => {
    await gotoCostumes(1104, 800)
    await ensureBitmapMode()
    const desktop = await layoutSnapshot()
    expect(desktop.railColumns).toBe(2)
    // Live resize down: no reload, the CSS-only layout adapts in place.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="paint-tool-rail"]')?.getBoundingClientRect().width <= 64,
    )
    const narrow = await layoutSnapshot()
    expect(narrow.railColumns).toBe(1)
    expect(narrow.canvasWidth).toBeGreaterThanOrEqual(240)
    expect(narrow.docScrollWidth).toBeLessThanOrEqual(narrow.innerWidth + 1)
    // Resize back: desktop appearance is fully restored.
    await page.setViewportSize({ width: 1104, height: 800 })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-testid="paint-tool-rail"]')!).gridTemplateColumns.split(' ').filter(Boolean).length === 2,
    )
    const restored = await layoutSnapshot()
    expect(restored.railColumns).toBe(2)
    expect(Math.abs(restored.railWidth - desktop.railWidth)).toBeLessThanOrEqual(2)
    expect(Math.abs(restored.sidebarWidth - desktop.sidebarWidth)).toBeLessThanOrEqual(2)
    expect(Math.abs(restored.canvasWidth - desktop.canvasWidth)).toBeLessThanOrEqual(2)
    await page.screenshot({ path: '/tmp/paint-responsive-resize-back.png' })
  }, 180_000)

  it('draws with a real drag and round-trips Undo/Redo at 390', async () => {
    await gotoCostumes(390, 844)
    await ensureBitmapMode()
    const before = await layoutSnapshot()
    expect(before.canvasWidth).toBeGreaterThanOrEqual(240)
    await page.getByTestId('bitmap-tool-brush').click()
    // Drag inside the CLIPPED surface box (the raw canvas element overflows
    // its container and can extend past the viewport; surface coords stay
    // hittable so the whole stroke lands on the artwork).
    const surface = page.getByTestId('costume-paint-surface')
    const sbox = await surface.boundingBox()
    if (!sbox) throw new Error('Missing paint surface box')
    const base = await canvasDigest()
    const y = sbox.y + sbox.height / 2
    await page.mouse.move(sbox.x + 12, y)
    await page.mouse.down()
    await page.mouse.move(sbox.x + sbox.width - 12, y, { steps: 12 })
    await page.mouse.up()
    // The drag painted: pixels differ from the pre-stroke digest.
    await page.waitForFunction((prev: string) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data
      let hash = 0
      for (let i = 0; i < data.length; i += 997) hash = ((hash * 31 + (data[i] ?? 0)) >>> 0)
      return `${hash.toString(16)}:${data.length}` !== prev
    }, base)
    const drawn = await canvasDigest()
    expect(drawn).not.toBe(base)
    await page.screenshot({ path: '/tmp/paint-responsive-390-drawn.png' })
    // Undo restores the pre-stroke pixels; Redo repaints them.
    await page.locator('[data-testid="paint-toolbar"] button[aria-label="Undo"]').click()
    await page.waitForFunction((prev: string) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data
      let hash = 0
      for (let i = 0; i < data.length; i += 997) hash = ((hash * 31 + (data[i] ?? 0)) >>> 0)
      return `${hash.toString(16)}:${data.length}` === prev
    }, base)
    expect(await canvasDigest()).toBe(base)
    await page.locator('[data-testid="paint-toolbar"] button[aria-label="Redo"]').click()
    await page.waitForFunction((prev: string) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const data = target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data
      let hash = 0
      for (let i = 0; i < data.length; i += 997) hash = ((hash * 31 + (data[i] ?? 0)) >>> 0)
      return `${hash.toString(16)}:${data.length}` !== prev
    }, base)
    expect(await canvasDigest()).toBe(drawn)
  }, 180_000)

  it('navigates every tool in both edit modes at 390', async () => {
    await gotoCostumes(390, 844)
    await ensureBitmapMode()
    // Every bitmap tool activates on click (visible + enabled + selected).
    for (const tool of BITMAP_TOOLS) {
      const button = page.getByTestId(`bitmap-tool-${tool}`)
      await button.waitFor({ state: 'visible' })
      expect(await button.isEnabled()).toBe(true)
      await button.click()
      expect(await button.getAttribute('class')).toContain('8d5de8')
    }
    // The eyedropper overlay opens and toggles back off, keeping the tool.
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'visible' })
    await page.getByTestId('bitmap-tool-eyedropper').click()
    await page.getByTestId('eyedropper-hint').waitFor({ state: 'detached' })
    // Vector mode: tools stay reachable at 390, then back to bitmap.
    // (Scoped to the rail: a hidden legacy panel reuses the same testIds.)
    await ensureVectorMode()
    for (const tool of ['select', 'reshape', 'brush', 'rect'] as const) {
      const button = page.locator(`[data-testid="paint-tool-rail"] [data-testid="vector-shape-${tool}"]`)
      await button.waitFor({ state: 'visible' })
      expect(await button.isEnabled()).toBe(true)
      await button.click()
    }
    await ensureBitmapMode()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  }, 180_000)

  it('keeps More visible, hittable and complete at 390', async () => {
    await gotoCostumes(390, 844)
    await ensureBitmapMode()
    const strict = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-testid="paint-toolbar"]')
      const more = toolbar?.querySelector('button[aria-label="More toolbar actions"]')
      if (!toolbar || !more) throw new Error('Missing More trigger')
      let node = more.parentElement
      let inside = true
      while (node) {
        const style = getComputedStyle(node)
        if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const prect = node.getBoundingClientRect()
          const rect = more.getBoundingClientRect()
          inside =
            inside &&
            rect.left >= prect.left - 0.5 &&
            rect.top >= prect.top - 0.5 &&
            rect.right <= prect.right + 0.5 &&
            rect.bottom <= prect.bottom + 0.5
        }
        node = node.parentElement
      }
      const rect = more.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        inside,
        hitOnSelf: hit === more || (hit instanceof Node && more.contains(hit)),
        hitDescribe: hit instanceof Element ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : 'null',
      }
    })
    expect(strict.inside).toBe(true)
    expect(strict.hitOnSelf).toBe(true)
    // A real pointer click opens the menu inside the viewport.
    await page.getByTestId('paint-toolbar-more').click()
    const menu = page.getByTestId('paint-toolbar-more-menu')
    await menu.waitFor({ state: 'visible' })
    const menuBox = await menu.boundingBox()
    if (!menuBox) throw new Error('Missing More menu box')
    expect(menuBox.x).toBeGreaterThanOrEqual(-1)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390 + 1)
    // Every action renders exactly once: inline XOR menu, never both/lost.
    const placement = await page.evaluate((wanted: readonly string[]) => {
      const overflow = document.querySelector('[data-testid="paint-toolbar-overflow"]')!
      const inline = overflow.querySelectorAll(':scope > div:first-child > button')
      const items = document.querySelectorAll('[data-testid="paint-toolbar-more-menu"] [data-overflow-menu-item]')
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
    const misplaced = placement.filter((entry) => entry.inline + entry.inMenu !== 1)
    expect(misplaced).toEqual([])
    await page.screenshot({ path: '/tmp/paint-responsive-390-more-open.png' })
    // Escape closes with focus returned to the trigger.
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('paint-toolbar-more')
  }, 180_000)

  it('changes the costume from the narrow picker at 390', async () => {
    await gotoCostumes(390, 844)
    await ensureBitmapMode()
    // Thumbnails stay visible with their selected numbers at 390.
    const cards = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid^="costume-card-"]')).map((card) => {
        const box = card.getBoundingClientRect()
        const thumb = card.querySelector('button[aria-label^="Select"]')?.getBoundingClientRect()
        return {
          cardVisible: box.width > 30 && box.height > 30,
          thumbVisible: (thumb?.width ?? 0) >= 32 && (thumb?.height ?? 0) >= 32,
          numberVisible: (card.textContent ?? '').trim().length > 0,
        }
      })
    })
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.cardVisible).toBe(true)
      expect(card.thumbVisible).toBe(true)
      expect(card.numberVisible).toBe(true)
    }
    if ((await costumeCount()) < 2) {
      // Single-costume project: duplicate through the real More menu, with
      // one retry if the first click races a menu re-fit.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const countBefore = await costumeCount()
        const more = page.getByTestId('paint-toolbar-more')
        if (await more.isVisible()) {
          await more.click()
          await page.getByTestId('paint-toolbar-more-menu').waitFor({ state: 'visible' })
          await page
            .locator('[data-testid="paint-toolbar-more-menu"] [data-overflow-menu-item][aria-label="Duplicate costume"]')
            .click()
        } else {
          await page.locator('[data-testid="paint-toolbar-overflow"] button[aria-label="Duplicate costume"]').click()
        }
        try {
          await page.waitForFunction(
            (prev: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > prev,
            countBefore,
            { timeout: 15_000 },
          )
          break
        } catch {
          if (attempt === 1) throw new Error('Duplicate costume did not add a card after two attempts')
        }
      }
    }
    expect(await costumeCount()).toBeGreaterThanOrEqual(2)
    const last = (await costumeCount()) - 1
    await page.locator(`[data-testid="costume-card-${last}"] button[aria-label^="Select"]`).click()
    // The clicked card becomes the selected one (ring highlight).
    await page.waitForFunction(
      (index: number) =>
        (document.querySelector(`[data-testid="costume-card-${index}"]`)?.className ?? '').includes('7c3fdd'),
      last,
    )
    await page.screenshot({ path: '/tmp/paint-responsive-390-costume.png' })
  }, 180_000)

  it('keeps named >=24px targets with no rail clipping at 390', async () => {
    await gotoCostumes(390, 844)
    await ensureBitmapMode()
    // Every visible paint/sidebar button has an accessible name + touch size.
    const audit = await page.evaluate(() => {
      const roots = [
        document.querySelector('[data-testid="paint-toolbar"]'),
        document.querySelector('[data-testid="paint-tool-rail"]'),
        document.querySelector('[data-testid="editor-workspace"] > div > aside'),
      ].filter((node): node is Element => !!node)
      const bad: Array<{ label: string; w: number; h: number }> = []
      for (const rootEl of roots) {
        for (const button of Array.from(rootEl.querySelectorAll('button'))) {
          // Screen-reader-only library shortcuts are invisible by design:
          // they carry names but need no touch target.
          if (button.closest('.sr-only')) continue
          const box = button.getBoundingClientRect()
          if (box.width === 0 && box.height === 0) continue
          const name = button.getAttribute('aria-label') ?? (button.textContent ?? '').trim()
          const rect = { w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 }
          if (!name || rect.w < 23.5 || rect.h < 23.5) {
            bad.push({ label: `${button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? (button.textContent ?? '').trim().slice(0, 24)}`, w: rect.w, h: rect.h })
          }
        }
      }
      return bad
    })
    expect(audit).toEqual([])
    // No rail button is vertically clipped: scroll each into view and hit-test.
    const railLabels = await page.locator('[data-testid="paint-tool-rail"] button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') ?? ''),
    )
    expect(railLabels.length).toBeGreaterThan(5)
    for (const label of railLabels) {
      const button = page.locator(`[data-testid="paint-tool-rail"] button[aria-label="${label}"]`)
      await button.scrollIntoViewIfNeeded()
      const hit = await button.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return target === node || (target instanceof Node && node.contains(target))
      })
      expect(hit).toBe(true)
    }
  }, 180_000)
})
