// Fail-first durable real Editor+VM parity suite for the STAGED pending
// rect/oval selection transforms (move / scale / rotate), restyle control,
// and selection-after-tool-switch.
//
// Instrumentation (no production edits, no env/query bypass):
// - Test server uses `test/vite.bitmap-pending.config.ts`, which adds
//   `vite-bitmap-pending-enabled-plugin.ts` to the base Vite config.
// - The plugin replaces ONLY
//     `export const BITMAP_PENDING_UI_ENABLED = false as const`
//   with `true` during transform (single expected replacement, throws
//   otherwise). HMR/watch are OFF.
// - On-disk `bitmap-pending-controller.ts` still contains `false` before+after
//   (asserted here). Real Editor entry (`/` -> App.svelte) is used; no
//   synthetic canvas. Real ScratchVM via `__hikkakuEditorTest.snapshot()`.
// - Product flag stays `false` on disk; this file never edits product code.
//
// Reference (own-words summary, no source text copied):
// scratch-paint bit rect/oval `handleMouseUp` does NOT rasterize: the new
// vector shape stays selected under the armed tool; the bounding-box tool
// moves / scales / rotates it parametrically; `setColor`/`setFilled`/
// `setThickness` restyle it in place; only a deselect (blank press, Escape
// via clearSelection, tool/mode/target/costume/project switch via
// deactivateTool) commits it to the raster. Delete drops it with no raster
// change and no history.
//
// Product gap under test (staged engine currently disabled on disk):
// - `Editor.svelte` floating move/scale/rotate sessions operate on the live
//   raster bytes (committed path), never `session.moveBy()` /
//   `session.retarget()`; `rotateBitmap` has no pending guard at all; there is
//   no `rotatePendingBitmapShape` helper (box-math only per design doc §7).
// - So staged move/scale/rotate are expected RED here (fail-first: genuine
//   product gaps). The restyle control and the tool-switch commit leg document
//   the currently-wired behavior and must stay green.
// - Do NOT weaken or delete these expectations when they go red: fix the
//   product path instead (separate work; this suite only reports).
//
// Per-action isolation: every test calls `stagePendingRect()` which reloads
// the page (`openBitmap`), so each action starts from a fresh staged rect.
// Each test verifies, in order:
//   (a) pre-commit VM bytes unchanged (md5ext/assetId stable),
//   (b) exact rendered center pixel,
//   (c) overlay bounds (`[data-testid="bitmap-selection"]` in canvas px),
//   (d) explicit commit (Escape) lands once + single Undo restores pre-drag,
//   (e) target switch away/back leaves no residual pending/overlay.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-transform-parity.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4698
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }
const MOVE_DELTA = { dx: 80, dy: 60 }

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[transform-parity] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run (accidental flip?)`,
    )
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

async function openBitmap() {
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

async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
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

async function stagePendingRect(): Promise<{ beforeCenter: number[]; beforeMoved: number[]; beforeMd5: string | undefined; beforeDigest: string }> {
  await openBitmap()
  const beforeCenter = await pixel(CENTER.x, CENTER.y)
  // Proven fixture base (diag 4701): the default bitmap already carries orange
  // artwork at the move destination (460,370 = 255,171,25,255) while CENTER is
  // transparent. Capture the destination's own base BEFORE the staged rect, so
  // the move Undo expectation compares each pixel to its own base instead of
  // cross-comparing the moved pixel to CENTER's transparent base.
  const beforeMoved = await pixel(CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy)
  const beforeMd5 = await vmCostumeMd5()
  const beforeDigest = await canvasDigest()
  await dragRect()
  await page.waitForTimeout(800)
  return { beforeCenter, beforeMoved, beforeMd5, beforeDigest }
}

async function targetSwitchNoResidual(): Promise<{ retained: boolean; nonblank: boolean }> {
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
  await page.waitForTimeout(1500)
  const midBitmapVisible = await page.getByTestId('bitmap-editor-canvas').isVisible().catch(() => false)
  let midNonBlank = true
  if (midBitmapVisible) {
    try {
      midNonBlank = isNonBlankDigest(await canvasDigest())
    } catch {
      midNonBlank = true
    }
  }
  await page.evaluate((id: string) => {
    ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
  }, current as unknown as undefined)
  await page.waitForTimeout(1200)
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  const retained = (await pendingStatusCount()) > 0
  let nonblank = true
  try {
    nonblank = isNonBlankDigest(await canvasDigest())
  } catch {
    nonblank = midNonBlank
  }
  return { retained, nonblank }
}

describe('bitmap pending transform parity (staged move/scale/rotate/style/tool-switch, fail-first)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (pending transform config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (pending transform config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk flag stays false, in-page flag is true', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
    console.log('[transform-parity:instrumentation] on-disk=false ok, in-page=true ok')
  }, 120_000)

  it('staged move with pointer: parametric translate, VM unchanged, overlay follows, single undo, no residual', async () => {
    const { beforeCenter, beforeMoved, beforeMd5, beforeDigest } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const boxBefore = await selectionBox()
    expect(boxBefore).toBeDefined()
    console.log(`[transform-parity:move] staged box=${JSON.stringify(boxBefore)} vmUnchanged=${(await vmCostumeMd5()) === beforeMd5}`)

    // Reference: drag INSIDE the staged selection moves the parametric shape
    // (session.moveBy + base+shape re-render, no history, no VM write).
    // Product gap: Editor routes this to the legacy floating raster move
    // (startBitmapFloatingMove), which punches/stamps live bytes and saves on
    // pointerup. Fail-first: the VM-unchanged + retained-pending expectations
    // below stay RED until the product routes the drag to session.moveBy().
    const from = await toScreen(CENTER.x, CENTER.y)
    const to = await toScreen(CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)

    // (a) pre-commit VM bytes unchanged.
    const md5AfterMove = await vmCostumeMd5()
    console.log(`[transform-parity:move] after-drag vmUnchanged=${md5AfterMove === beforeMd5} pending=${await pendingStatusCount()}`)
    expect(md5AfterMove).toBe(beforeMd5)
    // Pending retained (no commit-first on a pure pending transform).
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // (b) exact rendered pixel: old center restores the base, new center paints.
    const movedCenter = await pixel(CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy)
    console.log(`[transform-parity:move] movedCenter=${movedCenter.join(',')} oldCenter=${(await pixel(CENTER.x, CENTER.y)).join(',')}`)
    expect(movedCenter).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    // (c) overlay bounds follow the drag delta (width/height unchanged).
    const boxAfter = await selectionBox()
    console.log(`[transform-parity:move] boxAfter=${JSON.stringify(boxAfter)}`)
    expect(boxAfter).toBeDefined()
    expect(Math.abs((boxAfter?.x ?? 0) - (boxBefore?.x ?? 0) - MOVE_DELTA.dx)).toBeLessThan(6)
    expect(Math.abs((boxAfter?.y ?? 0) - (boxBefore?.y ?? 0) - MOVE_DELTA.dy)).toBeLessThan(6)
    expect(Math.abs((boxAfter?.width ?? 0) - (boxBefore?.width ?? 0))).toBeLessThan(6)
    expect(Math.abs((boxAfter?.height ?? 0) - (boxBefore?.height ?? 0))).toBeLessThan(6)
    // (d) explicit Escape commits once; single Undo restores pre-drag.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pixel(CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy)).toEqual([255, 0, 0, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    // Fixture-corrected (proven by /tmp/move-diag.ts): the moved destination's
    // own pre-drag base is the default orange artwork (255,171,25,255), NOT
    // CENTER's transparent base. A single Undo restores VM md5 + the full
    // canvas digest + each pixel to its own base: moved -> beforeMoved
    // (orange), CENTER -> beforeCenter (transparent). One Undo only; no
    // loosening (exact toEqual on both pixels, exact md5 + digest restores).
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy, beforeMoved] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await pixel(CENTER.x + MOVE_DELTA.dx, CENTER.y + MOVE_DELTA.dy)).toEqual(beforeMoved)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await canvasDigest()).toBe(beforeDigest)
    // (e) new target shows no residual pending/overlay.
    const tail = await targetSwitchNoResidual()
    console.log(`[transform-parity:move] tail=${JSON.stringify(tail)}`)
    expect(tail.retained).toBe(false)
    expect(tail.nonblank).toBe(true)
  }, 180_000)

  it('staged corner scale: parametric retarget, VM unchanged, overlay grows, single undo, no residual', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const boxBefore = await selectionBox()
    expect(boxBefore).toBeDefined()
    console.log(`[transform-parity:scale] staged box=${JSON.stringify(boxBefore)}`)

    // Reference: SE corner handle drag retargets the box (session.retarget,
    // frozen-box math, Alt pins center / Shift frees corner), re-rendering
    // base+shape with no history and no VM write.
    // Product gap: the SE handle runs the legacy floating scale
    // (beginBitmapFloatingScale -> saveBitmapCostume on pointerup). Fail-first
    // RED until the handle routes to session.retarget().
    const handle = page.getByTestId('bitmap-floating-scale-handle')
    await handle.waitFor({ state: 'visible', timeout: 15_000 })
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('SE scale handle has no bounding box')
    const startX = hb.x + hb.width / 2
    const startY = hb.y + hb.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 60, startY + 40, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(900)

    const md5AfterScale = await vmCostumeMd5()
    console.log(`[transform-parity:scale] after-drag vmUnchanged=${md5AfterScale === beforeMd5} pending=${await pendingStatusCount()}`)
    expect(md5AfterScale).toBe(beforeMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // Center stays inside the grown shape and stays exactly red.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    void beforeCenter
    const boxAfter = await selectionBox()
    console.log(`[transform-parity:scale] boxAfter=${JSON.stringify(boxAfter)}`)
    expect(boxAfter).toBeDefined()
    expect((boxAfter?.width ?? 0)).toBeGreaterThan((boxBefore?.width ?? 0) + 20)
    expect((boxAfter?.height ?? 0)).toBeGreaterThan((boxBefore?.height ?? 0) + 10)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForTimeout(1200)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const tail = await targetSwitchNoResidual()
    console.log(`[transform-parity:scale] tail=${JSON.stringify(tail)}`)
    expect(tail.retained).toBe(false)
    expect(tail.nonblank).toBe(true)
  }, 180_000)

  it('staged rotate: no silent raster commit, VM unchanged, pending retained, single undo, no residual', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    console.log(`[transform-parity:rotate] staged vmUnchanged ok`)

    // Reference: the bounding-box rotate handle rotates the pending vector
    // object (design doc §7: box-math subset; arbitrary angles out of scope).
    // Product gap: `rotateBitmap` has NO pending guard and rotates the live
    // raster (committed path) + saves. Fail-first: VM-unchanged + retained
    // below stay RED until rotate routes through the pending gate (block or
    // parametric rotate). Do NOT fake it by rasterizing early.
    await page.getByTestId('rotate-bitmap-right').click()
    await page.waitForTimeout(1000)
    const md5AfterRotate = await vmCostumeMd5()
    const retained = (await pendingStatusCount()) > 0
    console.log(`[transform-parity:rotate] vmUnchanged=${md5AfterRotate === beforeMd5} retained=${retained}`)
    expect(md5AfterRotate).toBe(beforeMd5)
    expect(retained).toBe(true)
    // Staged square rect is rotation-symmetric: center stays exactly red.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const tail = await targetSwitchNoResidual()
    console.log(`[transform-parity:rotate] tail=${JSON.stringify(tail)}`)
    expect(tail.retained).toBe(false)
    expect(tail.nonblank).toBe(true)
  }, 180_000)

  it('staged restyle control: fill change restyles in place, VM unchanged, single undo, no residual', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const boxBefore = await selectionBox()
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
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const boxAfter = await selectionBox()
    console.log(`[transform-parity:restyle] boxBefore=${JSON.stringify(boxBefore)} boxAfter=${JSON.stringify(boxAfter)}`)
    expect(Math.abs((boxAfter?.x ?? 0) - (boxBefore?.x ?? 0))).toBeLessThan(4)
    expect(Math.abs((boxAfter?.width ?? 0) - (boxBefore?.width ?? 0))).toBeLessThan(4)
    // Fixture-corrected (proven by /tmp/restyle-diag.ts, not a product bug):
    // `.fill('#0000ff')` leaves focus in the Paint-color <input>, and both the
    // reference (`keyboard-shortcuts-hoc.jsx`: ignore Escape when
    // `event.target instanceof HTMLInputElement`) and the product
    // (`isShortcutTypingTarget`) correctly swallow Escape while a text input
    // is focused (raw Escape: pixel stays blue, md5 unchanged, pending 1,
    // focus still INPUT). Blur first so Escape reaches the commit handler;
    // same precedent as `hsv-live-selection-apply-audit` ("フォーカスを外し
    // てからEscape"). Exact pixel/md5/one-Undo guarantees unchanged.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pendingStatusCount()).toBe(0)
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const tail = await targetSwitchNoResidual()
    console.log(`[transform-parity:restyle] tail=${JSON.stringify(tail)}`)
    expect(tail.retained).toBe(false)
    expect(tail.nonblank).toBe(true)
  }, 180_000)

  it('selection after tool switch: leaves shape tools commit-first, VM lands once, single undo, no residual', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    // Reference deactivateTool: leaving rect/oval commits the pending shape,
    // then the new tool owns the (cleared) selection.
    await page.getByTestId('bitmap-tool-brush').click()
    await page.waitForTimeout(1500)
    const md5AfterSwitch = await vmCostumeMd5()
    const retained = (await pendingStatusCount()) > 0
    console.log(`[transform-parity:tool-switch] committed=${md5AfterSwitch !== beforeMd5} retained=${retained}`)
    expect(md5AfterSwitch).not.toBe(beforeMd5)
    expect(retained).toBe(false)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py, want]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const got = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return got.join(',') === (want as number[]).join(',')
      },
      [CENTER.x, CENTER.y, beforeCenter] as unknown as undefined,
      { timeout: 15_000 },
    )
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    const tail = await targetSwitchNoResidual()
    console.log(`[transform-parity:tool-switch] tail=${JSON.stringify(tail)}`)
    expect(tail.retained).toBe(false)
    expect(tail.nonblank).toBe(true)
  }, 180_000)
})
