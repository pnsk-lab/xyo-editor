import {
  ScratchCanvasRenderer,
  ScratchVM,
  type RuntimeSnapshot,
  type ScratchBounds,
  type ScratchSound,
} from '@hikkaku/vm'

type RuntimeWorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas; snapshot: RuntimeSnapshot; assets: Record<string, Uint8Array>; images?: WorkerCostumeImage[]; keepKeys?: string[]; syncId: number }
  | { type: 'sync'; snapshot: RuntimeSnapshot; assets: Record<string, Uint8Array>; images?: WorkerCostumeImage[]; keepKeys?: string[]; syncId: number }
  | { type: 'attachCanvas'; canvas: OffscreenCanvas }
  | { type: 'cacheImages'; images?: WorkerCostumeImage[]; keepKeys?: string[]; syncId?: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'greenFlag'; snapshot?: RuntimeSnapshot; assets?: Record<string, Uint8Array>; images?: WorkerCostumeImage[]; keepKeys?: string[]; syncId?: number }
  | { type: 'probeSvg'; targetName?: string; syncId?: number }
  | { type: 'stopAll'; syncId?: number }
  | { type: 'step'; syncId?: number }
  | { type: 'toggleScript'; topBlockId: string; targetId: string; syncId?: number }
  | { type: 'reportBlockValue'; blockId: string; targetId: string; syncId?: number }
  | { type: 'setTurboMode'; enabled: boolean; syncId?: number }
  | { type: 'answerPrompt'; value: string; syncId?: number }
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
  | { type: 'question'; payload: { question?: string | null; answer?: string }; syncId: number; resetId: number }
  | { type: 'probeSvgResult'; bounds: ScratchBounds | null; targetName: string; syncId?: number }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }

type WorkerCostumeImage = {
  assetId: string
  dataFormat: string
  image: ImageBitmap
  /** Authoritative SVG texture size from sanitized bytes (`null` = unknown). */
  svgSize?: [number, number] | null
}

function isValidWorkerSvgSize(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [w, h] = value as unknown[]
  return (
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0 &&
    w <= 10000 &&
    h <= 10000
  )
}

const vm = new ScratchVM()
const renderer = new ScratchCanvasRenderer()
let frameTimer: ReturnType<typeof setTimeout> | number | undefined
let applyingHostSnapshot = false
let latestHostSyncId = 0
let latestResetSyncId = 0
let frameCount = 0
let fpsWindowStart = performance.now()
let lastRuntimeSnapshotPost = 0
const runtimeFrameInterval = 1000 / 30

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
  const message: RuntimeWorkerEvent = { type: 'snapshot', event, snapshot: vm.lightweightSnapshot(), syncId }
  self.postMessage(message)
}

const beginFrameTimer = () => {
  if (frameTimer) return
  const step = (now = performance.now()) => {
    if (!frameTimer) return
    if (vm.isRunning()) {
      const startedAt = performance.now()
      vm.step(now)
      const elapsed = performance.now() - startedAt
      frameTimer = scheduleRuntimeFrame(step, Math.max(0, runtimeFrameInterval - elapsed))
    } else {
      stopFrameTimer()
    }
  }
  frameTimer = scheduleRuntimeFrame(step, runtimeFrameInterval)
}

const stopFrameTimer = () => {
  if (!frameTimer) return
  cancelRuntimeFrame(frameTimer)
  frameTimer = undefined
  resetFps()
}

const scheduleRuntimeFrame = (callback: (now?: number) => void, delay = 0): ReturnType<typeof setTimeout> | number => {
  return setTimeout(() => callback(performance.now()), delay)
}

const cancelRuntimeFrame = (handle: ReturnType<typeof setTimeout> | number): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

for (const event of ['PROJECT_LOADED', 'PROJECT_CHANGED', 'TARGETS_UPDATE', 'WORKSPACE_UPDATE', 'BLOCKS_NEED_UPDATE', 'RUNTIME_STEP', 'PROJECT_RUN_START', 'PROJECT_RUN_STOP'] as const) {
  vm.on<RuntimeSnapshot>(event, (snapshot) => {
    if (applyingHostSnapshot) return
    if (event === 'RUNTIME_STEP' && snapshot.running) {
      countFrame()
      const now = performance.now()
      if (now - lastRuntimeSnapshotPost > 250) {
        lastRuntimeSnapshotPost = now
        self.postMessage({ type: 'snapshot', event, snapshot, syncId: latestHostSyncId } satisfies RuntimeWorkerEvent)
      }
      return
    }
    const message: RuntimeWorkerEvent = { type: 'snapshot', event, snapshot, syncId: latestHostSyncId }
    self.postMessage(message)
    if (event === 'PROJECT_RUN_START') beginFrameTimer()
    if (event === 'PROJECT_RUN_STOP' && !snapshot.running) stopFrameTimer()
  })
}

vm.on<{ question?: string | null; answer?: string }>('QUESTION', (payload) => {
  if (!applyingHostSnapshot) self.postMessage({ type: 'question', payload, syncId: latestHostSyncId, resetId: latestResetSyncId } satisfies RuntimeWorkerEvent)
})

vm.on<{ targetName: string; sound: ScratchSound }>('SOUND_PLAYED', ({ targetName, sound }) => {
  const message: RuntimeWorkerEvent = { type: 'soundPlayed', targetName, sound, snapshot: vm.lightweightSnapshot(), syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.on<RuntimeSnapshot>('SOUNDS_STOPPED', (snapshot) => {
  const message: RuntimeWorkerEvent = { type: 'soundsStopped', snapshot, syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.on<{ id: string; value: string }>('VISUAL_REPORT', ({ id, value }) => {
  const message: RuntimeWorkerEvent = { type: 'visualReport', id, value, snapshot: vm.lightweightSnapshot(), syncId: latestHostSyncId }
  self.postMessage(message)
})

vm.attachRenderer(renderer)

self.onmessage = async (event: MessageEvent<RuntimeWorkerCommand>) => {
  const command = event.data
  try {
    // Queued snapshot ordering: stale host frames (older syncId) never rewind
    // the worker. `syncId` orders all host frames; `projectGeneration` inside
    // `snapshot` distinguishes reload (new generation → full reset) from
    // same-generation edits (preserve execution). Both travel in `snapshot`.
    if (command.type === 'sync' && command.syncId < latestHostSyncId) return
    if ((command.type === 'greenFlag' || command.type === 'stopAll' || command.type === 'sync') && command.syncId !== undefined) {
      if (command.syncId < latestResetSyncId) return
      // Stale flag payload older than the latest host sync must not rewind the
      // worker to an older project: run without applying its snapshot.
      if (command.type === 'greenFlag' && 'snapshot' in command && command.snapshot && command.syncId < latestHostSyncId) {
        (command as { snapshot?: undefined }).snapshot = undefined
      }
      latestResetSyncId = command.syncId
    }
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
        vm.applyRuntimeSnapshot(command.snapshot, { cloneProject: false })
        renderer.requestDraw?.(vm.lightweightSnapshot())
        applyingHostSnapshot = false
        postRuntimeSnapshot('WORKER_READY', command.syncId)
        break
      case 'attachCanvas':
        renderer.attachCanvas(command.canvas)
        renderer.requestDraw(vm.lightweightSnapshot())
        break
      case 'sync':
        applyingHostSnapshot = true
        stopFrameTimer()
        vm.importAssetBytes(command.assets)
        cacheCostumeImages(command.images, true, command.keepKeys, command.snapshot)
        // Host -> worker direction: explicit generation contract.
        // Same-generation edits preserve execution (no hat restart); a new
        // host generation or explicit replacement fully resets (threads,
        // clones, timer, costume-write epoch) so old CAS never lands.
        vm.applyHostProjectSnapshot(command.snapshot, { cloneProject: false })
        renderer.requestDraw?.(vm.lightweightSnapshot())
        applyingHostSnapshot = false
        postRuntimeSnapshot('WORKER_SYNC', command.syncId)
        if (vm.isRunning()) beginFrameTimer()
        break
      case 'cacheImages':
        cacheCostumeImages(command.images, true, command.keepKeys)
        renderer.requestDraw?.(vm.lightweightSnapshot())
        break
      case 'resize':
        renderer.resize(command.width, command.height)
        renderer.requestDraw?.(vm.lightweightSnapshot())
        break
      case 'greenFlag':
        // A block edit followed by flag with no intermediate sync must still
        // run the NEW project: the controller attaches the latest host
        // snapshot (+ assets) to the flag command and the worker applies the
        // same host-authoritative contract before starting. Legacy flag
        // commands without a snapshot keep the old behavior.
        if (command.snapshot) {
          applyingHostSnapshot = true
          stopFrameTimer()
          vm.importAssetBytes(command.assets ?? {})
          cacheCostumeImages(command.images, true, command.keepKeys, command.snapshot)
          vm.applyHostProjectSnapshot(command.snapshot, { cloneProject: false })
          applyingHostSnapshot = false
        } else {
          cacheCostumeImages(command.images, true, command.keepKeys)
        }
        vm.greenFlag()
        beginFrameTimer()
        break
      case 'probeSvg': {
        const name = command.targetName ?? 'Sprite1'
        const bounds = renderer.getBounds?.(name) ?? null
        self.postMessage({ type: 'probeSvgResult', bounds, targetName: name, syncId: command.syncId } satisfies RuntimeWorkerEvent)
        break
      }
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
      case 'answerPrompt':
        vm.answerPrompt(command.value)
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

function cacheCostumeImages(images: WorkerCostumeImage[] = [], pruneStale = false, keepKeys?: string[], snapshot?: RuntimeSnapshot): void {
  for (const item of images) {
    if (!item || typeof item.assetId !== 'string' || typeof item.dataFormat !== 'string' || !item.image) continue
    // Same-key updates keep arrival order: callers guarantee syncId order
    // (stale sync/greenFlag payloads are dropped before reaching here),
    // so the newest payload wins by overwriting here.
    // Only forward validated SVG geometry; invalid/unknown evicts stale
    // authoritative sizes (clone/old-cache confusion guard). PNG never
    // touches the SVG geometry cache (handled inside cacheCostumeImage).
    const svgSize = item.dataFormat === 'svg' && isValidWorkerSvgSize(item.svgSize) ? item.svgSize : null
    renderer.cacheCostumeImage(item.assetId, item.dataFormat, item.image, svgSize)
    // Non-SVG entries must not retain a stale SVG geometry under a reused
    // key shape; cacheCostumeImage already scopes by dataFormat, but an
    // explicit null keeps the intent fail-closed when the host omits size.
    if (item.dataFormat === 'svg' && !isValidWorkerSvgSize(item.svgSize)) {
      // cacheCostumeImage(null) already evicted; nothing further to do.
    }
  }
  if (!pruneStale) return
  // Prune by ALL keys referenced from the snapshot, not by the subset that
  // rasterized successfully. A transient raster failure therefore keeps the
  // old cache (recovery on next render/resync), while costumes removed from
  // the snapshot are still released (close).
  const keep = keepKeys !== undefined ? new Set(keepKeys) : snapshot ? snapshotCostumeKeys(snapshot) : new Set(images.flatMap((item) => item && item.assetId && item.dataFormat ? [`${item.assetId}:${item.dataFormat}`] : []))
  renderer.pruneCostumeImages?.(keep)
}

function snapshotCostumeKeys(snapshot: RuntimeSnapshot): Set<string> {
  const keep = new Set<string>()
  for (const target of snapshot?.project?.targets ?? []) {
    for (const costume of (target as { costumes?: Array<{ assetId?: string; md5ext?: string; dataFormat?: string }> })?.costumes ?? []) {
      const dataFormat = costume.dataFormat ?? String(costume.md5ext ?? '').split('.').pop()?.toLowerCase() ?? ''
      const assetId = costume.md5ext ?? costume.assetId
      if (!assetId || (dataFormat !== 'svg' && dataFormat !== 'png' && dataFormat !== 'jpg' && dataFormat !== 'jpeg')) continue
      keep.add(`${assetId}:${dataFormat}`)
    }
  }
  return keep
}
