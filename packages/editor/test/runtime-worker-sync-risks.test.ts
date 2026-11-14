import { afterEach, describe, expect, it } from 'bun:test'
import { RuntimeWorkerController } from '../src/lib/runtime-worker'
import { ScratchCanvasRenderer } from '@hikkaku/vm'

/**
 * runtime-worker-svg-sync-review で報告された重大リスク D/B/H の
 * 修正後テスト。A(stopAll/sync追い越し)は誤診のため製品コードは不変。
 *
 * 修正方針:
 * - D: worker instance世代 + disposeでqueue破棄。in-flight async raster/postは
 *   世代/同一worker照合で破棄し、未transferのImageBitmapはhostがclose。
 * - B: pruneはsnapshotが参照する全keysで行う(hostがkeepKeys送信/workerが
 *   snapshotから導出)。一時失敗は旧保持、削除済は解放。同一keyは新旧順序通り。
 * - H: VM resolveCostumeImageはloading entry+generation(seq)比較で旧結果を破棄。
 *   stale成功imageはclose/revokeし、fresh readyを潰さない。refetch停止なし。
 */

const originalWorker = globalThis.Worker
const originalCreateImageBitmap = (globalThis as any).createImageBitmap

afterEach(() => {
  globalThis.Worker = originalWorker
  if (originalCreateImageBitmap === undefined) delete (globalThis as any).createImageBitmap
  else (globalThis as any).createImageBitmap = originalCreateImageBitmap
})

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: any }) => void) | undefined
  messages: any[] = []
  terminated = false
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: any, _transfer?: any) {
    this.messages.push(message)
  }
  terminate() {
    this.terminated = true
  }
  addEventListener() {}
  removeEventListener() {}
}

function installFakeWorker() {
  FakeWorker.instances = []
  globalThis.Worker = FakeWorker as unknown as typeof Worker
}

function fakeCanvas(offscreen: object = {}) {
  return { width: 480, height: 360, transferControlToOffscreen: () => offscreen }
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function emptySnapshot(marker = 'empty'): any {
  return { marker, project: { targets: [] } }
}

function snapshotWithPngCostume(assetId: string, marker = 'costume'): any {
  return {
    marker,
    project: {
      targets: [
        {
          id: 'sprite1',
          name: 'Sprite1',
          isStage: false,
          currentCostume: 0,
          costumes: [{ name: 'c', assetId, md5ext: `${assetId}.png`, dataFormat: 'png' }],
        },
      ],
    },
  }
}

function rendererSnapshotWithPng(assetId: string): any {
  return {
    project: {
      targets: [
        { id: 's1', name: 'Sprite1', isStage: false, currentCostume: 0, costumes: [{ name: 'c', assetId, md5ext: `${assetId}.png`, dataFormat: 'png' }] },
      ],
    },
    selectedTargetId: '',
    running: false,
    turboMode: false,
  }
}

function fakeBitmap() {
  const bmp: { closed: boolean; close: () => void } = {
    closed: false,
    close() {
      bmp.closed = true
    },
  }
  return bmp
}

describe('A: stopAll と sync 追い越し (host queue の厳密確認・誤診のため不変)', () => {
  it('pending sync がある間 stopAll は即時 post されず queue され、READY 後に sync より後で post される', async () => {
    installFakeWorker()
    const snapshot = emptySnapshot()
    const vm = { exportAssetBytes: () => ({}), loadAsset: async () => undefined, lightweightSnapshot: () => snapshot }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas() as never, snapshot as never)
    // READY 前: applied(0) < latestProject(1) のため queue されるはず。
    controller.stopAll()
    await flush()
    const worker = FakeWorker.instances[0]
    expect(worker.messages.some((m) => m.type === 'init')).toBe(true)
    expect(worker.messages.some((m) => m.type === 'stopAll')).toBe(false)

    worker.onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot, syncId: 1 } })
    await flush()
    const stopAll = worker.messages.find((m) => m.type === 'stopAll')
    expect(stopAll).toBeDefined()
    // queue 実行時に採番されるため READY の syncId より新しい。
    expect(stopAll.syncId).toBeGreaterThan(1)
    expect(worker.messages.findIndex((m) => m.type === 'init')).toBeLessThan(
      worker.messages.findIndex((m) => m.type === 'stopAll'),
    )
    controller.dispose()
  })

  it('sync 直後の stopAll も queue され、到着順は sync -> stopAll になる (追い越しなし)', async () => {
    installFakeWorker()
    const snapshot = emptySnapshot()
    const vm = { exportAssetBytes: () => ({}), loadAsset: async () => undefined, lightweightSnapshot: () => snapshot }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas() as never, snapshot as never)
    await flush()
    const worker = FakeWorker.instances[0]
    worker.onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot, syncId: 1 } })
    await flush()

    const snapshot2 = emptySnapshot('v2')
    const syncPromise = controller.sync(snapshot2 as never)
    // postSync は非同期 rasterize を挟むため、この時点では未 post。
    // stopAll は applied < latestProject により queue されるはず。
    controller.stopAll()
    await flush()
    await syncPromise
    await flush()
    expect(worker.messages.some((m) => m.type === 'sync')).toBe(true)
    expect(worker.messages.some((m) => m.type === 'stopAll')).toBe(false)

    const syncMsg = worker.messages.find((m) => m.type === 'sync')
    worker.onmessage!({ data: { type: 'snapshot', event: 'WORKER_SYNC', snapshot: snapshot2, syncId: syncMsg.syncId } })
    await flush()
    const syncIndex = worker.messages.findIndex((m) => m.type === 'sync')
    const stopIndex = worker.messages.findIndex((m) => m.type === 'stopAll')
    expect(stopIndex).toBeGreaterThan(syncIndex)
    controller.dispose()
  })
})

describe('D: dispose+reattach 旧 command 再生 (修正後: 流入しない)', () => {
  it('READY 前に queue された step は dispose で破棄され新 worker へ再生されない', async () => {
    installFakeWorker()
    const snapshot = emptySnapshot()
    const vm = { exportAssetBytes: () => ({}), loadAsset: async () => undefined, lightweightSnapshot: () => snapshot }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas({}) as never, snapshot as never)
    controller.step()
    await flush()
    const worker1 = FakeWorker.instances[0]
    expect(worker1.messages.some((m) => m.type === 'step')).toBe(false)

    controller.dispose()
    expect(worker1.terminated).toBe(true)
    controller.attachCanvas(fakeCanvas({}) as never, snapshot as never)
    await flush()
    const worker2 = FakeWorker.instances[1]
    expect(worker2).toBeDefined()
    const init2 = worker2.messages.find((m) => m.type === 'init')
    expect(init2).toBeDefined()
    worker2.onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot, syncId: init2.syncId } })
    await flush()
    // 修正後: 旧世代の step は破棄され再生されない。
    expect(worker2.messages.some((m) => m.type === 'step')).toBe(false)
    controller.dispose()
  })

  it('in-flight の旧 sync は dispose+reattach 後の新 worker へ post されない (fake delay)', async () => {
    installFakeWorker()
    let releaseStale!: (value: Uint8Array | undefined) => void
    const staleGate = new Promise<Uint8Array | undefined>((resolve) => {
      releaseStale = resolve
    })
    const empty = emptySnapshot('empty')
    const staleSnapshot = snapshotWithPngCostume('stale-png', 'stale')
    const vm = {
      exportAssetBytes: () => ({}),
      loadAsset: (assetId: string) => (String(assetId).startsWith('stale-png') ? staleGate : Promise.resolve(undefined)),
      lightweightSnapshot: () => empty,
    }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    FakeWorker.instances[0].onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot: empty, syncId: 1 } })
    await flush()

    const pendingSync = controller.sync(staleSnapshot as never)
    await flush(5)
    expect(FakeWorker.instances[0].messages.some((m) => m.type === 'sync')).toBe(false)

    controller.dispose()
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    const worker2 = FakeWorker.instances[1]
    releaseStale(undefined)
    await pendingSync
    await flush()
    const stalePosts = worker2.messages.filter((m) => m.type === 'sync' && m.snapshot?.marker === 'stale')
    // 修正後: 旧 snapshot の sync は新 worker に届かない。
    expect(stalePosts.length).toBe(0)
    controller.dispose()
  })

  it('dispose で破棄された旧 async raster の ImageBitmap は close され、新 worker へ transfer されない', async () => {
    installFakeWorker()
    const created: { closed: boolean; close: () => void }[] = []
    ;(globalThis as any).createImageBitmap = async () => {
      const bmp = fakeBitmap()
      created.push(bmp)
      return bmp as never
    }
    let releaseGate!: (value: Uint8Array | undefined) => void
    const gate = new Promise<Uint8Array | undefined>((resolve) => {
      releaseGate = resolve
    })
    const empty = emptySnapshot('empty')
    const staleSnapshot = snapshotWithPngCostume('stale-close', 'stale')
    const vm = {
      exportAssetBytes: () => ({}),
      loadAsset: () => gate,
      lightweightSnapshot: () => empty,
    }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    FakeWorker.instances[0].onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot: empty, syncId: 1 } })
    await flush()

    const pendingSync = controller.sync(staleSnapshot as never)
    await flush(5)
    controller.dispose()
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    // gate を開けて旧 raster を完了させる。旧世代なので post されず close される。
    releaseGate(new Uint8Array([137, 80, 78, 71]))
    await pendingSync
    await flush()
    const worker2 = FakeWorker.instances[1]
    expect(worker2.messages.filter((m) => m.type === 'sync' && m.snapshot?.marker === 'stale').length).toBe(0)
    expect(created.length).toBeGreaterThan(0)
    for (const bmp of created) expect(bmp.closed).toBe(true)
    controller.dispose()
  })

  it('dispose/restart 後も新 sync は新 worker へ正常 post される (transfer 済は close しない)', async () => {
    installFakeWorker()
    const created: { closed: boolean; close: () => void }[] = []
    ;(globalThis as any).createImageBitmap = async () => {
      const bmp = fakeBitmap()
      created.push(bmp)
      return bmp as never
    }
    const empty = emptySnapshot('empty')
    const nextSnapshot = snapshotWithPngCostume('fresh-png', 'fresh')
    const vm = {
      exportAssetBytes: () => ({}),
      loadAsset: async () => new Uint8Array([137, 80, 78, 71]),
      lightweightSnapshot: () => empty,
    }
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    controller.dispose()
    controller.attachCanvas(fakeCanvas({}) as never, empty as never)
    await flush()
    const worker2 = FakeWorker.instances[1]
    const init2 = worker2.messages.find((m) => m.type === 'init')
    expect(init2).toBeDefined()
    worker2.onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot: empty, syncId: init2.syncId } })
    await flush()
    await controller.sync(nextSnapshot as never)
    await flush()
    const syncMsg = worker2.messages.find((m) => m.type === 'sync' && m.snapshot?.marker === 'fresh')
    expect(syncMsg).toBeDefined()
    // host が keepKeys(参照全keys)を送る。
    expect(new Set(syncMsg.keepKeys)).toContain('fresh-png.png:png')
    // transfer 済の bitmap を host が close してはならない。
    for (const bmp of created) expect(bmp.closed).toBe(false)
    controller.dispose()
  })
})

describe('B: rasterization 失敗時 prune (修正後: 一時失敗は旧保持・削除済は解放)', () => {
  it('snapshot参照keepでのpruneは旧cacheを保持し、参照外の削除済のみcloseする', async () => {
    const renderer = new ScratchCanvasRenderer()
    const good = fakeBitmap()
    renderer.cacheCostumeImage('good.png', 'png', good as never)
    // 一時失敗 sync: images=[] でも snapshot参照keepに含まれるため保持される。
    renderer.pruneCostumeImages(['good.png:png'])
    expect(good.closed).toBe(false)

    // 削除済: snapshotから消えた key は解放される。
    renderer.pruneCostumeImages([])
    expect(good.closed).toBe(true)
  })

  it('同一key更新は新旧順序通り(新が勝ち・旧は解放)', async () => {
    const renderer = new ScratchCanvasRenderer()
    const old = fakeBitmap()
    renderer.cacheCostumeImage('same.png', 'png', old as never)
    const next = fakeBitmap()
    renderer.cacheCostumeImage('same.png', 'png', next as never)
    expect(old.closed).toBe(true)
    expect(next.closed).toBe(false)
    renderer.pruneCostumeImages(['same.png:png'])
    expect(next.closed).toBe(false)
    renderer.pruneCostumeImages([])
    expect(next.closed).toBe(true)
  })

  it('host sync は成功分のみimages・参照全keysをkeepKeysで送る (PNG+SVG混在)', async () => {
    installFakeWorker()
    ;(globalThis as any).createImageBitmap = async () => fakeBitmap() as never
    const snapshot: any = {
      marker: 'mixed',
      project: {
        targets: [
          {
            id: 's1',
            name: 'Sprite1',
            isStage: false,
            currentCostume: 0,
            costumes: [
              { name: 'ok', assetId: 'ok-png', md5ext: 'ok-png.png', dataFormat: 'png' },
              { name: 'ng', assetId: 'ng-png', md5ext: 'ng-png.png', dataFormat: 'png' },
              { name: 'svg', assetId: 'safe-svg', md5ext: 'safe-svg.svg', dataFormat: 'svg' },
            ],
          },
        ],
      },
    }
    const vm = {
      exportAssetBytes: () => ({}),
      loadAsset: async (assetId: string) =>
        String(assetId).startsWith('ok-png') ? new Uint8Array([137, 80, 78, 71]) : undefined,
      lightweightSnapshot: () => emptySnapshot(),
    }
    // svg raster は document を要するため loadAsset を png のみ成功させ、
    // svg は失敗扱い(=imagesから除外・keepKeysには残る)で検証する。
    const controller = new RuntimeWorkerController(vm as never, () => {})
    controller.attachCanvas(fakeCanvas({}) as never, emptySnapshot() as never)
    await flush()
    FakeWorker.instances[0].onmessage!({ data: { type: 'snapshot', event: 'WORKER_READY', snapshot: emptySnapshot(), syncId: 1 } })
    await flush()
    await controller.sync(snapshot as never)
    await flush()
    const syncMsg = FakeWorker.instances[0].messages.find((m) => m.type === 'sync' && m.snapshot?.marker === 'mixed')
    expect(syncMsg).toBeDefined()
    const imageKeys = new Set((syncMsg.images ?? []).map((i: any) => `${i.assetId}:${i.dataFormat}`))
    expect(imageKeys.has('ok-png.png:png')).toBe(true)
    expect(imageKeys.has('ng-png.png:png')).toBe(false)
    // 失敗分も snapshot参照として keep される = worker側pruneで旧保持される。
    expect(new Set(syncMsg.keepKeys)).toEqual(new Set(['ok-png.png:png', 'ng-png.png:png', 'safe-svg.svg:svg']))
    controller.dispose()
  })
})

describe('H: 非同期 assetResolver 旧結果 (修正後: generation比較で破棄)', () => {
  it('旧fetchの遅延結果はfresh readyを潰さず、freshは保持・再fetch不要', async () => {
    const renderer = new ScratchCanvasRenderer()
    let resolveOld!: (value: Uint8Array | undefined) => void
    const oldGate = new Promise<Uint8Array | undefined>((resolve) => {
      resolveOld = resolve
    })
    let resolverCalls = 0
    renderer.setAssetResolver(async () => {
      resolverCalls++
      return oldGate
    })
    const snap = rendererSnapshotWithPng('k')
    renderer.requestDraw(snap as never)
    await flush(5)
    expect(resolverCalls).toBe(1)

    // 新世代が先に fresh を seed (sync の cacheCostumeImage 経路と等価)。
    const fresh = fakeBitmap()
    renderer.cacheCostumeImage('k.png', 'png', fresh as never)

    // 旧 fetch が遅れて stale(undefined) で解決 -> 破棄される。
    resolveOld(undefined)
    await flush()

    // fresh は保持されたまま (leak ではなく到達可能)。
    expect(fresh.closed).toBe(false)

    // 未来の render: ready hit のため refetch されない。
    renderer.requestDraw(snap as never)
    await flush()
    expect(resolverCalls).toBe(1)

    // 保持の証明: 参照keepでは残り、参照外pruneで初めて解放される。
    renderer.pruneCostumeImages(['k.png:png'])
    expect(fresh.closed).toBe(false)
    renderer.pruneCostumeImages([])
    expect(fresh.closed).toBe(true)
  })

  it('旧fetchの遅延成功bitmapは破棄(close)されfreshを潰さない (leakなし)', async () => {
    const renderer = new ScratchCanvasRenderer()
    const staleBitmaps: { closed: boolean; close: () => void }[] = []
    let releaseCib!: (bmp: unknown) => void
    const cibGate = new Promise<unknown>((resolve) => {
      releaseCib = resolve
    })
    ;(globalThis as any).createImageBitmap = () => cibGate as never
    let resolveOld!: (value: Uint8Array | undefined) => void
    const oldGate = new Promise<Uint8Array | undefined>((resolve) => {
      resolveOld = resolve
    })
    renderer.setAssetResolver(async () => oldGate)
    const snap = rendererSnapshotWithPng('leak')
    renderer.requestDraw(snap as never)
    await flush(5)
    // 旧fetchがbytes成功まで進み、createImageBitmap待ちの間にfreshをseed。
    resolveOld(new Uint8Array([137, 80, 78, 71]))
    await flush(5)
    const fresh = fakeBitmap()
    renderer.cacheCostumeImage('leak.png', 'png', fresh as never)
    // 遅延生成されたstale bitmapはinner guardで破棄(close)される。
    const stale = fakeBitmap()
    staleBitmaps.push(stale)
    releaseCib(stale as never)
    await flush()
    expect(fresh.closed).toBe(false)
    expect(stale.closed).toBe(true)
    renderer.pruneCostumeImages([])
    expect(fresh.closed).toBe(true)
  })

  it('複数rendererは分離され、同一md5・SVG/PNGはdataFormatで分離される', async () => {
    const a = new ScratchCanvasRenderer()
    const b = new ScratchCanvasRenderer()
    const aImg = fakeBitmap()
    const bImg = fakeBitmap()
    a.cacheCostumeImage('same.png', 'png', aImg as never)
    b.cacheCostumeImage('same.png', 'png', bImg as never)
    a.pruneCostumeImages([])
    expect(aImg.closed).toBe(true)
    expect(bImg.closed).toBe(false)
    // 同一assetIdでもsvg/pngは別key。
    const svg = fakeBitmap()
    const png = fakeBitmap()
    b.cacheCostumeImage('same', 'svg', svg as never)
    b.cacheCostumeImage('same', 'png', png as never)
    b.pruneCostumeImages(['same:svg'])
    expect(svg.closed).toBe(false)
    expect(png.closed).toBe(true)
    b.pruneCostumeImages([])
    expect(svg.closed).toBe(true)
  })
})
