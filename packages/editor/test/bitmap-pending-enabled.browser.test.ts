// Fail-first E2E for the bitmap pending UI, enabled IN MEMORY ONLY.
//
// Instrumentation (no production edits, no env/query bypass):
// - Test server uses `test/vite.bitmap-pending.config.ts`, which adds
//   `vite-bitmap-pending-enabled-plugin.ts` to the base Vite config.
// - The plugin replaces ONLY
//     `export const BITMAP_PENDING_UI_ENABLED = false as const`
//   with `true` during transform (single expected replacement, throws
//   otherwise). HMR/watch are OFF (`server.watch: null`, `hmr: false`).
// - On-disk `bitmap-pending-controller.ts` still contains `false` before+after
//   (asserted here). The source contains no localStorage/sessionStorage/
//   URLSearchParams/location/import.meta.env/process.env bypass (asserted).
// - Real Editor entry (`/` -> App.svelte) is used, same as
//   `bitmap-pending-disabled.browser.test.ts`; no synthetic canvas.
//
// Coverage (fail-first: unsafe expectations stay RED where product is
// incomplete; do NOT weaken or delete them):
// - rect stages/restyle/release/Escape + displayed/VM bytes + single history
// - target/costume UI switch preflight exact state + retention
// - production-constructor external switch leg (real VM + detached canvas):
//   no data loss, quarantine export, new canvas nonblank, zero VM writes
// - copy/cut/flip/crop + other ops: no stale reads (commit-first or blocked)
// - beforeunload genuine warning state (synthetic event mock)
// - static guard audit: which Editor commands route through the pending gates
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-enabled.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4691
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
      `[bitmap-pending-enabled] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run (accidental flip?)`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[bitmap-pending-enabled] on-disk bypass check (${stage}): controller source must not contain ${JSON.stringify(token)}`,
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
      const sel = selId(targets, snap?.selectedTargetId)
      const idx = sel?.currentCostume ?? 0
      return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
      function selId(
        list: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }>,
        want: string | undefined,
      ) {
        return (
          list.find((t) => t.id === want) ??
          list.find((t) => !t.isStage) ??
          list[0]
        )
      }
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

async function selectedStableId(): Promise<string> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string } } }).__hikkakuEditorTest
      return api?.snapshot()?.selectedTargetId ?? ''
    } catch {
      return ''
    }
  })
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
  throw new Error(`waitForRaceKind timeout waiting for ${JSON.stringify(kind)}, got ${JSON.stringify(await raceKinds())}`)
}

async function waitForEditorStatus(fragment: string, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await editorStatusText()).includes(fragment)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForEditorStatus timeout waiting for ${JSON.stringify(fragment)}, got ${JSON.stringify(await editorStatusText())}`)
}

async function waitForStatus(text: string, timeout = 15_000) {
  await page.waitForFunction((want) => document.body.textContent?.includes(want as string) ?? false, text as unknown as undefined, {
    timeout,
  })
}

async function waitForStableDigest(tries = 10): Promise<string> {
  let last = await canvasDigest()
  for (let i = 0; i < tries; i += 1) {
    await page.waitForTimeout(400)
    const next = await canvasDigest()
    if (next === last) return next
    last = next
  }
  return last
}

function isNonBlankDigest(digest: string): boolean {
  // Nonblank = not every pixel identical (a fresh/preserved painting has
  // varied bytes; a wiped canvas would be a single repeated pixel value).
  const parts = digest.split(',')
  const first = `${parts[0]},${parts[1]},${parts[2]},${parts[3]}`
  for (let i = 4; i < parts.length; i += 4) {
    if (`${parts[i]},${parts[i + 1]},${parts[i + 2]},${parts[i + 3]}` !== first) return true
  }
  return false
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

async function stagePendingRect(): Promise<{ beforeCenter: number[]; beforeMd5: string | undefined }> {
  await openBitmap()
  const beforeCenter = await pixel(CENTER.x, CENTER.y)
  const beforeMd5 = await vmCostumeMd5()
  await dragRect()
  await page.waitForTimeout(800)
  return { beforeCenter, beforeMd5 }
}

describe('bitmap pending enabled E2E (vite transform only)', () => {
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

  it('instrumentation: on-disk flag stays false, in-page flag is true, no env/query bypass', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    // Query strings must not be a second enable path: the transform is the
    // sole mechanism, so an explicit disabling-looking query still serves true.
    await page.goto(`${base}/?bitmap-pending=0`, { waitUntil: 'networkidle' })
    const inPageQuery = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPageQuery).toBe(true)
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
    console.log('[pending-enabled:instrumentation] on-disk=false ok, in-page=true ok, query-no-bypass ok')
  }, 120_000)

  it('rect stages pending: displayed shows staged, VM unchanged, pending status visible', async () => {
    const { beforeMd5 } = await stagePendingRect()
    // Displayed canvas shows the staged red rect immediately (base + shape).
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Pending UI owns the selection outline while staged.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    // VM bytes are NOT written until the explicit commit (Escape/tool-switch).
    // Fail-first: an immediate-raster product writes here and goes RED.
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    console.log(`[pending-enabled:stage] displayed=red ok, vmUnchanged=${(await vmCostumeMd5()) === beforeMd5}`)
  }, 180_000)

  it('Escape commits the staged rect exactly once: VM lands, single Undo restores', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const stagedMd5 = await vmCostumeMd5()
    expect(stagedMd5).toBe(beforeMd5)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    // Committed: displayed stays red AND the VM identity advances exactly once.
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    // Pending UI clears after the commit; tool stays armed.
    expect(await pendingStatusCount()).toBe(0)
    // Exactly one Undo restores the pre-drag raster (no duplicate entries).
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
    console.log('[pending-enabled:escape-commit] committed once, single-undo restores')
  }, 180_000)

  it('restyle after mouseUp updates the staged shape with no new history entry', async () => {
    const { beforeCenter } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Reference parity: the mouseUp shape is still parametric, so changing the
    // fill restyles it in place (no raster commit, no new history entry).
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
    // No new history for the restyle: one Undo returns to pre-drag.
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
    console.log('[pending-enabled:restyle] in-place restyle ok, single-undo restores')
  }, 180_000)

  it('target switch preflight: fail-closed refusal while pending/inflight, switch allowed after Escape', async () => {
    // Pending refusal leg: stable identity + pixels prove fail-closed.
    const { beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const stagedDigest = await canvasDigest()
    const stableBefore = await selectedStableId()
    expect(stableBefore.length).toBeGreaterThan(0)
    await raceClear()
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
    await waitForEditorStatus('select-target blocked')
    const blockedStatus = await editorStatusText()
    expect(blockedStatus).toContain('select-target blocked')
    expect(blockedStatus).toContain('press Escape to commit')
    // Fail-closed: stable target remains, pending UI retained, zero VM/asset/history.
    expect(await selectedStableId()).toBe(stableBefore)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await canvasDigest()).toBe(stagedDigest)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(await raceKinds()).toContain('select-target-request')
    expect(await raceKinds()).not.toContain('select-target-proceed')
    expect(await raceKinds()).not.toContain('history-append-attempt')
    expect(await page.getByTestId('costume-paint-surface').isVisible()).toBe(true)
    expect(isNonBlankDigest(await canvasDigest())).toBe(true)
    console.log(`[pending-enabled:target-switch-pending] blocked ok, identity stable, pixels retained`)
    // Switch allowed after explicit Escape commit.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await raceClear()
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.waitForTimeout(1200)
    expect(await selectedStableId()).not.toBe(stableBefore)
    expect(await raceKinds()).toContain('select-target-proceed')
    console.log(`[pending-enabled:target-switch-escape] retry after commit proceeds`)
    // Inflight refusal leg: hold the CAS, Escape starts the flight, switch mid-flight refuses.
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, current as unknown as undefined)
    await page.waitForTimeout(1200)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
    const restaged = await stagePendingRect()
    void restaged
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const inflightStable = await selectedStableId()
    await raceClear()
    await raceHold('cas-pre')
    await page.keyboard.press('Escape')
    await waitForRaceKind('cas-pre')
    const inflightCards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    const inflightOther = inflightCards.find((c) => c !== inflightCards[0])!
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, inflightOther as unknown as undefined)
    await waitForEditorStatus('blocked')
    const inflightStatus = await editorStatusText()
    expect(inflightStatus).toContain('select-target blocked')
    expect(inflightStatus).toContain('retry after it settles')
    expect(await selectedStableId()).toBe(inflightStable)
    expect(await raceKinds()).toContain('select-target-request')
    expect(await raceKinds()).not.toContain('select-target-proceed')
    console.log(`[pending-enabled:target-switch-inflight] blocked ok, identity stable`)
    await raceRelease('cas-pre')
    await waitForRaceKind('cas-post')
    await waitForRaceKind('history-append-result')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
  }, 240_000)

  it('costume reselect (same-id reload) preflight: fail-closed refusal, Delete allows retry', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const stagedDigest = await canvasDigest()
    const stableBefore = await selectedStableId()
    expect(stableBefore.length).toBeGreaterThan(0)
    await raceClear()
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click()
    await waitForEditorStatus('select-costume blocked')
    const blockedStatus = await editorStatusText()
    expect(blockedStatus).toContain('select-costume blocked')
    expect(blockedStatus).toContain('press Escape to commit')
    // Fail-closed: stable costume remains, pending UI retained, zero VM/asset/history.
    expect(await selectedStableId()).toBe(stableBefore)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await canvasDigest()).toBe(stagedDigest)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    expect(isNonBlankDigest(await waitForStableDigest())).toBe(true)
    expect(await raceKinds()).toContain('select-costume-request')
    expect(await raceKinds()).not.toContain('select-costume-proceed')
    expect(await raceKinds()).not.toContain('history-append-attempt')
    console.log(`[pending-enabled:costume-reselect] blocked ok, identity stable, pixels retained`)
    // Switch allowed after explicit Delete discard (no history for the discard).
    await page.keyboard.press('Delete')
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBe(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual(beforeCenter)
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    await raceClear()
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click()
    await page.waitForTimeout(800)
    expect(await raceKinds()).toContain('select-costume-proceed')
    expect(await pendingStatusCount()).toBe(0)
    expect(await editorStatusText()).toContain('Costume selected')
    console.log(`[pending-enabled:costume-reselect-delete] retry after discard proceeds`)
  }, 180_000)

  it('production constructor external switch leg: retained off-canvas, exportable, zero VM writes', async () => {
    await page.goto(base, { waitUntil: 'networkidle' })
    const proof = await page.evaluate(async () => {
      const controllerMod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      const vmMod = await import('/test/bitmap-pending-session-vm-entry.ts')
      const W = 120
      const H = 90
      const freshCanvas = () => {
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#f0f0f0'
        ctx.fillRect(0, 0, W, H)
        return { canvas, ctx }
      }
      const { canvas, ctx } = freshCanvas()
      const vm = new (vmMod as unknown as { ScratchVM: new () => never }).ScratchVM()
      ;(vm as unknown as { loadProject: (p: unknown) => void }).loadProject(
        (vmMod as unknown as { createDefaultProject: () => unknown }).createDefaultProject(),
      )
      const api = vm as unknown as {
        getSprites: () => { id: string }[]
        getTarget: (id: string) => { costumes: { md5ext?: string }[] } | undefined
        addSprite: (n: string) => Promise<{ id?: string }>
        selectTarget: (id: string) => void
        updateCostumeIfMatch: (...a: unknown[]) => Promise<unknown>
        storeAsset: (d: Uint8Array, f: string) => Promise<unknown>
      }
      const tid = api.getSprites()[0].id
      const md5Before = api.getTarget(tid)?.costumes[0]?.md5ext
      // Production constructor (NOT the test factory): enabled in memory by
      // the transform, so this is the real product path.
      const controller = new (controllerMod as unknown as {
        BitmapPendingController: new (
          vm: unknown,
          cb: unknown,
        ) => {
          ensure: (slot: unknown, canvas: unknown) => unknown
          hasRecovery: () => boolean
          hasUnsavedState: () => boolean
          exportRecoveryPng: () => Promise<Uint8Array | undefined>
        }
      }).BitmapPendingController(vm as never, {
        onSelection: () => {},
        onStatus: () => {},
        peekHistory: async () => undefined,
        commitHistory: () => false,
        historyDepth: () => 0,
        historyIsCurrent: () => true,
        readConfig: () => ({}),
      })
      const slotA = { targetId: tid, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      const staged = controller.ensure(slotA, canvas) as unknown as {
        pointerDown: (at: unknown, k: string, m: string, s: unknown) => Promise<unknown>
        pointerUp: (at: unknown) => Promise<unknown>
      }
      if (!staged) throw new Error('no session (transform active?)')
      await staged.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', {
        fill: '#ff0000', secondary: '#ffffff', gradient: 'solid',
        fillTransparent: false, secondaryTransparent: false, brushSize: 6,
      })
      await staged.pointerUp({ x: 100, y: 75 })
      const stagedRed = Array.from(ctx.getImageData(60, 45, 1, 1).data).join(',') === '255,0,0,255'
      // External direct VM switch OUTSIDE the controller + reloader repaint.
      const newcomer = await api.addSprite('SpriteB')
      const spriteB = (newcomer.id ?? '') as string
      api.selectTarget(spriteB)
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(7, 7, 1, 1)
      const liveBefore = Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
      const slotB = { targetId: spriteB, costumeIndex: 0, loadSerial: 1, sessionGeneration: 1 }
      let writes = 0
      const target = vm as unknown as Record<string, unknown>
      const origStore = target['storeAsset']
      const origCas = target['updateCostumeIfMatch']
      if (typeof origStore === 'function') {
        target['storeAsset'] = async (...a: unknown[]) => {
          writes += 1
          return (origStore as (...a: unknown[]) => Promise<unknown>).apply(vm, a)
        }
      }
      if (typeof origCas === 'function') {
        target['updateCostumeIfMatch'] = async (...a: unknown[]) => {
          writes += 1
          return (origCas as (...a: unknown[]) => Promise<unknown>).apply(vm, a)
        }
      }
      const next = controller.ensure(slotB, canvas)
      const liveAfter = Array.from(ctx.getImageData(0, 0, W, H).data).join(',')
      const exported = await controller.exportRecoveryPng()
      if (typeof origStore === 'function') target['storeAsset'] = origStore
      if (typeof origCas === 'function') target['updateCostumeIfMatch'] = origCas
      let center: number[] | undefined
      if (exported && exported.byteLength > 0) {
        try {
          const bmp = await createImageBitmap(new Blob([exported as unknown as BlobPart], { type: 'image/png' }))
          const off = document.createElement('canvas')
          off.width = bmp.width
          off.height = bmp.height
          const octx = off.getContext('2d')!
          octx.drawImage(bmp, 0, 0)
          center = Array.from(octx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data)
        } catch {}
      }
      return {
        stagedRed, nextUndefined: next === undefined,
        hasRecovery: controller.hasRecovery(), unsaved: controller.hasUnsavedState(),
        liveUnchanged: liveBefore === liveAfter,
        exportedLen: exported?.byteLength ?? 0, exportedCenter: center, writes,
        md5Stable: api.getTarget(tid)?.costumes[0]?.md5ext === md5Before,
      }
    })
    console.log(`[pending-enabled:external-leg] ${JSON.stringify(proof)}`)
    expect(proof.stagedRed).toBe(true)
    expect(proof.nextUndefined).toBe(true)
    expect(proof.hasRecovery).toBe(true)
    expect(proof.unsaved).toBe(true)
    expect(proof.liveUnchanged).toBe(true)
    expect(proof.exportedLen as number).toBeGreaterThan(0)
    expect(proof.exportedCenter).toEqual([255, 0, 0, 255])
    expect(proof.writes).toBe(0)
    expect(proof.md5Stable).toBe(true)
  }, 120_000)

  it('copy while pending is commit-first or blocked (fail-first: stale read stays RED)', async () => {
    await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Ctrl/Cmd+C with a staged pending must NOT silently copy the
    // uncommitted overlay: commit-first (pending clears, VM advances) or an
    // explicit block. A plain `Bitmap selection copied` with the pending
    // still staged is the stale-read bug.
    await page.keyboard.press('ControlOrMeta+c')
    await page.waitForTimeout(1000)
    const status = await page.evaluate(() => document.body.textContent ?? '')
    const retained = (await pendingStatusCount()) > 0
    const md5After = await vmCostumeMd5()
    console.log(`[pending-enabled:copy] retained=${retained} statusHasCopied=${status.includes('Bitmap selection copied')}`)
    // Safe outcomes only: commit-then-copy (pending clears, copy proceeds on
    // committed bytes) or an explicit block/refusal with pending retained.
    // Copying the staged overlay while it stays pending is the stale-read bug.
    // Fail-first: product currently copies the staged overlay and stays RED.
    const committedCopy = !retained && status.includes('Bitmap selection copied')
    const blockedCopy = retained && (status.includes('blocked') || status.includes('pending retained') || status.includes('refused'))
    expect(committedCopy || blockedCopy).toBe(true)
    void md5After
  }, 120_000)

  it('cut while pending is blocked before any state mutation (no silent loss, no false cut)', async () => {
    const { beforeCenter, beforeMd5 } = await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    const stagedDigest = await canvasDigest()
    const editorStatus = () =>
      page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? '')
    await page.keyboard.press('ControlOrMeta+x')
    // The refusal must surface promptly as the exact editor status (not a
    // body-text substring, so an unrelated 'cut' string cannot false-pass).
    await page.waitForFunction(() => {
      const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
      return (w.__hikkakuEditorTest?.status() ?? '').includes('Bitmap cut blocked')
    }, undefined as unknown as undefined, { timeout: 15_000 })
    const status = await editorStatus()
    expect(status).toContain('Bitmap cut blocked')
    expect(status).toContain('pending retained')
    // No false pass: the success literal must NOT appear when nothing was cut.
    expect(status).not.toContain('Bitmap selection cut')
    // Pending retained with the staged overlay intact and zero VM mutation:
    // the block happens before the commit gate, so no history entry lands.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await selectionCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await vmCostumeMd5()).toBe(beforeMd5)
    // Clipboard preserved (side-effect-free proof): this test performed no
    // copy on the fresh page, so both clipboards start empty. A blocked cut
    // that secretly staged bytes would enable the paste buttons; they must
    // stay disabled here. This inspects the in-memory clipboard via real UI
    // without pressing Ctrl+V while still in rect (that shortcut first flips
    // bitmapTool rect->select and deliberately auto-commits the pending via
    // the paint-tool-switch gate, clearing the status — proven deliberate
    // product behavior, not clipboard proof — so it is verified separately
    // after the explicit Escape below).
    expect(await page.getByTestId('paste-costume-selection').isDisabled()).toBe(true)
    expect(await page.getByTestId('legacy-paste-costume-selection').isDisabled()).toBe(true)
    expect(await canvasDigest()).toBe(stagedDigest)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    // The retained pending stays healthy: Escape still commits exactly once.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const committedMd5 = await vmCostumeMd5()
    expect(committedMd5).toBeDefined()
    expect(committedMd5).not.toBe(beforeMd5)
    expect(await pendingStatusCount()).toBe(0)
    // Empty-clipboard paste after the explicit commit is a silent no-op:
    // digest and VM identity are unchanged (no hidden clipboard write from
    // the earlier blocked cut), and the pending stays cleared.
    const committedDigest = await canvasDigest()
    await page.keyboard.press('ControlOrMeta+v')
    await page.waitForTimeout(800)
    expect(await canvasDigest()).toBe(committedDigest)
    expect(await vmCostumeMd5()).toBe(committedMd5)
    expect(await pendingStatusCount()).toBe(0)
    // Exactly one Undo restores the pre-drag raster AND the VM identity (the
    // blocked cut added no history entry: a hidden commit would need two
    // Undos to reach the original here).
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
    console.log('[pending-enabled:cut] blocked-before-mutation ok, retained, clipboard preserved, single-undo restores')
  }, 180_000)

  it('flip while pending is commit-first or blocked (fail-first: stale flip stays RED)', async () => {
    await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await page.getByTestId('flip-bitmap-horizontal').click()
    await page.waitForTimeout(1000)
    const retained = (await pendingStatusCount()) > 0
    const status = await page.evaluate(() => document.body.textContent ?? '')
    console.log(`[pending-enabled:flip] retained=${retained} flipped=${status.includes('flipped horizontally')}`)
    // Safe: pending committed (clears) before the flip, or the flip refused
    // with the pending retained + an explicit blocked status. Flipping the
    // staged overlay while it stays pending is stale.
    const committedFlip = !retained && status.includes('flipped horizontally')
    const blockedFlip = retained && (status.includes('blocked') || status.includes('pending retained'))
    expect(committedFlip || blockedFlip).toBe(true)
  }, 120_000)

  it('delete/undo discards the staged pending with no history (should pass)', async () => {
    await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await page.keyboard.press('Delete')
    await page.waitForTimeout(800)
    // Discard-first: the staged shape is dropped, base restored, no history.
    expect(await pendingStatusCount()).toBe(0)
    console.log('[pending-enabled:delete] discard ok')
    // Re-stage, then Undo discards as well.
    await dragRect()
    await page.waitForTimeout(800)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBe(0)
    console.log('[pending-enabled:undo-discard] discard ok')
  }, 180_000)

  it('beforeunload warns while pending is staged (fail-first: silent close stays RED)', async () => {
    await stagePendingRect()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // Genuine close path: a cancelable beforeunload must be prevented while
    // unsaved pending work exists (unit/event mock: jsdom/Chrome suppresses
    // the real dialog, so assert the preventDefault signal instead).
    const prevented = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
      try {
        ;(event as unknown as { returnValue: unknown }).returnValue = true
      } catch {}
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    console.log(`[pending-enabled:beforeunload] prevented=${prevented}`)
    // Enabled Editor wires hasUnsavedState (staging/quarantine/history-gap)
    // -> preventDefault().
    expect(prevented).toBe(true)
    // After commit there is no unsaved state: the same event must NOT be
    // prevented (no sticky dialog). Quarantine-pending still prevents (unit
    // hostile suite asserts hasUnsavedState for the quarantined leg).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pendingStatusCount()).toBe(0)
    const preventedAfterCommit = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    console.log(`[pending-enabled:beforeunload] preventedAfterCommit=${preventedAfterCommit}`)
    expect(preventedAfterCommit).toBe(false)
    // Disabled path stays silent: the handler early-returns when the flag is
    // false (static guard; the in-page transform keeps the flag true here).
    const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(editorSource).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
  }, 120_000)

  it('static guard audit: crop/clear/paste/convert/export routes are commit-first, select routes are fail-closed (fail-first table)', async () => {
    const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    const guarded = (command: string): boolean =>
      editorSource.includes(`guardBitmapPendingCommitFirst('${command}')`)
    // Bounded function-body extraction: proves the gate lives inside the
    // named Editor function (not a dead literal elsewhere). Brace-balanced,
    // capped at 40k chars so an unterminated scan cannot swallow the file.
    function fnBody(source: string, needle: string): string {
      const start = source.indexOf(needle)
      if (start === -1) return ''
      const open = source.indexOf('{', start)
      if (open === -1) return ''
      let depth = 1
      let i = open + 1
      const limit = Math.min(source.length, open + 40_000)
      while (i < limit && depth > 0) {
        const ch = source[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
        i += 1
      }
      return source.slice(start, i)
    }
    // First-class safe gate for select-target/select-costume: either the
    // legacy commit-first call inside the function, or the proven fail-closed
    // refusal (pending+inflight checked, explicit blocked status with both
    // Escape/Delete and settle hints, return before the VM mutation, no
    // commit on the refusal path, disabled-tolerant). Generic file-wide
    // `includes('blocked')` alone would false-pass; ordering inside the
    // function body is required.
    function isSafeSelectGate(fnNeedle: string, command: string, vmCall: string): boolean {
      const body = fnBody(editorSource, fnNeedle)
      if (!body) return false
      if (body.includes(`guardBitmapPendingCommitFirst('${command}')`)) return true
      const checksBoth = body.includes('hasPending') && body.includes('commitInFlight') && body.includes('||')
      const blockedIdx = body.indexOf(`${command} blocked`)
      if (blockedIdx === -1) return false
      const hasPendingHint = body.includes('press Escape to commit')
      const hasInflightHint = body.includes('retry after it settles')
      const returnIdx = body.indexOf('return', blockedIdx)
      const vmIdx = body.indexOf(vmCall, returnIdx === -1 ? 0 : returnIdx)
      const ordered = returnIdx !== -1 && vmIdx !== -1 && blockedIdx < returnIdx && returnIdx < vmIdx
      const noCommitBeforeVm = returnIdx !== -1 && vmIdx !== -1 && !body.slice(0, vmIdx).includes('commitPending(')
      const toleratesDisabled = body.includes('if (pendingSession)')
      return checksBoth && hasPendingHint && hasInflightHint && ordered && noCommitBeforeVm && toleratesDisabled
    }
    const table: Record<string, boolean> = {
      // Currently wired (should stay green).
      'export-project': guarded('export-project'),
      'load-project': guarded('load-project'),
      // Paint ops: commit-first per preflight; unguarded ones stay RED.
      'paint-copy': guarded('paint-copy'),
      'paint-cut': guarded('paint-cut'),
      'paint-paste': guarded('paint-paste'),
      'paint-crop': guarded('paint-crop'),
      'paint-flip': guarded('paint-flip'),
      'paint-clear': guarded('paint-clear'),
      'convert-to-bitmap': guarded('convert-to-bitmap'),
      'convert-to-vector': guarded('convert-to-vector'),
    }
    console.log(`[pending-enabled:guard-audit] ${JSON.stringify(table)}`)
    for (const [command, ok] of Object.entries(table)) {
      expect(ok).toBe(true)
    }
    // select-costume/select-target: commit-first OR proven fail-closed refusal.
    // Silent-history race fix refuses while pending/inflight (before mutation)
    // instead of committing across the switch and silently losing history.
    const costumeSafe = isSafeSelectGate('async function selectCostume(index: number)', 'select-costume', 'vm.setCurrentCostume')
    const targetSafe = isSafeSelectGate('async function guardedSelectTarget(name: string)', 'select-target', 'vm.selectTarget')
    console.log(`[pending-enabled:guard-audit-select] costumeSafe=${costumeSafe} targetSafe=${targetSafe}`)
    expect(costumeSafe).toBe(true)
    expect(targetSafe).toBe(true)
    // Disabled flag-false path still switches: the pending controller
    // early-returns undefined when the flag is false, so the select guards
    // tolerate `undefined` and fall through to the VM call (proven by the
    // disabled browser file, which switches freely).
    const ensureBody = fnBody(editorSource, 'function ensureBitmapPendingController()')
    expect(ensureBody.includes('if (!BITMAP_PENDING_UI_ENABLED)')).toBe(true)
  }, 60_000)
})
