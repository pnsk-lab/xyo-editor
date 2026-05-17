<script lang="ts">
  import type paperCore from 'paper/dist/paper-core'
  import {
    AlignCenterVertical,
    AlignEndHorizontal,
    AlignStartHorizontal,
    Brush,
    Circle,
    Copy,
    Eraser,
    FlipHorizontal2,
    FlipVertical2,
    Image,
    MousePointer2,
    PaintBucket,
    Redo2,
    RotateCcw,
    RotateCw,
    SendToBack,
    Slash,
    Square,
    Trash2,
    Type,
    Undo2,
    ZoomIn,
    ZoomOut,
  } from 'lucide-svelte'
  import type { BitmapTool, VectorObjectInfo, VectorPathPointInfo, VectorResizeHandle } from '../../lib/editor-types'

  type CostumeEditMode = 'bitmap' | 'vector'
  type VectorShape = 'rect' | 'oval' | 'line' | 'text'
  type VectorTool = 'select' | 'reshape' | 'brush' | 'eraser' | 'fill' | VectorShape
  type ViewportState = { x: number; y: number; scale: number }
  type Rect = { x: number; y: number; width: number; height: number }

  const BITMAP_STAGE_WIDTH = 480
  const BITMAP_STAGE_HEIGHT = 360
  const BITMAP_WORKSPACE_SCALE = 5
  const BITMAP_WORKSPACE_WIDTH = BITMAP_STAGE_WIDTH * BITMAP_WORKSPACE_SCALE
  const BITMAP_WORKSPACE_HEIGHT = BITMAP_STAGE_HEIGHT * BITMAP_WORKSPACE_SCALE
  const VECTOR_WORKSPACE_SCALE = 5

  let {
    bitmapCanvas = $bindable(),
    bitmapCanvasWidth = BITMAP_WORKSPACE_WIDTH,
    bitmapCanvasHeight = BITMAP_WORKSPACE_HEIGHT,
    costumeEditMode = $bindable('bitmap'),
    bitmapTool = $bindable('brush'),
    vectorShape = $bindable('oval'),
    brushSize = $bindable(7),
    paintColor = $bindable('#ffab19'),
    secondaryPaintColor = $bindable('#ffffff'),
    paintGradient = $bindable('solid'),
    strokeColor = $bindable('#0f172a'),
    strokeWidth = $bindable(4),
    vectorOpacity = $bindable(100),
    vectorText = $bindable('Text'),
    viewportKey = '',
    currentCostumeName = '',
    currentCostumePreviewUrl = '',
    currentCostumePreviewSvg = '',
    currentCostumeIndex = 0,
    updateCurrentCostumeName,
    canUndo = false,
    canRedo = false,
    undoAssetEdit,
    redoAssetEdit,
    bitmapSelection,
    bitmapClipboard,
    vectorObjects = [],
    selectedVectorObjectIndex = -1,
    selectedVectorObjectIndices = [],
    vectorCanvasWidth = 96,
    vectorCanvasHeight = 96,
    beginBitmapPaint,
    paintBitmap,
    endBitmapPaint,
    pickBitmapColor,
    clearBitmapCanvas,
    copyBitmapSelection,
    pasteBitmapSelection,
    cropBitmapSelection,
    flipBitmap,
    rotateBitmap,
    deleteCurrentCostume,
    duplicateCurrentCostume,
    deleteEditorSelection,
    refreshAssetEditorPreviews,
    convertCurrentCostumeToVector,
    convertCurrentCostumeToBitmap,
    saveVectorCostume,
    saveVectorBrushStroke,
    saveVectorShapeInRect,
    fillVectorObjectAtPoint,
    eraseVectorObjectAtPoint,
    saveBitmapCostume,
    beginVectorObjectDrag,
    dragVectorObject,
    endVectorObjectDrag,
    beginVectorObjectResize,
    dragVectorObjectResize,
    endVectorObjectResize,
    beginVectorPathPointDrag,
    dragVectorPathPoint,
    endVectorPathPointDrag,
    selectVectorObjectsInRect,
    clearVectorObjectSelection,
  } = $props<{
    bitmapCanvas?: HTMLCanvasElement
    bitmapCanvasWidth?: number
    bitmapCanvasHeight?: number
    costumeEditMode: CostumeEditMode
    bitmapTool: BitmapTool
    vectorShape: VectorShape
    brushSize: number
    paintColor: string
    secondaryPaintColor: string
    paintGradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
    strokeColor: string
    strokeWidth: number
    vectorOpacity: number
    vectorText: string
    viewportKey?: string
    currentCostumeName?: string
    currentCostumePreviewUrl?: string
    currentCostumePreviewSvg?: string
    currentCostumeIndex?: number
    updateCurrentCostumeName: (event: Event) => void
    canUndo: boolean
    canRedo: boolean
    undoAssetEdit: () => void | Promise<void>
    redoAssetEdit: () => void | Promise<void>
    bitmapSelection: { x: number; y: number; width: number; height: number } | undefined
    bitmapClipboard: ImageData | undefined
    vectorObjects?: VectorObjectInfo[]
    selectedVectorObjectIndex?: number
    selectedVectorObjectIndices?: number[]
    vectorCanvasWidth?: number
    vectorCanvasHeight?: number
    beginBitmapPaint: (event: MouseEvent) => void | Promise<void>
    paintBitmap: (event: MouseEvent) => void
    endBitmapPaint: (event: MouseEvent) => void | Promise<void>
    pickBitmapColor: (event: MouseEvent) => void
    clearBitmapCanvas: () => void | Promise<void>
    copyBitmapSelection: (cut?: boolean) => void | Promise<void>
    pasteBitmapSelection: () => void | Promise<void>
    cropBitmapSelection: () => void | Promise<void>
    flipBitmap: (horizontal: boolean) => void | Promise<void>
    rotateBitmap: (clockwise: boolean) => void | Promise<void>
    deleteCurrentCostume: () => void | Promise<void>
    duplicateCurrentCostume: () => void
    deleteEditorSelection: () => void | Promise<void>
    refreshAssetEditorPreviews: () => void | Promise<void>
    convertCurrentCostumeToVector: () => void | Promise<void>
    convertCurrentCostumeToBitmap: () => void | Promise<void>
    saveVectorCostume: (center?: { x: number; y: number }) => void | Promise<void>
    saveVectorBrushStroke: (points: Array<{ x: number; y: number }>) => void | Promise<void>
    saveVectorShapeInRect: (shape: 'rect' | 'oval' | 'line', rect: Rect) => void | Promise<void>
    fillVectorObjectAtPoint: (point: { x: number; y: number }) => void | Promise<void>
    eraseVectorObjectAtPoint: (point: { x: number; y: number }) => void | Promise<void>
    saveBitmapCostume: () => void | Promise<void>
    beginVectorObjectDrag?: (object: VectorObjectInfo, event: PointerEvent) => void
    dragVectorObject?: (event: PointerEvent) => void
    endVectorObjectDrag?: (event: PointerEvent) => void | Promise<void>
    beginVectorObjectResize?: (object: VectorObjectInfo, handle: VectorResizeHandle, event: PointerEvent) => void
    dragVectorObjectResize?: (event: PointerEvent) => void
    endVectorObjectResize?: (event: PointerEvent) => void | Promise<void>
    beginVectorPathPointDrag?: (object: VectorObjectInfo, pointIndex: number, event: PointerEvent) => void
    dragVectorPathPoint?: (event: PointerEvent) => void
    endVectorPathPointDrag?: (event: PointerEvent) => void | Promise<void>
    selectVectorObjectsInRect?: (rect: Rect, append?: boolean) => void
    clearVectorObjectSelection?: () => void
  }>()

  const tools: Array<{ id: BitmapTool; label: string; icon: typeof MousePointer2 }> = [
    { id: 'select', label: 'Select', icon: MousePointer2 },
    { id: 'brush', label: 'Brush', icon: Brush },
    { id: 'eraser', label: 'Eraser', icon: Eraser },
    { id: 'fill', label: 'Fill', icon: PaintBucket },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'line', label: 'Line', icon: Slash },
    { id: 'oval', label: 'Circle', icon: Circle },
    { id: 'rect', label: 'Rectangle', icon: Square },
  ]

  const vectorTools: Array<{ id: VectorTool; label: string; icon: typeof MousePointer2 }> = [
    { id: 'select', label: 'Select', icon: MousePointer2 },
    { id: 'reshape', label: 'Reshape', icon: RotateCw },
    { id: 'brush', label: 'Brush', icon: Brush },
    { id: 'eraser', label: 'Eraser', icon: Eraser },
    { id: 'fill', label: 'Fill', icon: PaintBucket },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'line', label: 'Line', icon: Slash },
    { id: 'oval', label: 'Oval', icon: Circle },
    { id: 'rect', label: 'Rectangle', icon: Square },
  ]

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

  let viewportX = $state(0)
  let viewportY = $state(0)
  let viewportScale = $state(1)
  let vectorTool = $state<VectorTool>('select')
  let activeViewportKey = ''
  let viewportStates = new Map<string, ViewportState>()
  let viewportNode: HTMLElement | undefined
  let paperViewportCanvas: HTMLCanvasElement | undefined
  let paperViewportModule: typeof paperCore | undefined
  let paperViewportScope: paper.PaperScope | undefined
  let viewportResizeObserver: ResizeObserver | undefined
  let editSurfaceNode: HTMLElement | undefined
  let vectorMarquee = $state<{ start: { x: number; y: number }; current: { x: number; y: number }; append: boolean } | undefined>()
  let vectorBrushPoints = $state<Array<{ x: number; y: number }>>([])
  let vectorShapeDraft = $state<{ shape: 'rect' | 'oval' | 'line'; start: { x: number; y: number }; current: { x: number; y: number } } | undefined>()
  let activeCostumeEditMode = costumeEditMode

  function clampZoom(value: number) {
    return Math.max(0.25, Math.min(5, value))
  }

  function zoomCanvas(factor: number) {
    setViewport(viewportX, viewportY, clampZoom(viewportScale * factor))
  }

  function resetViewport() {
    viewportX = 0
    viewportY = 0
    viewportScale = 1
    saveViewportState()
    drawPaperViewport()
  }

  async function switchCostumeEditMode(nextMode: CostumeEditMode) {
    if (costumeEditMode === nextMode) return
    if (nextMode === 'bitmap') await convertCurrentCostumeToBitmap()
    else await convertCurrentCostumeToVector()
    switchToolForFormat(nextMode)
    costumeEditMode = nextMode
    activeCostumeEditMode = nextMode
    drawPaperViewport()
  }

  function switchToolForFormat(nextMode: CostumeEditMode) {
    if (nextMode === 'vector') {
      const nextVectorTool: Record<BitmapTool, VectorTool> = {
        select: 'select',
        brush: 'brush',
        eraser: 'eraser',
        fill: 'fill',
        text: 'text',
        line: 'line',
        oval: 'oval',
        rect: 'rect',
      }
      chooseVectorTool(nextVectorTool[bitmapTool as BitmapTool] ?? 'brush')
      return
    }
    const nextBitmapTool: Record<VectorTool, BitmapTool> = {
      select: 'select',
      reshape: 'select',
      brush: 'brush',
      eraser: 'eraser',
      fill: 'fill',
      text: 'text',
      line: 'line',
      oval: 'oval',
      rect: 'rect',
    }
    bitmapTool = nextBitmapTool[vectorTool] ?? 'brush'
  }

  function handleViewportWheel(event: WheelEvent) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      zoomCanvas(event.deltaY > 0 ? 0.9 : 1.1)
      return
    }
    setViewport(viewportX - event.deltaX, viewportY - event.deltaY, viewportScale)
  }

  function canvasBaseSize(node: HTMLElement) {
    return {
      width: editSurfaceWidth(),
      height: editSurfaceHeight(),
    }
  }

  function editSurfaceWidth() {
    return costumeEditMode === 'vector' ? BITMAP_WORKSPACE_WIDTH : bitmapCanvasWidth
  }

  function editSurfaceHeight() {
    return costumeEditMode === 'vector' ? BITMAP_WORKSPACE_HEIGHT : bitmapCanvasHeight
  }

  function setViewport(x: number, y: number, scale = viewportScale) {
    viewportScale = scale
    viewportX = x
    viewportY = y
    saveViewportState()
    drawPaperViewport()
  }

  function saveViewportState(key = activeViewportKey) {
    if (!key) return
    viewportStates = new Map(viewportStates).set(key, { x: viewportX, y: viewportY, scale: viewportScale })
  }

  function loadViewportState(key: string) {
    const saved = viewportStates.get(key) ?? { x: 0, y: 0, scale: 1 }
    viewportX = saved.x
    viewportY = saved.y
    viewportScale = saved.scale
    drawPaperViewport()
  }

  function clampCurrentViewport() {
    drawPaperViewport()
  }

  function viewportWheel(node: HTMLElement) {
    viewportNode = node
    viewportResizeObserver = new ResizeObserver(clampCurrentViewport)
    viewportResizeObserver.observe(node)
    void setupPaperViewport()
    clampCurrentViewport()
    node.addEventListener('wheel', handleViewportWheel, { passive: false })
    node.addEventListener('mousedown', handleCanvasMouseDown)
    node.addEventListener('mousemove', handleCanvasMouseMove)
    node.addEventListener('mouseup', handleCanvasMouseUp)
    node.addEventListener('mouseleave', handleCanvasMouseUp)
    node.addEventListener('dblclick', handleCanvasDoubleClick)
    return {
      destroy() {
        node.removeEventListener('wheel', handleViewportWheel)
        node.removeEventListener('mousedown', handleCanvasMouseDown)
        node.removeEventListener('mousemove', handleCanvasMouseMove)
        node.removeEventListener('mouseup', handleCanvasMouseUp)
        node.removeEventListener('mouseleave', handleCanvasMouseUp)
        node.removeEventListener('dblclick', handleCanvasDoubleClick)
        viewportResizeObserver?.disconnect()
        viewportResizeObserver = undefined
        paperViewportScope?.project?.clear()
        paperViewportScope = undefined
        if (viewportNode === node) viewportNode = undefined
      },
    }
  }

  async function setupPaperViewport() {
    if (!paperViewportCanvas) return
    if (!paperViewportModule) {
      const imported = await import('paper/dist/paper-core')
      paperViewportModule = ('default' in imported ? imported.default : imported) as typeof paperCore
    }
    if (!paperViewportScope) {
      paperViewportScope = new paperViewportModule.PaperScope()
      paperViewportScope.setup(paperViewportCanvas)
    }
    drawPaperViewport()
  }

  function drawPaperViewport() {
    const node = viewportNode
    const canvas = paperViewportCanvas
    const scope = paperViewportScope
    if (!node || !canvas || !scope) return
    const width = Math.max(1, node.clientWidth)
    const height = Math.max(1, node.clientHeight)
    const pixelRatio = window.devicePixelRatio || 1
    const backingWidth = Math.max(1, Math.round(width * pixelRatio))
    const backingHeight = Math.max(1, Math.round(height * pixelRatio))
    if (canvas.width !== backingWidth) canvas.width = backingWidth
    if (canvas.height !== backingHeight) canvas.height = backingHeight
    scope.view.viewSize = new scope.Size(width, height)
    scope.project.activeLayer.removeChildren()

    const context = canvas.getContext('2d')
    if (!context) return
    context.save()
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)

    const base = canvasBaseSize(node)
    const pixelsPerBitmap = (base.width / Math.max(1, editSurfaceWidth())) * viewportScale
    const tile = Math.max(2, Math.round(10 * pixelsPerBitmap))
    const period = tile * 2
    const originX = Math.round(width / 2 - (base.width * viewportScale) / 2 + viewportX)
    const originY = Math.round(height / 2 - (base.height * viewportScale) / 2 + viewportY)
    const startX = originX + Math.floor((0 - originX) / period) * period - period
    const startY = originY + Math.floor((0 - originY) / period) * period - period

    context.fillStyle = '#e8eef7'
    for (let y = startY; y < height + period; y += tile) {
      for (let x = startX; x < width + period; x += tile) {
        const column = Math.floor((x - originX) / tile)
        const row = Math.floor((y - originY) / tile)
        if ((column + row) % 2 !== 0) continue
        context.fillRect(Math.round(x), Math.round(y), tile, tile)
      }
    }
    context.restore()
  }

  function selectionStyle(rect: { x: number; y: number; width: number; height: number }) {
    return `left:${(rect.x / bitmapCanvasWidth) * 100}%;top:${(rect.y / bitmapCanvasHeight) * 100}%;width:${(rect.width / bitmapCanvasWidth) * 100}%;height:${(rect.height / bitmapCanvasHeight) * 100}%;`
  }

  function vectorObjectStyle(object: VectorObjectInfo) {
    const left = vectorArtLeft() + (object.boundsX ?? object.x ?? 0) * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + (object.boundsY ?? object.y ?? 0) * VECTOR_WORKSPACE_SCALE
    const width = Math.max(8, (object.boundsWidth ?? object.width ?? 2) * VECTOR_WORKSPACE_SCALE)
    const height = Math.max(8, (object.boundsHeight ?? object.height ?? 2) * VECTOR_WORKSPACE_SCALE)
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`
  }

  function vectorResizeHandleStyle(object: VectorObjectInfo, handle: VectorResizeHandle) {
    const objectLeft = object.boundsX ?? object.x ?? 0
    const objectTop = object.boundsY ?? object.y ?? 0
    const objectWidth = object.boundsWidth ?? object.width ?? 2
    const objectHeight = object.boundsHeight ?? object.height ?? 2
    const handleX = handle.includes('w') ? objectLeft : handle.includes('e') ? objectLeft + objectWidth : objectLeft + objectWidth / 2
    const handleY = handle.includes('n') ? objectTop : handle.includes('s') ? objectTop + objectHeight : objectTop + objectHeight / 2
    const left = vectorArtLeft() + handleX * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + handleY * VECTOR_WORKSPACE_SCALE
    return `left:${left}px;top:${top}px;transform:translate(-50%, -50%);`
  }

  function vectorPathPointStyle(point: { x: number; y: number }) {
    const left = vectorArtLeft() + point.x * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + point.y * VECTOR_WORKSPACE_SCALE
    return `left:${left}px;top:${top}px;transform:translate(-50%, -50%);`
  }

  function vectorControlLineStyle(anchor: VectorPathPointInfo, control: VectorPathPointInfo) {
    const x1 = vectorArtLeft() + anchor.x * VECTOR_WORKSPACE_SCALE
    const y1 = vectorArtTop() + anchor.y * VECTOR_WORKSPACE_SCALE
    const x2 = vectorArtLeft() + control.x * VECTOR_WORKSPACE_SCALE
    const y2 = vectorArtTop() + control.y * VECTOR_WORKSPACE_SCALE
    return { x1, y1, x2, y2 }
  }

  function relatedAnchorForControl(points: VectorPathPointInfo[], control: VectorPathPointInfo) {
    if (control.relatedAnchorIndex === undefined) return undefined
    return points.find((point) => point.index === control.relatedAnchorIndex && point.kind !== 'control')
  }

  function vectorControlPoints(points: VectorPathPointInfo[]) {
    return points.filter((point): point is VectorPathPointInfo => point.kind === 'control')
  }

  function vectorArtLeft() {
    return ((BITMAP_STAGE_WIDTH - vectorCanvasWidth) / 2) * VECTOR_WORKSPACE_SCALE
  }

  function vectorArtTop() {
    return ((BITMAP_STAGE_HEIGHT - vectorCanvasHeight) / 2) * VECTOR_WORKSPACE_SCALE
  }

  function vectorArtStyle() {
    return `left:${vectorArtLeft()}px;top:${vectorArtTop()}px;width:${vectorCanvasWidth * VECTOR_WORKSPACE_SCALE}px;height:${vectorCanvasHeight * VECTOR_WORKSPACE_SCALE}px;`
  }

  function vectorMarqueeStyle() {
    if (!vectorMarquee) return ''
    const rect = normalizedRect(vectorMarquee.start, vectorMarquee.current)
    return `left:${rect.x * VECTOR_WORKSPACE_SCALE}px;top:${rect.y * VECTOR_WORKSPACE_SCALE}px;width:${rect.width * VECTOR_WORKSPACE_SCALE}px;height:${rect.height * VECTOR_WORKSPACE_SCALE}px;`
  }

  function vectorShapeDraftStyle() {
    if (!vectorShapeDraft) return ''
    const rect = normalizedRect(vectorShapeDraft.start, vectorShapeDraft.current)
    return `left:${rect.x * VECTOR_WORKSPACE_SCALE}px;top:${rect.y * VECTOR_WORKSPACE_SCALE}px;width:${rect.width * VECTOR_WORKSPACE_SCALE}px;height:${rect.height * VECTOR_WORKSPACE_SCALE}px;`
  }

  function vectorPointFromEvent(event: MouseEvent | PointerEvent) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect) return undefined
    return {
      x: Math.max(0, Math.min(vectorCanvasWidth, ((event.clientX - rect.left) / rect.width) * vectorCanvasWidth)),
      y: Math.max(0, Math.min(vectorCanvasHeight, ((event.clientY - rect.top) / rect.height) * vectorCanvasHeight)),
    }
  }

  function normalizedRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
    const left = Math.min(start.x, end.x)
    const top = Math.min(start.y, end.y)
    return { x: left, y: top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
  }

  function chooseVectorTool(tool: VectorTool) {
    vectorTool = tool
    if (tool === 'rect' || tool === 'oval' || tool === 'line' || tool === 'text') vectorShape = tool
  }

  function selectedVectorObject() {
    return vectorObjects.find((object: VectorObjectInfo) => object.index === selectedVectorObjectIndex)
  }

  $effect(() => {
    if (paperViewportCanvas && viewportNode) void setupPaperViewport()
  })

  $effect(() => {
    const nextKey = viewportKey || `costume:${currentCostumeIndex}`
    if (nextKey === activeViewportKey) return
    saveViewportState()
    activeViewportKey = nextKey
    loadViewportState(nextKey)
  })

  $effect(() => {
    if (costumeEditMode === activeCostumeEditMode) return
    switchToolForFormat(costumeEditMode)
    activeCostumeEditMode = costumeEditMode
  })

  function handleCanvasMouseDown(event: MouseEvent) {
    if (costumeEditMode === 'bitmap') return beginBitmapPaint(event)
    if (costumeEditMode === 'vector') {
      if ((event.target as HTMLElement).closest('[data-vector-object]')) return
      const point = vectorPointFromEvent(event)
      if (!point) return
      if (vectorTool === 'select' || vectorTool === 'reshape') {
        vectorMarquee = { start: point, current: point, append: event.shiftKey || event.metaKey || event.ctrlKey }
        return
      }
      if (vectorTool === 'brush') {
        vectorBrushPoints = [point]
        return
      }
      if (vectorTool === 'fill') return fillVectorObjectAtPoint(point)
      if (vectorTool === 'eraser') return eraseVectorObjectAtPoint(point)
      if (vectorTool === 'rect' || vectorTool === 'oval' || vectorTool === 'line') {
        vectorShapeDraft = { shape: vectorTool, start: point, current: point }
        return
      }
      const x = point.x
      const y = point.y
      return saveVectorCostume({ x: Math.max(0, Math.min(vectorCanvasWidth, x)), y: Math.max(0, Math.min(vectorCanvasHeight, y)) })
    }
  }

  function handleCanvasMouseMove(event: MouseEvent) {
    if (costumeEditMode === 'bitmap') paintBitmap(event)
    if (costumeEditMode === 'vector' && vectorMarquee) {
      const point = vectorPointFromEvent(event)
      if (point) vectorMarquee = { ...vectorMarquee, current: point }
    }
    if (costumeEditMode === 'vector' && vectorTool === 'brush' && vectorBrushPoints.length > 0) {
      const point = vectorPointFromEvent(event)
      if (point) vectorBrushPoints = [...vectorBrushPoints, point]
    }
    if (costumeEditMode === 'vector' && vectorTool === 'eraser' && event.buttons > 0) {
      const point = vectorPointFromEvent(event)
      if (point) void eraseVectorObjectAtPoint(point)
    }
    if (costumeEditMode === 'vector' && vectorShapeDraft) {
      const point = vectorPointFromEvent(event)
      if (point) vectorShapeDraft = { ...vectorShapeDraft, current: point }
    }
  }

  function handleCanvasMouseUp(event: MouseEvent) {
    if (costumeEditMode === 'bitmap') return endBitmapPaint(event)
    if (costumeEditMode === 'vector' && vectorMarquee) {
      const rect = normalizedRect(vectorMarquee.start, vectorMarquee.current)
      const dragged = rect.width > 2 || rect.height > 2
      const append = vectorMarquee.append
      vectorMarquee = undefined
      if (dragged) selectVectorObjectsInRect?.(rect, append)
      else if (!append) clearVectorObjectSelection?.()
    }
    if (costumeEditMode === 'vector' && vectorTool === 'brush' && vectorBrushPoints.length > 0) {
      const points = vectorBrushPoints
      vectorBrushPoints = []
      if (points.length > 1) void saveVectorBrushStroke(points)
    }
    if (costumeEditMode === 'vector' && vectorShapeDraft) {
      const draft = vectorShapeDraft
      vectorShapeDraft = undefined
      const rect = normalizedRect(draft.start, draft.current)
      if (rect.width > 2 || rect.height > 2) void saveVectorShapeInRect(draft.shape, rect)
      else void saveVectorCostume(draft.start)
    }
  }

  function handleCanvasDoubleClick(event: MouseEvent) {
    if (costumeEditMode === 'bitmap') pickBitmapColor(event)
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-white">
  <div class="flex min-h-[118px] shrink-0 items-start gap-4 overflow-x-auto border-b border-slate-200 px-4 py-3">
    <div class="flex min-w-[210px] items-center gap-2 pt-1">
      <span class="text-xs font-bold text-slate-600">コスチューム</span>
      <input class="h-9 w-36 rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 outline-none focus:border-[#8d5de8]" value={currentCostumeName} aria-label={`Rename ${currentCostumeName || 'costume'}`} onchange={updateCurrentCostumeName} />
    </div>

    <div class="flex flex-1 flex-col gap-3">
      <div class="flex h-8 items-center gap-3">
        <div class="flex overflow-hidden rounded-md border border-slate-200 bg-white">
          <button class="flex h-8 w-9 items-center justify-center text-[#8d5de8] disabled:opacity-30" aria-label="Undo" title="Undo" disabled={!canUndo} onclick={undoAssetEdit}><Undo2 size={17} /></button>
          <button class="flex h-8 w-9 items-center justify-center border-l border-slate-200 text-[#8d5de8] disabled:opacity-30" aria-label="Redo" title="Redo" disabled={!canRedo} onclick={redoAssetEdit}><Redo2 size={17} /></button>
        </div>
        <div class="flex items-center gap-7 border-l border-dashed border-slate-200 pl-6 text-[#8d5de8]">
          <button class="toolbar-icon" aria-label="Duplicate costume" title="Duplicate" onclick={duplicateCurrentCostume}><Copy size={20} /></button>
          <button class="toolbar-icon opacity-60" aria-label="Group" title="Group"><AlignCenterVertical size={21} /></button>
          <button class="toolbar-icon opacity-60" aria-label="Bring forward" title="Bring forward"><AlignStartHorizontal size={21} /></button>
          <button class="toolbar-icon opacity-60" aria-label="Send backward" title="Send backward"><AlignEndHorizontal size={21} /></button>
          <button class="toolbar-icon opacity-60" aria-label="Send to back" title="Send to back"><SendToBack size={21} /></button>
        </div>
        <div class="flex items-center gap-7 border-l border-dashed border-slate-200 pl-6 text-[#8d5de8]">
          <button class="toolbar-icon" aria-label="Delete selection" title="Delete" onclick={deleteEditorSelection}><Trash2 size={21} /></button>
          <button class="toolbar-icon" aria-label="Flip horizontal" title="Flip horizontal" onclick={() => flipBitmap(true)}><FlipHorizontal2 size={21} /></button>
          <button class="toolbar-icon" aria-label="Flip vertical" title="Flip vertical" onclick={() => flipBitmap(false)}><FlipVertical2 size={21} /></button>
        </div>
      </div>

      <div class="flex h-10 items-center gap-4">
        <label class="flex items-center gap-2 text-sm font-bold text-slate-600">
          塗りつぶし
          <span class="flex h-9 overflow-hidden rounded border border-slate-300 bg-white">
            <input class="h-9 w-10 border-0 p-0" type="color" bind:value={paintColor} aria-label="Paint color" />
            <span class="flex h-9 w-5 items-center justify-center border-l border-slate-300 text-xs text-slate-500">▼</span>
          </span>
        </label>
        <label class="flex items-center gap-2 text-sm font-bold text-slate-600">
          枠線
          <span class="flex h-9 overflow-hidden rounded border border-slate-300 bg-white">
            <input class="h-9 w-10 border-0 p-0" type="color" bind:value={strokeColor} aria-label="Stroke color" />
            <span class="flex h-9 w-5 items-center justify-center border-l border-slate-300 text-xs text-slate-500">▼</span>
          </span>
        </label>
        <input class="h-9 w-16 rounded-full border border-slate-200 bg-white px-4 text-center text-sm font-semibold text-slate-600 outline-none focus:border-[#8d5de8]" type="number" min="0" max="48" bind:value={strokeWidth} aria-label="Stroke width" />
        {#if costumeEditMode === 'bitmap'}
          <label class="ml-2 flex min-w-44 items-center gap-2 text-xs font-semibold text-slate-500">
            Size
            <input class="w-32 accent-[#8d5de8]" type="range" min="1" max="24" bind:value={brushSize} aria-label="Brush size" />
          </label>
        {:else}
          <select class="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 outline-none focus:border-[#8d5de8]" bind:value={paintGradient} aria-label="Vector paint style">
            <option value="solid">Solid</option>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
            <option value="radial">Radial</option>
          </select>
          <label class="flex min-w-36 items-center gap-2 text-xs font-semibold text-slate-500">
            Opacity
            <input class="w-24 accent-[#8d5de8]" type="range" min="0" max="100" bind:value={vectorOpacity} aria-label="Vector opacity" />
          </label>
          {#if vectorShape === 'text'}
            <input class="h-9 w-32 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-600 outline-none focus:border-[#8d5de8]" bind:value={vectorText} aria-label="Vector text" />
          {/if}
        {/if}
        <input class="sr-only" type="color" bind:value={secondaryPaintColor} aria-label="Secondary paint color" />
      </div>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden bg-white">
    <div class="grid w-[132px] shrink-0 grid-cols-2 content-start gap-x-5 gap-y-5 px-7 py-7">
      {#if costumeEditMode === 'bitmap'}
        {#each tools as tool}
          {@const Icon = tool.icon}
          <button
            data-testid={`bitmap-tool-${tool.id}`}
            class={`flex h-11 w-11 items-center justify-center rounded text-slate-600 transition ${bitmapTool === tool.id ? 'bg-[#8d5de8] text-white shadow-sm' : 'hover:bg-slate-100'}`}
            aria-label={tool.label}
            title={tool.label}
            onclick={() => (bitmapTool = tool.id)}
          >
            <Icon size={27} strokeWidth={2.4} />
          </button>
        {/each}
      {:else}
        {#each vectorTools as tool}
          {@const Icon = tool.icon}
          <button
            data-testid={`vector-shape-${tool.id}`}
            class={`flex h-11 w-11 items-center justify-center rounded text-slate-600 transition ${vectorTool === tool.id ? 'bg-[#8d5de8] text-white shadow-sm' : 'hover:bg-slate-100'}`}
            aria-label={tool.label}
            title={tool.label}
            onclick={() => chooseVectorTool(tool.id)}
          >
            <Icon size={27} strokeWidth={2.4} />
          </button>
        {/each}
      {/if}
    </div>

    <div
      class="relative min-w-0 flex-1 overflow-hidden bg-white"
      role="application"
      aria-label="Costume paint canvas"
      use:viewportWheel
    >
      <canvas bind:this={paperViewportCanvas} class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
      <div
        bind:this={editSurfaceNode}
        data-vector-stage-surface={costumeEditMode === 'vector' ? 'true' : undefined}
        class="absolute left-1/2 top-1/2"
        style={`width:${editSurfaceWidth()}px;height:${editSurfaceHeight()}px;transform:translate(calc(-50% + ${viewportX}px), calc(-50% + ${viewportY}px)) scale(${viewportScale});transform-origin:center;`}
      >
        <canvas
          data-testid="bitmap-editor-canvas"
          bind:this={bitmapCanvas}
          class={`${costumeEditMode === 'bitmap' ? 'block' : 'hidden'} h-full w-full touch-none rounded border border-slate-200`}
          width={bitmapCanvasWidth}
          height={bitmapCanvasHeight}
        ></canvas>
        {#if costumeEditMode === 'vector'}
          {#if currentCostumePreviewSvg}
            <div class="vector-preview absolute select-none overflow-hidden rounded border border-slate-200" style={vectorArtStyle()}>
              {@html currentCostumePreviewSvg}
            </div>
          {:else if currentCostumePreviewUrl}
            <img class="absolute select-none rounded border border-slate-200" style={vectorArtStyle()} src={currentCostumePreviewUrl} alt="" draggable="false" />
          {:else}
            <div class="absolute rounded border border-slate-200" style={vectorArtStyle()}></div>
          {/if}
        {/if}
        <div class="pointer-events-none absolute inset-0 border border-dashed border-slate-500/70"></div>
        {#if bitmapSelection && costumeEditMode === 'bitmap'}
          <div class="pointer-events-none absolute border border-dashed border-blue-500 bg-blue-500/5" style={selectionStyle(bitmapSelection)}></div>
        {/if}
        {#if costumeEditMode === 'vector'}
          {#each vectorObjects as object}
            <button
              data-vector-object
              class={`absolute border-2 bg-transparent ${selectedVectorObjectIndices.includes(object.index) || selectedVectorObjectIndex === object.index ? 'border-blue-500' : 'border-transparent hover:border-blue-300'} ${vectorTool === 'select' || vectorTool === 'reshape' ? 'pointer-events-auto cursor-move' : 'pointer-events-none'}`}
              style={vectorObjectStyle(object)}
              aria-label={`Select ${object.label}`}
              onpointerdown={(event) => beginVectorObjectDrag?.(object, event)}
              onpointermove={(event) => dragVectorObject?.(event)}
              onpointerup={(event) => endVectorObjectDrag?.(event)}
              onpointercancel={() => undefined}
            ></button>
          {/each}
          {#if vectorMarquee}
            <div class="pointer-events-none absolute border border-dashed border-blue-500 bg-blue-500/10" style={vectorMarqueeStyle()}></div>
          {/if}
          {#if vectorShapeDraft}
            <div class={`pointer-events-none absolute border-2 border-blue-500 bg-blue-500/5 ${vectorShapeDraft.shape === 'oval' ? 'rounded-full' : ''}`} style={vectorShapeDraftStyle()}></div>
          {/if}
          {#if vectorTool === 'reshape' && beginVectorPathPointDrag && selectedVectorObject()?.points?.length}
            {@const selectedObject = selectedVectorObject()!}
            <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
              {#each vectorControlPoints(selectedObject.points ?? []) as point}
                {@const anchor = relatedAnchorForControl(selectedObject.points ?? [], point)}
                {#if anchor}
                  {@const line = vectorControlLineStyle(anchor, point)}
                  <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#8d5de8" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />
                {/if}
              {/each}
            </svg>
            {#each selectedObject.points ?? [] as point}
              <button
                data-vector-object
                data-vector-path-point
                class={`absolute border-2 border-white shadow pointer-events-auto cursor-move ${point.kind === 'control' ? 'h-3.5 w-3.5 rotate-45 rounded-sm bg-white ring-2 ring-[#8d5de8]' : 'h-4 w-4 rounded-full bg-[#8d5de8]'}`}
                style={vectorPathPointStyle(point)}
                aria-label={`Move path point ${point.index + 1}`}
                onpointerdown={(event) => beginVectorPathPointDrag?.(selectedObject, point.index, event)}
                onpointermove={(event) => dragVectorPathPoint?.(event)}
                onpointerup={(event) => endVectorPathPointDrag?.(event)}
                onpointercancel={() => undefined}
              ></button>
            {/each}
          {/if}
          {#if vectorTool === 'select' && beginVectorObjectResize && selectedVectorObject()}
            {@const selectedObject = selectedVectorObject()!}
            {#each vectorResizeHandles as handle}
              <button
                data-vector-object
                class={`absolute h-4 w-4 rounded-sm border-2 border-white bg-blue-600 shadow pointer-events-auto ${handle.cursor}`}
                style={vectorResizeHandleStyle(selectedObject, handle.id)}
                aria-label={`Resize selected vector object ${handle.id}`}
                onpointerdown={(event) => beginVectorObjectResize?.(selectedObject, handle.id, event)}
                onpointermove={(event) => dragVectorObjectResize?.(event)}
                onpointerup={(event) => endVectorObjectResize?.(event)}
                onpointercancel={() => undefined}
              ></button>
            {/each}
          {/if}
        {/if}
      </div>
      <div class="absolute bottom-2 right-3 flex overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
        <button class="flex h-9 w-10 items-center justify-center text-slate-600" aria-label="Zoom out" title="Zoom out" onclick={() => zoomCanvas(0.85)}><ZoomOut size={17} /></button>
        <button class="flex h-9 w-12 items-center justify-center border-l border-r border-slate-200 text-xs font-semibold text-slate-600" aria-label="Reset zoom" title="Reset zoom" onclick={resetViewport}>{Math.round(viewportScale * 100)}%</button>
        <button class="flex h-9 w-10 items-center justify-center text-slate-600" aria-label="Zoom in" title="Zoom in" onclick={() => zoomCanvas(1.15)}><ZoomIn size={17} /></button>
      </div>
    </div>
  </div>

  <div class="flex min-h-[48px] shrink-0 items-center gap-3 overflow-x-auto border-t border-slate-100 px-4">
    {#if costumeEditMode === 'bitmap'}
      <button class="flex items-center gap-2 rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-bold text-white" onclick={() => switchCostumeEditMode('vector')}>
        <Image size={18} />
        ベクターに変換
      </button>
      <button data-testid="save-bitmap-costume" class="ml-auto rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-semibold text-white" onclick={saveBitmapCostume}>Save bitmap</button>
    {:else}
      <button class="flex items-center gap-2 rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-bold text-white" onclick={() => switchCostumeEditMode('bitmap')}>
        <Image size={18} />
        ビットマップに変換
      </button>
      <button data-testid="save-vector-costume" class="ml-auto rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-semibold text-white" onclick={() => saveVectorCostume()}>Save vector</button>
    {/if}
  </div>
</div>

<style>
  .toolbar-icon {
    display: inline-flex;
    height: 2rem;
    width: 2rem;
    align-items: center;
    justify-content: center;
  }

  .vector-preview :global(svg) {
    display: block;
    height: 100%;
    width: 100%;
  }
</style>
