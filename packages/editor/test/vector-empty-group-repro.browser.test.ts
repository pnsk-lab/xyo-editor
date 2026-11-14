import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Regression: a blank-equivalent vector costume keeps one empty wrapper <g>
// as a selectable object. After drawing the first shape the canvas reports
// "2 objects selected" with a ghost 8px outline for the zero-area group.
// Desired: empty groups are filtered from selection (DOM preserved),
// while transparent-but-geometric groups, defs companions, clipPath exclusion,
// href (<use>/<image>) retention, and future-data preservation hold.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4334'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function unitsOf(svgText: string) {
  return await page.evaluate(async (svg: string) => {
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const rootEl = doc.documentElement
    const units = mod.editableVectorUnits(rootEl).map((el: Element) => {
      let bounds: unknown
      try {
        bounds = mod.vectorObjectBounds(el as Element)
      } catch (error) {
        bounds = String(error)
      }
      return {
        tag: el.tagName.toLowerCase(),
        childElements: Array.from(el.children).map((c) => c.tagName.toLowerCase()),
        outerHead: new XMLSerializer().serializeToString(el).slice(0, 500),
        bounds,
      }
    })
    return {
      rootChildren: Array.from(rootEl.children).map(
        (c) => `${c.tagName.toLowerCase()}[${c.children.length}]`,
      ),
      units,
    }
  }, svgText)
}

describe('vector empty group ghost', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4334', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 120_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('visible UI: first shape on blank-equivalent canvas selects 1 object, no 8px ghost', async () => {
    // Blank-equivalent: clear the default vector costume, then draw one rect.
    // Same DOM shape as a fresh Paint costume after its first stamp:
    // empty wrapper <g> chain + one real shape.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline]').length === 0,
      null,
      { timeout: 10_000 },
    )

    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    await page.getByTestId('vector-shape-rect').last().click()
    const before = await previewSvg()
    await page.mouse.move(centerX - 100, centerY - 40)
    await page.mouse.down()
    await page.mouse.move(centerX + 100, centerY + 40, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      before,
      { timeout: 10_000 },
    )

    // data/editor: preview DOM must expose exactly one selectable unit.
    const afterSvg = await previewSvg()
    const probe = await unitsOf(afterSvg)
    expect(probe.units.length).toBe(1)
    expect(probe.units[0]?.tag).toBe('rect')

    // Visible UI: select-all must show a single outline, never an 8px ghost.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-selection-outline].border-blue-500').length >= 1,
      null,
      { timeout: 10_000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const blueOutlines = await page.locator('[data-vector-selection-outline].border-blue-500').count()
    expect(blueOutlines).toBe(1)
    const ghostOutlines = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('[data-vector-selection-outline].border-blue-500')).filter(
          (el) => (el as HTMLElement).style.width === '8px' && (el as HTMLElement).style.height === '8px',
        ).length,
    )
    expect(ghostOutlines).toBe(0)
    const panelText = await page.evaluate(() => document.body.innerText)
    expect(panelText).not.toContain('2 objects selected')
  }, 180_000)

  it('data/editor: empty <g> is not selectable, transparent geometry stays selectable', async () => {
    const emptyPlusRect =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<g transform="translate(10 20)"><title>t</title><g id="inner"></g></g>' +
      '<rect x="220" y="172" width="40" height="16" fill="#ffab19" stroke="#0f172a" stroke-width="4"/>' +
      '</svg>'
    const emptyProbe = await unitsOf(emptyPlusRect)
    // Desired: the zero-geometry wrapper is filtered, only the rect remains.
    expect(emptyProbe.units.length).toBe(1)
    expect(emptyProbe.units[0]?.tag).toBe('rect')

    const transparentGroup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<g opacity="0"><rect x="10" y="10" width="40" height="20" fill="red"/></g>' +
      '<rect x="100" y="100" width="30" height="30" fill="blue"/>' +
      '</svg>'
    const transparentProbe = await unitsOf(transparentGroup)
    // Transparent but geometric groups must stay selectable (user can restyle them).
    expect(transparentProbe.units.length).toBe(2)
    expect(transparentProbe.units[0]?.tag).toBe('g')

    const titleOnlyGroup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<g><title>only-title</title></g>' +
      '<rect x="5" y="5" width="10" height="10" fill="red"/>' +
      '</svg>'
    const titleProbe = await unitsOf(titleOnlyGroup)
    expect(titleProbe.units.length).toBe(1)
    expect(titleProbe.units[0]?.tag).toBe('rect')
  }, 60_000)

  it('data/editor: defs/clipPath excluded, href and future data preserved', async () => {
    const defsCase =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<defs><linearGradient id="lg"><stop offset="0" stop-color="red"/></linearGradient></defs>' +
      '<rect x="10" y="10" width="20" height="20" fill="url(#lg)"/>' +
      '</svg>'
    // defs companions must never fork a second selectable object.
    expect((await unitsOf(defsCase)).units.length).toBe(1)

    const clipCase =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<clipPath id="c"><rect x="0" y="0" width="10" height="10"/></clipPath>' +
      '<rect x="20" y="20" width="10" height="10" fill="red"/>' +
      '</svg>'
    // Non-rendered containers are never selectable.
    expect((await unitsOf(clipCase)).units.length).toBe(1)

    const useCase =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<defs><rect id="r" x="0" y="0" width="20" height="20" fill="red"/></defs>' +
      '<use href="#r" x="50" y="50"/>' +
      '</svg>'
    // href references render via their target: keep them even when the local
    // bounds helper reports zero area, otherwise a zero-area filter would
    // silently drop meaningful art.
    const useProbe = await unitsOf(useCase)
    expect(useProbe.units.length).toBe(1)
    expect(useProbe.units[0]?.tag).toBe('use')

    const futureDataCase =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<g data-future-viz="pending"></g>' +
      '<rect x="20" y="20" width="10" height="10" fill="red"/>' +
      '</svg>'
    const futureProbe = await page.evaluate(async (svg: string) => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = mod.editableVectorUnits(doc.documentElement)
      return {
        unitCount: units.length,
        domPreserved: doc.documentElement.querySelector('g[data-future-viz]') !== null,
      }
    }, futureDataCase)
    // Filter from selection, never delete: future visualization data stays in DOM.
    expect(futureProbe.unitCount).toBe(1)
    expect(futureProbe.domPreserved).toBe(true)
  }, 60_000)
})
