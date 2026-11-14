import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Browser-side oracle for the FIT correction (`paper-viewport-parity.ts`):
// re-executes the reference `zoomToFit` lines in real Chromium against real
// Paper.js (`Rectangle.expand(50)` => +50 total per extent) and checks the
// helper agrees on concrete + extreme cases. Pure math, no editor UI.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4332'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('paper FIT oracle in a real browser', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4332', '--strictPort'], {
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
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('proves expand(50) and helper-vs-oracle agreement in Chromium', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    // Real Paper.js in the browser: inject the local UMD build (no CDN).
    await page.addScriptTag({ path: join(root, 'node_modules/paper/dist/paper-full.js') })
    const result = await page.evaluate(async () => {
      const parity = await import(/* @vite-ignore */ '/src/features/costumes/paper-viewport-parity.ts')
      const paper = (window as unknown as { paper: any }).paper
      // Real Paper.js proof in the browser: expand(50) is +50 total.
      const rect = new paper.Rectangle(10, 20, 100, 80)
      const expanded = rect.expand(50)
      // Independent oracle (reference lines, no helper).
      const oracle = (bw: number, bh: number, cw: number, ch: number, isBitmap: boolean): number => {
        const BASE = 0.5
        const MIN = 0.125
        if (!(bw > 0) || !(bh > 0) || !(cw > 0) || !(ch > 0)) return BASE
        if (![bw, bh, cw, ch].every(Number.isFinite)) return BASE
        const paddedW = (bw + (isBitmap ? 50 : 0)) * 1.5
        const paddedH = (bh + (isBitmap ? 50 : 0)) * 1.5
        const raw = BASE * Math.max(paddedW / cw, paddedH / ch)
        if (!Number.isFinite(raw) || raw <= 0) return BASE
        const ratio = Math.max(MIN, Math.min(1, raw))
        return ratio >= 1 ? BASE : BASE / ratio
      }
      const cases = [
        { b: { width: 10, height: 10 }, c: { width: 480, height: 360 }, m: false },
        { b: { width: 10, height: 10 }, c: { width: 480, height: 360 }, m: true },
        { b: { width: 100, height: 100 }, c: { width: 480, height: 360 }, m: false },
        { b: { width: 100, height: 100 }, c: { width: 480, height: 360 }, m: true },
        { b: { width: 400, height: 300 }, c: { width: 960, height: 720 }, m: false },
        { b: { width: 1, height: 2000 }, c: { width: 480, height: 360 }, m: true },
        { b: { width: 320, height: 240 }, c: { width: 50, height: 40 }, m: false },
        { b: { width: 320, height: 240 }, c: { width: 3840, height: 2160 }, m: true },
      ]
      const rows = cases.map(({ b, c, m }) => ({
        helper: parity.resolvePaperFitZoom(b, c, m),
        expected: oracle(b.width, b.height, c.width, c.height, m),
      }))
      return {
        expand: { x: expanded.x, y: expanded.y, w: expanded.width, h: expanded.height },
        rows,
        spotBitmap100: parity.resolvePaperFitZoom({ width: 100, height: 100 }, { width: 480, height: 360 }, true),
        spotVector100: parity.resolvePaperFitZoom({ width: 100, height: 100 }, { width: 480, height: 360 }, false),
        spotBitmap10: parity.resolvePaperFitZoom({ width: 10, height: 10 }, { width: 480, height: 360 }, true),
        failClosed: parity.resolvePaperFitZoom({ width: 0, height: 10 }, { width: 480, height: 360 }, false),
      }
    })
    const r = result as {
      expand: { x: number; y: number; w: number; h: number }
      rows: { helper: number; expected: number }[]
      spotBitmap100: number
      spotVector100: number
      spotBitmap10: number
      failClosed: number
    }
    expect(r.expand.w).toBeCloseTo(150, 10)
    expect(r.expand.h).toBeCloseTo(130, 10)
    expect(r.expand.x).toBeCloseTo(-15, 10)
    expect(r.expand.y).toBeCloseTo(-5, 10)
    for (const row of r.rows) {
      expect(Math.abs(row.helper - row.expected)).toBeLessThan(1e-12)
    }
    // Corrected concrete values: expand-then-pad, client CSS px units.
    expect(r.spotVector100).toBeCloseTo(2.4, 10)
    expect(r.spotBitmap100).toBeCloseTo(1.6, 10)
    expect(r.spotBitmap10).toBeCloseTo(4, 10)
    expect(r.failClosed).toBe(0.5)
  }, 120_000)
})
