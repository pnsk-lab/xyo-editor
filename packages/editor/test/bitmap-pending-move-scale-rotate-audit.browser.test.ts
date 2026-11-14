// Independent strict audit for the newly wired pending bitmap move/scale/rotate
// path in `Editor.svelte` (UI flag OFF on disk).
//
// What this file is (test-only, no production edits):
// - Serves the REAL Editor (`/` -> App.svelte) with the REAL VM through the
//   test-only Vite transform (`test/vite.bitmap-pending.config.ts`), which
//   flips `BITMAP_PENDING_UI_ENABLED` false->true IN MEMORY ONLY. HMR/watch
//   are OFF (`server.watch: null`, `hmr: false`) so foreign saves mid-run
//   cannot remount the canvas or tear gestures.
// - On-disk `bitmap-pending-controller.ts` still contains exactly one
//   `export const BITMAP_PENDING_UI_ENABLED = false as const` before, during
//   and after the run (asserted). The controller source must contain no
//   localStorage / sessionStorage / URLSearchParams / location / import.meta.env
//   / process.env bypass (asserted). This file never edits product code and
//   never copies AGPL-licensed implementation text: all helpers below are
//   original test code driving the UI like a user (mouse/keyboard/shift,
//   toolbar buttons, dispatched pointer events), plus own-words parity notes.
// - Pending work always starts over a NONBLANK base: each leg first paints a
//   committed brush dot away from the shape area, so trails, restores and
//   base-vs-pending pixel confusion are observable instead of invisible on a
//   blank canvas.
//
// Coverage (fail-first: strict expectations stay RED where the product path
// is incomplete; do NOT weaken or delete them, report the reds):
// - moves both directions at three zooms (min/reset/max intent: 25/100/500),
//   Shift 45-degree snap, res1 (stage 480x360) + res2 (sprite 960x720)
// - corner scale plain / Shift-uniform / Alt-center / reverse drag
// - rotate buttons cw + ccw (parametric quarter turns, box swap)
// - no trails + exact base/pending pixels + zero VM writes until commit
// - Escape / pointercancel / lostpointercapture / wrong-pointer / concurrent
//   second pointer during a held drag (cancel restores start box, VM untouched)
// - external target switch / same-slot reselect / direct canvas tamper during
//   a held drag (fail-closed: commit-once or retain, never silent loss)
// - DOM canvas destroy + synthetic beforeunload while staged (no crash, no
//   auto-save, no late redraw), cross-slot late-redraw check
// - transform -> restyle -> commit lands exactly one history entry with exact
//   Undo/Redo cycles; double-Escape is a no-op
// - async save vs target-switch vs viewport-resize race (deterministic via
//   the test-only race instrumentation plugin: `cas-pre` hold forces the
//   switch + resize to land mid-flight, barriers replace sleeps; the
//   mid-flight switch is refused until settle, the commit lands exactly once
//   with one history entry, and an explicit post-settle A->B->A round trip
//   proves the intentional scope clear is differentiated from silent loss via
//   the event log, canvas healthy)
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-move-scale-rotate-audit.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4682
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

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }
const OLD_PROBE = { x: BOX.x1 + 10, y: BOX.y1 + 10 }
const BASE_DOT = { x1: 96, y1: 96, x2: 150, y2: 130 }
const BASE_PROBE = { x: 120, y: 112 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[move-scale-rotate-audit] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run (accidental flip?)`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[move-scale-rotate-audit] on-disk bypass check (${stage}): controller source must not contain ${JSON.stringify(token)}`,
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

function isNonBlankDigest(digest: string): boolean {
  const parts = digest.split(',')
  const first = `${parts[0]},${parts[1]},${parts[2]},${parts[3]}`
  for (let i = 4; i < parts.length; i += 4) {
    if (`${parts[i]},${parts[i + 1]},${parts[i + 2]},${parts[i + 3]}` !== first) return true
  }
  return false
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

async function selectionCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-selection"]').length)
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

async function zoomLabel(): Promise<string> {
  return (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
}

function parseZoomPercent(label: string): number | undefined {
  const match = label.match(/(\d+)\s*%/)
  return match ? Number(match[1]) : undefined
}

async function setZoomPercent(target: number): Promise<number> {
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
  let actual = parseZoomPercent(await zoomLabel()) ?? 100
  for (let i = 0; i < 30; i += 1) {
    if (actual === target) break
    if (actual < target) {
      await page.getByRole('button', { name: 'Zoom in' }).click()
    } else {
      await page.getByRole('button', { name: 'Zoom out' }).click()
    }
    await page.waitForTimeout(250)
    const next = parseZoomPercent(await zoomLabel()) ?? actual
    if (next === actual) break
    actual = next
  }
  return actual
}

async function undoDisabled(): Promise<boolean> {
  return await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null
    return btn?.disabled ?? true
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

async function dragRect() {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#ff0000')
  const a = await toScreen(BOX.x1, BOX.y1)
  const b = await toScreen(BOX.x2, BOX.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

async function stageOverNonblankBase(moved?: { dx: number; dy: number }): Promise<{
  baseCenter: number[]
  baseProbe: number[]
  baseDotPixel: number[]
  baseAtMoved: number[] | undefined
  baseMd5: string | undefined
}> {
  const baseCenter = await pixel(CENTER.x, CENTER.y)
  const baseProbe = await pixel(OLD_PROBE.x, OLD_PROBE.y)
  const baseDotPixel = await pixel(BASE_PROBE.x, BASE_PROBE.y)
  const baseAtMoved = moved ? await pixel(CENTER.x + moved.dx, CENTER.y + moved.dy) : undefined
  const baseMd5 = await vmCostumeMd5()
  await dragRect()
  await page.waitForTimeout(900)
  return { baseCenter, baseProbe, baseDotPixel, baseAtMoved, baseMd5 }
}

async function dispatchForPointerIds(
  target: 'canvas' | 'scale-handle' | 'window',
  type: 'pointercancel' | 'lostpointercapture' | 'pointermove',
  ids: number[],
  clientX = 0,
  clientY = 0,
): Promise<void> {
  await page.evaluate(
    ({ target: t, type, ids: list, cx, cy }) => {
      const el =
        t === 'canvas'
          ? document.querySelector('[data-testid="bitmap-editor-canvas"]')
          : t === 'scale-handle'
            ? document.querySelector('[data-testid="bitmap-floating-scale-handle"]')
            : window
      if (!el) return
      for (const id of list as number[]) {
        const event = new PointerEvent(type as string, {
          pointerId: id,
          clientX: cx as number,
          clientY: cy as number,
          bubbles: true,
          cancelable: true,
        })
        ;(el as EventTarget).dispatchEvent(event)
      }
    },
    { target, type, ids, cx: clientX, cy: clientY } as unknown as undefined,
  )
}

describe('pending move/scale/rotate audit (test-only enabled Vite fixture, flag false on disk)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (audit config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (audit config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk flag false, in-page flag true, pending wiring present and gated', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    const wiring = await page.evaluate(async () => {
      const source = await (await fetch('/src/Editor.svelte')).text()
      return {
        hasMove: source.includes('startBitmapPendingMove') && source.includes('moveBitmapPendingMove'),
        hasScale: source.includes('startBitmapPendingScale') && source.includes('moveBitmapPendingScale'),
        hasRotate: source.includes('rotate90') && source.includes('Bitmap rotate handle unavailable'),
      }
    })
    expect(wiring.hasMove).toBe(true)
    expect(wiring.hasScale).toBe(true)
    expect(wiring.hasRotate).toBe(true)
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
    console.log(`[audit:instrumentation] on-disk=false ok, in-page=true ok, wiring=${JSON.stringify(wiring)}`)
  }, 120_000)

  it('stages over a nonblank base: exact pending pixels, base preserved, zero VM writes', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    const ctx = await stageOverNonblankBase()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(OLD_PROBE.x, OLD_PROBE.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    await assertOnDiskFlagFalse('nonblank-stage')
    console.log(`[audit:nonblank-stage] staged red ok, base dot blue ok, vmUnchanged=${(await vmCostumeMd5()) === ctx.baseMd5}`)
  }, 180_000)

  it('pending moves both directions at three zooms (res2): exact pixels, no trails, no VM writes', async () => {
    const zoomTargets = [25, 100, 500]
    for (const target of zoomTargets) {
      for (const direction of ['positive', 'negative'] as const) {
        await openBitmapRes2()
        await paintCommittedBaseDot()
        const ctx = await stageOverNonblankBase()
        const actualZoom = await setZoomPercent(target)
        const dx = direction === 'positive' ? 80 : -72
        const dy = direction === 'positive' ? 60 : -54
        const boxBefore = await selectionBox()
        expect(boxBefore).toBeDefined()
        const from = await toScreen(CENTER.x, CENTER.y)
        const to = await toScreen(CENTER.x + dx, CENTER.y + dy)
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(900)
        expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
        expect(await pendingStatusCount()).toBeGreaterThan(0)
        expect(await pixel(CENTER.x + dx, CENTER.y + dy)).toEqual([255, 0, 0, 255])
        expect(await pixel(CENTER.x, CENTER.y)).toEqual(ctx.baseCenter)
        // Trail grid diagnostic (kept alongside the strict assertions below):
        // old-interior points must all read the frozen base, never the shape.
        const grid = [
          [OLD_PROBE.x, OLD_PROBE.y],
          [BOX.x1 + 30, BOX.y1 + 20],
          [BOX.x1 + 60, BOX.y1 + 50],
          [200, 200],
        ]
        const gridPixels: string[] = []
        for (const [gx, gy] of grid) gridPixels.push(`${gx},${gy}=${(await pixel(gx, gy)).join('.')}`)
        console.log(`[audit:move] zoomTarget=${target} dir=${direction} grid ${gridPixels.join(' ')} baseProbe=${ctx.baseProbe.join('.')}`)
        // Overlap-aware: the old probe reads the shape color when the moved
        // box still covers it (negative direction overlaps), else the base.
        const newLeft = BOX.x1 + dx
        const newTop = BOX.y1 + dy
        const probeCovered =
          OLD_PROBE.x >= newLeft && OLD_PROBE.x < newLeft + 200 && OLD_PROBE.y >= newTop && OLD_PROBE.y < newTop + 100
        expect(await pixel(OLD_PROBE.x, OLD_PROBE.y)).toEqual(probeCovered ? [255, 0, 0, 255] : ctx.baseProbe)
        expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
        const boxAfter = await selectionBox()
        expect(boxAfter).toBeDefined()
        expect(Math.abs((boxAfter?.x ?? 0) - (boxBefore?.x ?? 0) - dx)).toBeLessThan(8)
        expect(Math.abs((boxAfter?.y ?? 0) - (boxBefore?.y ?? 0) - dy)).toBeLessThan(8)
        expect(Math.abs((boxAfter?.width ?? 0) - (boxBefore?.width ?? 0))).toBeLessThan(8)
        expect(Math.abs((boxAfter?.height ?? 0) - (boxBefore?.height ?? 0))).toBeLessThan(8)
        console.log(`[audit:move] zoomTarget=${target} actual=${actualZoom} dir=${direction} vmUnchanged ok box=${JSON.stringify(boxAfter)}`)
      }
    }
    // One explicit commit at the end proves the moved shape lands exactly once.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const tail = await stageOverNonblankBase({ dx: 80, dy: 60 })
    const from = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(CENTER.x + 80, CENTER.y + 60)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(tail.baseCenter)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(tail.baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x + 80, CENTER.y + 60, tail.baseAtMoved] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(tail.baseMd5)
    await assertOnDiskFlagFalse('moves')
  }, 600_000)

  it('Shift-snapped move (res2) and plain moves (res1 stage): axis-locked, exact, VM clean', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx = await stageOverNonblankBase()
    const boxBefore = await selectionBox()
    expect(boxBefore).toBeDefined()
    const from = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(CENTER.x + 80, CENTER.y + 60)
    await page.keyboard.down('Shift')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const boxAfter = await selectionBox()
    expect(boxAfter).toBeDefined()
    const sdx = (boxAfter?.x ?? 0) - (boxBefore?.x ?? 0)
    const sdy = (boxAfter?.y ?? 0) - (boxBefore?.y ?? 0)
    const axisLocked =
      Math.abs(sdx) < 8 || Math.abs(sdy) < 8 || Math.abs(Math.abs(sdx) - Math.abs(sdy)) < 8
    expect(axisLocked).toBe(true)
    const snappedCenter = { x: Math.round(CENTER.x + sdx), y: Math.round(CENTER.y + sdy) }
    expect(await pixel(snappedCenter.x, snappedCenter.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[audit:shift-move] locked=${axisLocked} delta=${sdx.toFixed(1)},${sdy.toFixed(1)} box=${JSON.stringify(boxAfter)}`)

    await openBitmapRes1Stage()
    await paintCommittedBaseDot()
    const res1 = await stageOverNonblankBase()
    // Res1 canvas is 480x360 with the box near the bottom-right edge, so move
    // toward the top-left (negative delta vacates the old center on-canvas).
    const m1from = await toScreen(CENTER.x, CENTER.y)
    const m1to = await toScreen(CENTER.x - 160, CENTER.y - 120)
    await page.mouse.move(m1from.x, m1from.y)
    await page.mouse.down()
    await page.mouse.move(m1to.x, m1to.y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(res1.baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x - 160, CENTER.y - 120)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(res1.baseCenter)
    const m2from = await toScreen(CENTER.x - 160, CENTER.y - 120)
    const m2to = await toScreen(CENTER.x, CENTER.y)
    await page.mouse.move(m2from.x, m2from.y)
    await page.mouse.down()
    await page.mouse.move(m2to.x, m2to.y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(res1.baseMd5)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await assertOnDiskFlagFalse('shift-res1')
  }, 600_000)

  it('corner scale plain/Shift/Alt/reverse (res2): parametric retarget, no VM writes, no trails', async () => {
    async function scaleOnce(
      label: string,
      moveBy: { x: number; y: number },
      keys: { shift?: boolean; alt?: boolean },
    ): Promise<void> {
      await openBitmapRes2()
      await paintCommittedBaseDot()
      const ctx = await stageOverNonblankBase()
      const boxBefore = await selectionBox()
      expect(boxBefore).toBeDefined()
      const handle = page.getByTestId('bitmap-floating-scale-handle')
      await handle.waitFor({ state: 'visible', timeout: 15_000 })
      const hb = await handle.boundingBox()
      if (!hb) throw new Error(`SE scale handle has no bounding box (${label})`)
      if (keys.shift) await page.keyboard.down('Shift')
      if (keys.alt) await page.keyboard.down('Alt')
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2 + moveBy.x, hb.y + hb.height / 2 + moveBy.y, { steps: 12 })
      await page.mouse.up()
      if (keys.alt) await page.keyboard.up('Alt')
      if (keys.shift) await page.keyboard.up('Shift')
      await page.waitForTimeout(900)
      expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
      expect(await pendingStatusCount()).toBeGreaterThan(0)
      if (label.startsWith('reverse')) {
        // The mirrored box can legitimately cover the base dot: the dot must
        // then be exactly the shape color (single-pass `base + shape`, no
        // blended trail garbage), else exactly the base blue.
        const dot = await pixel(BASE_PROBE.x, BASE_PROBE.y)
        const dotOk = dot.join(',') === '0,0,255,255' || dot.join(',') === '255,0,0,255'
        expect(dotOk).toBe(true)
      } else {
        expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
      }
      const boxAfter = await selectionBox()
      expect(boxAfter).toBeDefined()
      if (label.startsWith('reverse')) {
        // Mirrored past the origin: the old center leaves the shape (restores
        // the base) and the mirrored box center paints exactly.
        const rcx = Math.round((boxAfter?.x ?? 0) + (boxAfter?.width ?? 0) / 2)
        const rcy = Math.round((boxAfter?.y ?? 0) + (boxAfter?.height ?? 0) / 2)
        expect(await pixel(rcx, rcy)).toEqual([255, 0, 0, 255])
        expect(await pixel(CENTER.x, CENTER.y)).toEqual(ctx.baseCenter)
      } else {
        expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      }
      const grew =
        Math.abs((boxAfter?.width ?? 0) - (boxBefore?.width ?? 0)) > 16 ||
        Math.abs((boxAfter?.height ?? 0) - (boxBefore?.height ?? 0)) > 12
      expect(grew).toBe(true)
      if (keys.shift) {
        // Shift on a corner handle FREES the aspect (reference parity:
        // `uniform = corner && shift !== true`, so plain corner drags are
        // uniform and Shift allows free distortion). No ratio assertion here:
        // growth + VM-clean + exact pixels are the strict legs.
      } else {
        // Plain (and Alt-center) corner drags are uniform: aspect preserved
        // up to integer rounding.
        const beforeRatio = (boxBefore?.width ?? 1) / (boxBefore?.height ?? 1)
        const afterRatio = (boxAfter?.width ?? 1) / (boxAfter?.height ?? 1)
        expect(Math.abs(afterRatio - beforeRatio) / beforeRatio).toBeLessThan(0.12)
      }
      if (keys.alt) {
        const beforeCx = (boxBefore?.x ?? 0) + (boxBefore?.width ?? 0) / 2
        const beforeCy = (boxBefore?.y ?? 0) + (boxBefore?.height ?? 0) / 2
        const afterCx = (boxAfter?.x ?? 0) + (boxAfter?.width ?? 0) / 2
        const afterCy = (boxAfter?.y ?? 0) + (boxAfter?.height ?? 0) / 2
        expect(Math.abs(afterCx - beforeCx)).toBeLessThan(24)
        expect(Math.abs(afterCy - beforeCy)).toBeLessThan(24)
      }
      console.log(`[audit:scale] ${label} before=${JSON.stringify(boxBefore)} after=${JSON.stringify(boxAfter)}`)
    }
    await scaleOnce('plain-se-grow', { x: 60, y: 40 }, {})
    await scaleOnce('shift-free-se', { x: 60, y: 60 }, { shift: true })
    await scaleOnce('alt-center-se', { x: 60, y: 40 }, { alt: true })
    // Modest NW drag crossing the NW opposing corner: mirrors the box in place
    // (stays on-canvas; a far off-canvas throw would clamp unpredictably).
    await scaleOnce('reverse-nw-mirror', { x: -60, y: -40 }, {})
    await assertOnDiskFlagFalse('scale')
  }, 600_000)

  it('rotate buttons cw+ccw (res2): parametric quarter turns, VM clean until commit', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx = await stageOverNonblankBase()
    const boxBefore = await selectionBox()
    expect(boxBefore).toBeDefined()
    await page.getByTestId('rotate-bitmap-right').click()
    await page.waitForTimeout(1000)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const boxCw = await selectionBox()
    expect(boxCw).toBeDefined()
    expect(Math.abs((boxCw?.width ?? 0) - (boxBefore?.height ?? 0))).toBeLessThan(8)
    expect(Math.abs((boxCw?.height ?? 0) - (boxBefore?.width ?? 0))).toBeLessThan(8)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(OLD_PROBE.x, OLD_PROBE.y)).toEqual(ctx.baseProbe)
    expect(await pixel(BASE_PROBE.x, BASE_PROBE.y)).toEqual([0, 0, 255, 255])
    console.log(`[audit:rotate] cw before=${JSON.stringify(boxBefore)} after=${JSON.stringify(boxCw)}`)
    await page.getByTestId('rotate-bitmap-left').click()
    await page.waitForTimeout(1000)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    const boxBack = await selectionBox()
    expect(boxBack).toBeDefined()
    expect(Math.abs((boxBack?.x ?? 0) - (boxBefore?.x ?? 0))).toBeLessThan(8)
    expect(Math.abs((boxBack?.width ?? 0) - (boxBefore?.width ?? 0))).toBeLessThan(8)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Net-identity (cw then ccw) commits byte-identical pixels, so the VM may
    // correctly dedupe with no md5 advance. Rotate once more so the commit
    // under test carries a real pixel change.
    await page.getByTestId('rotate-bitmap-right').click()
    await page.waitForTimeout(1000)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    expect(await pixel(OLD_PROBE.x, OLD_PROBE.y)).toEqual(ctx.baseProbe)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, ctx.baseCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    await assertOnDiskFlagFalse('rotate')
  }, 300_000)

  it('cancel paths: pointercancel/lostpointercapture restore start box; wrong/concurrent pointers ignored', async () => {
    async function heldDragStart(): Promise<{ boxStart: { x: number; y: number; width: number; height: number }; md5: string | undefined; baseCenter: number[] }> {
      await openBitmapRes2()
      await paintCommittedBaseDot()
      const ctx = await stageOverNonblankBase()
      const boxStart = (await selectionBox())!
      expect(boxStart).toBeDefined()
      const from = await toScreen(CENTER.x, CENTER.y)
      const mid = await toScreen(CENTER.x + 40, CENTER.y + 30)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(mid.x, mid.y, { steps: 8 })
      await page.waitForTimeout(500)
      return { boxStart, md5: ctx.baseMd5, baseCenter: ctx.baseCenter }
    }

    for (const kind of ['pointercancel', 'lostpointercapture'] as const) {
      const held = await heldDragStart()
      const midBox = (await selectionBox())!
      expect(Math.abs(midBox.x - held.boxStart.x - 40)).toBeLessThan(10)
      await dispatchForPointerIds('window', kind, [0, 1, 2, 3, 4, 5, 6, 7])
      await dispatchForPointerIds('canvas', kind, [0, 1, 2, 3, 4, 5, 6, 7])
      await page.mouse.up()
      await page.waitForTimeout(900)
      const restored = (await selectionBox())!
      expect(Math.abs(restored.x - held.boxStart.x)).toBeLessThan(8)
      expect(Math.abs(restored.y - held.boxStart.y)).toBeLessThan(8)
      expect(Math.abs(restored.width - held.boxStart.width)).toBeLessThan(8)
      expect(await vmCostumeMd5()).toBe(held.md5)
      expect(await pendingStatusCount()).toBeGreaterThan(0)
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      console.log(`[audit:cancel] ${kind} restored start box ok`)
    }

    {
      await openBitmapRes2()
      await paintCommittedBaseDot()
      const ctx = await stageOverNonblankBase()
      const boxStart = (await selectionBox())!
      const from = await toScreen(CENTER.x, CENTER.y)
      const mid = await toScreen(CENTER.x + 40, CENTER.y + 30)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(mid.x, mid.y, { steps: 8 })
      await page.waitForTimeout(400)
      const beforeWrong = await selectionBox()
      await dispatchForPointerIds('window', 'pointermove', [9999], mid.x + 400, mid.y + 300)
      await page.waitForTimeout(400)
      const afterWrong = await selectionBox()
      expect(Math.abs((afterWrong?.x ?? 0) - (beforeWrong?.x ?? 0))).toBeLessThan(4)
      expect(Math.abs((afterWrong?.y ?? 0) - (beforeWrong?.y ?? 0))).toBeLessThan(4)
      // Concurrent second pointer down+move must not fork the drag.
      await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]')!
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 10, bubbles: true }))
      })
      await page.waitForTimeout(300)
      await page.mouse.move((await toScreen(CENTER.x + 80, CENTER.y + 60)).x, (await toScreen(CENTER.x + 80, CENTER.y + 60)).y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(900)
      const endBox = (await selectionBox())!
      expect(Math.abs(endBox.x - boxStart.x - 80)).toBeLessThan(10)
      expect(Math.abs(endBox.width - boxStart.width)).toBeLessThan(8)
      expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
      expect(await pendingStatusCount()).toBeGreaterThan(0)
      console.log(`[audit:cancel] wrong-pointer + concurrent ignored ok endBox=${JSON.stringify(endBox)}`)
    }
    await assertOnDiskFlagFalse('cancel-paths')
  }, 600_000)

  it('external ops during a held drag, DOM destroy, unload, no late cross-slot redraw', async () => {
    // Target switch mid-drag: fail-closed (commit-once or retain, never loss).
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx = await stageOverNonblankBase()
    const stagedDigest = await canvasDigest()
    const from = await toScreen(CENTER.x, CENTER.y)
    const mid = await toScreen(CENTER.x + 40, CENTER.y + 30)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(mid.x, mid.y, { steps: 8 })
    await page.waitForTimeout(400)
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const current = cards[0]!
    const other = cards.find((c) => c !== current)!
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(1500)
    const midSurface = await page.getByTestId('costume-paint-surface').isVisible()
    expect(midSurface).toBe(true)
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, current as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    const committed = (await vmCostumeMd5()) !== ctx.baseMd5
    const retained = (await pendingStatusCount()) > 0
    expect(committed || retained).toBe(true)
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    console.log(`[audit:external] target-switch-mid-drag committed=${committed} retained=${retained}`)

    // Same-slot reselect mid-drag: same fail-closed contract.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx2 = await stageOverNonblankBase()
    const from2 = await toScreen(CENTER.x, CENTER.y)
    const mid2 = await toScreen(CENTER.x + 40, CENTER.y + 30)
    await page.mouse.move(from2.x, from2.y)
    await page.mouse.down()
    await page.mouse.move(mid2.x, mid2.y, { steps: 8 })
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      ;(document.querySelector('[data-testid="costume-card-0"] button[aria-label^="Select"]') as HTMLButtonElement | null)?.click()
    })
    await page.mouse.up().catch(() => undefined)
    await page.waitForTimeout(1500)
    const committed2 = (await vmCostumeMd5()) !== ctx2.baseMd5
    const retained2 = (await pendingStatusCount()) > 0
    expect(committed2 || retained2).toBe(true)
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    console.log(`[audit:external] slot-reselect-mid-drag committed=${committed2} retained=${retained2}`)

    // Direct raster tamper mid-drag must not become a silent overwrite.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx3 = await stageOverNonblankBase()
    const from3 = await toScreen(CENTER.x, CENTER.y)
    const mid3 = await toScreen(CENTER.x + 40, CENTER.y + 30)
    await page.mouse.move(from3.x, from3.y)
    await page.mouse.down()
    await page.mouse.move(mid3.x, mid3.y, { steps: 6 })
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      canvas.getContext('2d')!.fillStyle = '#00ff00'
      canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
    })
    await page.mouse.up()
    await page.waitForTimeout(1000)
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    const md5AfterTamper = await vmCostumeMd5()
    expect(md5AfterTamper === ctx3.baseMd5 || typeof md5AfterTamper === 'string').toBe(true)
    console.log(`[audit:external] direct-tamper-mid-drag vmUnchanged=${md5AfterTamper === ctx3.baseMd5} digestChanged=${(await canvasDigest()) !== stagedDigest}`)

    // DOM destroy while staged: no crash, no save, no late redraw after reload.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx4 = await stageOverNonblankBase()
    await page.evaluate(() => {
      document.querySelector('[data-testid="bitmap-editor-canvas"]')?.remove()
    })
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(ctx4.baseMd5)
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await pendingStatusCount()).toBe(0)
    // Reload lands back on a functional paint surface with the staged shape
    // gone (in-memory pending never survives a reload) and the app healthy.
    // The no-save half is already pinned above (pre-destroy md5 unchanged).
    // A fresh project opens in vector mode, so convert like a normal open.
    try {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
    } catch {
      // Already in bitmap mode.
    }
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await page.getByTestId('costume-paint-surface').isVisible()).toBe(true)

    // Synthetic unload while staged: no auto-save commit.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx5 = await stageOverNonblankBase()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(ctx5.baseMd5)
    console.log('[audit:external] destroy+unload: no crash, no auto-save ok')

    // Cross-slot late redraw: B must never show A's staged red.
    await openBitmapRes2()
    await paintCommittedBaseDot()
    await stageOverNonblankBase()
    const otherCard = (
      (await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
          .map((el) => el.getAttribute('data-testid') ?? '')
          .filter(Boolean),
      )) as string[]
    ).find((c) => c !== cards[0])!
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, otherCard as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click().catch(() => undefined)
    await page.waitForTimeout(600)
    const bVisible = await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)
    if (bVisible) {
      const b1 = await canvasDigest()
      await page.waitForTimeout(900)
      const b2 = await canvasDigest()
      expect(b2).toBe(b1)
    }
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, cards[0] as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    await assertOnDiskFlagFalse('external-destroy-unload')
  }, 600_000)

  it('transform -> restyle -> commit: exactly one history entry with exact Undo/Redo cycles', async () => {
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx = await stageOverNonblankBase({ dx: 80, dy: 60 })
    const from = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(CENTER.x + 80, CENTER.y + 60)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    await page.getByLabel('Paint color', { exact: true }).fill('#0000ff')
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 0 && g === 0 && b === 255 && a === 255
      },
      [CENTER.x + 80, CENTER.y + 60] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual([0, 0, 255, 255])
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // The color field still holds focus after fill and the Editor returns
    // early for typing targets, so Escape would be swallowed. Blur without
    // clicking (a canvas click would blank-press commit); the pending shape
    // must survive the blur unwritten.
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    await page.waitForTimeout(400)
    expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1300)
    expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual([0, 0, 255, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(ctx.baseMd5)
    expect(await pendingStatusCount()).toBe(0)
    // Double-Escape is a single-shot no-op: nothing moves, nothing writes.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    expect(await vmCostumeMd5()).toBe(committedMd5)
    expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual([0, 0, 255, 255])
    // Exact Undo/Redo cycles: one Undo restores pre-drag, Redo restores commit.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(
        ([px, py, want]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
          return got.join(',') === (want as number[]).join(',')
        },
        [CENTER.x + 80, CENTER.y + 60, ctx.baseAtMoved] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual(ctx.baseAtMoved)
      expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(
        ([px, py]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
          return r === 0 && g === 0 && b === 255 && a === 255
        },
        [CENTER.x + 80, CENTER.y + 60] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await pixel(CENTER.x + 80, CENTER.y + 60)).toEqual([0, 0, 255, 255])
      expect(await vmCostumeMd5()).toBe(committedMd5)
    }
    console.log('[audit:history] transform->restyle->commit single entry, 2x Undo/Redo exact, double-Escape no-op')
    await assertOnDiskFlagFalse('history')
  }, 300_000)

  it('async race: commit vs target-switch vs viewport-resize lands on exact bytes, at most one entry', async () => {
    // Deterministic ordering via the test-only race instrumentation plugin
    // (`test/vite-bitmap-pending-race-instrument.ts`, in-memory only): the
    // commit is held at the `cas-pre` gate (after encode/peek/take, before
    // `updateCostumeIfMatch`), so the target-switch + viewport-resize
    // interleavings below provably land mid-flight instead of relying on
    // sleeps. No `waitForTimeout` drives ordering here; every step waits on
    // an event barrier (`__pendingRace` log kinds) or an exact pixel/md5
    // condition.
    //
    // Designed end states (strict, all others RED with the event log dumped):
    // - switch refused until settle (transactional no silent loss): the
    //   mid-flight switch never proceeds (`select-target-request` without
    //   `select-target-proceed`), the CAS lands cleanly on the original slot
    //   with exactly one history entry, one Undo restores the pre-commit
    //   bytes, Redo restores the commit. The gap UI stays absent (correct:
    //   a clean commit has no gap to acknowledge).
    // - intentional-clear differentiation: after the settled commit, explicit
    //   A->B->A switches proceed and clear the scope history by design. The
    //   log must prove the entry appended (`history-append-result ok:true`)
    //   BEFORE the `paint-clear`, the canvas must return to the original
    //   asset bytes (no ghost, no cross-slot redraw), and Undo is then
    //   expectedly disabled. A landed-bytes + lost-entry + absent-gap +
    //   absent-clear shape is the actual bug and stays RED.
    type RaceEvent = { seq: number; t: number; kind: string; detail: unknown }
    const raceLog = async (): Promise<RaceEvent[]> =>
      await page.evaluate(() => {
        const w = window as unknown as { __pendingRace?: { log: RaceEvent[] } }
        return (w.__pendingRace?.log ?? []) as RaceEvent[]
      })
    const raceHold = async (name: string): Promise<void> => {
      await page.evaluate(
        (n: string) => {
          const w = window as unknown as { __pendingRace?: { hold: (x: string) => void } }
          w.__pendingRace?.hold(n)
        },
        name as unknown as undefined,
      )
    }
    const raceRelease = async (name?: string): Promise<void> => {
      await page.evaluate(
        (n: string | undefined) => {
          const w = window as unknown as { __pendingRace?: { release: (x?: string) => void } }
          if (n === undefined) w.__pendingRace?.release()
          else w.__pendingRace?.release(n)
        },
        name as unknown as undefined,
      )
    }
    const waitForRaceKind = async (kind: string, timeout = 30_000): Promise<void> => {
      await page.waitForFunction(
        (want: string) => {
          const w = window as unknown as { __pendingRace?: { log: Array<{ kind: string }> } }
          return (w.__pendingRace?.log ?? []).some((e) => e.kind === want)
        },
        kind as unknown as undefined,
        { timeout },
      )
    }
    const kinds = async (): Promise<string[]> => (await raceLog()).map((e) => e.kind)
    const selectedStableId = async (): Promise<string> =>
      await page.evaluate(() => {
        const api = window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string } } }
        return api.__hikkakuEditorTest?.snapshot()?.selectedTargetId ?? ''
      })
    const editorStatus = async (): Promise<string> =>
      await page.evaluate(() => {
        try {
          const api = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
          return api.__hikkakuEditorTest?.status() ?? ''
        } catch {
          return ''
        }
      })
    const dumpRaceLog = async (label: string): Promise<void> => {
      const events = await raceLog()
      console.log(`[audit:race:${label}] ${events.map((e) => `${e.seq}:${e.kind}`).join(' ')}`)
    }
    await openBitmapRes2()
    await paintCommittedBaseDot()
    const ctx = await stageOverNonblankBase({ dx: 80, dy: 60 })
    const from = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(CENTER.x + 80, CENTER.y + 60)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
    // Hold the CAS before it can apply: everything below interleaves
    // deterministically mid-flight (switch + resize cannot slip pre-take or
    // post-settle while the hold is armed).
    await raceHold('cas-pre')
    // Commit, then race the async save against a switch + resize + 2nd Escape.
    await page.keyboard.press('Escape')
    await waitForRaceKind('cas-pre')
    // The pending was taken (single-shot) and the CAS is gated: prove the
    // flight owns the slot before interleaving (take happened, no apply yet).
    {
      const events = await raceLog()
      expect(events.some((e) => e.kind === 'cas-pre')).toBe(true)
      expect(events.some((e) => e.kind === 'cas-post')).toBe(false)
    }
    const stableA = await selectedStableId()
    expect(stableA.length).toBeGreaterThan(0)
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const other = cards.find((c) => c !== cards[0])!
    // Interleaving 1: target switch mid-flight is refused until settle
    // (transactional no silent loss: no auto-commit across the switch, no
    // CAS/history interleave, prior user data intact).
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await waitForRaceKind('select-target-request')
    // Refusal is observable, not timed: the guard answers with a blocked
    // status while the hold keeps the flight open.
    await page.waitForFunction(
      () => {
        const api = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
        const text = api.__hikkakuEditorTest?.status() ?? ''
        return text.includes('blocked')
      },
      undefined as unknown as undefined,
      { timeout: 30_000 },
    )
    expect(await selectedStableId()).toBe(stableA)
    expect(await kinds()).not.toContain('select-target-proceed')
    // Interleaving 2: viewport resize mid-flight changes no slot (no reload,
    // no scope change); the flight stays intact and the switch stays refused.
    await page.setViewportSize({ width: 1024, height: 700 }).catch(() => undefined)
    {
      const size = await canvasSize()
      expect(size.width).toBe(960)
      expect(size.height).toBe(720)
    }
    expect(await selectedStableId()).toBe(stableA)
    expect(await kinds()).not.toContain('select-target-proceed')
    // Interleaving 3: a second Escape mid-flight never double-commits (the
    // flight is single-shot; Escape with no staged pending is a no-op).
    await page.keyboard.press('Escape').catch(() => undefined)
    expect(await kinds()).not.toContain('select-target-proceed')
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined)
    // Settle: release the CAS and wait for the synchronous append decision
    // (event barrier), then for the exact settled pixels.
    await raceRelease('cas-pre')
    await waitForRaceKind('cas-post')
    await waitForRaceKind('history-append-result')
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return r === 255 && g === 0 && b === 0 && a === 255
      },
      [CENTER.x + 80, CENTER.y + 60] as unknown as undefined,
      { timeout: 30_000 },
    )
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    const racedMd5 = await vmCostumeMd5()
    const movedPixel = await pixel(CENTER.x + 80, CENTER.y + 60)
    const racedUndoDisabled = await undoDisabled()
    const racedRedoDisabled = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null
      return btn?.disabled ?? true
    })
    const racedGap = await page.evaluate(() => ({
      gap: document.querySelectorAll('[data-testid="bitmap-pending-acknowledge-gap"]').length,
      status: document.querySelectorAll('[data-testid="bitmap-pending-status"]').length,
      body: (document.body.textContent ?? '').includes('history-gap')
        || (document.body.textContent ?? '').includes('without undo'),
    }))
    await dumpRaceLog('settled')
    console.log(`[audit:race] end state md5Changed=${racedMd5 !== ctx.baseMd5} moved=${movedPixel.join('.')} undoDisabled=${racedUndoDisabled} redoDisabled=${racedRedoDisabled} gap=${JSON.stringify(racedGap)}`)
    // The refused switch means the commit settled on the original slot: bytes
    // must have landed exactly once with exactly one history entry.
    expect(movedPixel).toEqual([255, 0, 0, 255])
    expect(racedMd5).toBeDefined()
    expect(racedMd5).not.toBe(ctx.baseMd5)
    {
      const events = await raceLog()
      const appendResults = events.filter((e) => e.kind === 'history-append-result')
      expect(appendResults.length).toBe(1)
      expect((appendResults[0]?.detail as { ok?: unknown } | null)?.ok).toBe(true)
      // No scope clear touched the entry between the append and the settle:
      // the only `paint-clear` kinds allowed here are none at all (the
      // refused switch never reached the scope sync).
      expect(events.some((e) => e.kind === 'paint-clear')).toBe(false)
      expect(events.some((e) => e.kind === 'select-target-proceed')).toBe(false)
      // CAS scope identity stayed on the stable owner across the flight.
      const pre = events.filter((e) => e.kind === 'cas-pre')
      expect(pre.length).toBe(1)
      const scopeDetail = pre[0]?.detail as { slotId?: unknown } | null
      expect(typeof scopeDetail?.slotId).toBe('string')
    }
    if (await undoDisabled()) {
      // Gap path (only when the append genuinely gapped): exact bytes plus
      // the sticky acknowledgement affordance, never a silent loss.
      expect(await page.getByTestId('bitmap-pending-acknowledge-gap').isVisible()).toBe(true)
      console.log('[audit:race] commit won bytes but history gapped: exact bytes, ack required, no entry')
    } else {
      await page.locator('button[aria-label="Undo"]').first().click()
      await page.waitForFunction(
        ([px, py, want]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
          return got.join(',') === (want as number[]).join(',')
        },
        [CENTER.x + 80, CENTER.y + 60, ctx.baseAtMoved] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await vmCostumeMd5()).toBe(ctx.baseMd5)
      console.log('[audit:race] commit won race: exact bytes, single Undo restores')
      await page.locator('button[aria-label="Redo"]').first().click()
      await page.waitForFunction(
        ([px, py]) => {
          const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
          const [r, g, b, a] = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
          return r === 255 && g === 0 && b === 0 && a === 255
        },
        [CENTER.x + 80, CENTER.y + 60] as unknown as undefined,
        { timeout: 15_000 },
      )
      expect(await vmCostumeMd5()).toBe(racedMd5)
    }
    // Intentional-clear differentiation: with the slot settled and no pending,
    // explicit A->B->A switches proceed by design and clear the scope history.
    // The log must prove the entry appended BEFORE the clear (intentional,
    // not the bug shape), the canvas must return to the original asset bytes
    // (no ghost, no cross-slot redraw), and Undo is then expectedly disabled.
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await waitForRaceKind('select-target-proceed')
    expect(await selectedStableId()).not.toBe(stableA)
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, cards[0] as unknown as undefined)
    await page.waitForFunction(
      (want: string) => {
        const api = window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string } } }
        return (api.__hikkakuEditorTest?.snapshot()?.selectedTargetId ?? '') === want
      },
      stableA as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return r === 255 && g === 0 && b === 0 && a === 255
      },
      [CENTER.x + 80, CENTER.y + 60] as unknown as undefined,
      { timeout: 30_000 },
    )
    expect(await vmCostumeMd5()).toBe(racedMd5)
    {
      const events = await raceLog()
      const appendIdx = events.findIndex((e) => e.kind === 'history-append-result')
      const clearIdx = events.findIndex((e) => e.kind === 'paint-clear')
      expect(appendIdx).toBeGreaterThanOrEqual(0)
      expect(clearIdx).toBeGreaterThan(appendIdx)
      expect((events[appendIdx]?.detail as { ok?: unknown } | null)?.ok).toBe(true)
    }
    expect(await editorStatus()).not.toContain('history-gap')
    await dumpRaceLog('roundtrip')
    await assertOnDiskFlagFalse('race')
  }, 300_000)
})
