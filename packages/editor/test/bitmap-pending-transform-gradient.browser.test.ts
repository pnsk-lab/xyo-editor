// Strict real-Canvas pixel oracle for `rotatePendingBitmapShape` gradient parity.
//
// What is proven (all against the REAL helpers, imported live from the Vite
// dev server inside the page — no copied logic for the units under test):
//   G1 direction×kind stop parity: horizontal/vertical red→blue (`#ff0000` →
//      `#0000ff`) quarter turns cw/ccw. The INDEPENDENT reference paints the
//      source shape, then rotates the RASTER via an actual Canvas 2d matrix
//      (`translate(cx,cy) → rotate(±90°) → translate(-cx,-cy)`, smoothing off,
//      own-words matrix, no upstream source copied) about the shape's own
//      center. The CANDIDATE redraws via `rotatePendingBitmapShape` +
//      `compositePendingBitmapShapePreview`. Only `ccw horizontal→vertical`
//      and `cw vertical→horizontal` reverse stops; the other two keep order.
//      Rotated-vs-redrawn max channel diff stays tiny and end probes agree.
//   G2 transparent ends: `fillTransparent` / `secondaryTransparent` travel
//      WITH their hex (flags, never lossy hex baking). Transparent end probes
//      read alpha ~0 with the surviving RGB; opaque ends stay 255. Mid-ramp
//      pixels are semi-alpha (0 < a < 255).
//   G3 four quarter turns are the pixel identity (helper ×4 restores box+style
//      exactly; recomposite is byte-equal to the original source composite).
//   G4 asymmetric odd/even dimensions snap to integers (no NaNs, ≤0.5px drift);
//      even fully-inside cases stay strictly close to the matrix reference,
//      odd cases match on interior probes.
//   G5 res1/res2 independence: the same box on 120×90 and 480×360 yields the
//      same relative probes and the same helper box/style.
//   G6 outside clipping: an overflowing rotated box clamps (no throw, canvas
//      size kept), the visible part still matches the reference, reversal
//      still applies.
//   G7 solid/radial no-op: kind+stops unchanged in the helper; solid rotated
//      raster is byte-equal to the redrawn candidate (rotation-symmetric).
//
// Product code untouched: no Editor/Bitmap wiring changes here. On-disk
// `BITMAP_PENDING_UI_ENABLED` stays `false` (asserted before+after).
// Dedicated Vite port 4677 (surveyed 2026-11-13: no literal 4677 claim in
// test/*.test.ts; neighbours 4655/4695/4698 in use). CHROME_BIN inherited,
// with the task-given fallback.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4677
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

async function assertOnDiskFlagFalse(stage: string): Promise<void> {
  const source = await Bun.file(CONTROLLER_URL).text()
  const count = source.split(NEEDLE).length - 1
  if (count !== 1) {
    throw new Error(
      `[gradient-rotate] on-disk flag check (${stage}): expected exactly 1 ${JSON.stringify(NEEDLE)}, found ${count}; refusing to run`,
    )
  }
}

type GradientProof = {
  cases: Array<{
    name: string
    maxDiff: number
    worstAt: string
    worstA: number[]
    worstB: number[]
    topProbeR: number[]
    topProbeC: number[]
    bottomProbeR: number[]
    bottomProbeC: number[]
    expectedTopIsFill: boolean
    topMatches: boolean
    bottomMatches: boolean
    premultRgb: number
    premultAlpha: number
    ok: boolean
  }>
  identityByteEqual: boolean
  solidByteEqual: boolean
  radialUnchanged: boolean
  oddIntegers: boolean
  oddInteriorDiff: number
  resMatch: boolean
  clipOk: boolean
  clipVisibleMatch: boolean
  worstMaxDiff: number
}

async function runProofs(): Promise<GradientProof> {
  if (!page) throw new Error('Browser page not ready')
  return page.evaluate(async (): Promise<GradientProof> => {
    const tmod = await import('/src/features/costumes/bitmap-pending-transform.ts')
    const pmod = await import('/src/features/costumes/bitmap-pending-shape-preview.ts')
    const rotate = (tmod as unknown as { rotatePendingBitmapShape: (s: unknown, d: string, b: unknown) => { pending: unknown; changed: boolean } }).rotatePendingBitmapShape
    const composite = (pmod as unknown as { compositePendingBitmapShapePreview: (c: unknown, b: unknown, s: unknown) => ImageData | undefined }).compositePendingBitmapShapePreview

    const RED = '#ff0000'
    const BLUE = '#0000ff'
    const blank = (w: number, h: number): ImageData => new ImageData(w, h)
    const makeCanvas = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      return { canvas, ctx }
    }
    const px = (d: ImageData, x: number, y: number): number[] => {
      const o = (y * d.width + x) * 4
      return [d.data[o]!, d.data[o + 1]!, d.data[o + 2]!, d.data[o + 3]!]
    }
    const maxDiff = (a: ImageData, b: ImageData): number => {
      let m = 0
      const n = Math.min(a.data.length, b.data.length)
      for (let i = 0; i < n; i += 1) {
        const d = Math.abs((a.data[i] as number) - (b.data[i] as number))
        if (d > m) m = d
      }
      return m
    }
    // Premultiplied comparison: Canvas stores low-alpha pixels premultiplied,
    // so un-premultiplied RGB near the transparent end amplifies a ±1
    // storage rounding into a ±25 readback swing (observed: alpha 11 reads
    // back as 232 vs 255 blue with identical alpha). Comparing
    // round(c*a/255) + alpha measures the true ramp error (≤1-2) instead of
    // the un-premultiply quantization. Alpha itself is compared exactly.
    const premult = (c: number, a: number): number => Math.round((c * a) / 255)
    const maxPremultDiff = (a: ImageData, b: ImageData): { rgb: number; alpha: number } => {
      let rgb = 0
      let alpha = 0
      const n = Math.min(a.data.length, b.data.length / 1)
      for (let i = 0; i < n; i += 4) {
        const ar = a.data[i] as number
        const ag = a.data[i + 1] as number
        const ab = a.data[i + 2] as number
        const aa = a.data[i + 3] as number
        const br = b.data[i] as number
        const bg = b.data[i + 1] as number
        const bb = b.data[i + 2] as number
        const ba = b.data[i + 3] as number
        alpha = Math.max(alpha, Math.abs(aa - ba))
        rgb = Math.max(
          rgb,
          Math.abs(premult(ar, aa) - premult(br, ba)),
          Math.abs(premult(ag, aa) - premult(bg, ba)),
          Math.abs(premult(ab, aa) - premult(bb, ba)),
        )
      }
      return { rgb, alpha }
    }
    // Independent reference: rotate the painted raster about the shape's own
    // exact center via the exact y-down quarter-turn matrix (hand-rolled, no
    // upstream source copied). Canvas y-down cw maps (dx,dy)->(-dy,dx):
    //   cw:  x_s = cx + (y' - cy), y_s = cy - (x' - cx)
    //   ccw: x_s = cx - (y' - cy), y_s = cy + (x' - cx)
    // Integer corners map to integer corners even for half-integer centers
    // (half±half=int), so this nearest-exact permutation introduces zero
    // resampling error — unlike `drawImage` (premultiplied filtering), which
    // is logged separately as a looser cross-check. A second Canvas-matrix
    // path (`setTransform`+`drawImage`, smoothing off) is also computed for
    // the log to prove the matrix agrees.
    const rotateRasterExact = (src: ImageData, cx: number, cy: number, dir: string): ImageData => {
      const out = new ImageData(src.width, src.height)
      const Wd = src.width
      const Hd = src.height
      for (let y = 0; y < Hd; y += 1) {
        for (let x = 0; x < Wd; x += 1) {
          // Map the DESTINATION pixel CENTER through the inverse rotation,
          // then take the source pixel containing that point (floor). Pixel
          // (i,j) covers [i,i+1)x[j,j+1); centers sit at +0.5. The y-down cw
          // turn is (dx,dy)->(-dy,dx), so its inverse (dst->src) is:
          //   cw:  src = (cx + (y'c - cy), cy - (x'c - cx))
          //   ccw: src = (cx - (y'c - cy), cy + (x'c - cx)).
          const xc = x + 0.5
          const yc = y + 0.5
          let pxm: number
          let pym: number
          if (dir === 'cw') {
            pxm = cx + (yc - cy)
            pym = cy - (xc - cx)
          } else {
            pxm = cx - (yc - cy)
            pym = cy + (xc - cx)
          }
          const sx = Math.floor(pxm)
          const sy = Math.floor(pym)
          const d = (y * Wd + x) * 4
          if (sx >= 0 && sy >= 0 && sx < Wd && sy < Hd) {
            const s = (sy * Wd + sx) * 4
            out.data[d] = src.data[s]
            out.data[d + 1] = src.data[s + 1]
            out.data[d + 2] = src.data[s + 2]
            out.data[d + 3] = src.data[s + 3]
          } else {
            out.data[d + 3] = 0
          }
        }
      }
      return out
    }
    const rotateRaster = (src: HTMLCanvasElement, cx: number, cy: number, dir: string): ImageData => {
      const { canvas, ctx } = makeCanvas(src.width, src.height)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(dir === 'cw' ? Math.PI / 2 : -Math.PI / 2)
      ctx.translate(-cx, -cy)
      ctx.drawImage(src, 0, 0)
      ctx.restore()
      return ctx.getImageData(0, 0, canvas.width, canvas.height)
    }
    const paintShape = (w: number, h: number, shape: unknown): { canvas: HTMLCanvasElement; data: ImageData } => {
      const { canvas, ctx } = makeCanvas(w, h)
      const out = composite(ctx, blank(w, h), shape)
      if (!out) throw new Error('composite returned undefined')
      return { canvas, data: out }
    }
    const styleFor = (gradient: string, t: { f: boolean; s: boolean }) => ({
      fill: RED,
      secondary: BLUE,
      gradient,
      fillTransparent: t.f,
      secondaryTransparent: t.s,
      brushSize: 6,
    })
    const cases: GradientProof['cases'] = []
    let worstMaxDiff = 0

    // G1/G2: even fully-inside box on 120×90, all 4 direction×kind + 3
    // transparency states. Filled rect only (ellipse edges antialias and would
    // pollute strict diffs; mode/kind preservation is pinned by unit tests).
    const W = 120
    const H = 90
    const BOX = { x: 30, y: 15, width: 60, height: 40 }
    const CX = BOX.x + BOX.width / 2
    const CY = BOX.y + BOX.height / 2
    const transparencies = [
      { f: false, s: false },
      { f: true, s: false },
      { f: false, s: true },
    ]
    for (const gradient of ['horizontal', 'vertical']) {
      for (const dir of ['cw', 'ccw']) {
        for (const t of transparencies) {
          const name = `${gradient}/${dir}/fT${t.f ? 1 : 0}sT${t.s ? 1 : 0}`
          const source = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: styleFor(gradient, t) }
          const { canvas: srcCanvas, data: srcData } = paintShape(W, H, source)
          const rotated = rotateRasterExact(srcData, CX, CY, dir)
          // Looser Canvas-matrix cross-check (premultiplied filtering loosens
          // transparent ramps; logged only, never gated).
          const rotatedCanvas = rotateRaster(srcCanvas, CX, CY, dir)
          void rotatedCanvas
          const next = rotate(source, dir, { width: W, height: H }).pending as unknown as {
            box: { x: number; y: number; width: number; height: number }
            style: { gradient: string; fill: string; secondary: string; fillTransparent: boolean; secondaryTransparent: boolean }
          }
          const { data: cand } = paintShape(W, H, next)
          const md = maxDiff(rotated, cand)
          const pmd = maxPremultDiff(rotated, cand)
          if (md > worstMaxDiff) worstMaxDiff = md
          // Locate the worst pixel for the log (proves the error is the
          // premultiplied mid-ramp quantization, not an orientation flip).
          let worstAt = ''
          let worstA: number[] = []
          let worstB: number[] = []
          {
            let m = -1
            for (let yy = 0; yy < H; yy += 1) {
              for (let xx = 0; xx < W; xx += 1) {
                const a = px(rotated, xx, yy)
                const b = px(cand, xx, yy)
                const d = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!), Math.abs(a[3]! - b[3]!))
                if (d > m) {
                  m = d
                  worstAt = `${xx},${yy}`
                  worstA = a
                  worstB = b
                }
              }
            }
          }
          // End probes: inset 3px to dodge the antialiased rim. For a
          // horizontal source the ramp runs left→right; after rotation the
          // candidate is vertical so probe top/bottom. For a vertical source
          // the candidate is horizontal so probe left/right (stored as
          // top=left, bottom=right for uniform reporting).
          const nb = next.box
          let topR: number[]
          let topC: number[]
          let botR: number[]
          let botC: number[]
          if (gradient === 'horizontal') {
            const tx = Math.round(nb.x + nb.width / 2)
            const tyTop = Math.round(nb.y + 3)
            const tyBot = Math.round(nb.y + nb.height - 4)
            topR = px(rotated, tx, tyTop)
            topC = px(cand, tx, tyTop)
            botR = px(rotated, tx, tyBot)
            botC = px(cand, tx, tyBot)
          } else {
            const ty = Math.round(nb.y + nb.height / 2)
            const txL = Math.round(nb.x + 3)
            const txR = Math.round(nb.x + nb.width - 4)
            topR = px(rotated, txL, ty)
            topC = px(cand, txL, ty)
            botR = px(rotated, txR, ty)
            botC = px(cand, txR, ty)
          }
          // Expected orientation: no-reverse legs keep fill first
          // (top/left reads fill=red or transparent-red), reversing legs put
          // secondary first. Transparent ends reuse the surviving RGB, so
          // compare alpha for the transparent states and red-dominance for
          // the opaque state.
          const reverses = (dir === 'ccw' && gradient === 'horizontal') || (dir === 'cw' && gradient === 'vertical')
          const expectedTopIsFill = !reverses
          // Probe match in premultiplied space (same low-alpha rationale as
          // the full-image metric): un-premultiplied RGB near the transparent
          // end is unstable, premultiplied RGB + alpha is not.
          const chanDiffProbe = (a: number[], b: number[]): number =>
            Math.max(
              Math.abs(premult(a[0]!, a[3]!) - premult(b[0]!, b[3]!)),
              Math.abs(premult(a[1]!, a[3]!) - premult(b[1]!, b[3]!)),
              Math.abs(premult(a[2]!, a[3]!) - premult(b[2]!, b[3]!)),
              Math.abs(a[3]! - b[3]!),
            )
          const topMatches = chanDiffProbe(topR, topC) <= 6
          const bottomMatches = chanDiffProbe(botR, botC) <= 6
          // Orientation check on the CANDIDATE alone (independent of the
          // rotated image): opaque → red-dominant vs blue-dominant ends;
          // transparent → alpha ~0 vs 255 ends.
          let orientationOk = true
          if (!t.f && !t.s) {
            const topRed = topC[0]! > 150 && topC[2]! < 110
            const topBlue = topC[2]! > 150 && topC[0]! < 110
            const botRed = botC[0]! > 150 && botC[2]! < 110
            const botBlue = botC[2]! > 150 && botC[0]! < 110
            orientationOk = expectedTopIsFill ? topRed && botBlue : topBlue && botRed
          } else if (t.f && !t.s) {
            // fill transparent: fill end alpha ~0, secondary end ~255.
            orientationOk = expectedTopIsFill ? topC[3]! < 60 && botC[3]! > 200 : topC[3]! > 200 && botC[3]! < 60
          } else {
            orientationOk = expectedTopIsFill ? topC[3]! > 200 && botC[3]! < 60 : topC[3]! < 60 && botC[3]! > 200
          }
          cases.push({
            name,
            maxDiff: md,
            worstAt,
            worstA,
            worstB,
            topProbeR: topR,
            topProbeC: topC,
            bottomProbeR: botR,
            bottomProbeC: botC,
            expectedTopIsFill,
            topMatches: topMatches && orientationOk,
            bottomMatches,
            premultRgb: pmd.rgb,
            premultAlpha: pmd.alpha,
            ok: pmd.rgb <= 6 && pmd.alpha <= 3 && topMatches && bottomMatches && orientationOk,
          })
        }
      }
    }

    // G3: four cw turns return the exact pixels (even opaque horizontal).
    const src0 = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: styleFor('horizontal', { f: false, s: false }) }
    const { data: srcData0 } = paintShape(W, H, src0)
    let cur: unknown = src0
    for (let i = 0; i < 4; i += 1) cur = rotate(cur, 'cw', { width: W, height: H }).pending
    const { data: roundTripped } = paintShape(W, H, cur)
    let identityByteEqual = true
    for (let i = 0; i < srcData0.data.length; i += 1) {
      if (srcData0.data[i] !== roundTripped.data[i]) {
        identityByteEqual = false
        break
      }
    }

    // G7 solid: rotation-symmetric raster is byte-equal to the redrawn box.
    const solidSrc = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: styleFor('solid', { f: false, s: false }) }
    const { data: solidData } = paintShape(W, H, solidSrc)
    const solidRot = rotateRasterExact(solidData, CX, CY, 'cw')
    const solidNext = rotate(solidSrc, 'cw', { width: W, height: H }).pending as unknown as { style: { gradient: string } }
    const { data: solidCand } = paintShape(W, H, solidNext)
    let solidByteEqual = solidNext.style.gradient === 'solid'
    if (solidByteEqual) {
      for (let i = 0; i < solidRot.data.length; i += 1) {
        if (solidRot.data[i] !== solidCand.data[i]) {
          solidByteEqual = false
          break
        }
      }
    }
    // G7 radial: helper keeps kind+stops verbatim.
    const radialSrc = {
      kind: 'rect',
      box: { ...BOX },
      mode: 'filled',
      style: { ...styleFor('radial', { f: false, s: false }), secondary: BLUE },
    }
    const radialNext = rotate(radialSrc, 'cw', { width: W, height: H }).pending as unknown as {
      style: { gradient: string; fill: string; secondary: string }
    }
    const radialUnchanged =
      radialNext.style.gradient === 'radial' && radialNext.style.fill === RED && radialNext.style.secondary === BLUE

    // G4 odd dimensions: integers, no NaNs, interior probe parity.
    const ODD = { x: 7, y: 3, width: 61, height: 41 }
    const ODD_CX = ODD.x + ODD.width / 2
    const ODD_CY = ODD.y + ODD.height / 2
    const oddSrc = { kind: 'rect', box: { ...ODD }, mode: 'filled', style: styleFor('horizontal', { f: false, s: false }) }
    const { data: oddData } = paintShape(W, H, oddSrc)
    const oddRot = rotateRasterExact(oddData, ODD_CX, ODD_CY, 'ccw')
    const oddNext = rotate(oddSrc, 'ccw', { width: W, height: H }).pending as unknown as {
      box: { x: number; y: number; width: number; height: number }
      style: { gradient: string; fill: string; secondary: string }
    }
    const { data: oddCand } = paintShape(W, H, oddNext)
    const oddIntegers =
      Number.isInteger(oddNext.box.x) &&
      Number.isInteger(oddNext.box.y) &&
      Number.isInteger(oddNext.box.width) &&
      Number.isInteger(oddNext.box.height) &&
      [oddNext.box.x, oddNext.box.y, oddNext.box.width, oddNext.box.height].every((v) => Number.isFinite(v) && !Number.isNaN(v))
    const ocx = Math.round(oddNext.box.x + oddNext.box.width / 2)
    const ocy = Math.round(oddNext.box.y + oddNext.box.height / 2)
    // 3×3 interior patch max diff (edges may sit ±0.5px after the snap).
    let oddInteriorDiff = 0
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const a = px(oddRot, ocx + dx, ocy + dy)
        const b = px(oddCand, ocx + dx, ocy + dy)
        for (let k = 0; k < 4; k += 1) oddInteriorDiff = Math.max(oddInteriorDiff, Math.abs(a[k]! - b[k]!))
      }
    }

    // G5 res1/res2: same box+style and same relative probes on both sizes.
    const BIG_W = 480
    const BIG_H = 360
    const bigSrc = { kind: 'rect', box: { ...BOX }, mode: 'filled', style: styleFor('vertical', { f: false, s: false }) }
    const smallNext = rotate(bigSrc, 'cw', { width: W, height: H }).pending as unknown as { box: unknown; style: unknown }
    const bigNext = rotate(bigSrc, 'cw', { width: BIG_W, height: BIG_H }).pending as unknown as { box: unknown; style: unknown }
    const { data: smallCand } = paintShape(W, H, smallNext)
    const { data: bigCand } = paintShape(BIG_W, BIG_H, bigNext)
    const nbSmall = (smallNext as { box: { x: number; y: number; width: number; height: number } }).box
    const nbBig = (bigNext as { box: { x: number; y: number; width: number; height: number } }).box
    const boxesEqual = JSON.stringify(nbSmall) === JSON.stringify(nbBig)
    const stylesEqual = JSON.stringify((smallNext as { style: unknown }).style) === JSON.stringify((bigNext as { style: unknown }).style)
    // Relative probes: left/right thirds of the candidate box on each canvas.
    const probeRel = (d: ImageData, b: { x: number; y: number; width: number; height: number }, fx: number): number[] =>
      px(d, Math.round(b.x + b.width * fx), Math.round(b.y + b.height / 2))
    const relDiff =
      Math.max(
        Math.abs(probeRel(smallCand, nbSmall, 0.15)[0]! - probeRel(bigCand, nbBig, 0.15)[0]!),
        Math.abs(probeRel(smallCand, nbSmall, 0.85)[2]! - probeRel(bigCand, nbBig, 0.85)[2]!),
      )
    const resMatch = boxesEqual && stylesEqual && relDiff <= 12

    // G6 clipping: rotated box overflows a tight canvas; helper clamps.
    const TIGHT_W = 100
    const TIGHT_H = 80
    const EDGE = { x: 10, y: 10, width: 90, height: 70 }
    const edgeSrc = { kind: 'rect', box: { ...EDGE }, mode: 'filled', style: styleFor('vertical', { f: false, s: false }) }
    let clipOk = true
    let clipVisibleMatch = false
    try {
      const edgeNext = rotate(edgeSrc, 'cw', { width: TIGHT_W, height: TIGHT_H }).pending as unknown as {
        box: { x: number; y: number; width: number; height: number }
        style: { gradient: string; fill: string; secondary: string }
      }
      clipOk =
        edgeNext.box.width <= TIGHT_W &&
        edgeNext.box.height <= TIGHT_H &&
        edgeNext.style.gradient === 'horizontal' &&
        edgeNext.style.fill === BLUE &&
        edgeNext.style.secondary === RED
      const { canvas: edgeCanvas, data: edgeData } = paintShape(TIGHT_W, TIGHT_H, edgeSrc)
      void edgeCanvas
      const edgeRot = rotateRasterExact(edgeData, EDGE.x + EDGE.width / 2, EDGE.y + EDGE.height / 2, 'cw')
      const { data: edgeCand } = paintShape(TIGHT_W, TIGHT_H, edgeNext)
      // Visible probe: clamped box center (inside both by construction).
      const vx = Math.round(edgeNext.box.x + edgeNext.box.width / 2)
      const vy = Math.round(edgeNext.box.y + edgeNext.box.height / 2)
      const a = px(edgeRot, Math.min(TIGHT_W - 1, Math.max(0, vx)), Math.min(TIGHT_H - 1, Math.max(0, vy)))
      const b = px(edgeCand, Math.min(TIGHT_W - 1, Math.max(0, vx)), Math.min(TIGHT_H - 1, Math.max(0, vy)))
      clipVisibleMatch = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!), Math.abs(a[3]! - b[3]!)) <= 16
    } catch {
      clipOk = false
    }

    return {
      cases,
      identityByteEqual,
      solidByteEqual,
      radialUnchanged,
      oddIntegers,
      oddInteriorDiff,
      resMatch,
      clipOk,
      clipVisibleMatch,
      worstMaxDiff,
    }
  })
}

describe('bitmap pending transform gradient rotation (strict Canvas oracle, port 4677)', () => {
  beforeAll(async () => {
    await assertOnDiskFlagFalse('beforeAll')
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, CHROME_BIN: CHROME_PATH },
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
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page = fresh
    await fresh.goto(base, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await assertOnDiskFlagFalse('afterAll')
  })

  it('matches the matrix-rotated raster in all 4 direction×kind cases (opaque + transparent)', async () => {
    const proof = await runProofs()
    console.log(`[gradient-rotate] worstMaxDiff=${proof.worstMaxDiff} oddInterior=${proof.oddInteriorDiff}`)
    for (const c of proof.cases) {
      console.log(
        `[gradient-rotate] ${c.name} rawMax=${c.maxDiff}@${c.worstAt} pmRgb=${c.premultRgb} pmA=${c.premultAlpha} topC=${c.topProbeC.join(',')} botC=${c.bottomProbeC.join(',')} ok=${c.ok}`,
      )
    }
    console.log(
      `[gradient-rotate] identity=${proof.identityByteEqual} solid=${proof.solidByteEqual} radial=${proof.radialUnchanged} oddInt=${proof.oddIntegers} res=${proof.resMatch} clip=${proof.clipOk}/${proof.clipVisibleMatch}`,
    )
    expect(proof.cases.length).toBe(12)
    for (const c of proof.cases) {
      expect(c.ok).toBe(true)
      expect(c.premultRgb).toBeLessThanOrEqual(6)
      expect(c.premultAlpha).toBeLessThanOrEqual(3)
    }
    expect(proof.identityByteEqual).toBe(true)
    expect(proof.solidByteEqual).toBe(true)
    expect(proof.radialUnchanged).toBe(true)
    expect(proof.oddIntegers).toBe(true)
    expect(proof.oddInteriorDiff).toBeLessThanOrEqual(16)
    expect(proof.resMatch).toBe(true)
    expect(proof.clipOk).toBe(true)
    expect(proof.clipVisibleMatch).toBe(true)
  }, 60_000)
})
