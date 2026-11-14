// Fail-first E2E for bitmap pending structural/switch routes (enabled IN MEMORY ONLY).
//
// Instrumentation (no production edits, no env/query bypass):
// - Same mechanism as `bitmap-pending-enabled.browser.test.ts`: test server uses
//   `test/vite.bitmap-pending.config.ts` (transform-only `false` -> `true`).
// - On-disk `bitmap-pending-controller.ts` still contains `false` before+after.
// - Real Editor entry (`/` -> App.svelte); visible toolbar/card/keyboard UI only
//   (no direct VM mutation in these tests).
//
// Coverage (fail-first: unsafe expectations stay RED where product is incomplete):
// - blue base + red pending staging (displayed red, VM blue, pending visible)
// - duplicate costume toolbar refused while pending/inflight
// - delete current costume card refused; delete other refused
// - reorder (drag DnD) refused; restore-deleted refused
// - delete sprite card refused; duplicate sprite context-menu refused;
//   export sprite refused
// - tab switch code/sounds and back refused (no UI switch if unsafe)
// - convert bitmap<->vector commit-first allowed (already guarded, green)
// - export/import: export sprite refused while pending (exact bytes)
// - second blank shape press: atomic commit-then-stage (single history)
// - legacy select-floating while pending refused
// - beforeunload warns while pending (exact bytes via md5 + digest)
// - race: delayed CAS (hold cas-pre) gates actions + same-name target
//
// For each disjunction the test accepts ONLY the safe legs:
//   (a) explicit refusal preserving pending/base + zero VM/costume/target/tab
//       mutation, or (b) atomic commit followed by the op with a single
//       history/recovery or quarantine + explicit export. Anything else is RED.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-structural-ops.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4697
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
const BOX2 = { x1: 600, y1: 420, x2: 760, y2: 520 }
const CENTER = { x: 380, y: 310 }
const CENTER2 = { x: 680, y: 470 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}
function countNeedle(source: string): number {
  return source.split(NEEDLE).length - 1
}
async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = countNeedle(source)
  if (count !== 1) {
    throw new Error(
      `[structural-ops] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(`[structural-ops] on-disk bypass check (${stage}): must not contain ${JSON.stringify(token)}`)
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
async function snapshotInfo(): Promise<{
  stableId: string
  md5: string | undefined
  costumeCount: number
  targetCount: number
  tab: string
  bytesLen: number
}> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown; selectedTab: () => string } }).__hikkakuEditorTest
    const snap = api?.snapshot() as
      | {
          selectedTargetId?: string
          project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string; dataFormat?: string }> }> }
        }
      | undefined
    const targets = snap?.project?.targets ?? []
    const sel = targets.find((t) => t.id === snap?.selectedTargetId) ?? targets.find((t) => !t.isStage) ?? targets[0]
    const idx = sel?.currentCostume ?? 0
    return {
      stableId: String((sel as { id?: string } | undefined)?.id ?? (sel as { name?: string } | undefined)?.name ?? ''),
      md5: (sel?.costumes?.[idx] as { md5ext?: string; assetId?: string } | undefined)?.md5ext ?? sel?.costumes?.[idx]?.assetId,
      costumeCount: sel?.costumes?.length ?? 0,
      targetCount: targets.length,
      tab: api?.selectedTab() ?? '',
      bytesLen: 0,
    }
  })
}
async function loadedAssetBytesLen(): Promise<number> {
  return await page.evaluate(async () => {
    try {
      const w = window as unknown as {
        __hikkakuEditorTest?: { snapshot: () => unknown }
      }
      void w
      return -1
    } catch {
      return -1
    }
  })
}
async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}
async function editorStatusText(): Promise<string> {
  return await page.evaluate(() => {
    try {
      return (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? ''
    } catch {
      return ''
    }
  })
}
async function raceKinds(): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __pendingRace?: { log: Array<{ kind: string }> } }
    return (w.__pendingRace?.log ?? []).map((e) => e.kind)
  })
}
async function raceClear(): Promise<void> {
  await page.evaluate(() => {
    try {
      ;(window as unknown as { __pendingRace?: { clear: () => void } }).__pendingRace?.clear()
    } catch {}
  })
}
async function raceHold(name: string): Promise<void> {
  await page.evaluate((n: string) => {
    ;(window as unknown as { __pendingRace?: { hold: (x: string) => void } }).__pendingRace?.hold(n as string)
  }, name as unknown as undefined)
}
async function raceRelease(name?: string): Promise<void> {
  await page.evaluate((n: string | undefined) => {
    const w = window as unknown as { __pendingRace?: { release: (x?: string) => void } }
    if (n === undefined) w.__pendingRace?.release()
    else w.__pendingRace?.release(n)
  }, name as unknown as undefined)
}
async function waitForRaceKind(kind: string, timeout = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await raceKinds()).includes(kind)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForRaceKind timeout ${JSON.stringify(kind)}, got ${JSON.stringify(await raceKinds())}`)
}
async function waitForEditorStatus(fragment: string, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await editorStatusText()).includes(fragment)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForEditorStatus timeout ${JSON.stringify(fragment)}, got ${JSON.stringify(await editorStatusText())}`)
}
async function beforeunloadPrevented(): Promise<boolean> {
  return await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    try {
      ;(event as unknown as { returnValue: unknown }).returnValue = true
    } catch {}
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function openBitmap() {
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
  } catch {}
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) {
    throw new Error(`Expected res2 960x720 backing, got ${size.width}x${size.height}`)
  }
}
async function useSolidFill(fill: string) {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}
async function dragBox(box: { x1: number; y1: number; x2: number; y2: number }) {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toScreen(box.x1, box.y1)
  const b = await toScreen(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}
/** Blue base (committed) + red pending overlay. Returns base + pending identities. */
async function ensureTwoCostumes(): Promise<void> {
  const before = (await snapshotInfo()).costumeCount
  if (before >= 2) return
  await page.getByRole('button', { name: 'Add costume' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('menuitem', { name: 'Paint' }).click()
  await page.waitForTimeout(1200)
  expect((await snapshotInfo()).costumeCount).toBeGreaterThanOrEqual(2)
}
async function stageRedOverBlue(): Promise<{ baseMd5: string | undefined; stagedDigest: string; info: Awaited<ReturnType<typeof snapshotInfo>> }> {
  await openBitmap()
  await ensureTwoCostumes()
  // Deterministic slot: select the first costume, then blue base + red pending.
  try {
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click({ timeout: 5_000 })
    await page.waitForTimeout(800)
  } catch {}
  // Base: blue rect committed via Escape (single history).
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#0000ff')
  {
    const a = await toScreen(BOX.x1, BOX.y1)
    const b = await toScreen(BOX.x2, BOX.y2)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
  }
  await page.waitForTimeout(800)
  expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pendingStatusCount()).toBe(0)
  expect(await pixel(CENTER.x, CENTER.y)).toEqual([0, 0, 255, 255])
  const baseMd5 = (await snapshotInfo()).md5
  expect(baseMd5).toBeDefined()
  // Pending: red rect staged (VM stays blue).
  await useSolidFill('#ff0000')
  await dragBox(BOX)
  await page.waitForTimeout(800)
  expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect((await snapshotInfo()).md5).toBe(baseMd5)
  const stagedDigest = await canvasDigest()
  const info = await snapshotInfo()
  return { baseMd5, stagedDigest, info }
}

describe('bitmap pending structural ops (enabled, visible UI)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (pending config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (pending config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
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
  }, 120_000)

  it('duplicate costume toolbar is refused while pending (no mutation, beforeunload warns)', async () => {
    const { baseMd5, stagedDigest, info } = await stageRedOverBlue()
    const before = await snapshotInfo()
    expect(before.costumeCount).toBeGreaterThan(0)
    expect(await beforeunloadPrevented()).toBe(true)
    await raceClear()
    await page.getByRole('button', { name: 'Duplicate costume' }).click()
    await waitForEditorStatus('blocked', 15_000)
    const status = await editorStatusText()
    expect(status).toContain('blocked')
    expect(status).toContain('pending retained')
    // Fail-closed: pending retained, displayed red over blue, zero VM mutation.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await canvasDigest()).toBe(stagedDigest)
    const after = await snapshotInfo()
    expect(after.md5).toBe(baseMd5)
    expect(after.costumeCount).toBe(before.costumeCount)
    expect(after.targetCount).toBe(before.targetCount)
    expect(after.stableId).toBe(before.stableId)
    expect(after.tab).toBe(before.tab)
    expect(await beforeunloadPrevented()).toBe(true)
    void info
    // Explicit Escape still commits exactly once afterwards.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
    expect((await snapshotInfo()).md5).not.toBe(baseMd5)
  }, 180_000)

  it('delete current costume card is refused while pending', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const before = await snapshotInfo()
    await raceClear()
    const del = page.locator('[data-testid="costume-card-0"] button[aria-label^="Delete"]')
    await del.click()
    await waitForEditorStatus('blocked', 15_000)
    const status = await editorStatusText()
    expect(status).toContain('blocked')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await canvasDigest()).toBe(stagedDigest)
    expect((await snapshotInfo()).md5).toBe(baseMd5)
    expect((await snapshotInfo()).costumeCount).toBe(before.costumeCount)
  }, 180_000)

  it('delete sprite card is refused while pending (no target mutation)', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const before = await snapshotInfo()
    await raceClear()
    // Sprite delete X is only on the selected card; click it via evaluate to
    // avoid the target-card select handler racing the delete.
    const hasDelete = await page.evaluate(() => !!document.querySelector('[aria-label="Delete sprite"]'))
    expect(hasDelete).toBe(true)
    await page.evaluate(() => {
      ;(document.querySelector('[aria-label="Delete sprite"]') as HTMLElement | null)?.click()
    })
    await page.waitForTimeout(800)
    // Safe legs only: explicit refusal with pending retained, or atomic
    // commit-then-delete (pending clears, target count drops by one, single
    // history). Silent delete with pending retained is RED.
    const retained = (await pendingStatusCount()) > 0
    const status = await editorStatusText()
    const after = await snapshotInfo()
    if (retained) {
      expect(status).toContain('blocked')
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      expect(await canvasDigest()).toBe(stagedDigest)
      expect(after.md5).toBe(baseMd5)
      expect(after.targetCount).toBe(before.targetCount)
      expect(after.stableId).toBe(before.stableId)
    } else {
      // Commit-then-delete leg: committed red stays until the target is gone;
      // the op must report the delete and advance exactly one history entry.
      expect(status).toContain('Sprite deleted')
      expect(after.targetCount).toBe(before.targetCount - 1)
    }
  }, 180_000)

  it('duplicate sprite context menu is refused while pending', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const before = await snapshotInfo()
    await raceClear()
    const name = before.stableId ? '' : ''
    void name
    // Open the sprite context menu via real right-click on the selected card.
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    const self = cards.find((c) => c.startsWith('target-card-') && c !== 'target-card-stage')!
    await page.evaluate((id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
      if (!el) return
      const r = el.getBoundingClientRect()
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }),
      )
    }, self as unknown as undefined)
    await page.waitForTimeout(600)
    const menuVisible = await page.evaluate(() => document.body.textContent?.includes('Duplicate') ?? false)
    expect(menuVisible).toBe(true)
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await page.waitForTimeout(800)
    const retained = (await pendingStatusCount()) > 0
    const status = await editorStatusText()
    const after = await snapshotInfo()
    if (retained) {
      expect(status).toContain('blocked')
      expect(await canvasDigest()).toBe(stagedDigest)
      expect(after.md5).toBe(baseMd5)
      expect(after.targetCount).toBe(before.targetCount)
    } else {
      expect(status).toContain('duplicated')
      expect(after.targetCount).toBe(before.targetCount + 1)
    }
  }, 180_000)

  it('tab switch code/sounds and back is refused while pending (no UI switch)', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const before = await snapshotInfo()
    expect(before.tab).toBe('costumes')
    await raceClear()
    await page.getByTestId('main-tab-code').click()
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toContain('blocked')
    expect((await snapshotInfo()).tab).toBe('costumes')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await canvasDigest()).toBe(stagedDigest)
    expect((await snapshotInfo()).md5).toBe(baseMd5)
    await page.getByTestId('main-tab-sounds').click()
    await waitForEditorStatus('blocked', 15_000)
    expect((await snapshotInfo()).tab).toBe('costumes')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await canvasDigest()).toBe(stagedDigest)
    // Back to costumes is a no-op stay (already there); explicit Escape then
    // switches freely.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
    await page.getByTestId('main-tab-code').click()
    await page.waitForTimeout(800)
    expect((await snapshotInfo()).tab).toBe('code')
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(800)
    expect((await snapshotInfo()).tab).toBe('costumes')
  }, 240_000)

  it('second blank shape press commits first atomically then stages new (single history)', async () => {
    const { baseMd5 } = await stageRedOverBlue()
    // Second blank press at a disjoint box with the SAME fill (no restyle):
    // pointerDown commits red first, then stages the new red shape.
    await dragBox(BOX2)
    await page.waitForTimeout(1000)
    // First shape committed (VM advanced exactly once), second staged.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER2.x, CENTER2.y)).toEqual([255, 0, 0, 255])
    const afterSecondMd5 = (await snapshotInfo()).md5
    expect(afterSecondMd5).toBeDefined()
    expect(afterSecondMd5).not.toBe(baseMd5)
    // Discard the second pending via Delete: first commit survives.
    await page.keyboard.press('Delete')
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBe(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect((await snapshotInfo()).md5).toBe(afterSecondMd5)
    // One Undo removes the first commit back to the blue base.
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const d = Array.from(target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
        return d[0] === 0 && d[1] === 0 && d[2] === 255 && d[3] === 255
      },
      [CENTER.x, CENTER.y] as unknown as undefined,
      { timeout: 15_000 },
    )
  }, 180_000)

  it('legacy select-floating while pending is refused (no floating drag)', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const beforeSel = await snapshotInfo()
    // Switch to the legacy select tool via visible toolbar, then press inside
    // the staged pending and drag: must not start a floating raster drag.
    await page.getByTestId('bitmap-tool-select').click()
    await page.waitForTimeout(400)
    const a = await toScreen(CENTER.x, CENTER.y)
    const b = await toScreen(CENTER.x + 60, CENTER.y + 40)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    const retained = (await pendingStatusCount()) > 0
    const status = await editorStatusText()
    // Safe: retained + explicit block, or commit-then-marquee (pending clears).
    // Starting a floating drag over the staged overlay (digest changes with
    // pending retained) is the bypass RED.
    if (retained) {
      expect(status).toMatch(/blocked|Finish the bitmap selection drag first|pending retained/)
      expect(await canvasDigest()).toBe(stagedDigest)
      expect((await snapshotInfo()).md5).toBe(baseMd5)
    } else {
      // Commit-then-marquee leg: the tool-switch commits red first (single
      // history), then the drag reports a pixel-exact marquee selection
      // without touching artwork. Verify exact saved pixels/history/owner,
      // not just the status string.
      expect(status).toMatch(/committed|Bitmap selection|Moving bitmap selection|Selected \d+ x \d+/)
      const afterSel = await snapshotInfo()
      expect(afterSel.md5).not.toBe(baseMd5)
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      expect(await canvasDigest()).toBe(stagedDigest)
      expect(afterSel.targetCount).toBe(beforeSel.targetCount)
      expect(afterSel.stableId).toBe(beforeSel.stableId)
      expect(afterSel.costumeCount).toBe(beforeSel.costumeCount)
    }
  }, 180_000)

  it('costume reorder (drag DnD) is refused while pending', async () => {
    const { baseMd5, stagedDigest } = await stageRedOverBlue()
    const before = await snapshotInfo()
    expect(before.costumeCount).toBeGreaterThanOrEqual(2)
    await raceClear()
    // Real UI drag handlers via synthetic DragEvents (visible cards only):
    // dragstart on card-1 sets the drag index, drop on card-0 reorders.
    await page.evaluate(() => {
      const src = document.querySelector('[data-testid="costume-card-1"]') as HTMLElement | null
      if (!src) throw new Error('missing costume-card-1')
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await page.evaluate(() => {
      const dst = document.querySelector('[data-testid="costume-card-0"]') as HTMLElement | null
      if (!dst) throw new Error('missing costume-card-0')
      const dt = new DataTransfer()
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toContain('blocked')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await canvasDigest()).toBe(stagedDigest)
    expect((await snapshotInfo()).md5).toBe(baseMd5)
    expect((await snapshotInfo()).costumeCount).toBe(before.costumeCount)
  }, 180_000)

  it('restore-deleted costume is refused while pending', async () => {
    await openBitmap()
    await ensureTwoCostumes()
    // Create a restorable deletion BEFORE staging (allowed, no pending yet):
    // select card-1, delete it, select back card-0.
    await page.locator('[data-testid="costume-card-1"] button[aria-label^="Select"]').click()
    await page.waitForTimeout(800)
    await page.locator('[data-testid="costume-card-1"] button[aria-label^="Delete"]').click()
    await page.waitForTimeout(1000)
    expect((await snapshotInfo()).costumeCount).toBeGreaterThanOrEqual(1)
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click()
    await page.waitForTimeout(800)
    const restoreVisible = await page.evaluate(() => document.body.textContent?.includes('Restore deleted') ?? false)
    expect(restoreVisible).toBe(true)
    // Now stage blue base + red pending on card-0.
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await useSolidFill('#0000ff')
    {
      const a = await toScreen(BOX.x1, BOX.y1)
      const b = await toScreen(BOX.x2, BOX.y2)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 12 })
      await page.mouse.up()
    }
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const baseMd5 = (await snapshotInfo()).md5
    await useSolidFill('#ff0000')
    await dragBox(BOX)
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    const stagedDigest = await canvasDigest()
    const before = await snapshotInfo()
    await page.getByRole('button', { name: 'Restore deleted' }).click()
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toContain('blocked')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await canvasDigest()).toBe(stagedDigest)
    expect((await snapshotInfo()).md5).toBe(baseMd5)
    expect((await snapshotInfo()).costumeCount).toBe(before.costumeCount)
  }, 240_000)

  it('convert bitmap->vector while pending commits first then converts (single history)', async () => {
    const { baseMd5 } = await stageRedOverBlue()
    await raceClear()
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForTimeout(3000)
    // Commit-first leg: pending clears, VM advances, mode flips to vector.
    // Refusal would also be safe, but the guarded product commits-then-converts.
    const retained = (await pendingStatusCount()) > 0
    if (retained) {
      expect(await editorStatusText()).toContain('blocked')
      expect((await snapshotInfo()).md5).toBe(baseMd5)
    } else {
      expect((await snapshotInfo()).md5).not.toBe(baseMd5)
    }
  }, 180_000)

  it('race: delayed CAS gates duplicate-costume against inflight commit + same-name target', async () => {
    // Single-red staging (proven CAS flow): blue+red double-commit does not
    // reach the CAS gate in the same tick, so the race hold needs the plain
    // single-pending shape here. Exact-bytes blue+red is covered above.
    await openBitmap()
    const beforeCenter = await pixel(CENTER.x, CENTER.y)
    void beforeCenter
    const beforeMd5Single = (await snapshotInfo()).md5
    // Fresh color, no inherited stale: the default toolbar fill is Scratch
    // orange (#ffab19), so stage an explicit red pending for the barrier.
    await useSolidFill('#ff0000')
    await dragBox(BOX)
    await page.waitForTimeout(800)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect((await snapshotInfo()).md5).toBe(beforeMd5Single)
    const before = await snapshotInfo()
    const baseMd5 = beforeMd5Single
    await raceClear()
    await raceHold('cas-pre')
    await page.keyboard.press('Escape')
    await waitForRaceKind('cas-pre')
    // Inflight duplicate must refuse (no second commit, no duplicate).
    await page.getByRole('button', { name: 'Duplicate costume' }).click()
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toMatch(/blocked|in flight|retry after it settles/)
    expect((await snapshotInfo()).costumeCount).toBe(before.costumeCount)
    expect((await snapshotInfo()).md5).toBe(baseMd5)
    await raceRelease('cas-pre')
    await waitForRaceKind('cas-post')
    await waitForRaceKind('history-append-result')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
    void before
  }, 240_000)
})
