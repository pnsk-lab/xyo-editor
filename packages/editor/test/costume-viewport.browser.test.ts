import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Browser proof for `costume-viewport.ts` against the real CSS engine.
//
// The helper is pure (no DOM), but its contract is the exact style binding
// used by `BitmapEditor.svelte`:
//
//   width:Wpx;height:Hpx;
//   transform:translate(calc(-50% + <vx>px), calc(-50% + <vy>px)) scale(<s>);
//   transform-origin:center
//
// on a `left:50%;top:50%` child of the viewport container, with the
// 2400x1800 edit surface. Here a synthetic container/inner pair uses that
// same markup, the test measures `getBoundingClientRect()` (real CSS
// scaling, including `transform-origin`), and asserts:
// - `predictSurfaceRect` matches the measured rect within 1px,
// - pointer-fixed zoom keeps the measured screen point within 1px across
//   clamp limits and several magnifications,
// - ctrl/meta zoom, shift horizontal pan, and line-mode (x15) wheel branches
//   resolve through the same helper inside Chromium.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4293'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('costume viewport CSS transform in a real browser', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4293', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('predicts the real CSS rect within 1px at several scales', async () => {
    const result = await page.evaluate(async () => {
      const viewport = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      // Same structure as BitmapEditor: relative container + absolute
      // left-1/2 top-1/2 surface with the identical transform string.
      const container = document.createElement('div')
      container.style.cssText =
        'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.innerHTML = ''
      document.body.appendChild(container)
      const surface = document.createElement('div')
      surface.style.cssText =
        'position:absolute;left:50%;top:50%;width:2400px;height:1800px;transform-origin:center;'
      container.appendChild(surface)

      const cases = [
        { x: 0, y: 0, scale: 1 },
        { x: 30, y: -20, scale: 2 },
        { x: -100, y: 50, scale: 0.5 },
        { x: 12, y: 34, scale: 0.25 },
        { x: 0, y: 0, scale: 5 },
      ]
      const errors: number[] = []
      for (const state of cases) {
        surface.style.transform = `translate(calc(-50% + ${state.x}px), calc(-50% + ${state.y}px)) scale(${state.scale})`
        // Force layout.
        void surface.offsetWidth
        const containerRect = container.getBoundingClientRect()
        const center = {
          x: containerRect.left + containerRect.width / 2,
          y: containerRect.top + containerRect.height / 2,
        }
        const predicted = viewport.predictSurfaceRect({ width: 2400, height: 1800 }, center, state)
        const measured = surface.getBoundingClientRect()
        errors.push(
          Math.abs(predicted.left - measured.left),
          Math.abs(predicted.top - measured.top),
          Math.abs(predicted.width - measured.width),
          Math.abs(predicted.height - measured.height),
        )
      }
      document.body.innerHTML = ''
      return { maxError: Math.max(...errors), errors }
    })
    expect(result.maxError).toBeLessThan(1)
  })

  it('keeps the pointer fixed within 1px on real measured rects', async () => {
    const result = await page.evaluate(async () => {
      const viewport = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      const container = document.createElement('div')
      container.style.cssText =
        'position:relative;width:800px;height:600px;overflow:hidden;margin:0;padding:0;'
      document.body.innerHTML = ''
      document.body.appendChild(container)
      const surface = document.createElement('div')
      surface.style.cssText =
        'position:absolute;left:50%;top:50%;width:2400px;height:1800px;transform-origin:center;'
      container.appendChild(surface)

      const apply = (state: { x: number; y: number; scale: number }) => {
        surface.style.transform = `translate(calc(-50% + ${state.x}px), calc(-50% + ${state.y}px)) scale(${state.scale})`
        void surface.offsetWidth
      }
      // Editor-style mapping through the live rect (same as
      // `bitmapPointFromEvent`: (client - rect.left) / rect.width * W).
      const toSurface = (clientX: number, clientY: number) => {
        const rect = surface.getBoundingClientRect()
        return {
          x: ((clientX - rect.left) / rect.width) * 2400,
          y: ((clientY - rect.top) / rect.height) * 1800,
        }
      }
      const toScreen = (sx: number, sy: number) => {
        const rect = surface.getBoundingClientRect()
        return {
          x: rect.left + (sx / 2400) * rect.width,
          y: rect.top + (sy / 1800) * rect.height,
        }
      }

      const scales = [0.5, 1, 2]
      const factors = [1.1, 0.9, 1.15, 0.85, 2, 0.5]
      const anchors = [
        { dx: 0, dy: 0 },
        { dx: 120, dy: 80 },
        { dx: -200, dy: 150 },
      ]
      let maxError = 0
      for (const scale of scales) {
        for (const factor of factors) {
          for (const anchor of anchors) {
            const containerRect = container.getBoundingClientRect()
            const center = {
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + containerRect.height / 2,
            }
            const start = { x: 12, y: -34, scale }
            apply(start)
            const pointer = { x: center.x + anchor.dx, y: center.y + anchor.dy }
            // Surface point under the cursor, measured through the real rect.
            const fixed = toSurface(pointer.x, pointer.y)
            // Pure helper computes the pinned viewport (clamped to 0.25..5).
            const zoomed = viewport.zoomViewportAtScreenPoint(
              start,
              { width: 2400, height: 1800 },
              center,
              pointer,
              factor,
            )
            apply(zoomed.viewport)
            const back = toScreen(fixed.x, fixed.y)
            const error = Math.hypot(back.x - pointer.x, back.y - pointer.y)
            if (error > maxError) maxError = error
            if (!(error < 1)) {
              return { maxError: error, failed: { scale, factor, anchor, error } }
            }
          }
        }
      }
      // Clamp boundaries still pin the point on the real rect.
      apply({ x: 0, y: 0, scale: 0.3 })
      {
        const containerRect = container.getBoundingClientRect()
        const center = {
          x: containerRect.left + containerRect.width / 2,
          y: containerRect.top + containerRect.height / 2,
        }
        const pointer = { x: center.x + 120, y: center.y + 80 }
        const fixed = toSurface(pointer.x, pointer.y)
        const zoomed = viewport.zoomViewportAtScreenPoint(
          { x: 0, y: 0, scale: 0.3 },
          { width: 2400, height: 1800 },
          center,
          pointer,
          0.1,
        )
        if (zoomed.viewport.scale !== 0.25) return { maxError, failed: { reason: 'low clamp', scale: zoomed.viewport.scale } }
        apply(zoomed.viewport)
        const back = toScreen(fixed.x, fixed.y)
        const error = Math.hypot(back.x - pointer.x, back.y - pointer.y)
        if (error > maxError) maxError = error
        if (!(error < 1)) return { maxError: error, failed: { reason: 'low pin', error } }
      }
      document.body.innerHTML = ''
      return { maxError, failed: undefined as unknown as undefined }
    })
    expect(result.failed).toBeUndefined()
    expect(result.maxError).toBeLessThan(1)
  })

  it('resolves ctrl/meta, shift, and deltaMode branches in the browser', async () => {
    const result = await page.evaluate(async () => {
      const viewport = await import(/* @vite-ignore */ '/src/features/costumes/costume-viewport.ts')
      const base = { x: 10, y: 20, scale: 1 }
      const center = { x: 500, y: 400 }
      const surface = { width: 2400, height: 1800 }
      const pointer = { x: 620, y: 480 }

      const ctrlZoom = viewport.resolveWheelViewport(
        base,
        { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true },
        { surface, containerCenter: center, screenPoint: pointer },
      )
      const metaZoom = viewport.resolveWheelViewport(
        base,
        { deltaX: 0, deltaY: -100, deltaMode: 0, metaKey: true },
        { surface, containerCenter: center, screenPoint: pointer },
      )
      const shiftPan = viewport.resolveWheelViewport(
        base,
        { deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true },
        {},
      )
      const linePan = viewport.resolveWheelViewport(base, { deltaX: 0, deltaY: 2, deltaMode: 1 }, {})
      const plainPan = viewport.resolveWheelViewport(base, { deltaX: 10, deltaY: 20, deltaMode: 0 }, {})

      const fixed = viewport.screenToSurface(pointer, surface, center, base)
      const pin = (resolution: typeof ctrlZoom) => {
        if (resolution.kind !== 'zoom') return Number.POSITIVE_INFINITY
        const after = viewport.surfaceToScreen(fixed, surface, center, resolution.viewport)
        return Math.hypot(after.x - pointer.x, after.y - pointer.y)
      }
      return {
        ctrlKind: ctrlZoom.kind,
        ctrlScale: ctrlZoom.kind === 'zoom' ? ctrlZoom.viewport.scale : 0,
        ctrlPin: pin(ctrlZoom),
        metaKind: metaZoom.kind,
        metaScale: metaZoom.kind === 'zoom' ? metaZoom.viewport.scale : 0,
        metaPin: pin(metaZoom),
        shiftKind: shiftPan.kind,
        shiftViewport: shiftPan.viewport,
        lineViewport: linePan.viewport,
        plainViewport: plainPan.viewport,
        clampLow: viewport.clampViewportScale(0.1),
        clampHigh: viewport.clampViewportScale(99),
      }
    })
    expect(result.ctrlKind).toBe('zoom')
    expect(result.ctrlScale).toBeCloseTo(1.1, 10)
    expect(result.ctrlPin).toBeLessThan(1)
    expect(result.metaKind).toBe('zoom')
    expect(result.metaScale).toBeCloseTo(1.1, 10)
    expect(result.metaPin).toBeLessThan(1)
    expect(result.shiftKind).toBe('pan')
    // Shift+vertical wheel becomes horizontal pan: vx moves by -30.
    expect(result.shiftViewport).toEqual({ x: -20, y: 20, scale: 1 })
    // Line mode x15: dy=2 lines -> 30px pan.
    expect(result.lineViewport).toEqual({ x: 10, y: -10, scale: 1 })
    expect(result.plainViewport).toEqual({ x: 0, y: 0, scale: 1 })
    expect(result.clampLow).toBe(0.25)
    expect(result.clampHigh).toBe(5)
  })
})
