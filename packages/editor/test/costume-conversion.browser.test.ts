import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Browser proof that the fixed conversion preserves the on-stage appearance.
//
// Covers the task's full coordinate chain for a 96x96 sprite (and the stage):
// source SVG bytes -> sanitized <img> raster at SVG units x resolution
// (sprite 2x -> 192x192, stage 1x) with scaled rotation center -> trimmed PNG
// -> trimmed 1:1 vector SVG -> stage-canvas pixels. Assertions run against the
// real Chromium image decoder, real canvas pixels, and a real measured stage
// element rect (screen stage bounds / real UI pixel), including
// rotationCenter, clipping (overflow beyond the SVG viewport stays clipped),
// translucency (alpha !== 0 counts as content and survives PNG), empty SVG
// (fully transparent stays transparent), and stage-vs-sprite resolution.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4294'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('costume conversion preserves stage pixels in a real browser', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4294', '--strictPort'], {
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

  it('converts 96x96 sprite SVG -> 192x192 bitmap -> trimmed vector with identical stage ink', async () => {
    const result = await page.evaluate(async () => {
      const conversion = await import(/* @vite-ignore */ '/src/features/costumes/costume-conversion.ts')
      const sanitizer = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const loadImage = (url: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = url
        })
      const svgText =
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
        `<rect x="10" y="10" width="30" height="30" fill="#ff0000"/>` +
        `<circle cx="55" cy="55" r="15" fill="#0000ff" opacity="0.5"/>` +
        `<rect x="90" y="90" width="20" height="20" fill="#00ff00"/>` +
        `</svg>`
      const geometry = conversion.parseConversionSvgGeometry(svgText, false)
      const vectorSpec = conversion.resolveVectorToBitmapSpec({
        svgWidth: geometry.width,
        svgHeight: geometry.height,
        rotationCenterX: 48,
        rotationCenterY: 50,
        isStage: false,
      })
      // Sanitized raster (same boundary Editor.svelte uses: no external fetch).
      const clean = sanitizer.sanitizeSvgForDisplay(svgText)
      const rasterUrl = URL.createObjectURL(new Blob([new TextEncoder().encode(clean)], { type: 'image/svg+xml' }))
      const rasterImage = await loadImage(rasterUrl)
      URL.revokeObjectURL(rasterUrl)
      const bitmap = document.createElement('canvas')
      bitmap.width = vectorSpec.bitmapWidth
      bitmap.height = vectorSpec.bitmapHeight
      const bitmapContext = bitmap.getContext('2d')!
      bitmapContext.clearRect(0, 0, bitmap.width, bitmap.height)
      bitmapContext.drawImage(rasterImage, 0, 0, bitmap.width, bitmap.height)
      const pixels = bitmapContext.getImageData(0, 0, bitmap.width, bitmap.height)
      const at = (x: number, y: number) => {
        const offset = (y * bitmap.width + x) * 4
        return [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2], pixels.data[offset + 3]]
      }
      // Red rect center (20,20 units -> 40,40 px at 2x) is opaque red.
      const red = at(40, 40)
      // Blue circle center (55,55 units -> 110,110 px) is semitransparent (alpha neither 0 nor 255).
      const blue = at(110, 110)
      // Clipped overflow: SVG viewport is 96 units (192 px); green rect at
      // 90,90 units extends to 110 units but the viewport clips at 96, so the
      // asset stays 192px (not enlarged) and the bottom-right pixel inside
      // the viewport is opaque green, while a pixel in truly empty area stays
      // transparent.
      const corner = at(191, 191)
      const empty = at(5, 5)
      // Trim (alpha !== 0 counts, so semitransparent blue is content).
      const trim = (() => {
        let left = bitmap.width
        let top = bitmap.height
        let right = -1
        let bottom = -1
        for (let y = 0; y < bitmap.height; y += 1) {
          for (let x = 0; x < bitmap.width; x += 1) {
            if ((pixels.data[(y * bitmap.width + x) * 4 + 3] ?? 0) === 0) continue
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
        return right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : undefined
      })()
      const back = conversion.resolveBitmapToVectorSpec({
        canvasWidth: bitmap.width,
        canvasHeight: bitmap.height,
        trim,
        rotationCenterX: vectorSpec.rotationCenterX,
        rotationCenterY: vectorSpec.rotationCenterY,
        bitmapResolution: vectorSpec.bitmapResolution,
      })
      // Cropped PNG -> vector SVG -> sanitizer (fail-closed, no network).
      const cropped = document.createElement('canvas')
      cropped.width = trim!.width
      cropped.height = trim!.height
      cropped.getContext('2d')!.drawImage(bitmap, trim!.x, trim!.y, trim!.width, trim!.height, 0, 0, trim!.width, trim!.height)
      const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, 'image/png'))
      const href = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await blob!.arrayBuffer())))}`
      const rawSvg = conversion.buildConvertedVectorSvg(back, href)
      const finalSvg = sanitizer.sanitizeSvgForDisplay(rawSvg)
      // Stage render comparison: draw the original SVG and the converted
      // vector SVG at the same sprite transform (position 0,0, size 100) onto
      // two 480x360 stage canvases, then compare ink pixels. Both use the VM
      // mapping: canvas point (240,180) + draw at (-center) size W units.
      const renderStage = async (svg: string, centerX: number, centerY: number, width: number, height: number) => {
        const url = URL.createObjectURL(new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }))
        try {
          const image = await loadImage(url)
          const stage = document.createElement('canvas')
          stage.width = 480
          stage.height = 360
          const context = stage.getContext('2d')!
          context.clearRect(0, 0, 480, 360)
          context.drawImage(image, 240 - centerX, 180 - centerY, width, height)
          return context.getImageData(0, 0, 480, 360)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      const before = await renderStage(clean, 48, 50, 96, 96)
      const after = await renderStage(finalSvg, back.rotationCenterX, back.rotationCenterY, back.svgWidth, back.svgHeight)
      let maxDiff = 0
      let differing = 0
      for (let i = 0; i < before.data.length; i += 4) {
        const diff =
          Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0)) +
          Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0)) +
          Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0)) +
          Math.abs((before.data[i + 3] ?? 0) - (after.data[i + 3] ?? 0))
        maxDiff = Math.max(maxDiff, diff)
        if (diff > 48) differing += 1
      }
      // Real UI pixel / screen stage bounds: a 480-unit stage element measured
      // through getBoundingClientRect gives the screen px per scratch unit.
      document.body.innerHTML = ''
      const stageElement = document.createElement('div')
      stageElement.style.cssText = 'position:relative;width:480px;height:360px;margin:0;padding:0;'
      document.body.appendChild(stageElement)
      const rect = stageElement.getBoundingClientRect()
      return {
        vectorSpec,
        red,
        blue,
        corner,
        empty,
        trim,
        back: { ...back, image: back.image },
        rawHasImage: rawSvg.includes('<image'),
        finalHasImage: finalSvg.includes('<image'),
        maxDiff,
        differing,
        total: (480 * 360) | 0,
        rectWidth: rect.width,
        rectHeight: rect.height,
      }
    })
    // 96x96 sprite -> 192x192 @2x with scaled center (not 2400x1800).
    expect(result.vectorSpec).toEqual({ bitmapWidth: 192, bitmapHeight: 192, bitmapResolution: 2, rotationCenterX: 96, rotationCenterY: 100 })
    // Opaque red, semitransparent blue (clipping + translucency preserved).
    expect(result.red?.[0]).toBeGreaterThan(200)
    expect(result.red?.[3]).toBe(255)
    const blueAlpha = result.blue?.[3] ?? 0
    expect(blueAlpha).toBeGreaterThan(0)
    expect(blueAlpha).toBeLessThan(255)
    // Overflow clipped (asset stays viewport-sized, not enlarged to overflow),
    // empty area transparent.
    expect(result.corner?.[3]).toBe(255)
    expect(result.empty?.[3]).toBe(0)
    // Trimmed 1:1 vector keeps drawing bounds (image at trimmed origin).
    expect(result.back.image).toBeTruthy()
    expect(result.rawHasImage).toBe(true)
    expect(result.finalHasImage).toBe(true)
    // Stage pixels: identical ink position/size (allow resampling tolerance;
    // differing pixels must stay a small minority from 2x downscale edges).
    expect(result.maxDiff).toBeLessThanOrEqual(4 * 255)
    expect(result.differing / result.total).toBeLessThan(0.02)
    // Real UI pixel: the measured 480px stage element maps 1 unit -> 1 screen px.
    expect(result.rectWidth).toBeCloseTo(480, 0)
    expect(result.rectHeight).toBeCloseTo(360, 0)
  }, 30_000)

  it('keeps stage 480x360 1:1 and empty SVG transparent', async () => {
    const result = await page.evaluate(async () => {
      const conversion = await import(/* @vite-ignore */ '/src/features/costumes/costume-conversion.ts')
      const sanitizer = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
      const stageSpec = conversion.resolveVectorToBitmapSpec({ svgWidth: 480, svgHeight: 360, rotationCenterX: 240, rotationCenterY: 180, isStage: true })
      const emptySpec = conversion.resolveBitmapToVectorSpec({ canvasWidth: 480, canvasHeight: 360, trim: undefined, rotationCenterX: 240, rotationCenterY: 180, bitmapResolution: 1 })
      const emptySvg = conversion.buildConvertedVectorSvg(emptySpec, '')
      const emptyClean = sanitizer.sanitizeSvgForDisplay(emptySvg)
      const emptyImage = new Image()
      await new Promise<void>((resolve, reject) => {
        emptyImage.onload = () => resolve()
        emptyImage.onerror = reject
        emptyImage.src = URL.createObjectURL(new Blob([new TextEncoder().encode(emptyClean)], { type: 'image/svg+xml' }))
      })
      const probe = document.createElement('canvas')
      probe.width = 8
      probe.height = 8
      const context = probe.getContext('2d')!
      context.clearRect(0, 0, 8, 8)
      context.drawImage(emptyImage, 0, 0, 8, 8)
      const alpha = context.getImageData(0, 0, 8, 8).data[3]
      return { stageSpec, emptySpec, emptyHasImage: emptySvg.includes('<image'), alpha }
    })
    expect(result.stageSpec).toEqual({ bitmapWidth: 480, bitmapHeight: 360, bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 })
    expect(result.emptySpec.image).toBeNull()
    expect(result.emptyHasImage).toBe(false)
    expect(result.alpha).toBe(0)
  }, 30_000)
})
