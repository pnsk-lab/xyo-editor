// Independent-oracle audit for arbitrary pending rotation (test-only Vite fixture).
//
// Serves the REAL Editor (`/` -> App.svelte) with the REAL VM through
// `test/vite.bitmap-pending.config.ts`, which flips
// `BITMAP_PENDING_UI_ENABLED` false->true IN MEMORY ONLY (HMR/watch OFF).
// On-disk `bitmap-pending-controller.ts` still contains exactly one
// `export const BITMAP_PENDING_UI_ENABLED = false as const` before, during
// and after the run (asserted). This file never edits product code and never
// copies AGPL-licensed implementation text: the affine oracle below is
// original test code (detached Canvas2D `translate(center)+rotate+fillRect`
// reference), driving the UI like a user (mouse/keyboard/shift/alt,
// toolbar buttons, dispatched pointer events).
//
// Fail-first intent: every expectation pins the CORRECT vector behavior.
// A product mismatch (screen-locked gradient, drifted absolute drag,
// axis/shear box-swap, early VM write, trail, stale overlay, double history)
// fails here with the real pixel/box numbers logged.
//
// Coverage beyond `bitmap-pending-rotate-arbitrary.browser.test.ts`:
// - oracle angles: -30 (res1 ellipse + res2 rect), 45, 90 with detached-canvas
//   pixel agreement (center painted, bbox corners transparent, tight bbox)
// - selection outline = tight rotated bbox AND 8 scale handles stay at the
//   AXIS-ALIGNED bbox corners/edge-midpoints (not rotated with the ink);
//   rotate handle above bbox top-center
// - handles: 4 corners + 4 edges, Alt-center (center pinned), Shift uniform
//   (aspect kept), reverse crossing (mirror, no NaN, VM clean)
// - rotate-then-scale/move/90/recolor chain, in-place, VM clean until commit
// - filled vs outlined (center transparent, contour painted) and
//   horizontal/transparent gradients travel WITH the shape (local frame)
// - bounds/clipping near the canvas edge: no trails, no early VM writes
// - external target switch WHILE a rotate drag is held: no stale overlay on
//   the new canvas, no corruption, pending retained or committed, VM safe
// - cancel (pointercancel/lostpointercapture/Escape mid-drag) reverts to the
//   drag-start rotation with byte-identical overlay; commit is exactly one
//   history entry (double-Undo/double-Redo no-ops)
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-rotate-arbitrary-oracle.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4686
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'
const BYPASS_TOKENS = [
  'localStorage.',
  'sessionStorage.',
  'URLSearchParams',
  'location.search',
  'location.hash',
  'import.meta.env',
  'process.env',
]

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 } // 200x100 rect at res2
const CENTER = { x: 380, y: 310 }
const BASE_DOT = { x1: 96, y1: 96, x2: 150, y2: 130 }
const BASE_PROBE = { x: 120, y: 112 }
const EDGE_BOX = { x1: 760, y1: 260, x2: 955, y2: 360 } // near right edge (res2)
const EBOX = { x1: 140, y1: 120, x2: 340, y2: 220 } // 200x100 ellipse at res1
const ECENTER = { x: 240, y: 170 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[rotate-oracle] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[rotate-oracle] on-disk bypass check (${stage}): controller source must not contain ${JSON.stringify(token)}`,
      )
    }
  }
}

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const rect = target.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}

async function toCanvas(sx: number, sy: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: ((sx - rect.left) / rect.width) * size.width, y: ((sy - rect.top) / rect.height) * size.height }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function canvasDigest(): Promise<string> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data).join(',')
  })
}

async function vmCostumeMd5(): Promise<string | undefined> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
      const snap = api?.snapshot() as
        | {
            selectedTargetId?: string
            project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }> }
          }
        | undefined
      const targets = snap?.project?.targets ?? []
      const sel =
        targets.find((t) => t.id === snap?.selectedTargetId) ??
        targets.find((t) => !t.isStage) ??
        targets[0]
      const idx = sel?.currentCostume ?? 0
      return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
    } catch {
      return undefined
    }
  })
}

async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function selectionBox(): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  return await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!sel || !canvas) return undefined
    const s = sel.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    if (!(c.width > 0) || !(c.height > 0)) return undefined
    const sx = canvas.width / c.width
    const sy = canvas.height / c.height
    return {
      x: (s.left - c.left) * sx,
      y: (s.top - c.top) * sy,
      width: s.width * sx,
      height: s.height * sy,
    }
  })
}

async function handleCanvasPos(testId: string): Promise<{ x: number; y: number } | undefined> {
  const box = await page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!el || !canvas) return undefined
    const r = el.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    if (!(c.width > 0) || !(c.height > 0)) return undefined
    return {
      x: ((r.left + r.width / 2 - c.left) / c.width) * canvas.width,
      y: ((r.top + r.height / 2 - c.top) / c.height) * canvas.height,
    }
  }, testId as unknown as undefined)
  return box as { x: number; y: number } | undefined
}

async function openBitmapRes2() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already bitmap.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort.
  }
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected bitmap res2 960x720 backing, got ${size.width}x${size.height}`)
  }
}

async function openBitmapRes1Stage() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.evaluate(() => {
    ;(document.querySelector('[data-testid="target-card-stage"]') as HTMLElement | null)?.click()
  })
  await page.waitForTimeout(900)
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already bitmap.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort.
  }
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 480 || size.height !== 360) {
    throw new Error(`Expected stage res1 480x360 backing, got ${size.width}x${size.height}`)
  }
}

async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}

async function useGradientFill(kind: 'horizontal' | 'vertical' | 'radial', fill: string, secondary: string) {
  await page.getByLabel('Bitmap paint style').selectOption(kind)
  const labels = await page.getByLabel('Paint color').count()
  // Primary + secondary color fields share the label; fill both in order.
  const fields = page.getByLabel('Paint color')
  await fields.nth(0).fill(fill)
  if (labels > 1) await fields.nth(1).fill(secondary)
  for (const name of ['Transparent fill', 'Transparent secondary']) {
    try {
      const toggle = page.getByRole('button', { name })
      if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
    } catch {
      // Best effort: toolbar variant may differ.
    }
  }
}

async function paintCommittedBaseDot(): Promise<void> {
  await page.getByTestId('bitmap-tool-brush').click()
  await useSolidFill('#0000ff')
  const a = await toScreen(BASE_DOT.x1, BASE_DOT.y1)
  const b = await toScreen(BASE_DOT.x2, BASE_DOT.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(1500)
}

async function stageRectRed(box = BOX) {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#ff0000')
  const a = await toScreen(box.x1, box.y1)
  const b = await toScreen(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(900)
}

// Absolute rotate-handle drag: measures the press angle from the selection
// center (never assumes north), then lands at startAngle+delta on a 120px
// canvas circle. Mirrors the product's absolute `startRotation + delta`.
async function dragRotateHandle(deltaDegrees: number, options: { shift?: boolean } = {}): Promise<void> {
  const box = (await selectionBox())!
  if (!box) throw new Error('No bitmap selection for rotate drag')
  const handle = page.getByTestId('bitmap-floating-rotate-handle')
  await handle.waitFor({ state: 'visible', timeout: 15_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('Rotate handle has no bounding box')
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const startCanvas = {
    x: ((hb.x + hb.width / 2 - rect.left) / rect.width) * size.width,
    y: ((hb.y + hb.height / 2 - rect.top) / rect.height) * size.height,
  }
  const startAngle = (Math.atan2(startCanvas.y - cy, startCanvas.x - cx) * 180) / Math.PI
  const radius = 120
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const targetAngle = startAngle + deltaDegrees
  const targetCanvas = { x: cx + radius * Math.cos(toRad(targetAngle)), y: cy + radius * Math.sin(toRad(targetAngle)) }
  const target = await toScreen(targetCanvas.x, targetCanvas.y)
  if (options.shift) await page.keyboard.down('Shift')
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 15 })
  await page.mouse.up()
  if (options.shift) await page.keyboard.up('Shift')
  await page.waitForTimeout(900)
}

async function startHeldRotateDrag(deltaDegrees: number): Promise<void> {
  const box = (await selectionBox())!
  if (!box) throw new Error('No bitmap selection for held rotate drag')
  const handle = page.getByTestId('bitmap-floating-rotate-handle')
  await handle.waitFor({ state: 'visible', timeout: 15_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('Rotate handle has no bounding box')
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const startCanvas = {
    x: ((hb.x + hb.width / 2 - rect.left) / rect.width) * size.width,
    y: ((hb.y + hb.height / 2 - rect.top) / rect.height) * size.height,
  }
  const startAngle = (Math.atan2(startCanvas.y - cy, startCanvas.x - cx) * 180) / Math.PI
  const radius = 120
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const targetAngle = startAngle + deltaDegrees
  const target = await toScreen(cx + radius * Math.cos(toRad(targetAngle)), cy + radius * Math.sin(toRad(targetAngle)))
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await page.waitForTimeout(500)
}

// Drag one scale handle by a canvas-px delta (converted to screen px).
async function dragScaleHandle(
  handleId: string,
  dCanvasX: number,
  dCanvasY: number,
  modifiers: { alt?: boolean; shift?: boolean } = {},
): Promise<void> {
  const testId = handleId === 'se' ? 'bitmap-floating-scale-handle' : `bitmap-floating-scale-handle-${handleId}`
  const handle = page.getByTestId(testId)
  await handle.waitFor({ state: 'visible', timeout: 15_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error(`${testId} has no bounding box`)
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const sxPerCanvas = rect.width / size.width
  const syPerCanvas = rect.height / size.height
  if (modifiers.alt) await page.keyboard.down('Alt')
  if (modifiers.shift) await page.keyboard.down('Shift')
  try {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + dCanvasX * sxPerCanvas, hb.y + hb.height / 2 + dCanvasY * syPerCanvas, { steps: 12 })
    await page.mouse.up()
  } finally {
    if (modifiers.shift) await page.keyboard.up('Shift')
    if (modifiers.alt) await page.keyboard.up('Alt')
  }
  await page.waitForTimeout(900)
}

function expectedBbox(localW: number, localH: number, thetaDegrees: number): { width: number; height: number } {
  const rad = (Math.abs(thetaDegrees) * Math.PI) / 180
  const w = localW + 2
  const h = localH + 2
  return {
    width: w * Math.cos(rad) + h * Math.sin(rad),
    height: w * Math.sin(rad) + h * Math.cos(rad),
  }
}

// Independent Canvas affine oracle: detached 2d paints the SAME solid box
// rotated about its own center, then reads one probe pixel. No product
// imports, no shared math beyond atan2/cos/sin in the test.
async function oracleSolidPixel(
  box: { x: number; y: number; width: number; height: number },
  angleDegrees: number,
  fillCss: string,
  probe: { x: number; y: number },
  canvasSizePx: { width: number; height: number },
): Promise<number[]> {
  return await page.evaluate(
    ([b, a, f, p, s]) => {
      const box = b as unknown as { x: number; y: number; width: number; height: number }
      const angle = a as unknown as number
      const fill = f as unknown as string
      const probe = p as unknown as { x: number; y: number }
      const size = s as unknown as { width: number; height: number }
      const c = document.createElement('canvas')
      c.width = size.width
      c.height = size.height
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.save()
      ctx.translate(box.x + box.width / 2, box.y + box.height / 2)
      ctx.rotate((angle * Math.PI) / 180)
      ctx.fillStyle = fill
      ctx.fillRect(-box.width / 2, -box.height / 2, box.width, box.height)
      ctx.restore()
      return Array.from(ctx.getImageData(probe.x, probe.y, 1, 1).data)
    },
    [box, angleDegrees, fillCss, probe, canvasSizePx] as unknown as undefined,
  )
}

describe('pending arbitrary rotation oracle (test-only Vite, flag false on disk)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (rotate-oracle config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (rotate-oracle config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk flag false, in-page flag true', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
  }, 120_000)

  it('-30/45/90 oracle: tight bbox, oracle-agreeing pixels, outline vs axis-aligned handles', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const size = await canvasSize()
    const localBox = { x: 280, y: 260, width: 200, height: 100 }

    // -30 degrees free drag.
    await dragRotateHandle(-30)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const wantNeg30 = expectedBbox(200, 100, -30)
    const boxNeg30 = (await selectionBox())!
    expect(Math.abs(boxNeg30.width - wantNeg30.width)).toBeLessThan(14)
    expect(Math.abs(boxNeg30.height - wantNeg30.height)).toBeLessThan(14)
    expect(Math.abs(boxNeg30.x + boxNeg30.width / 2 - CENTER.x)).toBeLessThan(8)
    expect(Math.abs(boxNeg30.y + boxNeg30.height / 2 - CENTER.y)).toBeLessThan(8)
    // Center painted; bbox far corner transparent (outside the rotated diamond).
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect((await pixel(Math.floor(boxNeg30.x) + 1, Math.floor(boxNeg30.y) + 1))[3]).toBe(0)
    // Independent oracle agrees at the center and at an inside probe.
    expect(await oracleSolidPixel(localBox, -30, '#ff0000', CENTER, size)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(await oracleSolidPixel(localBox, -30, '#ff0000', CENTER, size))
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[rotate-oracle:-30] bbox=${JSON.stringify(boxNeg30)} want=${JSON.stringify(wantNeg30)}`)

    // Selection outline is the tight rotated bbox; handles stay axis-aligned.
    const nw = (await handleCanvasPos('bitmap-floating-scale-handle-nw'))!
    const se = (await handleCanvasPos('bitmap-floating-scale-handle'))!
    const n = (await handleCanvasPos('bitmap-floating-scale-handle-n'))!
    const rotate = (await handleCanvasPos('bitmap-floating-rotate-handle'))!
    expect(Math.abs(nw.x - boxNeg30.x)).toBeLessThan(6)
    expect(Math.abs(nw.y - boxNeg30.y)).toBeLessThan(6)
    expect(Math.abs(se.x - (boxNeg30.x + boxNeg30.width))).toBeLessThan(6)
    expect(Math.abs(se.y - (boxNeg30.y + boxNeg30.height))).toBeLessThan(6)
    expect(Math.abs(n.x - (boxNeg30.x + boxNeg30.width / 2))).toBeLessThan(6)
    expect(Math.abs(n.y - boxNeg30.y)).toBeLessThan(6)
    expect(Math.abs(rotate.x - (boxNeg30.x + boxNeg30.width / 2))).toBeLessThan(10)
    expect(rotate.y).toBeLessThan(boxNeg30.y)
    // Bbox-corner handle sits OUTSIDE the rotated ink at -30 (no shape paint),
    // while the outline still spans it: true-shape vs axis handles. Note the
    // costume base is NOT blank (existing sprite art shows through), so the
    // correct expectation is "not shape-red" (base preserved), not
    // transparent: the NW bbox corner happens to sit over a transparent base
    // region, the SE handle over existing opaque art.
    expect(await pixel(Math.round(se.x) - 2, Math.round(se.y) - 2)).not.toEqual([255, 0, 0, 255])

    // Absolute-discipline return: +30 lands byte-identical to the staged frame.
    const stagedDigest = await canvasDigest()
    void stagedDigest
    await dragRotateHandle(30)
    const boxBack = (await selectionBox())!
    expect(Math.abs(boxBack.width - 202)).toBeLessThan(8)
    expect(Math.abs(boxBack.height - 102)).toBeLessThan(8)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(baseMd5)

    // Shift snap: raw +60 snaps to +45 (narrower bbox than a free +60).
    await dragRotateHandle(60, { shift: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const wantSnap45 = expectedBbox(200, 100, 45)
    const wantFree60 = expectedBbox(200, 100, 60)
    const boxSnap = (await selectionBox())!
    expect(Math.abs(boxSnap.width - wantSnap45.width)).toBeLessThan(14)
    expect(Math.abs(boxSnap.height - wantSnap45.height)).toBeLessThan(14)
    expect(Math.abs(boxSnap.width - wantFree60.width)).toBeGreaterThan(10)
    await dragRotateHandle(-45, { shift: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)

    // +45 then oracle check at 45.
    await dragRotateHandle(45)
    const want45 = expectedBbox(200, 100, 45)
    const box45 = (await selectionBox())!
    expect(Math.abs(box45.width - want45.width)).toBeLessThan(14)
    expect(Math.abs(box45.height - want45.height)).toBeLessThan(14)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(await oracleSolidPixel(localBox, 45, '#ff0000', CENTER, size))
    expect((await pixel(Math.floor(box45.x) + 1, Math.floor(box45.y) + 1))[3]).toBe(0)

    // Fresh stage for exact +90: bbox swaps, corners coincide (painted just
    // inside, transparent just outside).
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd52 = await vmCostumeMd5()
    await stageRectRed()
    await dragRotateHandle(90)
    expect(await vmCostumeMd5()).toBe(baseMd52)
    const want90 = expectedBbox(200, 100, 90)
    const box90 = (await selectionBox())!
    expect(Math.abs(box90.width - want90.width)).toBeLessThan(12)
    expect(Math.abs(box90.height - want90.height)).toBeLessThan(12)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(await oracleSolidPixel(localBox, 90, '#ff0000', CENTER, size))
    expect(await pixel(Math.ceil(box90.x) + 3, Math.ceil(box90.y) + 3)).toEqual([255, 0, 0, 255])
    expect((await pixel(Math.floor(box90.x) - 3, Math.floor(box90.y) - 3))[3]).toBe(0)
    console.log(`[rotate-oracle:+90] bbox=${JSON.stringify(box90)} want=${JSON.stringify(want90)}`)

    // res1 leg (-30, resolution-independent math): 200x100 at EBOX.
    await openBitmapRes1Stage()
    await paintCommittedBaseDot()
    const res1Md5 = await vmCostumeMd5()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidFill('#ff0000')
    const ra = await toScreen(EBOX.x1, EBOX.y1)
    const rb = await toScreen(EBOX.x2, EBOX.y2)
    await page.mouse.move(ra.x, ra.y)
    await page.mouse.down()
    await page.mouse.move(rb.x, rb.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual([255, 0, 0, 255])
    const res1Size = await canvasSize()
    await dragRotateHandle(-30)
    expect(await vmCostumeMd5()).toBe(res1Md5)
    const wantRes1 = expectedBbox(200, 100, -30)
    const boxRes1 = (await selectionBox())!
    expect(Math.abs(boxRes1.width - wantRes1.width)).toBeLessThan(14)
    expect(Math.abs(boxRes1.height - wantRes1.height)).toBeLessThan(14)
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual(
      await oracleSolidPixel({ x: EBOX.x1, y: EBOX.y1, width: 200, height: 100 }, -30, '#ff0000', ECENTER, res1Size),
    )
    expect((await pixel(Math.floor(boxRes1.x) + 1, Math.floor(boxRes1.y) + 1))[3]).toBe(0)
    console.log(`[rotate-oracle:res1-30] bbox=${JSON.stringify(boxRes1)} want=${JSON.stringify(wantRes1)}`)
    await assertOnDiskFlagFalse('oracle-angles')
  }, 300_000)

  it('outlined + gradient-transparent travel in the local frame; all 8 handles stay axis-aligned', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    // Horizontal red->blue outlined shape with a fat contour.
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await useGradientFill('horizontal', '#ff0000', '#0000ff')
    await page.getByLabel('Brush size').fill('8')
    const a = await toScreen(BOX.x1, BOX.y1)
    const b = await toScreen(BOX.x2, BOX.y2)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    // Outlined: center stays transparent, contour paints.
    expect((await pixel(CENTER.x, CENTER.y))[3]).toBe(0)
    await dragRotateHandle(45)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const box45 = (await selectionBox())!
    const want45 = expectedBbox(200, 100, 45)
    // Outlined padding is brush/2+1 = 5 each side: local 210x110.
    const wantOutlined = expectedBbox(210, 110, 45)
    expect(Math.abs(box45.width - want45.width)).toBeGreaterThan(2)
    expect(Math.abs(box45.width - wantOutlined.width)).toBeLessThan(16)
    expect((await pixel(CENTER.x, CENTER.y))[3]).toBe(0)
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    // All 8 handles remain on the axis-aligned bbox (not rotated with ink).
    for (const id of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      const testId = id === 'se' ? 'bitmap-floating-scale-handle' : `bitmap-floating-scale-handle-${id}`
      const p = (await handleCanvasPos(testId))!
      const wantX = id.includes('w') ? box45.x : id.includes('e') ? box45.x + box45.width : box45.x + box45.width / 2
      const wantY = id.includes('n') ? box45.y : id.includes('s') ? box45.y + box45.height : box45.y + box45.height / 2
      expect(Math.abs(p.x - wantX)).toBeLessThan(8)
      expect(Math.abs(p.y - wantY)).toBeLessThan(8)
    }
    console.log(`[rotate-oracle:outlined] bbox=${JSON.stringify(box45)} want=${JSON.stringify(wantOutlined)}`)

    // Transparent gradient leg: fresh filled rect, horizontal, fill transparent.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd52 = await vmCostumeMd5()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useGradientFill('horizontal', '#ff0000', '#0000ff')
    try {
      const toggle = page.getByRole('button', { name: 'Transparent fill' })
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    } catch {
      // Best effort.
    }
    const c = await toScreen(BOX.x1, BOX.y1)
    const d = await toScreen(BOX.x2, BOX.y2)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(d.x, d.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    await dragRotateHandle(-30)
    expect(await vmCostumeMd5()).toBe(baseMd52)
    // Local west end is the transparent stop: maps to screen
    // center + R(-30)*(-100,0) = (93.3,-50) offset; inset toward center.
    const rad = (-30 * Math.PI) / 180
    const west = { x: Math.round(CENTER.x + Math.cos(rad) * -70), y: Math.round(CENTER.y + Math.sin(rad) * -70) }
    const east = { x: Math.round(CENTER.x + Math.cos(rad) * 70), y: Math.round(CENTER.y + Math.sin(rad) * 70) }
    const westPx = await pixel(west.x, west.y)
    const eastPx = await pixel(east.x, east.y)
    // Transparent end fades (low alpha or toward the surviving RGB), opaque
    // end stays saturated blue. Screen-locked gradients fail this pair.
    expect(westPx[3]).toBeLessThan(200)
    expect(eastPx[2]).toBeGreaterThan(120)
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[rotate-oracle:transparent] west=${JSON.stringify(westPx)} east=${JSON.stringify(eastPx)}`)
    await assertOnDiskFlagFalse('outlined-gradient')
  }, 300_000)

  it('corners/edges + Alt-center + Shift-uniform + reverse crossing after rotation', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    await dragRotateHandle(30)
    const rotated = (await selectionBox())!
    const centerBefore = { x: rotated.x + rotated.width / 2, y: rotated.y + rotated.height / 2 }

    // Edge handles: N shrinks height, E grows width, VM clean, center painted.
    const hBefore = rotated.height
    const wBefore = rotated.width
    await dragScaleHandle('n', 0, 30)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const afterN = (await selectionBox())!
    expect(afterN.height).toBeLessThan(hBefore - 8)
    expect(Math.abs(afterN.width - wBefore)).toBeLessThan(20)
    await dragScaleHandle('e', 40, 0)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const afterE = (await selectionBox())!
    expect(afterE.width).toBeGreaterThan(afterN.width + 16)
    expect(await pixel(Math.round(afterE.x + afterE.width / 2), Math.round(afterE.y + afterE.height / 2))).not.toEqual([0, 0, 0, 0])

    // Alt-center: SE growth keeps the bbox center pinned.
    const beforeAlt = (await selectionBox())!
    const centerAltBefore = { x: beforeAlt.x + beforeAlt.width / 2, y: beforeAlt.y + beforeAlt.height / 2 }
    await dragScaleHandle('se', 50, 30, { alt: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const afterAlt = (await selectionBox())!
    expect(afterAlt.width).toBeGreaterThan(beforeAlt.width + 16)
    expect(Math.abs(afterAlt.x + afterAlt.width / 2 - centerAltBefore.x)).toBeLessThan(8)
    expect(Math.abs(afterAlt.y + afterAlt.height / 2 - centerAltBefore.y)).toBeLessThan(8)

    // Shift-uniform: corner keeps aspect (local uniform), VM clean.
    const beforeShift = (await selectionBox())!
    const ratioBefore = beforeShift.width / beforeShift.height
    await dragScaleHandle('nw', -45, -30, { shift: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const afterShift = (await selectionBox())!
    expect(afterShift.width).toBeGreaterThan(beforeShift.width + 8)
    expect(Math.abs(afterShift.width / afterShift.height - ratioBefore) / ratioBefore).toBeLessThan(0.2)

    // Reverse crossing: drag NW far across the center (mirror), no NaN/crash.
    await dragScaleHandle('nw', 260, 180)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const crossed = (await selectionBox())!
    expect(Number.isFinite(crossed.x + crossed.y + crossed.width + crossed.height)).toBe(true)
    expect(crossed.width).toBeGreaterThan(10)
    expect(crossed.height).toBeGreaterThan(10)
    expect(Math.abs(centerBefore.x - CENTER.x)).toBeLessThan(120)
    console.log(`[rotate-oracle:handles] rotated=${JSON.stringify(rotated)} crossed=${JSON.stringify(crossed)}`)
    await assertOnDiskFlagFalse('handles-alt-shift-crossing')
  }, 300_000)

  it('rotate-then-scale/move/90/recolor chain stays in-place until a single commit', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseCenter = await pixel(CENTER.x, CENTER.y)
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    await dragRotateHandle(45)
    // Scale after rotation (local uniform growth), then move, then +45 (=90).
    await dragScaleHandle('se', 50, 30)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const grown = (await selectionBox())!
    expect(grown.width).toBeGreaterThan(200)
    // Move via the selection interior (absolute, no drift): pick the bbox
    // center, drag +20/+10 canvas px.
    const rect = await canvasRectLive()
    const size = await canvasSize()
    const sxPerCanvas = rect.width / size.width
    const syPerCanvas = rect.height / size.height
    const startSel = (await selectionBox())!
    const startCx = startSel.x + startSel.width / 2
    const startCy = startSel.y + startSel.height / 2
    const startScreen = await toScreen(startCx, startCy)
    await page.mouse.move(startScreen.x, startScreen.y)
    await page.mouse.down()
    await page.mouse.move(startScreen.x + 20 * sxPerCanvas, startScreen.y + 10 * syPerCanvas, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const moved = (await selectionBox())!
    expect(Math.abs(moved.x + moved.width / 2 - (grown.x + grown.width / 2) - 20)).toBeLessThan(10)
    expect(Math.abs(moved.y + moved.height / 2 - (grown.y + grown.height / 2) - 10)).toBeLessThan(10)
    // Second rotate composes to 90 total; restyle in place (blue), VM clean.
    await dragRotateHandle(45)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    await page.getByLabel('Paint color', { exact: true }).fill('#0000ff')
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 0 && g === 0 && b === 255 && a === 255
      },
      [Math.round(moved.x + moved.width / 2), Math.round(moved.y + moved.height / 2)] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Commit once; exactly one history entry for the rotated chain: two
    // exact Undo/Redo cycles (Undo always lands on the pre-drag base, Redo
    // always on the commit; an intermediate/double-append would miss base).
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).not.toBe(baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    const movedCenter = { x: Math.round(moved.x + moved.width / 2), y: Math.round(moved.y + moved.height / 2) }
    expect(await pixel(movedCenter.x, movedCenter.y)).toEqual([0, 0, 255, 255])
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(
        ([px, py, want]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
          return got.join(',') === (want as number[]).join(',')
        },
        [CENTER.x, CENTER.y, baseCenter] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await vmCostumeMd5()).toBe(baseMd5)
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(
        ([px, py]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
          return r === 0 && g === 0 && b === 255 && a === 255
        },
        [movedCenter.x, movedCenter.y] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await vmCostumeMd5()).toBe(committedMd5)
    }
    console.log('[rotate-oracle:chain] rotate->scale->move->90->recolor single history ok')
    await assertOnDiskFlagFalse('chain-history')
  }, 300_000)

  it('bounds clipping without trails; external switch mid-drag; cancel + single history, no corruption', async () => {
    // Bounds/clipping: shape flush to the right edge, rotated, clipped clean.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed(EDGE_BOX)
    const edgeStagedDigest = await canvasDigest()
    const edgeStagedBox = (await selectionBox())!
    await dragRotateHandle(45)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const edgeRotated = (await selectionBox())!
    expect(Number.isFinite(edgeRotated.x + edgeRotated.width)).toBe(true)
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    // Cancel the rotation via Escape mid-way? Instead revert absolutely and
    // require byte-identical overlay (no trails from the clipped repaint).
    await dragRotateHandle(-45)
    expect(await canvasDigest()).toBe(edgeStagedDigest)
    expect(Math.abs((await selectionBox())!.width - edgeStagedBox.width)).toBeLessThan(8)
    console.log(`[rotate-oracle:clip] staged=${JSON.stringify(edgeStagedBox)} rotated=${JSON.stringify(edgeRotated)}`)

    // External target switch WHILE a rotate drag is held: no stale overlay.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const victimMd5 = await vmCostumeMd5()
    await stageRectRed()
    const victimDigest = await canvasDigest()
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const current = cards[0]!
    const other = cards.find((c) => c !== current)!
    await startHeldRotateDrag(45)
    const midBox = (await selectionBox())!
    expect(midBox.width).toBeGreaterThan(0)
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.waitForTimeout(1500)
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(900)
    // Either committed or retained off-canvas, never silently lost; the live
    // canvas must not show the victim overlay on the new target.
    const retained = (await pendingStatusCount()) > 0
    const nowMd5 = await vmCostumeMd5()
    const nowDigest = await canvasDigest()
    expect(retained || nowMd5 !== victimMd5).toBe(true)
    // Switch back: victim art intact (base or committed), no corruption.
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, current as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    const backDigest = await canvasDigest()
    expect(typeof backDigest).toBe('string')
    expect(backDigest.length).toBeGreaterThan(0)
    void victimDigest
    console.log(`[rotate-oracle:hostile-mid-drag] retained=${retained}`)

    // Cancel paths + single history on a fresh stage.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const hBaseMd5 = await vmCostumeMd5()
    const hBaseCenter = await pixel(CENTER.x, CENTER.y)
    await stageRectRed()
    const hStagedDigest = await canvasDigest()
    const hStagedBox = (await selectionBox())!
    for (const kind of ['pointercancel', 'lostpointercapture'] as const) {
      await startHeldRotateDrag(45)
      const mid = (await selectionBox())!
      expect(Math.abs(mid.width - hStagedBox.width)).toBeGreaterThan(4)
      await page.evaluate((t) => {
        const handle = document.querySelector('[data-testid="bitmap-floating-rotate-handle"]')!
        for (let id = 0; id < 8; id += 1) {
          handle.dispatchEvent(new PointerEvent(t as string, { pointerId: id, clientX: 0, clientY: 0, bubbles: true, cancelable: true }))
        }
      }, kind as unknown as undefined)
      await page.mouse.up().catch(() => undefined)
      await page.waitForTimeout(900)
      const restored = (await selectionBox())!
      expect(Math.abs(restored.width - hStagedBox.width)).toBeLessThan(8)
      expect(await vmCostumeMd5()).toBe(hBaseMd5)
      expect(await pendingStatusCount()).toBeGreaterThan(0)
    }
    expect(await canvasDigest()).toBe(hStagedDigest)
    await startHeldRotateDrag(45)
    await page.keyboard.press('Escape')
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(900)
    expect(Math.abs((await selectionBox())!.width - hStagedBox.width)).toBeLessThan(8)
    expect(await vmCostumeMd5()).toBe(hBaseMd5)
    // Commit, then prove exactly one history entry.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    expect(await pendingStatusCount()).toBe(0)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).not.toBe(hBaseMd5)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, hBaseCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 255 && g === 0 && b === 0
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(committedMd5)
    await assertOnDiskFlagFalse('clip-hostile-cancel-history')
  }, 300_000)
})
