import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Chrome parity for arbitrary bitmap rotation:
// - Canvas default smoothing vs the reference-forced `imageSmoothingEnabled = false`.
// - Current helper `rotateFloatingPatch` (nearest, verbatim RGBA) vs canvas
//   `drawImage` with smoothing off/on for interior vs full-bleed patterns.
// - Safe `rotateFloatingPatchWithHalo` edge behaviour (masked: no neighbour leak).
// This file only exercises feature helpers through real DOM canvases; it never
// touches Editor.svelte / BitmapEditor.svelte wiring.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4281'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('bitmap floating arbitrary-rotation parity with real Canvas', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4281', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
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
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('reports fresh smoothing defaults and scratch-forced smoothing-off', async () => {
    const result = await page.evaluate(() => {
      const fresh = document.createElement('canvas').getContext('2d')!.imageSmoothingEnabled
      const freshQuality = document.createElement('canvas').getContext('2d')!.imageSmoothingQuality
      const forced = document.createElement('canvas')
      forced.width = 480
      forced.height = 360
      forced.getContext('2d')!.imageSmoothingEnabled = false
      return { fresh, freshQuality, forcedOff: forced.getContext('2d')!.imageSmoothingEnabled }
    })
    // Chrome default is smoothed; the reference bitmap path forces it off on
    // every raster canvas it creates. The committed helper path is
    // smoothing-independent (verbatim nearest sampling + putImageData).
    expect(result.fresh).toBe(true)
    expect(result.forcedOff).toBe(false)
    expect(typeof result.freshQuality).toBe('string')
  }, 30_000)

  it('matches canvas nearest-neighbour on interior pixels and stays unsmoothed', async () => {
    const result = await page.evaluate(async () => {
      const { rotateFloatingPatch, rotateFloatingPatchWithHalo } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const makeSrc = (draw: (x: CanvasRenderingContext2D) => void) => {
        const c = document.createElement('canvas')
        c.width = 10
        c.height = 10
        const x = c.getContext('2d')!
        x.clearRect(0, 0, 10, 10)
        draw(x)
        return c
      }
      const canvasRotated = (src: HTMLCanvasElement, deg: number, smoothing: boolean) => {
        const rad = (deg * Math.PI) / 180
        const cos = Math.abs(Math.cos(rad))
        const sin = Math.abs(Math.sin(rad))
        const ow = Math.ceil(src.width * cos + src.height * sin)
        const oh = Math.ceil(src.width * sin + src.height * cos)
        const dst = document.createElement('canvas')
        dst.width = ow
        dst.height = oh
        const d = dst.getContext('2d')!
        d.imageSmoothingEnabled = smoothing
        d.translate(ow / 2, oh / 2)
        d.rotate(rad)
        d.drawImage(src, -src.width / 2, -src.height / 2)
        return d.getImageData(0, 0, ow, oh)
      }
      const diffPixels = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let px = 0
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) px += 1
        }
        return px
      }
      const semiCount = (d: Uint8ClampedArray) => {
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0 && d[i]! < 255) n += 1
        return n
      }
      // Interior case: opaque block + interior hole with a transparent margin,
      // so no opaque touches the patch boundary.
      const interior = makeSrc((x) => {
        x.fillStyle = '#ff0000'
        x.fillRect(2, 2, 6, 6)
        x.clearRect(4, 4, 2, 2)
      })
      const raw = interior.getContext('2d')!.getImageData(0, 0, 10, 10)
      const patch = { width: 10, height: 10, data: raw.data }
      const helper15 = rotateFloatingPatch(patch, 15)
      const nn15 = canvasRotated(interior, 15, false)
      const sm15 = canvasRotated(interior, 15, true)
      // Full-bleed case: opaque touches the patch boundary (trimmed edge).
      const edge = makeSrc((x) => {
        x.fillStyle = '#ff0000'
        x.fillRect(0, 0, 10, 10)
        x.clearRect(4, 4, 2, 2)
      })
      const edgeRaw = edge.getContext('2d')!.getImageData(0, 0, 10, 10)
      const edgePatch = { width: 10, height: 10, data: edgeRaw.data }
      const edgeHelper = rotateFloatingPatch(edgePatch, 15)
      const edgeNN = canvasRotated(edge, 15, false)
      // Halo: the same edge patch centered in a blue 14x14 field.
      const haloCanvas = document.createElement('canvas')
      haloCanvas.width = 14
      haloCanvas.height = 14
      const hx = haloCanvas.getContext('2d')!
      hx.fillStyle = '#0000ff'
      hx.fillRect(0, 0, 14, 14)
      hx.drawImage(edge, 2, 2)
      const haloRaw = hx.getImageData(0, 0, 14, 14)
      const haloed = rotateFloatingPatchWithHalo(
        { width: 10, height: 10, data: new Uint8ClampedArray(edgeRaw.data) },
        { image: { width: 14, height: 14, data: haloRaw.data }, offsetX: 2, offsetY: 2 },
        15,
      )
      let haloBlue = 0
      for (let i = 0; i < haloed.patch.data.length; i += 4) {
        if (haloed.patch.data[i] === 0 && haloed.patch.data[i + 1] === 0 && haloed.patch.data[i + 2] === 255 && haloed.patch.data[i + 3] === 255) haloBlue += 1
      }
      return {
        interiorSize: [helper15.patch.width, helper15.patch.height, nn15.width, nn15.height],
        interiorDiffNN: diffPixels(helper15.patch.data, nn15.data),
        interiorDiffSM: diffPixels(helper15.patch.data, sm15.data),
        interiorSemi: [semiCount(helper15.patch.data), semiCount(nn15.data), semiCount(sm15.data)],
        edgeSize: [edgeHelper.patch.width, edgeHelper.patch.height, edgeNN.width, edgeNN.height],
        edgeDiffNN: diffPixels(edgeHelper.patch.data, edgeNN.data),
        edgeSemi: [semiCount(edgeHelper.patch.data), semiCount(edgeNN.data)],
        haloSize: [haloed.patch.width, haloed.patch.height],
        haloBlue,
        haloChanged: haloed.changed,
      }
    })
    expect(result.interiorSize[0]).toBe(result.interiorSize[2])
    expect(result.interiorSize[1]).toBe(result.interiorSize[3])
    // Interior opaque/hole pixels: helper == canvas nearest-neighbour byte-exact.
    expect(result.interiorDiffNN).toBe(0)
    // Smoothed canvas blends the same interior edges, so it must differ.
    expect(result.interiorDiffSM).toBeGreaterThan(0)
    expect(result.interiorSemi[0]).toBe(0)
    expect(result.interiorSemi[1]).toBe(0)
    expect(result.interiorSemi[2]).toBeGreaterThan(0)
    // Trimmed outer edge: isolated-patch canvas blends at the image boundary
    // even with smoothing off, while the helper stays hard/verbatime.
    expect(result.edgeSize[0]).toBe(result.edgeSize[2])
    expect(result.edgeDiffNN).toBeGreaterThan(0)
    expect(result.edgeSemi[0]).toBe(0)
    expect(result.edgeSemi[1]).toBeGreaterThan(0)
    // Safe halo rotation keeps the tight box and stays masked: no neighbour blue.
    expect(result.haloSize).toEqual([result.edgeSize[0], result.edgeSize[1]])
    expect(result.haloChanged).toBe(true)
    expect(result.haloBlue).toBe(0)
  }, 30_000)
})
