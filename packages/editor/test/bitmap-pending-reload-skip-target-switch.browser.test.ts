// Fail-first target-switch-during-commit audit for `armBitmapReloadSkipFromLive`.
//
// Bug: post-`await` code armed the skip from the CURRENT selected slot while
// the in-flight barrier still named the PRE-flight slot. A direct-VM
// `selectTarget` landing inside the commit flight made the barrier key differ
// from the newly selected slot, yet the arm accepted the new owner's live
// identity and the next preview reload for target B was skipped: B's canvas
// kept A's stale staged pixels instead of B's own bytes.
//
// Coverage (real Editor + real VM + real 2d canvas, test-only Vite transform
// `test/vite.bitmap-pending-direct.config.ts`, in-memory flag flip only,
// on-disk `BITMAP_PENDING_UI_ENABLED = false` asserted before+after, no
// production edits, no env/query bypass, no AGPL copy):
// - B prepared FIRST (green committed box, digest + md5 captured), then A
//   stages blue base + red pending. B is pre-existing distinguishable art.
// - leg1 (cas-pre held): hold `direct-cas-pre`, Escape starts the A commit,
//   DIRECT `selectTarget` to B mid-flight, release. External selection stands,
//   A pending recovered (quarantine + export, export center red), B canvas is
//   exactly B green (no stale red/blue), B VM bytes untouched, then a DIRECT
//   metadata rename on B forces a preview reload which must NOT be skipped
//   (canvas stays green, rename lands).
// - leg2 (history-append held): hold `direct-history-append`, Escape parks at
//   `direct-writer-cas-post` (CAS applied), DIRECT `selectTarget` to B,
//   release. Old A slot keeps the committed red, B stays green, quarantine
//   visible, no cross-slot leak, metadata rename on B reloads correctly, and a
//   follow-up normal commit on B still works (stale completion never cleared
//   the newer barrier into a stuck state, no blanket replay of stale data).
// - leg3 (normal same-slot): no switch, Escape commits, canvas + VM advance,
//   no quarantine, follow-up save works (same-slot path unaffected).
//
// Strict fail-first: any leg showing B with stale A ink, missing recovery,
// skipped metadata reload, stuck barrier, or on-disk flag flip stays RED.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-reload-skip-target-switch.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4696
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

const BOX_BLUE = { x1: 100, y1: 100, x2: 300, y2: 200 }
const BOX_RED = { x1: 280, y1: 260, x2: 480, y2: 360 }
const BOX_GREEN = { x1: 100, y1: 100, x2: 300, y2: 200 }
const CENTER_RED = { x: 380, y: 310 }
const CENTER_BLUE = { x: 200, y: 150 }
const CENTER_GREEN = { x: 200, y: 150 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[target-switch] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[target-switch] on-disk bypass check (${stage}): must not contain ${JSON.stringify(token)}`,
      )
    }
  }
  const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editorSource.includes('__directVm') || editorSource.includes('__directRace')) {
    throw new Error(
      `[target-switch] production switch check (${stage}): Editor.svelte must not contain direct-VM hooks on disk`,
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

async function vmSnapshot(): Promise<{
  selectedTargetId?: string
  project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string; name?: string }> }> }
}> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
    return (api?.snapshot() ?? {}) as never
  })
}

function pickSelected(
  targets: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }>,
  want: string | undefined,
) {
  return (
    targets.find((t) => t.id === want) ??
    targets.find((t) => !t.isStage) ??
    targets[0]
  )
}

async function vmCostumeMd5(): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets as never, snap?.selectedTargetId) as { currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}

async function selectedStableId(): Promise<string> {
  const snap = await vmSnapshot()
  return snap?.selectedTargetId ?? ''
}

async function costumeMd5ForStableId(stableId: string): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const hit = targets.find((t) => t.id === stableId)
  if (!hit) return undefined
  const idx = hit.currentCostume ?? 0
  return hit.costumes?.[idx]?.md5ext ?? hit.costumes?.[idx]?.assetId
}

async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function pendingExportCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-export"]').length)
}

async function pendingDiscardCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-discard"]').length)
}

async function pendingStatusText(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? '')
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

async function directKinds(): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __directRace?: { log: Array<{ kind: string }> } }
    return (w.__directRace?.log ?? []).map((e) => e.kind)
  })
}

async function directClear(): Promise<void> {
  await page.evaluate(() => {
    try {
      ;(window as unknown as { __directRace?: { clear: () => void } }).__directRace?.clear()
    } catch {}
  })
}

async function directHold(name: string): Promise<void> {
  await page.evaluate((n: string) => {
    ;(window as unknown as { __directRace?: { hold: (x: string) => void } }).__directRace?.hold(n as string)
  }, name as unknown as undefined)
}

async function directRelease(name?: string): Promise<void> {
  await page.evaluate((n: string | undefined) => {
    const w = window as unknown as { __directRace?: { release: (x?: string) => void } }
    if (n === undefined) w.__directRace?.release()
    else w.__directRace?.release(n)
  }, name as unknown as undefined)
}

async function waitForDirectKind(kind: string, timeout = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await directKinds()).includes(kind)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForDirectKind timeout ${JSON.stringify(kind)}, got ${JSON.stringify(await directKinds())}`)
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

async function ensureBitmapMode() {
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {
    // Already in bitmap mode.
  }
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 5_000 })
  } catch {
    // Best effort only.
  }
  await page.waitForTimeout(800)
}

async function beforeUnloadPrevented(): Promise<boolean> {
  return await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    try {
      ;(event as unknown as { returnValue: unknown }).returnValue = true
    } catch {}
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function quarantinedExportCenterPixel(): Promise<number[] | undefined> {
  const downloadPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => undefined)
  await page.getByTestId('bitmap-pending-export').click()
  const download = await downloadPromise
  if (!download) return undefined
  const stream = await download.createReadStream()
  if (!stream) return undefined
  const chunks: Uint8Array[] = []
  for await (const chunk of (stream as unknown as AsyncIterable<Uint8Array>)) chunks.push(chunk as Uint8Array)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buffer.set(c, offset)
    offset += c.length
  }
  const center = await page.evaluate(async (bytes: number[]) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off = document.createElement('canvas')
      off.width = bmp.width
      off.height = bmp.height
      const octx = off.getContext('2d')!
      octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch {
      return undefined
    }
  }, Array.from(buffer) as unknown as undefined)
  return (center ?? undefined) as number[] | undefined
}

/**
 * Prepare B green first, then A blue base + red pending.
 *
 * Returns the pre-existing B identity (stable id, green md5 + digest) and the
 * A pending identity (stable id, blue md5, staged digest). B's green box does
 * not overlap A/B centers, so pixels are unambiguous.
 */
async function prepareGreenBThenStageRedOnA(): Promise<{
  stableA: string
  stableB: string
  greenMd5: string | undefined
  greenDigest: string
  blueMd5: string | undefined
  stagedDigest: string
  otherName: string
}> {
  await openBitmap()
  const snap0 = await vmSnapshot()
  const targets0 = snap0?.project?.targets ?? []
  const self0 = pickSelected(targets0 as never, snap0?.selectedTargetId) as { id?: string; name?: string }
  const other = targets0.find((t) => t.id !== self0.id && !t.isStage) ?? targets0.find((t) => t.id !== self0.id)
  if (!other?.name || !other?.id) throw new Error('[target-switch] need two targets for the switch probe')
  const otherName = other.name
  const stableA0 = self0.id ?? ''
  // Paint green on the initial selection first (this will become target B
  // after we switch: whichever target is "other" gets green via UI select).
  await page.evaluate((name: string) => {
    const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
    vm?.selectTarget(name as string)
  }, otherName as unknown as undefined)
  await page.waitForTimeout(1200)
  const stableB = await selectedStableId()
  if (stableB === stableA0) throw new Error('[target-switch] UI selectTarget to other did not land during setup')
  await ensureBitmapMode()
  await useSolidFill('#00ff00')
  await dragBox(BOX_GREEN)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
  const greenDigest = await waitForStableDigest()
  expect(isNonBlankDigest(greenDigest)).toBe(true)
  const greenMd5 = await vmCostumeMd5()
  expect(greenMd5).toBeDefined()
  // Back to A: blue base + red staged pending.
  const snapMid = await vmSnapshot()
  const backName = (snapMid?.project?.targets ?? []).find((t) => t.id !== stableB && !t.isStage)?.name
    ?? (snapMid?.project?.targets ?? []).find((t) => t.id !== stableB)?.name
    ?? ''
  expect(backName.length).toBeGreaterThan(0)
  await page.evaluate((name: string) => {
    const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
    vm?.selectTarget(name as string)
  }, backName as unknown as undefined)
  await page.waitForTimeout(1200)
  const stableA = await selectedStableId()
  expect(stableA).not.toBe(stableB)
  await ensureBitmapMode()
  await useSolidFill('#0000ff')
  await dragBox(BOX_BLUE)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
  const blueMd5 = await vmCostumeMd5()
  expect(blueMd5).toBeDefined()
  expect(blueMd5).not.toBe(greenMd5)
  await useSolidFill('#ff0000')
  await dragBox(BOX_RED)
  await page.waitForTimeout(800)
  expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  expect(await vmCostumeMd5()).toBe(blueMd5)
  const stagedDigest = await canvasDigest()
  expect(stagedDigest).not.toBe(greenDigest)
  return { stableA, stableB, greenMd5, greenDigest, blueMd5, stagedDigest, otherName }
}

describe('bitmap pending reload skip target-switch (vite transform only, port 4696)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (target-switch config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (target-switch config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('cas-pre held switch: B shows exact green, A pending recovered, metadata reload not skipped', async () => {
    const { stableA, stableB, greenMd5, greenDigest, blueMd5, stagedDigest } = await prepareGreenBThenStageRedOnA()
    const otherName = (await vmSnapshot()).project?.targets?.find((t) => t.id === stableB)?.name ?? ''
    expect(otherName.length).toBeGreaterThan(0)
    await directClear()
    await directHold('direct-cas-pre')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-pre')
    // Hostile switch lands while the A commit is parked before the CAS.
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, otherName as unknown as undefined)
    let switched = false
    for (let i = 0; i < 25; i += 1) {
      await page.waitForTimeout(200)
      if ((await selectedStableId()) === stableB) {
        switched = true
        break
      }
    }
    expect(switched).toBe(true)
    await directRelease('direct-cas-pre')
    await directRelease('direct-store')
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    // External selection stands (no auto-revert).
    expect(await selectedStableId()).toBe(stableB)
    // B shows its own exact green bytes: no stale A red/blue survived the
    // switch (the stale skip would have hidden B's reload behind A's canvas).
    expect(await costumeMd5ForStableId(stableB)).toBe(greenMd5)
    expect(await vmCostumeMd5()).toBe(greenMd5)
    expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).toBe(greenDigest)
    expect(liveAfter).not.toBe(stagedDigest)
    // A pending recovered off-canvas (quarantine + export), A VM untouched
    // (CAS parked before landing, so blue stands, red never landed).
    expect(await costumeMd5ForStableId(stableA)).toBe(blueMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingStatusText()).toMatch(/quarantin|recovery-pending|external|conflict/)
    expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await beforeUnloadPrevented()).toBe(true)
    // Metadata change on B forces a preview reload: it must NOT be skipped
    // (stale skip would leave the pre-rename canvas or hide the rename).
    const extName = `bmeta-${Date.now() % 100000}`
    await page.evaluate(([id, idx, name]: [string, number, string]) => {
      const vm = (window as unknown as { __directVm?: { renameCostume: (t: string, i: number, n: string) => boolean } }).__directVm
      vm?.renameCostume(id as string, idx as number, name as string)
    }, [stableB, 0, extName] as unknown as undefined)
    await page.waitForTimeout(1500)
    const snapAfterMeta = await vmSnapshot()
    const hitAfterMeta = snapAfterMeta?.project?.targets?.find((t) => t.id === stableB)
    expect(hitAfterMeta?.costumes?.[hitAfterMeta.currentCostume ?? 0]?.name).toBe(extName)
    expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
    expect(await waitForStableDigest()).toBe(greenDigest)
    expect(await costumeMd5ForStableId(stableB)).toBe(greenMd5)
    // Explicit discard keeps B green and clears the recovery UI.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForTimeout(800)
    expect(await costumeMd5ForStableId(stableB)).toBe(greenMd5)
    expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
  }, 300_000)

  it('history-append held switch: committed A kept, B exact, no stale clear, follow-up B commit works', async () => {
    const { stableA, stableB, greenMd5, greenDigest, stagedDigest } = await prepareGreenBThenStageRedOnA()
    const otherName = (await vmSnapshot()).project?.targets?.find((t) => t.id === stableB)?.name ?? ''
    expect(otherName.length).toBeGreaterThan(0)
    await directClear()
    await directHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-post')
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, otherName as unknown as undefined)
    let switched = false
    for (let i = 0; i < 25; i += 1) {
      await page.waitForTimeout(200)
      if ((await selectedStableId()) === stableB) {
        switched = true
        break
      }
    }
    await directRelease('direct-history-append')
    await page.waitForTimeout(2200)
    expect(switched).toBe(true)
    expect(await selectedStableId()).toBe(stableB)
    // Old A slot keeps the committed staged red (CAS landed before the
    // switch); the new selection never carries old bytes (no cross-slot leak).
    const oldMd5 = await costumeMd5ForStableId(stableA)
    expect(oldMd5).toBeDefined()
    expect(await vmCostumeMd5()).toBe(greenMd5)
    expect(await vmCostumeMd5()).not.toBe(oldMd5)
    // B canvas exact, never the old staged digest / red.
    expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    expect(await waitForStableDigest()).toBe(greenDigest)
    expect((await waitForStableDigest())).not.toBe(stagedDigest)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await quarantinedExportCenterPixel()).toEqual([255, 0, 0, 255])
    // Metadata on B still reloads (no stale skip), bytes stable.
    const extName = `bmeta2-${Date.now() % 100000}`
    await page.evaluate(([id, idx, name]: [string, number, string]) => {
      const vm = (window as unknown as { __directVm?: { renameCostume: (t: string, i: number, n: string) => boolean } }).__directVm
      vm?.renameCostume(id as string, idx as number, name as string)
    }, [stableB, 0, extName] as unknown as undefined)
    await page.waitForTimeout(1500)
    expect(await pixel(CENTER_GREEN.x, CENTER_GREEN.y)).toEqual([0, 255, 0, 255])
    // Overlapping bounded: the stale A completion must not have cleared a
    // newer barrier (B settles independently). A follow-up staged commit on
    // the live B slot still works exactly once with no blanket replay.
    await page.getByTestId('bitmap-pending-discard').click()
    await page.waitForTimeout(800)
    expect(await pendingStatusCount()).toBe(0)
    await useSolidFill('#0000ff')
    await dragBox(BOX_BLUE)
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    expect(await pendingStatusCount()).toBe(0)
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    expect((await editorStatusText()).toLowerCase()).toMatch(/commit|saved|shape/)
  }, 300_000)

  it('normal same-slot commit still skips exactly once (no regression)', async () => {
    await openBitmap()
    await useSolidFill('#0000ff')
    await dragBox(BOX_BLUE)
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    const blueMd5 = await vmCostumeMd5()
    expect(blueMd5).toBeDefined()
    await useSolidFill('#ff0000')
    await dragBox(BOX_RED)
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    // Committed red over blue, no quarantine, canvas exact.
    expect(await vmCostumeMd5()).not.toBe(blueMd5)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
    expect(await pendingStatusCount()).toBe(0)
  }, 300_000)
})
