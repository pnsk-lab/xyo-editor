import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Halo commit semantics with real Canvas + real Paper Raster (MIT paper.js).
// No product-code change beyond the safe halo rule: this file only drives
// helpers through real DOM canvases and the real `paper` UMD raster
// pipeline, then compares numeric pixel counts against the formal
// (patch-only) commit image.
//
// Independent judgement encoded here: the expanded store around a trimmed
// selection is transparent-boundary padding. Committing it runs through a
// selection-sized mask, so outside-selection pixels never become stamped
// pixels. The safe helper enforces the same rule numerically, so an
// opaque-neighbour halo stays masked and never leaks the ring.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4282'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page
let paperUmd: string

describe('halo commit semantics with real Canvas and Paper raster', () => {
  beforeAll(async () => {
    paperUmd = await Bun.file(join(root, 'node_modules', 'paper', 'dist', 'paper-full.js')).text()
    if (!paperUmd.includes('Paper.js')) throw new Error('paper UMD not loaded')
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4282', '--strictPort'], {
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
    page = await browser.newPage()
    await page.goto(base)
    await page.addScriptTag({ content: paperUmd })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('reproduces holes, masks ring blue, Alt-duplicate, Undo/Redo and offboard through real Canvas', async () => {
    const result = await page.evaluate(async () => {
      const floating = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const sessionMod = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating-session.ts'
      )
      const {
        clearFloatingRectForMove,
        compositeFloatingPatch,
        extractFloatingPatch,
        rotateFloatingPatch,
        rotateFloatingPatchWithHalo,
      } = floating
      const {
        beginBitmapFloatingSession,
        centeredBitmapFloatingDest,
        renderBitmapFloatingSession,
        rotateBitmapFloatingSessionArbitraryWithHalo,
      } = sessionMod

      // Real 16x16 scene canvas: transparent background, red 6x6 at (5,5),
      // 2x2 cleared interior hole, one semi pixel, 1px blue ring outside.
      const scene = document.createElement('canvas')
      scene.width = 16
      scene.height = 16
      document.body.appendChild(scene)
      try {
        const ctx = scene.getContext('2d')!
        ctx.clearRect(0, 0, 16, 16)
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(5, 5, 6, 6)
        ctx.clearRect(7, 7, 2, 2)
        ctx.fillStyle = 'rgba(10,20,30,0.5)'
        ctx.fillRect(9, 5, 1, 1)
        ctx.fillStyle = '#0000ff'
        for (let x = 4; x <= 11; x += 1) {
          ctx.fillRect(x, 4, 1, 1)
          ctx.fillRect(x, 11, 1, 1)
        }
        for (let y = 4; y <= 11; y += 1) {
          ctx.fillRect(4, y, 1, 1)
          ctx.fillRect(11, y, 1, 1)
        }
        const raw = ctx.getImageData(0, 0, 16, 16)
        const canvas = { width: 16, height: 16, data: raw.data }
        const select = { x: 5, y: 5, width: 6, height: 6 }
        const extracted = extractFloatingPatch(
          { width: 16, height: 16, data: new Uint8ClampedArray(raw.data) },
          select,
        )!
        const count = (
          image: { width: number; height: number; data: Uint8ClampedArray },
          pred: (r: number, g: number, b: number, a: number) => boolean,
        ) => {
          let n = 0
          for (let i = 0; i < image.data.length; i += 4) {
            if (pred(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, image.data[i + 3]!)) n += 1
          }
          return n
        }
        const isBlue = (r: number, g: number, b: number, a: number) =>
          r === 0 && g === 0 && b === 255 && a === 255
        const isRed = (r: number, g: number, b: number, a: number) =>
          r === 255 && g === 0 && b === 0 && a === 255
        const isClear = (_r: number, _g: number, _b: number, a: number) => a === 0

        // Halo crop with real ring neighbours vs transparent padding halo.
        const cropHalo = (margin: number, paddingOnly: boolean) => {
          const w = select.width + margin * 2
          const h = select.height + margin * 2
          const haloCanvas = document.createElement('canvas')
          haloCanvas.width = w
          haloCanvas.height = h
          document.body.appendChild(haloCanvas)
          try {
            const hx = haloCanvas.getContext('2d')!
            hx.clearRect(0, 0, w, h)
            // drawImage the live scene shifted so SELECT lands at (margin,margin).
            hx.drawImage(scene, select.x - margin, select.y - margin, w, h, 0, 0, w, h)
            if (paddingOnly) {
              hx.clearRect(0, 0, w, margin)
              hx.clearRect(0, h - margin, w, margin)
              hx.clearRect(0, 0, margin, h)
              hx.clearRect(w - margin, 0, margin, h)
            }
            const haloRaw = hx.getImageData(0, 0, w, h)
            return {
              image: { width: w, height: h, data: new Uint8ClampedArray(haloRaw.data) },
              offsetX: margin,
              offsetY: margin,
            }
          } finally {
            haloCanvas.remove()
          }
        }

        const plain = rotateFloatingPatch(
          { width: extracted.patch.width, height: extracted.patch.height, data: new Uint8ClampedArray(extracted.patch.data) },
          30,
        )
        const padded = rotateFloatingPatchWithHalo(
          { width: extracted.patch.width, height: extracted.patch.height, data: new Uint8ClampedArray(extracted.patch.data) },
          cropHalo(2, true),
          30,
        )
        const haloed = rotateFloatingPatchWithHalo(
          { width: extracted.patch.width, height: extracted.patch.height, data: new Uint8ClampedArray(extracted.patch.data) },
          cropHalo(2, false),
          30,
        )
        const paddedEqual =
          padded.patch.width === plain.patch.width &&
          padded.patch.height === plain.patch.height &&
          padded.patch.data.every((v, i) => v === plain.patch.data[i])
        const plainBlue = count(plain.patch, isBlue)
        const haloBlue = count(haloed.patch, isBlue)

        // Formal commit: punch + recenter + source-over stamp, via putImageData.
        const dest = centeredBitmapFloatingDest(extracted.rect, plain.patch.width, plain.patch.height)
        const base = clearFloatingRectForMove(
          { width: 16, height: 16, data: new Uint8ClampedArray(canvas.data) },
          extracted.rect,
        ).image
        const formal = compositeFloatingPatch(base, plain.patch, dest.x, dest.y)
        const haloStamped = compositeFloatingPatch(
          clearFloatingRectForMove(
            { width: 16, height: 16, data: new Uint8ClampedArray(canvas.data) },
            extracted.rect,
          ).image,
          haloed.patch,
          dest.x,
          dest.y,
        )
        const beforeBlue = count(canvas, isBlue)
        const formalBlue = count(formal.image, isBlue)
        const haloCommitBlue = count(haloStamped.image, isBlue)
        let haloOnlyBlue = 0
        for (let i = 0; i < formal.image.data.length; i += 4) {
          const fb =
            formal.image.data[i] === 0 &&
            formal.image.data[i + 1] === 0 &&
            formal.image.data[i + 2] === 255 &&
            formal.image.data[i + 3] === 255
          const hb =
            haloStamped.image.data[i] === 0 &&
            haloStamped.image.data[i + 1] === 0 &&
            haloStamped.image.data[i + 2] === 255 &&
            haloStamped.image.data[i + 3] === 255
          if (hb && !fb) haloOnlyBlue += 1
        }
        // putImageData round-trip of the formal commit preserves red + clear corner.
        const live = document.createElement('canvas')
        live.width = 16
        live.height = 16
        document.body.appendChild(live)
        let roundTrip: Record<string, unknown> = {}
        try {
          const liveCtx = live.getContext('2d')!
          const out = new ImageData(formal.image.width, formal.image.height)
          out.data.set(formal.image.data)
          liveCtx.putImageData(out, 0, 0)
          const px = (x: number, y: number) => Array.from(liveCtx.getImageData(x, y, 1, 1).data)
          roundTrip = {
            redInside: count(formal.image, isRed) > 0,
            clearCorner: Array.from(px(0, 0)),
            holeKept: count(plain.patch, isClear) > 0,
          }
        } finally {
          live.remove()
        }

        // Alt-duplicate keeps the source red; Undo/Redo restarts from frozen original.
        const session = beginBitmapFloatingSession(
          { width: 16, height: 16, data: new Uint8ClampedArray(canvas.data) },
          select,
        )!
        const committedBefore = Array.from(session.committed.data)
        const original = {
          width: session.patch.width,
          height: session.patch.height,
          data: new Uint8ClampedArray(session.patch.data),
        }
        const haloForSession = cropHalo(2, false)
        const first = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, haloForSession, 30)
        const replay = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, haloForSession, 30)
        const replayEqual = replay.patch.data.every((v, i) => v === first.patch.data[i])
        const committedIntact =
          session.committed.data.every((v, i) => v === committedBefore[i])
        const reset = rotateBitmapFloatingSessionArbitraryWithHalo(session, original, haloForSession, 0)
        // Partial offboard: negative dest clips, far copy is a no-op.
        const clipped = renderBitmapFloatingSession(session, -2, -2)
        const outsideCopy = renderBitmapFloatingSession(session, 100, 100, { copy: true })
        const outsideMove = renderBitmapFloatingSession(session, 100, 100)

        return {
          paddedEqual,
          plainBlue,
          haloBlue,
          beforeBlue,
          formalBlue,
          haloCommitBlue,
          haloOnlyBlue,
          roundTrip,
          replayEqual,
          committedIntact,
          resetChanged: reset.changed,
          resetEqualOriginal: reset.patch.data.every((v, i) => v === original.data[i]),
          clippedRect: clipped.placedRect,
          outsideCopyChanged: outsideCopy.changed,
          outsideMoveChanged: outsideMove.changed,
          outsideMoveHole: Array.from(outsideMove.image.data.slice((5 * 16 + 5) * 4, (5 * 16 + 5) * 4 + 4)),
        }
      } finally {
        scene.remove()
      }
    })
    expect(result.paddedEqual).toBe(true)
    expect(result.plainBlue).toBe(0)
    // Safe halo: the opaque-neighbour halo is masked to transparent outside
    // the selection, so no ring blue enters the rotated patch or the commit.
    expect(result.haloBlue).toBe(0)
    expect(result.formalBlue).toBeLessThanOrEqual(result.beforeBlue)
    expect(result.haloCommitBlue).toBe(result.formalBlue)
    expect(result.haloOnlyBlue).toBe(0)
    expect(result.roundTrip.redInside).toBe(true)
    expect(result.roundTrip.clearCorner).toEqual([0, 0, 0, 0])
    expect(result.roundTrip.holeKept).toBe(true)
    expect(result.replayEqual).toBe(true)
    expect(result.committedIntact).toBe(true)
    expect(result.resetChanged).toBe(false)
    expect(result.resetEqualOriginal).toBe(true)
    expect(result.clippedRect).toEqual({ x: 0, y: 0, width: 4, height: 4 })
    expect(result.outsideCopyChanged).toBe(false)
    expect(result.outsideMoveChanged).toBe(true)
    expect(result.outsideMoveHole).toEqual([0, 0, 0, 0])
  }, 60_000)

  it('compares the masked Paper commit against the unmasked halo stamp numerically', async () => {
    const result = await page.evaluate(async () => {
      const { rotateFloatingPatch, rotateFloatingPatchWithHalo } = await import(
        /* @vite-ignore */ '/src/features/costumes/bitmap-floating.ts'
      )
      const paper = (window as unknown as { paper: any }).paper
      if (!paper || !paper.Raster) throw new Error('paper UMD missing')

      // Real scene canvas (same geometry as the Canvas test above).
      const scene = document.createElement('canvas')
      scene.width = 16
      scene.height = 16
      document.body.appendChild(scene)
      try {
        const ctx = scene.getContext('2d')!
        ctx.clearRect(0, 0, 16, 16)
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(5, 5, 6, 6)
        ctx.clearRect(7, 7, 2, 2)
        ctx.fillStyle = '#0000ff'
        for (let x = 4; x <= 11; x += 1) {
          ctx.fillRect(x, 4, 1, 1)
          ctx.fillRect(x, 11, 1, 1)
        }
        for (let y = 4; y <= 11; y += 1) {
          ctx.fillRect(4, y, 1, 1)
          ctx.fillRect(11, y, 1, 1)
        }
        // Paper setup on a scratch canvas (own scope, no editor wiring).
        const setupCanvas = document.createElement('canvas')
        setupCanvas.width = 32
        setupCanvas.height = 32
        document.body.appendChild(setupCanvas)
        try {
          paper.setup(setupCanvas)
          const baseRaster = new paper.Raster(scene)
          baseRaster.position = new paper.Point(8, 8)
          if (!baseRaster.loaded) {
            await new Promise<void>((resolve) => baseRaster.on('load', () => resolve()))
          }
          const rect = new paper.Rectangle(5, 5, 6, 6)
          const sub = baseRaster.getSubRaster(rect)
          const expandedRect = rect.expand(4)
          const expanded = baseRaster.getSubRaster(expandedRect)
          const subSize = [sub.width, sub.height]
          const expandedSize = [expanded.width, expanded.height]
          // The selection raster is used with smoothing disabled (same state
          // the editor forces on its floating raster before transforming).
          sub.canvas.getContext('2d')!.imageSmoothingEnabled = false
          const smoothingOff = sub.canvas.getContext('2d')!.imageSmoothingEnabled === false
          // Paper rectangles: expanded strictly contains the selection.
          const contains =
            expandedRect.x <= rect.x &&
            expandedRect.y <= rect.y &&
            expandedRect.x + expandedRect.width >= rect.x + rect.width &&
            expandedRect.y + expandedRect.height >= rect.y + rect.height

          // Helper rotations from the live bytes.
          const raw = ctx.getImageData(5, 5, 6, 6)
          const patch = { width: 6, height: 6, data: new Uint8ClampedArray(raw.data) }
          const haloRaw = ctx.getImageData(3, 3, 10, 10)
          const halo = {
            image: { width: 10, height: 10, data: new Uint8ClampedArray(haloRaw.data) },
            offsetX: 2,
            offsetY: 2,
          }
          const plain = rotateFloatingPatch(patch, 30)
          const haloed = rotateFloatingPatchWithHalo(
            { width: 6, height: 6, data: new Uint8ClampedArray(raw.data) },
            halo,
            30,
          )
          const countBlue = (data: Uint8ClampedArray) => {
            let n = 0
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 255 && data[i + 3] === 255) n += 1
            }
            return n
          }

          // Canvas truth: rotate the isolated 6x6 vs the expanded 10x10 with
          // smoothing off, both centered into the helper's tight box size.
          const canvasRotated = (src: HTMLCanvasElement, deg: number) => {
            const rad = (deg * Math.PI) / 180
            const dst = document.createElement('canvas')
            dst.width = plain.patch.width
            dst.height = plain.patch.height
            document.body.appendChild(dst)
            try {
              const d = dst.getContext('2d')!
              d.imageSmoothingEnabled = false
              d.translate(dst.width / 2, dst.height / 2)
              d.rotate(rad)
              d.drawImage(src, -src.width / 2, -src.height / 2)
              return d.getImageData(0, 0, dst.width, dst.height)
            } finally {
              dst.remove()
            }
          }
          const isolatedCanvas = document.createElement('canvas')
          isolatedCanvas.width = 6
          isolatedCanvas.height = 6
          document.body.appendChild(isolatedCanvas)
          const expandedCanvas = document.createElement('canvas')
          expandedCanvas.width = 10
          expandedCanvas.height = 10
          document.body.appendChild(expandedCanvas)
          let canvasIsolatedBlue = 0
          let canvasExpandedBlue = 0
          let maskedBlue = 0
          let maskedCornerAlpha = 1
          try {
            isolatedCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(raw.data), 6, 6), 0, 0)
            expandedCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(haloRaw.data), 10, 10), 0, 0)
            const iso = canvasRotated(isolatedCanvas, 30)
            const exp = canvasRotated(expandedCanvas, 30)
            canvasIsolatedBlue = countBlue(iso.data as unknown as Uint8ClampedArray)
            canvasExpandedBlue = countBlue(exp.data as unknown as Uint8ClampedArray)

            // Masked Paper-style commit: selection-sized rotated mask
            // (source-in) over the expanded rotation. Outside-selection blue
            // cannot leak outside the rotated selection shape: corners stay
            // transparent while the unmasked halo stamp carries ring blue.
            const mask = document.createElement('canvas')
            mask.width = plain.patch.width
            mask.height = plain.patch.height
            document.body.appendChild(mask)
            try {
              const m = mask.getContext('2d')!
              m.imageSmoothingEnabled = false
              m.translate(mask.width / 2, mask.height / 2)
              m.rotate((30 * Math.PI) / 180)
              m.fillStyle = '#000'
              m.fillRect(-3, -3, 6, 6)
              m.globalCompositeOperation = 'source-in'
              m.translate(0, 0)
              // Draw the expanded rotation underneath the mask: re-run the
              // expanded rotation onto the same canvas through source-in.
              const tmp = document.createElement('canvas')
              tmp.width = mask.width
              tmp.height = mask.height
              document.body.appendChild(tmp)
              try {
                const t = tmp.getContext('2d')!
                t.imageSmoothingEnabled = false
                t.translate(tmp.width / 2, tmp.height / 2)
                t.rotate((30 * Math.PI) / 180)
                t.drawImage(expandedCanvas, -5, -5)
                m.drawImage(tmp, -mask.width / 2, -mask.height / 2)
              } finally {
                tmp.remove()
              }
              const masked = m.getImageData(0, 0, mask.width, mask.height)
              maskedBlue = countBlue(masked.data as unknown as Uint8ClampedArray)
              maskedCornerAlpha = masked.data[3]!
            } finally {
              mask.remove()
            }
          } finally {
            isolatedCanvas.remove()
            expandedCanvas.remove()
          }

          sub.remove()
          expanded.remove()
          baseRaster.remove()
          paper.project.clear()

          return {
            paperVersion: String(paper.version ?? 'unknown'),
            subSize,
            expandedSize,
            smoothingOff,
            contains,
            helperPlainBlue: countBlue(plain.patch.data),
            helperHaloBlue: countBlue(haloed.patch.data),
            canvasIsolatedBlue,
            canvasExpandedBlue,
            maskedBlue,
            maskedCornerAlpha,
          }
        } finally {
          setupCanvas.remove()
        }
      } finally {
        scene.remove()
      }
    })
    expect(result.paperVersion).toContain('.')
    expect(result.subSize).toEqual([6, 6])
    // Interior selection: expand(4) grows 6x6 to 10x10 (2px per side).
    expect(result.expandedSize).toEqual([10, 10])
    expect(result.smoothingOff).toBe(true)
    expect(result.contains).toBe(true)
    // Helper truth (safe): isolated rotation and masked halo rotation both
    // carry no ring blue; only the unmasked expanded Canvas draw pulls blue.
    expect(result.helperPlainBlue).toBe(0)
    expect(result.helperHaloBlue).toBe(0)
    // Canvas truth mirrors the helper: isolated stays ring-free, expanded pulls blue.
    expect(result.canvasIsolatedBlue).toBe(0)
    expect(result.canvasExpandedBlue).toBeGreaterThan(0)
    // Masked Paper-style commit keeps the tight-box corner transparent and
    // carries no more ring blue than the unmasked expanded draw.
    expect(result.maskedCornerAlpha).toBe(0)
    expect(result.maskedBlue).toBeLessThanOrEqual(result.canvasExpandedBlue)
  }, 60_000)
})
