import { describe, expect, it } from 'bun:test'
import { strToU8 } from 'fflate'
import { ScratchCanvasRenderer, ScratchVM, createDefaultProject } from '../src/index'

function drawWithImage(costume: Record<string, unknown>, image: Record<string, unknown>) {
  const project = createDefaultProject()
  const sprite = project.targets[1]!
  sprite.costumes = [costume as never]
  const vm = new ScratchVM()
  vm.loadProject(project)
  const renderer = new ScratchCanvasRenderer()
  const drawImageCalls: unknown[][] = []
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
    drawImage: (...args: unknown[]) => drawImageCalls.push(args),
  } as unknown as CanvasRenderingContext2D
  const internals = renderer as unknown as {
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
    costumeImages: Map<string, { status: 'ready'; image: unknown }>
  }
  internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
  internals.context = context
  const md5ext = String((costume as { md5ext?: string }).md5ext ?? 'c.svg')
  const dataFormat = String((costume as { dataFormat?: string }).dataFormat ?? 'svg')
  internals.costumeImages.set(`${md5ext}:${dataFormat}`, { status: 'ready', image: image as never })
  const originalImage = globalThis.Image
  globalThis.Image = class {} as typeof Image
  try {
    renderer.requestDraw(vm.snapshot())
  } finally {
    globalThis.Image = originalImage
  }
  return drawImageCalls[0]?.slice(1)
}

describe('costumeImageSize 300-wide guard', () => {
  it('keeps genuine 300x150 SVG artwork at natural size (default sprite center 48,48)', () => {
    const call = drawWithImage(
      { name: 'wide', assetId: 'wide', md5ext: 'wide.svg', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 },
      { naturalWidth: 300, naturalHeight: 150 },
    )
    expect(call).toEqual([-48, -48, 300, 150])
  })

  it('keeps the viewBox-only placeholder fallback (300x132 with true center 46.5,20.5)', () => {
    const call = drawWithImage(
      { name: 'button', assetId: 'button', md5ext: 'button.svg', dataFormat: 'svg', rotationCenterX: 46.5, rotationCenterY: 20.5 },
      { naturalWidth: 300, naturalHeight: 132 },
    )
    expect(call).toEqual([-46.5, -20.5, 93, 41])
  })

  it('does not apply the SVG fallback to 300-wide bitmaps or center-less costumes', () => {
    const bitmap = drawWithImage(
      { name: 'wide-png', assetId: 'wide-png', md5ext: 'wide-png.png', dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 48, rotationCenterY: 48 },
      { naturalWidth: 300, naturalHeight: 150 },
    )
    expect(bitmap).toEqual([-48, -48, 300, 150])

    const blank = drawWithImage(
      { name: 'blank', assetId: 'blank', md5ext: 'blank.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0 },
      { naturalWidth: 300, naturalHeight: 150 },
    )
    expect(blank).toEqual([-0, -0, 300, 150])
  })

  it('round-trips UTF8 SVG text through sanitize/store/load without loss', async () => {
    const vm = new ScratchVM()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text x="8" y="48">こんにちは🍣</text></svg>'
    const stored = await vm.storeAsset(strToU8(svg), 'svg')
    const loaded = await vm.loadAsset(stored.assetId, 'svg')
    expect(new TextDecoder().decode(loaded!)).toContain('こんにちは🍣')
  })

  it('keeps full stage bounds for the default 480x360 backdrop', () => {
    const project = createDefaultProject()
    project.targets[1]!.visible = false
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    const drawImageCalls: unknown[][] = []
    const context = {
      clearRect: () => undefined,
      fillRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      scale: () => undefined,
      drawImage: (...args: unknown[]) => drawImageCalls.push(args),
    } as unknown as CanvasRenderingContext2D
    const internals = renderer as unknown as {
      canvas: HTMLCanvasElement
      context: CanvasRenderingContext2D
      costumeImages: Map<string, { status: 'ready'; image: unknown }>
    }
    internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
    internals.context = context
    const stageCostume = project.targets[0]!.costumes[0]!
    internals.costumeImages.set(`${stageCostume.md5ext}:${stageCostume.dataFormat}`, {
      status: 'ready',
      image: { naturalWidth: 480, naturalHeight: 360 } as never,
    })
    const originalImage = globalThis.Image
    globalThis.Image = class {} as typeof Image
    try {
      renderer.requestDraw(vm.snapshot())
    } finally {
      globalThis.Image = originalImage
    }
    expect(renderer.getNativeSize()).toEqual([480, 360])
    expect(drawImageCalls[0]?.slice(1)).toEqual([0, 0, 480, 360])
  })
})
