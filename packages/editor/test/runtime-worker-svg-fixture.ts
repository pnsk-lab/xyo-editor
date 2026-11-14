import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'

const SVG_EXPLICIT_300x150 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect width="300" height="150" fill="red"/></svg>'
const SVG_VIEWBOX_ONLY_93x41 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 93 41"><rect width="93" height="41" fill="red"/></svg>'

function pngBytes(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  context.fillStyle = '#00aa00'
  context.fillRect(0, 0, width, height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('toBlob failed'))
        return
      }
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/png')
  })
}

function projectWithCostume(costume: Record<string, unknown>) {
  const project = createDefaultProject()
  const sprite = project.targets.find((target) => !target.isStage)!
  sprite.costumes = [costume as never]
  sprite.currentCostume = 0
  return project
}

function approx(value: number, expected: number): boolean {
  return Math.abs(value - expected) < 0.5
}

;(window as any).runWorkerSvgFixture = async () => {
  const vm = new ScratchVM()
  const canvas = document.querySelector('#stage') as HTMLCanvasElement
  canvas.width = 480
  canvas.height = 360
  const controller = new RuntimeWorkerController(vm, () => {})
  const results: Record<string, unknown> = {}
  try {
    const explicit = await vm.storeAsset(new TextEncoder().encode(SVG_EXPLICIT_300x150), 'svg')
    const viewBoxOnly = await vm.storeAsset(new TextEncoder().encode(SVG_VIEWBOX_ONLY_93x41), 'svg')
    const pngRaw = await pngBytes(300, 150)
    const png = await vm.storeAsset(pngRaw, 'png')

    // 1) explicit 300x150, off-centre (75,37.5).
    let project = projectWithCostume({
      name: 'wide',
      assetId: explicit.assetId,
      md5ext: explicit.md5ext,
      dataFormat: 'svg',
      rotationCenterX: 75,
      rotationCenterY: 37.5,
    })
    await vm.loadProject(project)
    controller.attachCanvas(canvas, vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 1500))
    results.explicit = await controller.probeBounds('Sprite1')

    // 2) arbitrary rotationCenter (10,10) on the same explicit bytes.
    project = projectWithCostume({
      name: 'wide',
      assetId: explicit.assetId,
      md5ext: explicit.md5ext,
      dataFormat: 'svg',
      rotationCenterX: 10,
      rotationCenterY: 10,
    })
    await vm.loadProject(project)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.arbitraryCenter = await controller.probeBounds('Sprite1')

    // 3) viewBox-only 93x41 (true center 46.5,20.5).
    project = projectWithCostume({
      name: 'button',
      assetId: viewBoxOnly.assetId,
      md5ext: viewBoxOnly.md5ext,
      dataFormat: 'svg',
      rotationCenterX: 46.5,
      rotationCenterY: 20.5,
    })
    await vm.loadProject(project)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.viewBoxOnly = await controller.probeBounds('Sprite1')

    // 4) PNG 300x150 must stay 300x150 (never consults the SVG cache).
    project = projectWithCostume({
      name: 'wide-png',
      assetId: png.assetId,
      md5ext: png.md5ext,
      dataFormat: 'png',
      bitmapResolution: 1,
      rotationCenterX: 150,
      rotationCenterY: 75,
    })
    await vm.loadProject(project)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.png = await controller.probeBounds('Sprite1')

    // 5) switch back to explicit: stale viewBox-only geometry must not leak.
    project = projectWithCostume({
      name: 'wide',
      assetId: explicit.assetId,
      md5ext: explicit.md5ext,
      dataFormat: 'svg',
      rotationCenterX: 75,
      rotationCenterY: 37.5,
    })
    await vm.loadProject(project)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.switchBack = await controller.probeBounds('Sprite1')

    // 6) update: same sprite, new viewBox-only bytes under a fresh asset.
    project = projectWithCostume({
      name: 'button',
      assetId: viewBoxOnly.assetId,
      md5ext: viewBoxOnly.md5ext,
      dataFormat: 'svg',
      rotationCenterX: 46.5,
      rotationCenterY: 20.5,
    })
    await vm.loadProject(project)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.update = await controller.probeBounds('Sprite1')

    // 7) load: fresh default project still reports the stage-spanning sprite box.
    const fresh = createDefaultProject()
    await vm.loadProject(fresh)
    await controller.sync(vm.lightweightSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 800))
    results.load = await controller.probeBounds('Sprite1')

    const check = (bounds: any, expected: { width: number; height: number; left?: number; top?: number }) => {
      if (!bounds) return false
      if (!approx(bounds.width, expected.width) || !approx(bounds.height, expected.height)) return false
      if (expected.left !== undefined && !approx(bounds.left, expected.left)) return false
      if (expected.top !== undefined && !approx(bounds.top, expected.top)) return false
      return true
    }
    const summary = {
      explicit: check(results.explicit, { width: 300, height: 150, left: -75, top: 37.5 }),
      arbitraryCenter: check(results.arbitraryCenter, { width: 300, height: 150, left: -10, top: 10 }),
      viewBoxOnly: check(results.viewBoxOnly, { width: 93, height: 41 }),
      png: check(results.png, { width: 300, height: 150 }),
      switchBack: check(results.switchBack, { width: 300, height: 150, left: -75, top: 37.5 }),
      update: check(results.update, { width: 93, height: 41 }),
      load: typeof (results.load as any)?.width === 'number',
    }
    return { results, summary, pass: Object.values(summary).every(Boolean) }
  } finally {
    controller.dispose()
  }
}
