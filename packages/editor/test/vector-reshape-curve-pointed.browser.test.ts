import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-page Curved/Pointed (reshape anchor style) wiring:
// - rect drag creates a 4-anchor shape
// - reshape shows Curved/Pointed, both disabled with no anchor selected
// - selecting a rect corner enables Curved only (pointed style)
// - Curved converts the corner (controls appear, preview changes) as one
//   history entry (Undo/Redo round-trips geometry + button state)
// - Pointed clears the handles again, also with Undo/Redo
// - the group is hidden outside reshape (text/select/brush)
// - translated/scaled wrapper preservation is verified through the same
//   page modules (parent-transform parity with vector-point-style.ts)
const root = join(import.meta.dir, '..')
// 既存ブラウザーテスト群と重ならないポートを使う (4189/4241/4295 系は使用中)。
const base = 'http://127.0.0.1:4317'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function pointCount() {
  return await page.locator('[data-vector-path-point]').count()
}

async function waitForPointCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-path-point]').length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function previewAnchors(): Promise<Array<{ x: number; y: number }>> {
  return await page.evaluate(async () => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await mod.paperVectorObjectList(html)
    const points = (list[0] as any)?.points as Array<any> | undefined
    return (points ?? [])
      .filter((p) => p.kind === 'anchor')
      .map((p) => ({ x: p.x as number, y: p.y as number }))
  })
}

function anchorsMatch(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>, tolerance = 1.5) {
  if (a.length !== b.length) return false
  return a.every((p) => b.some((q) => Math.abs(p.x - q.x) < tolerance && Math.abs(p.y - q.y) < tolerance))
}

type ReshapeStyleSnapshot = {
  present: boolean
  curveDisabled: boolean | undefined
  pointDisabled: boolean | undefined
  curvePressed: string | null | undefined
  pointPressed: string | null | undefined
  handles: number
}

// Atomic snapshot: both buttons live in one conditional group, so read them
// in a single evaluate to avoid racing a Svelte re-render between two
// separate locator queries.
async function reshapeStyleState(): Promise<ReshapeStyleSnapshot> {
  return await page.evaluate(() => {
    const curve = document.querySelector('[data-testid="reshape-curve-point"]') as HTMLButtonElement | null
    const point = document.querySelector('[data-testid="reshape-point-point"]') as HTMLButtonElement | null
    return {
      present: curve !== null && point !== null,
      curveDisabled: curve ? curve.disabled : undefined,
      pointDisabled: point ? point.disabled : undefined,
      curvePressed: curve?.getAttribute('aria-pressed'),
      pointPressed: point?.getAttribute('aria-pressed'),
      handles: document.querySelectorAll('[data-vector-path-point]').length,
    }
  })
}

async function waitForReshapeStyle(expected: {
  present?: boolean
  curveDisabled?: boolean
  pointDisabled?: boolean
  minHandles?: number
}): Promise<ReshapeStyleSnapshot> {
  await page.waitForFunction(
    (exp) => {
      const curve = document.querySelector('[data-testid="reshape-curve-point"]') as HTMLButtonElement | null
      const point = document.querySelector('[data-testid="reshape-point-point"]') as HTMLButtonElement | null
      if (exp.present && (curve === null || point === null)) return false
      if (exp.curveDisabled !== undefined && curve?.disabled !== exp.curveDisabled) return false
      if (exp.pointDisabled !== undefined && point?.disabled !== exp.pointDisabled) return false
      if (exp.minHandles !== undefined && document.querySelectorAll('[data-vector-path-point]').length < exp.minHandles) {
        return false
      }
      return true
    },
    expected,
  )
  return await reshapeStyleState()
}

describe('vector reshape Curved/Pointed on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], {
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

  it('rect -> reshape -> anchor select -> Curved/Pointed with Undo/Redo, hidden outside reshape', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })

    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }

    // Draw a rect via real drag so the test starts from 4 anchors.
    const rectTool = page.getByTestId('vector-shape-rect').last()
    await rectTool.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.mouse.move(centerX - 110, centerY - 60)
    await page.mouse.down()
    await page.mouse.move(centerX + 110, centerY + 60, { steps: 12 })
    await page.mouse.up()

    const reshapeTool = page.getByTestId('vector-shape-reshape').last()
    await reshapeTool.click()
    await page.waitForSelector('[data-vector-path-point]')
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)

    // No anchor selected: both operations stay disabled so a stray click
    // never reaches the helper or history.
    let state = await waitForReshapeStyle({ present: true })
    expect(state.present).toBe(true)
    state = await waitForReshapeStyle({ curveDisabled: true, pointDisabled: true })
    expect(state.curveDisabled).toBe(true)
    expect(state.pointDisabled).toBe(true)

    // Select a rect corner: a pointed anchor offers Curved only.
    const handles = page.locator('[data-vector-path-point]')
    await handles.first().click()
    state = await waitForReshapeStyle({ curveDisabled: false, pointDisabled: true })
    expect(state.curveDisabled).toBe(false)
    expect(state.pointDisabled).toBe(true)

    // Curved: one history entry, controls appear, preview geometry changes.
    const svgBefore = await previewSvg()
    expect(svgBefore).toContain('<path')
    await page.getByTestId('reshape-curve-point').click()
    state = await waitForReshapeStyle({ curveDisabled: true, pointDisabled: false, minHandles: 5 })
    expect(state.curveDisabled).toBe(true)
    expect(state.pointDisabled).toBe(false)
    // Selected anchor's in/out handles are rendered alongside the anchors.
    expect(state.handles).toBeGreaterThan(4)
    const svgCurved = await previewSvg()
    expect(svgCurved).not.toBe(svgBefore)

    // Undo restores the pointed rect in one step; Redo re-applies the curve.
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    expect(await previewSvg()).toBe(svgBefore)
    state = await waitForReshapeStyle({ curveDisabled: false, pointDisabled: true })
    expect(state.curveDisabled).toBe(false)
    await redoButton.click()
    state = await waitForReshapeStyle({ pointDisabled: false, minHandles: 5 })
    expect(await previewSvg()).toBe(svgCurved)
    expect(state.pointDisabled).toBe(false)

    // Pointed: handles are cleared, again as a single history entry.
    // Pointing keeps the converted path element (rect is not restored),
    // so geometry is compared by anchors instead of markup.
    const anchorsBefore = await previewAnchors()
    await page.getByTestId('reshape-point-point').click()
    await waitForPointCount(4)
    expect(await pointCount()).toBe(4)
    const svgPointed = await previewSvg()
    expect(svgPointed).toContain('<path')
    expect(anchorsMatch(await previewAnchors(), anchorsBefore)).toBe(true)
    state = await waitForReshapeStyle({ curveDisabled: false, pointDisabled: true })
    expect(state.curveDisabled).toBe(false)
    expect(state.pointDisabled).toBe(true)
    await undoButton.click()
    state = await waitForReshapeStyle({ pointDisabled: false, minHandles: 5 })
    expect(await previewSvg()).toBe(svgCurved)
    expect(state.pointDisabled).toBe(false)
    await redoButton.click()
    await waitForPointCount(4)
    expect(await previewSvg()).toBe(svgPointed)

    // Outside reshape the group is hidden (text / select / brush).
    for (const tool of ['text', 'select', 'brush'] as const) {
      await page.getByTestId(`vector-shape-${tool}`).last().click()
      await page.waitForFunction(() => document.querySelector('[data-testid="reshape-curve-point"]') === null)
      state = await reshapeStyleState()
      expect(state.present).toBe(false)
    }
    await reshapeTool.click()
    state = await waitForReshapeStyle({ present: true })
    expect(state.present).toBe(true)
  }, 120_000)

  it('keeps parent transforms when curving/pointing through the page modules', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-point-style.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const translated =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<rect id="box" x="10" y="10" width="80" height="60" fill="yellow" stroke="black"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(translated, 'image/svg+xml')
      const box = doc.querySelector('#box')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const curve = await mod.curveVectorPointStyle(box, [0])
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const scaled =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="scale(2)">' +
        '<path id="curve" d="M0 0 C30 -40 70 -40 100 0 C130 40 170 40 200 0" fill="none" stroke="black"/>' +
        '</g></svg>'
      const doc2 = new DOMParser().parseFromString(scaled, 'image/svg+xml')
      const target = doc2.querySelector('#target')!
      const point = await mod.pointVectorPointStyle(target, [2])
      const after2 = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc2))
      return {
        curveChanged: curve.changed,
        outerTransform: doc.querySelector('#outer')?.getAttribute('transform'),
        outerChildren: doc.querySelector('#outer')?.children.length,
        beforeAnchors: ((before[0] as any).points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterAnchors: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterControls: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'control'),
        pointChanged: point.changed,
        targetTransform: doc2.querySelector('#target')?.getAttribute('transform'),
        middleKept: ((after2[0] as any)?.points as Array<any>).some(
          (p) => p.kind === 'anchor' && Math.abs(p.x - 200) < 1.5 && Math.abs(p.y - 0) < 1.5,
        ),
      }
    })
    expect(result.curveChanged).toBe(true)
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.outerChildren).toBe(1)
    expect(result.afterAnchors.length).toBe(4)
    for (const anchor of result.beforeAnchors as Array<{ x: number; y: number }>) {
      expect(
        (result.afterAnchors as Array<{ x: number; y: number }>).some(
          (p) => Math.abs(p.x - anchor.x) < 1.5 && Math.abs(p.y - anchor.y) < 1.5,
        ),
      ).toBe(true)
    }
    expect((result.afterControls as Array<unknown>).length).toBeGreaterThan(0)
    expect(result.pointChanged).toBe(true)
    expect(result.targetTransform ?? '').toContain('scale(2)')
    expect(result.middleKept).toBe(true)
  }, 30_000)
})
