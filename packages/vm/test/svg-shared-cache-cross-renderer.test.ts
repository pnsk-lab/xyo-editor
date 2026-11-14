/**
 * Reproduction: module-global `svgTextureSizeByKey` leaks across
 * `ScratchCanvasRenderer` instances via `pruneCostumeImages` /
 * `clearCachedCostumes` / `cacheCostumeImage` overwrite.
 *
 * Static-review claim under test:
 * - `svgTextureSizeByKey` is a module global (`packages/vm/src/index.ts`),
 *   keyed `${md5ext|assetId}:${dataFormat}`.
 * - `pruneCostumeImages` deletes that global key for every key it drops
 *   from its OWN `costumeImages` map.
 * - `clearCachedCostumes` calls `clearSvgTextureCache()` which clears the
 *   WHOLE global map, even keys the calling instance never held.
 * - `cacheCostumeImage(assetId, dataFormat, image)` without a valid
 *   `svgSize` (or with a different size) deletes/overwrites the same global
 *   key.
 * - `targetCostumeBox` (used by `getBounds`) reads ONLY that global key,
 *   never the per-image `WeakMap`. `costumeImageSize` (used for stage
 *   pixels) reads the global FIRST, then the per-image fallback.
 *
 * Harness below is VM-only, Node/Bun only (no Chromium, no network, no DOM):
 * - Two real `ScratchCanvasRenderer` instances share one SVG key
 *   `shared.svg:svg` (explicit `width=300 height=150 viewBox=0 0 300 150`,
 *   center `(75,37.5)` chosen so the legacy fallback
 *   `max(96,center*2) = 150x96` is distinguishable from the correct
 *   `300x150`).
 * - "Load complete" is simulated through the product load-stage APIs
 *   (`cacheCostumeImage` + authoritative `[300,150]`), i.e. the same global
 *   + per-image writes `resolveCostumeImage` performs after sanitizing bytes
 *   (`svgTextureSizeByKey.set(key, geometry.textureSize)` +
 *   `noteSvgTextureSizeForImage(image, svgSize)`).
 * - Then the OTHER instance runs `prune` / `clear` / `overwrite`, and the
 *   ORIGINAL instance re-runs stage pixels (`drawImage` capture) and
 *   `getBounds`.
 *
 * Expected if instances were isolated: original stays `300x150` in both.
 * Current product reality (characterized 2026-11-11, Bun `bun test`):
 * bounds regresses to `150x96` (`left -75/right 75/top 37.5/bottom -58.5`)
 * after prune/clear/delete-overwrite; overwrite-with-size hijacks both
 * pixels and bounds (`93x41`). Pixels stay `300x150` after pure delete only
 * because the per-image `WeakMap` masks the lost global — bounds has no
 * such second chance (`targetCostumeBox` reads the global only).
 *
 * Product code is untouched; this file only READS product behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ScratchCanvasRenderer,
  ScratchVM,
  clearSvgTextureCache,
  createDefaultProject,
} from '../src/index'

const SHARED_MD5EXT = 'shared.svg'
const SHARED_FORMAT = 'svg'
const SHARED_KEY = `${SHARED_MD5EXT}:${SHARED_FORMAT}`
const CORRECT_SIZE: [number, number] = [300, 150]
// Deliberately off-centre so center*2 fallback (150x75) differs.
const CENTER_X = 75
const CENTER_Y = 37.5

function sharedCostume() {
  return {
    name: 'shared',
    assetId: 'shared',
    md5ext: SHARED_MD5EXT,
    dataFormat: SHARED_FORMAT,
    rotationCenterX: CENTER_X,
    rotationCenterY: CENTER_Y,
  } as never
}

function makeSnapshot() {
  const project = createDefaultProject()
  const sprite = project.targets[1]!
  sprite.x = 0
  sprite.y = 0
  sprite.size = 100
  sprite.direction = 90
  sprite.rotationStyle = 'all around'
  sprite.visible = true
  sprite.costumes = [sharedCostume()]
  sprite.currentCostume = 0
  const vm = new ScratchVM()
  vm.loadProject(project)
  return vm.snapshot()
}

function stubImage() {
  return { naturalWidth: 300, naturalHeight: 150 } as never
}

function attachStub(renderer: ScratchCanvasRenderer, drawCalls: unknown[][]) {
  const context = {
    beginPath: () => undefined,
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
    drawImage: (...args: unknown[]) => drawCalls.push(args),
  } as unknown as CanvasRenderingContext2D
  const internals = renderer as unknown as {
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
  }
  internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
  internals.context = context
}

function withDummyImage<T>(fn: () => T): T {
  const original = globalThis.Image
  globalThis.Image = class {} as unknown as typeof Image
  try {
    return fn()
  } finally {
    globalThis.Image = original
  }
}

function drawArgsOf(drawCalls: unknown[][]): unknown[] | undefined {
  return drawCalls[0]?.slice(1)
}

beforeEach(() => {
  clearSvgTextureCache()
})

afterEach(() => {
  clearSvgTextureCache()
})

describe('shared SVG key across two real ScratchCanvasRenderer instances (read-only reproduction)', () => {
  it('pruning B leaves renderer A bounds and drawing unchanged', () => {
    const snapshot = makeSnapshot()
    const rendererA = new ScratchCanvasRenderer()
    const rendererB = new ScratchCanvasRenderer()
    const drawA: unknown[][] = []
    attachStub(rendererA, drawA)

    // A's load completes (authoritative 300x150, global + per-image).
    rendererA.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])
    // B holds the SAME key (precondition in the static review).
    rendererB.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])

    withDummyImage(() => rendererA.requestDraw(snapshot))
    const baselineBounds = rendererA.getBounds('Sprite1')
    const baselineDraw = drawArgsOf(drawA)
    expect(baselineBounds).toMatchObject({ width: 300, height: 150, left: -75, right: 225, top: 37.5, bottom: -112.5 })
    expect(baselineDraw).toEqual([-75, -37.5, 300, 150])

    // The OTHER instance drops the shared key.
    rendererB.pruneCostumeImages([])

    // Original instance draws / measures again without re-loading.
    drawA.length = 0
    withDummyImage(() => rendererA.requestDraw(snapshot))
    const afterBounds = rendererA.getBounds('Sprite1')
    const afterDraw = drawArgsOf(drawA)

    // B's cache changes must not affect A's bounds or rendered size.
    expect({ key: SHARED_KEY, afterBounds, afterDraw }).toMatchObject({
      key: SHARED_KEY,
      afterBounds: { width: 300, height: 150, left: -75, right: 225, top: 37.5, bottom: -112.5 },
      afterDraw: [-75, -37.5, 300, 150],
    })
  })

  it('clearing B leaves renderer A geometry intact', () => {
    const snapshot = makeSnapshot()
    const rendererA = new ScratchCanvasRenderer()
    const rendererB = new ScratchCanvasRenderer()
    const drawA: unknown[][] = []
    attachStub(rendererA, drawA)

    rendererA.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])
    rendererB.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])

    withDummyImage(() => rendererA.requestDraw(snapshot))
    expect(rendererA.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150 })

    // Clearing B must not clear A's renderer-owned geometry.
    rendererB.clearCachedCostumes()

    drawA.length = 0
    withDummyImage(() => rendererA.requestDraw(snapshot))
    const afterBounds = rendererA.getBounds('Sprite1')
    const afterDraw = drawArgsOf(drawA)

    expect({ key: SHARED_KEY, afterBounds, afterDraw }).toMatchObject({
      key: SHARED_KEY,
      afterBounds: { width: 300, height: 150, left: -75, right: 225, top: 37.5, bottom: -112.5 },
      afterDraw: [-75, -37.5, 300, 150],
    })
  })

  it('caching B without a size leaves renderer A geometry intact', () => {
    const snapshot = makeSnapshot()
    const rendererA = new ScratchCanvasRenderer()
    const rendererB = new ScratchCanvasRenderer()
    const drawA: unknown[][] = []
    attachStub(rendererA, drawA)

    rendererA.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])
    withDummyImage(() => rendererA.requestDraw(snapshot))
    expect(rendererA.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150 })

    // B re-seeds the same key without bytes-derived geometry.
    rendererB.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage())

    drawA.length = 0
    withDummyImage(() => rendererA.requestDraw(snapshot))
    const afterBounds = rendererA.getBounds('Sprite1')
    const afterDraw = drawArgsOf(drawA)

    expect({ key: SHARED_KEY, afterBounds, afterDraw }).toMatchObject({
      key: SHARED_KEY,
      afterBounds: { width: 300, height: 150, left: -75, right: 225, top: 37.5, bottom: -112.5 },
      afterDraw: [-75, -37.5, 300, 150],
    })
  })

  it('a different size on B does not alter renderer A drawing or bounds', () => {
    const snapshot = makeSnapshot()
    const rendererA = new ScratchCanvasRenderer()
    const rendererB = new ScratchCanvasRenderer()
    const drawA: unknown[][] = []
    attachStub(rendererA, drawA)

    rendererA.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])
    withDummyImage(() => rendererA.requestDraw(snapshot))
    expect(rendererA.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150 })

    // B records a different size under the same key; A must stay unchanged.
    rendererB.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [93, 41])

    drawA.length = 0
    withDummyImage(() => rendererA.requestDraw(snapshot))
    const afterBounds = rendererA.getBounds('Sprite1')
    const afterDraw = drawArgsOf(drawA)

    expect({ key: SHARED_KEY, afterBounds, afterDraw }).toMatchObject({
      key: SHARED_KEY,
      afterBounds: { width: 300, height: 150, left: -75, right: 225, top: 37.5, bottom: -112.5 },
      afterDraw: [-75, -37.5, 300, 150],
    })
  })

  it('updateSVGSkin on B does NOT touch the shared SVG geometry (isolation boundary)', () => {
    const snapshot = makeSnapshot()
    const rendererA = new ScratchCanvasRenderer()
    const rendererB = new ScratchCanvasRenderer()
    const drawA: unknown[][] = []
    attachStub(rendererA, drawA)

    rendererA.cacheCostumeImage(SHARED_MD5EXT, SHARED_FORMAT, stubImage(), [...CORRECT_SIZE] as [number, number])
    withDummyImage(() => rendererA.requestDraw(snapshot))
    expect(rendererA.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150 })

    // `updateSVGSkin` only touches B's own `skins` map (per-instance), never
    // `svgTextureSizeByKey`. If "update" in the review meant this API, that
    // slice is a misdiagnosis — this test documents the boundary by passing.
    const skinId = rendererB.createSVGSkin('<svg/>', [0, 0])
    rendererB.updateSVGSkin(skinId, '<svg/>', [0, 0])

    drawA.length = 0
    withDummyImage(() => rendererA.requestDraw(snapshot))
    expect(rendererA.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150 })
    expect(drawArgsOf(drawA)).toEqual([-75, -37.5, 300, 150])
  })
})
