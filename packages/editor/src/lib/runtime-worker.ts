import type { RuntimeSnapshot, ScratchCostume, ScratchSound, ScratchVM } from '@hikkaku/vm'

type RuntimeWorkerEvent =
  | { type: 'snapshot'; event: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundPlayed'; targetName: string; sound: ScratchSound; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundsStopped'; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'visualReport'; id: string; value: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }

type SnapshotHandler = (snapshot: RuntimeSnapshot, event: string) => void
type SoundHandler = (targetName: string, sound: ScratchSound, snapshot: RuntimeSnapshot) => void
type VisualReportHandler = (id: string, value: string, snapshot: RuntimeSnapshot) => void
type WorkerCostumeImage = { assetId: string; dataFormat: string; image: ImageBitmap }

const RUNTIME_WORKER_ENABLED = true

export class RuntimeWorkerController {
  private worker?: Worker
  private transferredCanvas?: HTMLCanvasElement
  private initialized = false
  private latestSyncId = 0
  private latestProjectSyncId = 0
  private appliedProjectSyncId = 0
  private queuedRuntimeCommands: Array<() => void> = []

  constructor(
    private readonly vm: ScratchVM,
    private readonly onSnapshot: SnapshotHandler,
    private readonly onError: (message: string) => void = () => {},
    private readonly onSoundPlayed: SoundHandler = () => {},
    private readonly onSoundsStopped: (snapshot: RuntimeSnapshot) => void = () => {},
    private readonly onVisualReport: VisualReportHandler = () => {},
    private readonly onFps: (fps: number) => void = () => {},
  ) {}

  attachCanvas(canvas: HTMLCanvasElement, snapshot: RuntimeSnapshot): boolean {
    if (!RUNTIME_WORKER_ENABLED) return false
    if (this.initialized || this.transferredCanvas === canvas) return this.initialized
    if (!('transferControlToOffscreen' in canvas)) return false
    this.worker = new Worker(new URL('./runtime.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<RuntimeWorkerEvent>) => {
      const message = event.data
      const syncId = 'syncId' in message ? message.syncId : undefined
      if (syncId !== undefined && syncId < this.latestSyncId) return
      if (message.type === 'snapshot') {
        if ((message.event === 'WORKER_READY' || message.event === 'WORKER_SYNC') && syncId !== undefined) {
          this.appliedProjectSyncId = Math.max(this.appliedProjectSyncId, syncId)
          this.flushRuntimeCommands()
        }
        this.onSnapshot(message.snapshot, message.event)
      }
      else if (message.type === 'soundPlayed') this.onSoundPlayed(message.targetName, message.sound, message.snapshot)
      else if (message.type === 'soundsStopped') this.onSoundsStopped(message.snapshot)
      else if (message.type === 'visualReport') this.onVisualReport(message.id, message.value, message.snapshot)
      else if (message.type === 'fps') this.onFps(message.fps)
      else if (message.type === 'error') this.onError(message.message)
    }
    const offscreen = canvas.transferControlToOffscreen()
    const syncId = ++this.latestSyncId
    this.latestProjectSyncId = syncId
    this.worker.postMessage({ type: 'init', canvas: offscreen, snapshot, assets: this.vm.exportAssetBytes(), syncId }, [offscreen])
    void this.sync(snapshot)
    this.transferredCanvas = canvas
    this.initialized = true
    this.resize(canvas.width, canvas.height)
    return true
  }

  async sync(snapshot: RuntimeSnapshot): Promise<void> {
    if (!this.worker) return
    const syncId = ++this.latestSyncId
    this.latestProjectSyncId = syncId
    this.worker.postMessage({ type: 'sync', snapshot, assets: this.vm.exportAssetBytes(), syncId })
    void this.rasterizeCostumes(snapshot).then((images) => {
      this.worker?.postMessage(
        { type: 'cacheImages', images, syncId },
        images.map((item) => item.image),
      )
    })
  }

  resize(width: number, height: number): void {
    this.worker?.postMessage({ type: 'resize', width, height })
  }

  greenFlag(): void {
    this.postRuntimeCommand({ type: 'greenFlag' })
  }

  stopAll(): void {
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

  dispose(): void {
    this.worker?.postMessage({ type: 'dispose' })
    this.worker?.terminate()
    this.worker = undefined
    this.initialized = false
  }

  private async rasterizeCostumes(snapshot: RuntimeSnapshot): Promise<WorkerCostumeImage[]> {
    const costumes = snapshot.project.targets.flatMap((target) => target.costumes)
    const unique = new Map<string, { costume: ScratchCostume; dataFormat: string; assetId: string }>()
    for (const costume of costumes) {
      const dataFormat = costume.dataFormat ?? md5extFormat(costume.md5ext)
      const assetId = costume.md5ext ?? costume.assetId
      if (assetId && isImageFormat(dataFormat)) unique.set(`${assetId}:${dataFormat}`, { costume, dataFormat, assetId })
    }
    const images = await Promise.all([...unique.values()].map((item) => this.rasterizeCostume(item.costume, item.assetId, item.dataFormat)))
    return images.filter((image): image is WorkerCostumeImage => image !== undefined)
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
    const svg = new TextDecoder().decode(bytes)
    const image = await loadSvgImage(svg)
    const width = Math.max(1, Math.ceil(image.naturalWidth || Number(costume.rotationCenterX) * 2 || 96))
    const height = Math.max(1, Math.ceil(image.naturalHeight || Number(costume.rotationCenterY) * 2 || 96))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height)
    return { assetId, dataFormat, image: await createImageBitmap(canvas) }
  }

  private postRuntimeCommand(command: Record<string, unknown>): void {
    const post = () => {
      this.worker?.postMessage({ ...command, syncId: ++this.latestSyncId })
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
