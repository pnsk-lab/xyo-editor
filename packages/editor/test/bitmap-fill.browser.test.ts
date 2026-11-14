import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real Canvas + DOM coverage for the bitmap fill paths wired in Editor.svelte
// (`applyBitmapFill`): gradient compositing (mask -> gradient layer ->
// `destination-in` -> draw back) and Shift full replacement (global
// exact-match sweep). The pure match rule is covered by
// `bitmap-fill.test.ts`; here every pixel flows through a real
// `CanvasRenderingContext2D` (`getImageData` / `putImageData` /
// `createLinearGradient` / `drawImage`) and real DOM canvases created with
// `document.createElement('canvas')`, mirroring the editor implementation.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4227'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('bitmap flood fill gradient and shift replace with real Canvas and DOM', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4227', '--strictPort'], {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('paints a horizontal gradient only inside the connected region via real canvas compositing', async () => {
    const result = await page.evaluate(async () => {
      const { floodFillMaskBitmap } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-fill'
      )
      // 5x5 with a 1px black border and a white 3x3 interior, painted pixel by
      // pixel on a real canvas (the same surface Editor.svelte fills).
      const bitmapCanvas = document.createElement('canvas')
      bitmapCanvas.width = 5
      bitmapCanvas.height = 5
      document.body.appendChild(bitmapCanvas)
      try {
        const context = bitmapCanvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 5, 5)
        context.fillStyle = '#000000'
        context.fillRect(0, 0, 5, 1)
        context.fillRect(0, 4, 5, 1)
        context.fillRect(0, 0, 1, 5)
        context.fillRect(4, 0, 1, 5)

        // Plain click: connected mask from the interior seed.
        const image = context.getImageData(0, 0, 5, 5)
        const source = { width: image.width, height: image.height, data: image.data }
        const maskResult = floodFillMaskBitmap(source, 2, 2)
        if (!maskResult.changed) throw new Error('expected the interior mask to change')
        const bounds = maskResult.bounds ?? { x: 0, y: 0, width: 5, height: 5 }

        // Same compositing as Editor.svelte `applyBitmapFill` gradient branch:
        // gradient layer sized to the mask bounds, clipped by the mask, drawn back.
        const gradientLayer = document.createElement('canvas')
        gradientLayer.width = bitmapCanvas.width
        gradientLayer.height = bitmapCanvas.height
        const gradientContext = gradientLayer.getContext('2d')!
        const gradient = gradientContext.createLinearGradient(
          bounds.x,
          bounds.y,
          bounds.x + bounds.width,
          bounds.y,
        )
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(1, '#0000ff')
        gradientContext.fillStyle = gradient
        gradientContext.fillRect(0, 0, gradientLayer.width, gradientLayer.height)
        const maskLayer = document.createElement('canvas')
        maskLayer.width = bitmapCanvas.width
        maskLayer.height = bitmapCanvas.height
        const maskContext = maskLayer.getContext('2d')!
        const maskImage = maskContext.createImageData(maskLayer.width, maskLayer.height)
        for (let i = 0; i < maskResult.mask.length; i += 1) {
          if (maskResult.mask[i] === 1) {
            const offset = i * 4
            maskImage.data[offset] = 255
            maskImage.data[offset + 1] = 255
            maskImage.data[offset + 2] = 255
            maskImage.data[offset + 3] = 255
          }
        }
        maskContext.putImageData(maskImage, 0, 0)
        gradientContext.globalCompositeOperation = 'destination-in'
        gradientContext.drawImage(maskLayer, 0, 0)
        gradientContext.globalCompositeOperation = 'source-over'
        context.drawImage(gradientLayer, 0, 0)

        const pixel = (x: number, y: number) =>
          Array.from(context.getImageData(x, y, 1, 1).data)
        return {
          gradientLayerIsCanvas: gradientLayer instanceof HTMLCanvasElement,
          maskLayerIsCanvas: maskLayer instanceof HTMLCanvasElement,
          inDom: bitmapCanvas.isConnected,
          bounds,
          filledCount: maskResult.filledCount,
          border: pixel(0, 0),
          left: pixel(1, 2),
          middle: pixel(2, 2),
          right: pixel(3, 2),
        }
      } finally {
        bitmapCanvas.remove()
      }
    })
    expect(result.gradientLayerIsCanvas).toBe(true)
    expect(result.maskLayerIsCanvas).toBe(true)
    expect(result.inDom).toBe(true)
    expect(result.bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 })
    expect(result.filledCount).toBe(9)
    // The black frame stops the fill exactly.
    expect(result.border).toEqual([0, 0, 0, 255])
    // Horizontal red -> blue gradient across the 3px interior: the left edge is
    // red-dominant, the right edge blue-dominant, the middle mixes both.
    const [lr, , lb, la] = result.left
    const [mr, , mb] = result.middle
    const [rr, , rb, ra] = result.right
    expect(la).toBe(255)
    expect(ra).toBe(255)
    expect(lr).toBeGreaterThan(150)
    expect(lb).toBeLessThan(150)
    expect(rb).toBeGreaterThan(150)
    expect(rr).toBeLessThan(150)
    expect(mr).toBeGreaterThan(0)
    expect(mb).toBeGreaterThan(0)
  }, 30_000)

  it('shift-click replaces the same color everywhere through the real solid putImageData path', async () => {
    const result = await page.evaluate(async () => {
      const { floodFillAllBitmap, floodFillBitmap } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-fill'
      )
      // Two white chambers split by a black wall: connected fill paints one
      // side while shift-click paints both.
      const bitmapCanvas = document.createElement('canvas')
      bitmapCanvas.width = 5
      bitmapCanvas.height = 3
      document.body.appendChild(bitmapCanvas)
      try {
        const context = bitmapCanvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 5, 3)
        context.fillStyle = '#000000'
        context.fillRect(2, 0, 1, 3)
        const readSource = () => {
          const image = context.getImageData(0, 0, 5, 3)
          return { width: image.width, height: image.height, data: image.data }
        }
        const oneSide = floodFillBitmap(readSource(), 0, 1, [255, 0, 0, 255])
        const bothSides = floodFillAllBitmap(readSource(), 0, 1, [255, 0, 0, 255])
        // No-op guard mirrors Editor.svelte: same-color shift fill changes nothing.
        const noop = floodFillAllBitmap(
          { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) },
          0,
          0,
          [255, 0, 0, 255],
        )
        if (!bothSides.changed) throw new Error('expected the shift fill to change')
        const filled = new ImageData(bothSides.image.width, bothSides.image.height)
        filled.data.set(bothSides.image.data)
        context.putImageData(filled, 0, 0)
        const pixel = (x: number, y: number) =>
          Array.from(context.getImageData(x, y, 1, 1).data)
        return {
          inDom: bitmapCanvas.isConnected,
          oneSide: oneSide.filledCount,
          bothSides: bothSides.filledCount,
          noopChanged: noop.changed,
          left: pixel(0, 1),
          right: pixel(4, 1),
          wall: pixel(2, 1),
        }
      } finally {
        bitmapCanvas.remove()
      }
    })
    expect(result.inDom).toBe(true)
    expect(result.oneSide).toBe(6)
    expect(result.bothSides).toBe(12)
    expect(result.noopChanged).toBe(false)
    expect(result.left).toEqual([255, 0, 0, 255])
    expect(result.right).toEqual([255, 0, 0, 255])
    expect(result.wall).toEqual([0, 0, 0, 255])
  }, 30_000)

  it('shift-click paints the gradient in every disconnected chamber through the real mask path', async () => {
    const result = await page.evaluate(async () => {
      const { floodFillAllMaskBitmap, floodFillMaskBitmap } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-fill'
      )
      const bitmapCanvas = document.createElement('canvas')
      bitmapCanvas.width = 5
      bitmapCanvas.height = 3
      document.body.appendChild(bitmapCanvas)
      try {
        const context = bitmapCanvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 5, 3)
        context.fillStyle = '#000000'
        context.fillRect(2, 0, 1, 3)
        const image = context.getImageData(0, 0, 5, 3)
        const source = { width: image.width, height: image.height, data: image.data }
        const oneSide = floodFillMaskBitmap(source, 0, 1)
        const bothSides = floodFillAllMaskBitmap(source, 0, 1)
        if (!bothSides.changed || !bothSides.bounds) throw new Error('expected a global mask')
        const bounds = bothSides.bounds
        // Same gradient compositing as the editor, driven by the shift mask.
        const gradientLayer = document.createElement('canvas')
        gradientLayer.width = bitmapCanvas.width
        gradientLayer.height = bitmapCanvas.height
        const gradientContext = gradientLayer.getContext('2d')!
        const gradient = gradientContext.createLinearGradient(
          bounds.x,
          bounds.y,
          bounds.x + bounds.width,
          bounds.y,
        )
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(1, '#0000ff')
        gradientContext.fillStyle = gradient
        gradientContext.fillRect(0, 0, gradientLayer.width, gradientLayer.height)
        const maskLayer = document.createElement('canvas')
        maskLayer.width = bitmapCanvas.width
        maskLayer.height = bitmapCanvas.height
        const maskContext = maskLayer.getContext('2d')!
        const maskImage = maskContext.createImageData(maskLayer.width, maskLayer.height)
        for (let i = 0; i < bothSides.mask.length; i += 1) {
          if (bothSides.mask[i] === 1) {
            const offset = i * 4
            maskImage.data[offset] = 255
            maskImage.data[offset + 1] = 255
            maskImage.data[offset + 2] = 255
            maskImage.data[offset + 3] = 255
          }
        }
        maskContext.putImageData(maskImage, 0, 0)
        gradientContext.globalCompositeOperation = 'destination-in'
        gradientContext.drawImage(maskLayer, 0, 0)
        gradientContext.globalCompositeOperation = 'source-over'
        context.drawImage(gradientLayer, 0, 0)
        const pixel = (x: number, y: number) =>
          Array.from(context.getImageData(x, y, 1, 1).data)
        return {
          oneSide: oneSide.filledCount,
          bothSides: bothSides.filledCount,
          bounds,
          left: pixel(0, 1),
          right: pixel(4, 1),
          wall: pixel(2, 1),
        }
      } finally {
        bitmapCanvas.remove()
      }
    })
    expect(result.oneSide).toBe(6)
    expect(result.bothSides).toBe(12)
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 5, height: 3 })
    // Both disconnected chambers receive the gradient; the wall stays black.
    const [lr, , lb, la] = result.left
    const [rr, , rb, ra] = result.right
    expect(la).toBe(255)
    expect(ra).toBe(255)
    expect(lr).toBeGreaterThan(lb)
    expect(rb).toBeGreaterThan(rr)
    expect(result.wall).toEqual([0, 0, 0, 255])
  }, 30_000)
})
