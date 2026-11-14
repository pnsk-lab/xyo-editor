import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor UI coverage for multi-select vector scaling through the shared
// selection bounds (vector-multi-scale.ts semantics + paper-vector
// conjugation): corner uniform / Shift free / Alt centered / edge
// single-axis / negative-factor flip, live preview, one undo entry, selection
// kept, ancestors and document order untouched.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4263'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

type SvgBounds = { x: number; y: number; width: number; height: number }

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function outlineCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

async function multiOutlineCount(): Promise<number> {
  return await page.locator('[data-vector-multi-selection]').count()
}

async function unionHandleCount(handle: string): Promise<number> {
  return await page.locator(`button[aria-label="Resize vector selection ${handle}"]`).count()
}

async function boundsList(svgText: string): Promise<SvgBounds[]> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits, vectorObjectBounds } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const units = editableVectorUnits(doc.documentElement)
    return units.map((element: Element) => vectorObjectBounds(element))
  }, svgText)
}

async function fillsList(svgText: string): Promise<Array<string | null>> {
  return await page.evaluate(async (svg: string) => {
    const { editableVectorUnits } = await import(
      /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
    )
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return editableVectorUnits(doc.documentElement).map((element: Element) => element.getAttribute('fill'))
  }, svgText)
}

function unionOf(bounds: SvgBounds[]): SvgBounds {
  // Mirror the implementation union: degenerate (empty-group) boxes are skipped.
  const boxes = bounds.filter((b) => b.width > 0 || b.height > 0)
  const source = boxes.length > 0 ? boxes : bounds
  const left = Math.min(...source.map((b) => b.x))
  const top = Math.min(...source.map((b) => b.y))
  const right = Math.max(...source.map((b) => b.x + b.width))
  const bottom = Math.max(...source.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 10_000 },
  )
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

// Drag a union handle on the real paint surface (canvas pixel space).
async function dragSurfaceUnionHandle(handle: string, dx: number, dy: number, modifiers?: { shift?: boolean; alt?: boolean }) {
  const target = page.getByTestId('costume-paint-surface').locator(`button[aria-label="Resize vector selection ${handle}"]`)
  await target.waitFor({ state: 'visible', timeout: 10_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error(`Missing union handle ${handle}`)
  if (modifiers?.shift) await page.keyboard.down('Shift')
  if (modifiers?.alt) await page.keyboard.down('Alt')
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 })
    await page.mouse.up()
  } finally {
    if (modifiers?.alt) await page.keyboard.up('Alt')
    if (modifiers?.shift) await page.keyboard.up('Shift')
  }
}

describe('vector multi-select scale on the real editor UI', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4263', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('scales the multi-selection through the shared se handle with one history entry', async () => {
    const surface = page.getByTestId('costume-paint-surface')
    await surface.click()
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    async function drawRect(from: { x: number; y: number }, to: { x: number; y: number }) {
      await page.getByTestId('vector-shape-rect').last().click()
      const before = await previewSvg()
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      await waitForPreviewChange(before)
    }

    // Start from a blank canvas so the shared bounds hold only the new
    // rects: at 5x workspace zoom a starter-spanning union would push the
    // east handles under the neighboring pane resizer.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-selection-outline]').length === 0, null, { timeout: 10_000 })

    await drawRect({ x: centerX - 150, y: centerY - 40 }, { x: centerX - 50, y: centerY + 40 })
    await drawRect({ x: centerX + 50, y: centerY - 40 }, { x: centerX + 150, y: centerY + 40 })
    await page.getByTestId('vector-shape-select').last().click()

    await page.keyboard.press('Control+a')
    const selectedCount = await outlineCount()
    expect(selectedCount).toBeGreaterThanOrEqual(2)
    // Shared bounds UI: one union outline plus 8 union handles (canvas + sidebar).
    expect(await multiOutlineCount()).toBeGreaterThanOrEqual(1)
    expect(await unionHandleCount('se')).toBeGreaterThanOrEqual(1)

    const beforeSvg = await previewSvg()
    const beforeBounds = await boundsList(beforeSvg)
    const beforeFills = await fillsList(beforeSvg)
    expect(beforeBounds.length).toBe(selectedCount)
    const beforeUnion = unionOf(beforeBounds)

    // Corner drag without Shift keeps aspect (Scratch parity).
    await dragSurfaceUnionHandle('se', 70, 40)
    await waitForPreviewChange(beforeSvg)
    const scaledSvg = await previewSvg()
    const scaledBounds = await boundsList(scaledSvg)
    expect(scaledBounds.length).toBe(selectedCount)
    // Selection survives the live preview + commit.
    expect(await outlineCount()).toBe(selectedCount)
    expect(await multiOutlineCount()).toBeGreaterThanOrEqual(1)
    // Document order (front order) is untouched.
    expect(await fillsList(scaledSvg)).toEqual(beforeFills)
    const scaledUnion = unionOf(scaledBounds)
    expect(scaledUnion.width).toBeGreaterThan(beforeUnion.width + 5)
    expect(scaledUnion.height).toBeGreaterThan(beforeUnion.height + 5)
    const ratioX = scaledUnion.width / beforeUnion.width
    const ratioY = scaledUnion.height / beforeUnion.height
    // Uniform corner: both axes share one factor.
    expect(Math.abs(ratioX - ratioY) / Math.max(ratioX, ratioY)).toBeLessThan(0.25)
    // Fixed point (union nw) stays put.
    expect(scaledUnion.x).toBeCloseTo(beforeUnion.x, 0)
    expect(scaledUnion.y).toBeCloseTo(beforeUnion.y, 0)

    // No-op click (no movement) touches nothing: preview, selection and
    // history stay put (a later single Undo still restores the scaled state).
    const idleBefore = await previewSvg()
    const idleOutlines = await outlineCount()
    const idleHandle = page.getByTestId('costume-paint-surface').locator('button[aria-label="Resize vector selection se"]')
    await idleHandle.waitFor({ state: 'visible', timeout: 10_000 })
    const idleBox = await idleHandle.boundingBox()
    if (!idleBox) throw new Error('Missing union handle for no-op click')
    await page.mouse.move(idleBox.x + idleBox.width / 2, idleBox.y + idleBox.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(500)
    expect(await previewSvg()).toBe(idleBefore)
    expect(await outlineCount()).toBe(idleOutlines)

    // Single history entry: one Undo restores, one Redo reapplies.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
    expect(await outlineCount()).toBe(selectedCount)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      scaledSvg,
      { timeout: 10_000 },
    )
    expect(await outlineCount()).toBe(selectedCount)
    // Leave the scaled state for the following cases, then restore.
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
  }, 120_000)

  it('uses free ratio with Shift and edge single-axis', async () => {
    const selectedCount = await outlineCount()
    expect(selectedCount).toBeGreaterThanOrEqual(2)
    const beforeSvg = await previewSvg()
    const beforeUnion = unionOf(await boundsList(beforeSvg))

    // Free-ratio corner: width-dominant drag stretches width more than height.
    await dragSurfaceUnionHandle('se', 90, 10, { shift: true })
    await waitForPreviewChange(beforeSvg)
    const freeSvg = await previewSvg()
    const freeUnion = unionOf(await boundsList(freeSvg))
    expect(await outlineCount()).toBe(selectedCount)
    const ratioX = freeUnion.width / beforeUnion.width
    const ratioY = freeUnion.height / beforeUnion.height
    expect(ratioX).toBeGreaterThan(ratioY + 0.1)
    expect(ratioX).toBeGreaterThan(1.05)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )

    // Edge handle: single axis (height stays, width grows), Shift-independent.
    const edgeBefore = await previewSvg()
    const edgeUnionBefore = unionOf(await boundsList(edgeBefore))
    await dragSurfaceUnionHandle('e', 60, 80, { shift: true })
    await waitForPreviewChange(edgeBefore)
    const edgeSvg = await previewSvg()
    const edgeUnion = unionOf(await boundsList(edgeSvg))
    expect(await outlineCount()).toBe(selectedCount)
    expect(edgeUnion.width).toBeGreaterThan(edgeUnionBefore.width + 5)
    expect(Math.abs(edgeUnion.height - edgeUnionBefore.height)).toBeLessThan(4)
    expect(edgeUnion.y).toBeCloseTo(edgeUnionBefore.y, 0)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      edgeBefore,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      edgeSvg,
      { timeout: 10_000 },
    )
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      edgeBefore,
      { timeout: 10_000 },
    )
  }, 120_000)

  it('scales from the shared center with Alt', async () => {
    const selectedCount = await outlineCount()
    expect(selectedCount).toBeGreaterThanOrEqual(2)
    const beforeSvg = await previewSvg()
    const beforeUnion = unionOf(await boundsList(beforeSvg))
    const centerX = beforeUnion.x + beforeUnion.width / 2
    const centerY = beforeUnion.y + beforeUnion.height / 2

    await dragSurfaceUnionHandle('se', 50, 0, { alt: true })
    await waitForPreviewChange(beforeSvg)
    const centeredSvg = await previewSvg()
    const centeredUnion = unionOf(await boundsList(centeredSvg))
    expect(await outlineCount()).toBe(selectedCount)
    expect(centeredUnion.width).toBeGreaterThan(beforeUnion.width + 5)
    // Centered: the shared center stays, both sides grow.
    expect(centeredUnion.x + centeredUnion.width / 2).toBeCloseTo(centerX, 0)
    expect(centeredUnion.y + centeredUnion.height / 2).toBeCloseTo(centerY, 0)
    expect(centeredUnion.x).toBeLessThan(beforeUnion.x)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      centeredSvg,
      { timeout: 10_000 },
    )
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
  }, 120_000)

  it('flips past the shared fixed point with one history entry', async () => {
    const selectedCount = await outlineCount()
    expect(selectedCount).toBeGreaterThanOrEqual(2)
    const beforeSvg = await previewSvg()
    const beforeBounds = await boundsList(beforeSvg)
    const beforeUnion = unionOf(beforeBounds)

    // Drag se far past the fixed (nw) corner so X flips (free ratio).
    await dragSurfaceUnionHandle('se', -500, 0, { shift: true })
    await waitForPreviewChange(beforeSvg)
    const flippedSvg = await previewSvg()
    expect(flippedSvg).not.toBe(beforeSvg)
    const flippedBounds = await boundsList(flippedSvg)
    expect(flippedBounds.length).toBe(selectedCount)
    expect(await outlineCount()).toBe(selectedCount)
    // Negative shared factor: derive sx from the union (< 0) and verify
    // every rect maps through pivot + (p - pivot) * sx (mirror included).
    // The se handle fixes the nw corner, so the pivot is the union origin.
    const flippedUnion = unionOf(flippedBounds)
    const sx = flippedUnion.width > 0 && beforeUnion.width > 0 ? -(flippedUnion.width / beforeUnion.width) : NaN
    const beforeFills = await fillsList(beforeSvg)
    const flippedFills = await fillsList(flippedSvg)
    expect(Number.isFinite(sx)).toBe(true)
    expect(sx).toBeLessThan(0)
    expect(flippedFills).toEqual(beforeFills)
    const pivotX = beforeUnion.x
    const mapX = (p: number) => pivotX + (p - pivotX) * sx
    for (let i = 0; i < selectedCount; i++) {
      if (beforeFills[i] !== '#ffab19') continue
      // Negative factors swap the edges: the AABB is the min/max of the
      // two mapped vertical edges (Scratch parity: flip keeps positive size).
      const mappedLeft = mapX(beforeBounds[i]!.x)
      const mappedRight = mapX(beforeBounds[i]!.x + beforeBounds[i]!.width)
      expect(flippedBounds[i]!.x).toBeCloseTo(Math.min(mappedLeft, mappedRight), 0)
      expect(flippedBounds[i]!.x + flippedBounds[i]!.width).toBeCloseTo(Math.max(mappedLeft, mappedRight), 0)
      expect(flippedBounds[i]!.width).toBeCloseTo(beforeBounds[i]!.width * Math.abs(sx), 0)
      expect(flippedBounds[i]!.y).toBeCloseTo(beforeBounds[i]!.y, 0)
    }
    // The two rects swapped horizontal order through the flip.
    const rectIndex = beforeBounds.map((_, i) => i).filter((i) => beforeFills[i] === '#ffab19').sort((a, b) => beforeBounds[a]!.x - beforeBounds[b]!.x)
    expect(rectIndex.length).toBe(2)
    expect(beforeBounds[rectIndex[0]!]!.x).toBeLessThan(beforeBounds[rectIndex[1]!]!.x)
    expect(flippedBounds[rectIndex[0]!]!.x).toBeGreaterThan(flippedBounds[rectIndex[1]!]!.x)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
    expect(await outlineCount()).toBe(selectedCount)
    await redoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      flippedSvg,
      { timeout: 10_000 },
    )
    expect(await outlineCount()).toBe(selectedCount)
    await undoButton().click()
    await page.waitForFunction(
      (expected) => document.querySelector('.vector-preview')?.innerHTML === expected,
      beforeSvg,
      { timeout: 10_000 },
    )
  }, 120_000)
})
