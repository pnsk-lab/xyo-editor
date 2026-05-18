<script lang="ts">
  import {
    Code2,
    Maximize2,
    Minimize2,
    Minus,
    Paintbrush,
    Plus,
    RotateCcw,
    Volume2,
  } from 'lucide-svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import type paperCore from 'paper/dist/paper-core'
  import * as Blockly from 'blockly/core'
  import 'blockly/blocks'
  import * as BlocklyEn from 'blockly/msg/en'
  import AppHeader from './components/AppHeader.svelte'
  import HiddenFileInputs from './components/HiddenFileInputs.svelte'
  import LibraryDialog from './components/LibraryDialog.svelte'
  import AssetSidebar from './features/AssetLibrary/AssetSidebar.svelte'
  import BitmapEditor from './features/CostumeEditor/BitmapEditor.svelte'
  import CodeEditor from './features/CodeEditor/CodeEditor.svelte'
  import SoundEditor from './features/SoundEditor/SoundEditor.svelte'
  import StagePanel from './features/Stage/StagePanel.svelte'
  import SpritePane from './features/Targets/SpritePane.svelte'
  import {
    addTranslate,
    editableSvgChildren,
    optionalSvgNumber,
    setVectorNumericAttribute,
    setVectorRotation,
    vectorObjectRotation,
  } from './features/costumes/vector-svg'
  import {
    alignVectorElements,
    applyPaperFlip,
    applyPaperRotation,
    applyPaperScale,
    disposeVectorPaperScope,
    moveVectorEditablePoint,
    moveVectorElementBy,
    paperVectorObjectList,
    resizeVectorElementBy,
    vectorBrushPathData,
  } from './features/costumes/paper-vector'
  import { vectorBrushMarkup, vectorShapeInRectMarkup, vectorShapeMarkup } from './features/costumes/vector-shapes'
  import { scratchKeyName } from './features/input/scratch-key'
  import { concatBytes, decodeImaAdpcmWav, replaceSoundSelection as replaceWavSelection, soundSelectionByteRange as wavSelectionByteRange, transformWav as transformWavBytes, wavPeaks, wavWithSamples } from './features/sounds/wav'
  import { applyScratchFields, attachScratchBlockState, makeToolbox, monitorCallbackKey, monitorableReporterSpecs, registerScratchBlocklyBlocks, workspaceToScratchBlocks } from './lib/blockly-adapter'
  import { literalShadowTypeForInput, scratchMenuShadowFieldName } from './lib/block-input-specs'
  import { costumeLibrary, extensionLibrary, soundLibrary, spriteLibrary } from './lib/editor-libraries'
  import type { AssetHistoryEntry, BitmapTool, EditorTab, LibraryItem, LibraryPanel, SoundEffect, VectorObjectInfo, VectorResizeHandle } from './lib/editor-types'
  import { RuntimeWorkerController } from './lib/runtime-worker'
  import {
    assetBytes,
    bytesToLocalBase64,
    colorDistance,
    floatSamplesToWav,
    hexToRgb,
    isImageFile,
    librarySvg,
    localBase64ToBytes,
    makeToneWav,
    mergeFloatSamples,
    mimeFromFilename,
    shadeHex,
  } from './lib/editor-utils'
  import {
    ScratchCanvasRenderer,
    ScratchStorage,
    blockPalette,
    costumeUpload as vmCostumeUpload,
    soundUpload as vmSoundUpload,
    type RuntimeSnapshot,
    type ScratchBlock,
    type ScratchCostume,
    type ScratchSound,
    type ScratchTarget,
  } from '@hikkaku/vm'
  import { createEditorContext, type EditorContext, type EditorContextTab, type EditorHeaderConfig } from './lib/editor-context'

  export let context: EditorContext = createEditorContext()

  const vm = context.vm
  const renderer = new ScratchCanvasRenderer()
  let runtimeInWorker = false
  let applyingWorkerSnapshot = false
  function applyWorkerRuntimeSnapshot(next: RuntimeSnapshot, event = '') {
    const merged = event === 'WORKER_READY' || event === 'WORKER_SYNC'
      ? next
      : { ...next, selectedTargetId: snapshot.selectedTargetId }
    applyingWorkerSnapshot = true
    vm.applyRuntimeSnapshot(merged)
    applyingWorkerSnapshot = false
    refresh(merged, 'worker')
    return merged
  }
  const runtimeWorker = new RuntimeWorkerController(
    vm,
    (next, event) => {
      applyWorkerRuntimeSnapshot(next, event)
      if (event === 'PROJECT_RUN_START') status = 'Running'
      if (event === 'PROJECT_RUN_STOP') status = 'Stopped'
    },
    (message) => {
      status = `Runtime worker error: ${message}`
    },
    (targetName, sound, next) => {
      applyWorkerRuntimeSnapshot(next)
      void playRuntimeSound(targetName, sound)
    },
    (next) => {
      applyWorkerRuntimeSnapshot(next)
      stopRuntimeSounds()
    },
    (id, value, next) => {
      applyWorkerRuntimeSnapshot(next)
      showVisualReport(id, value)
    },
    (nextFps) => {
      fps = nextFps
    },
  )
  const uploadStorage = new ScratchStorage()
  Blockly.setLocale(BlocklyEn as unknown as Record<string, string>)
  let snapshot: RuntimeSnapshot = vm.snapshot()
  let projectTitle = 'Untitled Scratch Project'
  let status = 'Ready'
  let fps = 0
  let fpsFrameCount = 0
  let fpsWindowStart = typeof performance !== 'undefined' ? performance.now() : 0
  let runtimeUiRefreshAt = 0
  let colorScheme: 'light' | 'dark' = 'light'
  let selectedTab: EditorTab = 'code'
  let selectedExternalTabId = ''
  let stageFullscreen = false
  let stagePaneWidth = 540
  let paintColor = '#ffab19'
  let secondaryPaintColor = '#ffffff'
  let paintGradient: 'solid' | 'horizontal' | 'vertical' | 'radial' = 'solid'
  let strokeColor = '#0f172a'
  let strokeWidth = 4
  let vectorOpacity = 100
  let costumeEditMode: 'bitmap' | 'vector' = 'bitmap'
  let costumeEditModeSignature = ''
  let costumeSelectionSignature = ''
  let bitmapTool: BitmapTool = 'brush'
  let vectorShape: 'rect' | 'oval' | 'line' | 'text' = 'oval'
  const vectorResizeHandles: Array<{ id: VectorResizeHandle; cursor: string }> = [
    { id: 'nw', cursor: 'cursor-nwse-resize' },
    { id: 'n', cursor: 'cursor-ns-resize' },
    { id: 'ne', cursor: 'cursor-nesw-resize' },
    { id: 'e', cursor: 'cursor-ew-resize' },
    { id: 'se', cursor: 'cursor-nwse-resize' },
    { id: 's', cursor: 'cursor-ns-resize' },
    { id: 'sw', cursor: 'cursor-nesw-resize' },
    { id: 'w', cursor: 'cursor-ew-resize' },
  ]
  let vectorText = 'Text'
  let vectorObjects: VectorObjectInfo[] = []
  let selectedVectorObjectIndex = -1
  let selectedVectorObjectIndices: number[] = []
  let brushSize = 7
  const BITMAP_STANDARD_WIDTH = 480
  const BITMAP_STANDARD_HEIGHT = 360
  const BITMAP_WORKSPACE_SCALE = 5
  const BITMAP_WORKSPACE_WIDTH = BITMAP_STANDARD_WIDTH * BITMAP_WORKSPACE_SCALE
  const BITMAP_WORKSPACE_HEIGHT = BITMAP_STANDARD_HEIGHT * BITMAP_WORKSPACE_SCALE
  let bitmapCanvas: HTMLCanvasElement
  let bitmapCanvasWidth = BITMAP_WORKSPACE_WIDTH
  let bitmapCanvasHeight = BITMAP_WORKSPACE_HEIGHT
  let isBitmapPainting = false
  let bitmapStart: { x: number; y: number } | undefined
  let bitmapPreviewBase: ImageData | undefined
  let bitmapPaperPoints: { x: number; y: number }[] = []
  let bitmapPaperModule: typeof paperCore | undefined
  let bitmapPaperScope: paper.PaperScope | undefined
  let bitmapSelection: { x: number; y: number; width: number; height: number } | undefined
  let bitmapMoveDrag: { startPoint: { x: number; y: number }; startSelection: { x: number; y: number; width: number; height: number }; base: ImageData; selection: ImageData } | undefined
  let bitmapClipboard: ImageData | undefined
  let skipNextBitmapCanvasReloadKey = ''
  let soundClipboard: Uint8Array | undefined
  let soundClipboardMeta: Partial<ScratchSound> | undefined
  let previewAudio: AudioBufferSourceNode | undefined
  let previewAudioContext: AudioContext | undefined
  let runtimeAudioContext: AudioContext | undefined
  let runtimeAudioSources: AudioBufferSourceNode[] = []
  let runtimeAudioVolumes = new Map<string, number>()
  let runtimeAudioEffects = new Map<string, Record<string, number>>()
  let previewPlayheadTimer: ReturnType<typeof setInterval> | undefined
  let previewAudioStartedAt = 0
  let previewAudioDuration = 0
  let previewSelectionStart = 0
  let previewSelectionEnd = 1
  let costumePreviewUrl = ''
  let costumePreviewSvg = ''
  let costumeThumbnailUrls: Record<string, string> = {}
  let costumeThumbnailSignature = ''
  let targetThumbnailUrls: Record<string, string> = {}
  let targetThumbnailSignature = ''
  let targetListSignature = ''
  let assetPreviewRevision = 0
  let soundWaveform: number[] = []
  let soundTrimStart = 0
  let soundTrimEnd = 1
  let soundPlayhead = 0

  let isSelectingSoundRange = false
  let soundSelectionAnchor = 0
  let soundTrimDrag: 'start' | 'end' | undefined
  let isRecordingSound = false
  let recordingLevel = 0
  let recordingStream: MediaStream | undefined
  let recordingContext: AudioContext | undefined
  let recordingProcessor: ScriptProcessorNode | undefined
  let recordingChunks: Float32Array[] = []
  let recordingSampleRate = 44100
  let assetEditorSignature = ''
  let assetUndoStack: AssetHistoryEntry[] = []
  let assetRedoStack: AssetHistoryEntry[] = []
  let vectorDrag:
    | {
        index: number
        pointerId: number
        startClientX: number
        startClientY: number
        dx: number
        dy: number
        scale: number
        applying: boolean
        historyReady: Promise<void>
        pendingClientX?: number
        pendingClientY?: number
      }
    | undefined
  let vectorResizeDrag:
    | {
        index: number
        handle: VectorResizeHandle
        pointerId: number
        startClientX: number
        startClientY: number
        dx: number
        dy: number
        scale: number
        applying: boolean
        historyReady: Promise<void>
        sourceReady: Promise<{ targetName: string; costumeIndex: number; svgText: string } | undefined>
        pendingClientX?: number
        pendingClientY?: number
      }
    | undefined
  let vectorPathPointDrag:
    | {
        objectIndex: number
        pointIndex: number
        pointerId: number
        startClientX: number
        startClientY: number
        startX: number
        startY: number
        scale: number
        applying: boolean
        historyReady: Promise<void>
        pendingClientX?: number
        pendingClientY?: number
        pendingShiftKey?: boolean
        pendingAltKey?: boolean
      }
    | undefined
  let rotationCenterDrag: { pointerId: number; startClientX: number; startClientY: number; dx: number; dy: number; scale: number } | undefined
  let lastDeletedSprite: Uint8Array | undefined
  let lastDeletedCostume: AssetHistoryEntry | undefined
  let lastDeletedCostumeRestore: (() => void) | undefined
  let lastDeletedSound: AssetHistoryEntry | undefined
  let lastDeletedSoundRestore: (() => void) | undefined
  let selectedSoundIndex = 0
  let draggedSpriteName = ''
  let draggedAssetSourceTarget = ''
  let draggedCodeSourceTarget = ''
  let draggedCostumeIndex: number | undefined
  let draggedSoundIndex: number | undefined
  let stageSpriteDrag:
    | {
        targetId: string
        pointerId: number
        startClientX: number
        startClientY: number
        offsetX: number
        offsetY: number
        moved: boolean
      }
    | undefined
  let stagePaneResize:
    | {
        startClientX: number
        startWidth: number
      }
    | undefined
  let suppressNextStageClick = false
  let spriteContextMenu: { name: string; x: number; y: number } | undefined
  let libraryPanel: LibraryPanel
  let libraryHistoryOpen = false
  let librarySearch = ''
  let fileInput: HTMLInputElement
  let spriteFileInput: HTMLInputElement
  let costumeFileInput: HTMLInputElement
  let soundFileInput: HTMLInputElement
  let blocklyHost: HTMLDivElement
  let stageCanvas: HTMLCanvasElement
  let workspace: Blockly.WorkspaceSvg | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let resizeObserver: ResizeObserver | undefined
  let blocklyPointerUpHandler: (() => void) | undefined
  let blocklySelectedCategoryPointerDownHandler: ((event: PointerEvent) => void) | undefined
  let loadingBlockly = false
  let workspaceLoadSerial = 0
  let workspaceTargetId = ''
  let workspaceToolboxSignature = ''
  let lastToolboxScrollCategoryName = ''
  let toolboxFlyoutScrollAnimation: number | undefined
  let toolboxCategorySyncAnimation: number | undefined
  let highlightedRuntimeBlockIds = new Set<string>()
  let visualReportBubble: { id: string; value: string; left: number; top: number } | undefined
  let visualReportTimer: ReturnType<typeof setTimeout> | undefined
  let dataDialogNameInput: HTMLInputElement | undefined
  let dataDialog:
    | {
        kind: 'variable' | 'list'
        name: string
        scope: 'global' | 'local'
      }
    | undefined
  const toolboxPaletteScale = 0.9
  const toolboxFlyoutWidth = 294

  function preferredColorScheme() {
    if (typeof window === 'undefined') return 'light'
    const stored = window.localStorage.getItem('hikkaku-color-scheme')
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function applyColorScheme(scheme: 'light' | 'dark') {
    colorScheme = scheme
    document.documentElement.dataset.theme = scheme
    document.documentElement.style.colorScheme = scheme
  }

  function toggleColorScheme() {
    const next = colorScheme === 'dark' ? 'light' : 'dark'
    applyColorScheme(next)
    window.localStorage.setItem('hikkaku-color-scheme', next)
  }
  const scratchBlocklyTheme = Blockly.Theme.defineTheme('hikkaku-scratch', {
    name: 'hikkaku-scratch',
    base: Blockly.Themes.Classic,
    blockStyles: Object.fromEntries(blockPalette.map((group) => [
      `${group.category}_blocks`,
      { colourPrimary: group.color, colourSecondary: shadeHex(group.color, -14), colourTertiary: shadeHex(group.color, -22) },
    ])),
    categoryStyles: Object.fromEntries(blockPalette.map((group) => [
      `${group.category}_category`,
      { colour: group.color },
    ])),
    componentStyles: {
      workspaceBackgroundColour: '#ffffff',
      toolboxBackgroundColour: '#f9f9f9',
      toolboxForegroundColour: '#575e75',
      flyoutBackgroundColour: '#f9f9f9',
      flyoutForegroundColour: '#575e75',
      flyoutOpacity: 1,
      scrollbarColour: '#cecdce',
      scrollbarOpacity: 0.85,
      insertionMarkerColour: '#000000',
      insertionMarkerOpacity: 0.18,
      markerColour: '#4c97ff',
      cursorColour: '#4c97ff',
    },
    fontStyle: {
      family: 'Helvetica Neue, Helvetica, Arial, sans-serif',
      weight: '600',
      size: 12,
    },
    startHats: true,
  })

  const editorTabs: Array<{ id: EditorTab; label: string; icon: typeof Code2 }> = [
    { id: 'code', label: 'コード', icon: Code2 },
    { id: 'costumes', label: 'コスチューム', icon: Paintbrush },
    { id: 'sounds', label: '音', icon: Volume2 },
  ]
  let contextTabs: EditorContextTab[] = [...(context.tabs ?? [])]
  let header: EditorHeaderConfig = context.header ?? {}
  let orderedContextTabs: Array<{ tab: EditorContextTab; index: number; order: number; id: string }> = []
  let activeContextTab: { tab: EditorContextTab; index: number; order: number; id: string } | undefined
  let unsubscribeContextTabs: (() => void) | undefined
  let unsubscribeContextHeader: (() => void) | undefined
  $: orderedContextTabs = contextTabs
    .map((tab, index) => ({ tab, index, order: tab.order ?? 0, id: externalTabId(tab, index) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
  $: activeContextTab = orderedContextTabs.find((item) => item.id === selectedExternalTabId)

  function externalTabId(tab: EditorContextTab, index: number) {
    return tab.id || `external-${index}`
  }

  function mountElement(node: HTMLElement, element: Element) {
    let mountedElement: Element | undefined
    const mount = (nextElement: Element) => {
      if (mountedElement === nextElement) return
      node.replaceChildren(nextElement)
      mountedElement = nextElement
    }
    mount(element)
    return {
      update: mount,
      destroy() {
        node.replaceChildren()
        mountedElement = undefined
      },
    }
  }

  function selectEditorTab(tab: EditorTab) {
    selectedExternalTabId = ''
    selectedTab = tab
  }

  function selectExternalTab(id: string) {
    selectedExternalTabId = id
  }

  function registerExternalTab(tab: EditorContextTab) {
    if (context.addTab) return context.addTab(tab)
    contextTabs = [...contextTabs, tab]
    return () => {
      contextTabs = contextTabs.filter((entry) => entry !== tab)
    }
  }

  const refresh = (next = vm.snapshot(), source: 'main' | 'worker' = 'main', draw = true) => {
    snapshot = next
    if (draw) requestAnimationFrame(() => renderer.requestDraw(snapshot))
    if (runtimeInWorker && source === 'main' && !applyingWorkerSnapshot) runtimeWorker.sync(next)
  }

  const refreshRuntimeFrame = (next: RuntimeSnapshot) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!next.running || now - runtimeUiRefreshAt > 250) {
      runtimeUiRefreshAt = now
      snapshot = next
    }
  }

  function resetFps() {
    fps = 0
    fpsFrameCount = 0
    fpsWindowStart = typeof performance !== 'undefined' ? performance.now() : 0
  }

  function countRuntimeFrame() {
    if (runtimeInWorker) return
    fpsFrameCount += 1
    const now = performance.now()
    if (now - fpsWindowStart < 500) return
    fps = Math.round((fpsFrameCount * 1000) / (now - fpsWindowStart))
    fpsFrameCount = 0
    fpsWindowStart = now
  }

  const installBrowserTestApi = () => {
    if (typeof window === 'undefined') return
    ;(window as unknown as {
      __hikkakuEditorTest?: {
        snapshot: () => RuntimeSnapshot
        selectedTab: () => typeof selectedTab
        status: () => string
        syncWorkspace: () => RuntimeSnapshot
        workspaceBlocks: () => Record<string, ScratchBlock>
        workspaceConnections: () => Record<string, Record<string, string | null>>
      }
    }).__hikkakuEditorTest = {
      snapshot: () => vm.snapshot(),
      selectedTab: () => selectedTab,
      status: () => status,
      syncWorkspace: () => {
        if (workspace && selectedTarget && !selectedTarget.isStage) {
          vm.applyWorkspaceChange(selectedTarget.id ?? selectedTarget.name, {
            blocks: workspaceToScratchBlocks(workspace, selectedTarget, stage),
          })
        }
        return vm.snapshot()
      },
      workspaceBlocks: () => workspace ? workspaceToScratchBlocks(workspace, selectedTarget, stage) : {},
      workspaceConnections: () => {
        const result: Record<string, Record<string, string | null>> = {}
        for (const block of workspace?.getAllBlocks(false) ?? []) {
          result[block.id] = Object.fromEntries(block.inputList.map((input) => [input.name, input.connection?.targetBlock()?.id ?? null]))
        }
        return result
      },
    }
  }

  const unsubscribers = [
    vm.on<RuntimeSnapshot>('PROJECT_LOADED', (next) => {
      status = 'Project loaded'
      workspaceTargetId = ''
      refresh(next)
    }),
    vm.on<RuntimeSnapshot>('PROJECT_CHANGED', (next) => {
      status = 'Project changed'
      refresh(next)
    }),
    vm.on<RuntimeSnapshot>('TARGETS_UPDATE', (next) => {
      if (next.running && !runtimeInWorker) refreshRuntimeFrame(next)
      else refresh(next, runtimeInWorker ? 'worker' : 'main')
    }),
    vm.on<RuntimeSnapshot>('WORKSPACE_UPDATE', (next) => refresh(next, runtimeInWorker ? 'worker' : 'main')),
    vm.on<RuntimeSnapshot>('BLOCKS_NEED_UPDATE', (next) => refresh(next, runtimeInWorker ? 'worker' : 'main')),
    vm.on<RuntimeSnapshot>('RUNTIME_STEP', (next) => {
      if (runtimeInWorker) refresh(next, 'main', false)
      else refreshRuntimeFrame(next)
      if (next.running) countRuntimeFrame()
    }),
    vm.on<RuntimeSnapshot>('PROJECT_RUN_START', (next) => {
      status = 'Running'
      resetFps()
      refresh(next)
    }),
    vm.on<RuntimeSnapshot>('PROJECT_RUN_STOP', (next) => {
      status = 'Stopped'
      resetFps()
      refresh(next)
    }),
    vm.on<{ id: string; value: string }>('VISUAL_REPORT', (payload) => {
      showVisualReport(payload.id, payload.value)
    }),
  ]

  $: project = snapshot.project
  $: targets = project.targets
  $: stage = targets.find((target) => target.isStage)
  $: sprites = targets.filter((target) => !target.isStage && !target.isClone)
  $: selectedTarget =
    targets.find((target) => target.id === snapshot.selectedTargetId || target.name === snapshot.selectedTargetId) ?? sprites[0] ?? stage
  $: selectedBlocks = selectedTarget ? Object.entries(selectedTarget.blocks) : []
  $: selectedVariables = selectedTarget ? Object.entries(selectedTarget.variables) : []
  $: selectedLists = selectedTarget ? Object.entries(selectedTarget.lists) : []
  $: visibleMonitors = project.monitors.filter((monitor) => monitor.visible)
  $: if (selectedTarget && selectedSoundIndex >= selectedTarget.sounds.length) selectedSoundIndex = Math.max(0, selectedTarget.sounds.length - 1)
  $: assetSignature = selectedTarget
    ? `${selectedTab}:${selectedTarget.id ?? selectedTarget.name}:${selectedTarget.currentCostume}:${selectedTarget.costumes[selectedTarget.currentCostume ?? 0]?.md5ext ?? ''}:${selectedSoundIndex}:${selectedTarget.sounds[selectedSoundIndex]?.md5ext ?? ''}`
    : selectedTab
  $: currentCostume = selectedTarget?.costumes[selectedTarget.currentCostume ?? 0]
  $: currentCostumeModeSignature = selectedTarget ? `${selectedTarget.id ?? selectedTarget.name}:${selectedTarget.currentCostume}:${currentCostume?.md5ext ?? currentCostume?.assetId ?? ''}` : ''
  $: currentCostumeSelectionSignature = selectedTarget ? `${selectedTarget.id ?? selectedTarget.name}:${selectedTarget.currentCostume}` : ''
  $: if (currentCostumeSelectionSignature !== costumeSelectionSignature) {
    costumeSelectionSignature = currentCostumeSelectionSignature
    resetCostumeEditorSelection()
  }
  $: if (!selectedExternalTabId && selectedTab === 'costumes' && currentCostumeModeSignature !== costumeEditModeSignature) {
    costumeEditModeSignature = currentCostumeModeSignature
    costumeEditMode = currentCostume?.dataFormat === 'svg' ? 'vector' : 'bitmap'
  }
  $: if (assetSignature !== assetEditorSignature) {
    assetEditorSignature = assetSignature
    refreshAssetEditorPreviews()
  }
  $: costumeListSignature = selectedTarget ? `${selectedTarget.id ?? selectedTarget.name}:${selectedTarget.costumes.map((costume) => `${costume.name}:${costume.md5ext ?? costume.assetId ?? ''}`).join('|')}` : ''
  $: if (selectedTarget && costumeListSignature !== costumeThumbnailSignature) {
    costumeThumbnailSignature = costumeListSignature
    refreshCostumeThumbnails(selectedTarget)
  }
  $: targetListSignature = targets.map((target) => {
    const costume = target.costumes[target.currentCostume ?? 0]
    return `${target.id ?? target.name}:${target.currentCostume}:${costume?.md5ext ?? costume?.assetId ?? ''}`
  }).join('|')
  $: if (targetListSignature !== targetThumbnailSignature) {
    targetThumbnailSignature = targetListSignature
    refreshTargetThumbnails(targets)
  }
  $: if (workspace && !selectedExternalTabId && selectedTab === 'code' && selectedTarget && workspaceTargetId !== (selectedTarget.id ?? selectedTarget.name)) {
    loadTargetWorkspace(selectedTarget)
  }
  $: toolboxSignature = selectedTarget
    ? makeWorkspaceToolboxSignature(selectedTarget, stage, targets, project.extensions)
    : ''
  $: if (workspace && !selectedExternalTabId && selectedTab === 'code' && !loadingBlockly && toolboxSignature !== workspaceToolboxSignature) {
    const toolboxCategoryName = selectedToolboxCategoryName()
    const flyoutScroll = flyoutScrollPosition()
    workspaceToolboxSignature = toolboxSignature
    registerDataMonitorCallbacks()
    workspace.updateToolbox(makeToolbox(selectedTarget, project.extensions, stage, targets, project.monitors))
    tick().then(() => {
      keepToolboxExpanded(toolboxCategoryName, true)
      restoreFlyoutScrollPosition(flyoutScroll)
      renderMonitorCheckboxesInFlyout()
    })
  }
  $: if (workspace && !selectedExternalTabId && selectedTab === 'code' && !loadingBlockly) {
    tick().then(() => {
      if (!workspace) return
      Blockly.svgResize(workspace)
      keepToolboxExpanded()
      renderMonitorCheckboxesInFlyout()
    })
  }
  $: if (workspace && !selectedExternalTabId && selectedTab === 'code' && !loadingBlockly) {
    snapshot.threads
    selectedTarget
    syncRuntimeBlockHighlights()
  }
  $: if (stageCanvas && (runtimeInWorker || !snapshot.running)) renderer.requestDraw(snapshot)
  $: installBrowserTestApi()

  onMount(() => {
    unsubscribeContextTabs = context.subscribeTabs?.((entries) => {
      contextTabs = entries
    })
    unsubscribeContextHeader = context.subscribeHeader?.((nextHeader) => {
      header = nextHeader
    })
    applyColorScheme(preferredColorScheme())
    registerScratchBlocklyBlocks()
    mountBlockly()
    runtimeInWorker = runtimeWorker.attachCanvas(stageCanvas, snapshot)
    if (!runtimeInWorker) renderer.attachCanvas(stageCanvas)
    vm.attachRenderer(renderer)
    vm.attachAudioEngine(createRuntimeAudioEngine())
    if (!runtimeInWorker) {
      tickTimer = setInterval(() => {
        if (vm.isRunning()) vm.step()
      }, 1000 / 30)
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    window.addEventListener('blur', cancelStageSpriteDrag)
    window.addEventListener('popstate', handleHistoryPop)
  })

  onDestroy(() => {
    unsubscribeContextTabs?.()
    unsubscribeContextHeader?.()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    if (tickTimer) clearInterval(tickTimer)
    if (visualReportTimer) clearTimeout(visualReportTimer)
    endStagePaneResize()
    cancelContinuousFlyoutScroll()
    cancelToolboxCategorySync()
    resizeObserver?.disconnect()
    if (blocklyPointerUpHandler) blocklyHost?.removeEventListener('pointerup', blocklyPointerUpHandler)
    if (blocklySelectedCategoryPointerDownHandler) {
      blocklyHost?.removeEventListener('pointerdown', blocklySelectedCategoryPointerDownHandler, { capture: true })
    }
    workspace?.dispose()
    bitmapPaperScope?.project?.remove()
    disposeVectorPaperScope()
    runtimeWorker.dispose()
    renderer.dispose()
    stopRecordingSound(false)
    stopPreviewSound()
    stopRuntimeSounds()
    previewAudioContext?.close().catch(() => undefined)
    runtimeAudioContext?.close().catch(() => undefined)
    if (costumePreviewUrl) URL.revokeObjectURL(costumePreviewUrl)
    costumePreviewSvg = ''
    Object.values(costumeThumbnailUrls).forEach((url) => URL.revokeObjectURL(url))
    Object.values(targetThumbnailUrls).forEach((url) => URL.revokeObjectURL(url))
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
    window.removeEventListener('keyup', handleKeyUp, { capture: true })
    window.removeEventListener('blur', cancelStageSpriteDrag)
    window.removeEventListener('popstate', handleHistoryPop)
  })

  function openProjectPicker() {
    fileInput.click()
  }

  function openSpritePicker() {
    spriteFileInput.click()
  }

  function openLibrary(kind: NonNullable<LibraryPanel>) {
    libraryPanel = kind
    librarySearch = ''
    if (typeof window !== 'undefined' && !libraryHistoryOpen) {
      window.history.pushState({ hikkakuLibrary: kind }, '', window.location.href)
      libraryHistoryOpen = true
    }
  }

  function closeLibrary() {
    libraryPanel = undefined
    librarySearch = ''
    libraryHistoryOpen = false
  }

  function closeLibraryFromButton() {
    if (libraryHistoryOpen && typeof window !== 'undefined') {
      window.history.back()
      return
    }
    closeLibrary()
  }

  function handleHistoryPop() {
    if (libraryPanel) closeLibrary()
  }

  function openBackdropPicker() {
    const target = vm.getStage()
    if (!target) return
    vm.selectTarget(target.name)
    selectEditorTab('costumes')
    tick().then(() => costumeFileInput.click())
  }

  function revokeObjectUrlMap(urls: Record<string, string>) {
    Object.values(urls).forEach((url) => URL.revokeObjectURL(url))
  }

  function resetProjectUiState() {
    assetPreviewRevision += 1
    stopRecordingSound(false)
    stopPreviewSound()
    stopRuntimeSounds()
    cancelStageSpriteDrag()
    cancelContinuousFlyoutScroll()
    cancelToolboxCategorySync()
    closeLibrary()
    spriteContextMenu = undefined
    dataDialog = undefined
    visualReportBubble = undefined
    if (visualReportTimer) {
      clearTimeout(visualReportTimer)
      visualReportTimer = undefined
    }
    if (costumePreviewUrl) {
      URL.revokeObjectURL(costumePreviewUrl)
      costumePreviewUrl = ''
    }
    costumePreviewSvg = ''
    revokeObjectUrlMap(costumeThumbnailUrls)
    costumeThumbnailUrls = {}
    costumeThumbnailSignature = ''
    revokeObjectUrlMap(targetThumbnailUrls)
    targetThumbnailUrls = {}
    targetThumbnailSignature = ''
    targetListSignature = ''
    selectedSoundIndex = 0
    soundWaveform = []
    soundTrimStart = 0
    soundTrimEnd = 1
    soundPlayhead = 0
    isSelectingSoundRange = false
    soundTrimDrag = undefined
    draggedSpriteName = ''
    draggedAssetSourceTarget = ''
    draggedCodeSourceTarget = ''
    draggedCostumeIndex = undefined
    draggedSoundIndex = undefined
    lastDeletedSprite = undefined
    lastDeletedCostume = undefined
    lastDeletedCostumeRestore = undefined
    lastDeletedSound = undefined
    lastDeletedSoundRestore = undefined
    resetCostumeEditorSelection()
    clearBitmapCanvasPreview()
    workspaceTargetId = ''
    workspaceToolboxSignature = ''
    highlightedRuntimeBlockIds = new Set()
    renderer.clearCachedCostumes?.()
  }

  async function loadProject(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      resetProjectUiState()
      if (/\.(sb2|sb3)$/i.test(file.name)) {
        await vm.loadProject(new Uint8Array(await file.arrayBuffer()))
        projectTitle = file.name.replace(/\.(json|sb2|sb3)$/i, '')
        return
      }
      await vm.importJSON(await file.text())
      projectTitle = file.name.replace(/\.(json|sb2|sb3)$/i, '')
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load project'
    } finally {
      input.value = ''
    }
  }

  async function importSpriteFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    if (files.length === 0) return
    try {
      let imported = 0
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (isImageFile(file)) {
          await addImageSprite(file, bytes)
          imported += 1
        } else {
          const sprite = /\.(sprite2|sprite3|sb2|sb3)$/i.test(file.name) ? vm.importSprite(bytes) : vm.importSprite(new TextDecoder().decode(bytes))
          if (sprite) imported += 1
        }
      }
      status = imported > 0 ? `${imported} sprite${imported === 1 ? '' : 's'} imported` : 'Sprite import skipped'
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not import sprite'
    } finally {
      input.value = ''
    }
  }

  function exportProject() {
    const blob = new Blob([vm.toJSON()], { type: 'application/json' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `${projectTitle || 'project'}.json`
    link.click()
    URL.revokeObjectURL(href)
    status = 'Project exported'
  }

  async function exportSb3() {
    const bytes = await vm.saveProjectSb3()
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `${projectTitle || 'project'}.sb3`
    link.click()
    URL.revokeObjectURL(href)
    status = 'SB3 exported'
  }

  async function exportSelectedSprite() {
    if (!selectedTarget || selectedTarget.isStage) return
    await exportSpriteByName(selectedTarget.name)
  }

  async function exportSpriteByName(name: string) {
    const target = vm.getTarget(name)
    if (!target || target.isStage) return
    const bytes = await vm.saveSpriteSb3(name)
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `${name || 'sprite'}.sprite3`
    link.click()
    URL.revokeObjectURL(href)
    closeSpriteContextMenu()
    status = 'Sprite exported'
  }

  function newProject() {
    resetProjectUiState()
    vm.clear()
    projectTitle = 'Untitled Scratch Project'
    status = 'New project'
  }

  function addSprite() {
    const sprite = vm.addSprite()
    status = `${sprite.name} created`
  }

  function paintNewSprite() {
    const sprite = vm.addSprite()
    vm.selectTarget(sprite.name)
    selectEditorTab('costumes')
    status = `${sprite.name} ready to paint`
  }

  async function addLibrarySprite(item: (typeof spriteLibrary)[number] = spriteLibrary[0]) {
    const sprite = vm.addSprite(item.name)
    try {
      for (const [index, costume] of item.costumes.entries()) {
        const response = await fetch(`/assets-scratch/images/${costume.md5ext}`)
        if (!response.ok) throw new Error(`Could not load ${costume.name}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const target = vm.getTarget(sprite.name)
        const svgText = costume.dataFormat === 'svg' ? new TextDecoder().decode(bytes) : ''
        const normalizedSvg = svgText && target
          ? svgTextForVectorEditor(svgText, target, {
              name: costume.name,
              dataFormat: 'svg',
              rotationCenterX: costume.rotationCenterX ?? 48,
              rotationCenterY: costume.rotationCenterY ?? 48,
            })
          : undefined
        const assetBytes = normalizedSvg ? new TextEncoder().encode(normalizedSvg) : bytes
        const asset = await vm.storeAsset(assetBytes, costume.dataFormat)
        const meta = {
          name: costume.name,
          dataFormat: costume.dataFormat,
          assetId: asset.assetId,
          md5ext: asset.md5ext,
          bitmapResolution: costume.bitmapResolution ?? (costume.dataFormat === 'svg' ? 1 : 2),
          rotationCenterX: costume.dataFormat === 'svg' ? 240 : costume.rotationCenterX ?? 48,
          rotationCenterY: costume.dataFormat === 'svg' ? 180 : costume.rotationCenterY ?? 48,
        }
        if (index === 0) await vm.updateCostume(sprite.name, 0, meta)
        else vm.addCostume(sprite.name, meta)
      }
      for (const sound of item.sounds) {
        const response = await fetch(`/assets-scratch/sounds/${sound.md5ext}`)
        if (!response.ok) throw new Error(`Could not load ${sound.name}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const asset = await vm.storeAsset(bytes, sound.dataFormat)
        vm.addSound(sprite.name, {
          name: sound.name,
          dataFormat: sound.dataFormat,
          assetId: asset.assetId,
          md5ext: asset.md5ext,
          rate: sound.rate,
          sampleCount: sound.sampleCount,
        })
      }
      status = `${sprite.name} added from library`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not add sprite'
    }
  }

  async function addImageSprite(file: File, bytes: Uint8Array) {
    await new Promise<void>((resolve, reject) => {
      vmCostumeUpload(bytes, file.type || mimeFromFilename(file.name), uploadStorage, async (costumes) => {
        const baseName = file.name.replace(/\.[^.]+$/, '') || 'Sprite'
        const sprite = vm.addSprite(baseName)
        for (const [index, costume] of costumes.entries()) {
          const stored = await vm.storeAsset(assetBytes(costume.asset.data), costume.dataFormat)
          if (index === 0) {
            await vm.updateCostume(sprite.name, 0, {
              name: baseName,
              dataFormat: costume.dataFormat,
              assetId: stored.assetId,
              md5ext: stored.md5ext,
              bitmapResolution: costume.dataFormat === 'svg' ? 1 : 2,
              rotationCenterX: 48,
              rotationCenterY: 50,
            })
          } else {
            vm.addCostume(sprite.name, {
              name: `${baseName}${index + 1}`,
              dataFormat: costume.dataFormat,
              assetId: stored.assetId,
              md5ext: stored.md5ext,
              bitmapResolution: costume.dataFormat === 'svg' ? 1 : 2,
              rotationCenterX: 48,
              rotationCenterY: 50,
            })
          }
        }
        resolve()
      }, reject)
    })
  }

  async function surpriseSprite() {
    await addLibrarySprite(spriteLibrary[Math.floor(Math.random() * spriteLibrary.length)] ?? spriteLibrary[0])
  }

  async function addLibraryBackdrop(item: (typeof costumeLibrary)[number] = costumeLibrary[0]) {
    const target = vm.getStage()
    if (!target) return
    try {
      const response = await fetch(`/assets-scratch/images/${item.md5ext}`)
      if (!response.ok) throw new Error(`Could not load ${item.name}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const asset = await vm.storeAsset(bytes, item.dataFormat)
      vm.addCostume(target.name, {
        name: item.name,
        dataFormat: item.dataFormat,
        assetId: asset.assetId,
        md5ext: asset.md5ext,
        bitmapResolution: item.dataFormat === 'svg' ? 1 : 2,
        rotationCenterX: 240,
        rotationCenterY: 180,
      })
      vm.selectTarget(target.name)
      selectEditorTab('costumes')
      status = `${item.name} backdrop added`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not add backdrop'
    }
  }

  async function surpriseBackdrop() {
    await addLibraryBackdrop(costumeLibrary[Math.floor(Math.random() * costumeLibrary.length)] ?? costumeLibrary[0])
  }

  function paintNewBackdrop() {
    const target = vm.getStage()
    if (!target) return
    vm.selectTarget(target.name)
    selectEditorTab('costumes')
    vm.addCostume(target.name, {
      name: `backdrop${target.costumes.length + 1}`,
      dataFormat: 'svg',
      rotationCenterX: 240,
      rotationCenterY: 180,
    })
    status = 'Backdrop ready to paint'
  }

  async function addLibraryCostume(item: (typeof costumeLibrary)[number] = costumeLibrary[0]) {
    if (!selectedTarget) return
    try {
      const response = await fetch(`/assets-scratch/images/${item.md5ext}`)
      if (!response.ok) throw new Error(`Could not load ${item.name}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const svgText = item.dataFormat === 'svg' ? new TextDecoder().decode(bytes) : ''
      const svgSize = svgText ? svgIntrinsicSize(svgText, selectedTarget) : undefined
      const normalizedSvg = item.dataFormat === 'svg' && !selectedTarget.isStage
        ? svgTextForVectorEditor(svgText, selectedTarget, {
            name: item.name,
            dataFormat: 'svg',
            rotationCenterX: (svgSize?.width ?? 96) / 2,
            rotationCenterY: (svgSize?.height ?? 96) / 2,
          })
        : undefined
      const assetBytes = normalizedSvg ? new TextEncoder().encode(normalizedSvg) : bytes
      const asset = await vm.storeAsset(assetBytes, item.dataFormat)
      vm.addCostume(selectedTarget.name, {
        name: item.name,
        dataFormat: item.dataFormat,
        assetId: asset.assetId,
        md5ext: asset.md5ext,
        bitmapResolution: item.dataFormat === 'svg' ? 1 : 2,
        rotationCenterX: item.dataFormat === 'svg' || selectedTarget.isStage ? 240 : item.rotationCenterX ?? 48,
        rotationCenterY: item.dataFormat === 'svg' || selectedTarget.isStage ? 180 : item.rotationCenterY ?? 48,
      })
      status = `${item.name} costume added`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not add costume'
    }
  }

  async function surpriseCostume() {
    await addLibraryCostume(costumeLibrary[Math.floor(Math.random() * costumeLibrary.length)] ?? costumeLibrary[0])
  }

  async function addLibrarySound(item: (typeof soundLibrary)[number] = soundLibrary[0]) {
    if (!selectedTarget) return
    try {
      const response = await fetch(`/assets-scratch/sounds/${item.md5ext}`)
      if (!response.ok) throw new Error(`Could not load ${item.name}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const asset = await vm.storeAsset(bytes, item.dataFormat)
      vm.addSound(selectedTarget.name, {
        name: item.name,
        dataFormat: item.dataFormat,
        assetId: asset.assetId,
        md5ext: asset.md5ext,
        rate: item.rate,
        sampleCount: item.sampleCount,
      })
      selectedSoundIndex = Math.max(0, selectedTarget.sounds.length)
      status = `${item.name} sound added`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not add sound'
    }
  }

  async function surpriseSound() {
    await addLibrarySound(soundLibrary[Math.floor(Math.random() * soundLibrary.length)] ?? soundLibrary[0])
  }

  async function chooseLibraryItem(item: LibraryItem) {
    if (libraryPanel === 'sprite') await addLibrarySprite(item as (typeof spriteLibrary)[number])
    else if (libraryPanel === 'costume') await addLibraryCostume(item as (typeof costumeLibrary)[number])
    else if (libraryPanel === 'backdrop') await addLibraryBackdrop(item as (typeof costumeLibrary)[number])
    else if (libraryPanel === 'sound') await addLibrarySound(item as (typeof soundLibrary)[number])
    else if (libraryPanel === 'extension') loadExtension((item as (typeof extensionLibrary)[number]).extensionId)
    closeLibrary()
  }

  function currentLibraryItems(panel: LibraryPanel, search: string) {
    const items = panel === 'sprite'
      ? spriteLibrary
      : panel === 'sound'
        ? soundLibrary
        : panel === 'extension'
          ? extensionLibrary
          : costumeLibrary
    const query = search.trim().toLowerCase()
    if (!query) return [...items]
    return [...items].filter((item) => {
      const tags = 'tags' in item ? item.tags.join(' ') : ''
      const id = 'extensionId' in item ? item.extensionId : ''
      return `${item.name} ${id} ${tags}`.toLowerCase().includes(query)
    })
  }

  function loadExtension(extensionId: string) {
    vm.loadExtension(extensionId)
    status = `${extensionId} extension loaded`
  }

  async function addSpriteToBackpack() {
    if (!selectedTarget || selectedTarget.isStage) return
    const bytes = await vm.saveSpriteSb3(selectedTarget.name)
    localStorage.setItem('hikkaku.backpack.sprite', bytesToLocalBase64(bytes))
    status = 'Sprite added to backpack'
  }

  function restoreSpriteFromBackpack() {
    const data = localStorage.getItem('hikkaku.backpack.sprite')
    if (!data) return
    const sprite = vm.importSprite(localBase64ToBytes(data))
    status = sprite ? `${sprite.name} restored from backpack` : 'Backpack sprite skipped'
  }

  async function addCostumeToBackpack() {
    if (!selectedTarget) return
    const costume = selectedTarget.costumes[selectedTarget.currentCostume ?? 0]
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
    if (!costume || !bytes) return
    localStorage.setItem('hikkaku.backpack.costume', JSON.stringify({ meta: costume, data: bytesToLocalBase64(bytes) }))
    status = 'Costume added to backpack'
  }

  async function restoreCostumeFromBackpack() {
    if (!selectedTarget) return
    const raw = localStorage.getItem('hikkaku.backpack.costume')
    if (!raw) return
    const payload = JSON.parse(raw) as { meta: ScratchCostume; data: string }
    const bytes = localBase64ToBytes(payload.data)
    const asset = await vm.storeAsset(bytes, payload.meta.dataFormat ?? 'svg')
    vm.addCostume(selectedTarget.name, { ...payload.meta, assetId: asset.assetId, md5ext: asset.md5ext })
    status = 'Costume restored from backpack'
  }

  async function addSoundToBackpack() {
    if (!selectedTarget) return
    const sound = selectedTarget.sounds[selectedSoundIndex]
    const bytes = sound ? await vm.getSoundBuffer(selectedTarget.name, selectedSoundIndex) : undefined
    if (!sound || !bytes) return
    localStorage.setItem('hikkaku.backpack.sound', JSON.stringify({ meta: sound, data: bytesToLocalBase64(bytes) }))
    status = 'Sound added to backpack'
  }

  async function restoreSoundFromBackpack() {
    if (!selectedTarget) return
    const raw = localStorage.getItem('hikkaku.backpack.sound')
    if (!raw) return
    const payload = JSON.parse(raw) as { meta: ScratchSound; data: string }
    const bytes = localBase64ToBytes(payload.data)
    const asset = await vm.storeAsset(bytes, payload.meta.dataFormat ?? 'wav')
    vm.addSound(selectedTarget.name, { ...payload.meta, assetId: asset.assetId, md5ext: asset.md5ext })
    status = 'Sound restored from backpack'
  }

  function addCodeToBackpack() {
    if (!selectedTarget) return
    localStorage.setItem('hikkaku.backpack.code', JSON.stringify({
      sourceName: selectedTarget.name,
      blocks: selectedTarget.blocks,
    }))
    status = 'Code added to backpack'
  }

  function restoreCodeFromBackpack() {
    if (!selectedTarget) return
    const raw = localStorage.getItem('hikkaku.backpack.code')
    if (!raw) return
    const payload = JSON.parse(raw) as { sourceName?: string; blocks?: Record<string, ScratchBlock> }
    if (!payload.blocks) return
    vm.shareBlocksToTarget(payload.blocks, selectedTarget.id ?? selectedTarget.name, payload.sourceName)
    status = 'Code restored from backpack'
  }

  async function deleteSelectedTarget() {
    if (!selectedTarget || selectedTarget.isStage) return
    await deleteSpriteByName(selectedTarget.name)
  }

  async function deleteSpriteByName(name: string, confirmDelete = false) {
    const target = vm.getTarget(name)
    if (!target || target.isStage) return
    if (confirmDelete && !window.confirm(`Delete ${target.name}?`)) return
    lastDeletedSprite = await vm.saveSpriteSb3(name)
    vm.deleteTarget(name)
    closeSpriteContextMenu()
    status = 'Sprite deleted'
  }

  function restoreDeletedSprite() {
    if (!lastDeletedSprite) return
    const sprite = vm.importSprite(lastDeletedSprite)
    status = sprite ? `${sprite.name} restored` : 'No sprite restored'
    lastDeletedSprite = undefined
  }

  function duplicateSelectedTarget() {
    if (!selectedTarget || selectedTarget.isStage) return
    duplicateSpriteByName(selectedTarget.name)
  }

  function duplicateSpriteByName(name: string) {
    const sprite = vm.duplicateSprite(name)
    closeSpriteContextMenu()
    if (sprite) status = `${sprite.name} duplicated`
  }

  function renameSelectedTarget() {
    if (!selectedTarget || selectedTarget.isStage) return
    const name = window.prompt('Sprite name', selectedTarget.name)
    if (!name) return
    vm.renameSprite(selectedTarget.name, name)
    status = 'Sprite renamed'
  }

  function updateNumber(field: 'x' | 'y' | 'direction' | 'size' | 'volume', event: Event) {
    if (!selectedTarget || selectedTarget.isStage) return
    const value = Number((event.currentTarget as HTMLInputElement).value)
    vm.updateTarget(selectedTarget.name, { [field]: value })
  }

  function setDirection(direction: number) {
    if (!selectedTarget || selectedTarget.isStage) return
    vm.updateTarget(selectedTarget.name, { direction })
  }

  function updateDirectionDial(event: Event) {
    setDirection(Number((event.currentTarget as HTMLInputElement).value))
  }

  function setRotationStyle(style: NonNullable<ScratchTarget['rotationStyle']>) {
    if (!selectedTarget || selectedTarget.isStage) return
    vm.updateTarget(selectedTarget.name, { rotationStyle: style })
  }

  function updateRotationStyle(event: Event) {
    setRotationStyle((event.currentTarget as HTMLSelectElement).value as NonNullable<ScratchTarget['rotationStyle']>)
  }

  function updateTargetName(event: Event) {
    if (!selectedTarget || selectedTarget.isStage) return
    const name = (event.currentTarget as HTMLInputElement).value.trim()
    if (name && name !== selectedTarget.name) vm.renameSprite(selectedTarget.name, name)
  }

  function toggleVisible() {
    if (!selectedTarget || selectedTarget.isStage) return
    setVisible(selectedTarget.visible === false)
  }

  function setVisible(visible: boolean) {
    if (!selectedTarget || selectedTarget.isStage) return
    vm.updateTarget(selectedTarget.name, { visible })
  }

  function toggleDraggable() {
    if (!selectedTarget || selectedTarget.isStage) return
    vm.updateTarget(selectedTarget.name, { draggable: !selectedTarget.draggable })
  }

  function activateOnEnter(event: KeyboardEvent, action: () => void) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  }

  function beginSpriteDrag(spriteName: string, event: DragEvent) {
    draggedSpriteName = spriteName
    draggedAssetSourceTarget = ''
    draggedCodeSourceTarget = ''
    event.dataTransfer?.setData('text/plain', spriteName)
    event.dataTransfer?.setData('application/x-hikkaku-sprite', spriteName)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function dropSpriteOn(spriteName: string, event?: DragEvent) {
    const target = vm.getTarget(spriteName)
    if (!target) return
    if (handleAssetDropOnTarget(target, event)) return
    if (!draggedSpriteName || draggedSpriteName === spriteName || target.isStage) return
    const targetIndex = project.targets.findIndex((item) => item.name === spriteName)
    if (targetIndex >= 0) vm.reorderTarget(draggedSpriteName, targetIndex)
    status = 'Sprite reordered'
    clearSpriteDrag()
  }

  function clearSpriteDrag() {
    draggedSpriteName = ''
    draggedAssetSourceTarget = ''
    draggedCodeSourceTarget = ''
  }

  function beginCodeDrag(event: DragEvent) {
    if (!selectedTarget) return
    draggedCodeSourceTarget = selectedTarget.id ?? selectedTarget.name
    event.dataTransfer?.setData('application/x-hikkaku-code-source', draggedCodeSourceTarget)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
  }

  function beginCostumeDrag(index: number, event: DragEvent) {
    if (!selectedTarget) return
    draggedCostumeIndex = index
    draggedAssetSourceTarget = selectedTarget.id ?? selectedTarget.name
    event.dataTransfer?.setData('application/x-hikkaku-costume-index', String(index))
    event.dataTransfer?.setData('application/x-hikkaku-source-target', draggedAssetSourceTarget)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
  }

  function dropCostumeOn(index: number) {
    if (!selectedTarget || draggedCostumeIndex === undefined || draggedCostumeIndex === index) return
    vm.reorderCostume(selectedTarget.name, draggedCostumeIndex, index)
    status = 'Costume reordered'
    draggedCostumeIndex = undefined
    draggedAssetSourceTarget = ''
  }

  function clearCostumeDrag() {
    draggedCostumeIndex = undefined
    draggedAssetSourceTarget = ''
  }

  function beginSoundDrag(index: number, event: DragEvent) {
    if (!selectedTarget) return
    draggedSoundIndex = index
    draggedAssetSourceTarget = selectedTarget.id ?? selectedTarget.name
    event.dataTransfer?.setData('application/x-hikkaku-sound-index', String(index))
    event.dataTransfer?.setData('application/x-hikkaku-source-target', draggedAssetSourceTarget)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
  }

  function dropSoundOn(index: number) {
    if (!selectedTarget || draggedSoundIndex === undefined || draggedSoundIndex === index) return
    vm.reorderSound(selectedTarget.name, draggedSoundIndex, index)
    selectedSoundIndex = index
    status = 'Sound reordered'
    draggedSoundIndex = undefined
    draggedAssetSourceTarget = ''
  }

  function clearSoundDrag() {
    draggedSoundIndex = undefined
    draggedAssetSourceTarget = ''
  }

  function handleAssetDropOnTarget(target: ScratchTarget, event?: DragEvent) {
    const data = event?.dataTransfer
    const sourceName = data?.getData('application/x-hikkaku-source-target') || draggedAssetSourceTarget
    const costumeIndexText = data?.getData('application/x-hikkaku-costume-index')
    const soundIndexText = data?.getData('application/x-hikkaku-sound-index')
    const codeSourceName = data?.getData('application/x-hikkaku-code-source') || draggedCodeSourceTarget
    if (codeSourceName) {
      shareCodeBetweenTargets(codeSourceName, target.id ?? target.name)
      draggedCodeSourceTarget = ''
      return true
    }
    if (costumeIndexText || draggedCostumeIndex !== undefined) {
      const index = Number(costumeIndexText || draggedCostumeIndex)
      shareCostumeBetweenTargets(sourceName, index, target.id ?? target.name)
      draggedCostumeIndex = undefined
      draggedAssetSourceTarget = ''
      return true
    }
    if (soundIndexText || draggedSoundIndex !== undefined) {
      const index = Number(soundIndexText || draggedSoundIndex)
      shareSoundBetweenTargets(sourceName, index, target.id ?? target.name)
      draggedSoundIndex = undefined
      draggedAssetSourceTarget = ''
      return true
    }
    return false
  }

  function shareCostumeBetweenTargets(sourceName: string, index: number, targetName: string) {
    const source = vm.getTarget(sourceName)
    const target = vm.getTarget(targetName)
    const costume = source?.costumes[index]
    if (!source || !target || !costume) return
    vm.shareCostumeToTarget(index, target.id ?? target.name, source.id ?? source.name)
    vm.selectTarget(target.name)
    selectEditorTab('costumes')
    status = `${costume.name} shared to ${target.isStage ? 'Stage' : target.name}`
  }

  function shareSoundBetweenTargets(sourceName: string, index: number, targetName: string) {
    const source = vm.getTarget(sourceName)
    const target = vm.getTarget(targetName)
    const sound = source?.sounds[index]
    if (!source || !target || !sound) return
    vm.shareSoundToTarget(index, target.id ?? target.name, source.id ?? source.name)
    vm.selectTarget(target.name)
    selectEditorTab('sounds')
    status = `${sound.name} shared to ${target.isStage ? 'Stage' : target.name}`
  }

  function shareCodeBetweenTargets(sourceName: string, targetName: string) {
    const source = vm.getTarget(sourceName)
    const target = vm.getTarget(targetName)
    if (!source || !target || Object.keys(source.blocks).length === 0) return
    vm.shareBlocksToTarget(source.blocks, target.id ?? target.name, source.id ?? source.name)
    vm.selectTarget(target.name)
    selectEditorTab('code')
    status = `Code shared to ${target.isStage ? 'Stage' : target.name}`
  }

  function openSpriteContextMenu(name: string, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    spriteContextMenu = { name, x: event.clientX, y: event.clientY }
  }

  function closeSpriteContextMenu() {
    spriteContextMenu = undefined
  }

  function uniqueLocalName(names: string[], baseName: string) {
    if (!names.includes(baseName)) return baseName
    let index = 2
    while (names.includes(`${baseName}${index}`)) index += 1
    return `${baseName}${index}`
  }

  function showVariableMonitor(variableId: string) {
    if (!selectedTarget) return
    vm.upsertVariableMonitor(selectedTarget.name, variableId, true)
    status = 'Monitor shown'
  }

  function createVariable() {
    if (!selectedTarget) return
    openDataDialog('variable')
  }

  function renameVariable(id: string) {
    if (!selectedTarget) return
    const current = selectedTarget.variables[id]
    const name = window.prompt('Variable name', current?.[0] ?? '')
    if (!name) return
    vm.renameVariable(selectedTarget.id ?? selectedTarget.name, id, name)
    status = 'Variable renamed'
  }

  function deleteVariable(id: string) {
    if (!selectedTarget) return
    vm.deleteVariable(selectedTarget.id ?? selectedTarget.name, id)
    status = 'Variable deleted'
  }

  function showListMonitor(listId: string) {
    if (!selectedTarget) return
    vm.upsertListMonitor(selectedTarget.id ?? selectedTarget.name, listId, true)
    status = 'Monitor shown'
  }

  function registerDataMonitorCallbacks() {
    if (!workspace) return
    for (const spec of monitorableReporterSpecs) {
      workspace.registerButtonCallback(monitorCallbackKey(spec), () => toggleBlockMonitor(spec.opcode, spec.params ?? {}))
    }
    for (const target of [stage, selectedTarget]) {
      if (!target) continue
      for (const id of Object.keys(target.variables)) {
        workspace.registerButtonCallback(`TOGGLE_VARIABLE_MONITOR_${id}`, () => toggleVariableMonitor(id))
      }
      for (const id of Object.keys(target.lists)) {
        workspace.registerButtonCallback(`TOGGLE_LIST_MONITOR_${id}`, () => toggleListMonitor(id))
      }
    }
  }

  function toggleVariableMonitor(variableId: string) {
    const owner = dataOwnerForVariable(variableId)
    if (!owner) return
    const monitorId = `${owner.id ?? owner.name}:${variableId}`
    const monitor = project.monitors.find((item) => item.id === monitorId || item.id.endsWith(`:${variableId}`))
    if (monitor) vm.setMonitorVisible(monitor.id, !monitor.visible)
    else vm.upsertVariableMonitor(owner.id ?? owner.name, variableId, true)
    status = 'Monitor toggled'
  }

  function toggleListMonitor(listId: string) {
    const owner = dataOwnerForList(listId)
    if (!owner) return
    const monitorId = `${owner.id ?? owner.name}:${listId}`
    const monitor = project.monitors.find((item) => item.id === monitorId || item.id.endsWith(`:${listId}`))
    if (monitor) vm.setMonitorVisible(monitor.id, !monitor.visible)
    else vm.upsertListMonitor(owner.id ?? owner.name, listId, true)
    status = 'Monitor toggled'
  }

  function toggleBlockMonitor(opcode: string, params: Record<string, string>) {
    const owner = selectedTarget ?? stage
    if (!owner) return
    const monitor = project.monitors.find((item) =>
      item.opcode === opcode
      && (!item.spriteName || item.spriteName === owner.name)
      && Object.entries(params).every(([key, value]) => String(item.params[key] ?? '') === value))
    if (monitor) vm.setMonitorVisible(monitor.id, !monitor.visible)
    else vm.upsertBlockMonitor(owner.id ?? owner.name, opcode, params, true)
    status = 'Monitor toggled'
  }

  function dataOwnerForVariable(variableId: string) {
    if (selectedTarget?.variables[variableId]) return selectedTarget
    if (stage?.variables[variableId]) return stage
    return undefined
  }

  function dataOwnerForList(listId: string) {
    if (selectedTarget?.lists[listId]) return selectedTarget
    if (stage?.lists[listId]) return stage
    return undefined
  }

  function dataOwnerForVariableName(name: string): { owner: ScratchTarget; id: string } | undefined {
    for (const owner of [selectedTarget, stage]) {
      if (!owner) continue
      const id = Object.entries(owner.variables).find(([, variable]) => variable[0] === name)?.[0]
      if (id) return { owner, id }
    }
    return undefined
  }

  function dataOwnerForListName(name: string): { owner: ScratchTarget; id: string } | undefined {
    for (const owner of [selectedTarget, stage]) {
      if (!owner) continue
      const id = Object.entries(owner.lists).find(([, list]) => list[0] === name)?.[0]
      if (id) return { owner, id }
    }
    return undefined
  }

  function createList() {
    if (!selectedTarget) return
    openDataDialog('list')
  }

  function createProcedure() {
    if (!workspace || !selectedTarget) return
    const name = window.prompt('ブロック名', uniqueProcedureName('ブロック名'))?.trim()
    if (!name) return
    const definition = workspace.newBlock('procedures_definition') as Blockly.BlockSvg
    const prototype = workspace.newBlock('procedures_prototype') as Blockly.BlockSvg
    prototype.setShadow(true)
    prototype.loadExtraState?.({ proccode: name, argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'false' })
    definition.initSvg()
    prototype.initSvg()
    const connection = definition.getInput('custom_block')?.connection
    if (connection && prototype.outputConnection) connection.connect(prototype.outputConnection)
    const metrics = workspace.getMetrics()
    definition.moveBy((metrics?.viewLeft ?? 0) + 48, (metrics?.viewTop ?? 0) + 48)
    prototype.render()
    definition.render()
    vm.applyWorkspaceChange(selectedTarget.id ?? selectedTarget.name, {
      blocks: workspaceToScratchBlocks(workspace, selectedTarget, stage),
    })
    status = 'Block created'
  }

  function uniqueProcedureName(base: string) {
    const names = new Set<string>()
    const blocks = selectedTarget?.blocks ?? {}
    for (const block of Object.values(blocks)) {
      if (block.opcode !== 'procedures_prototype') continue
      const proccode = typeof block.mutation?.proccode === 'string' ? block.mutation.proccode : undefined
      if (proccode) names.add(proccode)
    }
    if (!names.has(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}${index}`
      if (!names.has(candidate)) return candidate
    }
  }

  function openDataDialog(kind: 'variable' | 'list') {
    if (!selectedTarget) return
    const target = dataDialogDefaultTarget()
    const names = kind === 'variable'
      ? Object.values(target.variables).map((variable) => variable[0])
      : Object.values(target.lists).map((list) => list[0])
    dataDialog = {
      kind,
      name: uniqueLocalName(names, kind === 'variable' ? 'my variable' : 'list'),
      scope: selectedTarget.isStage ? 'global' : 'global',
    }
    tick().then(() => {
      dataDialogNameInput?.focus()
      dataDialogNameInput?.select()
    })
  }

  function dataDialogDefaultTarget() {
    return stage ?? selectedTarget!
  }

  function closeDataDialog() {
    dataDialog = undefined
  }

  function submitDataDialog() {
    if (!dataDialog || !selectedTarget) return
    const name = dataDialog.name.trim()
    if (!name) return
    const owner = dataDialog.scope === 'global' ? (stage ?? selectedTarget) : selectedTarget
    if (!owner) return
    const ownerId = owner.id ?? owner.name
    if (dataDialog.kind === 'variable') {
      const id = vm.createVariable(ownerId, name, 0, owner.isStage && name.startsWith('☁ '))
      vm.upsertVariableMonitor(ownerId, id, true)
      status = 'Variable created'
    } else {
      const id = vm.createList(ownerId, name, [])
      vm.upsertListMonitor(ownerId, id, true)
      status = 'List created'
    }
    dataDialog = undefined
  }

  function renameList(id: string) {
    if (!selectedTarget) return
    const current = selectedTarget.lists[id]
    const name = window.prompt('List name', current?.[0] ?? '')
    if (!name) return
    vm.renameList(selectedTarget.id ?? selectedTarget.name, id, name)
    status = 'List renamed'
  }

  function deleteList(id: string) {
    if (!selectedTarget) return
    vm.deleteList(selectedTarget.id ?? selectedTarget.name, id)
    status = 'List deleted'
  }

  function hideMonitor(id: string) {
    vm.setMonitorVisible(id, false)
    status = 'Monitor hidden'
  }

  function toggleTurboMode() {
    if (runtimeInWorker) runtimeWorker.setTurboMode(!snapshot.turboMode)
    else vm.setTurboMode(!snapshot.turboMode)
    status = snapshot.turboMode ? 'Turbo off' : 'Turbo on'
  }

  function startProject() {
    const context = ensureRuntimeAudioContext()
    void context.resume()
    if (runtimeInWorker) runtimeWorker.greenFlag()
    else vm.greenFlag()
  }

  function stopProject() {
    stopRuntimeSounds()
    if (runtimeInWorker) runtimeWorker.stopAll()
    else vm.stopAll()
    resetFps()
  }

  function stepProjectRuntime() {
    const context = ensureRuntimeAudioContext()
    void context.resume()
    if (runtimeInWorker) runtimeWorker.step()
    else vm.step()
  }

  function toggleStageFullscreen() {
    stageFullscreen = !stageFullscreen
    tick().then(() => {
      if (workspace) Blockly.svgResize(workspace)
      renderer.requestDraw(snapshot)
    })
  }

  function clampStagePaneWidth(width: number) {
    if (typeof window === 'undefined') return Math.min(820, Math.max(360, width))
    const viewportMax = Math.max(360, window.innerWidth - 420)
    return Math.min(Math.min(820, viewportMax), Math.max(360, width))
  }

  function beginStagePaneResize(event: PointerEvent) {
    if (stageFullscreen) return
    event.preventDefault()
    stagePaneResize = {
      startClientX: event.clientX,
      startWidth: stagePaneWidth,
    }
    document.body.classList.add('is-resizing-stage-pane')
    window.addEventListener('pointermove', dragStagePaneResize)
    window.addEventListener('pointerup', endStagePaneResize, { once: true })
    window.addEventListener('pointercancel', endStagePaneResize, { once: true })
  }

  function dragStagePaneResize(event: PointerEvent) {
    if (!stagePaneResize) return
    stagePaneWidth = clampStagePaneWidth(stagePaneResize.startWidth - (event.clientX - stagePaneResize.startClientX))
    if (workspace) Blockly.svgResize(workspace)
    renderer.requestDraw(snapshot)
  }

  function endStagePaneResize() {
    stagePaneResize = undefined
    document.body.classList.remove('is-resizing-stage-pane')
    window.removeEventListener('pointermove', dragStagePaneResize)
    window.removeEventListener('pointerup', endStagePaneResize)
    window.removeEventListener('pointercancel', endStagePaneResize)
    tick().then(() => {
      if (workspace) Blockly.svgResize(workspace)
      renderer.requestDraw(snapshot)
    })
  }

  function adjustStagePaneWidth(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    stagePaneWidth = clampStagePaneWidth(stagePaneWidth + (event.key === 'ArrowLeft' ? 24 : -24))
    tick().then(() => {
      if (workspace) Blockly.svgResize(workspace)
      renderer.requestDraw(snapshot)
    })
  }

  function cycleMonitorMode(id: string) {
    const monitor = project.monitors.find((item) => item.id === id)
    if (!monitor) return
    const modes = monitor.opcode === 'data_listcontents' ? ['list'] : ['default', 'large', 'slider']
    const next = modes[(modes.indexOf(monitor.mode) + 1) % modes.length] ?? 'default'
    setMonitorMode(id, next)
  }

  function setMonitorMode(id: string, mode: string) {
    vm.setMonitorMode(id, mode)
    status = `Monitor ${mode}`
  }

  function editMonitorSliderLimit(id: string, field: 'sliderMin' | 'sliderMax') {
    const monitor = project.monitors.find((item) => item.id === id)
    if (!monitor) return
    const current = field === 'sliderMin' ? monitor.sliderMin ?? 0 : monitor.sliderMax ?? 100
    const label = field === 'sliderMin' ? '最小値' : '最大値'
    const nextText = window.prompt(label, String(current))
    if (nextText === null) return
    const value = Number(nextText)
    if (!Number.isFinite(value)) return
    const min = field === 'sliderMin' ? value : Number(monitor.sliderMin ?? 0)
    const max = field === 'sliderMax' ? value : Number(monitor.sliderMax ?? 100)
    vm.setMonitorSliderRange(id, min, max, monitor.isDiscrete === true)
    status = `Monitor ${label} updated`
  }

  function updateMonitorSlider(id: string, field: 'sliderMin' | 'sliderMax', event: Event) {
    const monitor = project.monitors.find((item) => item.id === id)
    if (!monitor) return
    const value = Number((event.currentTarget as HTMLInputElement).value)
    const min = field === 'sliderMin' ? value : Number(monitor.sliderMin ?? 0)
    const max = field === 'sliderMax' ? value : Number(monitor.sliderMax ?? 100)
    vm.setMonitorSliderRange(id, min, max, monitor.isDiscrete === true)
  }

  function addCostume() {
    if (!selectedTarget) return
    vm.addCostume(selectedTarget.name, {
      name: `costume${selectedTarget.costumes.length + 1}`,
      dataFormat: 'svg',
      rotationCenterX: selectedTarget.isStage ? 240 : 48,
      rotationCenterY: selectedTarget.isStage ? 180 : 50,
    })
    status = 'Costume added'
  }

  async function uploadCostume(event: Event) {
    if (!selectedTarget) return
    const targetId = selectedTarget.id ?? selectedTarget.name
    const targetIsStage = selectedTarget.isStage
    const input = event.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    if (files.length === 0) return
    try {
      let uploaded = 0
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        await new Promise<void>((resolve, reject) => {
          vmCostumeUpload(bytes, file.type || mimeFromFilename(file.name), uploadStorage, async (costumes) => {
            for (const costume of costumes) {
              const stored = await vm.storeAsset(assetBytes(costume.asset.data), costume.dataFormat)
              vm.addCostume(targetId, {
                name: costumes.length > 1 ? `${file.name.replace(/\.[^.]+$/, '')}${costumes.indexOf(costume) + 1}` : file.name.replace(/\.[^.]+$/, ''),
                dataFormat: costume.dataFormat,
                assetId: stored.assetId,
                md5ext: stored.md5ext,
                bitmapResolution: costume.dataFormat === 'svg' ? 1 : 2,
                rotationCenterX: targetIsStage ? 240 : 48,
                rotationCenterY: targetIsStage ? 180 : 48,
              })
              uploaded += 1
            }
            resolve()
          }, reject)
        })
      }
      status = `${uploaded} costume${uploaded === 1 ? '' : 's'} uploaded`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not upload costume'
    } finally {
      input.value = ''
    }
  }

  async function selectCostume(index: number) {
    if (!selectedTarget) return
    vm.setCurrentCostume(selectedTarget.name, index)
    await tick()
    await refreshAssetEditorPreviews()
    status = 'Costume selected'
  }

  function renameCostume(index: number) {
    if (!selectedTarget) return
    const current = selectedTarget.costumes[index]
    const name = window.prompt('Costume name', current?.name ?? '')
    if (!name) return
    vm.renameCostume(selectedTarget.name, index, name)
    status = 'Costume renamed'
  }

  function updateCostumeName(index: number, event: Event) {
    if (!selectedTarget) return
    const name = (event.currentTarget as HTMLInputElement).value.trim()
    if (!name || name === selectedTarget.costumes[index]?.name) return
    vm.renameCostume(selectedTarget.name, index, name)
    status = 'Costume renamed'
  }

  async function deleteCostume(index: number) {
    if (!selectedTarget) return
    lastDeletedCostume = await currentHistoryEntry({ kind: 'costume', targetName: selectedTarget.name, index, meta: selectedTarget.costumes[index]!, bytes: new Uint8Array() })
    lastDeletedCostumeRestore = vm.deleteCostume(selectedTarget.name, index) ?? undefined
    status = 'Costume deleted'
  }

  async function restoreDeletedCostume() {
    if (!selectedTarget) return
    if (lastDeletedCostumeRestore) {
      lastDeletedCostumeRestore()
    } else if (lastDeletedCostume) {
      const asset = await vm.storeAsset(lastDeletedCostume.bytes, lastDeletedCostume.meta.dataFormat ?? 'svg')
      vm.addCostume(selectedTarget.name, { ...lastDeletedCostume.meta, assetId: asset.assetId, md5ext: asset.md5ext })
    } else {
      return
    }
    lastDeletedCostume = undefined
    lastDeletedCostumeRestore = undefined
    status = 'Costume restored'
  }

  async function exportCostume(index: number) {
    if (!selectedTarget) return
    const costume = selectedTarget.costumes[index]
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
    if (!costume || !bytes) return
    const blob = new Blob([new Uint8Array(bytes)], { type: costume.dataFormat === 'svg' ? 'image/svg+xml' : costume.dataFormat === 'png' ? 'image/png' : 'application/octet-stream' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `${costume.name}.${costume.dataFormat ?? 'asset'}`
    link.click()
    URL.revokeObjectURL(href)
    status = 'Costume exported'
  }

  function duplicateCostume(index: number) {
    if (!selectedTarget) return
    vm.duplicateCostume(selectedTarget.name, index)
    status = 'Costume duplicated'
  }

  function moveCostume(index: number, direction: -1 | 1) {
    if (!selectedTarget) return
    vm.reorderCostume(selectedTarget.name, index, index + direction)
    status = 'Costume reordered'
  }

  async function refreshAssetEditorPreviews() {
    if (!selectedTarget) return
    if (selectedTab === 'costumes') await refreshCostumePreview(selectedTarget)
    if (selectedTab === 'sounds') await refreshSoundWaveform(selectedTarget)
  }

  async function refreshCostumePreview(target: ScratchTarget) {
    const revision = assetPreviewRevision
    const index = target.currentCostume ?? 0
    const costume = target.costumes[index]
    if (costumePreviewUrl) {
      URL.revokeObjectURL(costumePreviewUrl)
      costumePreviewUrl = ''
    }
    costumePreviewSvg = ''
    if (!costume) return
    const key = costume.md5ext ?? costume.assetId
    const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
    if (revision !== assetPreviewRevision) return
    if (!bytes) {
      vectorObjects = []
      selectedVectorObjectIndex = -1
      selectedVectorObjectIndices = []
      skipNextBitmapCanvasReloadKey = ''
      await loadCostumeIntoBitmapCanvas(new Uint8Array(), costume.dataFormat ?? '', revision)
      return
    }
    if (costume.dataFormat === 'svg') {
      const nextSvg = svgTextForVectorEditor(new TextDecoder().decode(bytes), target, costume)
      const nextVectorObjects = await paperVectorObjectList(nextSvg)
      if (revision !== assetPreviewRevision) return
      costumePreviewSvg = nextSvg
      vectorObjects = nextVectorObjects
    } else {
      const type = costume.dataFormat === 'png' ? 'image/png' : 'application/octet-stream'
      const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
      if (revision !== assetPreviewRevision) {
        URL.revokeObjectURL(nextUrl)
        return
      }
      costumePreviewUrl = nextUrl
      vectorObjects = []
    }
    if (!vectorObjects.some((item) => item.index === selectedVectorObjectIndex)) selectedVectorObjectIndex = -1
    selectedVectorObjectIndices = selectedVectorObjectIndices.filter((index) => vectorObjects.some((item) => item.index === index))
    if (skipNextBitmapCanvasReloadKey === costumeReloadKey(target, index) && costume.dataFormat === 'png') {
      skipNextBitmapCanvasReloadKey = ''
    } else {
      skipNextBitmapCanvasReloadKey = ''
      await loadCostumeIntoBitmapCanvas(bytes, costume.dataFormat ?? '', revision)
    }
  }

  function costumeReloadKey(target: ScratchTarget, index: number) {
    return `${target.id ?? target.name}:${index}`
  }

  function resetCostumeEditorSelection() {
    bitmapSelection = undefined
    bitmapMoveDrag = undefined
    bitmapStart = undefined
    bitmapPreviewBase = undefined
    bitmapPaperPoints = []
    isBitmapPainting = false
    selectedVectorObjectIndex = -1
    selectedVectorObjectIndices = []
  }

  function svgTextForVectorEditor(svgText: string, target: ScratchTarget, costume: ScratchCostume) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.nodeName.toLowerCase() !== 'svg') return svgText
    const stageWidth = 480
    const stageHeight = 360
    const geometry = svgGeometry(svg, target)
    const { width, height } = geometry
    if (target.isStage || (width === stageWidth && height === stageHeight && svg.getAttribute('viewBox') === `0 0 ${stageWidth} ${stageHeight}`)) {
      svg.setAttribute('width', String(stageWidth))
      svg.setAttribute('height', String(stageHeight))
      svg.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`)
      return new XMLSerializer().serializeToString(svg)
    }
    const dx = stageWidth / 2 - (geometry.viewBoxX + (costume.rotationCenterX ?? width / 2))
    const dy = stageHeight / 2 - (geometry.viewBoxY + (costume.rotationCenterY ?? height / 2))
    for (const child of editableSvgChildren(svg)) addTranslate(child, dx, dy)
    svg.setAttribute('width', String(stageWidth))
    svg.setAttribute('height', String(stageHeight))
    svg.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`)
    return new XMLSerializer().serializeToString(svg)
  }

  function svgIntrinsicSize(svgText: string, target: ScratchTarget) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.nodeName.toLowerCase() !== 'svg') return { width: target.isStage ? 480 : 96, height: target.isStage ? 360 : 96 }
    const { width, height } = svgGeometry(svg, target)
    return { width, height }
  }

  function svgGeometry(svg: Element, target: ScratchTarget) {
    const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
    const viewBoxX = viewBox && Number.isFinite(viewBox[0]) ? viewBox[0]! : 0
    const viewBoxY = viewBox && Number.isFinite(viewBox[1]) ? viewBox[1]! : 0
    const viewBoxWidth = viewBox && Number.isFinite(viewBox[2]) ? viewBox[2]! : undefined
    const viewBoxHeight = viewBox && Number.isFinite(viewBox[3]) ? viewBox[3]! : undefined
    return {
      viewBoxX,
      viewBoxY,
      width: optionalSvgNumber(svg.getAttribute('width')) ?? viewBoxWidth ?? (target.isStage ? 480 : 96),
      height: optionalSvgNumber(svg.getAttribute('height')) ?? viewBoxHeight ?? (target.isStage ? 360 : 96),
    }
  }

  async function refreshCostumeThumbnails(target: ScratchTarget) {
    const revision = assetPreviewRevision
    const nextUrls: Record<string, string> = {}
    await Promise.all(target.costumes.map(async (costume, index) => {
      const key = costume.md5ext ?? costume.assetId
      const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
      if (revision !== assetPreviewRevision) return
      if (!bytes) return
      const urlKey = `${target.id ?? target.name}:${index}:${key}`
      const type = costume.dataFormat === 'svg' ? 'image/svg+xml' : costume.dataFormat === 'jpg' ? 'image/jpeg' : costume.dataFormat === 'png' ? 'image/png' : 'application/octet-stream'
      nextUrls[urlKey] = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
    }))
    if (revision !== assetPreviewRevision) {
      revokeObjectUrlMap(nextUrls)
      return
    }
    for (const [key, url] of Object.entries(costumeThumbnailUrls)) {
      if (!nextUrls[key]) URL.revokeObjectURL(url)
    }
    costumeThumbnailUrls = nextUrls
  }

  async function refreshTargetThumbnails(items: ScratchTarget[]) {
    const revision = assetPreviewRevision
    const nextUrls: Record<string, string> = {}
    await Promise.all(items.map(async (target) => {
      const costume = target.costumes[target.currentCostume ?? 0]
      const key = costume?.md5ext ?? costume?.assetId
      const bytes = key ? await vm.loadAsset(key, costume?.dataFormat ?? '') : undefined
      if (revision !== assetPreviewRevision) return
      if (!costume || !bytes) return
      const urlKey = targetThumbnailKey(target)
      const type = costume.dataFormat === 'svg' ? 'image/svg+xml' : costume.dataFormat === 'jpg' ? 'image/jpeg' : costume.dataFormat === 'png' ? 'image/png' : 'application/octet-stream'
      nextUrls[urlKey] = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
    }))
    if (revision !== assetPreviewRevision) {
      revokeObjectUrlMap(nextUrls)
      return
    }
    for (const [key, url] of Object.entries(targetThumbnailUrls)) {
      if (!nextUrls[key]) URL.revokeObjectURL(url)
    }
    targetThumbnailUrls = nextUrls
  }

  function costumeThumbnailKey(target: ScratchTarget, costume: ScratchCostume, index: number) {
    return `${target.id ?? target.name}:${index}:${costume.md5ext ?? costume.assetId ?? ''}`
  }

  function targetThumbnailKey(target: ScratchTarget) {
    const costume = target.costumes[target.currentCostume ?? 0]
    return `${target.id ?? target.name}:${target.currentCostume}:${costume?.md5ext ?? costume?.assetId ?? ''}`
  }

  function costumeDisplaySize(target: ScratchTarget | undefined, costume: ScratchCostume) {
    if (target?.isStage) return '480 x 360'
    const resolution = costume.bitmapResolution && costume.bitmapResolution > 0 ? costume.bitmapResolution : 1
    const width = Math.round((costume.rotationCenterX ?? 48) * 2 / resolution)
    const height = Math.round((costume.rotationCenterY ?? 48) * 2 / resolution)
    return `${width} x ${height}`
  }

  async function loadCostumeIntoBitmapCanvas(bytes: Uint8Array, dataFormat: string, revision = assetPreviewRevision) {
    if (!bitmapCanvas) return
    if (revision !== assetPreviewRevision) return
    const width = BITMAP_STANDARD_WIDTH * BITMAP_WORKSPACE_SCALE
    const height = BITMAP_STANDARD_HEIGHT * BITMAP_WORKSPACE_SCALE
    resizeBitmapCanvas(width, height)
    const context = bitmapCanvas.getContext('2d')
    if (!context) return
    clearBitmapCanvasPreview()
    if (dataFormat !== 'svg' && dataFormat !== 'png' && dataFormat !== 'jpg' && dataFormat !== 'jpeg') return
    const type = dataFormat === 'svg' ? 'image/svg+xml' : dataFormat === 'jpg' || dataFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
    try {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = reject
        image.src = url
      })
      if (revision !== assetPreviewRevision) return
      context.clearRect(0, 0, bitmapCanvas.width, bitmapCanvas.height)
      if (image.width === bitmapCanvas.width && image.height === bitmapCanvas.height) {
        context.drawImage(image, 0, 0)
      } else {
        const artLeft = (bitmapCanvas.width - BITMAP_STANDARD_WIDTH) / 2
        const artTop = (bitmapCanvas.height - BITMAP_STANDARD_HEIGHT) / 2
        const drawWidth = Math.min(image.width || BITMAP_STANDARD_WIDTH, BITMAP_STANDARD_WIDTH)
        const drawHeight = Math.min(image.height || BITMAP_STANDARD_HEIGHT, BITMAP_STANDARD_HEIGHT)
        context.drawImage(image, artLeft + (BITMAP_STANDARD_WIDTH - drawWidth) / 2, artTop + (BITMAP_STANDARD_HEIGHT - drawHeight) / 2, drawWidth, drawHeight)
      }
    } catch {
      // Keep a blank bitmap canvas if the browser cannot decode this asset.
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  function resizeBitmapCanvas(width: number, height: number) {
    if (!bitmapCanvas) return
    if (bitmapCanvas.width !== width) bitmapCanvas.width = width
    if (bitmapCanvas.height !== height) bitmapCanvas.height = height
    bitmapCanvasWidth = width
    bitmapCanvasHeight = height
    if (bitmapPaperScope?.view?.element) {
      const paperCanvas = bitmapPaperScope.view.element as HTMLCanvasElement
      paperCanvas.width = width
      paperCanvas.height = height
      bitmapPaperScope.view.viewSize = new bitmapPaperScope.Size(width, height)
    }
  }

  async function ensureBitmapPaperScope() {
    if (!bitmapCanvas) return undefined
    if (!bitmapPaperModule) {
      const imported = await import('paper/dist/paper-core')
      bitmapPaperModule = ('default' in imported ? imported.default : imported) as typeof paperCore
    }
    if (!bitmapPaperScope) {
      bitmapPaperScope = new bitmapPaperModule.PaperScope()
      const paperCanvas = document.createElement('canvas')
      paperCanvas.width = bitmapCanvas.width
      paperCanvas.height = bitmapCanvas.height
      bitmapPaperScope.setup(paperCanvas)
    }
    return bitmapPaperScope
  }

  async function refreshSoundWaveform(target: ScratchTarget) {
    const revision = assetPreviewRevision
    const loaded = target.sounds[selectedSoundIndex] ? await editableSoundBuffer(target, selectedSoundIndex) : undefined
    if (revision !== assetPreviewRevision) return
    soundWaveform = loaded ? wavPeaks(loaded.wav, 64) : []
    soundTrimStart = 0
    soundTrimEnd = 1
    soundPlayhead = 0
  }

  async function fillCurrentCostume() {
    if (!selectedTarget) return
    await captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0)
    const index = selectedTarget.currentCostume ?? 0
    const width = selectedTarget.isStage ? 480 : 96
    const height = selectedTarget.isStage ? 360 : 96
    const paint = vectorPaintStyle(width, height)
    const fill = `${paint.defs}<rect width="${width}" height="${height}" fill="${paint.fill}"/>`
    const svg = await svgWithInsertedShape(selectedTarget, index, fill, 'prepend')
    await vm.updateCostume(
      selectedTarget.name,
      index,
      {
        dataFormat: 'svg',
        rotationCenterX: selectedTarget.costumes[index]?.rotationCenterX ?? (selectedTarget.isStage ? 240 : 48),
        rotationCenterY: selectedTarget.costumes[index]?.rotationCenterY ?? (selectedTarget.isStage ? 180 : 48),
      },
      new TextEncoder().encode(svg),
    )
    status = 'Costume painted'
  }

  async function saveVectorCostume(center?: { x: number; y: number }) {
    if (!selectedTarget) return
    await captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0)
    const index = selectedTarget.currentCostume ?? 0
    const width = 480
    const height = 360
    const shape = vectorShapeMarkup({
      shape: vectorShape,
      width,
      height,
      center,
      paint: vectorPaintStyle(width, height),
      strokeColor,
      strokeWidth,
      opacity: vectorOpacity,
      text: vectorText,
    })
    const svg = await svgWithInsertedShape(selectedTarget, index, shape, 'append')
    await vm.updateCostume(selectedTarget.name, index, {
      dataFormat: 'svg',
      rotationCenterX: 240,
      rotationCenterY: 180,
    }, new TextEncoder().encode(svg))
    vectorObjects = await paperVectorObjectList(svg)
    selectedVectorObjectIndex = vectorObjects.at(-1)?.index ?? selectedVectorObjectIndex
    selectedVectorObjectIndices = selectedVectorObjectIndex >= 0 ? [selectedVectorObjectIndex] : []
    status = 'Vector costume saved'
  }

  async function saveVectorBrushStroke(points: Array<{ x: number; y: number }>) {
    if (!selectedTarget || points.length === 0) return
    await captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0)
    const index = selectedTarget.currentCostume ?? 0
    const width = 480
    const height = 360
    const paint = vectorPaintStyle(width, height)
    const path = await vectorBrushPathData(points, strokeColor, strokeWidth)
    const shape = `${paint.defs}${vectorBrushMarkup({ path, strokeColor, strokeWidth, opacity: vectorOpacity })}`
    const svg = await svgWithInsertedShape(selectedTarget, index, shape, 'append')
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(svg))
    vectorObjects = await paperVectorObjectList(svg)
    selectedVectorObjectIndex = vectorObjects.at(-1)?.index ?? selectedVectorObjectIndex
    selectedVectorObjectIndices = selectedVectorObjectIndex >= 0 ? [selectedVectorObjectIndex] : []
    status = 'Vector brush stroke saved'
  }

  async function saveVectorShapeInRect(shape: 'rect' | 'oval' | 'line', rect: { x: number; y: number; width: number; height: number }) {
    if (!selectedTarget) return
    await captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0)
    const index = selectedTarget.currentCostume ?? 0
    const width = 480
    const height = 360
    const paint = vectorPaintStyle(width, height)
    const markup = vectorShapeInRectMarkup({ shape, rect, paint, strokeColor, strokeWidth, opacity: vectorOpacity })
    const svg = await svgWithInsertedShape(selectedTarget, index, markup, 'append')
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(svg))
    vectorObjects = await paperVectorObjectList(svg)
    selectedVectorObjectIndex = vectorObjects.at(-1)?.index ?? selectedVectorObjectIndex
    selectedVectorObjectIndices = selectedVectorObjectIndex >= 0 ? [selectedVectorObjectIndex] : []
    status = 'Vector shape saved'
  }

  async function fillVectorObjectAtPoint(point: { x: number; y: number }) {
    const targetIndex = vectorObjectIndexAtPoint(point)
    if (targetIndex < 0) return
    selectedVectorObjectIndex = targetIndex
    selectedVectorObjectIndices = [targetIndex]
    await editVectorObject('style')
  }

  async function eraseVectorObjectAtPoint(point: { x: number; y: number }) {
    const targetIndex = vectorObjectIndexAtPoint(point)
    if (targetIndex < 0) return
    selectedVectorObjectIndex = targetIndex
    selectedVectorObjectIndices = [targetIndex]
    await editVectorObject('delete')
  }

  async function svgWithInsertedShape(target: ScratchTarget, index: number, shape: string, mode: 'append' | 'prepend') {
    const costume = target.costumes[index]
    const width = 480
    const height = 360
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key && costume?.dataFormat === 'svg' ? await vm.loadAsset(key, 'svg') : undefined
    const existing = bytes && costume ? svgTextForVectorEditor(new TextDecoder().decode(bytes), target, costume) : ''
    if (/<\/svg\s*>/i.test(existing)) {
      return mode === 'prepend'
        ? existing.replace(/(<svg\b[^>]*>)/i, `$1${shape}`)
        : existing.replace(/<\/svg\s*>/i, `${shape}</svg>`)
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shape}</svg>`
  }

  function vectorPaintStyle(width: number, height: number) {
    if (paintGradient === 'solid') return { defs: '', fill: paintColor }
    const id = `paint-${Date.now().toString(36)}-${Math.floor(Math.random() * 9999)}`
    const stops = `<stop offset="0" stop-color="${paintColor}"/><stop offset="1" stop-color="${secondaryPaintColor}"/>`
    if (paintGradient === 'radial') {
      return {
        defs: `<defs><radialGradient id="${id}" cx="50%" cy="50%" r="70%">${stops}</radialGradient></defs>`,
        fill: `url(#${id})`,
      }
    }
    const gradientAttrs = paintGradient === 'vertical'
      ? `x1="0" y1="0" x2="0" y2="${height}"`
      : `x1="0" y1="0" x2="${width}" y2="0"`
    return {
      defs: `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" ${gradientAttrs}>${stops}</linearGradient></defs>`,
      fill: `url(#${id})`,
    }
  }

  async function updateCostumeRotationCenter(axis: 'x' | 'y', event: Event) {
    if (!selectedTarget) return
    const index = selectedTarget.currentCostume ?? 0
    const costume = selectedTarget.costumes[index]
    if (!costume) return
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    await vm.updateCostume(selectedTarget.name, index, axis === 'x' ? { rotationCenterX: value } : { rotationCenterY: value })
    status = 'Rotation center updated'
  }

  async function editVectorObject(action: 'delete' | 'duplicate' | 'front' | 'back' | 'forward' | 'backward' | 'style' | 'left' | 'right' | 'up' | 'down' | 'group' | 'ungroup' | 'align-left' | 'align-center' | 'align-right' | 'align-top' | 'align-middle' | 'align-bottom') {
    if (!selectedTarget || selectedVectorObjectIndex < 0) return
    const index = selectedTarget.currentCostume ?? 0
    const loaded = await currentSvgDocument(selectedTarget, index)
    if (!loaded) return
    const { doc, svg } = loaded
    const children = editableSvgChildren(svg)
    const selectedIndices = normalizedVectorSelection(children.length)
    const element = children[selectedVectorObjectIndex]
    if (!element) return
    await captureCostumeHistory(selectedTarget, index)
    if (action === 'group') {
      const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
      const first = children[selectedIndices[0] ?? selectedVectorObjectIndex]
      if (!first) return
      svg.insertBefore(group, first)
      for (const selectedIndex of selectedIndices) {
        const child = children[selectedIndex]
        if (child) group.appendChild(child)
      }
      selectedVectorObjectIndex = editableSvgChildren(svg).indexOf(group)
      selectedVectorObjectIndices = [selectedVectorObjectIndex]
    } else if (action === 'ungroup') {
      const groups = selectedIndices.map((selectedIndex) => children[selectedIndex]).filter((child): child is Element => child?.tagName.toLowerCase() === 'g')
      for (const group of groups) {
        const groupChildren = Array.from(group.children)
        for (const child of groupChildren) svg.insertBefore(child, group)
        group.remove()
      }
      selectedVectorObjectIndex = Math.max(0, Math.min(selectedVectorObjectIndex, editableSvgChildren(svg).length - 1))
      selectedVectorObjectIndices = []
    } else if (action.startsWith('align-')) {
      await alignVectorElements(selectedIndices.map((selectedIndex) => children[selectedIndex]).filter((child): child is Element => Boolean(child)), action)
    } else if (action === 'delete') {
      for (const selectedIndex of [...selectedIndices].sort((a, b) => b - a)) children[selectedIndex]?.remove()
      selectedVectorObjectIndex = -1
      selectedVectorObjectIndices = []
    } else if (action === 'duplicate') {
      let lastClone: Element | undefined
      for (const selectedIndex of selectedIndices) {
        const source = children[selectedIndex]
        if (!source) continue
        const clone = source.cloneNode(true) as Element
        addTranslate(clone, 8, 8)
        svg.insertBefore(clone, source.nextSibling)
        lastClone = clone
      }
      if (lastClone) selectedVectorObjectIndex = editableSvgChildren(svg).indexOf(lastClone)
      selectedVectorObjectIndices = lastClone ? [selectedVectorObjectIndex] : []
    } else if (action === 'front') {
      for (const selectedIndex of selectedIndices) {
        const child = children[selectedIndex]
        if (child) svg.appendChild(child)
      }
      selectedVectorObjectIndex = editableSvgChildren(svg).length - 1
      selectedVectorObjectIndices = []
    } else if (action === 'back') {
      for (const selectedIndex of [...selectedIndices].reverse()) {
        const child = children[selectedIndex]
        if (child) svg.insertBefore(child, children[0] ?? null)
      }
      selectedVectorObjectIndex = 0
      selectedVectorObjectIndices = []
    } else if (action === 'forward') {
      for (const selectedIndex of [...selectedIndices].sort((a, b) => b - a)) {
        const child = children[selectedIndex]
        const next = child?.nextElementSibling
        if (child && next) svg.insertBefore(next, child)
      }
      selectedVectorObjectIndex = Math.min(editableSvgChildren(svg).length - 1, selectedVectorObjectIndex + 1)
      selectedVectorObjectIndices = []
    } else if (action === 'backward') {
      for (const selectedIndex of selectedIndices) {
        const child = children[selectedIndex]
        const previous = child?.previousElementSibling
        if (child && previous) svg.insertBefore(child, previous)
      }
      selectedVectorObjectIndex = Math.max(0, selectedVectorObjectIndex - 1)
      selectedVectorObjectIndices = []
    } else if (action === 'style') {
      for (const selectedIndex of selectedIndices) {
        const child = children[selectedIndex]
        if (!child) continue
        child.setAttribute('fill', paintColor)
        child.setAttribute('stroke', strokeColor)
        child.setAttribute('stroke-width', String(Math.max(0, strokeWidth)))
        child.setAttribute('opacity', String(Math.max(0, Math.min(1, vectorOpacity / 100))))
      }
    } else {
      const step = 4
      for (const selectedIndex of selectedIndices) {
        const child = children[selectedIndex]
        if (child) await moveVectorElementBy(child, action === 'left' ? -step : action === 'right' ? step : 0, action === 'up' ? -step : action === 'down' ? step : 0)
      }
    }
    const nextSvg = new XMLSerializer().serializeToString(doc.documentElement)
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(nextSvg))
    vectorObjects = await paperVectorObjectList(nextSvg)
    await refreshCostumePreview(vm.getTarget(selectedTarget.name) ?? selectedTarget)
    status = 'Vector object edited'
  }

  async function deleteBitmapSelection() {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas || !bitmapSelection || !selectedTarget) return
    const rect = selectedBitmapRect()
    if (rect.width <= 0 || rect.height <= 0) return
    context.clearRect(rect.x, rect.y, rect.width, rect.height)
    bitmapSelection = undefined
    await saveBitmapCostume('Bitmap selection deleted')
    status = 'Bitmap selection deleted'
  }

  async function deleteEditorSelection() {
    if (selectedTab !== 'costumes') return
    if (costumeEditMode === 'vector') {
      if (selectedVectorObjectIndex >= 0 || selectedVectorObjectIndices.length > 0) await editVectorObject('delete')
      return
    }
    if (bitmapSelection) await deleteBitmapSelection()
  }

  function selectVectorObject(index: number, append = false) {
    selectedVectorObjectIndex = index
    if (append) {
      selectedVectorObjectIndices = selectedVectorObjectIndices.includes(index)
        ? selectedVectorObjectIndices.filter((item) => item !== index)
        : [...selectedVectorObjectIndices, index].sort((a, b) => a - b)
    } else {
      selectedVectorObjectIndices = [index]
    }
  }

  function clearVectorObjectSelection() {
    selectedVectorObjectIndex = -1
    selectedVectorObjectIndices = []
  }

  function selectVectorObjectsInRect(rect: { x: number; y: number; width: number; height: number }, append = false) {
    const matches = vectorObjects
      .filter((object) => vectorObjectIntersectsRect(object, rect))
      .map((object) => object.index)
      .sort((a, b) => a - b)
    if (append) {
      selectedVectorObjectIndices = [...new Set([...selectedVectorObjectIndices, ...matches])].sort((a, b) => a - b)
    } else {
      selectedVectorObjectIndices = matches
    }
    selectedVectorObjectIndex = selectedVectorObjectIndices.at(-1) ?? -1
  }

  function vectorObjectIntersectsRect(object: VectorObjectInfo, rect: { x: number; y: number; width: number; height: number }) {
    const left = object.boundsX ?? object.x ?? 0
    const top = object.boundsY ?? object.y ?? 0
    const width = object.boundsWidth ?? object.width ?? 0
    const height = object.boundsHeight ?? object.height ?? 0
    const right = left + width
    const bottom = top + height
    return right >= rect.x && left <= rect.x + rect.width && bottom >= rect.y && top <= rect.y + rect.height
  }

  function vectorObjectIndexAtPoint(point: { x: number; y: number }) {
    const found = [...vectorObjects].reverse().find((object) => {
      const left = object.boundsX ?? object.x ?? 0
      const top = object.boundsY ?? object.y ?? 0
      const width = object.boundsWidth ?? object.width ?? 0
      const height = object.boundsHeight ?? object.height ?? 0
      return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height
    })
    return found?.index ?? -1
  }

  function normalizedVectorSelection(length: number) {
    const fromMulti = selectedVectorObjectIndices.filter((index) => index >= 0 && index < length)
    if (fromMulti.length > 0) return [...new Set(fromMulti)].sort((a, b) => a - b)
    return selectedVectorObjectIndex >= 0 && selectedVectorObjectIndex < length ? [selectedVectorObjectIndex] : []
  }

  async function updateVectorObjectNumber(field: 'x' | 'y' | 'width' | 'height', event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    await updateVectorObject((element) => setVectorNumericAttribute(element, field, value))
  }

  async function updateVectorObjectStrokeWidth(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    strokeWidth = Math.max(0, value)
    await updateVectorObject((element) => element.setAttribute('stroke-width', String(strokeWidth)))
  }

  async function updateVectorObjectOpacity(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    vectorOpacity = Math.max(0, Math.min(100, value))
    await updateVectorObject((element) => element.setAttribute('opacity', String(vectorOpacity / 100)))
  }

  async function updateVectorObjectRotation(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    await updateVectorObject((element) => setVectorRotation(element, value))
  }

  async function rotateSelectedVectorObject(delta: number) {
    await updateVectorObject((element) => applyPaperRotation(element, delta))
  }

  async function flipSelectedVectorObject(horizontal: boolean) {
    await updateVectorObject((element) => applyPaperFlip(element, horizontal))
  }

  async function updateVectorObjectText(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value
    await updateVectorObject((element) => {
      if (element.tagName.toLowerCase() === 'text') element.textContent = value
    })
  }

  async function scaleSelectedVectorObject(factor: number) {
    await updateVectorObject((element) => applyPaperScale(element, factor))
  }

  async function moveSelectedVectorObjectBy(dx: number, dy: number, captureHistory = true) {
    if (!dx && !dy) return
    await updateVectorObjects((element) => moveVectorElementBy(element, dx, dy), captureHistory)
  }

  async function resizeSelectedVectorObjectBy(handle: VectorResizeHandle, dx: number, dy: number, captureHistory = true) {
    if (!dx && !dy) return
    await updateVectorObject((element) => resizeVectorElementBy(element, handle, dx, dy), captureHistory)
  }

  async function resizeSelectedVectorObjectFromSource(
    sourceReady: Promise<{ targetName: string; costumeIndex: number; svgText: string } | undefined>,
    objectIndex: number,
    handle: VectorResizeHandle,
    dx: number,
    dy: number,
  ) {
    if (!selectedTarget || (!dx && !dy)) return
    const source = await sourceReady
    if (!source || source.targetName !== selectedTarget.name) return
    const doc = new DOMParser().parseFromString(source.svgText, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.nodeName.toLowerCase() !== 'svg') return
    const element = editableSvgChildren(svg)[objectIndex]
    if (!element) return
    await resizeVectorElementBy(element, handle, dx, dy)
    const nextSvg = new XMLSerializer().serializeToString(doc.documentElement)
    await vm.updateCostume(source.targetName, source.costumeIndex, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(nextSvg))
    vectorObjects = await paperVectorObjectList(nextSvg)
    selectedVectorObjectIndex = objectIndex
    selectedVectorObjectIndices = [objectIndex]
    await refreshCostumePreview(vm.getTarget(source.targetName) ?? selectedTarget)
    status = 'Vector object resized'
  }

  function vectorPreviewDimensions() {
    return { width: 480, height: 360 }
  }

  function vectorObjectOverlayStyle(object: VectorObjectInfo) {
    const dims = vectorPreviewDimensions()
    const scale = Math.min(100 / dims.width, 100 / dims.height)
    const offsetX = (100 - dims.width * scale) / 2
    const offsetY = (100 - dims.height * scale) / 2
    const left = offsetX + (object.boundsX ?? object.x ?? 0) * scale
    const top = offsetY + (object.boundsY ?? object.y ?? 0) * scale
    const width = Math.max(3, (object.boundsWidth ?? object.width ?? 2) * scale)
    const height = Math.max(3, (object.boundsHeight ?? object.height ?? 2) * scale)
    const drag = vectorDrag?.index === object.index ? ` translate(${vectorDrag.dx}px, ${vectorDrag.dy}px)` : ''
    const resize = vectorResizeDrag?.index === object.index ? `width:calc(${width}% + ${vectorResizeDrag.dx}px);height:calc(${height}% + ${vectorResizeDrag.dy}px);` : `width:${width}%;height:${height}%;`
    return `left:${left}%;top:${top}%;${resize}transform:${drag};`
  }

  function vectorResizeHandleStyle(object: VectorObjectInfo, handle: VectorResizeHandle) {
    const dims = vectorPreviewDimensions()
    const scale = Math.min(100 / dims.width, 100 / dims.height)
    const offsetX = (100 - dims.width * scale) / 2
    const offsetY = (100 - dims.height * scale) / 2
    const objectLeft = object.boundsX ?? object.x ?? 0
    const objectTop = object.boundsY ?? object.y ?? 0
    const objectWidth = object.boundsWidth ?? object.width ?? 2
    const objectHeight = object.boundsHeight ?? object.height ?? 2
    const handleX = handle.includes('w') ? objectLeft : handle.includes('e') ? objectLeft + objectWidth : objectLeft + objectWidth / 2
    const handleY = handle.includes('n') ? objectTop : handle.includes('s') ? objectTop + objectHeight : objectTop + objectHeight / 2
    const left = offsetX + handleX * scale
    const top = offsetY + handleY * scale
    const drag = vectorResizeDrag?.index === object.index ? ` translate(${vectorResizeDrag.dx}px, ${vectorResizeDrag.dy}px)` : ''
    return `left:${left}%;top:${top}%;transform:translate(-50%, -50%)${drag};`
  }

  function rotationCenterOverlayStyle() {
    const costume = selectedTarget?.costumes[selectedTarget.currentCostume ?? 0]
    const dims = vectorPreviewDimensions()
    const scale = Math.min(100 / dims.width, 100 / dims.height)
    const offsetX = (100 - dims.width * scale) / 2
    const offsetY = (100 - dims.height * scale) / 2
    const centerX = costume?.rotationCenterX ?? (selectedTarget?.isStage ? 240 : 48)
    const centerY = costume?.rotationCenterY ?? (selectedTarget?.isStage ? 180 : 48)
    const drag = rotationCenterDrag ? ` translate(${rotationCenterDrag.dx}px, ${rotationCenterDrag.dy}px)` : ''
    return `left:${offsetX + centerX * scale}%;top:${offsetY + centerY * scale}%;transform:translate(-50%, -50%)${drag};`
  }

  async function beginVectorObjectDrag(object: VectorObjectInfo, event: PointerEvent) {
    if (!selectedTarget) return
    event.preventDefault()
    event.stopPropagation()
    const append = event.shiftKey || event.metaKey || event.ctrlKey
    if (append || !selectedVectorObjectIndices.includes(object.index)) selectVectorObject(object.index, append)
    const element = event.currentTarget as HTMLElement
    const host = element.parentElement
    const rect = host?.getBoundingClientRect()
    const dims = host?.dataset.vectorStageSurface === 'true' ? { width: 480, height: 360 } : vectorPreviewDimensions()
    const scale = rect ? Math.min(rect.width / dims.width, rect.height / dims.height) : 1
    element.setPointerCapture(event.pointerId)
    vectorDrag = {
      index: object.index,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      dx: 0,
      dy: 0,
      scale,
      applying: false,
      historyReady: captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0),
    }
  }

  function dragVectorObject(event: PointerEvent) {
    if (!vectorDrag || vectorDrag.pointerId !== event.pointerId) return
    vectorDrag = {
      ...vectorDrag,
      dx: event.clientX - vectorDrag.startClientX,
      dy: event.clientY - vectorDrag.startClientY,
    }
    void applyLiveVectorDrag(event.clientX, event.clientY)
  }

  async function applyLiveVectorDrag(clientX: number, clientY: number) {
    if (!vectorDrag) return
    if (vectorDrag.applying) {
      vectorDrag = { ...vectorDrag, pendingClientX: clientX, pendingClientY: clientY }
      return
    }
    const drag = { ...vectorDrag, applying: true }
    vectorDrag = drag
    const dx = (clientX - drag.startClientX) / (drag.scale || 1)
    const dy = (clientY - drag.startClientY) / (drag.scale || 1)
    if (dx || dy) {
      await drag.historyReady
      await moveSelectedVectorObjectBy(dx, dy, false)
    }
    if (!vectorDrag || vectorDrag.pointerId !== drag.pointerId) return
    const pendingClientX = vectorDrag.pendingClientX
    const pendingClientY = vectorDrag.pendingClientY
    vectorDrag = {
      ...vectorDrag,
      startClientX: clientX,
      startClientY: clientY,
      dx: 0,
      dy: 0,
      applying: false,
      pendingClientX: undefined,
      pendingClientY: undefined,
    }
    if (pendingClientX !== undefined && pendingClientY !== undefined && (pendingClientX !== clientX || pendingClientY !== clientY)) {
      void applyLiveVectorDrag(pendingClientX, pendingClientY)
    }
  }

  async function endVectorObjectDrag(event: PointerEvent) {
    if (!vectorDrag || vectorDrag.pointerId !== event.pointerId) return
    await applyLiveVectorDrag(event.clientX, event.clientY)
    vectorDrag = undefined
    status = 'Vector object moved'
  }

  function beginVectorObjectResize(object: VectorObjectInfo, handle: VectorResizeHandle, event: PointerEvent) {
    if (!selectedTarget) return
    event.preventDefault()
    event.stopPropagation()
    selectVectorObject(object.index, false)
    const element = event.currentTarget as HTMLElement
    const host = element.parentElement
    const rect = host?.getBoundingClientRect()
    const dims = host?.dataset.vectorStageSurface === 'true' ? { width: 480, height: 360 } : vectorPreviewDimensions()
    const scale = rect ? Math.min(rect.width / dims.width, rect.height / dims.height) : 1
    const target = selectedTarget
    const costumeIndex = target.currentCostume ?? 0
    element.setPointerCapture(event.pointerId)
    vectorResizeDrag = {
      index: object.index,
      handle,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      dx: 0,
      dy: 0,
      scale,
      applying: false,
      historyReady: captureCostumeHistory(target, costumeIndex),
      sourceReady: currentSvgDocument(target, costumeIndex).then((loaded) => loaded
        ? { targetName: target.name, costumeIndex, svgText: new XMLSerializer().serializeToString(loaded.doc.documentElement) }
        : undefined),
    }
  }

  function dragVectorObjectResize(event: PointerEvent) {
    if (!vectorResizeDrag || vectorResizeDrag.pointerId !== event.pointerId) return
    vectorResizeDrag = {
      ...vectorResizeDrag,
      dx: event.clientX - vectorResizeDrag.startClientX,
      dy: event.clientY - vectorResizeDrag.startClientY,
    }
    void applyLiveVectorResize(event.clientX, event.clientY)
  }

  async function applyLiveVectorResize(clientX: number, clientY: number) {
    if (!vectorResizeDrag) return
    if (vectorResizeDrag.applying) {
      vectorResizeDrag = { ...vectorResizeDrag, pendingClientX: clientX, pendingClientY: clientY }
      return
    }
    const drag = { ...vectorResizeDrag, applying: true }
    vectorResizeDrag = drag
    const dw = (clientX - drag.startClientX) / (drag.scale || 1)
    const dh = (clientY - drag.startClientY) / (drag.scale || 1)
    if (dw || dh) {
      await drag.historyReady
      await resizeSelectedVectorObjectFromSource(drag.sourceReady, drag.index, drag.handle, dw, dh)
    }
    if (!vectorResizeDrag || vectorResizeDrag.pointerId !== drag.pointerId) return
    const pendingClientX = vectorResizeDrag.pendingClientX
    const pendingClientY = vectorResizeDrag.pendingClientY
    vectorResizeDrag = {
      ...vectorResizeDrag,
      dx: 0,
      dy: 0,
      applying: false,
      pendingClientX: undefined,
      pendingClientY: undefined,
    }
    if (pendingClientX !== undefined && pendingClientY !== undefined && (pendingClientX !== clientX || pendingClientY !== clientY)) {
      void applyLiveVectorResize(pendingClientX, pendingClientY)
    }
  }

  async function endVectorObjectResize(event: PointerEvent) {
    if (!vectorResizeDrag || vectorResizeDrag.pointerId !== event.pointerId) return
    await applyLiveVectorResize(event.clientX, event.clientY)
    vectorResizeDrag = undefined
    status = 'Vector object resized'
  }

  function beginVectorPathPointDrag(object: VectorObjectInfo, pointIndex: number, event: PointerEvent) {
    if (!selectedTarget) return
    const point = object.points?.find((item) => item.index === pointIndex)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    selectVectorObject(object.index, false)
    const element = event.currentTarget as HTMLElement
    const host = element.parentElement
    const rect = host?.getBoundingClientRect()
    const dims = host?.dataset.vectorStageSurface === 'true' ? { width: 480, height: 360 } : vectorPreviewDimensions()
    const scale = rect ? Math.min(rect.width / dims.width, rect.height / dims.height) : 1
    element.setPointerCapture(event.pointerId)
    vectorPathPointDrag = {
      objectIndex: object.index,
      pointIndex,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: point.x,
      startY: point.y,
      scale,
      applying: false,
      historyReady: captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0),
    }
  }

  function dragVectorPathPoint(event: PointerEvent) {
    if (!vectorPathPointDrag || vectorPathPointDrag.pointerId !== event.pointerId) return
    void applyLiveVectorPathPointDrag(event.clientX, event.clientY, event.shiftKey, event.altKey)
  }

  async function applyLiveVectorPathPointDrag(clientX: number, clientY: number, shiftKey = false, altKey = false) {
    if (!vectorPathPointDrag) return
    if (vectorPathPointDrag.applying) {
      vectorPathPointDrag = { ...vectorPathPointDrag, pendingClientX: clientX, pendingClientY: clientY, pendingShiftKey: shiftKey, pendingAltKey: altKey }
      return
    }
    const drag = { ...vectorPathPointDrag, applying: true }
    vectorPathPointDrag = drag
    const delta = pathPointDragDelta((clientX - drag.startClientX) / (drag.scale || 1), (clientY - drag.startClientY) / (drag.scale || 1), shiftKey)
    const nextX = drag.startX + delta.x
    const nextY = drag.startY + delta.y
    await drag.historyReady
    await updateVectorPathPoint(drag.objectIndex, drag.pointIndex, nextX, nextY, altKey, false)
    if (!vectorPathPointDrag || vectorPathPointDrag.pointerId !== drag.pointerId) return
    const pendingClientX = vectorPathPointDrag.pendingClientX
    const pendingClientY = vectorPathPointDrag.pendingClientY
    const pendingShiftKey = vectorPathPointDrag.pendingShiftKey
    const pendingAltKey = vectorPathPointDrag.pendingAltKey
    vectorPathPointDrag = {
      ...vectorPathPointDrag,
      applying: false,
      pendingClientX: undefined,
      pendingClientY: undefined,
      pendingShiftKey: undefined,
      pendingAltKey: undefined,
    }
    if (pendingClientX !== undefined && pendingClientY !== undefined && (pendingClientX !== clientX || pendingClientY !== clientY)) {
      void applyLiveVectorPathPointDrag(pendingClientX, pendingClientY, pendingShiftKey, pendingAltKey)
    }
  }

  async function endVectorPathPointDrag(event: PointerEvent) {
    if (!vectorPathPointDrag || vectorPathPointDrag.pointerId !== event.pointerId) return
    await applyLiveVectorPathPointDrag(event.clientX, event.clientY, event.shiftKey, event.altKey)
    vectorPathPointDrag = undefined
    status = 'Vector path point moved'
  }

  function pathPointDragDelta(dx: number, dy: number, snap: boolean) {
    if (!snap) return { x: dx, y: dy }
    const length = Math.hypot(dx, dy)
    if (!length) return { x: 0, y: 0 }
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    return { x: Math.cos(angle) * length, y: Math.sin(angle) * length }
  }

  function beginRotationCenterDrag(event: PointerEvent) {
    if (!selectedTarget) return
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget as HTMLElement
    const host = element.parentElement
    const rect = host?.getBoundingClientRect()
    const dims = vectorPreviewDimensions()
    const scale = rect ? Math.min(rect.width / dims.width, rect.height / dims.height) : 1
    element.setPointerCapture(event.pointerId)
    rotationCenterDrag = { pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, dx: 0, dy: 0, scale }
  }

  function dragRotationCenter(event: PointerEvent) {
    if (!rotationCenterDrag || rotationCenterDrag.pointerId !== event.pointerId) return
    rotationCenterDrag = {
      ...rotationCenterDrag,
      dx: event.clientX - rotationCenterDrag.startClientX,
      dy: event.clientY - rotationCenterDrag.startClientY,
    }
  }

  async function endRotationCenterDrag(event: PointerEvent) {
    if (!selectedTarget || !rotationCenterDrag || rotationCenterDrag.pointerId !== event.pointerId) return
    const drag = rotationCenterDrag
    rotationCenterDrag = undefined
    const index = selectedTarget.currentCostume ?? 0
    const costume = selectedTarget.costumes[index]
    if (!costume) return
    const scale = drag.scale || 1
    await vm.updateCostume(selectedTarget.name, index, {
      rotationCenterX: (costume.rotationCenterX ?? (selectedTarget.isStage ? 240 : 48)) + drag.dx / scale,
      rotationCenterY: (costume.rotationCenterY ?? (selectedTarget.isStage ? 180 : 48)) + drag.dy / scale,
    })
    status = 'Rotation center updated'
  }

  async function updateVectorObject(mutator: (element: Element) => void | Promise<void>, captureHistory = true) {
    if (!selectedTarget || selectedVectorObjectIndex < 0) return
    const index = selectedTarget.currentCostume ?? 0
    const loaded = await currentSvgDocument(selectedTarget, index)
    if (!loaded) return
    const { doc, svg } = loaded
    const element = editableSvgChildren(svg)[selectedVectorObjectIndex]
    if (!element) return
    if (captureHistory) await captureCostumeHistory(selectedTarget, index)
    await mutator(element)
    const nextSvg = new XMLSerializer().serializeToString(doc.documentElement)
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(nextSvg))
    vectorObjects = await paperVectorObjectList(nextSvg)
    await refreshCostumePreview(vm.getTarget(selectedTarget.name) ?? selectedTarget)
    status = 'Vector object updated'
  }

  async function updateVectorPathPoint(objectIndex: number, pointIndex: number, x: number, y: number, splitHandles = false, captureHistory = true) {
    if (!selectedTarget || objectIndex < 0) return
    const index = selectedTarget.currentCostume ?? 0
    const loaded = await currentSvgDocument(selectedTarget, index)
    if (!loaded) return
    const { doc, svg } = loaded
    const element = editableSvgChildren(svg)[objectIndex]
    if (!element) return
    if (captureHistory) await captureCostumeHistory(selectedTarget, index)
    await moveVectorEditablePoint(element, pointIndex, x, y, splitHandles)
    const nextSvg = new XMLSerializer().serializeToString(doc.documentElement)
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(nextSvg))
    vectorObjects = await paperVectorObjectList(nextSvg)
    selectedVectorObjectIndex = objectIndex
    selectedVectorObjectIndices = [objectIndex]
    await refreshCostumePreview(vm.getTarget(selectedTarget.name) ?? selectedTarget)
    status = 'Vector path point updated'
  }

  async function updateVectorObjects(mutator: (element: Element) => void | Promise<void>, captureHistory = true) {
    if (!selectedTarget) return
    const index = selectedTarget.currentCostume ?? 0
    const loaded = await currentSvgDocument(selectedTarget, index)
    if (!loaded) return
    const { doc, svg } = loaded
    const children = editableSvgChildren(svg)
    const selectedIndices = normalizedVectorSelection(children.length)
    if (selectedIndices.length === 0) return
    if (captureHistory) await captureCostumeHistory(selectedTarget, index)
    for (const selectedIndex of selectedIndices) {
      const element = children[selectedIndex]
      if (element) await mutator(element)
    }
    const nextSvg = new XMLSerializer().serializeToString(doc.documentElement)
    await vm.updateCostume(selectedTarget.name, index, { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }, new TextEncoder().encode(nextSvg))
    vectorObjects = await paperVectorObjectList(nextSvg)
    selectedVectorObjectIndices = selectedVectorObjectIndices.filter((item) => vectorObjects.some((object) => object.index === item))
    selectedVectorObjectIndex = selectedVectorObjectIndices.at(-1) ?? -1
    await refreshCostumePreview(vm.getTarget(selectedTarget.name) ?? selectedTarget)
    status = 'Vector objects updated'
  }

  async function currentSvgDocument(target: ScratchTarget, index: number) {
    const costume = target.costumes[index]
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key && costume?.dataFormat === 'svg' ? await vm.loadAsset(key, 'svg') : undefined
    if (!bytes) return undefined
    const doc = new DOMParser().parseFromString(svgTextForVectorEditor(new TextDecoder().decode(bytes), target, costume), 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.nodeName.toLowerCase() !== 'svg') return undefined
    return { doc, svg }
  }

  async function clearBitmapCanvas() {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    clearBitmapCanvasPreview()
    await saveBitmapCostume('Bitmap cleared')
    status = 'Bitmap cleared'
  }

  function clearBitmapCanvasPreview() {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas) return
    context.clearRect(0, 0, bitmapCanvas.width, bitmapCanvas.height)
    bitmapSelection = undefined
  }

  async function beginBitmapPaint(event: MouseEvent) {
    const context = bitmapCanvas?.getContext('2d')
    const point = bitmapPoint(event)
    if (!pointInBitmapWorkspace(point)) return
    if (bitmapTool === 'select' && context && bitmapSelection && pointInBitmapRect(point, bitmapSelection)) {
      const selection = context.getImageData(bitmapSelection.x, bitmapSelection.y, bitmapSelection.width, bitmapSelection.height)
      context.clearRect(bitmapSelection.x, bitmapSelection.y, bitmapSelection.width, bitmapSelection.height)
      bitmapMoveDrag = {
        startPoint: point,
        startSelection: { ...bitmapSelection },
        base: context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height),
        selection,
      }
      isBitmapPainting = true
      status = 'Moving bitmap selection'
      return
    }
    isBitmapPainting = true
    bitmapStart = point
    bitmapPreviewBase = context && bitmapCanvas ? context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height) : undefined
    bitmapPaperPoints = [point]
    if (bitmapTool === 'select') {
      status = 'Selecting bitmap area'
      return
    }
    if (bitmapTool === 'fill') {
      floodFillBitmap(event)
      isBitmapPainting = false
      bitmapStart = undefined
      await saveBitmapCostume('Bitmap fill saved')
      return
    }
    if (bitmapTool === 'text') {
      drawBitmapText(event)
      isBitmapPainting = false
      bitmapStart = undefined
      bitmapPreviewBase = undefined
      bitmapPaperPoints = []
      await saveBitmapCostume('Bitmap text saved')
      return
    }
    if (bitmapTool === 'brush' || bitmapTool === 'eraser' || bitmapTool === 'line' || bitmapTool === 'rect' || bitmapTool === 'oval') {
      await ensureBitmapPaperScope()
    }
    paintBitmap(event)
  }

  function paintBitmap(event: MouseEvent) {
    if (!isBitmapPainting || !bitmapCanvas) return
    const context = bitmapCanvas.getContext('2d')
    if (!context) return
    if (bitmapMoveDrag) {
      const point = clampBitmapPoint(bitmapPoint(event))
      const nextX = Math.round(Math.max(0, Math.min(bitmapCanvas.width - bitmapMoveDrag.startSelection.width, bitmapMoveDrag.startSelection.x + point.x - bitmapMoveDrag.startPoint.x)))
      const nextY = Math.round(Math.max(0, Math.min(bitmapCanvas.height - bitmapMoveDrag.startSelection.height, bitmapMoveDrag.startSelection.y + point.y - bitmapMoveDrag.startPoint.y)))
      context.putImageData(bitmapMoveDrag.base, 0, 0)
      context.putImageData(bitmapMoveDrag.selection, nextX, nextY)
      bitmapSelection = { ...bitmapMoveDrag.startSelection, x: nextX, y: nextY }
      return
    }
    if (bitmapTool === 'line' || bitmapTool === 'rect' || bitmapTool === 'oval' || bitmapTool === 'select') {
      drawBitmapDraft(event)
      return
    }
    if (bitmapTool !== 'brush' && bitmapTool !== 'eraser') return
    const { x, y } = clampBitmapPoint(bitmapPoint(event))
    bitmapPaperPoints = [...bitmapPaperPoints, { x, y }]
    drawBitmapPaperStroke()
  }

  async function endBitmapPaint(event: MouseEvent) {
    if (bitmapMoveDrag) {
      paintBitmap(event)
      bitmapMoveDrag = undefined
      isBitmapPainting = false
      bitmapStart = undefined
      await saveBitmapCostume('Bitmap selection moved')
      status = 'Bitmap selection moved'
      return
    }
    if (!isBitmapPainting || !bitmapCanvas || !bitmapStart) {
      isBitmapPainting = false
      return
    }
    const shouldCommit = bitmapTool !== 'select'
    if (bitmapTool === 'select') {
      restoreBitmapPreviewBase()
      const point = clampBitmapPoint(bitmapPoint(event))
      const dragged = Math.abs(point.x - bitmapStart.x) > 2 || Math.abs(point.y - bitmapStart.y) > 2
      bitmapSelection = dragged ? bitmapRect(bitmapStart, point) : bitmapOpaqueSelectionFromPoint(point)
    }
    if (bitmapTool === 'line' || bitmapTool === 'rect' || bitmapTool === 'oval') drawBitmapShape(event, true)
    isBitmapPainting = false
    bitmapStart = undefined
    bitmapPreviewBase = undefined
    bitmapPaperPoints = []
    if (bitmapTool === 'select' && bitmapSelection) status = `Selected ${bitmapSelection.width} x ${bitmapSelection.height}`
    if (shouldCommit) await saveBitmapCostume('Bitmap edit saved')
  }

  function bitmapPoint(event: MouseEvent) {
    const rect = bitmapCanvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * bitmapCanvas.width,
      y: ((event.clientY - rect.top) / rect.height) * bitmapCanvas.height,
    }
  }

  function pointInBitmapWorkspace(point: { x: number; y: number }) {
    return Boolean(bitmapCanvas && point.x >= 0 && point.y >= 0 && point.x <= bitmapCanvas.width && point.y <= bitmapCanvas.height)
  }

  function clampBitmapPoint(point: { x: number; y: number }) {
    if (!bitmapCanvas) return point
    return {
      x: Math.max(0, Math.min(bitmapCanvas.width, point.x)),
      y: Math.max(0, Math.min(bitmapCanvas.height, point.y)),
    }
  }

  function restoreBitmapPreviewBase() {
    const context = bitmapCanvas?.getContext('2d')
    if (context && bitmapPreviewBase) context.putImageData(bitmapPreviewBase, 0, 0)
  }

  function drawBitmapDraft(event: MouseEvent) {
    if (!bitmapStart) return
    restoreBitmapPreviewBase()
    if (bitmapTool === 'select') {
      drawBitmapSelectionOutline(bitmapRect(bitmapStart, clampBitmapPoint(bitmapPoint(event))))
      return
    }
    drawBitmapShape(event, false)
  }

  function drawBitmapSelectionOutline(rect: { x: number; y: number; width: number; height: number }) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    context.save()
    context.strokeStyle = '#2563eb'
    context.lineWidth = 1
    context.setLineDash([5, 4])
    context.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.width - 1), Math.max(1, rect.height - 1))
    context.restore()
  }

  function drawBitmapShape(event: MouseEvent, fromPreviewBase = false) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapStart) return
    if (fromPreviewBase) restoreBitmapPreviewBase()
    const end = clampBitmapPoint(bitmapPoint(event))
    const left = Math.min(bitmapStart.x, end.x)
    const top = Math.min(bitmapStart.y, end.y)
    const width = Math.abs(end.x - bitmapStart.x)
    const height = Math.abs(end.y - bitmapStart.y)
    context.strokeStyle = strokeColor
    context.fillStyle = bitmapPaintStyle(context, left, top, width, height)
    context.lineWidth = brushSize
    if (bitmapTool === 'line') {
      context.beginPath()
      context.moveTo(bitmapStart.x, bitmapStart.y)
      context.lineTo(end.x, end.y)
      context.stroke()
    } else if (bitmapTool === 'rect') {
      context.fillRect(left, top, width, height)
      context.strokeRect(left, top, width, height)
    } else if (bitmapTool === 'oval') {
      context.beginPath()
      context.ellipse(left + width / 2, top + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2)
      context.fill()
      context.stroke()
    }
  }

  function drawBitmapPaperStroke() {
    const context = bitmapCanvas?.getContext('2d')
    const scope = bitmapPaperScope
    if (!context || !scope || bitmapPaperPoints.length === 0) return
    restoreBitmapPreviewBase()
    context.save()
    context.globalCompositeOperation = bitmapTool === 'eraser' ? 'destination-out' : 'source-over'
    context.strokeStyle = paintColor
    context.lineWidth = bitmapTool === 'eraser' ? brushSize * 3.4 : brushSize * 2
    context.lineCap = 'round'
    context.lineJoin = 'round'
    const path = new scope.Path()
    for (const point of bitmapPaperPoints) path.add(new scope.Point(point.x, point.y))
    if (path.segments.length === 1) {
      const [point] = bitmapPaperPoints
      context.beginPath()
      context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2)
      if (bitmapTool === 'eraser') context.fillStyle = '#000'
      else context.fillStyle = paintColor
      context.fill()
    } else {
      if (path.segments.length > 2) path.smooth({ type: 'continuous' })
      drawPaperPathOnCanvas(context, path)
    }
    path.remove()
    context.restore()
  }

  function drawPaperPathOnCanvas(context: CanvasRenderingContext2D, path: paper.Path) {
    const first = path.firstSegment
    if (!first) return
    context.beginPath()
    context.moveTo(first.point.x, first.point.y)
    for (const curve of path.curves) {
      const from = curve.segment1
      const to = curve.segment2
      const handle1 = from.point.add(from.handleOut)
      const handle2 = to.point.add(to.handleIn)
      context.bezierCurveTo(handle1.x, handle1.y, handle2.x, handle2.y, to.point.x, to.point.y)
    }
    context.stroke()
  }

  function bitmapRect(start: { x: number; y: number }, end: { x: number; y: number }) {
    const left = Math.max(0, Math.floor(Math.min(start.x, end.x)))
    const top = Math.max(0, Math.floor(Math.min(start.y, end.y)))
    const right = Math.min(bitmapCanvas.width, Math.ceil(Math.max(start.x, end.x)))
    const bottom = Math.min(bitmapCanvas.height, Math.ceil(Math.max(start.y, end.y)))
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  }

  function selectedBitmapRect() {
    return bitmapSelection ?? { x: 0, y: 0, width: bitmapCanvas?.width ?? 0, height: bitmapCanvas?.height ?? 0 }
  }

  function pointInBitmapRect(point: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }) {
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  }

  function bitmapOpaqueSelectionFromPoint(point: { x: number; y: number }) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas) return bitmapRect(point, point)
    const image = context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height)
    const width = image.width
    const height = image.height
    const startX = Math.max(0, Math.min(width - 1, Math.floor(point.x)))
    const startY = Math.max(0, Math.min(height - 1, Math.floor(point.y)))
    const alphaAt = (x: number, y: number) => image.data[(y * width + x) * 4 + 3]
    const opaque = (x: number, y: number) => alphaAt(x, y) > 8
    if (!opaque(startX, startY)) {
      let left = width
      let top = height
      let right = -1
      let bottom = -1
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!opaque(x, y)) continue
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x)
          bottom = Math.max(bottom, y)
        }
      }
      return right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : bitmapRect(point, point)
    }

    const seen = new Uint8Array(width * height)
    const stack = [{ x: startX, y: startY }]
    seen[startY * width + startX] = 1
    let left = startX
    let top = startY
    let right = startX
    let bottom = startY
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      left = Math.min(left, current.x)
      top = Math.min(top, current.y)
      right = Math.max(right, current.x)
      bottom = Math.max(bottom, current.y)
      const next = [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]
      for (const item of next) {
        if (item.x < 0 || item.y < 0 || item.x >= width || item.y >= height) continue
        const index = item.y * width + item.x
        if (seen[index] || !opaque(item.x, item.y)) continue
        seen[index] = 1
        stack.push(item)
      }
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  }

  async function copyBitmapSelection(cut = false) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas) return
    const rect = selectedBitmapRect()
    if (rect.width <= 0 || rect.height <= 0) return
    bitmapClipboard = context.getImageData(rect.x, rect.y, rect.width, rect.height)
    if (cut) {
      context.clearRect(rect.x, rect.y, rect.width, rect.height)
      await saveBitmapCostume('Bitmap cut saved')
      status = 'Bitmap selection cut'
    } else {
      status = 'Bitmap selection copied'
    }
  }

  async function pasteBitmapSelection() {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapClipboard) return
    const rect = bitmapSelection ?? { x: 0, y: 0, width: bitmapClipboard.width, height: bitmapClipboard.height }
    context.putImageData(bitmapClipboard, rect.x, rect.y)
    bitmapSelection = { x: rect.x, y: rect.y, width: bitmapClipboard.width, height: bitmapClipboard.height }
    await saveBitmapCostume('Bitmap paste saved')
    status = 'Bitmap selection pasted'
  }

  async function cropBitmapSelection() {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas || !bitmapSelection) return
    const selection = context.getImageData(bitmapSelection.x, bitmapSelection.y, bitmapSelection.width, bitmapSelection.height)
    resizeBitmapCanvas(selection.width, selection.height)
    bitmapCanvas.getContext('2d')?.putImageData(selection, 0, 0)
    bitmapSelection = { x: 0, y: 0, width: selection.width, height: selection.height }
    await saveBitmapCostume('Bitmap crop saved')
    status = 'Bitmap cropped'
  }

  function drawBitmapText(event: MouseEvent) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    const { x, y } = bitmapPoint(event)
    const fontSize = Math.max(12, brushSize * 4)
    context.fillStyle = bitmapPaintStyle(context, x - fontSize * vectorText.length * 0.25, y - fontSize, Math.max(fontSize, fontSize * vectorText.length * 0.55), fontSize * 1.25)
    context.strokeStyle = strokeColor
    context.lineWidth = 1
    context.font = `${fontSize}px Arial, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.strokeText(vectorText, x, y)
    context.fillText(vectorText, x, y)
  }

  function floodFillBitmap(event: MouseEvent) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    const point = bitmapPoint(event)
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    if (x < 0 || y < 0 || x >= bitmapCanvas.width || y >= bitmapCanvas.height) return
    const image = context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height)
    const data = image.data
    const start = (y * bitmapCanvas.width + x) * 4
    const target = [data[start] ?? 0, data[start + 1] ?? 0, data[start + 2] ?? 0, data[start + 3] ?? 0]
    const fill = hexToRgb(paintColor)
    if (!fill || colorDistance(target, [fill.r, fill.g, fill.b, 255]) < 2) return
    const stack = [[x, y]]
    while (stack.length) {
      const next = stack.pop()
      if (!next) continue
      const [cx, cy] = next
      if (cx < 0 || cy < 0 || cx >= bitmapCanvas.width || cy >= bitmapCanvas.height) continue
      const offset = (cy * bitmapCanvas.width + cx) * 4
      const current = [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0]
      if (colorDistance(current, target) > 4) continue
      data[offset] = fill.r
      data[offset + 1] = fill.g
      data[offset + 2] = fill.b
      data[offset + 3] = 255
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
    }
    context.putImageData(image, 0, 0)
  }

  function bitmapPaintStyle(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): string | CanvasGradient {
    if (paintGradient === 'solid') return paintColor
    if (paintGradient === 'radial') {
      const radius = Math.max(width, height) / 2
      const gradient = context.createRadialGradient(x + width / 2, y + height / 2, 0, x + width / 2, y + height / 2, Math.max(1, radius))
      gradient.addColorStop(0, paintColor)
      gradient.addColorStop(1, secondaryPaintColor)
      return gradient
    }
    const gradient = paintGradient === 'vertical'
      ? context.createLinearGradient(x, y, x, y + height)
      : context.createLinearGradient(x, y, x + width, y)
    gradient.addColorStop(0, paintColor)
    gradient.addColorStop(1, secondaryPaintColor)
    return gradient
  }

  function pickBitmapColor(event: MouseEvent) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    const rect = bitmapCanvas.getBoundingClientRect()
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * bitmapCanvas.width)
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * bitmapCanvas.height)
    const [r, g, b] = context.getImageData(x, y, 1, 1).data
    paintColor = `#${[r, g, b].map((value) => (value ?? 0).toString(16).padStart(2, '0')).join('')}`
    status = 'Color picked'
  }

  async function saveBitmapCostume(nextStatus = 'Bitmap costume saved') {
    if (!selectedTarget || !bitmapCanvas) return
    await captureCostumeHistory(selectedTarget, selectedTarget.currentCostume ?? 0)
    await updateBitmapCostumeFromCanvas(selectedTarget, selectedTarget.currentCostume ?? 0, bitmapCanvas)
    status = nextStatus
  }

  async function updateBitmapCostumeFromCanvas(target: ScratchTarget, index: number, source: HTMLCanvasElement) {
    const costume = target.costumes[index]
    const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/png'))
    if (!blob) return
    const bitmapResolution = target.isStage ? 1 : 2
    if (target.name === selectedTarget?.name && index === (selectedTarget.currentCostume ?? 0)) skipNextBitmapCanvasReloadKey = costumeReloadKey(target, index)
    await vm.updateCostume(
      target.name,
      index,
      {
        dataFormat: 'png',
        bitmapResolution,
        rotationCenterX: costume?.rotationCenterX ?? source.width / (2 * bitmapResolution),
        rotationCenterY: costume?.rotationCenterY ?? source.height / (2 * bitmapResolution),
      },
      new Uint8Array(await blob.arrayBuffer()),
    )
  }

  async function rasterizeCostumeToCanvas(bytes: Uint8Array, dataFormat: string, width: number, height: number) {
    const type = dataFormat === 'svg'
      ? 'image/svg+xml'
      : dataFormat === 'jpg' || dataFormat === 'jpeg'
        ? 'image/jpeg'
        : 'image/png'
    const body = dataFormat === 'svg' ? svgWithCrispRendering(bytes) : new Uint8Array(bytes)
    const url = URL.createObjectURL(new Blob([body], { type }))
    try {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = reject
        image.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return undefined
      context.imageSmoothingEnabled = true
      context.clearRect(0, 0, width, height)
      if (image.width === width && image.height === height) {
        context.drawImage(image, 0, 0)
      } else if (width === BITMAP_STANDARD_WIDTH * BITMAP_WORKSPACE_SCALE && height === BITMAP_STANDARD_HEIGHT * BITMAP_WORKSPACE_SCALE) {
        const artLeft = (width - BITMAP_STANDARD_WIDTH) / 2
        const artTop = (height - BITMAP_STANDARD_HEIGHT) / 2
        context.drawImage(image, artLeft, artTop, BITMAP_STANDARD_WIDTH, BITMAP_STANDARD_HEIGHT)
      } else {
        context.drawImage(image, 0, 0, width, height)
      }
      return canvas
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  function svgWithCrispRendering(bytes: Uint8Array) {
    const text = new TextDecoder().decode(bytes)
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.nodeName.toLowerCase() !== 'svg') return new Uint8Array(bytes)
    svg.setAttribute('shape-rendering', 'crispEdges')
    return new TextEncoder().encode(new XMLSerializer().serializeToString(svg))
  }

  function trimmedBitmapBounds(source: HTMLCanvasElement) {
    const context = source.getContext('2d')
    if (!context) return undefined
    const image = context.getImageData(0, 0, source.width, source.height)
    let left = source.width
    let top = source.height
    let right = -1
    let bottom = -1
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if ((image.data[(y * source.width + x) * 4 + 3] ?? 0) === 0) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
    return right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : undefined
  }

  async function bitmapTrimmedImageElement(source: HTMLCanvasElement, trim: { x: number; y: number; width: number; height: number }, bitmapResolution: number) {
    const cropped = document.createElement('canvas')
    cropped.width = trim.width
    cropped.height = trim.height
    const context = cropped.getContext('2d')
    if (!context) return ''
    context.drawImage(source, trim.x, trim.y, trim.width, trim.height, 0, 0, trim.width, trim.height)
    const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, 'image/png'))
    if (!blob) return ''
    const data = bytesToLocalBase64(new Uint8Array(await blob.arrayBuffer()))
    const x = trim.x / bitmapResolution
    const y = trim.y / bitmapResolution
    const width = trim.width / bitmapResolution
    const height = trim.height / bitmapResolution
    const href = `data:image/png;base64,${data}`
    return `<image href="${href}" xlink:href="${href}" x="${x}" y="${y}" width="${width}" height="${height}"/>`
  }

  async function convertCurrentCostumeToBitmap() {
    if (!selectedTarget) return
    const index = selectedTarget.currentCostume ?? 0
    const costume = selectedTarget.costumes[index]
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
    if (!costume || !bytes) return
    await captureCostumeHistory(selectedTarget, index)
    const targetWidth = BITMAP_STANDARD_WIDTH * BITMAP_WORKSPACE_SCALE
    const targetHeight = BITMAP_STANDARD_HEIGHT * BITMAP_WORKSPACE_SCALE
    const canvas = await rasterizeCostumeToCanvas(bytes, costume.dataFormat ?? '', targetWidth, targetHeight)
    if (!canvas) return
    await updateBitmapCostumeFromCanvas(selectedTarget, index, canvas)
    if (bitmapCanvas) {
      resizeBitmapCanvas(targetWidth, targetHeight)
      const context = bitmapCanvas.getContext('2d')
      context?.clearRect(0, 0, bitmapCanvas.width, bitmapCanvas.height)
      context?.drawImage(canvas, 0, 0)
    }
    status = 'Converted to bitmap'
  }

  async function convertCurrentCostumeToVector() {
    if (!selectedTarget || !bitmapCanvas) return
    const index = selectedTarget.currentCostume ?? 0
    const costume = selectedTarget.costumes[index]
    if (!costume) return
    await captureCostumeHistory(selectedTarget, index)
    const bitmapResolution = selectedTarget.isStage ? 1 : 2
    const width = bitmapCanvas.width / bitmapResolution
    const height = bitmapCanvas.height / bitmapResolution
    const trim = trimmedBitmapBounds(bitmapCanvas)
    const imageMarkup = trim ? await bitmapTrimmedImageElement(bitmapCanvas, trim, bitmapResolution) : ''
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${imageMarkup}</svg>`
    await vm.updateCostume(selectedTarget.name, index, {
      dataFormat: 'svg',
      bitmapResolution: 1,
      rotationCenterX: costume.rotationCenterX ?? width / 2,
      rotationCenterY: costume.rotationCenterY ?? height / 2,
    }, new TextEncoder().encode(svg))
    vectorObjects = await paperVectorObjectList(svg)
    status = 'Converted to vector'
  }

  async function flipBitmap(horizontal: boolean) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context) return
    const image = context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height)
    const copy = new ImageData(bitmapCanvas.width, bitmapCanvas.height)
    for (let y = 0; y < bitmapCanvas.height; y += 1) {
      for (let x = 0; x < bitmapCanvas.width; x += 1) {
        const sourceX = horizontal ? bitmapCanvas.width - 1 - x : x
        const sourceY = horizontal ? y : bitmapCanvas.height - 1 - y
        const source = (sourceY * bitmapCanvas.width + sourceX) * 4
        const dest = (y * bitmapCanvas.width + x) * 4
        copy.data[dest] = image.data[source] ?? 0
        copy.data[dest + 1] = image.data[source + 1] ?? 0
        copy.data[dest + 2] = image.data[source + 2] ?? 0
        copy.data[dest + 3] = image.data[source + 3] ?? 0
      }
    }
    context.putImageData(copy, 0, 0)
    await saveBitmapCostume(horizontal ? 'Bitmap horizontal flip saved' : 'Bitmap vertical flip saved')
    status = horizontal ? 'Bitmap flipped horizontally' : 'Bitmap flipped vertically'
  }

  async function rotateBitmap(clockwise: boolean) {
    const context = bitmapCanvas?.getContext('2d')
    if (!context || !bitmapCanvas) return
    const source = document.createElement('canvas')
    source.width = bitmapCanvas.width
    source.height = bitmapCanvas.height
    source.getContext('2d')?.putImageData(context.getImageData(0, 0, bitmapCanvas.width, bitmapCanvas.height), 0, 0)
    resizeBitmapCanvas(source.height, source.width)
    const nextContext = bitmapCanvas.getContext('2d')
    if (!nextContext) return
    nextContext.save()
    if (clockwise) {
      nextContext.translate(bitmapCanvas.width, 0)
      nextContext.rotate(Math.PI / 2)
    } else {
      nextContext.translate(0, bitmapCanvas.height)
      nextContext.rotate(-Math.PI / 2)
    }
    nextContext.drawImage(source, 0, 0)
    nextContext.restore()
    bitmapSelection = undefined
    await saveBitmapCostume(clockwise ? 'Bitmap rotated right saved' : 'Bitmap rotated left saved')
    status = clockwise ? 'Bitmap rotated right' : 'Bitmap rotated left'
  }

  async function addSound() {
    if (!selectedTarget) return
    selectedSoundIndex = await createBlankSound(selectedTarget.name)
    status = 'Sound added'
  }

  async function createBlankSound(targetName: string) {
    const target = vm.getTarget(targetName)
    const index = target?.sounds.length ?? 0
    const bytes = floatSamplesToWav(new Float32Array(Math.floor(44100 * 0.5)), 44100)
    const asset = await vm.storeAsset(bytes, 'wav')
    vm.addSound(targetName, {
      name: `sound${index + 1}`,
      dataFormat: 'wav',
      assetId: asset.assetId,
      md5ext: asset.md5ext,
      format: '',
      rate: 44100,
      sampleCount: Math.max(0, Math.floor((bytes.length - 44) / 2)),
    })
    return index
  }

  async function uploadSound(event: Event) {
    if (!selectedTarget) return
    const targetId = selectedTarget.id ?? selectedTarget.name
    const input = event.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    if (files.length === 0) return
    try {
      let uploaded = 0
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        await new Promise<void>((resolve, reject) => {
          vmSoundUpload(bytes, file.type || mimeFromFilename(file.name), uploadStorage, async (sound) => {
            const uploadedBytes = assetBytes(sound.asset.data)
            const editableBytes = await bytesAsEditableWav(uploadedBytes, sound.dataFormat)
            const stored = await vm.storeAsset(editableBytes, 'wav')
            const target = vm.getTarget(targetId)
            vm.addSound(targetId, {
              name: file.name.replace(/\.[^.]+$/, ''),
              dataFormat: 'wav',
              assetId: stored.assetId,
              md5ext: stored.md5ext,
              rate: wavSampleRate(editableBytes),
              sampleCount: wavSampleCount(editableBytes),
            })
            if (targetId === (selectedTarget?.id ?? selectedTarget?.name)) selectedSoundIndex = Math.max(0, (target?.sounds.length ?? 1) - 1)
            uploaded += 1
            resolve()
          }, reject)
        })
      }
      status = `${uploaded} sound${uploaded === 1 ? '' : 's'} uploaded`
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not upload sound'
    } finally {
      input.value = ''
    }
  }

  function renameSound(index: number) {
    if (!selectedTarget) return
    const current = selectedTarget.sounds[index]
    const name = window.prompt('Sound name', current?.name ?? '')
    if (!name) return
    vm.renameSound(selectedTarget.name, index, name)
    status = 'Sound renamed'
  }

  function updateSoundName(index: number, event: Event) {
    if (!selectedTarget) return
    const name = (event.currentTarget as HTMLInputElement).value.trim()
    if (!name || name === selectedTarget.sounds[index]?.name) return
    vm.renameSound(selectedTarget.name, index, name)
    status = 'Sound renamed'
  }

  async function selectSound(index: number) {
    selectedSoundIndex = index
    if (selectedTarget) await refreshSoundWaveform(selectedTarget)
    status = 'Sound selected'
  }

  async function deleteSound(index: number) {
    if (!selectedTarget) return
    const soundCount = selectedTarget.sounds.length
    lastDeletedSound = await currentHistoryEntry({ kind: 'sound', targetName: selectedTarget.name, index, meta: selectedTarget.sounds[index]!, bytes: new Uint8Array() })
    lastDeletedSoundRestore = vm.deleteSound(selectedTarget.name, index)
    if (index < selectedSoundIndex) selectedSoundIndex -= 1
    else if (index === selectedSoundIndex) selectedSoundIndex = Math.max(0, Math.min(index, soundCount - 2))
    status = 'Sound deleted'
  }

  async function restoreDeletedSound() {
    if (!selectedTarget) return
    if (lastDeletedSoundRestore) {
      lastDeletedSoundRestore()
    } else if (lastDeletedSound) {
      const asset = await vm.storeAsset(lastDeletedSound.bytes, lastDeletedSound.meta.dataFormat ?? 'wav')
      vm.addSound(selectedTarget.name, { ...lastDeletedSound.meta, assetId: asset.assetId, md5ext: asset.md5ext })
    } else {
      return
    }
    lastDeletedSound = undefined
    lastDeletedSoundRestore = undefined
    status = 'Sound restored'
  }

  function duplicateSound(index: number) {
    if (!selectedTarget) return
    vm.duplicateSound(selectedTarget.name, index)
    selectedSoundIndex = index + 1
    status = 'Sound duplicated'
  }

  async function copySound(index: number) {
    if (!selectedTarget) return
    const editIndex = await ensureSoundForEditing(selectedTarget.name, index)
    const target = vm.getTarget(selectedTarget.name)
    if (!target) return
    const sound = target.sounds[editIndex]
    const loaded = await editableSoundBuffer(target, editIndex)
    if (!sound || !loaded) return
    const range = soundSelectionByteRange(loaded.wav)
    soundClipboard = new Uint8Array(loaded.wav.slice(range.start, range.end))
    soundClipboardMeta = structuredClone(sound)
    selectedSoundIndex = editIndex
    status = 'Sound copied'
  }

  async function pasteSound(index: number) {
    if (!selectedTarget || !soundClipboard || !soundClipboardMeta) return
    const editIndex = await ensureSoundForEditing(selectedTarget.name, index)
    const target = vm.getTarget(selectedTarget.name)
    if (!target) return
    await captureSoundHistory(target, editIndex)
    const loaded = await editableSoundBuffer(target, editIndex)
    const current = loaded?.wav ?? floatSamplesToWav(new Float32Array(0), 44100)
    const merged = replaceSoundSelection(current, soundClipboard)
    await vm.updateSoundBuffer(target.name, editIndex, merged, {
      ...soundClipboardMeta,
      name: target.sounds[editIndex]?.name ?? soundClipboardMeta.name ?? 'sound',
      dataFormat: 'wav',
      rate: wavSampleRate(merged),
      sampleCount: Math.max(0, Math.floor((merged.length - 44) / 2)),
    })
    selectedSoundIndex = editIndex
    await refreshSoundWaveform(target)
    status = 'Sound pasted'
  }

  async function copySoundToNew(index: number) {
    if (!selectedTarget) return
    const editIndex = await ensureSoundForEditing(selectedTarget.name, index)
    const target = vm.getTarget(selectedTarget.name)
    if (!target) return
    const sound = target.sounds[editIndex]
    const loaded = await editableSoundBuffer(target, editIndex)
    if (!sound || !loaded) return
    const range = soundSelectionByteRange(loaded.wav)
    const selectedBytes = wavWithSamples(loaded.wav, loaded.wav.slice(range.start, range.end))
    const asset = await vm.storeAsset(selectedBytes, 'wav')
    vm.addSound(target.name, {
      ...structuredClone(sound),
      name: `${sound.name} copy`,
      dataFormat: 'wav',
      assetId: asset.assetId,
      md5ext: asset.md5ext,
      rate: wavSampleRate(selectedBytes),
      sampleCount: Math.max(0, Math.floor((selectedBytes.length - 44) / 2)),
    })
    selectedSoundIndex = target.sounds.length
    status = 'Sound copied to new'
  }

  async function exportSound(index: number) {
    if (!selectedTarget) return
    const sound = selectedTarget.sounds[index]
    const bytes = await vm.getSoundBuffer(selectedTarget.name, index)
    if (!sound || !bytes) return
    const type = sound.dataFormat === 'mp3' ? 'audio/mpeg' : sound.dataFormat === 'wav' ? 'audio/wav' : 'application/octet-stream'
    const href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
    const link = document.createElement('a')
    link.href = href
    link.download = `${sound.name}.${sound.dataFormat ?? 'wav'}`
    link.click()
    URL.revokeObjectURL(href)
    status = 'Sound exported'
  }

  function moveSound(index: number, direction: -1 | 1) {
    if (!selectedTarget) return
    vm.reorderSound(selectedTarget.name, index, index + direction)
    selectedSoundIndex = Math.max(0, Math.min((selectedTarget.sounds.length ?? 1) - 1, index + direction))
    status = 'Sound reordered'
  }

  async function generateTone() {
    if (!selectedTarget) return
    const bytes = makeToneWav()
    if (selectedTarget.sounds.length === 0) {
      const asset = await vm.storeAsset(bytes, 'wav')
      vm.addSound(selectedTarget.name, {
        name: 'tone',
        dataFormat: 'wav',
        assetId: asset.assetId,
        md5ext: asset.md5ext,
        rate: 44100,
        sampleCount: 4410,
      })
      selectedSoundIndex = 0
    } else {
      await captureSoundHistory(selectedTarget, selectedSoundIndex)
      await vm.updateSoundBuffer(selectedTarget.name, selectedSoundIndex, bytes, {
        name: selectedTarget.sounds[selectedSoundIndex]?.name ?? 'tone',
        dataFormat: 'wav',
        rate: 44100,
        sampleCount: 4410,
      })
    }
    status = 'Tone generated'
  }

  async function startRecordingSound() {
    if (!selectedTarget || isRecordingSound) return
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordingContext = new AudioContext()
      recordingSampleRate = recordingContext.sampleRate
      recordingChunks = []
      const source = recordingContext.createMediaStreamSource(recordingStream)
      recordingProcessor = recordingContext.createScriptProcessor(4096, 1, 1)
      recordingProcessor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        recordingChunks.push(new Float32Array(input))
        let sum = 0
        for (const sample of input) sum += sample * sample
        recordingLevel = Math.min(1, Math.sqrt(sum / Math.max(1, input.length)) * 3)
      }
      source.connect(recordingProcessor)
      recordingProcessor.connect(recordingContext.destination)
      isRecordingSound = true
      status = 'Recording'
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not start recording'
    }
  }

  async function stopRecordingSound(save = true) {
    if (!isRecordingSound && !recordingContext && !recordingStream) return
    recordingProcessor?.disconnect()
    recordingProcessor = undefined
    recordingStream?.getTracks().forEach((track) => track.stop())
    recordingStream = undefined
    await recordingContext?.close().catch(() => undefined)
    recordingContext = undefined
    isRecordingSound = false
    recordingLevel = 0
    if (!save || !selectedTarget || recordingChunks.length === 0) {
      status = save ? 'Recording cancelled' : status
      recordingChunks = []
      return
    }
    const samples = trimSilence(mergeFloatSamples(recordingChunks))
    const wav = floatSamplesToWav(samples.length > 0 ? samples : mergeFloatSamples(recordingChunks), recordingSampleRate)
    const asset = await vm.storeAsset(wav, 'wav')
    vm.addSound(selectedTarget.name, {
      name: `recording${selectedTarget.sounds.length + 1}`,
      dataFormat: 'wav',
      assetId: asset.assetId,
      md5ext: asset.md5ext,
      rate: recordingSampleRate,
      sampleCount: Math.max(0, Math.floor((wav.length - 44) / 2)),
    })
    selectedSoundIndex = selectedTarget.sounds.length
    recordingChunks = []
    status = 'Recording added'
  }

  async function editSound(index: number, effect: SoundEffect) {
    if (!selectedTarget) return
    const editIndex = await ensureSoundForEditing(selectedTarget.name, index)
    const target = vm.getTarget(selectedTarget.name)
    if (!target) return
    const sound = target.sounds[editIndex]
    const loaded = await editableSoundBuffer(target, editIndex)
    if (!sound || !loaded) return
    selectedSoundIndex = editIndex
    await captureSoundHistory(target, editIndex, loaded.original)
    const edited = transformWavBytes(loaded.wav, effect, soundTrimStart, soundTrimEnd, (message) => {
      status = message
    })
    await vm.updateSoundBuffer(target.name, editIndex, edited, {
      name: sound.name,
      dataFormat: 'wav',
      rate: wavSampleRate(edited),
      sampleCount: Math.max(0, Math.floor((edited.length - 44) / 2)),
    })
    await refreshSoundWaveform(target)
    status = `Sound ${effect}`
  }

  async function deleteSoundSelection(index: number, keepSelection = false) {
    if (!selectedTarget) return
    const editIndex = await ensureSoundForEditing(selectedTarget.name, index)
    const target = vm.getTarget(selectedTarget.name)
    if (!target) return
    const sound = target.sounds[editIndex]
    const loaded = await editableSoundBuffer(target, editIndex)
    if (!sound || !loaded) return
    selectedSoundIndex = editIndex
    await captureSoundHistory(target, editIndex, loaded.original)
    const range = soundSelectionByteRange(loaded.wav)
    const nextSamples = keepSelection
      ? loaded.wav.slice(range.start, range.end)
      : concatBytes(loaded.wav.slice(44, range.start), loaded.wav.slice(range.end))
    const edited = wavWithSamples(loaded.wav, nextSamples)
    await vm.updateSoundBuffer(target.name, editIndex, edited, {
      name: sound.name,
      dataFormat: 'wav',
      rate: wavSampleRate(edited),
      sampleCount: Math.max(0, Math.floor((edited.length - 44) / 2)),
    })
    soundTrimStart = 0
    soundTrimEnd = 1
    await refreshSoundWaveform(target)
    status = keepSelection ? 'Sound cropped' : 'Sound selection deleted'
  }

  async function ensureSoundForEditing(targetName: string, index: number) {
    const target = vm.getTarget(targetName)
    if (target?.sounds[index]) return index
    return createBlankSound(targetName)
  }

  async function captureCostumeHistory(target: ScratchTarget, index: number) {
    const costume = target.costumes[index]
    const key = costume?.md5ext ?? costume?.assetId
    const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
    if (!costume || !bytes) return
    const entry: AssetHistoryEntry = { kind: 'costume', targetName: target.name, index, meta: structuredClone(costume), bytes: new Uint8Array(bytes) }
    assetUndoStack = [...assetUndoStack, entry].slice(-30)
    assetRedoStack = []
  }

  async function captureSoundHistory(target: ScratchTarget, index: number, existingBytes?: Uint8Array) {
    const sound = target.sounds[index]
    const bytes = existingBytes ?? (await vm.getSoundBuffer(target.name, index))
    if (!sound || !bytes) return
    const entry: AssetHistoryEntry = { kind: 'sound', targetName: target.name, index, meta: structuredClone(sound), bytes: new Uint8Array(bytes) }
    assetUndoStack = [...assetUndoStack, entry].slice(-30)
    assetRedoStack = []
  }

  async function editableSoundBuffer(target: ScratchTarget, index: number) {
    const sound = target.sounds[index]
    const bytes = await vm.getSoundBuffer(target.name, index)
    if (!sound || !bytes) return undefined
    try {
      return {
        sound,
        original: bytes,
        wav: await bytesAsEditableWav(bytes, sound.dataFormat),
      }
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not decode sound'
      return undefined
    }
  }

  async function bytesAsEditableWav(bytes: Uint8Array, dataFormat = 'wav') {
    const decodedAdpcm = decodeImaAdpcmWav(bytes)
    if (decodedAdpcm) return decodedAdpcm
    if (dataFormat === 'wav' && isWav(bytes)) return bytes
    if (typeof AudioContext === 'undefined') throw new Error('Audio editing is not available in this browser')
    const context = new AudioContext()
    try {
      const audioBytes = new Uint8Array(bytes)
      const buffer = await context.decodeAudioData(audioBytes.buffer)
      const samples = new Float32Array(buffer.length)
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const source = buffer.getChannelData(channel)
        for (let i = 0; i < source.length; i += 1) samples[i] = (samples[i] ?? 0) + (source[i] ?? 0) / buffer.numberOfChannels
      }
      return floatSamplesToWav(samples, buffer.sampleRate)
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  function isWav(bytes: Uint8Array) {
    return bytes.length >= 44 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE'
  }

  function wavSampleRate(bytes: Uint8Array) {
    return isWav(bytes) ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true) : 44100
  }

  function wavSampleCount(bytes: Uint8Array) {
    return Math.max(0, Math.floor(Math.max(0, bytes.length - 44) / 2))
  }

  async function undoAssetEdit() {
    const entry = assetUndoStack.at(-1)
    if (!entry) return
    const current = await currentHistoryEntry(entry)
    assetUndoStack = assetUndoStack.slice(0, -1)
    if (current) assetRedoStack = [...assetRedoStack, current].slice(-30)
    await restoreHistoryEntry(entry)
    status = 'Asset undo'
  }

  async function redoAssetEdit() {
    const entry = assetRedoStack.at(-1)
    if (!entry) return
    const current = await currentHistoryEntry(entry)
    assetRedoStack = assetRedoStack.slice(0, -1)
    if (current) assetUndoStack = [...assetUndoStack, current].slice(-30)
    await restoreHistoryEntry(entry)
    status = 'Asset redo'
  }

  async function currentHistoryEntry(entry: AssetHistoryEntry): Promise<AssetHistoryEntry | undefined> {
    const target = vm.getTarget(entry.targetName)
    if (!target) return undefined
    if (entry.kind === 'costume') {
      const costume = target.costumes[entry.index]
      const key = costume?.md5ext ?? costume?.assetId
      const bytes = key ? await vm.loadAsset(key, costume.dataFormat ?? '') : undefined
      return costume && bytes ? { kind: 'costume', targetName: target.name, index: entry.index, meta: structuredClone(costume), bytes: new Uint8Array(bytes) } : undefined
    }
    const sound = target.sounds[entry.index]
    const bytes = sound ? await vm.getSoundBuffer(target.name, entry.index) : undefined
    return sound && bytes ? { kind: 'sound', targetName: target.name, index: entry.index, meta: structuredClone(sound), bytes: new Uint8Array(bytes) } : undefined
  }

  async function restoreHistoryEntry(entry: AssetHistoryEntry) {
    if (entry.kind === 'costume') {
      await vm.updateCostume(entry.targetName, entry.index, entry.meta, entry.bytes)
    } else {
      await vm.updateSoundBuffer(entry.targetName, entry.index, entry.bytes, entry.meta)
    }
    await refreshAssetEditorPreviews()
  }

  function createRuntimeAudioEngine() {
    return {
      playSound: (targetName: string, sound: ScratchSound) => playRuntimeSound(targetName, sound),
      stopAllSounds: stopRuntimeSounds,
      stopSoundsForTarget: stopRuntimeSounds,
      setVolume: (targetName: string, volume: number) => {
        runtimeAudioVolumes.set(targetName, volume)
      },
      setEffects: (targetName: string, effects: Record<string, number>) => {
        runtimeAudioEffects.set(targetName, effects)
      },
    }
  }

  async function playRuntimeSound(targetName: string, sound: ScratchSound) {
    try {
      const context = ensureRuntimeAudioContext()
      await context.resume().catch(() => undefined)
      const key = sound.md5ext ?? sound.assetId
      const bytes = key ? await vm.loadAsset(key, sound.dataFormat ?? '') : undefined
      if (!bytes || bytes.byteLength === 0) return
      const audioBytes = new Uint8Array(bytes)
      const buffer = await decodeRuntimeAudio(context, audioBytes, sound.dataFormat)
      return playDecodedRuntimeBuffer(targetName, buffer)
    } catch (error) {
      status = error instanceof Error ? `Could not play sound: ${error.message}` : 'Could not play sound'
      return
    }
  }

  async function decodeRuntimeAudio(context: AudioContext, bytes: Uint8Array, dataFormat = '') {
    try {
      return await context.decodeAudioData(audioDecodeBuffer(bytes))
    } catch {
      const decodedAdpcm = decodeImaAdpcmWav(bytes)
      if (decodedAdpcm) return context.decodeAudioData(audioDecodeBuffer(decodedAdpcm))
      if (dataFormat && dataFormat !== 'wav') {
        const editable = await bytesAsEditableWav(bytes, dataFormat)
        return context.decodeAudioData(audioDecodeBuffer(editable))
      }
      throw new Error('Unable to decode audio data')
    }
  }

  function audioDecodeBuffer(bytes: Uint8Array) {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return buffer
  }

  async function playDecodedRuntimeBuffer(targetName: string, buffer: AudioBuffer) {
    const context = ensureRuntimeAudioContext()
    const source = context.createBufferSource()
    const gain = context.createGain()
    const panner = new StereoPannerNode(context)
    const effects = runtimeAudioEffects.get(targetName) ?? {}
    const target = vm.getTarget(targetName)
    const volume = runtimeAudioVolumes.get(targetName) ?? target?.volume ?? 100
    source.buffer = buffer
    source.detune.value = effects.PITCH ?? effects.pitch ?? 0
    gain.gain.value = Math.max(0, Math.min(1, volume / 100))
    panner.pan.value = Math.max(-1, Math.min(1, (effects.PAN ?? effects.pan ?? 0) / 100))
    source.connect(gain)
    gain.connect(panner)
    panner.connect(context.destination)
    runtimeAudioSources = [...runtimeAudioSources, source]
    return new Promise<void>((resolve) => {
      source.onended = () => {
        runtimeAudioSources = runtimeAudioSources.filter((item) => item !== source)
        resolve()
      }
      source.start()
    })
  }

  function stopRuntimeSounds() {
    for (const source of runtimeAudioSources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // The source may already have ended.
      }
    }
    runtimeAudioSources = []
  }

  async function previewSound(index: number) {
    if (!selectedTarget) return
    stopPreviewSound()
    const context = ensurePreviewAudioContext()
    void context.resume()
    const target = vm.getTarget(selectedTarget.name)
    if (!target?.sounds[index]) return
    const editIndex = index
    const sound = target.sounds[editIndex]
    const loaded = await editableSoundBuffer(target, editIndex)
    if (!sound || !loaded) return
    selectedSoundIndex = editIndex
    const range = soundSelectionByteRange(loaded.wav)
    const playBytes = range.start > 44 || range.end < loaded.wav.length ? wavWithSamples(loaded.wav, loaded.wav.slice(range.start, range.end)) : loaded.wav
    try {
      const audioBytes = new Uint8Array(playBytes)
      const buffer = await context.decodeAudioData(audioBytes.buffer)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      previewSelectionStart = Math.min(soundTrimStart, soundTrimEnd)
      previewSelectionEnd = Math.max(soundTrimStart, soundTrimEnd)
      previewAudioDuration = buffer.duration
      previewAudioStartedAt = context.currentTime
      previewAudio = source
      previewPlayheadTimer = setInterval(updatePreviewPlayhead, 33)
      source.onended = stopPreviewSound
      source.start()
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not play sound'
      stopPreviewSound()
    }
  }

  function stopPreviewSound() {
    if (previewPlayheadTimer) {
      clearInterval(previewPlayheadTimer)
      previewPlayheadTimer = undefined
    }
    if (previewAudio) {
      previewAudio.onended = null
      try {
        previewAudio.stop()
      } catch {
        // The source may already have ended.
      }
      previewAudio = undefined
    }
    soundPlayhead = 0
  }

  function ensurePreviewAudioContext() {
    previewAudioContext ??= new AudioContext()
    return previewAudioContext
  }

  function ensureRuntimeAudioContext() {
    runtimeAudioContext ??= new AudioContext()
    return runtimeAudioContext
  }

  function updatePreviewPlayhead() {
    if (!previewAudioContext || previewAudioDuration <= 0) return
    const elapsed = Math.max(0, previewAudioContext.currentTime - previewAudioStartedAt)
    const progress = Math.min(1, elapsed / previewAudioDuration)
    soundPlayhead = previewSelectionStart + progress * Math.max(0, previewSelectionEnd - previewSelectionStart)
  }

  function soundSelectionByteRange(bytes: Uint8Array) {
    return wavSelectionByteRange(bytes, soundTrimStart, soundTrimEnd)
  }

  function replaceSoundSelection(bytes: Uint8Array, insertSamples: Uint8Array) {
    return replaceWavSelection(bytes, insertSamples, soundTrimStart, soundTrimEnd)
  }

  function updateSoundTrim(which: 'start' | 'end', event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value) / 100
    if (which === 'start') soundTrimStart = Math.max(0, Math.min(1, Math.min(value, soundTrimEnd)))
    else soundTrimEnd = Math.max(0, Math.min(1, Math.max(value, soundTrimStart)))
  }

  function soundWaveformPosition(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
  }

  function soundWaveformPointerPosition(event: PointerEvent, host: HTMLElement) {
    const rect = host.getBoundingClientRect()
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
  }

  function beginSoundWaveformSelection(event: MouseEvent) {
    if (soundTrimDrag) return
    isSelectingSoundRange = true
    soundSelectionAnchor = soundWaveformPosition(event)
    soundTrimStart = soundSelectionAnchor
    soundTrimEnd = soundSelectionAnchor
    soundPlayhead = soundSelectionAnchor
  }

  function updateSoundWaveformSelection(event: MouseEvent) {
    if (!isSelectingSoundRange) return
    const current = soundWaveformPosition(event)
    soundTrimStart = Math.min(soundSelectionAnchor, current)
    soundTrimEnd = Math.max(soundSelectionAnchor, current)
    soundPlayhead = current
  }

  function endSoundWaveformSelection(event: MouseEvent) {
    if (!isSelectingSoundRange) return
    updateSoundWaveformSelection(event)
    isSelectingSoundRange = false
    if (Math.abs(soundTrimEnd - soundTrimStart) < 0.01) {
      soundTrimStart = 0
      soundTrimEnd = 1
    }
    status = 'Sound selection updated'
  }

  function beginSoundTrimHandle(which: 'start' | 'end', event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    soundTrimDrag = which
    const element = event.currentTarget as HTMLElement
    element.setPointerCapture(event.pointerId)
    dragSoundTrimHandle(event)
  }

  function dragSoundTrimHandle(event: PointerEvent) {
    if (!soundTrimDrag) return
    const host = (event.currentTarget as HTMLElement).parentElement
    if (!host) return
    const value = soundWaveformPointerPosition(event, host)
    if (soundTrimDrag === 'start') soundTrimStart = Math.max(0, Math.min(value, soundTrimEnd - 0.005))
    else soundTrimEnd = Math.min(1, Math.max(value, soundTrimStart + 0.005))
    soundPlayhead = value
  }

  function endSoundTrimHandle(event: PointerEvent) {
    if (!soundTrimDrag) return
    dragSoundTrimHandle(event)
    soundTrimDrag = undefined
    status = 'Sound selection updated'
  }

  function stagePosition(target: ScratchTarget) {
    const left = 50 + ((target.x ?? 0) / 480) * 100
    const top = 50 - ((target.y ?? 0) / 360) * 100
    return `left:${left}%;top:${top}%;transform:translate(-50%,-50%) rotate(${(target.direction ?? 90) - 90}deg);`
  }

  function stagePointerPosition(event: MouseEvent | PointerEvent): { x: number; y: number } {
    const data = stagePointerData(event)
    return { x: data.scratchX, y: data.scratchY }
  }

  function stagePointerData(event: MouseEvent | PointerEvent) {
    const rect = stageCanvas.getBoundingClientRect()
    const canvasX = event.clientX - rect.left
    const canvasY = event.clientY - rect.top
    return {
      x: canvasX,
      y: canvasY,
      scratchX: (canvasX / rect.width) * 480 - 240,
      scratchY: 180 - (canvasY / rect.height) * 360,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
    }
  }

  function pickSprite(event: MouseEvent) {
    if (suppressNextStageClick) {
      suppressNextStageClick = false
      event.preventDefault()
      return
    }
    const { x, y } = stagePointerPosition(event)
    const picked = renderer.pick(x, y)
    if (picked) {
      vm.selectTarget(picked)
    }
  }

  function updateMouse(event: MouseEvent | PointerEvent, patch: Record<string, unknown> = {}) {
    const data = {
      ...stagePointerData(event),
      isDown: event.buttons > 0,
      down: event.buttons > 0,
      buttons: event.buttons,
      ...patch,
    }
    if (runtimeInWorker) runtimeWorker.postMouse(data)
    else vm.postMouse(data)
  }

  function beginStageSpriteDrag(event: PointerEvent) {
    suppressNextStageClick = false
    updateMouse(event)
    if (stageSpriteDrag) cancelStageSpriteDrag()
    if (event.button !== 0) return
    const { x, y } = stagePointerPosition(event)
    const picked = renderer.pick(x, y)
    if (!picked) return
    const target = vm.getTarget(picked)
    if (!target || target.isStage) return
    vm.selectTarget(target.id ?? target.name)
    if (runtimeInWorker) runtimeWorker.startDrag(target.id ?? target.name)
    else vm.startDrag(target.id ?? target.name)
    stageCanvas.setPointerCapture(event.pointerId)
    stageSpriteDrag = {
      targetId: target.id ?? target.name,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      offsetX: x - (target.x ?? 0),
      offsetY: y - (target.y ?? 0),
      moved: false,
    }
  }

  function dragStageSprite(event: PointerEvent) {
    updateMouse(event)
    if (!stageSpriteDrag || stageSpriteDrag.pointerId !== event.pointerId) return
    if (!stageSpriteDrag.moved && Math.hypot(event.clientX - stageSpriteDrag.startClientX, event.clientY - stageSpriteDrag.startClientY) < 4) return
    const { x, y } = stagePointerPosition(event)
    const next = renderer.getFencedPositionOfDrawable(stageSpriteDrag.targetId, [
      x - stageSpriteDrag.offsetX,
      y - stageSpriteDrag.offsetY,
    ])
    const target = vm.getTarget(stageSpriteDrag.targetId)
    if (!target) return
    if (Math.abs((target.x ?? 0) - next[0]) > 0.01 || Math.abs((target.y ?? 0) - next[1]) > 0.01) {
      stageSpriteDrag.moved = true
      const data = { targetId: stageSpriteDrag.targetId, x: next[0], y: next[1] }
      if (runtimeInWorker) runtimeWorker.postSpriteInfo(data)
      else vm.postSpriteInfo(data)
    }
  }

  function endStageSpriteDrag(event: PointerEvent) {
    updateMouse(event, { wasDragged: stageSpriteDrag?.moved === true })
    if (!stageSpriteDrag || stageSpriteDrag.pointerId !== event.pointerId) return
    suppressNextStageClick = true
    if (runtimeInWorker) runtimeWorker.stopDrag(stageSpriteDrag.targetId)
    else vm.stopDrag(stageSpriteDrag.targetId)
    if (stageCanvas.hasPointerCapture(event.pointerId)) stageCanvas.releasePointerCapture(event.pointerId)
    stageSpriteDrag = undefined
  }

  function cancelStageSpriteDrag(event?: PointerEvent | Event) {
    if (!stageSpriteDrag) return
    if (runtimeInWorker) runtimeWorker.stopDrag(stageSpriteDrag.targetId)
    else vm.stopDrag(stageSpriteDrag.targetId)
    const pointerId = event instanceof PointerEvent ? event.pointerId : stageSpriteDrag.pointerId
    if (stageCanvas?.hasPointerCapture?.(pointerId)) stageCanvas.releasePointerCapture(pointerId)
    stageSpriteDrag = undefined
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (libraryPanel && event.key === 'Escape') {
      event.preventDefault()
      closeLibraryFromButton()
      return
    }
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
    if (selectedTab === 'costumes') {
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          void (event.shiftKey ? redoAssetEdit() : undoAssetEdit())
          return
        }
        if (key === 'x') {
          event.preventDefault()
          if (costumeEditMode === 'bitmap' && bitmapSelection) void copyBitmapSelection(true)
          else void deleteEditorSelection()
          return
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault()
          void deleteEditorSelection()
          return
        }
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        void deleteEditorSelection()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        refreshAssetEditorPreviews()
        return
      }
    }
    if (selectedTab === 'sounds' && selectedTarget?.sounds[selectedSoundIndex]) {
      if (event.key === ' ') {
        event.preventDefault()
        if (previewAudio) stopPreviewSound()
        else void previewSound(selectedSoundIndex)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        void deleteSoundSelection(selectedSoundIndex, event.shiftKey)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        soundTrimStart = 0
        soundTrimEnd = 1
        return
      }
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          void (event.shiftKey ? redoAssetEdit() : undoAssetEdit())
          return
        }
        if (key === 'c') {
          event.preventDefault()
          void copySound(selectedSoundIndex)
          return
        }
        if (key === 'v') {
          event.preventDefault()
          void pasteSound(selectedSoundIndex)
          return
        }
        if (key === 'a') {
          event.preventDefault()
          soundTrimStart = 0
          soundTrimEnd = 1
          return
        }
      }
    }
    if (isScratchRuntimeKey(event)) event.preventDefault()
    const data = { key: scratchKeyName(event), isDown: true, pressed: true }
    if (runtimeInWorker) runtimeWorker.postKeyboard(data)
    else vm.postKeyboard(data)
  }

  function handleKeyUp(event: KeyboardEvent) {
    if (isScratchRuntimeKey(event)) event.preventDefault()
    const data = { key: scratchKeyName(event), isDown: false, pressed: false }
    if (runtimeInWorker) runtimeWorker.postKeyboard(data)
    else vm.postKeyboard(data)
  }

  function isScratchRuntimeKey(event: KeyboardEvent) {
    return event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === ' '
  }

  function trimSilence(samples: Float32Array) {
    const threshold = 0.012
    let start = 0
    let end = samples.length
    while (start < end && Math.abs(samples[start] ?? 0) < threshold) start += 1
    while (end > start && Math.abs(samples[end - 1] ?? 0) < threshold) end -= 1
    const padding = Math.floor(recordingSampleRate * 0.03)
    return samples.slice(Math.max(0, start - padding), Math.min(samples.length, end + padding))
  }

  function zoomBlockly(amount: number) {
    workspace?.zoomCenter(amount)
  }

  function resetBlocklyZoom() {
    if (!workspace) return
    const zoom = Math.log(0.86 / workspace.scale) / Math.log(1.1)
    workspace.beginCanvasTransition()
    workspace.zoomCenter(zoom)
    workspace.scrollCenter()
    setTimeout(() => workspace?.endCanvasTransition(), 500)
  }

  function mountBlockly() {
    workspace = Blockly.inject(blocklyHost, {
      toolbox: makeToolbox(selectedTarget, project.extensions, stage, targets, project.monitors),
      renderer: 'zelos',
      theme: scratchBlocklyTheme,
      trashcan: true,
      scrollbars: true,
      sounds: false,
      move: {
        scrollbars: true,
        drag: true,
        wheel: false,
      },
      zoom: {
        controls: true,
        wheel: true,
        startScale: 0.86,
        maxScale: 2,
        minScale: 0.35,
        scaleSpeed: 1.1,
      },
      grid: {
        spacing: 38,
        length: 2,
        colour: '#d9d9d9',
        snap: false,
      },
    })
    workspace.registerButtonCallback('CREATE_VARIABLE', createVariable)
    workspace.registerButtonCallback('CREATE_LIST', createList)
    workspace.registerButtonCallback('CREATE_BLOCK', createProcedure)
    workspace.registerButtonCallback('OPEN_EXTENSIONS', () => openLibrary('extension'))
    registerDataMonitorCallbacks()
    tick().then(() => {
      keepToolboxExpanded()
      renderMonitorCheckboxesInFlyout()
    })
    blocklyPointerUpHandler = () => requestAnimationFrame(() => {
      keepToolboxExpanded()
      renderMonitorCheckboxesInFlyout()
    })
    blocklySelectedCategoryPointerDownHandler = suppressSelectedToolboxCategoryClick
    blocklyHost.addEventListener('pointerup', blocklyPointerUpHandler)
    blocklyHost.addEventListener('pointerdown', blocklySelectedCategoryPointerDownHandler, { capture: true })
    workspace.addChangeListener((event) => {
      if (loadingBlockly) return
      if (event.type === Blockly.Events.CLICK) {
        handleBlocklyClick(event)
        tick().then(() => {
          keepToolboxExpanded()
          renderMonitorCheckboxesInFlyout()
        })
        return
      }
      if (event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) return
      if (event.type === Blockly.Events.MOVE && !event.group) return
      if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
        requestAnimationFrame(() => {
          keepToolboxExpanded()
          renderMonitorCheckboxesInFlyout()
        })
        return
      }
      if (runtimeInWorker && snapshot.running) return
      if (!selectedTarget || selectedTarget.isStage) return
      vm.applyWorkspaceChange(selectedTarget.id ?? selectedTarget.name, {
        blocks: workspaceToScratchBlocks(workspace!, selectedTarget, stage),
      })
    })
    resizeObserver = new ResizeObserver(() => {
      if (workspace) Blockly.svgResize(workspace)
    })
    resizeObserver.observe(blocklyHost)
    if (selectedTarget) loadTargetWorkspace(selectedTarget)
  }

  function selectedToolboxCategoryName() {
    if (!workspace) return undefined
    const toolbox = workspace.getToolbox() as unknown as {
      getSelectedItem?: () => unknown
    } | null
    return toolboxItemName(toolbox?.getSelectedItem?.())
  }

  function flyoutScrollPosition() {
    const flyoutWorkspace = workspace?.getFlyout()?.getWorkspace()
    return flyoutWorkspace ? { x: flyoutWorkspace.scrollX, y: flyoutWorkspace.scrollY } : undefined
  }

  function restoreFlyoutScrollPosition(position: { x: number; y: number } | undefined) {
    if (!position) return
    const flyoutWorkspace = workspace?.getFlyout()?.getWorkspace()
    flyoutWorkspace?.scroll(position.x, position.y)
  }

  function renderMonitorCheckboxesInFlyout() {
    const flyoutWorkspace = workspace?.getFlyout()?.getWorkspace()
    if (!flyoutWorkspace || selectedExternalTabId || selectedTab !== 'code') return
    flyoutWorkspace.getCanvas().querySelectorAll('.hikkaku-monitor-checkbox').forEach((node) => node.remove())
    const blocks = flyoutWorkspace.getTopBlocks(false) as Blockly.BlockSvg[]
    for (const block of blocks) {
      const action = monitorActionForFlyoutBlock(block)
      if (!action) continue
      const root = block.getSvgRoot() as SVGGElement | null
      if (!root) continue
      const shiftedRoot = root as SVGGElement & { __hikkakuMonitorCheckboxShifted?: boolean }
      if (!shiftedRoot.__hikkakuMonitorCheckboxShifted) {
        block.moveBy(40, 0, ['hikkaku-monitor-checkbox'])
        shiftedRoot.__hikkakuMonitorCheckboxShifted = true
      }
      const position = block.getRelativeToSurfaceXY()
      const size = block.getHeightWidth()
      const checkbox = createFlyoutMonitorCheckbox(action.checked)
      checkbox.setAttribute('transform', `translate(${position.x - 30},${position.y + Math.max(2, (size.height - 16) / 2)})`)
      checkbox.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      checkbox.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        action.toggle()
        requestAnimationFrame(() => renderMonitorCheckboxesInFlyout())
      })
      flyoutWorkspace.getCanvas().appendChild(checkbox)
    }
  }

  function monitorActionForFlyoutBlock(block: Blockly.BlockSvg): { checked: boolean; toggle: () => void } | undefined {
    if (block.type === 'data_variable') {
      const variableName = String(block.getFieldValue('VARIABLE_NAME') ?? '')
      const record = dataOwnerForVariableName(variableName)
      if (!record) return undefined
      return {
        checked: variableMonitorVisible(record.owner, record.id),
        toggle: () => toggleVariableMonitor(record.id),
      }
    }
    if (block.type === 'data_listcontents') {
      const listName = String(block.getFieldValue('LIST_NAME') ?? '')
      const record = dataOwnerForListName(listName)
      if (!record) return undefined
      return {
        checked: listMonitorVisible(record.owner, record.id),
        toggle: () => toggleListMonitor(record.id),
      }
    }
    const spec = monitorableReporterSpecs.find((candidate) => candidate.opcode === block.type)
    if (!spec) return undefined
    const params = spec.params ?? {}
    return {
      checked: blockMonitorVisible(block.type, params),
      toggle: () => toggleBlockMonitor(block.type, params),
    }
  }

  function variableMonitorVisible(owner: ScratchTarget, id: string) {
    const monitorId = `${owner.id ?? owner.name}:${id}`
    return project.monitors.some((monitor) => monitor.opcode === 'data_variable' && monitor.visible && (monitor.id === monitorId || monitor.id.endsWith(`:${id}`)))
  }

  function listMonitorVisible(owner: ScratchTarget, id: string) {
    const monitorId = `${owner.id ?? owner.name}:${id}`
    return project.monitors.some((monitor) => monitor.opcode === 'data_listcontents' && monitor.visible && (monitor.id === monitorId || monitor.id.endsWith(`:${id}`)))
  }

  function blockMonitorVisible(opcode: string, params: Record<string, string>) {
    const owner = selectedTarget ?? stage
    return project.monitors.some((monitor) =>
      monitor.opcode === opcode
      && monitor.visible
      && (!monitor.spriteName || !owner || monitor.spriteName === owner.name)
      && Object.entries(params).every(([key, value]) => String(monitor.params[key] ?? '') === value))
  }

  function createFlyoutMonitorCheckbox(checked: boolean) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.classList.add('hikkaku-monitor-checkbox')
    group.setAttribute('role', 'button')
    group.setAttribute('aria-pressed', checked ? 'true' : 'false')
    group.style.cursor = 'pointer'
    const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    box.setAttribute('width', '16')
    box.setAttribute('height', '16')
    box.setAttribute('rx', '2')
    box.setAttribute('fill', checked ? '#4c97ff' : '#ffffff')
    box.setAttribute('stroke', checked ? '#3373cc' : '#c8c8d0')
    box.setAttribute('stroke-width', '1')
    group.appendChild(box)
    if (checked) {
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      mark.setAttribute('d', 'M4 8.2 7 11.2 12.5 4.8')
      mark.setAttribute('fill', 'none')
      mark.setAttribute('stroke', '#ffffff')
      mark.setAttribute('stroke-width', '2')
      mark.setAttribute('stroke-linecap', 'round')
      mark.setAttribute('stroke-linejoin', 'round')
      group.appendChild(mark)
    }
    return group
  }

  function toolboxItemName(item: unknown) {
    const candidate = item as { getName?: () => string } | undefined
    return candidate?.getName?.()
  }

  function makeWorkspaceToolboxSignature(
    target: ScratchTarget,
    stageTarget: ScratchTarget | undefined,
    allTargets: readonly ScratchTarget[],
    extensions: readonly string[],
  ) {
    const stageVariables = Object.entries(stageTarget?.variables ?? {}).map(([id, variable]) => `${id}:${variable[0]}`).join('|')
    const stageLists = Object.entries(stageTarget?.lists ?? {}).map(([id, list]) => `${id}:${list[0]}`).join('|')
    const targetVariables = Object.entries(target.variables).map(([id, variable]) => `${id}:${variable[0]}`).join('|')
    const targetLists = Object.entries(target.lists).map(([id, list]) => `${id}:${list[0]}`).join('|')
    return [
      target.id ?? target.name,
      extensions.join('|'),
      allTargets.map((nextTarget) => `${nextTarget.id ?? nextTarget.name}:${nextTarget.name}`).join('|'),
      stageVariables,
      stageLists,
      targetVariables,
      targetLists,
      target.costumes.map((costume) => costume.name).join('|'),
      stageTarget?.costumes.map((costume) => costume.name).join('|') ?? '',
      target.sounds.map((sound) => sound.name).join('|'),
      targetProcedureSignature(target),
    ].join(':')
  }

  function targetProcedureSignature(target: ScratchTarget) {
    const parts: string[] = []
    for (const [id, block] of Object.entries(target.blocks)) {
      if (block.opcode !== 'procedures_definition' && block.opcode !== 'procedures_prototype') continue
      const customBlockId = block.inputs?.custom_block?.[1]
      parts.push([
        id,
        block.opcode,
        typeof customBlockId === 'string' ? customBlockId : '',
        typeof block.mutation?.proccode === 'string' ? block.mutation.proccode : '',
        typeof block.mutation?.argumentids === 'string' ? block.mutation.argumentids : '',
        typeof block.mutation?.argumentnames === 'string' ? block.mutation.argumentnames : '',
        typeof block.mutation?.argumentdefaults === 'string' ? block.mutation.argumentdefaults : '',
        typeof block.mutation?.warp === 'string' ? block.mutation.warp : '',
      ].join(','))
    }
    return parts.join('|')
  }

  function toolboxCategoryNameFromEventTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return undefined
    const categoryElement = target.closest<HTMLElement>('.blocklyToolboxCategoryContainer, .blocklyToolboxCategory, .blocklyTreeRow')
    if (!categoryElement || !blocklyHost?.contains(categoryElement)) return undefined
    return categoryElement
      .querySelector<HTMLElement>('.blocklyToolboxCategoryLabel, .blocklyTreeLabel')
      ?.textContent
      ?.trim()
  }

  function suppressSelectedToolboxCategoryClick(event: PointerEvent) {
    if (!workspace || event.button !== 0) return
    const categoryName = toolboxCategoryNameFromEventTarget(event.target)
    if (!categoryName || categoryName !== selectedToolboxCategoryName()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    requestAnimationFrame(() => {
      normalizeToolboxFlyoutWidth()
      scrollContinuousFlyoutToCategory(categoryName)
    })
  }

  function keepToolboxExpanded(preferredCategoryName?: string, forceRefresh = false) {
    if (!workspace || selectedExternalTabId || selectedTab !== 'code') return
    const toolbox = workspace.getToolbox() as unknown as {
      clearSelection?: () => void
      getFlyout?: () => { isVisible?: () => boolean; setAutoClose?: (autoClose: boolean) => void } | null
      getSelectedItem?: () => unknown
      getToolboxItems?: () => unknown[]
      setSelectedItem?: (item: unknown) => void
    } | null
    if (!toolbox?.setSelectedItem || !toolbox.getToolboxItems) return
    lockToolboxPaletteScale(toolbox)
    keepContinuousToolboxFlyoutStable(toolbox)
    keepToolboxCategorySyncedToFlyoutScroll(toolbox)
    const items = toolbox.getToolboxItems()
    const selected = toolbox.getSelectedItem?.()
    const flyout = toolbox.getFlyout?.()
    flyout?.setAutoClose?.(false)
    const flyoutVisible = flyout?.isVisible?.() === true
    if (selected && flyoutVisible && !forceRefresh) {
      const selectedName = toolboxItemName(selected)
      requestAnimationFrame(() => {
        normalizeToolboxFlyoutWidth()
        renderMonitorCheckboxesInFlyout()
        if (selectedName && selectedName !== lastToolboxScrollCategoryName) {
          scrollContinuousFlyoutToCategory(selectedName)
          lastToolboxScrollCategoryName = selectedName
        }
      })
      return
    }
    const selectedName = toolboxItemName(selected)
    const targetName = preferredCategoryName ?? selectedName
    const namedItem = targetName ? items.find((entry) => toolboxItemName(entry) === targetName) : undefined
    const item = namedItem ?? selected ?? items.find((entry) => {
      const candidate = entry as { isSelectable?: () => boolean }
      return candidate.isSelectable?.() !== false
    })
    if (!item) return
    if (selected && (forceRefresh || !flyoutVisible)) toolbox.clearSelection?.()
    toolbox.setSelectedItem(item)
    Blockly.svgResize(workspace)
    requestAnimationFrame(() => {
      normalizeToolboxFlyoutWidth()
      renderMonitorCheckboxesInFlyout()
      const itemName = toolboxItemName(item)
      scrollContinuousFlyoutToCategory(itemName)
      lastToolboxScrollCategoryName = itemName ?? ''
    })
  }

  function lockToolboxPaletteScale(toolbox: {
    getFlyout?: () => unknown
  }) {
    const flyout = toolbox.getFlyout?.() as {
      getFlyoutScale?: () => number
      getWorkspace?: () => Blockly.WorkspaceSvg
      setAutoClose?: (autoClose: boolean) => void
      __hikkakuPaletteScaleLocked?: boolean
    } | null
    flyout?.setAutoClose?.(false)
    if (!flyout || flyout.__hikkakuPaletteScaleLocked) return
    flyout.getFlyoutScale = () => toolboxPaletteScale
    flyout.getWorkspace?.().setScale(toolboxPaletteScale)
    flyout.__hikkakuPaletteScaleLocked = true
  }

  function keepContinuousToolboxFlyoutStable(toolbox: {
    getFlyout?: () => { isVisible?: () => boolean } | null
    updateFlyout_?: (oldItem: unknown, newItem: unknown) => void
    __hikkakuStableContinuousFlyout?: boolean
  }) {
    if (toolbox.__hikkakuStableContinuousFlyout || !toolbox.updateFlyout_) return
    const updateFlyout = toolbox.updateFlyout_.bind(toolbox)
    toolbox.updateFlyout_ = (oldItem: unknown, newItem: unknown) => {
      const oldName = toolboxItemName(oldItem)
      const newName = toolboxItemName(newItem)
      const oldContents = toolboxItemContents(oldItem)
      const newContents = toolboxItemContents(newItem)
      if (
        oldName &&
        newName &&
        toolbox.getFlyout?.()?.isVisible?.() === true &&
        oldContents &&
        newContents &&
        toolboxContentsMatch(oldContents, newContents)
      ) {
        return
      }
      updateFlyout(oldItem, newItem)
    }
    toolbox.__hikkakuStableContinuousFlyout = true
  }

  function keepToolboxCategorySyncedToFlyoutScroll(toolbox: {
    getFlyout?: () => unknown
    getSelectedItem?: () => unknown
    getToolboxItems?: () => unknown[]
    setSelectedItem?: (item: unknown) => void
  }) {
    const flyout = toolbox.getFlyout?.() as {
      getWorkspace?: () => Blockly.WorkspaceSvg & {
        scrollbar?: { setY?: (y: number) => void; __hikkakuCategorySyncInstalled?: boolean }
      }
    } | null
    const scrollbar = flyout?.getWorkspace?.().scrollbar
    if (!scrollbar?.setY || scrollbar.__hikkakuCategorySyncInstalled) return
    const setY = scrollbar.setY.bind(scrollbar)
    scrollbar.setY = (y: number) => {
      setY(y)
      scheduleToolboxCategorySync()
    }
    scrollbar.__hikkakuCategorySyncInstalled = true
  }

  function scheduleToolboxCategorySync() {
    if (toolboxCategorySyncAnimation !== undefined) return
    toolboxCategorySyncAnimation = requestAnimationFrame(() => {
      toolboxCategorySyncAnimation = undefined
      syncToolboxCategoryToFlyoutScroll()
    })
  }

  function syncToolboxCategoryToFlyoutScroll() {
    if (!workspace || selectedExternalTabId || selectedTab !== 'code') return
    const currentName = currentFlyoutCategoryName()
    if (!currentName || currentName === selectedToolboxCategoryName()) return
    const toolbox = workspace.getToolbox() as unknown as {
      getFlyout?: () => { isVisible?: () => boolean } | null
      getToolboxItems?: () => unknown[]
      setSelectedItem?: (item: unknown) => void
    } | null
    if (toolbox?.getFlyout?.()?.isVisible?.() !== true || !toolbox.setSelectedItem || !toolbox.getToolboxItems) return
    const item = toolbox.getToolboxItems().find((entry) => toolboxItemName(entry) === currentName)
    if (!item) return
    toolbox.setSelectedItem(item)
    lastToolboxScrollCategoryName = currentName
  }

  function currentFlyoutCategoryName() {
    const flyoutRect = blocklyHost?.querySelector<SVGSVGElement>('.blocklyToolboxFlyout')?.getBoundingClientRect()
    const labels = [...(blocklyHost?.querySelectorAll<SVGGElement>('.blocklyFlyoutLabel') ?? [])]
      .map((label) => ({ name: label.textContent?.trim() ?? '', top: label.getBoundingClientRect().top }))
      .filter((label) => label.name)
      .sort((a, b) => a.top - b.top)
    if (!flyoutRect || labels.length === 0) return undefined
    const threshold = flyoutRect.top + 12
    let current = labels[0]
    for (const label of labels) {
      if (label.top > threshold) break
      current = label
    }
    return current.name
  }

  function cancelToolboxCategorySync() {
    if (toolboxCategorySyncAnimation === undefined) return
    cancelAnimationFrame(toolboxCategorySyncAnimation)
    toolboxCategorySyncAnimation = undefined
  }

  function toolboxItemContents(item: unknown) {
    const candidate = item as { getContents?: () => unknown[] } | undefined
    return candidate?.getContents?.()
  }

  function toolboxContentsMatch(left: unknown[], right: unknown[]) {
    if (left.length !== right.length) return false
    return left.every((entry, index) => toolboxContentKey(entry) === toolboxContentKey(right[index]))
  }

  function toolboxContentKey(entry: unknown) {
    const item = entry as { kind?: unknown; text?: unknown; type?: unknown; callbackKey?: unknown } | undefined
    return `${String(item?.kind ?? '')}:${String(item?.text ?? '')}:${String(item?.type ?? '')}:${String(item?.callbackKey ?? '')}`
  }

  function normalizeToolboxFlyoutWidth() {
    const flyout = blocklyHost?.querySelector<SVGSVGElement>('.blocklyToolboxFlyout')
    const background = flyout?.querySelector<SVGPathElement>('.blocklyFlyoutBackground')
    if (!flyout) return
    flyout.style.width = `${toolboxFlyoutWidth}px`
    flyout.style.minWidth = `${toolboxFlyoutWidth}px`
    flyout.style.maxWidth = `${toolboxFlyoutWidth}px`
    flyout.style.overflow = 'hidden'
    flyout.setAttribute('width', String(toolboxFlyoutWidth))
    if (!background) return
    const height = flyout.getBoundingClientRect().height
    const radius = 8
    const widthWithoutRadius = toolboxFlyoutWidth - radius
    background.setAttribute('d', `M 0,0 h ${widthWithoutRadius} a ${radius} ${radius} 0 0 1 ${radius} ${radius} v ${Math.max(0, height - radius * 2)} a ${radius} ${radius} 0 0 1 -${radius} ${radius} h -${widthWithoutRadius} z`)
    const flyoutRect = flyout.getBoundingClientRect()
    const scrollbar = [...blocklyHost.querySelectorAll<SVGSVGElement>('.blocklyFlyoutScrollbar')]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.height > 0 && rect.left > flyoutRect.left
      })
    if (!scrollbar) return
    const scrollbarRect = scrollbar.getBoundingClientRect()
    const targetLeft = flyoutRect.left + toolboxFlyoutWidth - scrollbarRect.width - 3
    const [currentX, currentY] = svgTranslate(scrollbar)
    scrollbar.style.transform = `translate(${currentX + targetLeft - scrollbarRect.left}px, ${currentY}px)`
  }

  function scrollContinuousFlyoutToCategory(categoryName?: string) {
    if (!workspace || !categoryName) return
    const flyout = workspace.getToolbox()?.getFlyout?.() as {
      getWorkspace?: () => Blockly.WorkspaceSvg & {
        getMetrics?: () => { viewTop?: number } | null
        scrollbar?: { setY?: (y: number) => void }
      }
    } | null
    const flyoutWorkspace = flyout?.getWorkspace?.()
    const flyoutSvg = blocklyHost?.querySelector<SVGSVGElement>('.blocklyToolboxFlyout')
    const label = [...(blocklyHost?.querySelectorAll<SVGGElement>('.blocklyFlyoutLabel') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === categoryName)
    if (!flyoutWorkspace || !flyoutSvg || !label) return
    const labelRect = label.getBoundingClientRect()
    const flyoutRect = flyoutSvg.getBoundingClientRect()
    const delta = labelRect.top - flyoutRect.top - 8
    if (Math.abs(delta) < 2) return
    const currentTop = flyoutWorkspace.getMetrics?.()?.viewTop ?? 0
    smoothScrollContinuousFlyout(flyoutWorkspace, Math.max(0, currentTop + delta))
  }

  function smoothScrollContinuousFlyout(
    flyoutWorkspace: Blockly.WorkspaceSvg & {
      getMetrics?: () => { viewTop?: number } | null
      scrollbar?: { setY?: (y: number) => void }
    },
    targetTop: number,
  ) {
    const scrollbar = flyoutWorkspace.scrollbar
    if (!scrollbar?.setY) return
    const startTop = flyoutWorkspace.getMetrics?.()?.viewTop ?? 0
    const distance = targetTop - startTop
    if (Math.abs(distance) < 2 || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      cancelContinuousFlyoutScroll()
      scrollbar.setY(Math.max(0, targetTop))
      return
    }
    cancelContinuousFlyoutScroll()
    const startTime = performance.now()
    const duration = 220
    const step = (time: number) => {
      const progress = Math.min(1, (time - startTime) / duration)
      const eased = 1 - (1 - progress) ** 3
      scrollbar.setY(Math.max(0, startTop + distance * eased))
      if (progress < 1) {
        toolboxFlyoutScrollAnimation = requestAnimationFrame(step)
        return
      }
      toolboxFlyoutScrollAnimation = undefined
    }
    toolboxFlyoutScrollAnimation = requestAnimationFrame(step)
  }

  function cancelContinuousFlyoutScroll() {
    if (toolboxFlyoutScrollAnimation === undefined) return
    cancelAnimationFrame(toolboxFlyoutScrollAnimation)
    toolboxFlyoutScrollAnimation = undefined
  }

  function svgTranslate(element: SVGElement): [number, number] {
    const transform = getComputedStyle(element).transform
    if (transform === 'none') return [0, 0]
    const matrix = transform.match(/matrix\(([^)]+)\)/)?.[1]?.split(',').map((value) => Number(value.trim()))
    if (matrix && matrix.length >= 6) return [matrix[4] ?? 0, matrix[5] ?? 0]
    const translate = transform.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/)
    return [Number(translate?.[1] ?? 0), Number(translate?.[2] ?? 0)]
  }

  function handleBlocklyClick(event: Blockly.Events.Abstract) {
    if (!selectedTarget || selectedTarget.isStage || !workspace) return
    const click = event as Blockly.Events.Abstract & { blockId?: string; targetType?: string }
    if (click.targetType !== 'block' || !click.blockId) return
    const block = workspace.getBlockById(click.blockId) as Blockly.BlockSvg | null
    if (!block || block.isInFlyout) return
    const targetId = selectedTarget.id ?? selectedTarget.name
    if (block.outputConnection) {
      if (runtimeInWorker) runtimeWorker.reportBlockValue(block.id, targetId)
      else vm.reportBlockValue(block.id, targetId)
      return
    }
    const rootBlock = (block?.getRootBlock() ?? block) as Blockly.BlockSvg | null
    if (!rootBlock || rootBlock.isInFlyout) return
    if (runtimeInWorker) runtimeWorker.toggleScript(rootBlock.id, targetId)
    else vm.toggleScript(rootBlock.id, targetId)
    status = 'Script toggled'
  }

  function showVisualReport(blockId: string, value: string) {
    status = `Value: ${value}`
    if (!workspace || !blocklyHost) return
    const block = workspace.getBlockById(blockId) as Blockly.BlockSvg | null
    const blockRoot = block?.getSvgRoot()
    if (!blockRoot) return
    const hostRect = blocklyHost.getBoundingClientRect()
    const blockRect = blockRoot.getBoundingClientRect()
    visualReportBubble = {
      id: blockId,
      value,
      left: Math.max(8, blockRect.right - hostRect.left + 8),
      top: Math.max(8, blockRect.top - hostRect.top + blockRect.height / 2),
    }
    if (visualReportTimer) clearTimeout(visualReportTimer)
    visualReportTimer = setTimeout(() => {
      visualReportBubble = undefined
      visualReportTimer = undefined
    }, 2600)
  }

  function syncRuntimeBlockHighlights() {
    if (!workspace || !selectedTarget) return
    const targetName = selectedTarget.name
    const nextIds = new Set(
      snapshot.threads
        .filter((thread) => thread.targetName === targetName && thread.status !== 'done')
        .map((thread) => thread.topBlockId)
        .filter((blockId) => Boolean(workspace?.getBlockById(blockId)))
    )
    for (const blockId of highlightedRuntimeBlockIds) {
      if (!nextIds.has(blockId)) workspace.highlightBlock(blockId, false)
    }
    for (const blockId of nextIds) {
      if (!highlightedRuntimeBlockIds.has(blockId)) workspace.highlightBlock(blockId, true)
    }
    highlightedRuntimeBlockIds = nextIds
  }

  function clearRuntimeBlockHighlights() {
    if (workspace) workspace.highlightBlock(null)
    highlightedRuntimeBlockIds = new Set()
  }

  function loadTargetWorkspace(target: ScratchTarget) {
    if (!workspace) return
    const loadSerial = ++workspaceLoadSerial
    loadingBlockly = true
    const targetId = target.id ?? target.name
    Blockly.Events.disable()
    workspace.setResizesEnabled(false)
    try {
      clearRuntimeBlockHighlights()
      workspace.clear()
      const created = new Map<string, Blockly.BlockSvg>()
      const literalInputs = new Set<Blockly.BlockSvg>()
      for (const [id, block] of Object.entries(target.blocks)) {
        if (!Blockly.Blocks[block.opcode]) continue
        if (isProcedurePrototypeArgumentShadow(block, target.blocks)) continue
        const next = workspace.newBlock(block.opcode, id) as Blockly.BlockSvg
        if (block.shadow) next.setShadow(true)
        applyScratchFields(next, block, { connectLiteralInputs: false })
        attachScratchBlockState(next, block)
        if (block.x !== undefined && block.y !== undefined) next.moveBy(block.x, block.y)
        next.initSvg()
        created.set(id, next)
      }
      for (const [id, block] of Object.entries(target.blocks)) {
        if (isProcedurePrototypeArgumentShadow(block, target.blocks)) continue
        const source = created.get(id)
        if (!source) continue
        if (block.next) {
          const next = created.get(block.next)
          if (next && source.nextConnection && next.previousConnection) {
            source.nextConnection.connect(next.previousConnection)
          }
        }
        for (const [name, input] of Object.entries(block.inputs ?? {})) {
          const shadowValue = input[0] === 3 ? input[2] : undefined
          const shadow = typeof shadowValue === 'string' ? created.get(shadowValue) : undefined
          const childValue = input[1]
          const child = typeof childValue === 'string'
            ? created.get(childValue)
            : Array.isArray(childValue)
              ? createLiteralInputBlock(childValue, input[0] === 1 && literalInputIsShadow(childValue), block.opcode, name, false)
              : undefined
          if (Array.isArray(childValue) && child) literalInputs.add(child)
          const connection = source.getInput(name)?.connection
          if (shadow && connection && child && !child.isShadow()) {
            connection.setShadowState?.(blocklyShadowState(shadow))
            rememberScratchShadow(connection, String(shadowValue))
            shadow.dispose(false)
            created.delete(String(shadowValue))
          } else if (Array.isArray(shadowValue) && connection && child && !child.isShadow()) {
            const shadowState = blocklyShadowStateFromLiteral(shadowValue, block.opcode, name)
            if (shadowState) connection.setShadowState?.(shadowState)
          }
          if (child && connection && child.outputConnection) connection.connect(child.outputConnection)
          if (child && connection && child.previousConnection) connection.connect(child.previousConnection)
          if (Array.isArray(childValue) && child && !child.getParent()) child.dispose(false)
        }
      }
      workspaceTargetId = targetId
      workspace.render()
      cleanupFloatingImportLiterals(literalInputs)
      Blockly.svgResize(workspace)
      keepToolboxExpanded()
    } finally {
      workspace.setResizesEnabled(true)
      Blockly.Events.enable()
    }
    requestAnimationFrame(() => {
      if (loadSerial !== workspaceLoadSerial) return
      loadingBlockly = false
      syncRuntimeBlockHighlights()
    })
  }

  function isProcedurePrototypeArgumentShadow(block: ScratchBlock, blocks: Record<string, ScratchBlock>) {
    if (!block.shadow || !block.opcode.startsWith('argument_reporter_')) return false
    const parent = typeof block.parent === 'string' ? blocks[block.parent] : undefined
    return parent?.opcode === 'procedures_prototype'
  }

  function cleanupFloatingImportLiterals(literalInputs: Set<Blockly.BlockSvg>) {
    for (const literal of literalInputs) {
      if (!literal.getParent() && !literal.isDisposed()) literal.dispose(false)
    }
  }

	  function createLiteralInputBlock(value: unknown[], shadow: boolean, ownerOpcode?: string, inputName?: string, renderBlock = true) {
    const info = literalInputBlockInfo(value, ownerOpcode, inputName)
    if (!workspace || !info || !Blockly.Blocks[info.type]) return undefined
    const block = workspace.newBlock(info.type) as Blockly.BlockSvg
    block.setShadow(shadow)
    block.setFieldValue(info.value, info.field)
    attachScratchBlockState(block, {
      opcode: info.type,
      fields: info.scratchField ? { [info.scratchField]: [info.value, info.id ?? info.value] } : {},
      inputs: {},
      shadow,
      topLevel: false,
    } as ScratchBlock)
    block.initSvg()
    if (renderBlock) block.render()
    return block
  }

  function blocklyShadowStateFromLiteral(value: unknown[], ownerOpcode?: string, inputName?: string) {
    const info = literalInputBlockInfo(value, ownerOpcode, inputName)
    return info ? { type: info.type, fields: { [info.field]: info.value } } : undefined
  }

  function literalInputBlockInfo(value: unknown[], ownerOpcode?: string, inputName?: string) {
    const code = Number(value[0])
    const text = String(value[1] ?? '')
    const id = value[2] === undefined ? undefined : String(value[2])
    const contextualType = ownerOpcode && inputName ? literalShadowTypeForInput(ownerOpcode, inputName, code) : undefined
    if (contextualType) {
      const menuField = scratchMenuShadowFieldName(contextualType)
      if (menuField) return { type: contextualType, field: menuField, scratchField: menuField, value: text, id }
      if (contextualType === 'colour_picker') return { type: 'colour_picker', field: 'COLOUR', value: text }
      if (contextualType === 'data_variable') return { type: 'data_variable', field: 'VARIABLE_NAME', scratchField: 'VARIABLE', value: text, id }
      if (contextualType === 'data_listcontents') return { type: 'data_listcontents', field: 'LIST_NAME', scratchField: 'LIST', value: text, id }
      if (contextualType === 'text') return { type: 'text', field: 'TEXT', value: text }
      if (contextualType === 'math_number') return { type: 'math_number', field: 'NUM', value: text }
    }
    if (code === 4) return { type: 'math_number', field: 'NUM', value: text }
    if (code === 9) return { type: 'colour_picker', field: 'COLOUR', value: text }
    if (code === 10) return { type: 'text', field: 'TEXT', value: text }
    if (code === 11) return { type: 'event_broadcast_menu', field: 'BROADCAST_OPTION', scratchField: 'BROADCAST_OPTION', value: text, id }
    if (code === 12) return { type: 'data_variable', field: 'VARIABLE_NAME', scratchField: 'VARIABLE', value: text, id }
    if (code === 13) return { type: 'data_listcontents', field: 'LIST_NAME', scratchField: 'LIST', value: text, id }
    return undefined
  }

  function literalInputIsShadow(value: unknown[]) {
    const info = literalInputBlockInfo(value)
    return !!info && info.type !== 'data_variable' && info.type !== 'data_listcontents'
  }

  function blocklyShadowState(block: Blockly.BlockSvg) {
    const fields: Record<string, string> = {}
    for (const input of block.inputList) {
      for (const field of input.fieldRow) {
        if (field.name) fields[field.name] = String(field.getValue())
      }
    }
    return Object.keys(fields).length > 0 ? { type: block.type, fields } : { type: block.type }
  }

  function rememberScratchShadow(connection: Blockly.Connection, blockId: string) {
    ;(connection as Blockly.Connection & { __hikkakuScratchShadowId?: string }).__hikkakuScratchShadowId = blockId
  }
</script>


<svelte:head>
  <title>Hikkaku Scratch Editor</title>
</svelte:head>

<svelte:window
  on:click={closeSpriteContextMenu}
  on:keydown={(event) => {
    if (event.key === 'Escape') {
      closeSpriteContextMenu()
      closeLibrary()
      closeDataDialog()
    }
  }}
/>

<HiddenFileInputs
  bind:fileInput
  bind:spriteFileInput
  bind:costumeFileInput
  bind:soundFileInput
  {loadProject}
  {importSpriteFile}
  {uploadCostume}
  {uploadSound}
/>

<LibraryDialog
  {libraryPanel}
  bind:librarySearch
  items={currentLibraryItems(libraryPanel, librarySearch)}
  chooseItem={chooseLibraryItem}
  close={closeLibraryFromButton}
  {bytesToLocalBase64}
  {librarySvg}
/>

{#if dataDialog}
  <div class="fixed inset-0 z-[80] flex items-center justify-center bg-[#4c97ff]/85 p-4" role="presentation">
    <div
      class="w-full max-w-[400px] overflow-hidden rounded-md border-4 border-[#9bbcff] bg-white shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="data-dialog-title"
      data-testid="data-dialog"
    >
      <form on:submit|preventDefault={submitDataDialog}>
        <div class="flex h-14 items-center justify-between bg-[#855cd6] pl-10 pr-4 text-white">
          <h2 id="data-dialog-title" class="flex-1 text-center text-lg font-bold">
            {dataDialog.kind === 'variable' ? '新しい変数' : '新しいリスト'}
          </h2>
          <button type="button" class="flex h-9 w-9 items-center justify-center rounded-full bg-[#7447bf] text-2xl font-bold leading-none hover:bg-[#6840ac]" aria-label="Close dialog" on:click={closeDataDialog}>
            ×
          </button>
        </div>

        <div class="px-10 py-7">
          <label class="block text-base font-bold text-[#575e75]" for="data-dialog-name">
            {dataDialog.kind === 'variable' ? '新しい変数名:' : '新しいリスト名:'}
          </label>
          <input
            id="data-dialog-name"
            class="mt-3 h-[54px] w-full rounded-md border-2 border-[#855cd6] px-3 text-lg font-semibold text-[#575e75] outline-none focus:ring-2 focus:ring-[#b99cff]"
            data-testid="data-dialog-name"
            bind:this={dataDialogNameInput}
            bind:value={dataDialog.name}
          />

          <div class="mt-7 grid grid-cols-1 gap-3 text-base font-semibold text-[#575e75] sm:grid-cols-2">
            <label class="flex items-start gap-2 leading-6">
              <input class="mt-1 h-4 w-4" type="radio" bind:group={dataDialog.scope} value="global" />
              <span>すべてのスプライト用</span>
            </label>
            <label class={`flex items-start gap-2 leading-6 ${selectedTarget?.isStage ? 'opacity-45' : ''}`}>
              <input class="mt-1 h-4 w-4" type="radio" bind:group={dataDialog.scope} value="local" disabled={selectedTarget?.isStage} />
              <span>このスプライトのみ</span>
            </label>
          </div>

          <div class="mt-8 flex justify-end gap-2">
            <button type="button" class="h-[50px] rounded-md border border-slate-300 bg-white px-5 text-base font-bold text-[#575e75] hover:bg-slate-50" on:click={closeDataDialog}>
              キャンセル
            </button>
            <button type="submit" class="h-[50px] rounded-md bg-[#855cd6] px-5 text-base font-bold text-white hover:bg-[#7447bf]" disabled={!dataDialog.name.trim()}>
              OK
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
{/if}

<main class="flex h-svh overflow-hidden flex-col bg-[#f5f7fb] text-slate-800" data-color-scheme={colorScheme}>
  <AppHeader
    bind:projectTitle
    {header}
    {status}
    {snapshot}
    openProject={openProjectPicker}
    {newProject}
    {exportProject}
    {exportSb3}
    {toggleTurboMode}
    greenFlag={startProject}
    stopAll={stopProject}
    stepRuntime={stepProjectRuntime}
    {colorScheme}
    {toggleColorScheme}
  />

  <section class="editor-shell grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden lg:grid-cols-[minmax(420px,1fr)_8px_var(--stage-pane-width)] lg:grid-rows-1" style={`--stage-pane-width: ${stagePaneWidth}px;`}>
    <section data-testid="editor-workspace" class={`${stageFullscreen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col overflow-hidden bg-[#dce9f8]`}>
      <div class="flex min-h-[44px] shrink-0 items-end justify-between border-b border-[#b8c6d8] bg-[#dce9f8] px-3 pt-1">
        <div class="flex min-w-0 items-end">
          {#each editorTabs as tab}
            {@const TabIcon = tab.icon}
            <button
              data-testid={`main-tab-${tab.id}`}
              class={`relative -mb-px flex h-[39px] min-w-[104px] items-center justify-center gap-1.5 rounded-t-[18px] border px-4 text-sm font-bold transition-colors ${!selectedExternalTabId && selectedTab === tab.id ? 'z-10 border-[#b8c6d8] border-b-white bg-white text-[#855cd6]' : 'border-[#b8c6d8] bg-[#d3dfef] text-[#68758a] hover:bg-[#e7eff9] hover:text-[#575e75]'}`}
              aria-current={!selectedExternalTabId && selectedTab === tab.id ? 'page' : undefined}
              on:click={() => selectEditorTab(tab.id)}
            >
              <TabIcon size={18} strokeWidth={3} aria-hidden="true" />
              <span class="truncate">{tab.label}</span>
            </button>
          {/each}
          {#each orderedContextTabs as item (item.tab)}
            <button
              data-testid={`main-tab-${item.id}`}
              class={`relative -mb-px flex h-[39px] min-w-[104px] items-center justify-center gap-1.5 rounded-t-[18px] border px-4 text-sm font-bold transition-colors ${selectedExternalTabId === item.id ? 'z-10 border-[#b8c6d8] border-b-white bg-white text-[#855cd6]' : 'border-[#b8c6d8] bg-[#d3dfef] text-[#68758a] hover:bg-[#e7eff9] hover:text-[#575e75]'}`}
              aria-current={selectedExternalTabId === item.id ? 'page' : undefined}
              on:click={() => selectExternalTab(item.id)}
            >
              <span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>*]:h-[18px] [&>*]:w-[18px]" use:mountElement={item.tab.icon}></span>
              <span class="truncate">{item.tab.label}</span>
            </button>
          {/each}
          <div class="hidden">
            <slot name="tabs" registerTab={registerExternalTab} {selectedTab} selectTab={selectEditorTab}></slot>
          </div>
        </div>
        <div class="flex items-center gap-2 pb-2">
          <input
            class="hidden h-[28px] w-[216px] rounded border border-[#c7c7c7] bg-white px-2 text-sm font-semibold text-[#575e75] outline-none placeholder:text-[#6b7280] focus:border-[#855cd6] md:block"
            aria-label="Search blocks"
            placeholder="検索 (Ctrl+F)"
          />
          <button class="rounded-md border border-slate-300 bg-white p-2 hover:bg-slate-50" aria-label={stageFullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={stageFullscreen ? 'Exit fullscreen' : 'Fullscreen'} on:click={toggleStageFullscreen}>
            {#if stageFullscreen}
              <Minimize2 size={17} />
            {:else}
              <Maximize2 size={17} />
            {/if}
          </button>
          <button class="rounded-md border border-slate-300 bg-white p-2 hover:bg-slate-50" aria-label="Refresh workspace" title="Refresh workspace" on:click={() => refresh()}>
            <RotateCcw size={17} />
          </button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden border-t-0 border-[#b8c6d8] bg-white">
        {#if !selectedExternalTabId && selectedTab !== 'code'}
          <AssetSidebar
            bind:selectedTab
            bind:paintColor
            bind:secondaryPaintColor
            {selectedTarget}
            {selectedSoundIndex}
            {isRecordingSound}
            {recordingLevel}
            {costumeThumbnailUrls}
            {lastDeletedCostume}
            {lastDeletedCostumeRestore}
            {lastDeletedSound}
            {lastDeletedSoundRestore}
            {costumeThumbnailKey}
            {costumeDisplaySize}
            {fillCurrentCostume}
            {openLibrary}
            {surpriseCostume}
            {addCostume}
            openCostumeUpload={() => costumeFileInput.click()}
            {addLibraryCostume}
            {beginCostumeDrag}
            {dropCostumeOn}
            {clearCostumeDrag}
            {selectCostume}
            {updateCostumeName}
            {renameCostume}
            {duplicateCostume}
            {exportCostume}
            {moveCostume}
            {deleteCostume}
            {restoreDeletedCostume}
            {generateTone}
            {stopRecordingSound}
            {startRecordingSound}
            {surpriseSound}
            {addSound}
            openSoundUpload={() => soundFileInput.click()}
            {addLibrarySound}
            {beginSoundDrag}
            {dropSoundOn}
            {clearSoundDrag}
            {updateSoundName}
            {selectSound}
            {renameSound}
            {duplicateSound}
            {exportSound}
            {moveSound}
            {editSound}
            {deleteSound}
            {restoreDeletedSound}
            costumeItems={costumeLibrary}
            soundItems={soundLibrary}
          />
        {/if}

        <div class="relative min-h-0 flex-1 overflow-hidden bg-white">
        <CodeEditor bind:host={blocklyHost} visible={!selectedExternalTabId && selectedTab === 'code'} />
        {#if !selectedExternalTabId && selectedTab === 'code'}
          <button
            class="absolute bottom-0 left-0 z-30 flex h-14 w-[72px] items-center justify-center bg-[#855cd6] text-white shadow-[0_-4px_10px_rgba(0,0,0,0.14)] hover:bg-[#7447bf]"
            type="button"
            aria-label="拡張機能を追加"
            title="拡張機能を追加"
            data-testid="open-extension-library"
            on:click={() => openLibrary('extension')}
          >
            <span class="relative text-[26px] font-black leading-none">≋</span>
            <Plus class="ml-0.5 mt-2" size={15} strokeWidth={3} />
          </button>
          {#if visualReportBubble}
            <div
              class="pointer-events-none absolute z-30 -translate-y-1/2 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-semibold text-slate-700 shadow-md"
              style={`left: ${visualReportBubble.left}px; top: ${visualReportBubble.top}px;`}
              data-testid="visual-report"
            >
              {visualReportBubble.value}
            </div>
          {/if}
          <div class="absolute bottom-4 right-4 z-20 flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white shadow-sm">
            <button class="flex h-8 w-8 items-center justify-center border-b border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="Zoom in" title="Zoom in" on:click={() => zoomBlockly(1)}>
              <Plus size={16} />
            </button>
            <button class="flex h-8 w-8 items-center justify-center border-b border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="Zoom out" title="Zoom out" on:click={() => zoomBlockly(-1)}>
              <Minus size={16} />
            </button>
            <button class="flex h-8 w-8 items-center justify-center text-slate-600 hover:bg-slate-50" aria-label="Reset zoom" title="Reset zoom" on:click={resetBlocklyZoom}>
              <RotateCcw size={15} />
            </button>
          </div>
        {/if}
        {#if !selectedExternalTabId && selectedTab === 'costumes'}
          <div class="absolute left-0 top-0 z-10 flex h-5 w-10 gap-1 opacity-0">
            <button data-testid="vector-shape-rect" on:click={() => (vectorShape = 'rect')}>rect</button>
            <button data-testid="asset-tab-sounds" on:click={() => selectEditorTab('sounds')}>sounds</button>
          </div>
          <div class="hidden">
            <div>
              <div class="flex items-center justify-between">
                <h2 class="text-sm font-bold">Vector</h2>
                <div class="flex gap-1">
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={assetUndoStack.length === 0} on:click={undoAssetEdit}>Undo</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={assetRedoStack.length === 0} on:click={redoAssetEdit}>Redo</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={addCostumeToBackpack}>Pack</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={restoreCostumeFromBackpack}>Unpack</button>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-1">
                {#each ['oval', 'rect', 'line', 'text'] as shape}
                  <button data-testid={`legacy-vector-shape-${shape}`} class={`rounded border px-2 py-1 text-xs font-semibold ${vectorShape === shape ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white'}`} on:click={() => (vectorShape = shape as typeof vectorShape)}>{shape}</button>
                {/each}
              </div>
              {#if vectorShape === 'text'}
                <input class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" bind:value={vectorText} aria-label="Vector text" />
              {/if}
              <div class="grid grid-cols-2 gap-2">
                <label class="text-xs font-semibold">Fill<input class="mt-1 h-9 w-full rounded border border-slate-200" type="color" bind:value={paintColor} /></label>
                <label class="text-xs font-semibold">Fill 2<input class="mt-1 h-9 w-full rounded border border-slate-200" type="color" bind:value={secondaryPaintColor} /></label>
                <label class="text-xs font-semibold">Stroke<input class="mt-1 h-9 w-full rounded border border-slate-200" type="color" bind:value={strokeColor} /></label>
                <label class="text-xs font-semibold">Gradient
                  <select class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm" bind:value={paintGradient}>
                    <option value="solid">solid</option>
                    <option value="horizontal">horizontal</option>
                    <option value="vertical">vertical</option>
                    <option value="radial">radial</option>
                  </select>
                </label>
                <label class="text-xs font-semibold">Line<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm" type="number" min="0" max="48" bind:value={strokeWidth} /></label>
                <label class="text-xs font-semibold">Opacity<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm" type="number" min="0" max="100" bind:value={vectorOpacity} /></label>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <label class="text-xs font-semibold">
                  Center X
                  <input class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm" type="number" value={selectedTarget?.costumes[selectedTarget?.currentCostume ?? 0]?.rotationCenterX ?? (selectedTarget?.isStage ? 240 : 48)} on:change={(event) => updateCostumeRotationCenter('x', event)} />
                </label>
                <label class="text-xs font-semibold">
                  Center Y
                  <input class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm" type="number" value={selectedTarget?.costumes[selectedTarget?.currentCostume ?? 0]?.rotationCenterY ?? (selectedTarget?.isStage ? 180 : 48)} on:change={(event) => updateCostumeRotationCenter('y', event)} />
                </label>
              </div>
              <div class={`relative flex aspect-square items-center justify-center rounded-md border bg-white p-2 ${selectedVectorObjectIndex >= 0 ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'}`}>
                {#if costumePreviewUrl}
                  <img class="max-h-full max-w-full object-contain" src={costumePreviewUrl} alt="Costume preview" />
                {:else}
                  <div class="h-16 w-16 rounded-full border-4 border-orange-700 bg-orange-300"></div>
                {/if}
                {#each vectorObjects as object}
                  <button
                    class={`absolute border-2 bg-transparent ${selectedVectorObjectIndices.includes(object.index) || selectedVectorObjectIndex === object.index ? 'border-blue-500' : 'border-transparent hover:border-blue-300'}`}
                    style={vectorObjectOverlayStyle(object)}
                    aria-label={`Select ${object.label}`}
                    on:pointerdown={(event) => beginVectorObjectDrag(object, event)}
                    on:pointermove={dragVectorObject}
                    on:pointerup={endVectorObjectDrag}
                    on:pointercancel={() => (vectorDrag = undefined)}
                  ></button>
                {/each}
                {#if vectorObjects.find((object) => object.index === selectedVectorObjectIndex)}
                  {@const selectedObject = vectorObjects.find((object) => object.index === selectedVectorObjectIndex)!}
                  {#each vectorResizeHandles as handle}
                    <button
                      class={`absolute h-4 w-4 rounded-sm border-2 border-white bg-blue-600 shadow ${handle.cursor}`}
                      style={vectorResizeHandleStyle(selectedObject, handle.id)}
                      aria-label={`Resize selected vector object ${handle.id}`}
                      on:pointerdown={(event) => beginVectorObjectResize(selectedObject, handle.id, event)}
                      on:pointermove={dragVectorObjectResize}
                      on:pointerup={endVectorObjectResize}
                      on:pointercancel={() => (vectorResizeDrag = undefined)}
                    ></button>
                  {/each}
                {/if}
                {#if selectedTarget?.costumes[selectedTarget.currentCostume ?? 0]}
                  <button
                    class="absolute h-5 w-5 rounded-full border-2 border-white bg-blue-600 shadow ring-2 ring-blue-200"
                    style={rotationCenterOverlayStyle()}
                    aria-label="Move rotation center"
                    on:pointerdown={beginRotationCenterDrag}
                    on:pointermove={dragRotationCenter}
                    on:pointerup={endRotationCenterDrag}
                    on:pointercancel={() => (rotationCenterDrag = undefined)}
                  ></button>
                {/if}
                {#if vectorObjects.find((object) => object.index === selectedVectorObjectIndex)}
                  <div class="absolute left-2 top-2 rounded bg-blue-600 px-2 py-1 text-[10px] font-bold text-white">
                    {vectorObjects.find((object) => object.index === selectedVectorObjectIndex)?.label}
                  </div>
                {/if}
              </div>
              <div class="rounded-md border border-slate-200 bg-white p-2">
                <div class="mb-2 flex items-center justify-between">
                  <h3 class="text-xs font-bold uppercase text-slate-500">Objects</h3>
                  <span class="text-[11px] font-semibold text-slate-500">{vectorObjects.length}</span>
                </div>
                <div class="max-h-32 space-y-1 overflow-auto">
                  {#each vectorObjects as object}
                    <button class={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs font-semibold ${selectedVectorObjectIndices.includes(object.index) || selectedVectorObjectIndex === object.index ? 'bg-blue-100 text-blue-700' : 'bg-slate-50 text-slate-600'}`} on:click={(event) => selectVectorObject(object.index, event.shiftKey || event.metaKey || event.ctrlKey)}>
                      <span class="truncate">{object.label}</span>
                      <span class="ml-2 h-3 w-3 rounded-sm border border-slate-300" style={`background:${object.fill ?? object.stroke ?? '#fff'}`}></span>
                    </button>
                  {:else}
                    <p class="text-xs text-slate-500">No editable vector objects.</p>
                  {/each}
                </div>
                {#if selectedVectorObjectIndices.length > 1}
                  <p class="mt-2 text-[11px] font-semibold text-blue-700">{selectedVectorObjectIndices.length} objects selected</p>
                {/if}
                <div class="mt-2 grid grid-cols-4 gap-1">
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('duplicate')}>Copy</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('delete')}>Delete</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('front')}>Front</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('back')}>Back</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('forward')}>Fwd</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('backward')}>Backwd</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('group')}>Group</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('ungroup')}>Ungroup</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('left')}>Left</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('right')}>Right</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('up')}>Up</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('down')}>Down</button>
                </div>
                <div class="mt-2 grid grid-cols-3 gap-1">
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-left')}>Align L</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-center')}>Align C</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-right')}>Align R</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-top')}>Align T</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-middle')}>Align M</button>
                  <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndices.length < 2} on:click={() => editVectorObject('align-bottom')}>Align B</button>
                </div>
                <button class="mt-2 w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40" disabled={selectedVectorObjectIndex < 0} on:click={() => editVectorObject('style')}>Apply fill and stroke</button>
                {#if vectorObjects.find((object) => object.index === selectedVectorObjectIndex)}
                  {@const selectedObject = vectorObjects.find((object) => object.index === selectedVectorObjectIndex)!}
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <label class="text-[11px] font-semibold text-slate-500">X<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" value={selectedObject.x ?? 0} on:change={(event) => updateVectorObjectNumber('x', event)} /></label>
                    <label class="text-[11px] font-semibold text-slate-500">Y<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" value={selectedObject.y ?? 0} on:change={(event) => updateVectorObjectNumber('y', event)} /></label>
                    <label class="text-[11px] font-semibold text-slate-500">W<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" value={selectedObject.width ?? 100} on:change={(event) => updateVectorObjectNumber('width', event)} /></label>
                    <label class="text-[11px] font-semibold text-slate-500">H<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" value={selectedObject.height ?? 100} on:change={(event) => updateVectorObjectNumber('height', event)} /></label>
                    <label class="text-[11px] font-semibold text-slate-500">Line<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" min="0" value={selectedObject.strokeWidth ?? strokeWidth} on:change={updateVectorObjectStrokeWidth} /></label>
                    <label class="text-[11px] font-semibold text-slate-500">Opacity<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" min="0" max="100" value={Math.round((selectedObject.opacity ?? 1) * 100)} on:change={updateVectorObjectOpacity} /></label>
                    <label class="col-span-2 text-[11px] font-semibold text-slate-500">Rotation<input class="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs" type="number" value={selectedObject.rotation ?? 0} on:change={updateVectorObjectRotation} /></label>
                  </div>
                  {#if selectedObject.tag === 'text'}
                    <input class="mt-2 w-full rounded border border-slate-200 px-2 py-1 text-xs" value={selectedObject.text ?? ''} aria-label="Selected vector text" on:change={updateVectorObjectText} />
                  {/if}
                  <div class="mt-2 grid grid-cols-2 gap-1">
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => scaleSelectedVectorObject(1.1)}>Grow</button>
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => scaleSelectedVectorObject(0.9)}>Shrink</button>
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => rotateSelectedVectorObject(-15)}>Rotate -15</button>
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => rotateSelectedVectorObject(15)}>Rotate +15</button>
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => flipSelectedVectorObject(true)}>Flip H</button>
                    <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold" on:click={() => flipSelectedVectorObject(false)}>Flip V</button>
                  </div>
                {/if}
              </div>
              <button data-testid="legacy-save-vector-costume" class="w-full rounded-md bg-blue-500 px-3 py-2 text-sm font-semibold text-white" on:click={saveVectorCostume}>Save vector</button>
            </div>
          </div>
            <BitmapEditor
              bind:bitmapCanvas
              {bitmapCanvasWidth}
              {bitmapCanvasHeight}
              bind:costumeEditMode
              bind:bitmapTool
              bind:vectorShape
              bind:brushSize
              bind:paintColor
              bind:secondaryPaintColor
              bind:paintGradient
              bind:strokeColor
              bind:strokeWidth
              bind:vectorOpacity
              bind:vectorText
              viewportKey={`${selectedTarget?.id ?? selectedTarget?.name ?? 'target'}:${selectedTarget?.currentCostume ?? 0}`}
              currentCostumeName={selectedTarget?.costumes[selectedTarget?.currentCostume ?? 0]?.name ?? ''}
              currentCostumePreviewUrl={costumePreviewUrl}
              currentCostumePreviewSvg={costumePreviewSvg}
              currentCostumeIndex={selectedTarget?.currentCostume ?? 0}
              updateCurrentCostumeName={(event) => selectedTarget && updateCostumeName(selectedTarget.currentCostume ?? 0, event)}
              canUndo={assetUndoStack.length > 0}
              canRedo={assetRedoStack.length > 0}
              {undoAssetEdit}
              {redoAssetEdit}
              {bitmapSelection}
              {bitmapClipboard}
              {vectorObjects}
              {selectedVectorObjectIndex}
              {selectedVectorObjectIndices}
              vectorCanvasWidth={480}
              vectorCanvasHeight={360}
              {beginBitmapPaint}
              {paintBitmap}
              {endBitmapPaint}
              {pickBitmapColor}
              {clearBitmapCanvas}
              {copyBitmapSelection}
              {pasteBitmapSelection}
              {cropBitmapSelection}
              {flipBitmap}
              {rotateBitmap}
              deleteCurrentCostume={() => selectedTarget && deleteCostume(selectedTarget.currentCostume ?? 0)}
              duplicateCurrentCostume={() => selectedTarget && duplicateCostume(selectedTarget.currentCostume ?? 0)}
              {deleteEditorSelection}
              {refreshAssetEditorPreviews}
              {convertCurrentCostumeToVector}
              {convertCurrentCostumeToBitmap}
              {saveVectorCostume}
              {saveVectorBrushStroke}
              {saveVectorShapeInRect}
              {fillVectorObjectAtPoint}
              {eraseVectorObjectAtPoint}
              saveBitmapCostume={() => saveBitmapCostume()}
              {beginVectorObjectDrag}
              {dragVectorObject}
              {endVectorObjectDrag}
              {beginVectorObjectResize}
              {dragVectorObjectResize}
              {endVectorObjectResize}
              {beginVectorPathPointDrag}
              {dragVectorPathPoint}
              {endVectorPathPointDrag}
              {selectVectorObjectsInRect}
              {clearVectorObjectSelection}
            />
        {:else if !selectedExternalTabId && selectedTab === 'sounds'}
          <SoundEditor
            {selectedTarget}
            {selectedSoundIndex}
            {assetUndoStack}
            {assetRedoStack}
            {soundClipboard}
            {soundWaveform}
            bind:soundTrimStart
            bind:soundTrimEnd
            {soundPlayhead}
            {previewAudio}
            bind:soundTrimDrag
            {undoAssetEdit}
            {redoAssetEdit}
            {updateSoundName}
            {addSoundToBackpack}
            {restoreSoundFromBackpack}
            {generateTone}
            {previewSound}
            {stopPreviewSound}
            {copySound}
            {pasteSound}
            {copySoundToNew}
            {exportSound}
            {deleteSoundSelection}
            {editSound}
            {beginSoundWaveformSelection}
            {updateSoundWaveformSelection}
            {endSoundWaveformSelection}
            {beginSoundTrimHandle}
            {dragSoundTrimHandle}
            {endSoundTrimHandle}
            {updateSoundTrim}
          />
        {:else if activeContextTab}
          <div class="h-full min-h-0 overflow-hidden" use:mountElement={activeContextTab.tab.content}></div>
        {:else if !selectedExternalTabId && selectedTab !== 'code'}
          <div class="flex min-h-[28rem] items-center justify-center text-sm text-slate-500">
            Select a tab to edit assets.
          </div>
        {/if}
        </div>
      </div>
    </section>

    <button
      class={`stage-pane-resizer min-h-0 w-2 cursor-col-resize border-x border-[#b8c6d8] bg-[#d7e5f6] transition-colors hover:bg-[#b8d3f5] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#855cd6] ${stageFullscreen ? 'stage-pane-resizer--hidden' : ''}`}
      type="button"
      aria-label="Resize stage pane"
      title="Resize stage pane"
      on:pointerdown={beginStagePaneResize}
      on:keydown={adjustStagePaneWidth}
    ></button>

    <aside data-testid="stage-pane" class={`flex min-h-0 flex-col overflow-hidden border-t border-[#b8c6d8] bg-[#e8f1fc] lg:border-t-0 ${stageFullscreen ? 'fixed inset-0 z-50 border-0 lg:border-0' : ''}`}>
      <StagePanel
        bind:stageCanvas
        {stageFullscreen}
        {snapshot}
        {fps}
        {visibleMonitors}
        {toggleStageFullscreen}
        {pickSprite}
        {updateMouse}
        {beginStageSpriteDrag}
        {dragStageSprite}
        {endStageSpriteDrag}
        {cancelStageSpriteDrag}
        {cycleMonitorMode}
        {setMonitorMode}
        {hideMonitor}
        {editMonitorSliderLimit}
        {updateMonitorSlider}
        greenFlag={startProject}
        stopAll={stopProject}
        stepRuntime={stepProjectRuntime}
      />

      <SpritePane
        {selectedTarget}
        {stage}
        {sprites}
        {targetThumbnailUrls}
        {spriteContextMenu}
        {targetThumbnailKey}
        {activateOnEnter}
        {paintNewSprite}
        {openLibrary}
        {openSpritePicker}
        {surpriseSprite}
        {addSprite}
        {paintNewBackdrop}
        {openBackdropPicker}
        {surpriseBackdrop}
        {addLibrarySprite}
        selectTarget={(name) => vm.selectTarget(name)}
        {beginSpriteDrag}
        {dropSpriteOn}
        {clearSpriteDrag}
        {openSpriteContextMenu}
        {duplicateSpriteByName}
        {exportSpriteByName}
        {deleteSpriteByName}
        libraryItems={spriteLibrary}
        {updateTargetName}
        {updateNumber}
        {setDirection}
        {updateDirectionDial}
        {setRotationStyle}
        {setVisible}
      />
    </aside>
  </section>
</main>
