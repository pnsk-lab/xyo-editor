import {
  ScratchCanvasRenderer,
  ScratchVM,
  type RuntimeSnapshot,
  type ScratchSound,
} from '@hikkaku/vm'

type RuntimeWorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas; snapshot: RuntimeSnapshot; assets: Record<string, Uint8Array>; images?: WorkerCostumeImage[]; syncId: number }
  | { type: 'sync'; snapshot: RuntimeSnapshot; assets: Record<string, Uint8Array>; images?: WorkerCostumeImage[]; syncId: number }
  | { type: 'cacheImages'; images?: WorkerCostumeImage[]; syncId?: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'greenFlag'; syncId?: number }
  | { type: 'stopAll'; syncId?: number }
  | { type: 'step'; syncId?: number }
  | { type: 'toggleScript'; topBlockId: string; targetId: string; syncId?: number }
  | { type: 'reportBlockValue'; blockId: string; targetId: string; syncId?: number }
  | { type: 'setTurboMode'; enabled: boolean; syncId?: number }
  | { type: 'postMouse'; data: unknown; syncId?: number }
  | { type: 'postKeyboard'; data: unknown; syncId?: number }
  | { type: 'startDrag'; targetId: string; syncId?: number }
  | { type: 'stopDrag'; targetId?: string; syncId?: number }
  | { type: 'postSpriteInfo'; data: unknown; syncId?: number }
  | { type: 'dispose' }

type RuntimeWorkerEvent =
  | { type: 'snapshot'; event: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundPlayed'; targetName: string; sound: ScratchSound; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'soundsStopped'; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'visualReport'; id: string; value: string; snapshot: RuntimeSnapshot; syncId?: number }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }

type WorkerCostumeImage = {
  assetId: string
  dataFormat: string
  image: ImageBitmap
}

const vm = new ScratchVM()
const renderer = new ScratchCanvasRenderer()
let frameTimer: ReturnType<typeof setInterval> | undefined
let lastRuntimeStepPost = 0
let applyingHostSnapshot = false
let latestHostSyncId = 0
const runtimeStepPostInterval = 1000
let frameCount = 0
let fpsWindowStart = performance.now()

const resetFps = () => {
  frameCount = 0
  fpsWindowStart = performance.now()
  self.postMessage({ type: 'fps', fps: 0 } satisfies RuntimeWorkerEvent)
}

const countFrame = () => {
  frameCount += 1
  const now = performance.now()
  if (now - fpsWindowStart < 500) return
  const fps = Math.round((frameCount * 1000) / (now - fpsWindowStart))
  frameCount = 0
  fpsWindowStart = now
  self.postMessage({ type: 'fps', fps } satisfies RuntimeWorkerEvent)
}

const postRuntimeSnapshot = (event: string, syncId = latestHostSyncId) => {
  const message: RuntimeWorkerEvent = { type: 'snapshot', event, snapshot: vm.snapshot(), syncId }
  self.postMessage(message)
}

const beginFrameTimer = () => {
  if (frameTimer) return
  frameTimer = setInterval(() => {
    if (vm.isRunning()) vm.step()
  }, 1000 / 30)
}

const stopFrameTimer = () => {
  if (!frameTimer) return
  clearInterval(frameTimer)
  frameTimer = undefined
  resetFps()
}

for (const event of ['PROJECT_LOADED', 'PROJECT_CHANGED', 'TARGETS_UPDATE', 'WORKSPACE_UPDATE', 'BLOCKS_NEED_UPDATE', 'RUNTIME_STEP', 'PROJECT_RUN_START', 'PROJECT_RUN_STOP'] as const) {
  vm.on<RuntimeSnapshot>(event, (snapshot) => {
    if (applyingHostSnapshot) return
    if (event === 'RUNTIME_STEP' && snapshot.running) {
      countFrame()
      const now = performance.now()
      if (now - lastRuntimeStepPost < runtimeStepPostInterval) return
      lastRuntimeStepPost = now
    } else if (event === 'PROJECT_RUN_START' || event === 'PROJECT_RUN_STOP') {
      lastRuntimeStepPost = 0
    }
    const message: RuntimeWorkerEvent = { type: 'snapshot', event, snapshot, syncId: latestHostSyncId }
    self.postMessage(message)
    if (event === 'PROJECT_RUN_START') beginFrameTimer()
    if (event === 'PROJECT_RUN_STOP' && !snapshot.running) stopFrameTimer()
  })
}

vm.on<{ targetName: string; sound: ScratchSound }>('SOUND_PLAYED', ({ targetName, sound }) => {
  const message: RuntimeWorkerEvent = { type: 'soundPlayed', targetName, sound, snapshot: vm.snapshot(), syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.on<RuntimeSnapshot>('SOUNDS_STOPPED', (snapshot) => {
  const message: RuntimeWorkerEvent = { type: 'soundsStopped', snapshot, syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.on<{ id: string; value: string }>('VISUAL_REPORT', ({ id, value }) => {
  const message: RuntimeWorkerEvent = { type: 'visualReport', id, value, snapshot: vm.snapshot(), syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.attachRenderer(renderer)

self.onmessage = async (event: MessageEvent<RuntimeWorkerCommand>) => {
  const command = event.data
  try {
    if (command.type === 'sync' && command.syncId < latestHostSyncId) return
    if ('syncId' in command && typeof command.syncId === 'number') latestHostSyncId = Math.max(latestHostSyncId, command.syncId)
    switch (command.type) {
      case 'init':
        applyingHostSnapshot = true
        renderer.attachCanvas(command.canvas)
        stopFrameTimer()
        renderer.clearCachedCostumes?.()
        await vm.loadProject(command.snapshot.project)
        vm.importAssetBytes(command.assets)
        cacheCostumeImages(command.images)
        vm.applyRuntimeSnapshot(command.snapshot)
        renderer.requestDraw?.(vm.snapshot())
        applyingHostSnapshot = false
        postRuntimeSnapshot('WORKER_READY', command.syncId)
        break
      case 'sync':
        applyingHostSnapshot = true
        stopFrameTimer()
        vm.importAssetBytes(command.assets)
        cacheCostumeImages(command.images)
        vm.applyRuntimeSnapshot(command.snapshot)
        renderer.requestDraw?.(vm.snapshot())
        applyingHostSnapshot = false
        postRuntimeSnapshot('WORKER_SYNC', command.syncId)
        if (vm.isRunning()) beginFrameTimer()
        break
      case 'cacheImages':
        cacheCostumeImages(command.images)
        renderer.requestDraw?.(vm.snapshot())
        break
      case 'resize':
        renderer.resize(command.width, command.height)
        renderer.requestDraw?.(vm.snapshot())
        break
      case 'greenFlag':
        vm.greenFlag()
        beginFrameTimer()
        break
      case 'stopAll':
        vm.stopAll()
        stopFrameTimer()
        break
      case 'step':
        vm.step()
        break
      case 'toggleScript':
        vm.toggleScript(command.topBlockId, command.targetId)
        if (vm.isRunning()) beginFrameTimer()
        else stopFrameTimer()
        break
      case 'reportBlockValue':
        vm.reportBlockValue(command.blockId, command.targetId)
        break
      case 'setTurboMode':
        vm.setTurboMode(command.enabled)
        postRuntimeSnapshot('TURBO_MODE_UPDATE')
        break
      case 'postMouse':
        vm.postMouse(command.data)
        break
      case 'postKeyboard':
        vm.postKeyboard(command.data)
        break
      case 'startDrag':
        vm.startDrag(command.targetId)
        break
      case 'stopDrag':
        vm.stopDrag(command.targetId)
        break
      case 'postSpriteInfo':
        vm.postSpriteInfo(command.data)
        break
      case 'dispose':
        stopFrameTimer()
        renderer.dispose()
        self.close()
        break
    }
  } catch (error) {
    applyingHostSnapshot = false
    const message: RuntimeWorkerEvent = { type: 'error', message: error instanceof Error ? error.message : String(error) }
    self.postMessage(message)
  }
}

function cacheCostumeImages(images: WorkerCostumeImage[] = []): void {
  for (const item of images) renderer.cacheCostumeImage(item.assetId, item.dataFormat, item.image)
}
