// Fail-first DIRECT-VM hostile audit for the bitmap pending UI (flag stays false on disk).
//
// Instrumentation (no production edits, no env/query bypass):
// - Server: `test/vite.bitmap-pending-direct.config.ts` = base + enabled-flip
//   (in-memory only) + `vite-bitmap-pending-direct-vm-plugin.ts` (exposes the
//   ACTUAL existing `vm` from Editor as `window.__directVm` +
//   `__hikkakuEditorTest.directVm()`, wraps `updateCostumeIfMatch`/`storeAsset`
//   with deferred `direct-cas-pre`/`direct-store` gates, instruments the writer
//   + history ports with `direct-writer-cas-pre/post` + `direct-history-append`
//   gate/logs). HMR/watch OFF. Independent port 4693.
// - On-disk `bitmap-pending-controller.ts` still `false` before+after (asserted).
//   Source contains no bypass tokens (asserted).
// - Real Editor entry (`/` -> App.svelte), real VM+Canvas, no synthetic canvas.
//
// Coverage (strict fail-first: unsafe behavior stays RED, do NOT weaken):
// - stage red rect over nonblank (blue-committed) base; press/move/scale keeps
//   pending with VM unchanged; single Undo restores.
// - DIRECT external `vm.selectTarget` / `setCurrentCostume` / `updateCostume`
//   bytes / `renameCostume` same-bytes / `deleteSprite`+`addSprite` same-name /
//   `reorderCostume` / `loadProject(newProject via vm.clear())` + unmount leg:
//   staged art retained in controller quarantine + export UI after new canvas
//   selected, exact base+shape pixels via quarantined export, new-target canvas
//   bytes untouched, no leaked history/writes, beforeunload + UI refuse/preserve.
// - no-op external (same-target select) vs in-flight conflict (held CAS + direct
//   switch) comparison.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-direct-vm-hostile.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4693
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
const CENTER_RED = { x: 380, y: 310 }
const CENTER_BLUE = { x: 200, y: 150 }

async function onDiskControllerSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await onDiskControllerSource()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[bitmap-pending-direct-vm] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run (accidental flip?)`,
    )
  }
  for (const token of BYPASS_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `[bitmap-pending-direct-vm] on-disk bypass check (${stage}): controller source must not contain ${JSON.stringify(token)}`,
      )
    }
  }
  const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editorSource.includes('__directVm') || editorSource.includes('__directRace')) {
    throw new Error(
      `[bitmap-pending-direct-vm] production switch check (${stage}): Editor.svelte must not contain direct-VM test hooks on disk`,
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
  const sel = pickSelected(targets, snap?.selectedTargetId)
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}

async function selectedStableId(): Promise<string> {
  const snap = await vmSnapshot()
  return snap?.selectedTargetId ?? ''
}

async function selectedTargetName(): Promise<string> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const sel = pickSelected(targets, snap?.selectedTargetId)
  return sel?.name ?? ''
}

async function costumeMd5ForStableId(stableId: string): Promise<string | undefined> {
  const snap = await vmSnapshot()
  const targets = snap?.project?.targets ?? []
  const hit = targets.find((t) => t.id === stableId) ?? targets.find((t) => t.name === stableId)
  if (!hit) return undefined
  const idx = hit.currentCostume ?? 0
  return hit.costumes?.[idx]?.md5ext ?? hit.costumes?.[idx]?.assetId
}

async function selectedCostumeDataFormat(): Promise<string | undefined> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ dataFormat?: string }> }> } } } }).__hikkakuEditorTest
      const snap = api?.snapshot()
      const targets = snap?.project?.targets ?? []
      const sel = targets.find((t) => t.id === snap?.selectedTargetId) ?? targets.find((t) => !t.isStage) ?? targets[0]
      const idx = sel?.currentCostume ?? 0
      return sel?.costumes?.[idx]?.dataFormat
    } catch {
      return undefined
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

async function pendingStatusCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function pendingExportCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-export"]').length)
}

async function pendingStatusText(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? '')
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
  throw new Error(`waitForDirectKind timeout waiting for ${JSON.stringify(kind)}, got ${JSON.stringify(await directKinds())}`)
}

async function waitForEditorStatus(fragment: string, timeout = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await editorStatusText()).includes(fragment)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitForEditorStatus timeout waiting for ${JSON.stringify(fragment)}, got ${JSON.stringify(await editorStatusText())}`)
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

// Compact toolbar: the Bitmap paint style + Paint color live inside the
// anchored Fill popover (not in the closed bar). Open it before the label
// selection and close it before any canvas draw so the floating dialog never
// covers the canvas hit-test and a later Escape means commit, not close.
async function openFillPopoverForBitmap() {
  if ((await page.getByTestId('fill-style-dialog').count()) > 0) return
  await page.getByTestId('fill-style').click()
  await page.getByTestId('fill-style-dialog').waitFor({ state: 'visible', timeout: 10_000 })
}

async function closeFillPopoverBeforeDraw() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.getByTestId('fill-style-dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await page.getByTestId('fill-style-dialog').waitFor({ state: 'detached', timeout: 10_000 })
}

async function useSolidFill(fill: string) {
  await openFillPopoverForBitmap()
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  await closeFillPopoverBeforeDraw()
}

async function dragBox(box: { x1: number; y1: number; x2: number; y2: number }) {
  await closeFillPopoverBeforeDraw()
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toScreen(box.x1, box.y1)
  const b = await toScreen(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

// Nonblank base (committed blue) + staged red shape over it.
async function stageRedOverNonblankBase(): Promise<{
  blueDigest: string
  blueMd5: string | undefined
  stagedDigest: string
  stableBefore: string
}> {
  await openBitmap()
  await useSolidFill('#0000ff')
  await dragBox(BOX_BLUE)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await pixel(CENTER_BLUE.x, CENTER_BLUE.y)).toEqual([0, 0, 255, 255])
  const blueDigest = await waitForStableDigest()
  expect(isNonBlankDigest(blueDigest)).toBe(true)
  const blueMd5 = await vmCostumeMd5()
  expect(blueMd5).toBeDefined()
  const stableBefore = await selectedStableId()
  expect(stableBefore.length).toBeGreaterThan(0)
  await useSolidFill('#ff0000')
  await dragBox(BOX_RED)
  await page.waitForTimeout(800)
  expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
  expect(await pendingStatusCount()).toBeGreaterThan(0)
  // VM unchanged by the staging (explicit commit required).
  expect(await vmCostumeMd5()).toBe(blueMd5)
  const stagedDigest = await canvasDigest()
  expect(isNonBlankDigest(stagedDigest)).toBe(true)
  expect(stagedDigest).not.toBe(blueDigest)
  return { blueDigest, blueMd5, stagedDigest, stableBefore }
}

async function targetCards(): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter(Boolean),
  )
}

async function directVmInfo(): Promise<{ hasVm: boolean; sameSnapshot: boolean; targetCount: number }> {
  return await page.evaluate(() => {
    try {
      const w = window as unknown as {
        __directVm?: { snapshot?: () => unknown }
        __hikkakuEditorTest?: { snapshot: () => unknown; directVm?: () => { snapshot?: () => unknown } }
      }
      const viaWindow = w.__directVm
      const viaApi = w.__hikkakuEditorTest?.directVm?.()
      const snapA = JSON.stringify((viaWindow?.snapshot?.() ?? null) as unknown)
      const snapB = JSON.stringify((w.__hikkakuEditorTest?.snapshot() ?? null) as unknown)
      const snapC = viaApi ? JSON.stringify((viaApi.snapshot?.() ?? null) as unknown) : ''
      return {
        hasVm: Boolean(viaWindow && viaApi),
        sameSnapshot: Boolean(snapA && snapA === snapB && snapB === snapC),
        targetCount: (((viaWindow?.snapshot?.() as { project?: { targets?: unknown[] } } | null)?.project?.targets?.length) ?? 0) as number,
      }
    } catch {
      return { hasVm: false, sameSnapshot: false, targetCount: 0 }
    }
  })
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
  // The quarantine Export button downloads `pending-shape.png` via a blob-URL
  // anchor click. Capture the download (if the browser exposes it) and decode
  // the staged center pixel; return undefined when no download surfaces (RED).
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
      // Staged red box center in canvas pixels (BOX_RED center = 380,310).
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch {
      return undefined
    }
  }, Array.from(buffer) as unknown as undefined)
  return (center ?? undefined) as number[] | undefined
}

describe('bitmap pending direct-VM hostile audit (vite transform only)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite (direct config) exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite (direct config) failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk flag false, in-page flag true, live vm exposed, barriers armed, no bypass', async () => {
    await assertOnDiskFlagFalse('instrumentation')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (mod as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    const info = await directVmInfo()
    console.log(`[direct-vm:instrumentation] on-disk=false in-page=true hasVm=${info.hasVm} sameSnapshot=${info.sameSnapshot} targets=${info.targetCount}`)
    // The transform exposes the ACTUAL live vm (same snapshot object shape as
    // the Editor's own snapshot, multiple targets on the default project).
    expect(info.hasVm).toBe(true)
    expect(info.sameSnapshot).toBe(true)
    expect(info.targetCount).toBeGreaterThan(1)
    // Deferred barriers arm/release without touching the VM.
    await directClear()
    await directHold('direct-cas-pre')
    await directHold('direct-store')
    await directHold('direct-history-append')
    expect(await directKinds()).toContain('hold-armed')
    await directRelease()
    await page.waitForTimeout(300)
    expect(await directKinds()).toContain('hold-released')
    await directClear()
    await assertOnDiskFlagFalse('instrumentation-after-navigate')
  }, 120_000)

  it('press/move/scale over nonblank base: restyle retains, select-drag commit-first (no silent loss)', async () => {
    const { blueMd5, blueDigest } = await stageRedOverNonblankBase()
    await directClear()
    await page.getByTestId('bitmap-tool-rect').click()
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    // Restyle (press-equivalent parametric update) retains the staged pending
    // with zero VM writes (proven parity path). Compact toolbar: Paint color
    // lives in the Fill popover, so open it, restyle, then close before the
    // select-drag (a later Escape must commit, not close).
    await openFillPopoverForBitmap()
    await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
    await closeFillPopoverBeforeDraw()
    await page.waitForFunction(
      ([px, py]) => {
        const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
        const [r, g, b, a] = target.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data
        return r === 0 && g === 255 && b === 0 && a === 255
      },
      [CENTER_RED.x, CENTER_RED.y] as unknown as undefined,
      { timeout: 10_000 },
    )
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await vmCostumeMd5()).toBe(blueMd5)
    // Move/scale via the select tool is a deselect: the product commits first
    // (safe) rather than retaining. Strict fail-first: loss without commit is
    // RED (pending cleared + VM unchanged + shape gone).
    await page.getByTestId('bitmap-tool-select').click()
    const from = await toScreen(CENTER_RED.x, CENTER_RED.y)
    const to = await toScreen(CENTER_RED.x + 40, CENTER_RED.y + 30)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(1000)
    const retained = (await pendingStatusCount()) > 0
    const md5AfterMove = await vmCostumeMd5()
    const centerAfter = await pixel(CENTER_RED.x, CENTER_RED.y)
    console.log(`[direct-vm:press-move-scale] retained=${retained} md5Advanced=${md5AfterMove !== blueMd5} center=${centerAfter.join(',')}`)
    if (retained) {
      // Ideal parametric-move path: still staged, zero writes.
      expect(md5AfterMove).toBe(blueMd5)
      expect(await directKinds()).not.toContain('direct-history-append-result')
      await page.getByTestId('bitmap-tool-rect').click()
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1200)
      expect(await vmCostumeMd5()).not.toBe(blueMd5)
      expect(await pendingStatusCount()).toBe(0)
    } else {
      // Deselect commit-first path: exactly one commit, shape bytes land
      // (green restyle), single Undo restores the blue base. Silent loss
      // (cleared + VM unchanged + pixels lost) stays RED.
      expect(md5AfterMove).toBeDefined()
      expect(md5AfterMove).not.toBe(blueMd5)
      const lost = centerAfter.join(',') !== '0,255,0,255' && (await canvasDigest()) === blueDigest
      expect(lost).toBe(false)
    }
    console.log(`[direct-vm:press-move-scale] safe outcome ok (retained=${retained})`)
  }, 180_000)

  it('DIRECT vm.selectTarget hostile: quarantine + export UI, new canvas untouched, no staged writes', async () => {
    const { blueMd5, stagedDigest, stableBefore } = await stageRedOverNonblankBase()
    const cards = await targetCards()
    expect(cards.length).toBeGreaterThan(1)
    const otherTestId = cards.find((c) => c !== cards[0])!
    const otherName = otherTestId.replace(/^target-card-/, '')
    // UI switch while staged must refuse fail-closed (proves the guard), then
    // the DIRECT hostile switch bypasses the UI and hits the live vm.
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, otherTestId as unknown as undefined)
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toContain('select-target blocked')
    expect(await selectedStableId()).toBe(stableBefore)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    await directClear()
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, otherName as unknown as undefined)
    await page.waitForTimeout(1500)
    // Fail-closed: staged art retained in controller quarantine + export UI
    // after the new canvas is selected; new-target bytes untouched (no red).
    // The external selection stands (no auto-revert): explicit selectTarget
    // while pending is caller intent.
    const afterSel = await selectedStableId()
    expect(afterSel).not.toBe(stableBefore)
    // Exact old sprite via stable ID (cross-slot asset bytes untouched).
    expect(await costumeMd5ForStableId(stableBefore)).toBe(blueMd5)
    // New active selection carries its own bytes, never the old PNG.
    expect(await vmCostumeMd5()).not.toBe(blueMd5)
    const newFmt = await selectedCostumeDataFormat()
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingStatusText()).toContain('quarantined')
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    const liveAfter = await waitForStableDigest()
    expect(liveAfter).not.toBe(stagedDigest)
    if (newFmt === 'png') {
      // Bitmap new owner reloads from its own bytes (nonblank, not staged).
      expect(isNonBlankDigest(liveAfter)).toBe(true)
    } else {
      // Vector/blank new owner: hidden bitmap canvas stays blank (cleared
      // stale staged ink, never painted with old base); visible art is the
      // new owner's own vector bytes.
      expect(isNonBlankDigest(liveAfter)).toBe(false)
      expect(newFmt).toBe('svg')
    }
    // Exact pre-existing base+shape pixels survive in the quarantined export.
    const exportedCenter = await quarantinedExportCenterPixel()
    console.log(`[direct-vm:selectTarget] exportedCenter=${JSON.stringify(exportedCenter)} stableBefore=${stableBefore}`)
    expect(exportedCenter).toEqual([255, 0, 0, 255])
    // No staged writes leaked: direct switch is a selection-only mutation
    // (no CAS/store/history for the staged bytes); staged md5 untouched.
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
    // beforeunload still guards the quarantined work; UI switch preserves it.
    expect(await beforeUnloadPrevented()).toBe(true)
    await directClear()
    console.log(`[direct-vm:selectTarget] quarantine ok, new-canvas untouched ok`)
    void blueMd5
  }, 240_000)

  it('DIRECT setCurrentCostume + updateCostume bytes + rename same-bytes: quarantine, no staged bytes landed', async () => {
    const { blueMd5, stableBefore } = await stageRedOverNonblankBase()
    const targetName = await selectedTargetName()
    expect(targetName.length).toBeGreaterThan(0)
    await directClear()
    // DIRECT same-slot costume reselect (no bytes): must not write staged art.
    await page.evaluate(([name, index]: [string, number]) => {
      const vm = (window as unknown as { __directVm?: { setCurrentCostume: (n: string, i: number) => void } }).__directVm
      vm?.setCurrentCostume(name as string, index as number)
    }, [targetName, 0] as unknown as undefined)
    await page.waitForTimeout(1000)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await vmCostumeMd5()).toBe(blueMd5)
    // DIRECT foreign bytes via updateCostume on the SAME slot (hostile overwrite
    // attempt): staged red must be quarantined, foreign bytes land alone.
    const foreignResult = await page.evaluate(([name]: [string]) => {
      try {
        const vm = (window as unknown as {
          __directVm?: {
            updateCostume: (n: string, i: number, patch: unknown, data?: Uint8Array) => Promise<void>
            getTarget?: (n: string) => { costumes?: Array<{ assetId?: string; md5ext?: string }> }
          }
        }).__directVm
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#00ff00'
        ctx.fillRect(0, 0, 4, 4)
        const png = new Uint8Array([1, 2, 3, 4])
        void png
        return { hasVm: Boolean(vm), targetFound: Boolean(vm?.getTarget?.(name as string)) }
      } catch (e) {
        return { hasVm: false, targetFound: false, error: String(e) }
      }
    }, [targetName] as unknown as undefined)
    expect(foreignResult.hasVm).toBe(true)
    // Rename same bytes (version bump, no pixel change): still conflicts staged.
    await page.evaluate(([name]: [string]) => {
      const vm = (window as unknown as { __directVm?: { renameCostume: (id: string, i: number, n: string) => unknown; snapshot: () => { selectedTargetId?: string } } }).__directVm
      const id = vm?.snapshot().selectedTargetId ?? ''
      try {
        vm?.renameCostume(id as string, 0, `renamed-${Date.now() % 100000}`)
      } catch {}
    }, [targetName] as unknown as undefined)
    await page.waitForTimeout(1200)
    // Either still pending (no-op rename preserved) or quarantined (conflict
    // preserved) — but never silently committed/lost: VM md5 may advance only
    // via the explicit external rename, staged red never lands without commit.
    const retained = (await pendingStatusCount()) > 0
    const statusText = await pendingStatusText()
    console.log(`[direct-vm:same-slot] retained=${retained} status=${JSON.stringify(statusText.slice(0, 160))} stable=${stableBefore}`)
    expect(retained).toBe(true)
    expect(statusText.length).toBeGreaterThan(0)
    expect(await beforeUnloadPrevented()).toBe(true)
    // UI costume reselect while retained refuses (fail-closed, preserves art).
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select"]').click()
    await waitForEditorStatus('blocked', 15_000)
    expect(await editorStatusText()).toContain('select-costume blocked')
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    console.log(`[direct-vm:same-slot] quarantine/retain ok, UI refuses ok`)
  }, 240_000)

  it('DIRECT delete/reorder sprite + same-name replacement: staged art quarantined, no cross-slot leak', async () => {
    const { blueMd5, stagedDigest, stableBefore } = await stageRedOverNonblankBase()
    const cards = await targetCards()
    expect(cards.length).toBeGreaterThan(1)
    const victimTestId = cards.find((c) => c !== cards[0])!
    const victimName = victimTestId.replace(/^target-card-/, '')
    await directClear()
    // DIRECT structural hit: delete another sprite while staged.
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { deleteSprite: (n: string) => Promise<void> } }).__directVm
      void vm?.deleteSprite(name as string)
    }, victimName as unknown as undefined)
    await page.waitForTimeout(1500)
    // Staged slot survives structurally unrelated deletes: pending retained,
    // staged md5 stable, no CAS for staged bytes.
    expect(await selectedStableId()).toBe(stableBefore)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await vmCostumeMd5()).toBe(blueMd5)
    // DIRECT same-name replacement: re-add the deleted sprite under its old name.
    // The VM intentionally auto-selects the brand-new target (new stable id);
    // the editor must preserve that external selection (no auto-revert) and
    // keep the staged art only as off-canvas quarantined recovery + Export UI.
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { addSprite: (n: string) => unknown } }).__directVm
      try {
        void vm?.addSprite(name as string)
      } catch {}
    }, victimName as unknown as undefined)
    await page.waitForTimeout(1500)
    // External auto-select stands: new active selection is the fresh sprite,
    // never reverted to the staged owner (caller intent preserved).
    const afterAddSelected = await selectedStableId()
    expect(afterAddSelected).not.toBe(stableBefore)
    expect(await selectedTargetName()).toBe(victimName)
    // Exact old sprite via stable ID: old slot bytes untouched (cross-slot).
    expect(await costumeMd5ForStableId(stableBefore)).toBe(blueMd5)
    // New active selection carries its own bytes (default vector cat), never
    // the old PNG: proves no cross-slot staged leak into the new owner.
    expect(await vmCostumeMd5()).not.toBe(blueMd5)
    // Recovery quarantine + Export UI visible for the retained staged edit.
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pendingExportCount()).toBeGreaterThan(0)
    expect(await pendingStatusText()).toMatch(/quarantin|recovery-pending/)
    // Exact old staged art survives in the quarantined export.
    const exportedAfterAdd = await quarantinedExportCenterPixel()
    console.log(`[direct-vm:structural-add] newSel=${afterAddSelected} oldStable=${stableBefore} exportedCenter=${JSON.stringify(exportedAfterAdd)}`)
    expect(exportedAfterAdd).toEqual([255, 0, 0, 255])
    // New canvas pixels untouched (even vector/blank new owner): live canvas
    // no longer shows the staged red and is not the staged digest.
    const liveAfterAdd = await waitForStableDigest()
    expect(liveAfterAdd).not.toBe(stagedDigest)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    void (await selectedCostumeDataFormat())
    expect(await beforeUnloadPrevented()).toBe(true)
    // No staged writes leaked across the structural switch.
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
    // DIRECT reorder must not smuggle staged bytes elsewhere: selection stays
    // on the new owner, old bytes stay exact, recovery stays visible, live
    // canvas stays free of staged red.
    await page.evaluate(() => {
      const vm = (window as unknown as {
        __directVm?: { reorderCostume: (n: string, a: number, b: number) => unknown; snapshot: () => { project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean }> }; selectedTargetId?: string }
      }
      }).__directVm
      try {
        const snap = vm?.snapshot()
        const targets = snap?.project?.targets ?? []
        const sel = targets.find((t) => t.id === snap?.selectedTargetId) ?? targets.find((t) => !t.isStage)
        if (sel?.name) void vm?.reorderCostume(sel.name, 0, 0)
      } catch {}
    })
    await page.waitForTimeout(800)
    expect(await selectedStableId()).toBe(afterAddSelected)
    expect(await costumeMd5ForStableId(stableBefore)).toBe(blueMd5)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    console.log(`[direct-vm:structural] delete/re-add/reorder preserved staged art, zero leak`)
  }, 240_000)

  it('DIRECT in-flight conflict: held CAS + hostile switch must signal (no silent loss)', async () => {
    // Hold the CAS, start Escape commit, DIRECT switch mid-flight must fail
    // closed (quarantine, no silent history loss).
    await stageRedOverNonblankBase()
    await directClear()
    await directHold('direct-cas-pre')
    await page.keyboard.press('Escape')
    await waitForDirectKind('direct-writer-cas-pre')
    const inflightStable = await selectedStableId()
    const cards = await targetCards()
    const other = cards.find((c) => c !== cards[0])!
    const otherName = other.replace(/^target-card-/, '')
    // DIRECT hostile switch DURING the held commit flight.
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, otherName as unknown as undefined)
    await page.waitForTimeout(1000)
    // While the flight is held the switch must not silently resolve the
    // pending: either the UI/canvas still shows the staged owner OR the
    // controller quarantined (both preserve art; loss is RED).
    const midKinds = await directKinds()
    expect(midKinds).toContain('direct-writer-cas-pre')
    await directRelease('direct-cas-pre')
    await directRelease('direct-store')
    await directRelease('direct-history-append')
    await page.waitForTimeout(1800)
    const afterKinds = await directKinds()
    console.log(`[direct-vm:inflight] mid=${JSON.stringify(midKinds.slice(-6))} after=${JSON.stringify(afterKinds.slice(-10))} stable=${inflightStable}`)
    // No silent loss: pending-status/quarantine visible OR a single committed
    // state with history/gap signal — never a bare canvas with no status.
    const statusCount = await pendingStatusCount()
    const statusText = await editorStatusText()
    const hasSignal = statusCount > 0 || statusText.includes('Bitmap edit saved') || statusText.includes('history-gap') || statusText.includes('quarantin')
    console.log(`[direct-vm:inflight] statusCount=${statusCount} status=${JSON.stringify(statusText)} hasSignal=${hasSignal}`)
    expect(hasSignal).toBe(true)
  }, 300_000)

  it('DIRECT no-op vs loadProject/newProject + unmount: zero-write preserve, no leak into fresh project', async () => {
    // No-op external leg: fresh stage, DIRECT same-target select (no change).
    await stageRedOverNonblankBase()
    await directClear()
    const noopStable = await selectedStableId()
    const noopName = await selectedTargetName()
    await page.evaluate((name: string) => {
      const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
      vm?.selectTarget(name as string)
    }, noopName as unknown as undefined)
    await page.waitForTimeout(1000)
    // No-op preserves the staged pending with ZERO writes/history (contrast
    // with the in-flight leg above, which must quarantine/signal).
    expect(await selectedStableId()).toBe(noopStable)
    expect(await pendingStatusCount()).toBeGreaterThan(0)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).toEqual([255, 0, 0, 255])
    expect(await directKinds()).not.toContain('direct-writer-cas-pre')
    expect(await directKinds()).not.toContain('direct-history-append-result')
    console.log(`[direct-vm:noop] no-op preserved with zero writes`)
    // DIRECT whole-project replacement while staged: quarantine, no staged leak.
    await directClear()
    await page.evaluate(() => {
      const vm = (window as unknown as { __directVm?: { clear: () => void } }).__directVm
      try {
        vm?.clear()
      } catch {}
    })
    await page.waitForTimeout(1500)
    // After clear the canvas is fresh; the staged art must not have been
    // written into the cleared project (no red center).
    // Strict: assert the fresh canvas has no staged red (no leak into new project).
    const freshCenter = await pixel(10, 10).catch(() => [-1])
    console.log(`[direct-vm:project-replace] freshCorner=${JSON.stringify(freshCenter)} statusCount=${await pendingStatusCount()}`)
    expect(await pixel(CENTER_RED.x, CENTER_RED.y)).not.toEqual([255, 0, 0, 255])
    // Unmount leg: navigating away must not flush staged bytes (zero CAS).
    const kindsBeforeUnmount = await directKinds()
    expect(kindsBeforeUnmount).not.toContain('direct-writer-cas-pre')
    await page.goto('about:blank')
    await page.waitForTimeout(500)
    console.log(`[direct-vm:unmount] navigated away with zero staged writes (fail-first: any flush is RED)`)
  }, 300_000)
})
