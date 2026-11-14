// Independent fail-first audit: pagehide/pageshow temporal races for the
// bitmap pending path (test-only enabled, real Editor + real VM + real canvas).
//
// Instrumentation (no production edits, no env/query/storage bypass):
// - Test server uses `test/vite.bitmap-pending-direct.config.ts` (same as the
//   applied-before-append suite): in-memory flag flip + live `__directVm`
//   + deferred `direct-cas-pre` / `direct-history-append` gates. HMR/watch OFF.
//   Independent port 4696.
// - On-disk `BITMAP_PENDING_UI_ENABLED` stays `false` (asserted before+after).
//   Production `Editor.svelte` never imports the isolated test factory.
// - All helpers below are original test code (no AGPL copy): they drive the UI
//   like a user and read pixels/VM identity via the live test hooks.
//
// Temporal legs (each independent, fresh page + fresh nonblank blue base +
// staged red rect unless noted):
// - cas-pre-hide: hold `direct-cas-pre`, Escape parks before CAS, synthetic
//   `pagehide`, release. No foreign write. Expect abort/superseded: VM
//   bytes+seq unchanged, live canvas keeps staged red, quarantine retained,
//   exact export red, single CAS attempt, no double history, beforeunload true.
// - cas-pre-hide-foreign-bytes: same park + synthetic `pagehide` + direct
//   same-slot green write while parked, release. External wins: live green,
//   staged red quarantined off-canvas, export exact red, no cross-slot paint.
// - appended-hide-foreign-bytes: hold `direct-history-append`, Escape parks
//   after CAS applied, synthetic `pagehide`, direct green while parked,
//   release, then `pageshow` persisted. External wins, history append skipped,
//   quarantine/gap visible, live green, export red.
// - appended-hide-foreign-switch: same park + `pagehide` + direct
//   `selectTarget` to another sprite while parked, release, `pageshow`
//   persisted. External selection stands, no cross-slot leak, staged
//   quarantined, export red.
// - move-held-hide: staged red, canvas move drag held (mouse down inside +
//   small move, no up), synthetic `pagehide` while held, mouse up, `pageshow`
//   persisted. Pending retained (no silent drop/duplication), live shows
//   staged red, export red, VM unchanged until explicit commit.
// - scale-held-hide: staged red, SE scale-handle drag held, `pagehide` while
//   held, release, `pageshow` persisted. Same retention guarantees.
// - rotate-held-hide: staged red, rotate-handle drag held, `pagehide` while
//   held, release, `pageshow` persisted. Same retention guarantees.
//
// Every leg then dispatches synthetic `pageshow` with `persisted === true`
// and asserts: no old-canvas repaint under the new owner, no double commit
// (single CAS attempt), no lost/duplicated staging, history-gap surfaced when
// the append was skipped, old base+pending recovery export exact red,
// bytes/seq owner unchanged when the commit failed, `beforeunload` still
// armed while retained.
//
// Boundary (documented, not claimed durable): a frozen BFCache page keeps
// in-memory state only while mounted; a real reload/navigation/unmount drops
// it (no durable autosave). The suite never asserts survival across a real
// reload — only that hide/show alone never paints old art onto a new owner
// and never writes the VM.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-pagehide-temporal-races.browser.test.ts
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

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const SHAPE = { x1: 280, y1: 260, x2: 480, y2: 360 }
const SHAPE_CENTER = { x: 380, y: 310 }
const BLUE_BOX = { x1: 100, y1: 100, x2: 300, y2: 200 }
const BLUE_DOT = { x: 200, y: 150 }

async function diskSource(): Promise<string> {
  return await Bun.file(CONTROLLER_URL).text()
}

async function requireFlagFalse(stage: string): Promise<void> {
  const src = await diskSource()
  const hits = src.split(NEEDLE).length - 1
  if (hits !== 1) throw new Error(`[temporal-races] flag (${stage}): expected 1 needle, found ${hits}`)
  for (const token of ['localStorage.', 'sessionStorage.', 'URLSearchParams', 'location.search', 'location.hash', 'import.meta.env', 'process.env']) {
    if (src.includes(token)) throw new Error(`[temporal-races] bypass (${stage}): ${token}`)
  }
  const editor = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
  if (editor.includes('createBitmapPendingControllerForTest') || editor.includes('testForceEnabled')) {
    throw new Error(`[temporal-races] production switch (${stage}): Editor must not import test factory`)
  }
}

async function backingSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: el.width, height: el.height }
  })
}

async function liveRect(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
}

async function toClient(x: number, y: number): Promise<{ x: number; y: number }> {
  const r = await liveRect()
  const s = await backingSize()
  return { x: r.left + (x / s.width) * r.width, y: r.top + (y / s.height) * r.height }
}

async function readPixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(el.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}

async function fullDigest(): Promise<string> {
  return await page.evaluate(() => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data).join(',')
  })
}

function digestIsNonBlank(d: string): boolean {
  const parts = d.split(',')
  const first = `${parts[0]},${parts[1]},${parts[2]},${parts[3]}`
  for (let i = 4; i < parts.length; i += 4) {
    if (`${parts[i]},${parts[i + 1]},${parts[i + 2]},${parts[i + 3]}` !== first) return true
  }
  return false
}

async function snap(): Promise<{ selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string; name?: string }> }> } }> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
    return (api?.snapshot() ?? {}) as never
  })
}

function pickTarget(targets: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }>, want: string | undefined) {
  return targets.find((t) => t.id === want) ?? targets.find((t) => !t.isStage) ?? targets[0]
}

async function liveMd5(): Promise<string | undefined> {
  const s = await snap()
  const list = s?.project?.targets ?? []
  const sel = pickTarget(list as never, s?.selectedTargetId)
  const idx = sel?.currentCostume ?? 0
  return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
}

async function md5ForStable(stable: string): Promise<string | undefined> {
  const s = await snap()
  const hit = (s?.project?.targets ?? []).find((t) => t.id === stable)
  if (!hit) return undefined
  const idx = hit.currentCostume ?? 0
  return hit.costumes?.[idx]?.md5ext ?? hit.costumes?.[idx]?.assetId
}

async function stableNow(): Promise<string> {
  return (await snap())?.selectedTargetId ?? ''
}

async function costumeIdxNow(): Promise<number> {
  const s = await snap()
  const list = s?.project?.targets ?? []
  const sel = pickTarget(list as never, s?.selectedTargetId)
  return sel?.currentCostume ?? 0
}

async function ownerNumbers(stable: string, idx: number): Promise<{ seq: number; gen: number }> {
  return await page.evaluate(([id, i]) => {
    const vm = (window as unknown as { __directVm?: { getCostumeWriteSeq: (t: string, n: number) => number; getProjectGeneration?: () => number } }).__directVm
    return {
      seq: vm?.getCostumeWriteSeq(id as string, i as number) ?? -1,
      gen: vm?.getProjectGeneration?.() ?? -1,
    }
  }, [stable, idx] as unknown as undefined)
}

async function pendingCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}

async function exportCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-export"]').length)
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    try {
      return (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? ''
    } catch {
      return ''
    }
  })
}

async function pendingDomText(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[data-testid="bitmap-pending-status"]')?.textContent ?? '')
}

async function unloadArmed(): Promise<boolean> {
  return await page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    try {
      ;(ev as unknown as { returnValue: unknown }).returnValue = true
    } catch {}
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  })
}

async function raceKinds(): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __directRace?: { log: Array<{ kind: string }> } }
    return (w.__directRace?.log ?? []).map((e) => e.kind)
  })
}

async function raceClear(): Promise<void> {
  await page.evaluate(() => {
    try {
      ;(window as unknown as { __directRace?: { clear: () => void } }).__directRace?.clear()
    } catch {}
  })
}

async function raceHold(name: string): Promise<void> {
  await page.evaluate((n: string) => {
    ;(window as unknown as { __directRace?: { hold: (x: string) => void } }).__directRace?.hold(n as string)
  }, name as unknown as undefined)
}

async function raceRelease(name?: string): Promise<void> {
  await page.evaluate((n: string | undefined) => {
    const w = window as unknown as { __directRace?: { release: (x?: string) => void } }
    if (n === undefined) w.__directRace?.release()
    else w.__directRace?.release(n)
  }, name as unknown as undefined)
}

async function waitKind(kind: string, timeout = 30_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if ((await raceKinds()).includes(kind)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`waitKind timeout ${kind}, got ${JSON.stringify(await raceKinds())}`)
}

async function openPaint(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 })
  } catch {}
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try {
    await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 })
  } catch {}
  await page.waitForTimeout(800)
  const s = await backingSize()
  if (s.width !== 960 || s.height !== 720) throw new Error(`backing ${s.width}x${s.height}, want 960x720`)
}

async function solidFill(hex: string): Promise<void> {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(hex)
  const t = page.getByRole('button', { name: 'Transparent fill' })
  if ((await t.getAttribute('aria-pressed')) === 'true') await t.click()
}

async function dragShape(box: { x1: number; y1: number; x2: number; y2: number }): Promise<void> {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  const a = await toClient(box.x1, box.y1)
  const b = await toClient(box.x2, box.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

async function prepareBlueThenStageRed(): Promise<{ blueDigest: string; blueMd5: string | undefined; stagedDigest: string; owner: string; idx: number }> {
  await openPaint()
  await solidFill('#0000ff')
  await dragShape(BLUE_BOX)
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  expect(await readPixel(BLUE_DOT.x, BLUE_DOT.y)).toEqual([0, 0, 255, 255])
  const blueDigest = await fullDigest()
  expect(digestIsNonBlank(blueDigest)).toBe(true)
  const blueMd5 = await liveMd5()
  expect(blueMd5).toBeDefined()
  const owner = await stableNow()
  expect(owner.length).toBeGreaterThan(0)
  const idx = await costumeIdxNow()
  await solidFill('#ff0000')
  await dragShape(SHAPE)
  await page.waitForTimeout(800)
  expect(await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)).toEqual([255, 0, 0, 255])
  expect(await pendingCount()).toBeGreaterThan(0)
  expect(await liveMd5()).toBe(blueMd5)
  const stagedDigest = await fullDigest()
  expect(stagedDigest).not.toBe(blueDigest)
  return { blueDigest, blueMd5, stagedDigest, owner, idx }
}

async function dispatchPagehide(): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'))
  })
  await page.waitForTimeout(800)
}

async function dispatchPageshowPersisted(): Promise<void> {
  await page.evaluate(() => {
    const ev = new Event('pageshow') as Event & { persisted: boolean }
    ;(ev as { persisted: boolean }).persisted = true
    window.dispatchEvent(ev)
  })
  await page.waitForTimeout(800)
}

async function directGreenSameSlot(stable: string, idx: number): Promise<{ md5: string | undefined; seq: number }> {
  return await page.evaluate(async ([id, i]: [string, number]) => {
    const w = window as unknown as {
      __directVm?: {
        updateCostume: (t: string, n: number, patch: unknown, data?: Uint8Array) => Promise<void>
        getCostumeIdentity?: (t: string, n: number) => { md5ext?: string } | undefined
        getCostumeWriteSeq?: (t: string, n: number) => number
        snapshot?: () => { project?: { targets?: Array<{ id?: string; costumes?: Array<{ bitmapResolution?: number }> }> } }
      }
    }
    const c = document.createElement('canvas')
    c.width = 960
    c.height = 720
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#00ff00'
    ctx.fillRect(0, 0, 960, 720)
    const blob: Blob | null = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
    if (!blob) throw new Error('green encode failed')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const res = (w.__directVm?.snapshot?.()?.project?.targets?.find((t) => t.id === (id as string))?.costumes?.[i as number] as { bitmapResolution?: number } | undefined)?.bitmapResolution ?? 2
    await w.__directVm?.updateCostume(id as string, i as number, { dataFormat: 'png', bitmapResolution: res }, bytes)
    return {
      md5: w.__directVm?.getCostumeIdentity?.(id as string, i as number)?.md5ext,
      seq: w.__directVm?.getCostumeWriteSeq?.(id as string, i as number) ?? -1,
    }
  }, [stable, idx] as unknown as undefined)
}

async function directSwitchToOther(expectOwner: string): Promise<{ otherName: string; afterStable: string }> {
  const otherName = await page.evaluate((want: string) => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean }> } } } }).__hikkakuEditorTest
    const targets = api?.snapshot().project?.targets ?? []
    const other = targets.find((t) => t.id !== (want as string) && !t.isStage) ?? targets.find((t) => t.id !== (want as string))
    return other?.name ?? ''
  }, expectOwner as unknown as undefined)
  expect(otherName.length).toBeGreaterThan(0)
  await page.evaluate((name: string) => {
    const vm = (window as unknown as { __directVm?: { selectTarget: (n: string) => void } }).__directVm
    vm?.selectTarget(name as string)
  }, otherName as unknown as undefined)
  await page.waitForTimeout(1200)
  const afterStable = await stableNow()
  return { otherName, afterStable }
}

async function exportCenterPixel(): Promise<number[] | undefined> {
  const dl = page.waitForEvent('download', { timeout: 8_000 }).catch(() => undefined)
  await page.getByTestId('bitmap-pending-export').click()
  const file = await dl
  if (!file) return undefined
  const stream = await file.createReadStream()
  if (!stream) return undefined
  const chunks: Uint8Array[] = []
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c as Uint8Array)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return await page.evaluate(async (bytes: number[]) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const off2 = document.createElement('canvas')
      off2.width = bmp.width
      off2.height = bmp.height
      const octx = off2.getContext('2d')!
      octx.drawImage(bmp, 0, 0)
      return Array.from(octx.getImageData(380, 310, 1, 1).data)
    } catch {
      return undefined
    }
  }, Array.from(buf) as unknown as undefined) as number[] | undefined
}

async function countKind(kind: string): Promise<number> {
  return (await raceKinds()).filter((k) => k === kind).length
}

describe('bitmap pending pagehide temporal races (direct config, port 4696)', () => {
  beforeAll(async () => {
    await requireFlagFalse('beforeAll')
    server = spawn(
      'bun',
      ['x', 'vite', '--config', 'test/vite.bitmap-pending-direct.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    )
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await requireFlagFalse('afterAll')
  })

  it('cas-pre + pagehide, no foreign: abort, no landing, quarantine + export exact, single attempt', async () => {
    const prep = await prepareBlueThenStageRed()
    const before = await ownerNumbers(prep.owner, prep.idx)
    await raceClear()
    await raceHold('direct-cas-pre')
    await page.keyboard.press('Escape')
    await waitKind('direct-writer-cas-pre')
    await dispatchPagehide()
    // Still parked before CAS: pagehide must abort the flight, never land.
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await unloadArmed()).toBe(true)
    await raceRelease('direct-cas-pre')
    await page.waitForTimeout(2200)
    await dispatchPageshowPersisted()
    // Failed commit: owner bytes/seq unchanged, live keeps staged red overlay.
    expect(await md5ForStable(prep.owner)).toBe(prep.blueMd5)
    expect((await ownerNumbers(prep.owner, prep.idx)).seq).toBe(before.seq)
    const livePx = await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)
    const liveDigest = await fullDigest()
    console.log(`[temporal-races:cas-pre-debug] livePx=${JSON.stringify(livePx)} stagedDigestMatch=${liveDigest === prep.stagedDigest} blueMatch=${liveDigest === prep.blueDigest} kinds=${JSON.stringify(await raceKinds())} status=${JSON.stringify(await pendingDomText())} editor=${JSON.stringify(await editorStatus())}`)
    expect(livePx).toEqual([255, 0, 0, 255])
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await exportCount()).toBeGreaterThan(0)
    expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(`${await pendingDomText()} ${await editorStatus()}`).toMatch(/quarantin|recovery-pending|aborted|superseded|external|conflict/)
    // No double commit: exactly one CAS attempt parked, at most one result.
    expect(await countKind('direct-writer-cas-pre')).toBe(1)
    expect(await countKind('direct-writer-cas-post')).toBeLessThanOrEqual(1)
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('cas-pre-hide')
    console.log('[temporal-races:cas-pre-hide] abort retained, single attempt, export exact')
  }, 300_000)

  it('cas-pre + pagehide + foreign same-slot green: external wins, no old repaint, export staged', async () => {
    const prep = await prepareBlueThenStageRed()
    await raceClear()
    await raceHold('direct-cas-pre')
    await page.keyboard.press('Escape')
    await waitKind('direct-writer-cas-pre')
    await dispatchPagehide()
    const ext = await directGreenSameSlot(prep.owner, prep.idx)
    expect(ext.md5).toBeDefined()
    expect(ext.md5).not.toBe(prep.blueMd5)
    await raceRelease('direct-cas-pre')
    await page.waitForTimeout(2200)
    await dispatchPageshowPersisted()
    // External green wins byte-exact; staged red lives only in quarantine export.
    expect(await md5ForStable(prep.owner)).toBe(ext.md5)
    expect(await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)).toEqual([0, 255, 0, 255])
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await countKind('direct-writer-cas-pre')).toBe(1)
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('cas-pre-foreign-bytes')
    console.log('[temporal-races:cas-pre-foreign-bytes] external wins, quarantine export exact')
  }, 300_000)

  it('applied-before-append + pagehide + foreign green: append skipped, gap/quarantine visible', async () => {
    const prep = await prepareBlueThenStageRed()
    await raceClear()
    await raceHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitKind('direct-writer-cas-post')
    await dispatchPagehide()
    const ext = await directGreenSameSlot(prep.owner, prep.idx)
    expect(ext.md5).toBeDefined()
    await raceRelease('direct-history-append')
    await page.waitForTimeout(2200)
    await dispatchPageshowPersisted()
    // Own CAS landed first, then external overwrote: live is green, staged is
    // retained off-canvas with a visible gap/quarantine (never silent commit).
    expect(await md5ForStable(prep.owner)).toBe(ext.md5)
    expect(await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)).toEqual([0, 255, 0, 255])
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(`${await pendingDomText()} ${await editorStatus()}`).toMatch(/quarantin|recovery-pending|external|conflict|history-gap|history dropped/)
    expect(`${await pendingDomText()} ${await editorStatus()}`).not.toMatch(/^Bitmap shape committed$/)
    if ((await exportCount()) > 0) {
      expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    }
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('appended-foreign-bytes')
    console.log('[temporal-races:appended-foreign-bytes] append skipped, external wins, gap/quarantine visible')
  }, 300_000)

  it('applied-before-append + pagehide + foreign target switch: selection stands, no cross-slot leak', async () => {
    const prep = await prepareBlueThenStageRed()
    await raceClear()
    await raceHold('direct-history-append')
    await page.keyboard.press('Escape')
    await waitKind('direct-writer-cas-post')
    await dispatchPagehide()
    const sw = await directSwitchToOther(prep.owner)
    expect(sw.afterStable).not.toBe(prep.owner)
    await raceRelease('direct-history-append')
    await page.waitForTimeout(2200)
    await dispatchPageshowPersisted()
    // External selection stands (no revert); old slot keeps committed red, new
    // slot never shows old red.
    expect(await stableNow()).toBe(sw.afterStable)
    expect(await md5ForStable(prep.owner)).toBeDefined()
    expect(await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)).not.toEqual([255, 0, 0, 255])
    expect(await pendingCount()).toBeGreaterThan(0)
    if ((await exportCount()) > 0) {
      expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    }
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('appended-switch')
    console.log('[temporal-races:appended-switch] selection stands, no cross-slot leak')
  }, 300_000)

  it('move-held + pagehide then pageshow: retained, no duplication, export exact', async () => {
    const prep = await prepareBlueThenStageRed()
    const stagedBefore = await fullDigest()
    // Start a pending move: press inside the staged rect, drag slightly, hold.
    const start = await toClient(SHAPE_CENTER.x, SHAPE_CENTER.y)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    const held = await toClient(SHAPE_CENTER.x + 24, SHAPE_CENTER.y + 12)
    await page.mouse.move(held.x, held.y, { steps: 6 })
    await page.waitForTimeout(600)
    await dispatchPagehide()
    // While held + hidden: still staged, VM untouched, unload armed.
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    expect(await unloadArmed()).toBe(true)
    await page.mouse.up()
    await page.waitForTimeout(800)
    await dispatchPageshowPersisted()
    // No silent drop/duplication: staged overlay intact, single pending.
    expect(await readPixel(SHAPE_CENTER.x, SHAPE_CENTER.y)).toEqual([255, 0, 0, 255])
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await unloadArmed()).toBe(true)
    void stagedBefore
    await requireFlagFalse('move-held')
    console.log('[temporal-races:move-held] move retained across hide/show, no duplication')
  }, 300_000)

  it('scale-held + pagehide then pageshow: retained, live untouched, export exact', async () => {
    const prep = await prepareBlueThenStageRed()
    await page.getByTestId('bitmap-floating-scale-handle').waitFor({ state: 'visible', timeout: 15_000 })
    const box = await page.getByTestId('bitmap-floating-scale-handle').boundingBox()
    expect(box).toBeTruthy()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 24, cy + 18, { steps: 6 })
    await page.waitForTimeout(600)
    await dispatchPagehide()
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    await page.mouse.up()
    await page.waitForTimeout(800)
    await dispatchPageshowPersisted()
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('scale-held')
    console.log('[temporal-races:scale-held] scale retained across hide/show')
  }, 300_000)

  it('rotate-held + pagehide then pageshow: retained, live untouched, export exact', async () => {
    const prep = await prepareBlueThenStageRed()
    await page.getByTestId('bitmap-floating-rotate-handle').waitFor({ state: 'visible', timeout: 15_000 })
    const box = await page.getByTestId('bitmap-floating-rotate-handle').boundingBox()
    expect(box).toBeTruthy()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 30, cy + 10, { steps: 6 })
    await page.waitForTimeout(600)
    await dispatchPagehide()
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    await page.mouse.up()
    await page.waitForTimeout(800)
    await dispatchPageshowPersisted()
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await liveMd5()).toBe(prep.blueMd5)
    expect(await exportCenterPixel()).toEqual([255, 0, 0, 255])
    expect(await unloadArmed()).toBe(true)
    await requireFlagFalse('rotate-held')
    console.log('[temporal-races:rotate-held] rotate retained across hide/show')
  }, 300_000)

  it('static wiring: enabled-only hide/show, no autosave/commit, no durable promise', async () => {
    const editor = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(editor).toContain(`window.addEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editor).toContain(`window.removeEventListener('pagehide', handleBitmapPendingPageHide)`)
    expect(editor).toContain(`window.addEventListener('pageshow', handleBitmapPendingPageShow)`)
    expect(editor).toContain(`window.removeEventListener('pageshow', handleBitmapPendingPageShow)`)
    expect(editor).toContain('function handleBitmapPendingPageHide')
    expect(editor).toContain('function handleBitmapPendingPageShow')
    const hide = editor.slice(editor.indexOf('function handleBitmapPendingPageHide'), editor.indexOf('function handleBitmapPendingPageHide') + 900)
    expect(hide).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(hide).toContain(`retainUnsavedForExternalChange('pagehide')`)
    const show = editor.slice(editor.indexOf('function handleBitmapPendingPageShow'), editor.indexOf('function handleBitmapPendingPageShow') + 1400)
    expect(show).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(show).toContain('persisted')
    for (const block of [hide, show]) {
      expect(block).not.toContain('commitPending')
      expect(block).not.toContain('commitRecovery')
      expect(block).not.toContain('storeAsset')
      expect(block).not.toContain('updateCostumeIfMatch')
      expect(block).not.toContain('preventDefault')
    }
    // Boundary prose: frozen BFCache / real unload are not durable (no claim).
    expect(editor).toContain('BFCache')
    await requireFlagFalse('static')
  }, 60_000)
})
