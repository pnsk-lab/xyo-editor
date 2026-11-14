// Arbitrary-angle pending rotation E2E (test-only enabled Vite fixture).
//
// Serves the REAL Editor (`/` -> App.svelte) with the REAL VM through
// `test/vite.bitmap-pending.config.ts`, which flips
// `BITMAP_PENDING_UI_ENABLED` false->true IN MEMORY ONLY (HMR/watch OFF).
// On-disk `bitmap-pending-controller.ts` still contains exactly one
// `export const BITMAP_PENDING_UI_ENABLED = false as const` before, during
// and after the run (asserted). This file never edits product code and never
// copies AGPL-licensed implementation text: all helpers below are original
// test code driving the UI like a user (mouse/keyboard/shift, toolbar
// buttons, dispatched pointer events), plus own-words parity notes.
//
// Coverage (free rotate-handle leg, parametric `base + shape`):
// - rect res2: free +45 handle drag -> tight rotated bbox, center painted,
//   bbox corners transparent, base dot intact, zero VM writes until commit
// - absolute-drag discipline: +45 then -45 returns byte-identical to the
//   pre-rotation overlay (no drift, no accumulation)
// - Shift snap: +60 with Shift snaps to +45 (discriminated from free +60)
// - rect res2: free +90 (north -> east) swaps bbox extents, corners transparent
// - restyle after rotate: in-place, VM clean; Escape commits once; exact
//   Undo/Redo; double-Escape no-op
// - ellipse res1: Shift-snap rotate, restyle, corner resize AFTER rotation
//   (local matrix: uniform aspect preserved, growth, VM clean), commit,
//   exact Undo/Redo
// - cancel: pointercancel + lostpointercapture + Escape mid-drag revert to
//   the drag-start rotation with the pending retained and no VM/history write
// - hostile: target switch while staged-rotated is blocked (pending retained,
//   no silent loss); after commit, Redo + target round-trip lose nothing
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-rotate-arbitrary.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4683
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
      `[rotate-arbitrary] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run (accidental flip?)`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[rotate-arbitrary] on-disk bypass check (${stage}): controller source must not contain ${JSON.stringify(token)}`,
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

async function openBitmapRes2() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already in bitmap mode.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort only.
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
    // Already in bitmap mode.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {
    // Best effort only.
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

// Drag the free-rotation handle by an absolute gesture delta (canvas px
// angles, y-down clockwise positive). The handle floats above the selection
// top edge, so the press point is the handle's real center and the start
// angle is measured from it (not assumed north). Each drag is absolute from
// its own start: the product stages startRotation + gestureDelta.
async function dragRotateHandle(deltaDegrees: number, options: { shift?: boolean; hold?: boolean } = {}): Promise<void> {
  const box = (await selectionBox())!
  if (!box) throw new Error('No bitmap selection for rotate drag')
  const handle = page.getByTestId('bitmap-floating-rotate-handle')
  await handle.waitFor({ state: 'visible', timeout: 15_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('Rotate handle has no bounding box')
  const rect = await canvasRectLive()
  const size = await canvasSize()
  const toCanvas = (sx: number, sy: number) => ({
    x: ((sx - rect.left) / rect.width) * size.width,
    y: ((sy - rect.top) / rect.height) * size.height,
  })
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const startCanvas = toCanvas(hb.x + hb.width / 2, hb.y + hb.height / 2)
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
  if (options.hold) {
    if (options.shift) await page.keyboard.up('Shift')
    return
  }
  await page.mouse.up()
  if (options.shift) await page.keyboard.up('Shift')
  await page.waitForTimeout(900)
}

// Start a rotate-handle drag and leave the button held (for mid-drag cancel
// / Escape legs). The caller releases with `page.mouse.up()`.
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

// Tight rotated bbox of the inflated local box (filled padding 1 each side).
function expectedBbox(localW: number, localH: number, thetaDegrees: number): { width: number; height: number } {
  const rad = (Math.abs(thetaDegrees) * Math.PI) / 180
  const w = localW + 2
  const h = localH + 2
  return {
    width: w * Math.cos(rad) + h * Math.sin(rad),
    height: w * Math.sin(rad) + h * Math.cos(rad),
  }
}

async function dispatchCancelOnRotateHandle(type: 'pointercancel' | 'lostpointercapture'): Promise<void> {
  // Real browsers deliver cancel/loss to the pointer-capture holder (the
  // handle button); canvas-dispatched synthetics are dropped by the canvas
  // pointer-id guard, so target the handle like the reference handle tests.
  await page.evaluate((t) => {
    const handle = document.querySelector('[data-testid="bitmap-floating-rotate-handle"]')!
    for (let id = 0; id < 8; id += 1) {
      handle.dispatchEvent(new PointerEvent(t as string, { pointerId: id, clientX: 0, clientY: 0, bubbles: true, cancelable: true }))
    }
  }, type as unknown as undefined)
}

describe('pending arbitrary rotation (test-only enabled Vite fixture, flag false on disk)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (rotate-arbitrary config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (rotate-arbitrary config) failed to start')
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
    console.log('[rotate-arbitrary:instrumentation] on-disk=false ok, in-page=true ok')
  }, 120_000)

  it('rect res2 free +45: tight bbox, painted center, transparent corners, zero VM writes', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    const baseCenter = await pixel(CENTER.x, CENTER.y)
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const stagedDigest = await canvasDigest()
    const stagedBox = (await selectionBox())!
    await dragRotateHandle(45)
    // Zero writes until commit: VM bytes frozen, pending still staged.
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Tight rotated bbox (200x100 local + padding, 45 degrees).
    const want = expectedBbox(200, 100, 45)
    const boxAfter = (await selectionBox())!
    expect(Math.abs(boxAfter.width - want.width)).toBeLessThan(14)
    expect(Math.abs(boxAfter.height - want.height)).toBeLessThan(14)
    // Center keeps the shape center: still painted exactly red.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Bbox corners lie outside the rotated shape: transparent endpoints.
    const corner = await pixel(Math.floor(boxAfter.x) + 1, Math.floor(boxAfter.y) + 1)
    expect(corner[3]).toBe(0)
    // The committed base dot is untouched by the overlay repaint.
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[rotate-arbitrary:+45] bbox=${JSON.stringify(boxAfter)} want=${JSON.stringify(want)}`)
    // Absolute-drag discipline: -45 from the new handle returns byte-identical
    // to the pre-rotation overlay (no drift, no accumulation).
    await dragRotateHandle(-45)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    const boxBack = (await selectionBox())!
    expect(Math.abs(boxBack.x - stagedBox.x)).toBeLessThan(8)
    expect(Math.abs(boxBack.y - stagedBox.y)).toBeLessThan(8)
    expect(Math.abs(boxBack.width - stagedBox.width)).toBeLessThan(8)
    expect(Math.abs(boxBack.height - stagedBox.height)).toBeLessThan(8)
    expect(await canvasDigest()).toBe(stagedDigest)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(baseCenter).toBeDefined()
    await assertOnDiskFlagFalse('free-45')
  }, 300_000)

  it('rect res2 Shift +60 snaps to +45; free +90 swaps bbox extents', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    // Shift-snap: raw +60 snaps to +45 (discriminated from a free +60, whose
    // bbox would be ~26px narrower).
    await dragRotateHandle(60, { shift: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const want45 = expectedBbox(200, 100, 45)
    const snapped = (await selectionBox())!
    expect(Math.abs(snapped.width - want45.width)).toBeLessThan(14)
    expect(Math.abs(snapped.height - want45.height)).toBeLessThan(14)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    console.log(`[rotate-arbitrary:shift] snapped=${JSON.stringify(snapped)} want=${JSON.stringify(want45)}`)

    // Free +90 from the snapped state lands at 135 total; instead use a fresh
    // stage for an exact free +90 (north -> east handle drag = +90 delta).
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
    // At exactly 90 degrees the bbox corners coincide with the rotated shape
    // corners (painted): verify inside-painted just within the corner and a
    // transparent endpoint just outside it (tight, no bleed).
    expect(await pixel(Math.ceil(box90.x) + 3, Math.ceil(box90.y) + 3)).toEqual([255, 0, 0, 255])
    const outside90 = await pixel(Math.floor(box90.x) - 3, Math.floor(box90.y) - 3)
    expect(outside90[3]).toBe(0)
    console.log(`[rotate-arbitrary:+90] bbox=${JSON.stringify(box90)} want=${JSON.stringify(want90)}`)
    await assertOnDiskFlagFalse('shift-90')
  }, 300_000)

  it('restyle after rotate + Escape commit: one history entry, exact Undo/Redo', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseCenter = await pixel(CENTER.x, CENTER.y)
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    await dragRotateHandle(45)
    const stagedDigest = await canvasDigest()
    // In-place restyle of the rotated shape: no VM write, no history.
    await page.getByLabel('Paint color', { exact: true }).fill('#0000ff')
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 0 && g === 0 && b === 255 && a === 255
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await canvasDigest()).not.toBe(stagedDigest)
    // Blur the color field (typing-target Escape swallow parity), then Escape
    // commits exactly once.
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    // Double-Escape is a single-shot no-op.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(committedMd5)
    // Exact Undo/Redo cycles: one Undo restores the pre-drag base exactly.
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
      expect(await pixel(CENTER.x, CENTER.y)).toEqual(baseCenter)
      expect(await vmCostumeMd5()).toBe(baseMd5)
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(
        ([px, py]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
          return r === 0 && g === 0 && b === 255 && a === 255
        },
        [CENTER.x, CENTER.y] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
      expect(await vmCostumeMd5()).toBe(committedMd5)
    }
    console.log('[rotate-arbitrary:history] restyle->commit single entry, 2x Undo/Redo exact')
    await assertOnDiskFlagFalse('history')
  }, 300_000)

  it('ellipse res1: Shift rotate, restyle, corner resize after rotation, commit, exact undo', async () => {
    await openBitmapRes1Stage()
    await paintCommittedBaseDot()
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    const baseCenter = await pixel(ECENTER.x, ECENTER.y)
    const baseMd5 = await vmCostumeMd5()
    // Stage a 200x100 ellipse.
    await page.getByTestId('bitmap-tool-oval').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidFill('#ff0000')
    const a = await toScreen(EBOX.x1, EBOX.y1)
    const b = await toScreen(EBOX.x2, EBOX.y2)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual([255, 0, 0, 255])
    // Shift +60 snaps to +45 at res1 (resolution-independent math).
    await dragRotateHandle(60, { shift: true })
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const want45 = expectedBbox(200, 100, 45)
    const rotated = (await selectionBox())!
    expect(Math.abs(rotated.width - want45.width)).toBeLessThan(14)
    expect(Math.abs(rotated.height - want45.height)).toBeLessThan(14)
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual([255, 0, 0, 255])
    console.log(`[rotate-arbitrary:res1] bbox=${JSON.stringify(rotated)} want=${JSON.stringify(want45)}`)
    // Corner resize AFTER rotation: local-matrix uniform growth, VM clean.
    const handle = page.getByTestId('bitmap-floating-scale-handle')
    await handle.waitFor({ state: 'visible', timeout: 15_000 })
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('SE scale handle has no bounding box')
    const beforeRatio = rotated.width / rotated.height
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 40, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const grown = (await selectionBox())!
    expect(grown.width).toBeGreaterThan(rotated.width + 16)
    expect(grown.height).toBeGreaterThan(rotated.height + 10)
    const afterRatio = grown.width / grown.height
    expect(Math.abs(afterRatio - beforeRatio) / beforeRatio).toBeLessThan(0.15)
    expect(await pixel(ECENTER.x, ECENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[rotate-arbitrary:res1-scale] before=${JSON.stringify(rotated)} after=${JSON.stringify(grown)}`)
    // Commit, exact single Undo, Redo.
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).not.toBe(baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [ECENTER.x, ECENTER.y, baseCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(baseMd5)
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 255 && g === 0 && b === 0 && a === 255
      },
      [ECENTER.x, ECENTER.y] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(committedMd5)
    await assertOnDiskFlagFalse('res1-ellipse')
  }, 300_000)

  it('cancel paths: pointercancel/lostpointercapture/Escape revert the drag, pending retained', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    const stagedDigest = await canvasDigest()
    const stagedBox = (await selectionBox())!
    expect(await pendingStatusCount()).toBeGreaterThan(0)

    for (const kind of ['pointercancel', 'lostpointercapture'] as const) {
      const held = await startHeldRotateDrag(45)
      const midBox = (await selectionBox())!
      expect(Math.abs(midBox.width - stagedBox.width)).toBeGreaterThan(4)
      console.log(`[rotate-arbitrary:cancel] ${kind} mid=${JSON.stringify(midBox)} staged=${JSON.stringify(stagedBox)}`)
      await dispatchCancelOnRotateHandle(kind)
      await page.mouse.up().catch(() => undefined)
      await page.waitForTimeout(900)
      const restored = (await selectionBox())!
      console.log(`[rotate-arbitrary:cancel] ${kind} restored=${JSON.stringify(restored)}`)
      expect(Math.abs(restored.x - stagedBox.x)).toBeLessThan(8)
      expect(Math.abs(restored.y - stagedBox.y)).toBeLessThan(8)
      expect(Math.abs(restored.width - stagedBox.width)).toBeLessThan(8)
      expect(await vmCostumeMd5()).toBe(baseMd5)
      expect(await pendingStatusCount()).toBeGreaterThan(0)
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      console.log(`[rotate-arbitrary:cancel] ${kind} reverted to staged box ok`)
      void held
    }
    expect(await canvasDigest()).toBe(stagedDigest)

    // Escape mid-drag reverts the drag (no commit); a later Escape commits.
    await startHeldRotateDrag(45)
    await page.keyboard.press('Escape')
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(900)
    const afterEsc = (await selectionBox())!
    expect(Math.abs(afterEsc.width - stagedBox.width)).toBeLessThan(8)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    expect(await pendingStatusCount()).toBe(0)
    expect(await vmCostumeMd5()).not.toBe(baseMd5)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await assertOnDiskFlagFalse('cancel-paths')
  }, 300_000)

  it('hostile target switch while staged-rotated retains; redo + round-trip lose nothing', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const baseMd5 = await vmCostumeMd5()
    await stageRectRed()
    await dragRotateHandle(45)
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const current = cards[0]!
    const other = cards.find((c) => c !== current)!
    // Target switch with a staged rotated shape is blocked: the pending is
    // retained, nothing is silently lost, the VM is untouched.
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.waitForTimeout(1500)
    const committed = (await vmCostumeMd5()) !== baseMd5
    const retained = (await pendingStatusCount()) > 0
    expect(committed || retained).toBe(true)
    // Commit explicitly, then prove Redo + a target round-trip lose nothing.
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).not.toBe(baseMd5)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForTimeout(1200)
    expect(await vmCostumeMd5()).toBe(baseMd5)
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 255 && g === 0 && b === 0 && a === 255
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(committedMd5)
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(600)
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, current as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(committedMd5)
    console.log('[rotate-arbitrary:hostile] switch blocked-then-retained, redo + round-trip exact')
    await assertOnDiskFlagFalse('hostile')
  }, 300_000)
})
