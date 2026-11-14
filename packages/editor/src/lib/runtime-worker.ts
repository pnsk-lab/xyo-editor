import type { RuntimeSnapshot, ScratchBounds, ScratchCostume, ScratchSound } from '@hikkaku/vm'
import { parseSvgRootGeometryBytes, sanitizeSvgByteStream } from '@hikkaku/vm'
import type { RuntimeVM } from './runtime-backends'

type RuntimeWorkerEvent =
  | { type: 'snapshot'; event: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundPlayed'; targetName: string; sound: ScratchSound; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundsStopped'; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'visualReport'; id: string; value: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'question'; payload: { question?: string | null; answer?: string }; syncId: number; resetId: number }
  | { type: 'probeSvgResult'; bounds: ScratchBounds | null; targetName: string; syncId?: number }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }

type SnapshotHandler = (snapshot: RuntimeSnapshot, event: string) => void
type SoundHandler = (targetName: string, sound: ScratchSound, snapshot: RuntimeSnapshot) => void
type VisualReportHandler = (id: string, value: string, snapshot: RuntimeSnapshot) => void
type WorkerCostumeImage = { assetId: string; dataFormat: string; image: ImageBitmap; svgSize?: [number, number] | null }

const RUNTIME_WORKER_ENABLED = true

export class RuntimeWorkerController {
  private worker?: Worker
  private transferredCanvas?: HTMLCanvasElement
  private initialized = false
  private latestSyncId = 0
  private latestProjectSyncId = 0
  private appliedProjectSyncId = 0
  private questionFence = 0
  private initPosted?: Promise<void>
  private queuedRuntimeCommands: Array<() => void> = []
  /** Worker instance generation. Bumped on every new worker/dispose so
   *  pre-dispose queues and in-flight async raster posts cannot flow into
   *  a re-attached new worker. */
  private workerGeneration = 0

  constructor(
    private readonly vm: RuntimeVM,
    private readonly onSnapshot: SnapshotHandler,
    private readonly onError: (message: string) => void = () => {},
    private readonly onSoundPlayed: SoundHandler = () => {},
    private readonly onSoundsStopped: (snapshot: RuntimeSnapshot) => void = () => {},
    private readonly onVisualReport: VisualReportHandler = () => {},
    private readonly onFps: (fps: number) => void = () => {},
    private readonly supported = true,
    private readonly onQuestion: (payload: { question?: string | null; answer?: string }) => void = () => {},
  ) {}

  attachCanvas(canvas: HTMLCanvasElement, snapshot: RuntimeSnapshot): boolean {
    if (!RUNTIME_WORKER_ENABLED || !this.supported) return false
    if (this.transferredCanvas === canvas) return this.initialized
    if (!('transferControlToOffscreen' in canvas)) return false
    if (this.initialized) {
      const offscreen = canvas.transferControlToOffscreen()
      this.transferredCanvas = canvas
      const worker = this.worker
      const generation = this.workerGeneration
      // Init rasterizes images asynchronously, so enqueue the replacement after init.
      void this.initPosted?.then(() => {
        if (this.worker === worker && this.workerGeneration === generation) worker?.postMessage({ type: 'attachCanvas', canvas: offscreen }, [offscreen])
      })
      return true
    }
    this.workerGeneration += 1
    const generation = this.workerGeneration
    this.worker = new Worker(new URL('./runtime.worker.ts', import.meta.url), { type: 'module' })
    const attachedWorker = this.worker
    this.worker.onmessage = (event: MessageEvent<RuntimeWorkerEvent>) => {
      if (this.worker !== attachedWorker || this.workerGeneration !== generation) return
      const message = event.data
      const syncId = 'syncId' in message ? message.syncId : undefined
      if (message.type === 'snapshot') {
        const isProjectSyncEvent = message.event === 'WORKER_READY' || message.event === 'WORKER_SYNC'
        if (isProjectSyncEvent) {
          if (syncId !== undefined && syncId < this.latestProjectSyncId) return
          if (syncId !== undefined) this.appliedProjectSyncId = Math.max(this.appliedProjectSyncId, syncId)
          this.flushRuntimeCommands()
        }
        else if (syncId !== undefined && syncId < this.appliedProjectSyncId) return
        this.onSnapshot(message.snapshot, message.event)
      }
      else if (message.type === 'soundPlayed') this.onSoundPlayed(message.targetName, message.sound, message.snapshot)
      else if (message.type === 'soundsStopped') this.onSoundsStopped(message.snapshot)
      else if (message.type === 'visualReport') this.onVisualReport(message.id, message.value, message.snapshot)
      else if (message.type === 'question') {
        if (message.resetId < this.questionFence || message.syncId < Math.max(this.latestProjectSyncId, this.appliedProjectSyncId)) return
        this.onQuestion(message.payload)
      }
      else if (message.type === 'fps') this.onFps(message.fps)
      else if (message.type === 'error') this.onError(message.message)
    }
    const offscreen = canvas.transferControlToOffscreen()
    const syncId = ++this.latestSyncId
    this.latestProjectSyncId = syncId
    this.initPosted = this.postInit(offscreen, snapshot, syncId)
    this.transferredCanvas = canvas
    this.initialized = true
    this.resize(canvas.width, canvas.height)
    return true
  }

  async sync(snapshot: RuntimeSnapshot): Promise<void> {
    if (!this.worker) return
    const syncId = ++this.latestSyncId
    this.latestProjectSyncId = syncId
    await this.postSync(snapshot, syncId)
  }

  resize(width: number, height: number): void {
    this.worker?.postMessage({ type: 'resize', width, height })
  }

  greenFlag(): void {
    const syncId = ++this.latestSyncId
    this.questionFence = syncId
    // Attach the latest host project (+ asset bytes) so a block/costume/
    // target edit followed by flag with no intermediate sync still runs the
    // NEW project on the worker. Captured synchronously: the async raster
    // below must not observe a newer project than the flag click.
    const snapshot = this.vm.snapshot()
    const assets = this.vm.exportAssetBytes()
    this.postGreenFlag(snapshot, assets, syncId)
  }

  stopAll(): void {
    this.questionFence = this.latestSyncId + 1
    this.postRuntimeCommand({ type: 'stopAll' })
  }

  step(): void {
    this.postRuntimeCommand({ type: 'step' })
  }

  toggleScript(topBlockId: string, targetId: string): void {
    this.postRuntimeCommand({ type: 'toggleScript', topBlockId, targetId })
  }

  reportBlockValue(blockId: string, targetId: string): void {
    this.postRuntimeCommand({ type: 'reportBlockValue', blockId, targetId })
  }

  setTurboMode(enabled: boolean): void {
    this.postRuntimeCommand({ type: 'setTurboMode', enabled })
  }

  answerPrompt(value: string): void {
    this.postRuntimeCommand({ type: 'answerPrompt', value })
  }

  postMouse(data: unknown): void {
    this.postRuntimeCommand({ type: 'postMouse', data })
  }

  postKeyboard(data: unknown): void {
    this.postRuntimeCommand({ type: 'postKeyboard', data })
  }

  startDrag(targetId: string): void {
    this.postRuntimeCommand({ type: 'startDrag', targetId })
  }

  stopDrag(targetId?: string): void {
    this.postRuntimeCommand({ type: 'stopDrag', targetId })
  }

  postSpriteInfo(data: unknown): void {
    this.postRuntimeCommand({ type: 'postSpriteInfo', data })
  }

  probeBounds(targetName = 'Sprite1'): Promise<ScratchBounds | null> {
    const worker = this.worker
    if (!worker) return Promise.resolve(null)
    const syncId = ++this.latestSyncId
    return new Promise((resolve) => {
      const handler = (event: MessageEvent<RuntimeWorkerEvent>) => {
        const message = event.data
        if (message?.type === 'probeSvgResult' && message.syncId === syncId) {
          worker.removeEventListener('message', handler as EventListener)
          resolve(message.bounds)
        }
      }
      worker.addEventListener('message', handler as EventListener)
      worker.postMessage({ type: 'probeSvg', targetName, syncId })
      setTimeout(() => {
        worker.removeEventListener('message', handler as EventListener)
        resolve(null)
      }, 5000)
    })
  }

  dispose(): void {
    // Invalidate every in-flight async raster/post and drop pre-dispose
    // queues so they can never replay on a re-attached new worker.
    // Queued ImageBitmaps that never transfer must be closed by the
    // stale-path guards (postInit/postSync/postRuntimeCommandWithImages).
    this.workerGeneration += 1
    this.queuedRuntimeCommands = []
    this.worker?.postMessage({ type: 'dispose' })
    this.worker?.terminate()
    this.worker = undefined
    this.initialized = false
    this.initPosted = undefined
  }

  private async rasterizeCostumes(snapshot: RuntimeSnapshot): Promise<WorkerCostumeImage[]> {
    const costumes = snapshot.project.targets.flatMap((target) => target.costumes)
    const unique = new Map<string, { costume: ScratchCostume; dataFormat: string; assetId: string }>()
    for (const costume of costumes) {
      const dataFormat = costume.dataFormat ?? md5extFormat(costume.md5ext)
      const assetId = costume.md5ext ?? costume.assetId
      if (assetId && isImageFormat(dataFormat)) unique.set(`${assetId}:${dataFormat}`, { costume, dataFormat, assetId })
    }
    const images = await Promise.all([...unique.values()].map(async (item) => {
      try {
        return await this.rasterizeCostume(item.costume, item.assetId, item.dataFormat)
      } catch {
        return undefined
      }
    }))
    return images.filter((image): image is WorkerCostumeImage => image !== undefined)
  }

  private async postInit(offscreen: OffscreenCanvas, snapshot: RuntimeSnapshot, syncId: number): Promise<void> {
    const worker = this.worker
    const generation = this.workerGeneration
    const images = await this.rasterizeCostumes(snapshot)
    if (this.worker !== worker || this.workerGeneration !== generation) {
      closeWorkerImages(images)
      return
    }
    const keepKeys = collectCostumeImageKeys(snapshot)
    this.worker?.postMessage(
      { type: 'init', canvas: offscreen, snapshot, assets: this.vm.exportAssetBytes(), images, keepKeys, syncId },
      [offscreen, ...transferImages(images)],
    )
  }

  private async postSync(snapshot: RuntimeSnapshot, syncId: number): Promise<void> {
    const worker = this.worker
    const generation = this.workerGeneration
    await this.initPosted
    if (this.worker !== worker || this.workerGeneration !== generation) return
    const images = await this.rasterizeCostumes(snapshot)
    if (this.worker !== worker || this.workerGeneration !== generation) {
      closeWorkerImages(images)
      return
    }
    const keepKeys = collectCostumeImageKeys(snapshot)
    this.worker?.postMessage(
      { type: 'sync', snapshot, assets: this.vm.exportAssetBytes(), images, keepKeys, syncId },
      transferImages(images),
    )
  }

  private async rasterizeCostume(costume: ScratchCostume, assetId: string, dataFormat: string): Promise<WorkerCostumeImage | undefined> {
    const bytes = await this.vm.loadAsset(assetId, dataFormat)
    if (!bytes) return undefined
    if (dataFormat !== 'svg') {
      const blobBytes = new Uint8Array(bytes.length)
      blobBytes.set(bytes)
      const type = dataFormat === 'jpg' || dataFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
      return { assetId, dataFormat, image: await createImageBitmap(new Blob([blobBytes], { type })) }
    }
    // Sanitize first (parser-based, DOM-free): the bytes we display must
    // never carry external URLs / image-set fetches, and the authoritative
    // geometry must come from the SAME sanitized bytes the worker will trust.
    // rotationCenter is an offset only and is never used for size estimation.
    let sanitizedBytes: Uint8Array
    try {
      sanitizedBytes = sanitizeSvgByteStream(bytes)
    } catch {
      return undefined
    }
    let svgSize: [number, number] | null = null
    try {
      svgSize = parseSvgRootGeometryBytes(sanitizedBytes).textureSize
    } catch {
      svgSize = null
    }
    if (svgSize && !(Number.isFinite(svgSize[0]) && Number.isFinite(svgSize[1]) && svgSize[0] > 0 && svgSize[1] > 0)) {
      svgSize = null
    }
    const svg = new TextDecoder().decode(sanitizedBytes)
    const image = await loadSvgImage(svg)
    const naturalWidth = Number(image.naturalWidth) || 0
    const naturalHeight = Number(image.naturalHeight) || 0
    const width = Math.max(1, Math.ceil((svgSize?.[0] ?? naturalWidth) || 96))
    const height = Math.max(1, Math.ceil((svgSize?.[1] ?? naturalHeight) || 96))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height)
    return { assetId, dataFormat, image: await createImageBitmap(canvas), svgSize }
  }

  private postRuntimeCommand(command: Record<string, unknown>): void {
    const generation = this.workerGeneration
    const post = () => {
      if (this.workerGeneration !== generation) return
      this.worker?.postMessage({ ...command, syncId: ++this.latestSyncId })
    }
    if (this.appliedProjectSyncId < this.latestProjectSyncId) this.queuedRuntimeCommands.push(post)
    else post()
  }

  private postGreenFlag(snapshot: RuntimeSnapshot, assets: Record<string, Uint8Array>, syncId: number): void {
    const worker = this.worker
    const generation = this.workerGeneration
    const keepKeys = collectCostumeImageKeys(snapshot)
    const post = () => {
      if (this.worker !== worker || this.workerGeneration !== generation) return
      void this.rasterizeCostumes(snapshot).then((images) => {
        if (this.worker !== worker || this.workerGeneration !== generation) {
          closeWorkerImages(images)
          return
        }
        // Queued behind pending project syncs (appliedProjectSyncId gate):
        // syncId ordering on the worker drops stale flag payloads, so the
        // newest flag wins and a stop/dispose in between is never replayed
        // onto a re-attached worker (generation-guarded above).
        this.worker?.postMessage(
          { type: 'greenFlag', snapshot, assets, images, keepKeys, syncId },
          transferImages(images),
        )
      })
    }
    if (this.appliedProjectSyncId < this.latestProjectSyncId) this.queuedRuntimeCommands.push(post)
    else post()
  }

  private flushRuntimeCommands(): void {
    if (this.appliedProjectSyncId < this.latestProjectSyncId) return
    const commands = this.queuedRuntimeCommands.splice(0)
    for (const command of commands) command()
  }
}

function transferImages(images: WorkerCostumeImage[]): ImageBitmap[] {
  return images.map((item) => item.image)
}

function closeWorkerImages(images: WorkerCostumeImage[]): void {
  for (const item of images) {
    try {
      item?.image?.close?.()
    } catch {
      // never-transfered bitmap cleanup must not throw
    }
  }
}

/** All image keys referenced by a snapshot, independent of raster success.
 *  Worker prune must use this (not just successfully rasterized images)
 *  so a transient failure keeps the old cache instead of evicting it,
 *  while genuinely removed costumes are still released. */
function collectCostumeImageKeys(snapshot: RuntimeSnapshot): string[] {
  const keys = new Set<string>()
  const targets = (snapshot as { project?: { targets?: Array<{ costumes?: ScratchCostume[] }> } })?.project?.targets ?? []
  for (const target of targets) {
    for (const costume of target?.costumes ?? []) {
      const dataFormat = costume.dataFormat ?? md5extFormat(costume.md5ext)
      const assetId = costume.md5ext ?? costume.assetId
      if (assetId && isImageFormat(dataFormat)) keys.add(`${assetId}:${dataFormat}`)
    }
  }
  return [...keys]
}

function md5extFormat(md5ext?: string): string {
  return md5ext?.split('.').pop()?.toLowerCase() ?? ''
}

function isImageFormat(dataFormat: string): boolean {
  return dataFormat === 'svg' || dataFormat === 'png' || dataFormat === 'jpg' || dataFormat === 'jpeg'
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to decode SVG costume'))
    }
    image.src = url
  })
}
