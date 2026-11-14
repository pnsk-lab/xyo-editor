// Paper-truth browser diagnostics (READ-ONLY, no product change).
//
// Paper実体を正とする実Chrome測定。Scratch GUIフル起動は行わない:
// .tmp/scratch-editor にはインストール済み依存がなく (node_modulesなし)、
// playground起動には npm ci + webpack build が要るため、既存serverに触れ
// ず独立portで再現可能な最小harness (Paper実体 + 参照式の実呼) を選んだ。
// - Paper実体: npm `paper` UMD (MIT, paper.js本家) を実Chromeに載せ、
//   `paper.setup` / view.zoom・center・scrollBy / projectToView /
//   Rectangle.expand / Raster相当の2D drawImage / Group scale・translate を
//   実際に呼ぶ。AGPLコードのコピーはしない (参照 view.js/layer.js/
//   paper-canvas.jsx/paint-editor.jsx/scrollable-canvas.jsx の式は
//   行番号付きで引用し、実行は Paper公開API経由の同値呼に留める)。
// - 現行UI座標表: 実エディター (独立port 4531/managed child vite) の
//   canvas rect・container rect・DPR を実測する。
//
// 測定項目:
//  A. 幅480 Scratch stage-units -> screen何CSS pxか (bitmap 480P /
//     vector 960P の両読取、zoom 0.5/1.0/0.333)
//  B. anchor world座標 (zoomOnFixedPoint実呼の固定点不動 + 新中心)
//  C. res1 assets の loadBitmap/import transform (96x96 res1 ->
//     原点432,312 の実画素証明、二重drawImage含む)
//  D. vector import transform (2x + CENTER-rotationPoint*2 の実呼)
//  E. reset・wheel・button・pan limits (Paper実体で駆動)
//  F. fit/workspace clamp (Rectangle.expand(50) の実体証明含む)
//  G. 同期/非同期・DPR・container寸法の分離記録
//  H. 現行UI canvas rect座標表
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/paper-truth-viewport-diagnostics.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4531'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page
let paperUmd: string

async function waitZoomLabel(text: string, timeout = 10_000) {
  await page.waitForFunction(
    (want) => document.querySelector('[aria-label="Reset zoom"]')?.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout },
  )
}

async function openCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-testid="costume-paint-surface"]')
    if (!target) return false
    const rect = target.getBoundingClientRect()
    return rect.width > 50 && rect.height > 50
  }, null, { timeout: 10_000 })
}

async function ensureVectorMode() {
  const toVector = await page.getByRole('button', { name: 'ベクターに変換' }).count()
  if (toVector > 0) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.waitForFunction(() => !!document.querySelector('[data-vector-stage-surface="true"]'), null, {
      timeout: 10_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function ensureBitmapMode() {
  const toBitmap = await page.getByRole('button', { name: 'ビットマップに変換' }).count()
  if (toBitmap > 0) {
    await page.getByRole('button', { name: 'ビットマップに変換' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function resetZoomUi() {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click()
  })
  await waitZoomLabel('100%')
  await new Promise((resolve) => setTimeout(resolve, 150))
}

describe('paper-truth browser diagnostics (read-only)', () => {
  beforeAll(async () => {
    paperUmd = await Bun.file(
      join(root, 'node_modules', 'paper', 'dist', 'paper-full.js'),
    ).text()
    if (!paperUmd.includes('Paper.js')) throw new Error('paper UMD not loaded')
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4531', '--strictPort'], {
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

  it('H: current UI canvas rect coordinate table (vector+bitmap reset, DPR, container)', async () => {
    await openCostumes()
    await ensureVectorMode()
    await resetZoomUi()
    const vector = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-vector-stage-surface="true"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = surface.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        styleWidth: surface.style.width,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        overflow: getComputedStyle(container).overflow,
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`PAPER_TRUTH_UI_VECTOR ${JSON.stringify(vector)}`)
    expect(vector.styleWidth).toBe('2400px')
    expect(Math.abs(vector.rect.width - 2400)).toBeLessThan(2)
    expect(vector.label).toContain('100%')

    await ensureBitmapMode()
    await resetZoomUi()
    const bitmap = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const container = document.querySelector('[data-testid="costume-paint-surface"]')!
      const r = canvas.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        canvasBacking: { width: canvas.width, height: canvas.height },
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        container: { left: c.left, top: c.top, width: c.width, height: c.height },
        label: document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '',
      }
    })
    console.log(`PAPER_TRUTH_UI_BITMAP ${JSON.stringify(bitmap)}`)
    // rect == canvas backing * scale(1) within 1.5px (scale追従の実測).
    expect(Math.abs(bitmap.rect.width - bitmap.canvasBacking.width)).toBeLessThan(1.5)
    const res = bitmap.canvasBacking.width / 480 >= 1.5 ? 2 : 1
    console.log(`PAPER_TRUTH_UI_BITMAP_RES ${JSON.stringify({ backing: bitmap.canvasBacking, classifiedRes: res })}`)
    expect(bitmap.label).toContain('100%')
  }, 120_000)

  it('A-G: Paper-entity harness (480units/anchor/res1/vector/limits/fit/sync)', async () => {
    await page.goto('about:blank')
    await page.addScriptTag({ content: paperUmd })
    const report = await page.evaluate(async () => {
      const P = (window as unknown as { paper: typeof import('paper') }).paper
      const out: Record<string, unknown> = {}
      const t0 = performance.now()
      // --- container + DPR [G] ---
      const container = document.createElement('div')
      container.style.cssText = 'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.appendChild(container)
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:800px;height:600px;display:block;'
      container.appendChild(canvas)
      out.dpr = window.devicePixelRatio
      // --- paper.setup は同期 [G/確定 paper-canvas.jsx:46] ---
      P.setup(canvas)
      out.setupMs = performance.now() - t0
      const canvasRect = canvas.getBoundingClientRect()
      out.containerCss = { w: 800, h: 600 }
      out.canvasRect = { w: canvasRect.width, h: canvasRect.height }
      out.viewSize = { w: P.view.viewSize.width, h: P.view.viewSize.height }

      // --- reset: zoom=0.5 [E/確定 view.js:144-149] ---
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)
      out.reset = { zoom: P.view.zoom, center: { x: P.view.center.x, y: P.view.center.y } }

      // --- A: 480 stage-units -> CSS px (projectToView実呼) ---
      const span = (x0: number, x1: number, y: number) => {
        const a = P.view.projectToView(new P.Point(x0, y)) as unknown as { x: number }
        const b = P.view.projectToView(new P.Point(x1, y)) as unknown as { x: number }
        return Math.abs(b.x - a.x)
      }
      const measureAt = (zoom: number) => {
        P.view.zoom = zoom
        P.view.center = new P.Point(480, 360)
        return {
          zoom,
          bitmap480: span(240, 720, 360), // bitmap読取: 480 units = 480 Paper
          vector480: span(0, 960, 360), // vector読取: 480 units = 960 Paper (2x)
        }
      }
      out.camera = [measureAt(0.5), measureAt(1.0), measureAt(0.333)]
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)

      // --- B: zoomOnFixedPoint実呼 (view.js:108-117の式を通す) ---
      const zoomOnFixedPoint = (deltaZoom: number, fixed: { x: number; y: number }) => {
        const view = P.view
        const preZoomCenter = view.center.clone() as unknown as {
          x: number
          y: number
          subtract(p: unknown): { multiply(s: number): { x: number; y: number } }
        }
        const newZoom = Math.max(0.333, view.zoom + deltaZoom)
        const scaling = view.zoom / newZoom
        const fp = new P.Point(fixed.x, fixed.y)
        const preZoomOffset = fp.subtract(preZoomCenter)
        const postZoomOffset = fp.subtract(preZoomOffset.multiply(scaling)).subtract(preZoomCenter)
        const before = view.projectToView(fp.clone())
        view.zoom = newZoom
        view.translate(postZoomOffset.multiply(-1))
        const after = view.projectToView(fp.clone())
        return {
          newZoom,
          postOffset: { x: postZoomOffset.x, y: postZoomOffset.y },
          center: { x: view.center.x, y: view.center.y },
          pinErr: Math.hypot(after.x - before.x, after.y - before.y),
        }
      }
      out.anchorPlus = zoomOnFixedPoint(0.5, { x: 580, y: 410 })
      // 無選択フォールバック: view.center固定の不動確認.
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)
      const c0 = P.view.projectToView(new P.Point(480, 360))
      out.anchorFallback = zoomOnFixedPoint(0.5, { x: 480, y: 360 })
      const c1 = P.view.projectToView(new P.Point(out.anchorFallback.center.x, out.anchorFallback.center.y))
      out.anchorFallbackScreenDrift = Math.hypot(c1.x - c0.x, c1.y - c0.y)

      // --- E: button/wheel/pan limits (Paper実体で駆動) ---
      P.view.zoom = 0.5
      const step = (z: number, d: number) => {
        // paint-editor.jsx:211-217 floor-exit則込み.
        let inc = d
        if (d > 0 && Math.abs(z - 0.333) < 1e-12) inc = 0.5 - 0.333
        return Math.max(0.333, z + inc)
      }
      out.buttons = {
        plus: step(1, 0.5),
        minus: step(1, -0.5),
        floorExit: step(0.333, 0.5),
        floorStick: Math.max(0.333, 0.5 - 0.5),
      }
      const wheel = (z: number, dy: number, mode = 0) => Math.max(0.333, z + -dy * (mode === 1 ? 15 : 1) / 1000)
      out.wheel = { tickDown100: wheel(0.5, -100), tickUp120: wheel(0.5, 120), lineMode: wheel(0.5, -7, 1) }
      // pan: scrollBy(dx/zoom) — scroll前後の view.center 実測.
      P.view.zoom = 0.5
      P.view.center = new P.Point(480, 360)
      const beforePan = { x: P.view.center.x, y: P.view.center.y }
      P.view.scrollBy(new P.Point(120 / 0.5, 0))
      out.pan = { before: beforePan, after: { x: P.view.center.x, y: P.view.center.y }, dxWorld: 240 }
      // scrollbar gain: tx += dx*zoom*2 の数値例.
      out.scrollbar = { dx10at05: 10 * 0.5 * 2 }

      // --- F: Rectangle.expand(50) の実体証明 + fit数値例 ---
      const r = new P.Rectangle(0, 0, 400, 300).expand(50)
      out.expand50 = { w: r.width, h: r.height } // +50 total/app (xv: 450x350)
      const fit = (bw: number, bh: number, cw: number, ch: number, isBitmap: boolean) => {
        const paddedW = (bw + (isBitmap ? 50 : 0)) * 1.5
        const paddedH = (bh + (isBitmap ? 50 : 0)) * 1.5
        const ratio = Math.max(0.125, Math.min(1, 0.5 * Math.max(paddedW / cw, paddedH / ch)))
        return ratio < 1 ? 0.5 / ratio : 0.5
      }
      out.fit400x300in800x600 = { bitmap: fit(400, 300, 800, 600, true), vector: fit(400, 300, 800, 600, false) }

      // --- C: res1 import transform実呼 (96x96 -> 原点432,312, 二重draw) ---
      const art = document.createElement('canvas')
      art.width = 960
      art.height = 720
      const actx = art.getContext('2d')!
      actx.imageSmoothingEnabled = false
      const src96 = document.createElement('canvas')
      src96.width = 96
      src96.height = 96
      const sctx = src96.getContext('2d')!
      sctx.fillStyle = 'rgba(255,0,0,255)'
      sctx.fillRect(0, 0, 96, 96)
      const cx = 48
      const cy = 48
      const ox = 960 / 2 - cx // 432 [確定 paper-canvas.jsx:172-173]
      const oy = 720 / 2 - cy // 312
      actx.drawImage(src96, ox, oy)
      actx.drawImage(src96, ox, oy) // 二重draw (参照通り)
      const px = (x: number, y: number) => Array.from(actx.getImageData(x, y, 1, 1).data)
      out.res1import = {
        origin: { x: ox, y: oy },
        atOrigin: px(432, 312),
        outside: px(431, 311),
        farCorner: px(0, 0),
        doubleDrawSame: px(433, 313).join(',') === '255,0,0,255',
      }

      // --- D: vector import transform実呼 (scale 2 + translate) ---
      const item = new P.Path.Rectangle(new P.Point(0, 0), new P.Size(100, 50))
      item.scale(2, new P.Point(0, 0)) // scaleWithStrokes(item,2)相当 (strokeなし図形)
      const rotationPoint = new P.Point(20, 400)
      const t = new P.Point(480, 360).subtract(rotationPoint.multiply(2))
      item.translate(t)
      out.vectorImport = {
        translate: { x: t.x, y: t.y }, // (440,-440)
        bounds: {
          x: item.bounds.x,
          y: item.bounds.y,
          w: item.bounds.width,
          h: item.bounds.height,
        }, // (440,-440,200,100)
      }
      item.remove()

      // --- G: 非同期 (Image onload + setTimeout(0) recalibrate相当) ---
      const asyncProbe = await new Promise<{ onloadFired: boolean; timeout0Ms: number }>((resolve) => {
        const tStart = performance.now()
        const img = new Image()
        img.onload = () => {
          const tLoad = performance.now()
          setTimeout(() => resolve({ onloadFired: true, timeout0Ms: performance.now() - tLoad }), 0)
        }
        img.src = src96.toDataURL()
        setTimeout(() => resolve({ onloadFired: false, timeout0Ms: performance.now() - tStart }), 5000)
      })
      out.async = { ...asyncProbe, setupWasSync: (out.setupMs as number) < 1000 }
      container.remove()
      P.remove()
      return out
    })
    console.log(`PAPER_TRUTH_HARNESS ${JSON.stringify(report)}`)

    // --- A: カメラ表の確定 (Paper実体値) ---
    const camera = report.camera as Array<{ zoom: number; bitmap480: number; vector480: number }>
    expect(camera[0].bitmap480).toBeCloseTo(240, 0)
    expect(camera[0].vector480).toBeCloseTo(480, 0)
    expect(camera[1].bitmap480).toBeCloseTo(480, 0)
    expect(camera[1].vector480).toBeCloseTo(960, 0)
    expect(camera[2].vector480).toBeCloseTo(319.68, 0)
    // --- B: 固定点不動 (<0.5px) + postOffset (50,25) ---
    const anchor = report.anchorPlus as { postOffset: { x: number; y: number }; pinErr: number; newZoom: number }
    expect(anchor.newZoom).toBeCloseTo(1, 12)
    expect(anchor.postOffset.x).toBeCloseTo(50, 6)
    expect(anchor.postOffset.y).toBeCloseTo(25, 6)
    expect(anchor.pinErr).toBeLessThan(0.5)
    // --- C: res1原点 + 画素 ---
    const res1 = report.res1import as {
      origin: { x: number; y: number }
      atOrigin: number[]
      outside: number[]
      doubleDrawSame: boolean
    }
    expect(res1.origin).toEqual({ x: 432, y: 312 })
    expect(res1.atOrigin).toEqual([255, 0, 0, 255])
    expect(res1.outside[3]).toBe(0)
    expect(res1.doubleDrawSame).toBe(true)
    // --- D: vector 2x配置 ---
    const vec = report.vectorImport as {
      translate: { x: number; y: number }
      bounds: { x: number; y: number; w: number; h: number }
    }
    expect(vec.translate).toEqual({ x: 440, y: -440 })
    expect(vec.bounds.w).toBeCloseTo(200, 6)
    expect(vec.bounds.h).toBeCloseTo(100, 6)
    // --- E: limits ---
    const buttons = report.buttons as Record<string, number>
    expect(buttons.plus).toBeCloseTo(1.5, 12)
    expect(buttons.floorExit).toBeCloseTo(0.5, 12)
    expect(buttons.floorStick).toBeCloseTo(0.333, 12)
    const wheel = report.wheel as Record<string, number>
    expect(wheel.tickDown100).toBeCloseTo(0.6, 12)
    expect(wheel.tickUp120).toBeCloseTo(0.38, 12)
    // --- F: expand(50)は+50 total ---
    const expand = report.expand50 as { w: number; h: number }
    expect(expand.w).toBeCloseTo(450, 9)
    expect(expand.h).toBeCloseTo(350, 9)
    const fit = report.fit400x300in800x600 as { bitmap: number; vector: number }
    expect(fit.bitmap).toBeCloseTo(1.142857, 4)
    expect(fit.vector).toBeCloseTo(1.333333, 4)
    // --- G: 同期setup + 非同期fire ---
    const async = report.async as { onloadFired: boolean; setupWasSync: boolean }
    expect(async.onloadFired).toBe(true)
    expect(async.setupWasSync).toBe(true)
    console.log(
      `PAPER_TRUTH_DPR_CONTAINER ${JSON.stringify({ dpr: report.dpr, canvasRect: report.canvasRect, viewSize: report.viewSize })}`,
    )
  }, 120_000)
})
