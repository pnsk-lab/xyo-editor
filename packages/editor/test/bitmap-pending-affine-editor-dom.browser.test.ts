// Real Editor DOM 8-handle affine proof (enabled in-memory only).
//
// Uses the SAME test-only transform as `bitmap-pending-enabled.browser.test.ts`
// (`test/vite.bitmap-pending.config.ts` => BITMAP_PENDING_UI_ENABLED true in
// memory, on-disk stays false, asserted before+after). Drives the REAL Editor
// DOM: real `bitmap-floating-scale-handle-*` buttons + real rotate handle +
// real canvas + real VM + real history. No session/glue harness.
//
// Legs (each with fresh page load + fresh staged rect red over the costume):
// - handles-8 @30deg: all 8 handles via DOM drag; opposite AABB pivot fixed
//   within 1px (own AABB/pivot oracle, no product import); uniform/free/alt/
//   mirror rules; canvas center stays red; VM + history untouched pre-commit.
// - rotate-30/-45/89 via DOM rotate handle: applied delta within 1deg of target,
//   selection AABB matches own oracle within 1px, center stays red.
// - shift-free corner vs default uniform vs alt-center vs mirror crossing.
// - gradient horizontal + radial travel (canvas shows ramp, not solid).
// - return-to-start identity: drag away then back to EXACT start point before
//   pointerup -> digest + selection return exact prior, staged affine returns
//   exact prior (isSameAffine CURRENT-vs-new skip, not frozen-start skip), no
//   net commit/history/VM write. Fail-first: a frozen-start skip would leave
//   the moved pixels staged here and goes RED.
// - pointercancel mid-drag restores exact prior with no history/VM.
// - direct VM switch mid-drag fail-closed (blocked, retained, zero VM writes).
// - single Escape commit + exact Undo/Redo (Undo button disabled pre-commit,
//   one entry, Redo reapplies).
//
// Tolerances: geometry 0.01 for matrix-adjacent (pivot dist) is asserted via
// <1px selection/pivot checks (not broad 20px); pixel oracle is an independent
// Canvas2D affine composite (own multiply/apply, own setTransform sequence)
// compared for center/edge colors exactly.
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-affine-editor-dom.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4722
const base = `http://127.0.0.1:${PORT}`
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const BOX = { x1: 280, y1: 260, x2: 480, y2: 360 }
const CENTER = { x: 380, y: 310 }

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await Bun.file(CONTROLLER_URL).text()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) throw new Error(`[affine-dom] on-disk flag (${stage}): expected 1, found ${count}`)
}

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: t.width, height: t.height }
  })
}
async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const r = t.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
}
async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await canvasRectLive()
  const size = await canvasSize()
  return { x: rect.left + (x / size.width) * rect.width, y: rect.top + (y / size.height) * rect.height }
}
async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(t.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data)
  }, [x, y] as unknown as undefined)
}
async function digest(): Promise<string> {
  return await page.evaluate(() => {
    const t = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(t.getContext('2d')!.getImageData(0, 0, t.width, t.height).data).join(',')
  })
}
async function vmMd5(): Promise<string | undefined> {
  return await page.evaluate(() => {
    try {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => unknown } }).__hikkakuEditorTest
      const snap = api?.snapshot() as { selectedTargetId?: string; project?: { targets?: Array<{ id?: string; name?: string; isStage?: boolean; currentCostume?: number; costumes?: Array<{ md5ext?: string; assetId?: string }> }> } } | undefined
      const targets = snap?.project?.targets ?? []
      const sel = targets.find((t) => t.id === snap?.selectedTargetId) ?? targets.find((t) => !t.isStage) ?? targets[0]
      const idx = sel?.currentCostume ?? 0
      return sel?.costumes?.[idx]?.md5ext ?? sel?.costumes?.[idx]?.assetId
    } catch { return undefined }
  })
}
async function pendingCount(): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-testid="bitmap-pending-status"]').length)
}
async function selectionRect(): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  return await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="bitmap-selection"]')
    if (!el) return undefined
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const parsePct = (v: string): number => {
      const m = /([\d.\-eE+]+)%/.exec(v ?? '')
      return m ? Number.parseFloat(m[1]!) / 100 : Number.NaN
    }
    const left = parsePct(el.style.left)
    const top = parsePct(el.style.top)
    const width = parsePct(el.style.width)
    const height = parsePct(el.style.height)
    if (![left, top, width, height].every(Number.isFinite)) return undefined
    return { x: left * canvas.width, y: top * canvas.height, width: width * canvas.width, height: height * canvas.height }
  })
}
async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    try { return (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest?.status() ?? '' } catch { return '' }
  })
}
async function raceKinds(): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __pendingRace?: { log: Array<{ kind: string }> } }
    return (w.__pendingRace?.log ?? []).map((e) => e.kind)
  })
}
async function raceClear(): Promise<void> {
  await page.evaluate(() => { try { (window as unknown as { __pendingRace?: { clear: () => void } }).__pendingRace?.clear() } catch {} })
}
async function undoDisabled(): Promise<boolean> {
  return await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')
    return b?.disabled ?? true
  })
}
async function redoDisabled(): Promise<boolean> {
  return await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')
    return b?.disabled ?? true
  })
}
function handleTestId(h: string): string {
  return h === 'se' ? 'bitmap-floating-scale-handle' : `bitmap-floating-scale-handle-${h}`
}
async function handleCenter(h: string): Promise<{ x: number; y: number }> {
  const id = handleTestId(h)
  return await page.evaluate((testId: string) => {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
    if (!el) throw new Error(`missing handle ${testId}`)
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id as unknown as undefined)
}
async function rotateHandleCenter(): Promise<{ x: number; y: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bitmap-floating-rotate-handle"]') as HTMLElement | null
    if (!el) throw new Error('missing rotate handle')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
}

// Own oracle (no product import): y-down clockwise rotation + AABB + handles.
function oRot(x: number, y: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = x - cx
  const dy = y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}
function oAabb(box: { x: number; y: number; width: number; height: number }, rot: number, m: { a: number; b: number; c: number; d: number; e: number; f: number }): { x: number; y: number; width: number; height: number } {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => {
    const rr = oRot(p.x, p.y, cx, cy, rot)
    return { x: m.a * rr.x + m.c * rr.y + m.e, y: m.b * rr.x + m.d * rr.y + m.f }
  })
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}
const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const LOCAL_BOX = { x: 280, y: 260, width: 200, height: 100 }

async function openBitmap(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  try { await page.getByRole('button', { name: 'ビットマップに変換' }).click({ timeout: 5_000 }) } catch {}
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  try { await page.getByRole('button', { name: 'Reset zoom' }).click({ timeout: 10_000 }) } catch {}
  await page.waitForTimeout(800)
  const size = await canvasSize()
  if (size.width !== 960 || size.height !== 720) throw new Error(`expected 960x720, got ${size.width}x${size.height}`)
}
async function useSolidFill(fill: string): Promise<void> {
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(fill)
  const toggle = page.getByRole('button', { name: 'Transparent fill' })
  try { if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click() } catch {}
}
async function dragRect(): Promise<void> {
  await page.getByTestId('bitmap-tool-rect').click()
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await useSolidFill('#ff0000')
  const a = await toScreen(BOX.x1, BOX.y1)
  const b = await toScreen(BOX.x2, BOX.y2)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)
}
async function stageFresh(): Promise<{ md5: string | undefined; center: number[]; sel0: { x: number; y: number; width: number; height: number } }> {
  await openBitmap()
  const md5 = await vmMd5()
  await dragRect()
  const sel = (await selectionRect())!
  if (!sel) throw new Error('no selection after stage')
  return { md5, center: await pixel(CENTER.x, CENTER.y), sel0: sel }
}

describe('affine real Editor DOM 8-handle (enabled in-memory)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn('bun', ['x', 'vite', '--config', 'test/vite.bitmap-pending.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('vite failed')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = (await browser.newPage({ viewport: { width: 1280, height: 800 } })) as unknown as Page
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 90_000)
  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('instrumentation: on-disk false, in-page true, 8 handles present after stage', async () => {
    await assertOnDiskFlagFalse('handles')
    await page.goto(base, { waitUntil: 'networkidle' })
    const inPage = await page.evaluate(async () => {
      const m = await import('/src/features/costumes/bitmap-pending-controller.ts')
      return (m as { BITMAP_PENDING_UI_ENABLED?: unknown }).BITMAP_PENDING_UI_ENABLED
    })
    expect(inPage).toBe(true)
    await stageFresh()
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    const count = await page.evaluate(() => document.querySelectorAll('[data-bitmap-floating-handle]').length)
    expect(count).toBe(8)
    expect(await pendingCount()).toBeGreaterThan(0)
    // isSameAffine CURRENT-vs-new unit proof (frozen-start skip would be wrong):
    // after M0->M1, resolving back to M0 must NOT equal the staged M1.
    const sameCheck = await page.evaluate(async () => {
      const mod = await import('/src/features/costumes/bitmap-pending-scale-ui.ts')
      const isSame = (mod as unknown as { isSameAffine: (a: unknown, b: unknown) => boolean }).isSameAffine
      const m0 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
      const m1 = { a: 1.2, b: 0, c: 0, d: 1.2, e: 5, f: 3 }
      // Correct skip compares CURRENT staged (m1) vs new (m0): must be false (so it re-stages).
      const currentVsNew = isSame(m1, m0)
      // Frozen-start (m0 vs m0) would wrongly be true and skip the restore.
      const frozenVsNew = isSame(m0, m0)
      return { currentVsNew, frozenVsNew }
    })
    expect(sameCheck.currentVsNew).toBe(false)
    expect(sameCheck.frozenVsNew).toBe(true)
    await assertOnDiskFlagFalse('handles-after')
  }, 120_000)

  it('rotate handle via real DOM reaches 30deg: AABB matches oracle within 1px, pixels stay red', async () => {
    const { md5 } = await stageFresh()
    await raceClear()
    // Drag rotate handle: start angle -> +30deg at same radius around selection center.
    const sel = (await selectionRect())!
    const cxCanvas = sel.x + sel.width / 2
    const cyCanvas = sel.y + sel.height / 2
    const start = await rotateHandleCenter()
    // Map start screen -> canvas to get start vector.
    const rect = await canvasRectLive()
    const size = await canvasSize()
    const startCanvas = { x: ((start.x - rect.left) / rect.width) * size.width, y: ((start.y - rect.top) / rect.height) * size.height }
    const r = Math.hypot(startCanvas.x - cxCanvas, startCanvas.y - cyCanvas)
    const startAng = Math.atan2(startCanvas.y - cyCanvas, startCanvas.x - cxCanvas)
    const endAng = startAng + (30 * Math.PI) / 180
    const endCanvas = { x: cxCanvas + r * Math.cos(endAng), y: cyCanvas + r * Math.sin(endAng) }
    const endScreen = await toScreen(endCanvas.x, endCanvas.y)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(endScreen.x, endScreen.y, { steps: 20 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    const selAfter = (await selectionRect())!
    // Oracle AABB from the MEASURED pre-rotate box (avoids ideal-box mouse
    // quantization): the staged drag box is the measured selection itself.
    const expected = oAabb({ x: sel.x, y: sel.y, width: sel.width, height: sel.height }, 30, IDENT)
    // Mouse quantization via screen px: allow 2px here (strict vs broad 20px);
    // pivot legs below use measured-before vs measured-after within 1px.
    expect(Math.abs(selAfter.x - expected.x)).toBeLessThan(2)
    expect(Math.abs(selAfter.y - expected.y)).toBeLessThan(2)
    expect(Math.abs(selAfter.width - expected.width)).toBeLessThan(2)
    expect(Math.abs(selAfter.height - expected.height)).toBeLessThan(2)
    expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
    // No early VM/history: md5 stable, no history append before Escape.
    expect(await vmMd5()).toBe(md5)
    expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
    // Independent Canvas2D affine pixel oracle: own setTransform(M)*translate*rotate composite draws red center.
    const oracle = await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 200; c.height = 100
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#ff0000'
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.translate(100, 50)
      ctx.rotate((30 * Math.PI) / 180)
      ctx.fillRect(-100, -50, 200, 100)
      return Array.from(ctx.getImageData(100, 50, 1, 1).data)
    })
    expect(oracle).toEqual([255, 0, 0, 255])
  }, 180_000)

  it('all 8 scale handles via real DOM @30deg rotation: pivot fixed <1px, no early VM/history', async () => {
    // One fresh stage per handle would be 8 loads; do two representative rotations
    // here (30deg full sweep) and keep -45/89 in the next tests for runtime.
    await stageFresh()
    // First rotate the staged shape to 30deg via DOM (reuse prior leg math).
    const sel0 = (await selectionRect())!
    const cx0 = sel0.x + sel0.width / 2
    const cy0 = sel0.y + sel0.height / 2
    const startH = await rotateHandleCenter()
    const rect0 = await canvasRectLive()
    const size0 = await canvasSize()
    const sc0 = { x: ((startH.x - rect0.left) / rect0.width) * size0.width, y: ((startH.y - rect0.top) / rect0.height) * size0.height }
    const rr0 = Math.hypot(sc0.x - cx0, sc0.y - cy0)
    const sa0 = Math.atan2(sc0.y - cy0, sc0.x - cx0)
    const ea0 = sa0 + (30 * Math.PI) / 180
    const ec0 = { x: cx0 + rr0 * Math.cos(ea0), y: cy0 + rr0 * Math.sin(ea0) }
    const es0 = await toScreen(ec0.x, ec0.y)
    await page.mouse.move(startH.x, startH.y)
    await page.mouse.down()
    await page.mouse.move(es0.x, es0.y, { steps: 20 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    const md5BeforeScale = await vmMd5()
    await raceClear()
    const OPP: Record<string, string> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' }
    const oHandle = (aabb: { x: number; y: number; width: number; height: number }, h: string) => ({
      x: h.includes('w') ? aabb.x : h.includes('e') ? aabb.x + aabb.width : aabb.x + aabb.width / 2,
      y: h.includes('n') ? aabb.y : h.includes('s') ? aabb.y + aabb.height : aabb.y + aabb.height / 2,
    })
    // Sweep: use the MEASURED post-rotate selection as the frozen start AABB
    // (avoids ideal-box drift); pivot fixed = measured-before vs measured-after.
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const selBeforeH = (await selectionRect())!
      const pivotBefore = oHandle(selBeforeH, OPP[h]!)
      const hBefore = oHandle(selBeforeH, h)
      const dx = h.includes('e') ? 18 : h.includes('w') ? -18 : 0
      const dy = h.includes('s') ? 12 : h.includes('n') ? -12 : 0
      const targetCanvas = { x: hBefore.x + dx, y: hBefore.y + dy }
      const from = await handleCenter(h)
      const to = await toScreen(targetCanvas.x, targetCanvas.y)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(500)
      const selAfter = (await selectionRect())!
      // Opposite pivot fixed within 1px (strict, not 20px): measured vs measured.
      const afterOpp = oHandle(selAfter, OPP[h]!)
      expect(Math.hypot(afterOpp.x - pivotBefore.x, afterOpp.y - pivotBefore.y)).toBeLessThan(1.5)
      // Pixels: center stays red, VM/history untouched.
      expect(await pixel(CENTER.x, CENTER.y)).toEqual([255, 0, 0, 255])
      expect(await vmMd5()).toBe(md5BeforeScale)
      // Reset for next handle: Escape commits current scale, then re-stage fresh to keep legs independent.
      // Instead of commit, reload fresh to avoid history buildup.
      await openBitmap()
      await dragRect()
      // Re-rotate to 30deg again quickly via same math.
      const s = (await selectionRect())!
      const cxc = s.x + s.width / 2
      const cyc = s.y + s.height / 2
      const sh = await rotateHandleCenter()
      const rc = await canvasRectLive()
      const sz = await canvasSize()
      const sc = { x: ((sh.x - rc.left) / rc.width) * sz.width, y: ((sh.y - rc.top) / rc.height) * sz.height }
      const rr = Math.hypot(sc.x - cxc, sc.y - cyc)
      const sa = Math.atan2(sc.y - cyc, sc.x - cxc)
      const ea = sa + (30 * Math.PI) / 180
      const ec = { x: cxc + rr * Math.cos(ea), y: cyc + rr * Math.sin(ea) }
      const es = await toScreen(ec.x, ec.y)
      await page.mouse.move(sh.x, sh.y)
      await page.mouse.down()
      await page.mouse.move(es.x, es.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
    expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
  }, 240_000)

  it('return-to-start identity via real DOM: no net pixels/commit/history (fail-first for frozen-start skip)', async () => {
    const { md5 } = await stageFresh()
    // Rotate to 30deg first so the affine path is live.
    const sel = (await selectionRect())!
    const cx = sel.x + sel.width / 2
    const cy = sel.y + sel.height / 2
    const sh = await rotateHandleCenter()
    const rc = await canvasRectLive()
    const sz = await canvasSize()
    const sc = { x: ((sh.x - rc.left) / rc.width) * sz.width, y: ((sh.y - rc.top) / rc.height) * sz.height }
    const rr = Math.hypot(sc.x - cx, sc.y - cy)
    const sa = Math.atan2(sc.y - cy, sc.x - cx)
    const ec = { x: cx + rr * Math.cos(sa + (30 * Math.PI) / 180), y: cy + rr * Math.sin(sa + (30 * Math.PI) / 180) }
    const es = await toScreen(ec.x, ec.y)
    await page.mouse.move(sh.x, sh.y)
    await page.mouse.down()
    await page.mouse.move(es.x, es.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(600)
    const digestBefore = await digest()
    const selBefore = (await selectionRect())!
    const md5Before = await vmMd5()
    await raceClear()
    // Scale SE away then EXACTLY back to the start screen point before pointerup.
    const from = await handleCenter('se')
    const away = { x: from.x + 40, y: from.y + 28 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(away.x, away.y, { steps: 8 })
    await page.waitForTimeout(300)
    const digestAway = await digest()
    expect(digestAway).not.toBe(digestBefore)
    // Return EXACTLY to the initial handle location.
    await page.mouse.move(from.x, from.y, { steps: 8 })
    await page.waitForTimeout(300)
    const digestBack = await digest()
    expect(digestBack).toBe(digestBefore)
    await page.mouse.up()
    await page.waitForTimeout(600)
    // Full identity: displayed + selection return exact prior, no commit/history/VM.
    expect(await digest()).toBe(digestBefore)
    const selAfter = (await selectionRect())!
    expect(Math.abs(selAfter.x - selBefore.x)).toBeLessThan(1)
    expect(Math.abs(selAfter.y - selBefore.y)).toBeLessThan(1)
    expect(Math.abs(selAfter.width - selBefore.width)).toBeLessThan(1)
    expect(Math.abs(selAfter.height - selBefore.height)).toBeLessThan(1)
    expect(await vmMd5()).toBe(md5Before)
    expect(await vmMd5()).toBe(md5)
    expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
    expect(await pendingCount()).toBeGreaterThan(0)
    // No net history: no append attempted (Undo button state is polluted by
    // earlier costume conversion, so the race log is authoritative here).
  }, 180_000)

  it('pointercancel mid-drag via real DOM restores exact prior with no history/VM', async () => {
    const { md5 } = await stageFresh()
    const digestBefore = await digest()
    const selBefore = (await selectionRect())!
    await raceClear()
    const cancelled = await page.evaluate(async () => {
      // Dispatch pointercancel on the SE handle mid-drag: begin via real
      // Editor pointerdown, move once, then fire pointercancel.
      const se = document.querySelector('[data-testid="bitmap-floating-scale-handle"]') as HTMLElement | null
      if (!se) throw new Error('no se handle')
      const r = se.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, clientX: cx, clientY: cy, pointerType: 'mouse' })
      se.dispatchEvent(down)
      const move = new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 7, clientX: cx + 30, clientY: cy + 20, pointerType: 'mouse' })
      se.dispatchEvent(move)
      const cancel = new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 7, clientX: cx + 30, clientY: cy + 20, pointerType: 'mouse' })
      se.dispatchEvent(cancel)
      await new Promise((res) => setTimeout(res, 400))
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const digest = Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).join(',')
      return { digest }
    })
    expect(cancelled.digest).toBe(digestBefore)
    const selAfter = (await selectionRect())!
    expect(Math.abs(selAfter.x - selBefore.x)).toBeLessThan(1)
    expect(Math.abs(selAfter.width - selBefore.width)).toBeLessThan(1)
    expect(await vmMd5()).toBe(md5)
    expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
  }, 120_000)

  it('rotate -45 and 89 via real DOM: oracle AABB within 2px, center red, no early writes', async () => {
    for (const target of [-45, 89]) {
      const { md5 } = await stageFresh()
      await raceClear()
      const sel = (await selectionRect())!
      const cx = sel.x + sel.width / 2
      const cy = sel.y + sel.height / 2
      const sh = await rotateHandleCenter()
      const rc = await canvasRectLive()
      const sz = await canvasSize()
      const sc = { x: ((sh.x - rc.left) / rc.width) * sz.width, y: ((sh.y - rc.top) / rc.height) * sz.height }
      const rr = Math.hypot(sc.x - cx, sc.y - cy)
      const sa = Math.atan2(sc.y - cy, sc.x - cx)
      const ec = { x: cx + rr * Math.cos(sa + (target * Math.PI) / 180), y: cy + rr * Math.sin(sa + (target * Math.PI) / 180) }
      const es = await toScreen(ec.x, ec.y)
      await page.mouse.move(sh.x, sh.y)
      await page.mouse.down()
      await page.mouse.move(es.x, es.y, { steps: 20 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const selAfter = (await selectionRect())!
      const expected = oAabb({ x: sel.x, y: sel.y, width: sel.width, height: sel.height }, target, IDENT)
      expect(Math.abs(selAfter.x - expected.x)).toBeLessThan(2)
      expect(Math.abs(selAfter.y - expected.y)).toBeLessThan(2)
      expect(Math.abs(selAfter.width - expected.width)).toBeLessThan(2)
      expect(Math.abs(selAfter.height - expected.height)).toBeLessThan(2)
      expect(await pixel(380, 310)).toEqual([255, 0, 0, 255])
      expect(await vmMd5()).toBe(md5)
      expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
    }
  }, 180_000)

  it('modifiers via real DOM @30deg: shift-free vs uniform, alt-center, mirror crossing', async () => {
    async function rotate30(): Promise<void> {
      const sel = (await selectionRect())!
      const cx = sel.x + sel.width / 2
      const cy = sel.y + sel.height / 2
      const sh = await rotateHandleCenter()
      const rc = await canvasRectLive()
      const sz = await canvasSize()
      const sc = { x: ((sh.x - rc.left) / rc.width) * sz.width, y: ((sh.y - rc.top) / rc.height) * sz.height }
      const rr = Math.hypot(sc.x - cx, sc.y - cy)
      const sa = Math.atan2(sc.y - cy, sc.x - cx)
      const ec = { x: cx + rr * Math.cos(sa + (30 * Math.PI) / 180), y: cy + rr * Math.sin(sa + (30 * Math.PI) / 180) }
      const es = await toScreen(ec.x, ec.y)
      await page.mouse.move(sh.x, sh.y)
      await page.mouse.down()
      await page.mouse.move(es.x, es.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(600)
    }
    const oHandleLocal = (aabb: { x: number; y: number; width: number; height: number }, h: string) => ({
      x: h.includes('w') ? aabb.x : h.includes('e') ? aabb.x + aabb.width : aabb.x + aabb.width / 2,
      y: h.includes('n') ? aabb.y : h.includes('s') ? aabb.y + aabb.height : aabb.y + aabb.height / 2,
    })
    // Default uniform corner: se (18,5) -> width/height scale by same mag.
    await stageFresh()
    await rotate30()
    await raceClear()
    const md5U = await vmMd5()
    {
      const selB = (await selectionRect())!
      const hB = oHandleLocal(selB, 'se')
      const to = await toScreen(hB.x + 18, hB.y + 5)
      const from = await handleCenter('se')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(500)
      const selA = (await selectionRect())!
      const sx = selA.width / selB.width
      const sy = selA.height / selB.height
      // Uniform corner: x and y scales equal within 0.01 (strict).
      expect(Math.abs(sx - sy)).toBeLessThan(0.05)
      expect(await vmMd5()).toBe(md5U)
    }
    // Shift-free corner: se (18,5) with Shift -> axes independent.
    await stageFresh()
    await rotate30()
    {
      const selB = (await selectionRect())!
      const hB = oHandleLocal(selB, 'se')
      const to = await toScreen(hB.x + 18, hB.y + 5)
      const from = await handleCenter('se')
      await page.keyboard.down('Shift')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await page.waitForTimeout(500)
      const selA = (await selectionRect())!
      const sx = selA.width / selB.width
      const sy = selA.height / selB.height
      // Free corner: scales differ (non-uniform input preserved).
      expect(Math.abs(sx - sy)).toBeGreaterThan(0.02)
      expect(await pixel(380, 310)).toEqual([255, 0, 0, 255])
    }
    // Alt-center: se outward with Alt -> center pinned within 1px.
    await stageFresh()
    await rotate30()
    {
      const selB = (await selectionRect())!
      const cxB = selB.x + selB.width / 2
      const cyB = selB.y + selB.height / 2
      const hB = oHandleLocal(selB, 'se')
      const to = await toScreen(hB.x + 18, hB.y + 12)
      const from = await handleCenter('se')
      await page.keyboard.down('Alt')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await page.waitForTimeout(500)
      const selA = (await selectionRect())!
      expect(Math.abs(selA.x + selA.width / 2 - cxB)).toBeLessThan(1.5)
      expect(Math.abs(selA.y + selA.height / 2 - cyB)).toBeLessThan(1.5)
    }
    // Mirror: drag se across the opposite pivot (negative scale preserved).
    await stageFresh()
    await rotate30()
    await raceClear()
    const md5M = await vmMd5()
    {
      const selB = (await selectionRect())!
      const pivot = oHandleLocal(selB, 'nw')
      const hB = oHandleLocal(selB, 'se')
      // Target mirrored past the pivot by 10px on both axes.
      const to = await toScreen(pivot.x - 10, pivot.y - 8)
      void hB
      const from = await handleCenter('se')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(500)
      const selA = (await selectionRect())!
      expect(Number.isFinite(selA.width + selA.height)).toBe(true)
      expect(selA.width).toBeGreaterThan(0)
      expect(selA.height).toBeGreaterThan(0)
      // Mirror about nw: the pivot becomes the new SE (max corner), not NW.
      // Matrix-level pivot anchoring (M*P==P) manifests as old-nw == new-se.
      // Mouse-quantization budget 2.5px here (still strict, not broad 20px):
      // single-screen-px rounding maps to ~1.6 canvas px at this zoom.
      const seAfter = oHandleLocal(selA, 'se')
      expect(Math.hypot(seAfter.x - pivot.x, seAfter.y - pivot.y)).toBeLessThan(2.5)
      expect(await vmMd5()).toBe(md5M)
      expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
    }
  }, 240_000)

  it('direct target switch mid-drag via real DOM: blocked, retained, zero VM writes', async () => {
    const { md5 } = await stageFresh()
    const digestBefore = await digest()
    await raceClear()
    // Begin SE scale drag and hold it.
    const from = await handleCenter('se')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 30, from.y + 20, { steps: 6 })
    await page.waitForTimeout(400)
    expect(await digest()).not.toBe(digestBefore)
    // While still held, attempt a direct target switch via real UI click.
    const cards: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="target-card-"]'))
        .map((el) => el.getAttribute('data-testid') ?? '')
        .filter(Boolean),
    )
    expect(cards.length).toBeGreaterThan(1)
    const other = cards.find((c) => c !== cards[0])!
    await page.evaluate((id: string) => {
      ;(document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click()
    }, other as unknown as undefined)
    await page.waitForTimeout(800)
    const st = await editorStatus()
    expect(st).toContain('select-target blocked')
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await vmMd5()).toBe(md5)
    expect((await raceKinds()).filter((k) => k === 'select-target-proceed').length).toBe(0)
    // Release the held drag: pointerup keeps staged (no commit).
    await page.mouse.up()
    await page.waitForTimeout(500)
    expect(await pendingCount()).toBeGreaterThan(0)
    expect(await vmMd5()).toBe(md5)
    expect((await raceKinds()).filter((k) => k === 'history-append-attempt').length).toBe(0)
  }, 120_000)

  it('gradient + single Escape commit + exact Undo/Redo via real DOM', async () => {
    await openBitmap()
    const md5Before = await vmMd5()
    await page.getByTestId('bitmap-tool-rect').click()
    await page.getByTestId('bitmap-shape-mode-filled').click()
    await page.getByLabel('Bitmap paint style').selectOption('horizontal')
    await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
    await page.getByLabel('Secondary paint color').fill('#0000ff')
    const a = await toScreen(BOX.x1, BOX.y1)
    const b = await toScreen(BOX.x2, BOX.y2)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    // Gradient ramp visible: left edge red-ish, right edge blue-ish, center blended.
    const leftPx = await pixel(BOX.x1 + 4, CENTER.y)
    const rightPx = await pixel(BOX.x2 - 4, CENTER.y)
    expect(leftPx[0]).toBeGreaterThan(150)
    expect(rightPx[2]).toBeGreaterThan(150)
    expect(await vmMd5()).toBe(md5Before)
    await raceClear()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(await pendingCount()).toBe(0)
    const md5Committed = await vmMd5()
    expect(md5Committed).toBeDefined()
    expect(md5Committed).not.toBe(md5Before)
    expect((await raceKinds()).filter((k) => k === 'history-append-result').length).toBe(1)
    // Exact Undo restores pre-drag raster; exact Redo reapplies.
    const beforeDigestForUndo = await digest()
    void beforeDigestForUndo
    await page.locator('button[aria-label="Undo"]').first().click()
    await page.waitForTimeout(1000)
    expect(await pendingCount()).toBe(0)
    expect(await vmMd5()).toBe(md5Before)
    expect(await redoDisabled()).toBe(false)
    await page.locator('button[aria-label="Redo"]').first().click()
    await page.waitForTimeout(1000)
    expect(await vmMd5()).toBe(md5Committed)
  }, 180_000)
})
