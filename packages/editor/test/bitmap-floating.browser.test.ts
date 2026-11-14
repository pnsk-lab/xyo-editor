import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real Canvas + DOM coverage for the bitmap floating-selection helpers
// (`src/features/costumes/bitmap-floating.ts`). The pure move/duplicate/
// scale/rotate contract is covered by `bitmap-floating.test.ts`; here every
// pixel flows through a real `CanvasRenderingContext2D` (`getImageData` /
// `putImageData` / `drawImage` with smoothing off) and real DOM canvases
// created with `document.createElement('canvas')`, mirroring how the future
// Editor wiring will exchange pixels with these helpers. No Editor wiring is
// exercised here: the module under test is Editor-free by design.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4231'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('bitmap floating selection with real Canvas and DOM', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4231', '--strictPort'], {
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

  it('round-trips a move preview through putImageData: hole, stamp, and untouched pixels', async () => {
    const result = await page.evaluate(async () => {
      const { extractFloatingPatch, previewFloatingMove, trimBitmapRectToOpaque } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const bitmapCanvas = document.createElement('canvas')
      bitmapCanvas.width = 8
      bitmapCanvas.height = 6
      document.body.appendChild(bitmapCanvas)
      try {
        const context = bitmapCanvas.getContext('2d')!
        // Transparent base: trim drops the empty margins before lifting.
        // Semi-transparent red marker plus an opaque green neighbour.
        context.fillStyle = 'rgba(255,0,0,0.5)'
        context.fillRect(3, 2, 1, 1)
        context.fillStyle = '#00ff00'
        context.fillRect(4, 2, 1, 1)

        const readSource = () => {
          const image = context.getImageData(0, 0, 8, 6)
          return { width: image.width, height: image.height, data: image.data }
        }
        // Trim first like the future drag-start path, then preview a move.
        const trimmed = trimBitmapRectToOpaque(readSource(), { x: 0, y: 0, width: 8, height: 6 })
        const extracted = extractFloatingPatch(readSource(), trimmed ?? { x: 0, y: 0, width: 0, height: 0 })
        const preview = previewFloatingMove(readSource(), trimmed!, 2, 1)
        if (!preview.changed) throw new Error('expected the move preview to change')
        const out = new ImageData(preview.image.width, preview.image.height)
        out.data.set(preview.image.data)
        context.putImageData(out, 0, 0)
        const pixel = (x: number, y: number) =>
          Array.from(context.getImageData(x, y, 1, 1).data)
        return {
          inDom: bitmapCanvas.isConnected,
          canvasIsCanvas: bitmapCanvas instanceof HTMLCanvasElement,
          trimmed,
          patchSize: extracted ? [extracted.patch.width, extracted.patch.height] : null,
          placedRect: preview.placedRect,
          destRed: pixel(5, 3),
          destGreen: pixel(6, 3),
          hole: pixel(3, 2),
          untouched: pixel(0, 0),
        }
      } finally {
        bitmapCanvas.remove()
      }
    })
    expect(result.inDom).toBe(true)
    expect(result.canvasIsCanvas).toBe(true)
    // Transparent margins trimmed before lifting.
    expect(result.trimmed).toEqual({ x: 3, y: 2, width: 2, height: 1 })
    expect(result.patchSize).toEqual([2, 1])
    expect(result.placedRect).toEqual({ x: 5, y: 3, width: 2, height: 1 })
    // Semi-transparent red survives the canvas round-trip (alpha preserved,
    // canvas stores it premultiplied but getImageData recovers ~128).
    expect(result.destRed[0]).toBeGreaterThan(200)
    expect(result.destRed[3]).toBeGreaterThan(100)
    expect(result.destRed[3]).toBeLessThan(160)
    expect(result.destGreen).toEqual([0, 255, 0, 255])
    expect(result.hole).toEqual([0, 0, 0, 0])
    expect(result.untouched).toEqual([0, 0, 0, 0])
  }, 30_000)

  it('matches canvas drawImage nearest-neighbour scaling and rotation for 90-degree steps', async () => {
    const result = await page.evaluate(async () => {
      const { compositeFloatingPatch, rotateFloatingPatch90, scaleFloatingPatch } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      // 2x1 opaque patch: red | blue. Both the helper (`source-over`) and
      // canvas `drawImage` composite opaque pixels by replacement, so the two
      // paths match byte-for-byte here. Semi-transparent parity (with the
      // ±2 premultiplication tolerance) is covered by the source-over test
      // below; alpha round-trips are also covered by the first test and the
      // unit suite via `putImageData`.
      const source = document.createElement('canvas')
      source.width = 2
      source.height = 1
      document.body.appendChild(source)
      const target = document.createElement('canvas')
      target.width = 6
      target.height = 4
      document.body.appendChild(target)
      try {
        const sourceContext = source.getContext('2d')!
        sourceContext.fillStyle = '#ff0000'
        sourceContext.fillRect(0, 0, 1, 1)
        sourceContext.fillStyle = '#0000ff'
        sourceContext.fillRect(1, 0, 1, 1)
        const raw = sourceContext.getImageData(0, 0, 2, 1)
        const patch = { width: raw.width, height: raw.height, data: raw.data }

        // Pure 2x scale stamped via putImageData ...
        const scaled = scaleFloatingPatch(patch, 2, 2)
        if (!scaled.changed) throw new Error('expected the scale to change')
        const targetContext = target.getContext('2d')!
        targetContext.fillStyle = '#ffffff'
        targetContext.fillRect(0, 0, 6, 4)
        const blank = targetContext.getImageData(0, 0, 6, 4)
        const stamped = compositeFloatingPatch(
          { width: 6, height: 4, data: blank.data },
          scaled.patch,
          1,
          1,
        )
        const stampedImage = new ImageData(stamped.image.width, stamped.image.height)
        stampedImage.data.set(stamped.image.data)
        targetContext.putImageData(stampedImage, 0, 0)

        // ... versus the canvas-native nearest-neighbour path.
        const native = document.createElement('canvas')
        native.width = 6
        native.height = 4
        document.body.appendChild(native)
        try {
          const nativeContext = native.getContext('2d')!
          nativeContext.imageSmoothingEnabled = false
          nativeContext.fillStyle = '#ffffff'
          nativeContext.fillRect(0, 0, 6, 4)
          nativeContext.drawImage(source, 1, 1, 4, 2)
          const pixelOf = (ctx: CanvasRenderingContext2D, x: number, y: number) =>
            Array.from(ctx.getImageData(x, y, 1, 1).data)
          const matchesNative =
            JSON.stringify(pixelOf(targetContext, 1, 1)) === JSON.stringify(pixelOf(nativeContext, 1, 1)) &&
            JSON.stringify(pixelOf(targetContext, 4, 2)) === JSON.stringify(pixelOf(nativeContext, 4, 2))

          // Quarter-turn via the canvas transform stack vs the pure helper.
          const square = document.createElement('canvas')
          square.width = 2
          square.height = 2
          document.body.appendChild(square)
          try {
            const squareContext = square.getContext('2d')!
            squareContext.fillStyle = '#ff0000'
            squareContext.fillRect(0, 0, 1, 1)
            squareContext.fillStyle = '#00ff00'
            squareContext.fillRect(1, 0, 1, 1)
            squareContext.fillStyle = '#0000ff'
            squareContext.fillRect(0, 1, 1, 1)
            squareContext.fillStyle = '#ffffff'
            squareContext.fillRect(1, 1, 1, 1)
            const squareRaw = squareContext.getImageData(0, 0, 2, 2)
            const rotated = rotateFloatingPatch90(
              { width: 2, height: 2, data: squareRaw.data },
              90,
            )
            const turned = document.createElement('canvas')
            turned.width = 2
            turned.height = 2
            document.body.appendChild(turned)
            try {
              const turnedContext = turned.getContext('2d')!
              turnedContext.imageSmoothingEnabled = false
              turnedContext.translate(2, 0)
              turnedContext.rotate(Math.PI / 2)
              turnedContext.drawImage(square, 0, 0)
              const expected = Array.from(turnedContext.getImageData(0, 0, 2, 2).data)
              return {
                inDom: source.isConnected && target.isConnected,
                scaledSize: [scaled.patch.width, scaled.patch.height],
                placedRect: stamped.placedRect,
                matchesNative,
                rotatedBytes: Array.from(rotated.patch.data),
                canvasRotatedBytes: expected,
              }
            } finally {
              turned.remove()
            }
          } finally {
            square.remove()
          }
        } finally {
          native.remove()
        }
      } finally {
        source.remove()
        target.remove()
      }
    })
    expect(result.inDom).toBe(true)
    expect(result.scaledSize).toEqual([4, 2])
    expect(result.placedRect).toEqual({ x: 1, y: 1, width: 4, height: 2 })
    expect(result.matchesNative).toBe(true)
    expect(result.rotatedBytes).toEqual(result.canvasRotatedBytes)
  }, 30_000)

  it('previews a small selection on a real 2400x1800 canvas without disturbing other pixels', async () => {
    const result = await page.evaluate(async () => {
      const { previewFloatingMove } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const bitmapCanvas = document.createElement('canvas')
      bitmapCanvas.width = 2400
      bitmapCanvas.height = 1800
      document.body.appendChild(bitmapCanvas)
      try {
        const context = bitmapCanvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 2400, 1800)
        context.fillStyle = '#0000ff'
        context.fillRect(1200, 900, 2, 1)
        const readSource = () => {
          const image = context.getImageData(0, 0, 2400, 1800)
          return { width: image.width, height: image.height, data: image.data }
        }
        const before = Array.from(context.getImageData(0, 0, 1, 1).data)
        const preview = previewFloatingMove(readSource(), { x: 1200, y: 900, width: 2, height: 1 }, 10, -10)
        if (!preview.changed) throw new Error('expected the 2400x1800 preview to change')
        const out = new ImageData(preview.image.width, preview.image.height)
        out.data.set(preview.image.data)
        context.putImageData(out, 0, 0)
        const pixel = (x: number, y: number) =>
          Array.from(context.getImageData(x, y, 1, 1).data)
        return {
          inDom: bitmapCanvas.isConnected,
          canvasSize: [bitmapCanvas.width, bitmapCanvas.height],
          placedRect: preview.placedRect,
          dest: pixel(1210, 890),
          destNext: pixel(1211, 890),
          hole: pixel(1200, 900),
          farCornerBefore: before,
          farCornerAfter: pixel(0, 0),
          oppositeCorner: pixel(2399, 1799),
        }
      } finally {
        bitmapCanvas.remove()
      }
    })
    expect(result.inDom).toBe(true)
    expect(result.canvasSize).toEqual([2400, 1800])
    expect(result.placedRect).toEqual({ x: 1210, y: 890, width: 2, height: 1 })
    expect(result.dest).toEqual([0, 0, 255, 255])
    expect(result.destNext).toEqual([0, 0, 255, 255])
    expect(result.hole).toEqual([0, 0, 0, 0])
    expect(result.farCornerAfter).toEqual(result.farCornerBefore)
    expect(result.oppositeCorner).toEqual([255, 255, 255, 255])
  }, 60_000)

  it('composites transparent/semi-transparent patches source-over like drawImage and keeps move/Alt/undo invariants', async () => {
    const result = await page.evaluate(async () => {
      const { clearFloatingRectForMove, compositeFloatingPatch, previewFloatingMove } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const pixelOf = (ctx: CanvasRenderingContext2D, x: number, y: number) =>
        Array.from(ctx.getImageData(x, y, 1, 1).data)
      const makeCanvas = (w: number, h: number) => {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        document.body.appendChild(canvas)
        return canvas
      }
      // Base: white with a green marker; patch: opaque red + transparent hole.
      const baseCanvas = makeCanvas(4, 1)
      const patchCanvas = makeCanvas(2, 1)
      const checkCanvas = makeCanvas(4, 1)
      try {
        const baseContext = baseCanvas.getContext('2d')!
        baseContext.fillStyle = '#ffffff'
        baseContext.fillRect(0, 0, 4, 1)
        baseContext.fillStyle = '#00ff00'
        baseContext.fillRect(2, 0, 1, 1)
        const patchContext = patchCanvas.getContext('2d')!
        patchContext.clearRect(0, 0, 2, 1)
        patchContext.fillStyle = '#ff0000'
        patchContext.fillRect(0, 0, 1, 1)
        const baseRaw = baseContext.getImageData(0, 0, 4, 1)
        const patchRaw = patchContext.getImageData(0, 0, 2, 1)
        const base = { width: 4, height: 1, data: baseRaw.data }
        const patch = { width: 2, height: 1, data: patchRaw.data }

        // Helper stamp vs native drawImage: transparent must preserve green.
        const stamped = compositeFloatingPatch(
          { width: 4, height: 1, data: new Uint8ClampedArray(baseRaw.data) },
          patch,
          1,
          0,
        )
        const checkContext = checkCanvas.getContext('2d')!
        checkContext.putImageData(new ImageData(new Uint8ClampedArray(baseRaw.data), 4, 1), 0, 0)
        checkContext.drawImage(patchCanvas, 1, 0)
        const helperRed = Array.from(stamped.image.data.slice(4, 8))
        const helperKept = Array.from(stamped.image.data.slice(8, 12))
        const canvasRed = pixelOf(checkContext, 1, 0)
        const canvasKept = pixelOf(checkContext, 2, 0)

        // Semi-transparent red over white: helper vs drawImage within ±2.
        const semiCanvas = makeCanvas(1, 1)
        const semiBase = makeCanvas(1, 1)
        let semiHelper: number[] = []
        let semiNative: number[] = []
        try {
          const semiContext = semiCanvas.getContext('2d')!
          semiContext.clearRect(0, 0, 1, 1)
          semiContext.fillStyle = 'rgba(255,0,0,0.5)'
          semiContext.fillRect(0, 0, 1, 1)
          const semiRaw = semiContext.getImageData(0, 0, 1, 1)
          const whiteContext = semiBase.getContext('2d')!
          whiteContext.fillStyle = '#ffffff'
          whiteContext.fillRect(0, 0, 1, 1)
          const whiteRaw = whiteContext.getImageData(0, 0, 1, 1)
          const semiStamped = compositeFloatingPatch(
            { width: 1, height: 1, data: new Uint8ClampedArray(whiteRaw.data) },
            { width: 1, height: 1, data: new Uint8ClampedArray(semiRaw.data) },
            0,
            0,
          )
          semiHelper = Array.from(semiStamped.image.data)
          whiteContext.drawImage(semiCanvas, 0, 0)
          semiNative = pixelOf(whiteContext, 0, 0)
        } finally {
          semiCanvas.remove()
          semiBase.remove()
        }

        // Move invariants on a real canvas: hole punch, Alt-duplicate, undo.
        const live = makeCanvas(6, 2)
        let move: Record<string, unknown> = {}
        try {
          const liveContext = live.getContext('2d')!
          liveContext.fillStyle = '#ffffff'
          liveContext.fillRect(0, 0, 6, 2)
          liveContext.fillStyle = '#0000ff'
          liveContext.fillRect(1, 0, 1, 1)
          const readLive = () => {
            const image = liveContext.getImageData(0, 0, 6, 2)
            return { width: image.width, height: image.height, data: image.data }
          }
          const beforeBytes = Array.from(readLive().data)
          const cleared = clearFloatingRectForMove(readLive(), { x: 1, y: 0, width: 1, height: 1 })
          const clearedHole = cleared.changed
            ? Array.from(cleared.image.data.slice((0 * 6 + 1) * 4, (0 * 6 + 1) * 4 + 4))
            : null
          const moved = previewFloatingMove(readLive(), { x: 1, y: 0, width: 1, height: 1 }, 3, 1)
          const dup = previewFloatingMove(readLive(), { x: 1, y: 0, width: 1, height: 1 }, 3, 1, { copy: true })
          const movedDest = moved.changed
            ? Array.from(moved.image.data.slice((1 * 6 + 4) * 4, (1 * 6 + 4) * 4 + 4))
            : null
          const dupSource = Array.from(dup.image.data.slice((0 * 6 + 1) * 4, (0 * 6 + 1) * 4 + 4))
          const dupDest = dup.changed
            ? Array.from(dup.image.data.slice((1 * 6 + 4) * 4, (1 * 6 + 4) * 4 + 4))
            : null
          move = {
            inputUnchanged: JSON.stringify(Array.from(readLive().data)) === JSON.stringify(beforeBytes),
            clearedHole,
            movedHole: moved.changed
              ? Array.from(moved.image.data.slice((0 * 6 + 1) * 4, (0 * 6 + 1) * 4 + 4))
              : null,
            movedDest,
            dupSource,
            dupDest,
            dupChanged: dup.changed,
          }
        } finally {
          live.remove()
        }

        return {
          helperRed,
          helperKept,
          canvasRed,
          canvasKept,
          semiHelper,
          semiNative,
          ...move,
        }
      } finally {
        baseCanvas.remove()
        patchCanvas.remove()
        checkCanvas.remove()
      }
    })
    // Transparent hole preserves the green background exactly like drawImage;
    // the old verbatim stamp erased it to [0,0,0,0].
    expect(result.helperRed).toEqual(result.canvasRed)
    expect(result.helperKept).toEqual([0, 255, 0, 255])
    expect(result.canvasKept).toEqual([0, 255, 0, 255])
    // Semi-transparent blends source-over: allow ±2 for premultiplication rounding.
    expect(result.semiHelper.length).toBe(4)
    expect(result.semiNative.length).toBe(4)
    for (let i = 0; i < 4; i += 1) {
      expect(Math.abs((result.semiHelper as number[])[i]! - (result.semiNative as number[])[i]!)).toBeLessThanOrEqual(2)
    }
    // Move punches the source, Alt-duplicate keeps it, inputs never mutate.
    expect(result.inputUnchanged).toBe(true)
    expect(result.clearedHole).toEqual([0, 0, 0, 0])
    expect(result.movedHole).toEqual([0, 0, 0, 0])
    expect(result.movedDest).toEqual([0, 0, 255, 255])
    expect(result.dupSource).toEqual([0, 0, 255, 255])
    expect(result.dupDest).toEqual([0, 0, 255, 255])
    expect(result.dupChanged).toBe(true)
  }, 30_000)
})
