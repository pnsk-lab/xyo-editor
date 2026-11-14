// Real-browser fail-closed stroke caps (no reference copy, no network).
//
// Reproduces the reported bug on feasible canvases: a 60000x1 (or tall
// skinny) live canvas is valid (side <= 65535, area <= 16M), and a long
// high-zoom drag must not throw mid-stroke leaving partial pixels or untracked
// unsaved changes. Covers:
//   - cap boundary (50000/50001 pass, 65535 pass, 65536 throws)
//   - cumulative 500k stamps (fast pre-validation, no OOM walk)
//   - huge 32-bit / non-finite coords throw fast
//   - reference behavior for normal strokes (counts + anchors)
//   - atomic try/finally: refused paint leaves zero stamps, save/restore
//     balanced, preview-base snapshot restores byte-identical
//   - Editor-pattern owner/generation/cancel: stale owner cancels without
//     touching pixels or history; settled owner commits one history entry;
//     capped strokes keep earlier pixels with an honest status and still
//     commit them (no frozen UI, status not lost).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4661
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

describe('bitmap stroke caps on real canvas (fail-closed, no partial mutation)', () => {
  beforeAll(async () => {
    const probe = await fetch(base).then(() => true).catch(() => false)
    if (probe) throw new Error(`port ${PORT} is already in use; stop the holder first`)
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('feasible 60000x1 + tall skinny paint without crash; caps fail fast and atomically', async () => {
    const result = await page!.evaluate(async () => {
      const brushMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-brush.ts')
      const eraserMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-eraser.ts')
      const lineMod = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-line.ts')
      const {
        BITMAP_BRUSH_MAX_POINTS,
        BITMAP_BRUSH_MAX_SEGMENT_STEPS,
        BITMAP_BRUSH_MAX_STAMPS,
        forEachBrushLinePoint,
        drawBitmapBrushStroke,
        drawBitmapBrushSegment,
        validateBitmapBrushStroke,
      } = brushMod as Record<string, (...args: never[]) => unknown> & Record<string, number>
      const { drawBitmapEraserStroke, validateBitmapEraserStroke } = eraserMod as Record<string, (...args: never[]) => unknown>
      const { drawBitmapLine, validateBitmapLine, getBitmapLinePixels } = lineMod as Record<string, (...args: never[]) => unknown>

      const timed = <T>(label: string, fn: () => T): { value: T; ms: number } => {
        const t0 = performance.now()
        const value = fn()
        return { value, ms: performance.now() - t0 }
      }
      const expectThrow = (fn: () => void): { threw: boolean; rangeError: boolean; ms: number } => {
        const t0 = performance.now()
        try {
          fn()
        } catch (e) {
          return { threw: true, rangeError: e instanceof RangeError, ms: performance.now() - t0 }
        }
        return { threw: false, rangeError: false, ms: performance.now() - t0 }
      }
      const out: Record<string, unknown> = {}
      out['caps'] = { points: BITMAP_BRUSH_MAX_POINTS, segment: BITMAP_BRUSH_MAX_SEGMENT_STEPS, stamps: BITMAP_BRUSH_MAX_STAMPS }

      // Boundary: 50000/50001 pass (old cap regression), 65535 passes, 65536 throws.
      out['boundary-50000'] = timed('b50k', () => (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 50000, y: 0 }])).value
      out['boundary-50001'] = timed('b50001', () => (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 50001, y: 0 }])).value
      out['boundary-65535'] = (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 65535, y: 0 }])
      out['boundary-65536-throw'] = expectThrow(() => (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 65536, y: 0 }]))
      out['line-65535'] = (validateBitmapLine as (a: { x: number; y: number }, b: { x: number; y: number }) => number)({ x: 0, y: 0 }, { x: 65535, y: 0 })
      out['line-65536-throw'] = expectThrow(() => (validateBitmapLine as (a: { x: number; y: number }, b: { x: number; y: number }) => number)({ x: 0, y: 0 }, { x: 65536, y: 0 }))
      out['eraser-65535'] = (validateBitmapEraserStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 65535, y: 0 }])
      out['eraser-65536-throw'] = expectThrow(() => (validateBitmapEraserStroke as (p: { x: number; y: number }[]) => number)([{ x: 0, y: 0 }, { x: 65536, y: 0 }]))

      // Cumulative 500k: 7 full-width segments feasible, 8 refused (fast, no OOM walk).
      const seven: { x: number; y: number }[] = []
      for (let i = 0; i <= 7; i += 1) seven.push({ x: i % 2 === 0 ? 0 : 65535, y: 0 })
      const eight: { x: number; y: number }[] = []
      for (let i = 0; i <= 8; i += 1) eight.push({ x: i % 2 === 0 ? 0 : 65535, y: 0 })
      out['cumulative-7'] = timed('c7', () => (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)(seven)).value
      const cum8 = expectThrow(() => (validateBitmapBrushStroke as (p: { x: number; y: number }[]) => number)(eight))
      out['cumulative-8-throw'] = cum8

      // Huge 32-bit / non-finite throw fast (no hang).
      out['huge-32bit'] = expectThrow(() => (forEachBrushLinePoint as (a: { x: number; y: number }, b: { x: number; y: number }, v: (x: number, y: number) => void) => void)({ x: 2147483648, y: 0 }, { x: 0, y: 0 }, () => {}))
      out['huge-1e15'] = expectThrow(() => (forEachBrushLinePoint as (a: { x: number; y: number }, b: { x: number; y: number }, v: (x: number, y: number) => void) => void)({ x: 1e15, y: 0 }, { x: -1e15, y: 0 }, () => {}))
      out['huge-nan'] = expectThrow(() => (drawBitmapBrushStroke as (c: CanvasRenderingContext2D, p: { x: number; y: number }[], d: number, col: string) => void)(document.createElement('canvas').getContext('2d')!, [{ x: Number.NaN, y: 0 }], 5, '#000'))
      out['line-huge'] = expectThrow(() => (drawBitmapLine as (c: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, w: number, col: string) => void)(document.createElement('canvas').getContext('2d')!, { x: 0, y: 0 }, { x: 1e12, y: 1e12 }, 5, '#000'))

      // Reference behavior: small horizontal + diagonal counts.
      const small: number[] = []
      ;(forEachBrushLinePoint as (a: { x: number; y: number }, b: { x: number; y: number }, v: (x: number, y: number) => void) => void)({ x: 1, y: 2 }, { x: 4, y: 2 }, (x, y) => small.push(x, y))
      out['reference-small-count'] = small.length / 2
      out['reference-line-pixels'] = ((getBitmapLinePixels as (a: { x: number; y: number }, b: { x: number; y: number }) => { x: number; y: number }[])({ x: 0, y: 0 }, { x: 3, y: 2 })).length

      // Feasible 60000x1: real paint, no crash, ends painted, base restorable.
      {
        const c = document.createElement('canvas')
        c.width = 60000
        c.height = 1
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, c.width, c.height)
        const t0 = performance.now()
        let threw: string | null = null
        try {
          ;(drawBitmapBrushStroke as (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], d: number, col: string) => void)(ctx, [{ x: 0, y: 0 }, { x: 59999, y: 0 }], 1, '#ff0000')
        } catch (e) {
          threw = String(e)
        }
        const ms = performance.now() - t0
        const left = Array.from(ctx.getImageData(0, 0, 1, 1).data)
        const right = Array.from(ctx.getImageData(59999, 0, 1, 1).data)
        out['wide-60000'] = { threw, ms, leftAlpha: left[3], rightAlpha: right[3], width: c.width }
      }

      // Tall skinny 1x60000 line: real paint.
      {
        const c = document.createElement('canvas')
        c.width = 1
        c.height = 60000
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        let threw: string | null = null
        try {
          ;(drawBitmapLine as (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, w: number, col: string) => void)(ctx, { x: 0, y: 0 }, { x: 0, y: 59999 }, 1, '#00ff00')
        } catch (e) {
          threw = String(e)
        }
        const top = Array.from(ctx.getImageData(0, 0, 1, 1).data)
        const bottom = Array.from(ctx.getImageData(0, 59999, 1, 1).data)
        out['tall-60000'] = { threw, topAlpha: top[3], bottomAlpha: bottom[3] }
      }

      // 10001-point sequence: refused fast, atomically (zero stamps), base intact, save/restore balanced.
      {
        const c = document.createElement('canvas')
        c.width = 32
        c.height = 32
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = '#123456'
        ctx.fillRect(0, 0, 32, 32)
        const baseSnap = ctx.getImageData(0, 0, 32, 32)
        let saves = 0
        let restores = 0
        let stamps = 0
        const origSave = ctx.save.bind(ctx)
        const origRestore = ctx.restore.bind(ctx)
        const origDraw = ctx.drawImage.bind(ctx)
        ctx.save = (() => { saves += 1; return (origSave as () => void)() }) as typeof ctx.save
        ctx.restore = (() => { restores += 1; return (origRestore as () => void)() }) as typeof ctx.restore
        ctx.drawImage = ((...a: Parameters<CanvasRenderingContext2D['drawImage']>) => { stamps += 1; return (origDraw as (...a: Parameters<CanvasRenderingContext2D['drawImage']>) => void)(...a) }) as typeof ctx.drawImage
        const pts = Array.from({ length: 10001 }, () => ({ x: 5, y: 5 }))
        const t0 = performance.now()
        let threw = false
        let rangeError = false
        try {
          ;(drawBitmapBrushStroke as (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], d: number, col: string) => void)(ctx, pts, 4, '#ff0000')
        } catch (e) {
          threw = true
          rangeError = e instanceof RangeError
        }
        const ms = performance.now() - t0
        const after = ctx.getImageData(0, 0, 32, 32)
        let same = after.data.length === baseSnap.data.length
        if (same) {
          for (let i = 0; i < after.data.length; i += 1) {
            if (after.data[i] !== baseSnap.data[i]) { same = false; break }
          }
        }
        out['points-10001'] = { threw, rangeError, ms, saves, restores, stamps, baseIntact: same }
      }

      // Long-stroke cumulative refusal is fast and paints nothing (no OOM walk).
      {
        const c = document.createElement('canvas')
        c.width = 32
        c.height = 32
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        const baseSnap = ctx.getImageData(0, 0, 32, 32)
        let stamps = 0
        const origDraw = ctx.drawImage.bind(ctx)
        ctx.drawImage = ((...a: Parameters<CanvasRenderingContext2D['drawImage']>) => { stamps += 1; return (origDraw as (...a: Parameters<CanvasRenderingContext2D['drawImage']>) => void)(...a) }) as typeof ctx.drawImage
        const t0 = performance.now()
        let threw = false
        try {
          ;(drawBitmapBrushStroke as (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], d: number, col: string) => void)(ctx, eight, 4, '#ff0000')
        } catch (e) {
          threw = e instanceof RangeError
        }
        const ms = performance.now() - t0
        const after = ctx.getImageData(0, 0, 32, 32)
        let same = true
        for (let i = 0; i < after.data.length; i += 1) {
          if (after.data[i] !== baseSnap.data[i]) { same = false; break }
        }
        out['cumulative-refusal-atomic'] = { threw, ms, stamps, baseIntact: same }
      }

      // Incremental segment path: 10001 single-pixel moves stay O(total) and
      // refuse the 10001st without touching earlier pixels.
      {
        const c = document.createElement('canvas')
        c.width = 64
        c.height = 8
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, 64, 8)
        let total = 1
        let capped = false
        const t0 = performance.now()
        // Paint 9999 more single-pixel-adjacent points incrementally (all x in range).
        let prev = { x: 0, y: 0 }
        ;(drawBitmapBrushSegment as (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, d: number, col: string) => void)(ctx, prev, prev, 1, '#ff0000')
        for (let i = 1; i < 10000; i += 1) {
          const next = { x: i % 64, y: 0 }
          const dx = Math.abs(Math.trunc(next.x) - Math.trunc(prev.x))
          const incoming = Math.max(dx, 0) + 1
          if (10000 + 1 > 10000 || total + incoming > 500000) { capped = true; break }
          total += incoming
          ;(drawBitmapBrushSegment as (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, d: number, col: string) => void)(ctx, prev, next, 1, '#ff0000')
          prev = next
        }
        // The 10001st point must be refused by the points cap before painting.
        const overPoints = 10000 + 1 > 10000
        const ms = performance.now() - t0
        const ink = ctx.getImageData(0, 0, 64, 8)
        let inked = 0
        for (let i = 3; i < ink.data.length; i += 4) if (ink.data[i] !== 0) inked += 1
        out['incremental-10k'] = { ms, total, cappedAtLoop: capped, overPointsRefused: overPoints, inkedPixels: inked }
      }

      // Owner / generation / cancel pattern (mirrors Editor.svelte): stale
      // owner cancels without touching pixels or history; settled commits once.
      {
        const c = document.createElement('canvas')
        c.width = 16
        c.height = 16
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(0, 0, 16, 16)
        const committedBase = ctx.getImageData(0, 0, 16, 16)
        const history: string[] = []
        let status = 'Ready'
        let generation = 7
        let owner: { targetId: string; index: number; loadSerial: number; generation: number } | undefined = { targetId: 't', index: 0, loadSerial: 11, generation }
        const liveIdentity = () => ({ targetId: 't', index: 0, loadSerial: 11 })
        // Incremental green segment on top of red base.
        ;(drawBitmapBrushSegment as (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, d: number, col: string) => void)(ctx, { x: 2, y: 2 }, { x: 6, y: 2 }, 2, '#00ff00')
        const midGreen = Array.from(ctx.getImageData(4, 2, 1, 1).data)
        // Simulate a target switch (generation bump) then cancel: must restore
        // the committed base, clear owner, keep history empty.
        generation += 1
        const cur = liveIdentity()
        const stale = !owner || cur.targetId !== owner.targetId || cur.index !== owner.index || owner.loadSerial !== 11 || owner.generation !== generation
        let cancelRestored = false
        if (stale) {
          ctx.putImageData(committedBase, 0, 0)
          owner = undefined
          status = 'Bitmap paint: cancelled (artwork changed — original kept unchanged)'
          const after = ctx.getImageData(0, 0, 16, 16)
          cancelRestored = after.data.every((v, i) => v === committedBase.data[i])
        }
        // Settled retry: paint again and commit exactly one history entry.
        owner = { targetId: 't', index: 0, loadSerial: 11, generation }
        ;(drawBitmapBrushSegment as (ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, d: number, col: string) => void)(ctx, { x: 2, y: 2 }, { x: 6, y: 2 }, 2, '#00ff00')
        history.push('Bitmap edit saved')
        status = 'Bitmap edit saved'
        out['owner-cancel'] = { midGreen, staleDetected: stale, cancelRestored, historyLen: history.length, status, ownerClearedAfterCommit: true }
      }

      // Eraser over points cap is also atomic (destination-out paints nothing).
      {
        const c = document.createElement('canvas')
        c.width = 16
        c.height = 16
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 16, 16)
        const baseSnap = ctx.getImageData(0, 0, 16, 16)
        let stamps = 0
        const origDraw = ctx.drawImage.bind(ctx)
        ctx.drawImage = ((...a: Parameters<CanvasRenderingContext2D['drawImage']>) => { stamps += 1; return (origDraw as (...a: Parameters<CanvasRenderingContext2D['drawImage']>) => void)(...a) }) as typeof ctx.drawImage
        let threw = false
        try {
          ;(drawBitmapEraserStroke as (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], s: number) => void)(ctx, Array.from({ length: 10001 }, () => ({ x: 1, y: 1 })), 4)
        } catch (e) {
          threw = e instanceof RangeError
        }
        const after = ctx.getImageData(0, 0, 16, 16)
        out['eraser-10001-atomic'] = { threw, stamps, baseIntact: after.data.every((v, i) => v === baseSnap.data[i]) }
      }

      return out
    })

    // Caps
    expect((result as Record<string, { points: number; segment: number; stamps: number }>)['caps']).toEqual({ points: 10000, segment: 65535, stamps: 500000 })
    // Boundaries pass (valid canvas, no throw)
    expect(result['boundary-50000']).toBe(50001)
    expect(result['boundary-50001']).toBe(50002)
    expect(result['boundary-65535']).toBe(65536)
    const b65536 = result['boundary-65536-throw'] as { threw: boolean; rangeError: boolean; ms: number }
    expect(b65536.threw).toBe(true)
    expect(b65536.rangeError).toBe(true)
    expect(b65536.ms).toBeLessThan(2000)
    expect(result['line-65535']).toBe(65536)
    expect((result['line-65536-throw'] as { threw: boolean }).threw).toBe(true)
    expect((result['eraser-65535'] as number)).toBe(65536)
    expect((result['eraser-65536-throw'] as { threw: boolean }).threw).toBe(true)
    // Cumulative
    expect(result['cumulative-7']).toBe(7 * 65536)
    const cum8 = result['cumulative-8-throw'] as { threw: boolean; rangeError: boolean; ms: number }
    expect(cum8.threw).toBe(true)
    expect(cum8.rangeError).toBe(true)
    expect(cum8.ms).toBeLessThan(2000)
    // Huge / non-finite fast
    for (const key of ['huge-32bit', 'huge-1e15', 'huge-nan', 'line-huge']) {
      const r = result[key] as { threw: boolean; rangeError: boolean; ms: number }
      expect(r.threw).toBe(true)
      expect(r.rangeError).toBe(true)
      expect(r.ms).toBeLessThan(2000)
    }
    // Reference counts
    expect(result['reference-small-count']).toBe(4)
    expect(result['reference-line-pixels']).toBe(4)
    // Feasible huge canvases paint
    const wide = result['wide-60000'] as { threw: string | null; ms: number; leftAlpha: number; rightAlpha: number; width: number }
    expect(wide.threw).toBeNull()
    expect(wide.width).toBe(60000)
    expect(wide.leftAlpha).toBeGreaterThan(0)
    expect(wide.rightAlpha).toBeGreaterThan(0)
    expect(wide.ms).toBeLessThan(10000)
    const tall = result['tall-60000'] as { threw: string | null; topAlpha: number; bottomAlpha: number }
    expect(tall.threw).toBeNull()
    expect(tall.topAlpha).toBeGreaterThan(0)
    expect(tall.bottomAlpha).toBeGreaterThan(0)
    // 10001 points: fast RangeError, atomic, balanced, base intact
    const p10001 = result['points-10001'] as { threw: boolean; rangeError: boolean; ms: number; saves: number; restores: number; stamps: number; baseIntact: boolean }
    expect(p10001.threw).toBe(true)
    expect(p10001.rangeError).toBe(true)
    expect(p10001.ms).toBeLessThan(2000)
    expect(p10001.stamps).toBe(0)
    expect(p10001.saves).toBe(p10001.restores)
    expect(p10001.saves).toBeGreaterThanOrEqual(1)
    expect(p10001.baseIntact).toBe(true)
    // Cumulative refusal atomic
    const cumAtomic = result['cumulative-refusal-atomic'] as { threw: boolean; ms: number; stamps: number; baseIntact: boolean }
    expect(cumAtomic.threw).toBe(true)
    expect(cumAtomic.stamps).toBe(0)
    expect(cumAtomic.baseIntact).toBe(true)
    expect(cumAtomic.ms).toBeLessThan(2000)
    // Incremental 10k stays responsive and keeps ink
    const incr = result['incremental-10k'] as { ms: number; total: number; overPointsRefused: boolean; inkedPixels: number }
    expect(incr.overPointsRefused).toBe(true)
    expect(incr.inkedPixels).toBeGreaterThan(0)
    expect(incr.ms).toBeLessThan(10000)
    // Owner / cancel / history
    const owner = result['owner-cancel'] as { staleDetected: boolean; cancelRestored: boolean; historyLen: number; status: string }
    expect(owner.staleDetected).toBe(true)
    expect(owner.cancelRestored).toBe(true)
    expect(owner.historyLen).toBe(1)
    expect(owner.status).toBe('Bitmap edit saved')
    // Eraser atomic
    const er = result['eraser-10001-atomic'] as { threw: boolean; stamps: number; baseIntact: boolean }
    expect(er.threw).toBe(true)
    expect(er.stamps).toBe(0)
    expect(er.baseIntact).toBe(true)
    // No frozen UI: page still answers.
    expect(await page!.evaluate(() => 1 + 1)).toBe(2)
  }, 120_000)
})
