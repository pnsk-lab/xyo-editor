// Stage PNG backdrop `bitmapResolution` canonical pins.
//
// FORENSIC CONTEXT (static investigation; product code untouched):
// - Recent work changed stage PNG upload / library / backdrop intake in
//   `packages/editor/src/Editor.svelte` from `bitmapResolution 2` to `1`
//   (`addLibraryBackdrop`, `addLibraryCostume` stage branch, `uploadCostume`
//   stage branch), with rotationCenter forced to (240, 180).
// - Scratch canonical values (from `.tmp/scratch-editor`, static only):
//   * `scratch-gui/.../libraries/backdrops.json`: all 68 PNG backdrops are
//     `bitmapResolution: 2, rotationCenter 480,360` (e.g. Arctic
//     `67e0db33...png`); SVG backdrops are res 1, center 240,180.
//   * `scratch-gui/src/lib/file-uploader.js` `costumeUpload`: bitmap uploads
//     create a VMAsset with NO bitmapResolution/rotationCenter; the VM then
//     defaults them (`load-costume.js` `loadBitmap_`: res 2, center = image
//     middle). Stage uploads therefore land at res 2 in real Scratch.
//   * `scratch-gui/.../paint-editor-wrapper.jsx` `handleUpdateImage`: paint
//     saves bitmaps with hardcoded `2 /* bitmapResolution */`, center from
//     `update-image-hoc.jsx` `(480 - rect.x, 360 - rect.y)` on the 960x720
//     artboard (full-bleed stage art -> res2 center 480,360).
//   * `scratch-render/.../BitmapSkin.js`: drawn size = texels / resolution.
// - XYO-EDITOR consequence (this repo's VM renders W/R directly,
//   `packages/vm/src/index.ts` `drawBackdropImage`: x = 240 - cx/R,
//   y = 180 - cy/R, size W/R x H/R; no res1->res2 upscale unlike Scratch):
//   * Canonical 960x720-byte PNG backdrop at res2/480,360 -> x=0,y=0,
//     480x360: exact full-stage cover.
//   * SAME bytes forced to res1/240,180 -> x=0,y=0, 960x720:
//     2x overflow, only the top-left quarter is visible.
//   * 480x360 user PNG at res1/240,180 -> full-stage fill, whereas
//     Scratch stores it at res2/middle -> 240x180 centered quarter.
// - UNCONFIRMED (static alone cannot settle; live Scratch GUI run needed):
//   * Pixel-level before/after appearance in the REAL Scratch editor GUI
//     (browser) for a Stage 480x360 PNG upload, including paint round-trip
//     placement of a res1 stage bitmap on Scratch's 960x720 paint artboard.
//   * Whether any Scratch-side normalization rewrites res1 stage bitmaps on
//     project load/save beyond `fetchBitmapCanvas_` (shows only the 1->2
//     upscale path statically).
//
// This file pins the repo-own facts (library metadata, bundled byte sizes,
// VM stage draw math) so the intake regression above is visible without
// touching product code.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScratchCanvasRenderer, ScratchVM, createDefaultProject } from '../../vm/src/index'
import { scratchCostumeLibrary } from '../src/lib/scratch-asset-libraries'

const here = dirname(fileURLToPath(import.meta.url))
const imageDir = join(here, '..', 'public', 'assets-scratch', 'images')

function pngDimensions(path: string): [number, number] {
  const bytes = readFileSync(path)
  // Minimal IHDR parse (no image library): 8-byte signature + 25-byte IHDR.
  expect(bytes.length).toBeGreaterThan(33)
  expect(bytes[12]).toBe(0x49)
  expect(bytes[13]).toBe(0x48)
  expect(bytes[14]).toBe(0x44)
  expect(bytes[15]).toBe(0x52)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return [width, height]
}

/** Draw one stage backdrop through the real VM renderer with a stub 2d context. */
function drawBackdropOnStage(
  costume: Record<string, unknown>,
  image: { naturalWidth: number; naturalHeight: number },
): [number, number, number, number] {
  const project = createDefaultProject()
  // Focus the frame on the backdrop: drop sprites so no sprite/fallback path
  // can emit drawImage calls through the stub context.
  project.targets = project.targets.filter((target) => target.isStage)
  const stage = project.targets.find((target) => target.isStage) ?? project.targets[0]!
  stage.costumes = [costume as never]
  stage.currentCostume = 0
  const vm = new ScratchVM()
  vm.loadProject(project)
  const renderer = new ScratchCanvasRenderer()
  const drawImageCalls: unknown[][] = []
  const context = {
    arc: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    lineTo: () => undefined,
    moveTo: () => undefined,
    restore: () => undefined,
    rotate: () => undefined,
    save: () => undefined,
    scale: () => undefined,
    setLineDash: () => undefined,
    stroke: () => undefined,
    strokeRect: () => undefined,
    translate: () => undefined,
    drawImage: (...args: unknown[]) => drawImageCalls.push(args),
  } as unknown as CanvasRenderingContext2D
  const internals = renderer as unknown as {
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
    costumeImages: Map<string, { status: 'ready'; image: unknown }>
  }
  internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
  internals.context = context
  const md5ext = String((costume as { md5ext?: string }).md5ext ?? 'c.png')
  const dataFormat = String((costume as { dataFormat?: string }).dataFormat ?? 'png')
  internals.costumeImages.set(`${md5ext}:${dataFormat}`, { status: 'ready', image: image as never })
  const originalImage = (globalThis as { Image?: typeof Image }).Image
  ;(globalThis as { Image?: unknown }).Image = class {}
  try {
    renderer.requestDraw(vm.snapshot())
  } finally {
    if (originalImage) (globalThis as { Image?: unknown }).Image = originalImage
    else delete (globalThis as { Image?: unknown }).Image
  }
  const call = drawImageCalls.find((args) => args[0] === image)
  expect(call).toBeDefined()
  return (call as unknown[]).slice(1) as [number, number, number, number]
}

const ARCTIC_MD5 = '67e0db3305b3c8bac3a363b1c428892e.png'

describe('stage PNG backdrop bitmapResolution canonical pins', () => {
  it('keeps Scratch library metadata: every PNG is res2, every SVG is res1', () => {
    const png = scratchCostumeLibrary.filter((c) => c.dataFormat === 'png')
    const svg = scratchCostumeLibrary.filter((c) => c.dataFormat === 'svg')
    expect(png.length).toBeGreaterThan(0)
    expect(svg.length).toBeGreaterThan(0)
    for (const entry of png) expect(entry.bitmapResolution).toBe(2)
    for (const entry of svg) expect(entry.bitmapResolution).toBe(1)
  })

  it('keeps the Arctic library PNG at canonical res2 center 480,360', () => {
    const arctic = scratchCostumeLibrary.find((c) => c.md5ext === ARCTIC_MD5)
    expect(arctic).toBeDefined()
    expect(arctic).toMatchObject({ dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 480, rotationCenterY: 360 })
  })

  it('ships 960x720 bytes for the canonical res2 PNG backdrops', () => {
    expect(pngDimensions(join(imageDir, ARCTIC_MD5))).toEqual([960, 720])
    expect(pngDimensions(join(imageDir, '050615fe992a00d6af0e664e497ebf53.png'))).toEqual([960, 720])
  })

  it('renders canonical 960x720 res2/480,360 as an exact full-stage cover', () => {
    const call = drawBackdropOnStage(
      { name: 'Arctic', assetId: 'arctic', md5ext: ARCTIC_MD5, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 480, rotationCenterY: 360 },
      { naturalWidth: 960, naturalHeight: 720 },
    )
    expect(call).toEqual([0, 0, 480, 360])
  })

  it('demonstrates 2x overflow if 960x720 bytes are forced to res1/240,180', () => {
    // This is exactly what addLibraryBackdrop / the stage branches of
    // addLibraryCostume / uploadCostume now store: bitmapResolution 1 with
    // center (240,180), discarding the library res2/480,360 metadata.
    const call = drawBackdropOnStage(
      { name: 'Arctic', assetId: 'arctic', md5ext: ARCTIC_MD5, dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
      { naturalWidth: 960, naturalHeight: 720 },
    )
    expect(call).toEqual([0, 0, 960, 720])
    // Only the top-left 480x360 of the 960x720 draw is visible on stage.
    expect(call).not.toEqual([0, 0, 480, 360])
  })

  it('shows the intake divergence for a 480x360 user PNG: res1 fills, Scratch-canonical res2 quarters', () => {
    const res1 = drawBackdropOnStage(
      { name: 'stage-photo', assetId: 'photo', md5ext: 'photo.png', dataFormat: 'png', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 },
      { naturalWidth: 480, naturalHeight: 360 },
    )
    expect(res1).toEqual([0, 0, 480, 360])
    // Real Scratch upload path (no res/center supplied -> VM defaults res2,
    // center image-middle) renders the same bytes as a centered quarter.
    const res2 = drawBackdropOnStage(
      { name: 'stage-photo', assetId: 'photo', md5ext: 'photo.png', dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 240, rotationCenterY: 180 },
      { naturalWidth: 480, naturalHeight: 360 },
    )
    expect(res2).toEqual([120, 90, 240, 180])
  })
})
