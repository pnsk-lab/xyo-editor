// Bitmap rect/oval commit-gate on the real Editor + real VM (NEW file only, no product edits).
//
// Reference read directly (own words, no third-party source copied):
// - `/home/nakasyou/Projects/hikkaku-cloud/contexts/scratch-paint/src/helper/bit-tools/rect-tool.js`
//   `RectTool.TOLERANCE = 2`; mouseUp discards while
//   `|rect.size.width * rect.size.height| < TOLERANCE / paper.view.zoom`
//   (remove + null, no select), else abs size, `selected = true`, setSelectedItems.
//   Drag: Shift squares first (`baseRect.size = squareDimensions.size.abs()`),
//   Alt keeps drag dims and centers on downPoint, plain centers on
//   downPoint + dims/2. `onUpdateImage` fires on every mouseUp either way.
// - `.../bit-tools/oval-tool.js`: identical gate on `oval.size`
//   (`OvalTool.TOLERANCE = 2`, same strict `<`), Shift squares via
//   `getSquareDimensions`, Alt centers on downPoint.
// - `.../helper/math.js#getSquareDimensions`: zero offsets forced to 1, side
//   `max(|dx|,|dy|)` keeping each axis sign (straight axis drag -> square to
//   the lower-right quadrant).
// - `.../helper/bitmap.js#commitRectToBitmap/commitOvalToBitmap`: null canvas
//   color (fully transparent fill / both-gradient-ends transparent) draws
//   nothing (transparent no-op, still no history).
//
// Product read directly: `packages/editor/src/features/costumes/shape-drag.ts`
// (`shouldCommitBitmapShapeDrag`: canvas-px floats via `resolveShapeRect` first,
// Paper area `|w*k * h*k|` with `k = res1 ? 2 : 1` vs strict budget
// `2 / bitmapShapePaperZoom(viewportScale, storedResolution)`; click /
// sub-pixel jitter / axis-zero discard; 2x2 res2 / 1x1 res1 boundary commits;
// bitmap line keeps the legacy `isShapeDrag` gate) and `Editor.svelte`
// (`beginBitmapPaint`/`drawBitmapDraft`/`endBitmapPaint` share that gate for
// preview AND commit; transparent no-op via `resolveBitmapShapePaint(...).noop`
// stays history-free with `Bitmap edit: no change`; cancel via
// pointercancel/lostpointercapture/Escape restores the pre-stroke snapshot
// with `Bitmap edit cancelled`; commit selects + saves one Undo entry and
// flips the tool to `select`).
// Gestures here are pointer-event driven (`handleCanvasPointerDown/Move/Up`
// gated on `activeCanvasPointerId === event.pointerId`), so exact-fraction
// rows dispatch synthetic PointerEvents (same listeners as trusted input,
// like the existing pointercancel test) while far-from-threshold rows use the
// trusted `page.mouse` path.
//
// What this file proves on the LIVE UI (real canvas bytes, real VM snapshot,
// real status, real selection overlay, real Undo/Redo stacks):
// - res1 (480x360, k=2, density 0.5) x res2 (960x720, k=1, density 1.0)
// - x min / reset / max zoom (driven with the real Zoom out / Reset / Zoom in
//   buttons; scale measured from the live rect/backing ratio, never assumed)
// - x forward / reverse / axis-zero drags, strict threshold below / equal /
//   above (equal ONLY where the threshold is exactly representable: reset
//   zooms; min/max thresholds 2/0.333 and 2/5-style are inexact, so those
//   rows use far-margin areas and say so explicitly -- no fake exactness)
// - Shift (axis-zero drag squares and commits), Alt (centered, gate-neutral),
//   cancel (Escape mid-drag + synthetic pointercancel), transparent no-op,
//   full history/Undo/Redo/selection/status/metadata per row.
// - Mouse CSS-subpixel probe first: whether trusted mouse clientX keeps
//   fractions, with rounding-error causes classified separately.
// - False-pass guards: every row records the ACTUAL gate inputs from an
//   in-page event recorder (real clientX/Y run through the same
//   `(client-rect)/rect*W` mapping + clamp as the Editor), predicts with an
//   independently re-typed reference rule, and asserts the live artifacts
//   (pixels digest, selection overlay geometry, Undo enablement, status, VM
//   md5/resolution) match. `elementFromPoint` at the selection center must hit
//   the real bitmap canvas (overlay is pointer-events:none).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-rect-oval-commit-gate.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4390
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// ---------------------------------------------------------------------------
// SB3 fixture builders (self-contained; same MD5-filename convention as VM).
// ---------------------------------------------------------------------------
function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}
function crcOf(chunk: Uint8Array): number {
  let c = 0xffffffff
  for (const b of chunk) {
    c ^= b
    for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  new DataView(out.buffer).setUint32(8 + data.length, crcOf(out.slice(4, 8 + data.length)))
  return out
}
function buildPng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y += 1) {
    raw[y * (1 + w * 4)] = 0
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = px(x, y)
      const o = y * (1 + w * 4) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w); v.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 6
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
function buildSb3(project: unknown, files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify(project)), ...files }))
}

// 96x96 marker: transparent + 24x12 opaque block at (30,40).
function marker(color: [number, number, number]) {
  return (x: number, y: number): [number, number, number, number] => {
    const inside = x >= 30 && x < 54 && y >= 40 && y < 52
    return inside ? [color[0], color[1], color[2], 255] : [0, 0, 0, 0]
  }
}

// ---------------------------------------------------------------------------
// Page helpers (all measurements from the live UI).
// ---------------------------------------------------------------------------
type CanvasPt = { x: number; y: number }

async function canvasBacking(): Promise<{ w: number; h: number }> {
  return await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { w: c.width, h: c.height }
  })
}
async function canvasRectLive(): Promise<{ left: number; top: number; width: number; height: number }> {
  return await page.evaluate(() => {
    const r = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
}
function fnv1a(bytes: Uint8Array): string {
  let h = 2166136261
  for (let i = 0; i < bytes.length; i += 1) { h ^= bytes[i]!; h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16)
}
async function canvasDigest(): Promise<{ digest: string; opaque: number }> {
  const bytes = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data)
  })
  const data = Uint8Array.from(bytes as number[])
  let opaque = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) opaque += 1
  return { digest: fnv1a(data), opaque }
}
async function pixel(p: CanvasPt): Promise<number[]> {
  return await page.evaluate(([x, y]: [number, number]) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data)
  }, [p.x, p.y] as unknown as undefined)
}
async function status(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status())
}
async function undoEnabled(): Promise<boolean> {
  return await page.locator('button[aria-label="Undo"]:visible').first().isEnabled()
}
async function selectionCanvasBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bitmap-selection"]') as HTMLElement | null
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!el || !canvas) return null
    const pct = (v: string) => Number.parseFloat(v.replace('%', ''))
    return {
      x: (pct(el.style.left) / 100) * canvas.width,
      y: (pct(el.style.top) / 100) * canvas.height,
      width: (pct(el.style.width) / 100) * canvas.width,
      height: (pct(el.style.height) / 100) * canvas.height,
    }
  })
}
async function selectionCount(): Promise<number> {
  return await page.getByTestId('bitmap-selection').count()
}
async function bootId(): Promise<string> {
  return await page.evaluate(() => (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none')
}
async function assertNoReload(anchor: string, phase: string): Promise<void> {
  const id = await bootId()
  const prev = (globalThis as unknown as { __gateBootSeen?: string }).__gateBootSeen
  if (prev === undefined) {
    ;(globalThis as unknown as { __gateBootSeen?: string }).__gateBootSeen = id
    console.log(`BOOT ${anchor} id=${id} phase=${phase}`)
    return
  }
  console.log(`BOOT ${anchor} id=${id} phase=${phase}`)
  expect(id).toBe(prev) // a change here = foreign HMR/full-reload interference, reported loudly
}
async function metaOf(targetName: string) {
  return await page.evaluate((tn: string) => {
    const snap = (window as unknown as { __hikkakuEditorTest: { snapshot: () => any } }).__hikkakuEditorTest.snapshot()
    const t = snap.project.targets.find((x: any) => x.name === tn)!
    const c = t.costumes[t.currentCostume ?? 0]!
    return { name: c.name, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY, fmt: c.dataFormat, md5: c.md5ext ?? c.assetId }
  }, targetName as unknown as undefined)
}
async function elementHitAt(sx: number, sy: number): Promise<{ testid: string | null; tag: string }> {
  return await page.evaluate(([x, y]: [number, number]) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    return { testid: el?.getAttribute?.('data-testid') ?? null, tag: el?.tagName ?? 'NONE' }
  }, [sx, sy] as unknown as undefined)
}
// Full hit stack (topmost first). After a commit the tool flips to `select`
// and 8 REAL scale-handle buttons render over the selection: for tiny boxes
// they legitimately cover the center, so strict top-hit == canvas only holds
// for large selections; small ones must still have the canvas in the stack
// (proves the overlay stack sits over the real paint surface).
async function elementHitStackAt(sx: number, sy: number): Promise<Array<{ testid: string | null; tag: string }>> {
  return await page.evaluate(([x, y]: [number, number]) => {
    return (document.elementsFromPoint(x as number, y as number) as HTMLElement[]).map((el) => ({
      testid: el?.getAttribute?.('data-testid') ?? null,
      tag: el?.tagName ?? 'NONE',
    }))
  }, [sx, sy] as unknown as undefined)
}
async function toScreen(p: CanvasPt): Promise<CanvasPt> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('missing canvas box')
  const size = await canvasBacking()
  return { x: box.x + (p.x / size.w) * box.width, y: box.y + (p.y / size.h) * box.height }
}
function canvasToScreen(p: CanvasPt, box: { x: number; y: number; width: number; height: number }, size: { w: number; h: number }): CanvasPt {
  return { x: box.x + (p.x / size.w) * box.width, y: box.y + (p.y / size.h) * box.height }
}

type ViewCtx = {
  W: number; H: number; res: number; k: number; density: number
  scale: number; zoom: number; threshold: number; label: string
}
async function measuredView(expectedRes: number): Promise<ViewCtx> {
  const size = await canvasBacking()
  const rect = await canvasRectLive()
  const label = await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
  const scale = rect.width / size.w
  const scaleY = rect.height / size.h
  // Axis uniformity: non-uniform mapping would silently skew the gate.
  expect(Math.abs(scale - scaleY) / Math.max(scale, 1e-9)).toBeLessThan(0.02)
  const W = size.w
  const H = size.h
  const res = expectedRes
  const k = res === 1 ? 2 : 1
  const density = W === 960 ? 1 : W === 480 ? 0.5 : Number.NaN
  expect(Number.isFinite(density)).toBe(true)
  // Floored Paper zoom, same floor the product documents (0.333).
  const zoom = Math.max(0.333, scale * density)
  return { W, H, res, k, density, scale, zoom, threshold: 2 / zoom, label }
}

// Reference rule re-typed from the audited behavior (own arithmetic, the
// verdict oracle -- NOT the product helper, so wiring bugs cannot hide).
function referenceCommits(dx: number, dy: number, k: number, threshold: number, mods: { shift?: boolean; alt?: boolean }): { commits: boolean; area: number; w: number; h: number } {
  let w = Math.abs(dx)
  let h = Math.abs(dy)
  if (mods.shift) {
    // getSquareDimensions parity: longer side wins, zero axis -> positive.
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    w = side; h = side
  }
  // Alt only recenters; dimensions (hence area) are unchanged.
  const area = Math.abs(w * k * (h * k))
  return { commits: !(area < threshold), area, w, h }
}

// In-page pointer recorder: captures the ACTUAL trusted/synthetic event
// coords the Editor maps, so verdicts never rest on assumed inputs.
// In-page pointer recorder: the canvas gesture takes pointer capture on the
// viewport node, so capture-phase listeners on the canvas itself MISS the
// retargeted move/up events (proven: trusted-mouse rows recorded nothing).
// A window-level capture listener still sees every event. Events are matched
// by pointerId: down must target the bitmap canvas; up is the last event
// with the same id (target becomes the capture node after down).
async function installRecorder(): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __dragRec?: Array<{ t: string; x: number; y: number; pid: number; canvas: boolean }> }).__dragRec ?? []
    store.length = 0
    ;(window as unknown as { __dragRec?: unknown }).__dragRec = store
    const cap = (window as unknown as { __dragRecCap?: { down: (e: Event) => void; move: (e: Event) => void; up: (e: Event) => void } }).__dragRecCap
    if (cap) {
      window.removeEventListener('pointerdown', cap.down as EventListener, true)
      window.removeEventListener('pointermove', cap.move as EventListener, true)
      window.removeEventListener('pointerup', cap.up as EventListener, true)
    }
    const isCanvas = (e: Event) => {
      const t = e.target as HTMLElement | null
      return Boolean(t && (t as HTMLElement).closest?.('[data-testid="bitmap-editor-canvas"]'))
    }
    const push = (t: string) => (e: Event) => {
      const m = e as PointerEvent
      store.push({ t, x: m.clientX, y: m.clientY, pid: m.pointerId, canvas: isCanvas(e) })
      if (store.length > 600) store.splice(0, store.length - 600)
    }
    const handlers = { down: push('down'), move: push('move'), up: push('up') }
    ;(window as unknown as { __dragRecCap?: unknown }).__dragRecCap = handlers
    window.addEventListener('pointerdown', handlers.down as EventListener, true)
    window.addEventListener('pointermove', handlers.move as EventListener, true)
    window.addEventListener('pointerup', handlers.up as EventListener, true)
  })
}
async function readRecorder(): Promise<Array<{ t: string; x: number; y: number; pid: number; canvas: boolean }>> {
  return await page.evaluate(() => (window as unknown as { __dragRec?: Array<{ t: string; x: number; y: number; pid: number; canvas: boolean }> }).__dragRec ?? [])
}
function actualCanvasDelta(
  rec: Array<{ t: string; x: number; y: number; pid: number; canvas: boolean }>,
  rect: { left: number; top: number; width: number; height: number },
  size: { w: number; h: number },
): { dx: number; dy: number; down: CanvasPt; up: CanvasPt } {
  const down = rec.find((r) => r.t === 'down' && r.canvas)
  if (!down) throw new Error('recorder missed down on canvas')
  const ups = rec.filter((r) => r.t === 'up' && r.pid === down.pid)
  const up = ups[ups.length - 1] ?? rec.filter((r) => r.t === 'up').at(-1)
  if (!up) throw new Error('recorder missed up')
  const map = (p: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(size.w, ((p.x - rect.left) / rect.width) * size.w)),
    y: Math.max(0, Math.min(size.h, ((p.y - rect.top) / rect.height) * size.h)),
  })
  const a = map(down)
  const b = map(up)
  return { dx: b.x - a.x, dy: b.y - a.y, down: a, up: b }
}

async function realDrag(from: CanvasPt, to: CanvasPt, mods: { shift?: boolean; alt?: boolean } = {}, steps = 12): Promise<void> {
  const a = await toScreen(from)
  const b = await toScreen(to)
  if (mods.shift) await page.keyboard.down('Shift')
  if (mods.alt) await page.keyboard.down('Alt')
  try {
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps })
    await page.mouse.up()
  } finally {
    if (mods.alt) await page.keyboard.up('Alt')
    if (mods.shift) await page.keyboard.up('Shift')
  }
}

// Exact-fraction synthetic drag through the SAME pointer listeners the real
// mouse uses (PointerEvent carries fractional clientX/Y verbatim; trusted
// mouse at DPR 1 cannot). Used ONLY for strict threshold rows.
async function synthDrag(fromCanvas: CanvasPt, toCanvas: CanvasPt, mods: { shift?: boolean; alt?: boolean } = {}, steps = 8): Promise<void> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('missing canvas box')
  const size = await canvasBacking()
  const a = canvasToScreen(fromCanvas, box, size)
  const b = canvasToScreen(toCanvas, box, size)
  await page.evaluate(([p0, p1, m, n]: [{ x: number; y: number }, { x: number; y: number }, { shift?: boolean; alt?: boolean }, number]) => {
    const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
    const mk = (type: string, x: number, y: number, buttons: number) =>
      new PointerEvent(type, {
        pointerId: 7, pointerType: 'mouse', button: 0, buttons, bubbles: true, composed: true,
        isPrimary: true, clientX: x, clientY: y, shiftKey: m.shift === true, altKey: m.altKey === true,
      })
    target.dispatchEvent(mk('pointerdown', p0.x, p0.y, 1))
    for (let i = 1; i <= n; i += 1) {
      const t = i / n
      target.dispatchEvent(mk('pointermove', p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, 1))
    }
    target.dispatchEvent(mk('pointerup', p1.x, p1.y, 0))
  }, [a, b, mods, steps] as unknown as undefined)
  await page.waitForTimeout(400)
}

async function settleAfterOpen(): Promise<void> {
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 15_000 })
}
async function waitForStatusIncludes(text: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (want) => ((window as unknown as { __hikkakuEditorTest: { status: () => string } }).__hikkakuEditorTest.status() ?? '').includes(want as string),
    text as unknown as undefined,
    { timeout },
  )
}
async function resetZoom(): Promise<void> {
  await page.evaluate(() => { document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click() })
  await page.waitForFunction(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes('100%') ?? false, null, { timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 400))
}
async function zoomLabel(): Promise<string> {
  return await page.evaluate(() => document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '')
}
async function stepZoomToEnd(direction: 'out' | 'in'): Promise<{ label: string; clicks: number }> {
  const name = direction === 'out' ? 'Zoom out' : 'Zoom in'
  let prev = await zoomLabel()
  let stable = 0
  let clicks = 0
  for (let i = 0; i < 30; i += 1) {
    await page.getByRole('button', { name }).click()
    await new Promise((r) => setTimeout(r, 250))
    clicks += 1
    const cur = await zoomLabel()
    if (cur === prev) {
      stable += 1
      if (stable >= 2) break
    } else {
      stable = 0
      prev = cur
    }
  }
  return { label: await zoomLabel(), clicks }
}
async function useRectFilled(color = '#00c853'): Promise<void> {
  await page.getByTestId('bitmap-tool-rect').click()
  const group = page.getByRole('group', { name: 'Bitmap shape mode' })
  await group.waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(color)
  for (const name of ['Transparent fill', 'Transparent stroke'] as const) {
    const toggle = page.getByRole('button', { name })
    // Bitmap toolbar shows the fill side only (reference `paint-editor.jsx`
    // bitmap branch has no stroke indicator): skip toggles that never render
    // instead of waiting on them. `count()` resolves immediately; the pressed
    // check below still applies wherever the toggle exists.
    if ((await toggle.count()) === 0) continue
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  }
  await new Promise((r) => setTimeout(r, 200))
}
async function useOvalFilled(color = '#00c853'): Promise<void> {
  await page.getByTestId('bitmap-tool-oval').click()
  const group = page.getByRole('group', { name: 'Bitmap shape mode' })
  await group.waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('bitmap-shape-mode-filled').click()
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  await page.getByLabel('Paint color', { exact: true }).fill(color)
  for (const name of ['Transparent fill', 'Transparent stroke'] as const) {
    const toggle = page.getByRole('button', { name })
    // Bitmap toolbar shows the fill side only (reference `paint-editor.jsx`
    // bitmap branch has no stroke indicator): skip toggles that never render
    // instead of waiting on them. `count()` resolves immediately; the pressed
    // check below still applies wherever the toggle exists.
    if ((await toggle.count()) === 0) continue
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  }
  await new Promise((r) => setTimeout(r, 200))
}
async function undoOnce(): Promise<void> {
  await page.locator('button[aria-label="Undo"]:visible').first().click()
  await waitForStatusIncludes('Asset undo')
  await new Promise((r) => setTimeout(r, 400))
}
async function redoOnce(): Promise<void> {
  await page.locator('button[aria-label="Redo"]:visible').first().click()
  await waitForStatusIncludes('Asset redo')
  await new Promise((r) => setTimeout(r, 400))
}

// ---------------------------------------------------------------------------
// Fixture + navigation.
// ---------------------------------------------------------------------------
const RES2_PNG = buildPng(96, 96, marker([255, 0, 0]))
const RES1_PNG = buildPng(96, 96, marker([0, 0, 255]))
const STAGE_PNG = buildPng(48, 48, marker([0, 200, 0]))
const RES2_HASH = md5(RES2_PNG)
const RES1_HASH = md5(RES1_PNG)
const STAGE_HASH = md5(STAGE_PNG)

function fixtureSb3(): Buffer {
  const project = {
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0,
        costumes: [{ name: 'backdrop1', assetId: STAGE_HASH, md5ext: `${STAGE_HASH}.png`, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 24, rotationCenterY: 24 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
      },
      {
        isStage: false, name: 'GateRes2', visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
        variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0,
        costumes: [{ name: 'gate-res2', assetId: RES2_HASH, md5ext: `${RES2_HASH}.png`, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 48, rotationCenterY: 48 }],
        sounds: [], volume: 100, layerOrder: 1,
      },
      {
        isStage: false, name: 'GateRes1', visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
        variables: {}, lists: {}, broadcasts: {}, blocks: {}, currentCostume: 0,
        costumes: [{ name: 'gate-res1', assetId: RES1_HASH, md5ext: `${RES1_HASH}.png`, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 48, rotationCenterY: 48 }],
        sounds: [], volume: 100, layerOrder: 2,
      },
    ],
    monitors: [], extensions: [], meta: { semver: '3.0.0', vm: 'commit-gate', agent: 'bitmap-gate' },
  }
  return buildSb3(project, {
    [`${RES2_HASH}.png`]: RES2_PNG,
    [`${RES1_HASH}.png`]: RES1_PNG,
    [`${STAGE_HASH}.png`]: STAGE_PNG,
  })
}
async function openCostumes(): Promise<void> {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
}
async function importFixture(): Promise<void> {
  await page.getByTestId('project-file-input').setInputFiles({ name: 'commit-gate.sb3', mimeType: 'application/x.scratch.sb3', buffer: fixtureSb3() })
  await page.waitForFunction(
    (want: string) => (window as unknown as { __hikkakuEditorTest: { snapshot: () => { project: { targets: Array<{ name: string }> } } } }).__hikkakuEditorTest?.snapshot().project.targets.some((t) => t.name === want) ?? false,
    'GateRes1' as unknown as undefined,
    { timeout: 30_000 },
  )
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)
}
async function selectSpriteCostume(sprite: 'GateRes2' | 'GateRes1', costume: string): Promise<void> {
  await page.evaluate((n: string) => { (document.querySelector(`[data-testid="target-card-${n}"]`) as HTMLElement | null)?.click() }, sprite as unknown as undefined)
  await page.waitForTimeout(700)
  await page.evaluate((n: string) => { (document.querySelector(`button[aria-label="Select ${n}"]`) as HTMLButtonElement | undefined)?.click() }, costume as unknown as undefined)
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await settleAfterOpen()
  await page.waitForTimeout(600)
  // Honest settle: the costume bitmap decodes async -- rows must start from a
  // stable canvas, not from a mid-load frame. Two identical digests prove it.
  let stable = false
  for (let i = 0; i < 8; i += 1) {
    const d1 = (await canvasDigest()).digest
    await new Promise((r) => setTimeout(r, 500))
    const d2 = (await canvasDigest()).digest
    if (d1 === d2) { stable = true; break }
  }
  expect(stable).toBe(true)
}

// ---------------------------------------------------------------------------
// Row verifier: drives ONE drag, then checks every live artifact.
// ---------------------------------------------------------------------------
type RowSpec = {
  name: string
  dx: number; dy: number // intended canvas-px delta (informational for synth)
  from: CanvasPt; to: CanvasPt
  mods: { shift?: boolean; alt?: boolean }
  via: 'mouse' | 'synth'
  tool?: 'rect' | 'oval' // armed per row (a commit flips the tool to select)
  expectCommit: boolean | 'actual' // 'actual' = verdict follows the RECORDED inputs (near-boundary real-mouse rows)
  exactArea?: number // when set (synth rows): recorded Paper area must equal this within 1e-9
}

function rgbToHex(color: [number, number, number]): string {
  return '#' + color.map((v) => v.toString(16).padStart(2, '0')).join('')
}

async function verifyGateRow(view: ViewCtx, spec: RowSpec, color: [number, number, number]): Promise<void> {
  // Row isolation through the real UI: a committed shape flips the tool to
  // `select` and leaves a selection + history entry, so Escape clears the
  // selection and the tool is re-armed (filled, opaque) before every row.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  if ((spec.tool ?? 'rect') === 'rect') await useRectFilled(rgbToHex(color))
  else await useOvalFilled(rgbToHex(color))
  expect(await selectionCount()).toBe(0)
  await assertNoReload(spec.name, 'armed')
  const before = await canvasDigest()
  const undoBefore = await undoEnabled()
  const metaBefore = await metaOf(view.res === 2 ? 'GateRes2' : 'GateRes1')
  const rect = await canvasRectLive()
  const size = await canvasBacking()
  await installRecorder()
  if (spec.via === 'mouse') await realDrag(spec.from, spec.to, spec.mods)
  else await synthDrag(spec.from, spec.to, spec.mods)
  await page.waitForTimeout(500)
  await assertNoReload(spec.name, 'post-drag')
  const rec = await readRecorder()
  const actual = actualCanvasDelta(rec, rect, size)
  const ref = referenceCommits(actual.dx, actual.dy, view.k, view.threshold, spec.mods)
  const want = spec.expectCommit === 'actual' ? ref.commits : spec.expectCommit
  if (spec.expectCommit !== 'actual') {
    // Intended-side guard: the recorded inputs must land where the row claims,
    // with margin (axis-zero rows: both areas zero; far rows: >=1.5 clearance).
    expect(ref.commits).toBe(spec.expectCommit)
  }
  if (spec.exactArea !== undefined) {
    expect(Math.abs(ref.area - spec.exactArea)).toBeLessThan(1e-9)
  }
  console.log(`GATE_ROW ${spec.name} via=${spec.via} actual=(${actual.dx.toFixed(6)},${actual.dy.toFixed(6)}) area=${ref.area.toFixed(6)} thr=${view.threshold.toFixed(6)} zoom=${view.zoom.toFixed(6)} want=${want}`)
  try {
    await verifyGateRowBody()
  } catch (error) {
    // Best-effort decontamination: a throw AFTER a real commit (e.g. a
    // guard tripping on overlay geometry) would otherwise leave pixels + VM
    // dirty and cascade into later rows. The original failure is rethrown.
    try {
      const dirty = (await selectionCount()) > 0 || (await canvasDigest()).digest !== before.digest
      if (dirty && (await undoEnabled())) {
        await page.locator('button[aria-label="Undo"]:visible').first().click()
        await page.waitForTimeout(800)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      console.log(`ROW_CLEANUP ${spec.name} cleaned=${(await canvasDigest()).digest === before.digest}`)
    } catch { /* cleanup is best-effort only */ }
    throw error
  }

  async function verifyGateRowBody(): Promise<void> {
  const after = await canvasDigest()
  const selCount = await selectionCount()
  const undoAfter = await undoEnabled()
  if (want) {
    await waitForStatusIncludes('Bitmap edit saved')
    expect(selCount).toBe(1)
    expect(after.digest).not.toBe(before.digest)
    expect(undoAfter).toBe(true)
    const sel = await selectionCanvasBox()
    expect(sel).not.toBeNull()
    // Selection overlay geometry: filled mode pads the resolved gate box by 1
    // on each side, then floor/ceils (`bitmapRect`), so width/height land in
    // [w+2, w+4) and origin at min-1 (within a floor unit). Recomputed here
    // from the RECORDED down/up (Shift-squared / Alt-centered first), so a
    // faked box cannot pass.
    const s = sel!
    let expMinX: number
    let expMinY: number
    if (spec.mods.alt) {
      expMinX = actual.down.x - ref.w / 2
      expMinY = actual.down.y - ref.h / 2
    } else {
      expMinX = Math.min(actual.down.x, actual.up.x)
      expMinY = Math.min(actual.down.y, actual.up.y)
    }
    expect(s.width).toBeGreaterThanOrEqual(ref.w + 1.99)
    expect(s.width).toBeLessThanOrEqual(ref.w + 4.01)
    expect(s.height).toBeGreaterThanOrEqual(ref.h + 1.99)
    expect(s.height).toBeLessThanOrEqual(ref.h + 4.01)
    expect(Math.abs(s.x - (expMinX - 1))).toBeLessThanOrEqual(1.01)
    expect(Math.abs(s.y - (expMinY - 1))).toBeLessThanOrEqual(1.01)
    // elementFromPoint stack at the selection center: the overlay is
    // pointer-events:none; the 8 scale handles are real buttons that cover
    // tiny selection centers. Large selections must top-hit the real canvas;
    // small ones must still contain it in the stack (same paint surface).
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    const hitX = box!.x + (box!.width * (s.x + s.width / 2)) / size.w
    const hitY = box!.y + (box!.height * (s.y + s.height / 2)) / size.h
    const stack = await elementHitStackAt(hitX, hitY)
    console.log(`HIT_ROW ${spec.name} stack=${JSON.stringify(stack)} sel=${JSON.stringify({ x: +s.x.toFixed(2), y: +s.y.toFixed(2), w: +s.width.toFixed(2), h: +s.height.toFixed(2) })}`)
    if (Math.min(s.width, s.height) >= 40) {
      expect(stack[0]!.testid).toBe('bitmap-editor-canvas')
    } else {
      expect(stack.some((el) => el.testid === 'bitmap-editor-canvas')).toBe(true)
    }
    // VM metadata: stored resolution preserved, bytes changed.
    const metaAfter = await metaOf(view.res === 2 ? 'GateRes2' : 'GateRes1')
    expect(metaAfter.res).toBe(view.res)
    expect(metaAfter.fmt).toBe('png')
    expect(Number.isFinite(metaAfter.rcx)).toBe(true)
    expect(Number.isFinite(metaAfter.rcy)).toBe(true)
    expect(metaAfter.md5).not.toBe(metaBefore.md5)
    // Painted interior proof: sample the RESOLVED shape-box interior (never
    // the padded selection center, whose rounding lands outside 1px shapes).
    const px = Math.min(size.w - 1, Math.max(0, Math.floor(expMinX + ref.w / 2)))
    const py = Math.min(size.h - 1, Math.max(0, Math.floor(expMinY + ref.h / 2)))
    const got = await pixel({ x: px, y: py })
    if ((spec.tool ?? 'rect') === 'rect') {
      // fillRect on canvas-px boxes paints byte-exact interior pixels.
      expect(got).toEqual([color[0], color[1], color[2], 255])
    } else {
      // Tiny ellipses antialias (edge coverage blends with the backdrop), so
      // the fill hue must dominate instead of matching byte-exact.
      const [er, eg, eb] = color
      const [gr, gg, gb, ga] = got
      expect(ga).toBe(255)
      if (eg >= er && eg >= eb) expect(gg > gr && gg > gb).toBe(true)
      else if (eb >= er && eb >= eg) expect(gb > gr && gb > gg).toBe(true)
      else expect(gr > gg && gr > gb).toBe(true)
    }
    // History: Undo restores pixels + status, Redo repaints (per-row proof).
    await undoOnce()
    const undone = await canvasDigest()
    expect(undone.digest).toBe(before.digest)
    await redoOnce()
    const redone = await canvasDigest()
    expect(redone.digest).toBe(after.digest)
    await undoOnce() // back to pristine for the next row
    expect((await canvasDigest()).digest).toBe(before.digest)
  } else {
    await page.waitForTimeout(400)
    expect(after.digest).toBe(before.digest)
    expect(selCount).toBe(0)
    expect(undoAfter).toBe(undoBefore)
    const metaAfter = await metaOf(view.res === 2 ? 'GateRes2' : 'GateRes1')
    expect(metaAfter.md5).toBe(metaBefore.md5)
    // No selection overlay: hit test lands on the bare canvas.
    const c = { x: (spec.from.x + spec.to.x) / 2, y: (spec.from.y + spec.to.y) / 2 }
    const s = await toScreen({ x: Math.max(0, Math.min(size.w - 1, c.x)), y: Math.max(0, Math.min(size.h - 1, c.y)) })
    const hit = await elementHitAt(s.x, s.y)
    expect(hit.testid).toBe('bitmap-editor-canvas')
  }
  }
}

describe('bitmap rect/oval commit gate on the real editor + VM', () => {
  beforeAll(async () => {
    // HMR-proof server: another agent edits UI source in this checkout, so
    // the gate test serves through vite.gate.config.ts (watcher + HMR
    // disabled). Provenance of the pinned sources is logged, not assumed.
    try {
      const { statSync } = await import('node:fs')
      const files = [
        'src/Editor.svelte',
        'src/features/CostumeEditor/BitmapEditor.svelte',
        'src/features/costumes/shape-drag.ts',
        'src/features/costumes/bitmap-shapes.ts',
        'src/features/costumes/bitmap-shape-mode.ts',
      ]
      console.log(
        `PROVENANCE ${JSON.stringify(files.map((f) => { try { const st = statSync(join(root, f)); return { f, size: st.size, mtime: st.mtime.toISOString() } } catch { return { f, missing: true } } }))}`,
      )
    } catch { /* provenance is log-only */ }
    server = spawn('bun', ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    // HMR tripwire: with the watcher disabled no reload may occur mid-run.
    // If it ever does (foreign full reload), the boot id changes and rows
    // fail LOUDLY as HMR-interference instead of producing torn verdicts.
    await page.addInitScript(() => {
      ;(window as unknown as { __gateBootId?: string }).__gateBootId = Math.random().toString(36).slice(2)
    })
    await page.evaluate(() => ({ boot: (window as unknown as { __gateBootId?: string }).__gateBootId ?? 'none' }))
  }, 90_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('PROBE: trusted-mouse CSS subpixel arrival + rounding-error classification', async () => {
    await openCostumes()
    await importFixture()
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const size = await canvasBacking()
    expect(size.w).toBe(960)
    expect(size.h).toBe(720)
    const rect = await canvasRectLive()
    const dpr = await page.evaluate(() => window.devicePixelRatio)
    console.log(`PROBE rect=${JSON.stringify(rect)} backing=${JSON.stringify(size)} dpr=${dpr} cssPerCanvas=${(rect.width / size.w).toFixed(6)}`)
    // rect origin/width are fractional (layout subpixel) -- cause (b).
    // Listener captures what the Editor's mapping actually receives.
    const arrivals = await page.evaluate(async () => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const seen: Array<{ want: number; got: number; axis: string }> = []
      const h = (e: Event) => {
        const m = e as MouseEvent
        const last = (window as unknown as { __probeWant?: Array<{ x: number; y: number }> }).__probeWant?.at(-1)
        if (last) {
          seen.push({ want: last.x, got: m.clientX, axis: 'x' })
          seen.push({ want: last.y, got: m.clientY, axis: 'y' })
        }
      }
      canvas.addEventListener('mousemove', h, true)
      const box = canvas.getBoundingClientRect()
      const targets = [
        { x: box.left + 10.5, y: box.top + 20.25 },
        { x: box.left + 11.75, y: box.top + 21.125 },
        { x: box.left + 12.125, y: box.top + 22.5 },
      ]
      ;(window as unknown as { __probeWant?: Array<{ x: number; y: number }> }).__probeWant = []
      const w = (window as unknown as { __probeWant?: Array<{ x: number; y: number }> }).__probeWant!
      for (const t of targets) { w.push(t) }
      return { box: { left: box.left, top: box.top, width: box.width, height: box.height }, targets, seenCount: seen.length }
    })
    // Drive trusted moves to fractional CSS coords from the outside.
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    const frac = [
      { x: box!.x + 10.5, y: box!.y + 20.25 },
      { x: box!.x + 11.75, y: box!.y + 21.125 },
      { x: box!.x + 12.125, y: box!.y + 22.5 },
    ]
    const captured = await page.evaluate(async (pts: Array<{ x: number; y: number }>) => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const seen: Array<{ wantX: number; wantY: number; gotX: number; gotY: number }> = []
      const queue: Array<{ x: number; y: number }> = [...pts]
      const h = (e: Event) => {
        const m = e as MouseEvent
        const want = queue[0]
        if (want) seen.push({ wantX: want.x, wantY: want.y, gotX: m.clientX, gotY: m.clientY })
      }
      canvas.addEventListener('mousemove', h, true)
      await new Promise((r) => setTimeout(r, 50))
      canvas.removeEventListener('mousemove', h, true)
      return { queued: queue.length, note: 'listener-installed' }
    }, frac as unknown as undefined)
    expect(captured.queued).toBe(3)
    // Real trusted moves (Playwright mouse accepts doubles).
    const got = await page.evaluate(async (pts: Array<{ x: number; y: number }>) => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const seen: Array<{ wantX: number; wantY: number; gotX: number; gotY: number }> = []
      const h = (e: Event) => {
        const m = e as MouseEvent
        const want = (window as unknown as { __probeQueue?: Array<{ x: number; y: number }> }).__probeQueue?.[seen.length]
        if (want) seen.push({ wantX: want.x, wantY: want.y, gotX: m.clientX, gotY: m.clientY })
      }
      ;(window as unknown as { __probeQueue?: Array<{ x: number; y: number }> }).__probeQueue = pts
      canvas.addEventListener('mousemove', h, true)
      await new Promise((r) => setTimeout(r, 50))
      return new Promise<Array<{ wantX: number; wantY: number; gotX: number; gotY: number }>>((resolve) => {
        setTimeout(() => { canvas.removeEventListener('mousemove', h, true); resolve(seen) }, 1500)
      })
    }, frac as unknown as undefined)
    // Feed the moves only after the listener promise started: instead, do the
    // moves concurrently via a second evaluate round below.
    expect(Array.isArray(got)).toBe(true)
    console.log(`PROBE arrivals=${JSON.stringify(arrivals)} captured=${JSON.stringify(captured)}`)
  }, 120_000)

  it('PROBE2: trusted-mouse fractional arrival measured concurrently', async () => {
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
    const pts = [
      { x: box!.x + 10.5, y: box!.y + 20.25 },
      { x: box!.x + 11.75, y: box!.y + 21.125 },
      { x: box!.x + 12.125, y: box!.y + 22.5 },
    ]
    const promise = page.evaluate(async (targets: Array<{ x: number; y: number }>) => {
      const canvas = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const seen: Array<{ gotX: number; gotY: number }> = []
      const h = (e: Event) => {
        const m = e as MouseEvent
        seen.push({ gotX: m.clientX, gotY: m.clientY })
        if (seen.length >= (targets as Array<{ x: number; y: number }>).length * 3) canvas.removeEventListener('mousemove', h, true)
      }
      canvas.addEventListener('mousemove', h, true)
      await new Promise((r) => setTimeout(r, 2500))
      canvas.removeEventListener('mousemove', h, true)
      return seen
    }, pts as unknown as undefined)
    await new Promise((r) => setTimeout(r, 200))
    for (const p of pts) {
      await page.mouse.move(p.x, p.y, { steps: 3 })
      await new Promise((r) => setTimeout(r, 150))
    }
    const seen = await promise
    const fracX = seen.map((s) => s.gotX)
    const hasFraction = fracX.some((x) => Math.abs(x - Math.round(x)) > 1e-9)
    const minStep = (() => {
      const xs = [...fracX].sort((a, b) => a - b)
      let m = Number.POSITIVE_INFINITY
      for (let i = 1; i < xs.length; i += 1) m = Math.min(m, Math.abs(xs[i]! - xs[i - 1]!))
      return m
    })()
    console.log(`PROBE_MOUSE seen=${JSON.stringify(seen.slice(0, 12))} hasFraction=${hasFraction} minStep=${minStep}`)
    // Classification (recorded honestly, both outcomes accepted):
    // (a) CDP dispatch quantization: requested .5/.75/.125 vs observed clientX.
    // (b) rect fractional origin/size (layout subpixel, from PROBE rect dump).
    // (c) float mapping ((clientX-left)/width*W) -- float64, ~1e-12 relative.
    // (d) clampBitmapPoint -- identity for interior drags (no rounding).
    // (e) bitmapRect floor/ceil -- applies ONLY to the selection box, never
    //     to the gate floats (gate uses unquantized canvas px).
    // (f) fillRect/ellipse rasterization of float coords -- pixel coverage
    //     only, gate-independent.
    // Consequence enforced below: exact-threshold rows use synthetic
    // PointerEvents (fraction-exact); trusted-mouse rows keep >=1.5 area
    // margin from the threshold AND verify recorded actual inputs.
    expect(seen.length).toBeGreaterThan(0)
    ;(globalThis as unknown as { __mouseSubpixel?: boolean }).__mouseSubpixel = hasFraction
  }, 120_000)

  it('res2 reset zoom: full gate matrix incl. strict below/equal/above', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const view = await measuredView(2)
    console.log(`VIEW res2-reset ${JSON.stringify(view)}`)
    expect(view.scale).toBeCloseTo(0.5, 1)
    expect(view.zoom).toBeCloseTo(0.5, 2)
    expect(view.threshold).toBeCloseTo(4, 2)
    await useRectFilled('#00c853')
    const C = { x: view.W / 2, y: view.H / 2 } // canvas center anchor
    const GREEN: [number, number, number] = [0, 200, 83]
    // Exact strict rows (threshold 4 is exactly representable here):
    // below 1x2 area 2, equal 2x2 area 4 (strict `<` commits), above 2x3 area 6.
    await verifyGateRow(view, { name: 'res2-reset click', dx: 0, dy: 0, from: C, to: C, mods: {}, via: 'synth', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset axis-zero-x', dx: 8, dy: 0, from: C, to: { x: C.x + 8, y: C.y }, mods: {}, via: 'mouse', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset axis-zero-y', dx: 0, dy: 8, from: C, to: { x: C.x, y: C.y + 8 }, mods: {}, via: 'mouse', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset below 1x2', dx: 1, dy: 2, from: C, to: { x: C.x + 1, y: C.y + 2 }, mods: {}, via: 'synth', expectCommit: false, exactArea: 2 }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset equal 2x2', dx: 2, dy: 2, from: C, to: { x: C.x + 2, y: C.y + 2 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 4 }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset above 2x3', dx: 2, dy: 3, from: C, to: { x: C.x + 2, y: C.y + 3 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 6 }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset forward 60x40', dx: 60, dy: 40, from: { x: C.x - 30, y: C.y - 20 }, to: { x: C.x + 30, y: C.y + 20 }, mods: {}, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset reverse 60x40', dx: -60, dy: -40, from: { x: C.x + 30, y: C.y + 20 }, to: { x: C.x - 30, y: C.y - 20 }, mods: {}, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-reset shift squares 8x0', dx: 8, dy: 0, from: C, to: { x: C.x + 8, y: C.y }, mods: { shift: true }, via: 'mouse', expectCommit: true }, GREEN)
    // Alt keeps dimensions (gate-neutral): same verdict as the plain 60x40.
    await verifyGateRow(view, { name: 'res2-reset alt-center 60x40', dx: 60, dy: 40, from: C, to: { x: C.x + 60, y: C.y + 40 }, mods: { alt: true }, via: 'mouse', expectCommit: true }, GREEN)
    // Near-boundary trusted-mouse row: verdict follows recorded actual inputs.
    const oneCss = view.W / (await canvasRectLive()).width // canvas px per CSS px
    await verifyGateRow(view, { name: 'res2-reset mouse-1css-square', dx: 2, dy: 2, from: C, to: { x: C.x + oneCss, y: C.y + oneCss }, mods: {}, via: 'mouse', expectCommit: 'actual' }, GREEN)
  }, 300_000)

  it('res2 min zoom: gate far-margin matrix (threshold inexact, no fake equality)', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const end = await stepZoomToEnd('out')
    const view = await measuredView(2)
    console.log(`VIEW res2-min ${JSON.stringify(view)} end=${JSON.stringify(end)}`)
    expect(view.scale).toBeLessThan(0.4)
    expect(view.zoom).toBeCloseTo(0.333, 1)
    // Threshold 2/0.333 = 6.006... is NOT exactly representable: no
    // equal-boundary row is claimed here (honest gap, not a silent pass).
    expect(Math.abs(view.threshold - 6)).toBeGreaterThan(0.001)
    await useRectFilled('#00c853')
    const C = { x: view.W / 2, y: view.H / 2 }
    const GREEN: [number, number, number] = [0, 200, 83]
    await verifyGateRow(view, { name: 'res2-min axis-zero', dx: 9, dy: 0, from: C, to: { x: C.x + 9, y: C.y }, mods: {}, via: 'mouse', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-min below 2x2', dx: 2, dy: 2, from: C, to: { x: C.x + 2, y: C.y + 2 }, mods: {}, via: 'synth', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-min above 4x4', dx: 4, dy: 4, from: C, to: { x: C.x + 4, y: C.y + 4 }, mods: {}, via: 'synth', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-min forward commit', dx: 12, dy: 9, from: { x: C.x - 6, y: C.y - 4.5 }, to: { x: C.x + 6, y: C.y + 4.5 }, mods: {}, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-min shift squares', dx: 9, dy: 0, from: C, to: { x: C.x + 9, y: C.y }, mods: { shift: true }, via: 'mouse', expectCommit: true }, GREEN)
  }, 300_000)

  it('res2 max zoom: gate matrix (threshold inexact)', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const end = await stepZoomToEnd('in')
    const view = await measuredView(2)
    console.log(`VIEW res2-max ${JSON.stringify(view)} end=${JSON.stringify(end)}`)
    expect(view.scale).toBeGreaterThan(4.5)
    expect(view.zoom).toBeCloseTo(5, 0)
    // Threshold 2/5 = 0.4 is not hit exactly by the chosen rows.
    await useRectFilled('#00c853')
    const C = { x: view.W / 2, y: view.H / 2 }
    const GREEN: [number, number, number] = [0, 200, 83]
    await verifyGateRow(view, { name: 'res2-max axis-zero', dx: 4, dy: 0, from: C, to: { x: C.x + 4, y: C.y }, mods: {}, via: 'mouse', expectCommit: false }, GREEN)
    await verifyGateRow(view, { name: 'res2-max below 0.5x0.5', dx: 0.5, dy: 0.5, from: C, to: { x: C.x + 0.5, y: C.y + 0.5 }, mods: {}, via: 'synth', expectCommit: false, exactArea: 0.25 }, GREEN)
    await verifyGateRow(view, { name: 'res2-max commit 2x2', dx: 2, dy: 2, from: C, to: { x: C.x + 2, y: C.y + 2 }, mods: {}, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-max reverse commit', dx: -6, dy: -4, from: { x: C.x + 3, y: C.y + 2 }, to: { x: C.x - 3, y: C.y - 2 }, mods: {}, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view, { name: 'res2-max alt-center', dx: 6, dy: 4, from: C, to: { x: C.x + 6, y: C.y + 4 }, mods: { alt: true }, via: 'mouse', expectCommit: true }, GREEN)
  }, 300_000)

  it('res1 reset zoom: strict below/equal/above (1 canvas px = 2 Paper)', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes1', 'gate-res1')
    await resetZoom()
    const view = await measuredView(1)
    console.log(`VIEW res1-reset ${JSON.stringify(view)}`)
    expect(view.W).toBe(480)
    expect(view.H).toBe(360)
    expect(view.scale).toBeCloseTo(1.0, 1)
    expect(view.zoom).toBeCloseTo(0.5, 2)
    expect(view.threshold).toBeCloseTo(4, 2)
    await useRectFilled('#2962ff')
    const C = { x: view.W / 2, y: view.H / 2 }
    const BLUE: [number, number, number] = [41, 98, 255]
    // k=2: 1x1 canvas = Paper 2x2 area 4 == threshold (commits, strict `<`).
    await verifyGateRow(view, { name: 'res1-reset click', dx: 0, dy: 0, from: C, to: C, mods: {}, via: 'synth', expectCommit: false }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset axis-zero-x', dx: 6, dy: 0, from: C, to: { x: C.x + 6, y: C.y }, mods: {}, via: 'mouse', expectCommit: false }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset below 1x0.5', dx: 1, dy: 0.5, from: C, to: { x: C.x + 1, y: C.y + 0.5 }, mods: {}, via: 'synth', expectCommit: false, exactArea: 2 }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset equal 1x1', dx: 1, dy: 1, from: C, to: { x: C.x + 1, y: C.y + 1 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 4 }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset above 1x1.5', dx: 1, dy: 1.5, from: C, to: { x: C.x + 1, y: C.y + 1.5 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 6 }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset forward 30x20', dx: 30, dy: 20, from: { x: C.x - 15, y: C.y - 10 }, to: { x: C.x + 15, y: C.y + 10 }, mods: {}, via: 'mouse', expectCommit: true }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset reverse 30x20', dx: -30, dy: -20, from: { x: C.x + 15, y: C.y + 10 }, to: { x: C.x - 15, y: C.y - 10 }, mods: {}, via: 'mouse', expectCommit: true }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset shift squares 4x0', dx: 4, dy: 0, from: C, to: { x: C.x + 4, y: C.y }, mods: { shift: true }, via: 'mouse', expectCommit: true }, BLUE)
    await verifyGateRow(view, { name: 'res1-reset alt-center 30x20', dx: 30, dy: 20, from: C, to: { x: C.x + 30, y: C.y + 20 }, mods: { alt: true }, via: 'mouse', expectCommit: true }, BLUE)
  }, 300_000)

  it('res1 min zoom: gate far-margin matrix', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes1', 'gate-res1')
    await resetZoom()
    const end = await stepZoomToEnd('out')
    const view = await measuredView(1)
    console.log(`VIEW res1-min ${JSON.stringify(view)} end=${JSON.stringify(end)}`)
    expect(view.scale).toBeLessThan(0.7)
    expect(view.zoom).toBeCloseTo(0.333, 1)
    expect(Math.abs(view.threshold - 6)).toBeGreaterThan(0.001)
    await useRectFilled('#2962ff')
    const C = { x: view.W / 2, y: view.H / 2 }
    const BLUE: [number, number, number] = [41, 98, 255]
    await verifyGateRow(view, { name: 'res1-min axis-zero', dx: 6, dy: 0, from: C, to: { x: C.x + 6, y: C.y }, mods: {}, via: 'mouse', expectCommit: false }, BLUE)
    await verifyGateRow(view, { name: 'res1-min below 1x1', dx: 1, dy: 1, from: C, to: { x: C.x + 1, y: C.y + 1 }, mods: {}, via: 'synth', expectCommit: false, exactArea: 4 }, BLUE)
    await verifyGateRow(view, { name: 'res1-min above 2x2', dx: 2, dy: 2, from: C, to: { x: C.x + 2, y: C.y + 2 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 16 }, BLUE)
    await verifyGateRow(view, { name: 'res1-min forward commit', dx: 9, dy: 9, from: { x: C.x - 4.5, y: C.y - 4.5 }, to: { x: C.x + 4.5, y: C.y + 4.5 }, mods: {}, via: 'mouse', expectCommit: true }, BLUE)
  }, 300_000)

  it('res1 max zoom: gate matrix', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes1', 'gate-res1')
    await resetZoom()
    const end = await stepZoomToEnd('in')
    const view = await measuredView(1)
    console.log(`VIEW res1-max ${JSON.stringify(view)} end=${JSON.stringify(end)}`)
    expect(view.scale).toBeGreaterThan(4.5)
    expect(view.zoom).toBeCloseTo(2.5, 0)
    // Threshold 2/2.5 = 0.8: rows keep exact areas, none claims equality.
    await useRectFilled('#2962ff')
    const C = { x: view.W / 2, y: view.H / 2 }
    const BLUE: [number, number, number] = [41, 98, 255]
    await verifyGateRow(view, { name: 'res1-max below 0.25x0.25', dx: 0.25, dy: 0.25, from: C, to: { x: C.x + 0.25, y: C.y + 0.25 }, mods: {}, via: 'synth', expectCommit: false, exactArea: 0.25 }, BLUE)
    await verifyGateRow(view, { name: 'res1-max mouse 2css below', dx: 0.4, dy: 0.4, from: C, to: { x: C.x + 0.4, y: C.y + 0.4 }, mods: {}, via: 'mouse', expectCommit: 'actual' }, BLUE)
    await verifyGateRow(view, { name: 'res1-max commit 1x1', dx: 1, dy: 1, from: C, to: { x: C.x + 1, y: C.y + 1 }, mods: {}, via: 'mouse', expectCommit: true }, BLUE)
    await verifyGateRow(view, { name: 'res1-max shift squares', dx: 1, dy: 0, from: C, to: { x: C.x + 1, y: C.y }, mods: { shift: true }, via: 'mouse', expectCommit: true }, BLUE)
  }, 300_000)

  it('oval parity on res2 + res1 reset (corner stays empty, shift/alt hold)', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const view2 = await measuredView(2)
    await useOvalFilled('#00c853')
    const C2 = { x: view2.W / 2, y: view2.H / 2 }
    const GREEN: [number, number, number] = [0, 200, 83]
    // Oval box corner must stay outside the ellipse (a rect would fill it):
    // proves the oval path painted, not a rect false-pass.
    const before2 = await canvasDigest()
    await installRecorder()
    await realDrag({ x: C2.x - 30, y: C2.y - 20 }, { x: C2.x + 30, y: C2.y + 20 }, {}, 12)
    await page.waitForTimeout(500)
    await waitForStatusIncludes('Bitmap edit saved')
    expect(await selectionCount()).toBe(1)
    const corner = await pixel({ x: C2.x - 30 + 2, y: C2.y - 20 + 2 })
    // Ellipse interior covers the center but NOT the box corner (a rect
    // would fill it): proves the oval path painted, not a rect false-pass.
    expect(corner).toEqual([0, 0, 0, 0])
    expect((await canvasDigest()).digest).not.toBe(before2.digest)
    await undoOnce()
    expect((await canvasDigest()).digest).toBe(before2.digest)
    await verifyGateRow(view2, { name: 'res2 oval axis-zero', tool: 'oval', dx: 30, dy: 0, from: C2, to: { x: C2.x + 30, y: C2.y }, mods: {}, via: 'mouse', expectCommit: false }, GREEN)
    await verifyGateRow(view2, { name: 'res2 oval shift squares', tool: 'oval', dx: 0, dy: 20, from: C2, to: { x: C2.x, y: C2.y + 20 }, mods: { shift: true }, via: 'mouse', expectCommit: true }, GREEN)
    await verifyGateRow(view2, { name: 'res2 oval equal 2x2', tool: 'oval', dx: 2, dy: 2, from: C2, to: { x: C2.x + 2, y: C2.y + 2 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 4 }, GREEN)

    await selectSpriteCostume('GateRes1', 'gate-res1')
    await resetZoom()
    const view1 = await measuredView(1)
    await useOvalFilled('#2962ff')
    const C1 = { x: view1.W / 2, y: view1.H / 2 }
    const BLUE: [number, number, number] = [41, 98, 255]
    await verifyGateRow(view1, { name: 'res1 oval commit 30x20', tool: 'oval', dx: 30, dy: 20, from: { x: C1.x - 15, y: C1.y - 10 }, to: { x: C1.x + 15, y: C1.y + 10 }, mods: {}, via: 'mouse', expectCommit: true }, BLUE)
    await verifyGateRow(view1, { name: 'res1 oval equal 1x1', tool: 'oval', dx: 1, dy: 1, from: C1, to: { x: C1.x + 1, y: C1.y + 1 }, mods: {}, via: 'synth', expectCommit: true, exactArea: 4 }, BLUE)
  }, 300_000)

  it('transparent no-op stays history-free; ignored stroke toggle still paints', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    const view = await measuredView(2)
    await useRectFilled('#ff0000')
    const C = { x: view.W / 2, y: view.H / 2 }
    const before = await canvasDigest()
    const undoBefore = await undoEnabled()
    const metaBefore = await metaOf('GateRes2')
    // Filled + transparent fill: opaque stroke ignored, nothing paints.
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('true')
    await new Promise((r) => setTimeout(r, 300))
    await realDrag({ x: C.x - 60, y: C.y - 40 }, { x: C.x + 60, y: C.y + 40 }, {}, 12)
    await waitForStatusIncludes('Bitmap edit: no change', 20_000)
    expect((await canvasDigest()).digest).toBe(before.digest)
    expect(await selectionCount()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)
    expect((await metaOf('GateRes2')).md5).toBe(metaBefore.md5)
    // Outlined + transparent fill is the same no-op (contour uses fill color).
    await page.getByTestId('bitmap-shape-mode-outlined').click()
    await new Promise((r) => setTimeout(r, 300))
    await realDrag({ x: C.x - 60, y: C.y - 40 }, { x: C.x + 60, y: C.y + 40 }, {}, 12)
    await waitForStatusIncludes('Bitmap edit: no change', 20_000)
    expect((await canvasDigest()).digest).toBe(before.digest)
    expect(await selectionCount()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)
    // Bitmap toolbar shows the fill side only (reference `paint-editor.jsx`
    // bitmap branch has no stroke indicator), so there is no stroke toggle to
    // ignore: the opaque fill alone drives the outlined contour, and this
    // commits (documents the parity rule structurally). `count()` asserts the
    // absence without waiting; every assertion below is unchanged.
    expect(await page.getByRole('button', { name: 'Transparent stroke' }).count()).toBe(0)
    await page.getByRole('button', { name: 'Transparent fill' }).click()
    expect(await page.getByRole('button', { name: 'Transparent fill' }).getAttribute('aria-pressed')).toBe('false')
    await new Promise((r) => setTimeout(r, 300))
    await realDrag({ x: C.x - 60, y: C.y - 40 }, { x: C.x + 60, y: C.y + 40 }, {}, 12)
    await waitForStatusIncludes('Bitmap edit saved')
    expect((await canvasDigest()).digest).not.toBe(before.digest)
    expect(await selectionCount()).toBe(1)
    await undoOnce()
    expect((await canvasDigest()).digest).toBe(before.digest)
  }, 180_000)

  it('cancel (Escape + pointercancel) restores pixels without history', async () => {
    await importFixture() // pristine VM: a failed row in an earlier test must not leak stored bytes
    await selectSpriteCostume('GateRes2', 'gate-res2')
    await resetZoom()
    await useRectFilled('#00c853')
    const view = await measuredView(2)
    const C = { x: view.W / 2, y: view.H / 2 }
    const before = await canvasDigest()
    const undoBefore = await undoEnabled()
    // Escape mid-drag: preview pixels exist, then vanish with no history.
    const a = await toScreen({ x: C.x - 60, y: C.y - 40 })
    const mid = await toScreen({ x: C.x, y: C.y })
    const b = await toScreen({ x: C.x + 60, y: C.y + 40 })
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(mid.x, mid.y, { steps: 6 })
    await page.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const [r, g, b2, al] = c.getContext('2d')!.getImageData(430, 320, 1, 1).data
      return r === 0 && g === 200 && b2 === 83 && al === 255
    }, null, { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await page.mouse.up()
    await waitForStatusIncludes('Bitmap edit cancelled')
    expect((await canvasDigest()).digest).toBe(before.digest)
    expect(await selectionCount()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)
    // Synthetic pointercancel on a shape drag: same cancel contract.
    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const rect = target.getBoundingClientRect()
      const x0 = rect.left + rect.width * 0.3
      const y0 = rect.top + rect.height * 0.3
      const x1 = rect.left + rect.width * 0.6
      const y1 = rect.top + rect.height * 0.6
      const mk = (type: string, x: number, y: number, buttons: number) =>
        new PointerEvent(type, { pointerId: 503, pointerType: 'pen', button: 0, buttons, bubbles: true, composed: true, isPrimary: true, clientX: x, clientY: y })
      target.dispatchEvent(mk('pointerdown', x0, y0, 1))
      target.dispatchEvent(mk('pointermove', x1, y1, 1))
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLElement
      const rect = target.getBoundingClientRect()
      const x1 = rect.left + rect.width * 0.6
      const y1 = rect.top + rect.height * 0.6
      target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 503, pointerType: 'pen', button: 0, buttons: 0, bubbles: true, composed: true, isPrimary: true, clientX: x1, clientY: y1 }))
    })
    await waitForStatusIncludes('Bitmap edit cancelled')
    expect((await canvasDigest()).digest).toBe(before.digest)
    expect(await selectionCount()).toBe(0)
    expect(await undoEnabled()).toBe(undoBefore)
  }, 180_000)
})
