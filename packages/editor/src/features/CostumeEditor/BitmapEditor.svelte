<script lang="ts">
  import {
    AlignEndHorizontal,
    AlignStartHorizontal,
    ArrowLeftRight,
    BringToFront,
    Brush,
    Circle,
    ClipboardPaste,
    Copy,
    Eraser,
    FlipHorizontal2,
    FlipVertical2,
    Group,
    Image,
    MousePointer2,
    PaintBucket,
    Pipette,
    Redo2,
    RotateCcw,
    RotateCw,
    SendToBack,
    Slash,
    SplinePointer,
    Square,
    Trash2,
    Type,
    Undo2,
    Ungroup,
    ZoomIn,
    ZoomOut,
  } from 'lucide-svelte'
  import type { BitmapTool, VectorObjectInfo, VectorPathPointInfo, VectorResizeHandle } from '../../lib/editor-types'
  import type { BitmapFloatingScaleHandle } from '../costumes/bitmap-floating-session'
  import { isShapeDrag, readShapeModifiers, resolveShapeRect, shouldCommitShapeDrag, vectorShapePaperZoom, type ShapeModifierKeys } from '../costumes/shape-drag'
  import { hexToPaintRgba, previewGradientEndCss } from '../costumes/transparent-paint'
  import { paintToCss, resolveGradientEndpoints } from '../costumes/paint-colors'
  import {
    EYEDROPPER_LOUPE_CANVAS_SIZE,
    EYEDROPPER_LOUPE_RADIUS,
    VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS,
    buildVectorEyedropperCacheKey,
    eyedropperCss,
    eyedropperPixelFromClient,
    isVectorEyedropperKeyCurrent,
    loupeSourceRect,
    padLoupePixels,
    rasterizeVectorPreview,
    resolveEyedropperCommitTarget,
    type EyedropperRgba,
    type EyedropperTarget,
  } from '../costumes/eyedropper'
  import { vectorLineRect } from '../costumes/vector-shapes'
  import { PAINT_MIXED, isMixedSelectionValue, type VectorSelectionSummary } from '../costumes/vector-selection-style'
  import { swapFillPaintState } from '../costumes/paint-colors'
  import { swapStrokePaintState } from '../costumes/vector-stroke-paint'
  import {
    BITMAP_BRUSH_MAX_SIZE,
    BITMAP_BRUSH_MIN_SIZE,
    STROKE_WIDTH_MAX,
    STROKE_WIDTH_MIN,
    VECTOR_BRUSH_DEFAULT_SIZE,
    VECTOR_BRUSH_MAX_SIZE,
    VECTOR_BRUSH_MIN_SIZE,
    isVectorFillDisabled,
    isVectorStrokeDisabled,
    isBitmapBrushSizeVisible,
    isBitmapStrokeControlsVisible,
    normalizeVectorBrushSize,
  } from '../costumes/paint-toolbar-sizes'
  import { VECTOR_TEXT_FONT_OPTIONS, resolveTextBaseDirection } from '../costumes/vector-text'
  import { resolveBitmapTextCommitPoint } from '../costumes/bitmap-text'
  import { shouldDeferInlineTextKeyToIme } from '../costumes/inline-text-ime'
  import EraserCursor from './EraserCursor.svelte'
  import EyedropperLoupe from './EyedropperLoupe.svelte'
  import HsvColorPicker from '../../components/HsvColorPicker.svelte'
  import VectorBrushPreview from './VectorBrushPreview.svelte'
  import VectorShapePreview from './VectorShapePreview.svelte'
  import VectorFillHoverPreview from './VectorFillHoverPreview.svelte'
  import VectorReshapeOverlay from './VectorReshapeOverlay.svelte'
  import PaintSwatchPopover from './PaintSwatchPopover.svelte'
  import PaintToolbarOverflow, { type PaintToolbarOverflowAction } from './PaintToolbarOverflow.svelte'
  import { tick } from 'svelte'
  import { sanitizeSvgForDisplay } from '../costumes/svg-sanitize'
  import { buttonZoomStepAdditive, buttonZoomStepForPaperDensity, buildCostumeViewportKey, buildLegacySlotViewportKey, clampViewportScale, clampViewportScaleForDensity, clampViewportScaleLenient, cssScaleToUiPercent, densityForBitmapStoredResolution, resolveInitialFitViewport, resolveWheelViewport, resolveWheelViewportForPaperDensity, unionFitRects, VECTOR_PAPER_TO_CSS_DENSITY, BITMAP_RES2_PAPER_TO_CSS_DENSITY, viewportMinScaleForDensity, viewportResetScaleForDensity, viewportUiPercentForDensity, zoomViewportAtSurfacePoint } from '../costumes/costume-viewport'
  import { scanBitmapOpaqueBounds } from '../costumes/bitmap-opaque-bounds'
  import { clampCssViewportToPaper, paperItemRectsForBitmapOpaque, paperItemRectsForVectorUnits } from '../costumes/viewport-paper-clamp'
  import {
    vectorReshapeToleranceFromSurfaceScale,
    vectorReshapeToleranceSvgUnits,
    vectorSelectToleranceFromSurfaceScale,
    vectorSelectToleranceSvgUnits,
  } from '../costumes/vector-hit-tolerance'
  import {
    createFillHoverPreviewTracker,
    resolveFillHoverPreview,
  } from '../costumes/vector-fill-hover-preview'
  import type { FillPreviewTargetKey } from '../costumes/vector-fill-hover'
  import { editableVectorUnits } from '../costumes/vector-svg'
  import {
    paperVectorFillTargetAtPoint,
    paperVectorHoleTargetAtPoint,
  } from '../costumes/paper-vector'
  import {
    buildFillHoverPreviewSnapshot,
    type FillHoverOverlayToolbarPaint,
  } from '../costumes/vector-fill-hover-overlay'
  import { isFillInvisible } from '../costumes/transparent-paint'
  import { liveReshapeActionIndices } from '../costumes/vector-reshape-handle-masks'

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
  // Default live bitmap canvas before the first costume loads: the sprite
  // artboard (960x720/res2). The vector edit surface keeps the 2400x1800
  // workspace box (editSurfaceWidth/Height below); only the bitmap default
  // follows the artboard.
  const BITMAP_DEFAULT_CANVAS_WIDTH = 960
  const BITMAP_DEFAULT_CANVAS_HEIGHT = 720
  const VECTOR_WORKSPACE_SCALE = 5
  const CHECKERBOARD_CELL_SIZE = 10

  let {
    bitmapCanvas = $bindable(),
    bitmapCanvasWidth = BITMAP_DEFAULT_CANVAS_WIDTH,
    bitmapCanvasHeight = BITMAP_DEFAULT_CANVAS_HEIGHT,
    bitmapResolution = undefined,
    bitmapFitState = undefined,
    /** True while the bitmap destination is loading/verifying (pending owner). Shows explicit loading; destructive UI stays disabled. */
    bitmapWorkspaceBusy = false,
    /** True while the bitmap destination is not settled (pending, owner mismatch, or oversize refusal). Destructive bitmap controls stay disabled. */
    bitmapDestructiveDisabled = false,
    /** Pending rect/oval session state (B-3): staged overlay exists. */
    bitmapPendingHas = false,
    /** History-gap flag: landed without undo entry, acknowledgement required. */
    bitmapPendingGap = false,
    /** Quarantined conflict preserved off-canvas, explicit export/discard required. */
    bitmapPendingQuarantined = false,
    /** Retained off-canvas recovery (direct-VM hostile path): same UI. */
    bitmapPendingRecoveryHas = false,
    bitmapPendingKind = undefined,
    bitmapPendingMode = undefined,
    exportBitmapPendingQuarantined = undefined,
    discardBitmapPendingQuarantine = undefined,
    acknowledgeBitmapPendingGap = undefined,
    costumeEditMode = $bindable('bitmap'),
    bitmapTool = $bindable('brush'),
    bitmapShapeMode = $bindable('filled'),
    eyedropperActive = $bindable(false),
    eyedropperTarget = $bindable('fill'),
    applyEyedropperColor = (_pixel: EyedropperRgba, _target: EyedropperTarget) => {},
    vectorShape = $bindable('oval'),
    openStylePopover = $bindable<'fill' | 'stroke' | null>(null),
    brushSize = $bindable(10),
    vectorBrushSize = $bindable(VECTOR_BRUSH_DEFAULT_SIZE),
    bitmapEraserSize = $bindable(40),
    vectorEraserSize = $bindable(40),
    paintColor = $bindable('#ffab19'),
    secondaryPaintColor = $bindable('#ffffff'),
    paintGradient = $bindable('solid'),
    fillTransparent = $bindable(false),
    secondaryTransparent = $bindable(false),
    strokeTransparent = $bindable(false),
    strokeColor = $bindable('#0f172a'),
    strokeSecondaryColor = $bindable('#ffffff'),
    secondaryStrokeTransparent = $bindable(false),
    strokeGradient = $bindable('solid'),
    strokeWidth = $bindable(4),
    vectorOpacity = $bindable(100),
    vectorText = $bindable('Text'),
    vectorTextFontSize = $bindable(40),
    vectorTextFontFamily = $bindable('Sans Serif'),
    viewportScale = $bindable(1),
    viewportKey = '',
    /**
     * Project identity for viewport scoping (Editor-owned; e.g. the sb3
     * content hash or a project load generation). While absent, keys fall
     * back to the legacy project segment: same-slot viewports are shared
     * across project replaces when the asset bytes are identical (F3
     * incomplete until the Editor passes this -- concrete wiring is listed
     * in the key-scope comment on `scopedViewportKey`).
     */
    projectIdentity = undefined,
    /**
     * Costume content identity for viewport scoping (Editor-owned,
     * reserved for a future structural generation). Slot-stable: only a
     * non-empty explicit value scopes the key; the volatile
     * `bitmapFitState.assetKey` is never used, so same-slot paint/save/
     * Undo/Redo keeps one key with no refit and no map growth. Currently
     * always '' (see `resolveCostumeViewportIdentity`).
     */
    costumeIdentity = undefined,
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
    bitmapFloatingActive = false,
    vectorClipboard = [],
    vectorObjects = [],
    selectedVectorObjectIndex = -1,
    selectedVectorObjectIndices = [],
    vectorCanvasWidth = 96,
    vectorCanvasHeight = 96,
    beginBitmapPaint,
    paintBitmap,
    endBitmapPaint,
    beginBitmapFloatingScale,
    moveBitmapFloatingScale,
    endBitmapFloatingScale,
    beginBitmapFloatingRotate,
    moveBitmapFloatingRotate,
    endBitmapFloatingRotate,
    pickBitmapColor,
    clearBitmapCanvas,
    copyBitmapSelection,
    pasteBitmapSelection,
    copyCostumeSelection,
    pasteCostumeSelection,
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
    findVectorTextIndexAtPoint,
    commitVectorInlineText,
    commitBitmapInlineText,
    prepareVectorInlineTextFont = undefined,
    saveVectorBrushStroke,
    saveVectorShapeInRect,
    fillVectorObjectAtPoint,
    eraseVectorStroke,
    saveBitmapCostume,
    beginVectorObjectDragAtPoint,
    beginVectorSelectedDragAtPoint = undefined,
    dragVectorObject,
    endVectorObjectDrag,
    beginVectorObjectResize,
    dragVectorObjectResize,
    endVectorObjectResize,
    beginVectorObjectRotate,
    dragVectorObjectRotate,
    endVectorObjectRotate,
    beginVectorMultiRotate,
    vectorMultiBounds,
    vectorCenterGuideOpacity = 0,
    bitmapCenterGuideOpacity = 0,
    bitmapArtCenterX = undefined,
    bitmapArtCenterY = undefined,
    beginVectorMultiResize,
    beginVectorPathPointDrag,
    dragVectorPathPoint,
    endVectorPathPointDrag,
    beginVectorLeafTranslateDragAtPoint,
    dragVectorLeafTranslate,
    endVectorLeafTranslateDrag,
    selectVectorObjectsInRect,
    clearVectorObjectSelection,
    vectorReshapePointIndex = undefined,
    vectorReshapePointIndices = undefined,
    vectorReshapeHandleMasks = undefined,
    vectorReshapeLeafIndices = undefined,
    selectVectorReshapePoint,
    selectVectorReshapePoints,
    selectVectorReshapeLeaves,
    normalizeReshapeLeafToSelectRoot,
    selectVectorReshapeLeafAtPoint,
    toggleVectorReshapePoint,
    selectVectorReshapePointsInRect,
    addVectorPathPointAt,
    deleteVectorReshapePoint,
    deleteVectorReshapePoints,
    curveVectorReshapePoint,
    pointVectorReshapePoint,
    updateVectorObjectStrokeWidth,
    applyVectorStyle,
    vectorSelectionSummary,
    markVectorStyleDirty,
    applyHsvLive,
    commitHsvLive,
    flushHsvLive,
    groupVectorSelection,
    ungroupVectorSelection,
    bringVectorSelectionToFront,
    bringVectorSelectionForward,
    sendVectorSelectionBackward,
    sendVectorSelectionToBack,
    flipVectorSelection,
  } = $props<{
    bitmapCanvas?: HTMLCanvasElement
    bitmapCanvasWidth?: number
    bitmapCanvasHeight?: number
    /** Explicit stored bitmap resolution (sprite 2 / stage 1); unknown stays legacy. */
    bitmapResolution?: number
    /**
     * Read-only settled bitmap fit bounds from the Editor (no drawing/history
     * write): the placed decoded-image rect in canvas px (`null` when
     * empty/refused/undecodable), the committed surface size, plus the owner
     * identity that committed it. Updated only on committed loads (stale
     * serial/revision aborts never touch it), so first-fit can gate on it
     * without racing the async decode or the reactive canvas-size flush.
     */
    bitmapFitState?: { bounds: { x: number; y: number; width: number; height: number } | null; surfaceWidth: number; surfaceHeight: number; targetId: string; index: number; assetKey: string; serial: number } | undefined
    /** True while the bitmap destination is loading/verifying (pending owner). */
    bitmapWorkspaceBusy?: boolean
    /** True while the bitmap destination is not settled (pending/refused/stale). */
    bitmapDestructiveDisabled?: boolean
    bitmapPendingHas?: boolean
    bitmapPendingGap?: boolean
    bitmapPendingQuarantined?: boolean
    bitmapPendingRecoveryHas?: boolean
    bitmapPendingKind?: string | undefined
    bitmapPendingMode?: string | undefined
    exportBitmapPendingQuarantined?: () => Promise<Uint8Array | undefined>
    discardBitmapPendingQuarantine?: () => boolean | void | Promise<boolean | void>
    acknowledgeBitmapPendingGap?: (note?: string) => boolean | void | Promise<boolean | void>
    costumeEditMode: CostumeEditMode
    bitmapTool: BitmapTool
    bitmapShapeMode: 'filled' | 'outlined'
    eyedropperActive?: boolean
    eyedropperTarget?: EyedropperTarget
    applyEyedropperColor?: (pixel: EyedropperRgba, target: EyedropperTarget) => void | Promise<void>
    vectorShape: VectorShape
    /** Compact popover state lifted to the Editor so window-capture Escape
     * closes the dialog first (retain selection) instead of deselecting. */
    openStylePopover?: 'fill' | 'stroke' | null
    brushSize: number
    vectorBrushSize: number
    bitmapEraserSize: number
    vectorEraserSize: number
    paintColor: string
    secondaryPaintColor: string
    paintGradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
    fillTransparent: boolean
    secondaryTransparent: boolean
    strokeTransparent: boolean
    strokeColor: string
    strokeSecondaryColor: string
    secondaryStrokeTransparent: boolean
    strokeGradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
    strokeWidth: number
    vectorOpacity: number
    vectorText: string
    vectorTextFontSize: number
    vectorTextFontFamily: string
    viewportScale?: number
    viewportKey?: string
    /** Project identity for viewport scoping (Editor-owned; absent => legacy project segment). */
    projectIdentity?: string
    /** Costume content identity for viewport scoping (Editor-owned md5ext/assetKey). */
    costumeIdentity?: string
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
    bitmapFloatingActive?: boolean
    vectorClipboard?: string[]
    vectorObjects?: VectorObjectInfo[]
    selectedVectorObjectIndex?: number
    selectedVectorObjectIndices?: number[]
    vectorCanvasWidth?: number
    vectorCanvasHeight?: number
    beginBitmapPaint: (event: MouseEvent) => void | Promise<void>
    paintBitmap: (event: MouseEvent) => void
    endBitmapPaint: (event: MouseEvent) => void | Promise<void>
    beginBitmapFloatingScale?: (event: PointerEvent, handle?: BitmapFloatingScaleHandle) => void
    moveBitmapFloatingScale?: (event: PointerEvent) => void
    endBitmapFloatingScale?: (event: PointerEvent) => void | Promise<void>
    beginBitmapFloatingRotate?: (event: PointerEvent) => void
    moveBitmapFloatingRotate?: (event: PointerEvent) => void
    endBitmapFloatingRotate?: (event: PointerEvent) => void | Promise<void>
    pickBitmapColor: (event: MouseEvent) => void
    clearBitmapCanvas: () => void | Promise<void>
    copyBitmapSelection: (cut?: boolean) => void | Promise<void>
    pasteBitmapSelection: () => void | Promise<void>
    copyCostumeSelection?: () => void | Promise<void>
    pasteCostumeSelection?: () => void | Promise<void>
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
    findVectorTextIndexAtPoint: (point: { x: number; y: number }, toleranceSvgUnits?: number) => Promise<number>
    commitVectorInlineText: (session: { x: number; y: number; text: string; targetIndex?: number }) => Promise<string>
    commitBitmapInlineText: (point: { x: number; y: number }, text: string) => Promise<boolean>
    prepareVectorInlineTextFont?: (index: number) => void | Promise<void>
    saveVectorBrushStroke: (points: Array<{ x: number; y: number }>) => void | Promise<void>
    saveVectorShapeInRect: (shape: 'rect' | 'oval' | 'line', rect: Rect) => void | Promise<void>
    fillVectorObjectAtPoint: (point: { x: number; y: number }) => void | Promise<void>
    eraseVectorStroke: (points: Array<{ x: number; y: number }>) => void | Promise<void>
    saveBitmapCostume: () => void | Promise<void>
    beginVectorObjectDragAtPoint?: (point: { x: number; y: number }, event: PointerEvent, scale: number) => Promise<boolean>
    // Selection-gated drag starter for retained shape tools (rect/oval stay
    // armed after commit): only a hit inside `allowedIndices` starts a move.
    beginVectorSelectedDragAtPoint?: (point: { x: number; y: number }, event: PointerEvent, scale: number, allowedIndices: readonly number[]) => Promise<boolean>
    dragVectorObject?: (event: PointerEvent) => void
    endVectorObjectDrag?: (event: PointerEvent) => void | Promise<void>
    beginVectorObjectResize?: (object: VectorObjectInfo, handle: VectorResizeHandle, event: PointerEvent) => void
    dragVectorObjectResize?: (event: PointerEvent) => void
    endVectorObjectResize?: (event: PointerEvent) => void | Promise<void>
    beginVectorObjectRotate?: (object: VectorObjectInfo, event: PointerEvent) => void
    dragVectorObjectRotate?: (event: PointerEvent) => void
    endVectorObjectRotate?: (event: PointerEvent) => void | Promise<void>
    beginVectorMultiRotate?: (event: PointerEvent) => void
    vectorMultiBounds?: { x: number; y: number; width: number; height: number } | undefined
    vectorCenterGuideOpacity?: number
    bitmapCenterGuideOpacity?: number
    bitmapArtCenterX?: number | undefined
    bitmapArtCenterY?: number | undefined
    beginVectorMultiResize?: (handle: VectorResizeHandle, event: PointerEvent) => void
    beginVectorPathPointDrag?: (object: VectorObjectInfo, pointIndex: number, event: PointerEvent) => void
    dragVectorPathPoint?: (event: PointerEvent) => void
    endVectorPathPointDrag?: (event: PointerEvent) => void | Promise<void>
    beginVectorLeafTranslateDragAtPoint?: (point: { x: number; y: number }, event: PointerEvent, scale: number) => boolean | Promise<boolean>
    dragVectorLeafTranslate?: (event: PointerEvent) => void
    endVectorLeafTranslateDrag?: (event: PointerEvent) => void | Promise<void>
    selectVectorObjectsInRect?: (rect: Rect, append?: boolean) => void | Promise<void>
    clearVectorObjectSelection?: () => void
    vectorReshapePointIndex?: number | undefined
    vectorReshapePointIndices?: number[] | undefined
    vectorReshapeHandleMasks?: Record<number, number> | undefined
    vectorReshapeLeafIndices?: number[] | undefined
    selectVectorReshapePoint?: (index: number | undefined) => void
    selectVectorReshapePoints?: (indices: number[]) => void
    selectVectorReshapeLeaves?: (indices: number[]) => void
    normalizeReshapeLeafToSelectRoot?: () => void
    selectVectorReshapeLeafAtPoint?: (point: { x: number; y: number }, append?: boolean, toleranceSvgUnits?: number) => boolean | Promise<boolean>
    toggleVectorReshapePoint?: (index: number, append: boolean) => void
    selectVectorReshapePointsInRect?: (rect: Rect, append?: boolean) => number[] | void | Promise<number[] | void>
    addVectorPathPointAt?: (point: { x: number; y: number }, toleranceSvgUnits?: number) => void | Promise<void> | Promise<boolean>
    deleteVectorReshapePoint?: (index?: number) => void | Promise<void> | Promise<boolean>
    deleteVectorReshapePoints?: (indices: number[]) => void | Promise<void> | Promise<boolean>
    curveVectorReshapePoint?: () => void | Promise<void> | Promise<boolean>
    pointVectorReshapePoint?: () => void | Promise<void> | Promise<boolean>
    updateVectorObjectStrokeWidth: (event: Event) => void | Promise<void>
    applyVectorStyle?: () => void | Promise<void>
    vectorSelectionSummary?: VectorSelectionSummary | undefined
    markVectorStyleDirty?: (field: string) => void
    applyHsvLive?: (field: 'fill' | 'stroke' | 'fillSecondary' | 'strokeSecondary', hex: string) => void
    commitHsvLive?: (field: 'fill' | 'stroke' | 'fillSecondary' | 'strokeSecondary') => void
    flushHsvLive?: () => void | Promise<void>
    groupVectorSelection: () => void | Promise<void>
    ungroupVectorSelection: () => void | Promise<void>
    bringVectorSelectionToFront?: () => void | Promise<void>
    bringVectorSelectionForward?: () => void | Promise<void>
    sendVectorSelectionBackward?: () => void | Promise<void>
    sendVectorSelectionToBack?: () => void | Promise<void>
    flipVectorSelection?: (horizontal: boolean) => void | Promise<void>
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
    { id: 'reshape', label: 'Reshape', icon: SplinePointer },
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

  const bitmapFloatingHandles: Array<{ id: BitmapFloatingScaleHandle; cursor: string }> = [
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
  let vectorTool = $state<VectorTool>('select')
  let activeViewportKey = ''
  let activeViewportSlot = ''
  let activeViewportMode: CostumeEditMode = costumeEditMode
  // Viewport states keyed by the full project + slot + costume + mode scope.
  // Presence in this map MEANS settled: only an explicit user pan/zoom, an
  // explicit reset, an applied first-fit, or a same-slot inheritance (see the
  // key-change effect) may insert. Pristine placeholders (pre-fit resets,
  // undecoded arrives) are never saved, so a delayed fit still lands on
  // revisit (F2) and a replaced project / reused slot starts unsettled (F3).
  let viewportStates = new Map<string, ViewportState>()
  let viewportNode: HTMLElement | undefined
  let editSurfaceNode: HTMLElement | undefined
  let vectorMarquee = $state<{ start: { x: number; y: number }; current: { x: number; y: number }; append: boolean } | undefined>()
  let vectorHitPromise: Promise<boolean> | undefined
  let vectorBrushPoints = $state<Array<{ x: number; y: number }>>([])
  let vectorEraserPoints = $state<Array<{ x: number; y: number }>>([])
  let pendingBrushPreviews = $state<Array<{ id: number; points: Array<{ x: number; y: number }>; color: string; width: number; opacity: number }>>([])
  let nextBrushPreviewId = 0
  let vectorShapeDraft = $state<{ shape: 'rect' | 'oval' | 'line'; start: { x: number; y: number }; current: { x: number; y: number }; modifiers: ShapeModifierKeys } | undefined>()
  // Retained shape-tool press bookkeeping (rect/oval bounding-box parity):
  // `vectorShapeLastPoint/Modifiers` track the pointer while the async
  // selection hit test is still pending, so a miss fallback starts the fresh
  // shape from the latest pointer (not the stale press point).
  // `vectorShapeDelegated` marks a hit that handed control to the object move
  // drag, so cancel/settle paths route through the normal drag end.
  let vectorShapeLastPoint: { x: number; y: number } | undefined
  let vectorShapeLastModifiers: ShapeModifierKeys | undefined
  let vectorShapeDelegated = false
  // Pending selected-shape hit generation (true data-change race gate):
  // every retained shape press (rect/oval over a live selection) mints a
  // fresh id; the async `beginVectorSelectedDragAtPoint` continuations and
  // the awaiting `handleCanvasMouseUp` only settle when their captured id
  // still matches the live one. pointercancel / genuine lostpointercapture /
  // Escape / target-costume-project switches retire the live id synchronously,
  // so a stale resolve can never move the wrong asset, resurrect a cleared
  // selection, or double-commit history. A retired id never touches the next
  // gesture (next press mints a new id). `vectorShapeReleaseSeen` records the
  // gesture that already saw its pointerup, so the implicit auto-loss
  // trailing a normal pointerup is ignored instead of cancelling the commit.
  let vectorShapeGestureSeq = 0
  let vectorShapeLiveGesture: number | undefined = undefined
  let vectorHitGesture: number | undefined = undefined
  let vectorShapeReleaseSeen: number | undefined = undefined
  let pendingShapePreviews = $state<Array<{ id: number; shape: 'rect' | 'oval' | 'line'; rect: Rect; color: string; secondaryColor: string; gradient: 'solid' | 'horizontal' | 'vertical' | 'radial'; stroke: string; strokeSecondary: string; strokeGradient: 'solid' | 'horizontal' | 'vertical' | 'radial'; width: number; opacity: number }>>([])
  let nextShapePreviewId = 0
  let activeCostumeEditMode = costumeEditMode
  let activeCanvasPointerId: number | undefined
  let eraserCursor = $state<{ x: number; y: number } | undefined>()
  // Compact toolbar popover (Scratch parity layout): the Fill/Outline swatches
  // stay inline (one row tall) while the full HSV/alpha/gradient/transparent/
  // eyedropper/swap controls live in the anchored dialog. `null` keeps both
  // dialogs closed so the toolbar never grows; opening never writes paint.
  // State is a bindable parent-owned prop so the Editor window-capture Escape
  // can close the dialog first (retain selection) before any deselect.
  function closeStylePopover() {
    if (openStylePopover !== null) {
      openStylePopover = null
      void flushHsvLive?.()
    }
  }
  // Vector fill-tool hover preview (Scratch fill-tool parity, draw-only).
  // Shows the would-be fill/stroke paint in a `pointer-events: none` overlay
  // snapshot above the base artwork. Never touches the live SVG / VM /
  // history: resolution reads through `resolveFillHoverPreview` (same gating
  // as the click commit) and rendering clones the preview SVG string into a
  // detached document (`buildFillHoverPreviewSnapshot`). Stale async results
  // are dropped via the tracker; every clear path below also invalidates
  // in-flight requests so a slow resolve can never paint after a leave.
  let fillHoverPreviewSvg = $state<string | null>(null)
  let fillHoverPreviewKey = $state<FillPreviewTargetKey | null>(null)
  const fillHoverPreviewTracker = createFillHoverPreviewTracker()
  let fillHoverUnitsCache: { key: string; doc: Document; units: Element[] } | null = null

  function isVectorFillHoverActive(): boolean {
    return (
      costumeEditMode === 'vector' &&
      vectorTool === 'fill' &&
      !eyedropperActive &&
      inlineText === undefined &&
      activeCanvasPointerId === undefined
    )
  }

  function clearFillHoverPreview() {
    // Invalidate in-flight resolves first so a slow earlier move can never
    // apply after a leave / tool switch / selection / color / Escape / target
    // switch. Only overlay state is reset; the live artwork is untouched.
    fillHoverPreviewTracker.issue()
    fillHoverPreviewSvg = null
    fillHoverPreviewKey = null
  }

  function fillHoverToolbarPaint(): FillHoverOverlayToolbarPaint {
    return {
      paintColor,
      secondaryPaintColor,
      paintGradient,
      fillTransparent,
      secondaryTransparent,
      strokeColor,
      strokeSecondaryColor,
      strokeGradient,
      strokeTransparent,
      secondaryStrokeTransparent,
      strokeWidth,
      vectorOpacity,
    }
  }

  /** Read-only effective stroke visibility (self + ancestors, no writes). */
  function hasEffectiveVisibleStroke(element: Element): boolean {
    try {
      let node: Element | null = element
      while (node) {
        try {
          const tag = node.tagName?.toLowerCase()
          if (tag === 'svg') break
          const style = typeof node.getAttribute === 'function' ? (node.getAttribute('style') ?? '') : ''
          const styleStroke = /stroke\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim().toLowerCase()
          const rawStroke = (typeof node.getAttribute === 'function' ? (node.getAttribute('stroke') ?? styleStroke ?? '') : '').trim().toLowerCase()
          if (rawStroke !== '') {
            if (rawStroke === 'none' || rawStroke === 'transparent') return false
            const rawWidth =
              (typeof node.getAttribute === 'function' ? (node.getAttribute('stroke-width') ?? /stroke-width\s*:\s*([^;]+)/i.exec(style)?.[1] ?? '') : '').trim()
            if (rawWidth !== '') {
              const width = Number(rawWidth)
              if (Number.isFinite(width) && width <= 0) return false
            }
            return true
          }
        } catch {
          return false
        }
        node = node.parentElement
      }
    } catch {
      return false
    }
    return false
  }

  function fillHoverUnitsFor(baseSvgText: string): { doc: Document; units: Element[] } | null {
    try {
      const cached = fillHoverUnitsCache
      if (cached && cached.key === baseSvgText) return cached
      const doc = new DOMParser().parseFromString(baseSvgText, 'image/svg+xml')
      const svg = doc.documentElement
      if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null
      if (doc.getElementsByTagName('parsererror').length > 0) return null
      const units = editableVectorUnits(svg)
      fillHoverUnitsCache = { key: baseSvgText, doc, units }
      return { doc, units }
    } catch {
      return null
    }
  }

  async function requestVectorFillHover(point: { x: number; y: number }) {
    if (!isVectorFillHoverActive()) {
      clearFillHoverPreview()
      return
    }
    const baseSvgText = currentCostumePreviewSvg ?? ''
    if (!baseSvgText) {
      clearFillHoverPreview()
      return
    }
    const seenSvgText = baseSvgText
    const cached = fillHoverUnitsFor(baseSvgText)
    if (!cached) {
      clearFillHoverPreview()
      return
    }
    const { units } = cached
    if (units.length === 0) {
      clearFillHoverPreview()
      return
    }
    // Zoom-aware tolerance from the measured surface scale (2 screen px, the
    // same budget the click commit resolves via `resolveVectorHitTolerance`).
    const tolerance = vectorSelectToleranceForHit()
    const paint = fillHoverToolbarPaint()
    const selected = new Set<number>()
    for (const index of selectedVectorObjectIndices ?? []) {
      if (Number.isInteger(index)) selected.add(index)
    }
    if (Number.isInteger(selectedVectorObjectIndex)) selected.add(selectedVectorObjectIndex)
    const requestId = fillHoverPreviewTracker.issue()
    let result: Awaited<ReturnType<typeof resolveFillHoverPreview>>
    try {
      result = await resolveFillHoverPreview({
        units,
        point: { x: point.x, y: point.y },
        tolerance,
        paint: {
          gradientType: paintGradient,
          fillTransparent,
          fillInvisible: isFillInvisible(fillTransparent, secondaryTransparent, paintGradient),
        },
        resolvers: {
          resolveBodyTarget: (resolveUnits, resolvePoint, resolveTolerance) =>
            paperVectorFillTargetAtPoint(resolveUnits, resolvePoint, resolveTolerance),
          resolveHoleProbe: (resolveUnits, resolvePoint, resolveTolerance) =>
            paperVectorHoleTargetAtPoint(resolveUnits, resolvePoint, resolveTolerance),
        },
        selectedIndices: selected,
        getCandidateFlags: (element) => {
          try {
            if (typeof element.getAttribute === 'function' && element.getAttribute('data-fill-hover-hole-overlay') === 'true') {
              return { noHover: true }
            }
          } catch {
              return { noHover: true }
            }
            return {}
          },
        hasVisibleStroke: hasEffectiveVisibleStroke,
      })
    } catch {
      if (!fillHoverPreviewTracker.isStale(requestId)) clearFillHoverPreview()
      return
    }
    // Drop stale async results: a newer move (or a clear, which issues too)
    // has already superseded this request. Also drop when the artwork changed
    // under the request or the tool is no longer hovering.
    if (fillHoverPreviewTracker.isStale(requestId)) return
    if ((currentCostumePreviewSvg ?? '') !== seenSvgText) return
    if (!isVectorFillHoverActive()) {
      clearFillHoverPreview()
      return
    }
    if (result.kind !== 'body' && result.kind !== 'hole-overlay') {
      clearFillHoverPreview()
      return
    }
    const nextKey = result.targetKey
    // Same target without a radial ramp needs no rebuild (avoids flicker);
    // radial gradients recenter on the pointer even when the target is
    // unchanged, so they always rebuild.
    const sameTarget =
      fillHoverPreviewKey !== null &&
      nextKey !== null &&
      fillHoverPreviewKey.index === nextKey.index &&
      fillHoverPreviewKey.property === nextKey.property &&
      fillHoverPreviewKey.isHoleOverlay === nextKey.isHoleOverlay
    const needsRadialRecenter = paintGradient === 'radial' || strokeGradient === 'radial'
    if (sameTarget && !needsRadialRecenter && fillHoverPreviewSvg !== null) return
    let snapshot: string | null = null
    try {
      snapshot = buildFillHoverPreviewSnapshot({ baseSvgText: seenSvgText, result, point, paint })
    } catch {
      snapshot = null
    }
    if (fillHoverPreviewTracker.isStale(requestId)) return
    if ((currentCostumePreviewSvg ?? '') !== seenSvgText) return
    if (!isVectorFillHoverActive()) {
      clearFillHoverPreview()
      return
    }
    if (!snapshot) {
      clearFillHoverPreview()
      return
    }
    fillHoverPreviewSvg = snapshot
    fillHoverPreviewKey = nextKey
  }
  // Dedicated eyedropper overlay (both modes): an orthogonal flag, not a tool
  // value, so activating never rewrites bitmapTool/vectorTool and cancelling
  // restores the previous tool for free. Hover holds the live sample + padded
  // loupe block; pressed tracks an in-progress pick gesture for touch drag.
  let eyedropperHover = $state<
    | { surfaceX: number; surfaceY: number; clientX: number; clientY: number; pixel: EyedropperRgba; inside: boolean; pixels: Uint8ClampedArray; blockSize: number }
    | undefined
  >()
  let eyedropperPressed = $state(false)
  // Last cursor position seen while the overlay is active. The vector raster
  // cache resolves asynchronously, so a hover that arrives before the cache
  // is ready recomputes from here once the cache lands (otherwise the loupe
  // would stay hidden until the next physical mouse move).
  let lastEyedropperClient: { clientX: number; clientY: number } | undefined
  // Suppresses the tail click of a double-click that started as a pick: the
  // first press commits (and deactivates the overlay), the second press would
  // otherwise paint a dot with the just-picked color. Time-boxed so normal
  // rapid painting is never affected.
  let lastEyedropperCommitAt = 0
  let vectorEyedropperCache = $state<{ canvas: HTMLCanvasElement; scale: number } | undefined>()
  let vectorEyedropperCacheKey = ''
  let vectorEyedropperCachePending = 0
  // Inline text session: a focused overlay textarea pinned to the click point.
  // Draft keystrokes stay local; only an explicit commit calls into
  // Editor.svelte (which writes exactly one history entry), and cancel
  // discards the draft without touching history or the artwork.
  let inlineText = $state<
    | { mode: 'vector'; x: number; y: number; draft: string; targetIndex?: number }
    | { mode: 'bitmap'; x: number; y: number; draft: string }
    | undefined
  >()
  let inlineTextCommitting = $state(false)
  // True between compositionstart/compositionend: a Japanese IME owns the
  // keystrokes, so Escape/Enter must go to the IME (no commit, no blur, no
  // shortcut). Reset on every session boundary; OS IME on real hardware is
  // UNCONFIRMED in CI (synthetic CompositionEvents only).
  let inlineTextComposing = $state(false)

  // Base direction of the open draft (content first-strong, else document
  // dir): an RTL draft edits right-based (the overlay grows left from the
  // click and the save anchors the right edge at the click), while LTR/CJK
  // drafts keep the historical centered box.
  let inlineTextDirection = $derived(inlineText ? resolveTextBaseDirection(inlineText.draft) : 'ltr')

  function focusInlineText(node: HTMLTextAreaElement) {
    // The opening click can complete after this overlay mounts (pointer
    // capture retargets mouseup/click), and the click's default focus would
    // otherwise steal focus back to the canvas. Defer past the click so the
    // caret lands in the editor, satisfying the focused-on-open requirement.
    const frame = requestAnimationFrame(() => node.focus())
    const timer = setTimeout(() => {
      if (document.activeElement !== node) node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    }, 50)
    return {
      destroy() {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
      },
    }
  }

  // Preview-only font-family for the inline overlay + textarea style.
  // The persisted value stays verbatim (unknown/tricky stacks round-trip
  // byte-identical through the SVG attribute / canvas font string), but raw
  // interpolation into a `style="...font-family:X;..."` string would let a
  // hostile stack smuggle extra declarations (`;`, `{`, `}`) into the live
  // editor chrome. Strip only declaration-breaking characters; quotes, commas,
  // spaces and CJK glyphs (the entire 14-option toolbar, incl. the CJK stacks)
  // pass through so the preview still shows the real typeface.
  function previewTextFontFamily() {
    try {
      return String(vectorTextFontFamily ?? '').replace(/[;{}<>\n\r\0]/g, '').slice(0, 120) || 'Sans Serif'
    } catch {
      return 'Sans Serif'
    }
  }

  function inlineTextStyle() {
    if (!inlineText) return ''
    const previewFamily = previewTextFontFamily()
    if (inlineText.mode === 'vector') {
      const left = vectorArtLeft() + inlineText.x * VECTOR_WORKSPACE_SCALE
      const top = vectorArtTop() + inlineText.y * VECTOR_WORKSPACE_SCALE
      const fontSize = Math.max(8, vectorTextFontSize) * VECTOR_WORKSPACE_SCALE
      return `left:${left}px;top:${top}px;font-size:${fontSize}px;font-family:${previewFamily};`
    }
    const fontSize = Math.max(8, vectorTextFontSize)
    return `left:${inlineText.x}px;top:${inlineText.y}px;font-size:${fontSize}px;font-family:${previewFamily};`
  }

  async function commitInlineText() {
    if (!inlineText || inlineTextCommitting) return
    await flushHsvLive?.()
    const session = inlineText
    const draft = session.draft
    inlineTextCommitting = true
    try {
      if (session.mode === 'vector') {
        await commitVectorInlineText({ x: session.x, y: session.y, text: draft, targetIndex: session.targetIndex })
      } else {
        // The raster path draws centered, so an RTL draft shifts left by half
        // the widest line: the saved right edge lands on the click point,
        // matching the vector anchor. Advances are measured on a throwaway
        // canvas (CJK-accurate) with the estimator as fallback.
        const measureCanvas = typeof document === 'undefined' ? undefined : document.createElement('canvas')
        const measureContext = measureCanvas?.getContext('2d') ?? undefined
        const adjusted = resolveBitmapTextCommitPoint(
          { x: session.x, y: session.y },
          draft,
          vectorTextFontSize,
          vectorTextFontFamily,
          undefined,
          (line, font) => {
            if (!measureContext) return undefined
            try {
              measureContext.font = font
              const width = measureContext.measureText(line).width
              return Number.isFinite(width) && width > 0 ? width : undefined
            } catch {
              return undefined
            }
          },
        )
        await commitBitmapInlineText(adjusted, draft)
      }
    } finally {
      inlineTextCommitting = false
      if (inlineText === session) {
        inlineTextComposing = false
        inlineText = undefined
      }
    }
  }

  function cancelInlineText() {
    // No history, no artwork change: just drop the draft.
    if (inlineTextCommitting) return
    void flushHsvLive?.()
    inlineTextComposing = false
    inlineText = undefined
  }

  function handleInlineTextCompositionStart() {
    inlineTextComposing = true
  }

  function handleInlineTextCompositionEnd() {
    inlineTextComposing = false
  }

  function handleInlineTextKeydown(event: KeyboardEvent) {
    // Scratch parity (text-tool.js TEXT_EDIT_MODE): the textarea keeps its
    // native Enter newline; plain Escape ends editing and commits. Keystrokes
    // must not leak into global costume shortcuts.
    event.stopPropagation()
    // IME conversion owns Escape/Enter: pass them through (no preventDefault,
    // no commit/blur, no shortcut). Guards are layered because no single
    // signal is reliable everywhere: isComposing (Chromium), the
    // compositionstart/end window (IME still open but flag missing), and
    // legacy keyCode/which 229.
    if (shouldDeferInlineTextKeyToIme(event, inlineTextComposing)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      void commitInlineText()
    }
    // Enter falls through so the textarea inserts a newline (Shift+Enter too).
  }

  function bitmapPointFromEvent(event: MouseEvent) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect) return undefined
    return {
      x: Math.max(0, Math.min(bitmapCanvasWidth, ((event.clientX - rect.left) / rect.width) * bitmapCanvasWidth)),
      y: Math.max(0, Math.min(bitmapCanvasHeight, ((event.clientY - rect.top) / rect.height) * bitmapCanvasHeight)),
    }
  }

  function vectorSurfaceScaleFromLayout(): number | undefined {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect || !(rect.width > 0) || !Number.isFinite(vectorCanvasWidth) || vectorCanvasWidth <= 0) return undefined
    const scale = rect.width / vectorCanvasWidth
    return Number.isFinite(scale) && scale > 0 ? scale : undefined
  }

  function vectorSelectToleranceForHit(): number {
    // Layout-measured surface scale already equals 5 * viewportScale; the
    // helper turns the 2 screen-px budget into SVG units. Falls back to the
    // zoom-state conversion (same product) when the layout is unreadable.
    const measured = vectorSurfaceScaleFromLayout()
    if (measured !== undefined) return vectorSelectToleranceFromSurfaceScale(measured)
    return vectorSelectToleranceSvgUnits(viewportScale)
  }

  async function openVectorInlineText(point: { x: number; y: number }) {
    inlineTextComposing = false
    const hit = await findVectorTextIndexAtPoint(point, vectorSelectToleranceForHit()).catch(() => -1)
    if (hit >= 0) {
      const existing = vectorObjects.find((object: VectorObjectInfo) => object.index === hit)
      // Display-only sync: the toolbar shows this unit's effective font
      // (unknown stacks verbatim) and records the session baseline, so an
      // unoperated commit preserves it. Never marks dirty, never touches art.
      try {
        await prepareVectorInlineTextFont?.(hit)
      } catch {
        // Best effort: the session still opens with the current toolbar
        // values, and the commit preserves fonts when no baseline matches.
      }
      inlineText = { mode: 'vector', x: point.x, y: point.y, draft: existing?.text ?? '', targetIndex: hit }
      return
    }
    inlineText = { mode: 'vector', x: point.x, y: point.y, draft: '' }
  }

  function openBitmapInlineText(point: { x: number; y: number }) {
    inlineTextComposing = false
    inlineText = { mode: 'bitmap', x: Math.round(point.x), y: Math.round(point.y), draft: '' }
  }

  function activePaperDensity(): number | undefined {
    // Live density is explicit-only: vector is the fixed 2.5 workspace
    // mapping; bitmap uses the stored resolution prop (2 => 1.0, 1 => 0.5,
    // anything else => unknown). Canvas-width guessing is deliberately NOT
    // done here: without an explicit stored resolution the bitmap path stays
    // unknown (legacy band, fail-closed for unknown only; res1 is decided
    // at 0.5 because the reference loader doubles stored res1 before paint
    // while this repo keeps stored res1 non-destructively).
    if (costumeEditMode === 'vector') return VECTOR_PAPER_TO_CSS_DENSITY
    return densityForBitmapStoredResolution(bitmapResolution)
  }

  function activeResetScale(): number {
    return viewportResetScaleForDensity(activePaperDensity())
  }

  function activeMinScale(): number {
    return viewportMinScaleForDensity(activePaperDensity())
  }

  function activeUiPercent(): number {
    return viewportUiPercentForDensity(viewportScale, activePaperDensity())
  }

  function clampZoom(value: number) {
    // Per-mode Paper band: vector 0.1332..5, res2 0.333..5, res1 0.666..5,
    // unknown 0.25..5. The ceiling 5 stays OUR safety bound (Scratch
    // unbounded above, 明記).
    const density = activePaperDensity()
    if (density === undefined) return clampViewportScale(value)
    return clampViewportScaleForDensity(value, density)
  }

  // Paper workspace clamp wiring (reference `view.js` order, CSS projection).
  // Pure math lives in `viewport-paper-clamp.ts`; this only adapts live
  // Svelte state (surface/container/density/true-center/items) so the unit
  // and browser tests share the formula. Unknown stays legacy
  // (density undefined => input unchanged, 明記). Res1 is clamped on its
  // decided 0.5 density: Paper = (S-cc)/0.5 + (480,360). Scale is never
  // changed here: the Paper clamp only scrolls (center), matching
  // `clampViewBounds` (zoom preserved, clamp wins over the fixed-point pin).
  function paperClampCanvasCenter(): { x: number; y: number } | undefined {
    if (costumeEditMode !== 'bitmap') return undefined
    const w = editSurfaceWidth()
    const h = editSurfaceHeight()
    const cx = Number.isFinite(bitmapArtCenterX) ? (bitmapArtCenterX as number) : w / 2
    const cy = Number.isFinite(bitmapArtCenterY) ? (bitmapArtCenterY as number) : h / 2
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return undefined
    return { x: cx, y: cy }
  }

  function paperClampItems(): Array<{ left: number; top: number; right: number; bottom: number }> {
    try {
      if (costumeEditMode === 'vector') {
        return paperItemRectsForVectorUnits(vectorObjects as Array<{ boundsX?: number; x?: number; boundsY?: number; y?: number; boundsWidth?: number; width?: number; boundsHeight?: number; height?: number }>)
      }
      const density = activePaperDensity()
      if (density === undefined) return []
      const live = { width: editSurfaceWidth(), height: editSurfaceHeight() }
      const mapped = paperItemRectsForBitmapOpaque(
        bitmapFitState?.bounds as { x: number; y: number; width: number; height: number } | null | undefined,
        live,
        bitmapFitState?.surfaceWidth,
        bitmapFitState?.surfaceHeight,
        density,
        paperClampCanvasCenter(),
      )
      // Stale/mismatched fit (resize race, owner switch) fails closed to no
      // items (art+view only) so a stale rect can never teleport the clamp.
      if (mapped === undefined) return []
      return mapped
    } catch {
      return []
    }
  }

  function applyPaperWorkspaceClamp(
    viewport: { x: number; y: number; scale: number },
    clipEmpty: boolean,
  ): { x: number; y: number; scale: number } {
    try {
      const density = activePaperDensity()
      if (density === undefined) return viewport
      const rect = viewportNode?.getBoundingClientRect()
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return viewport
      const clamped = clampCssViewportToPaper({
        viewport,
        surface: { width: editSurfaceWidth(), height: editSurfaceHeight() },
        containerSize: { width: rect.width, height: rect.height },
        density,
        canvasCenter: paperClampCanvasCenter(),
        itemPaperRects: paperClampItems(),
        clipEmpty,
      })
      return clamped.viewport
    } catch {
      return viewport
    }
  }

  function setViewportWithPaperClamp(x: number, y: number, scale: number, clipEmpty: boolean) {
    const banded = clampZoom(scale)
    const clamped = applyPaperWorkspaceClamp({ x, y, scale: banded }, clipEmpty)
    setViewport(clamped.x, clamped.y, banded)
  }

  // Toolbar zoom anchor in edit-surface px: the selection center when
  // something is selected, else the artwork center. Bitmap selections are
  // already canvas px (= surface px); vector bounds are SVG units mapped
  // through the 5x art box at vectorArtLeft/Top.
  function selectionSurfacePoint(): { x: number; y: number } {
    if (costumeEditMode === 'bitmap') {
      const selection = bitmapSelection as { x: number; y: number; width: number; height: number } | undefined
      if (selection && Number.isFinite(selection.x) && Number.isFinite(selection.y) && Number.isFinite(selection.width) && Number.isFinite(selection.height)) {
        return { x: selection.x + selection.width / 2, y: selection.y + selection.height / 2 }
      }
      return { x: editSurfaceWidth() / 2, y: editSurfaceHeight() / 2 }
    }
    const multi = vectorMultiBounds as { x: number; y: number; width: number; height: number } | undefined
    if (multi && Number.isFinite(multi.x) && Number.isFinite(multi.y) && Number.isFinite(multi.width) && Number.isFinite(multi.height)) {
      const centerX = multi.x + multi.width / 2
      const centerY = multi.y + multi.height / 2
      return { x: vectorArtLeft() + centerX * VECTOR_WORKSPACE_SCALE, y: vectorArtTop() + centerY * VECTOR_WORKSPACE_SCALE }
    }
    const selected = new Set<number>()
    for (const index of selectedVectorObjectIndices ?? []) {
      if (Number.isInteger(index)) selected.add(index)
    }
    if (Number.isInteger(selectedVectorObjectIndex) && (selectedVectorObjectIndex as number) >= 0) {
      selected.add(selectedVectorObjectIndex as number)
    }
    if (selected.size > 0) {
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const object of vectorObjects as VectorObjectInfo[]) {
        if (!selected.has(object.index)) continue
        const left = object.boundsX ?? object.x ?? 0
        const top = object.boundsY ?? object.y ?? 0
        const width = object.boundsWidth ?? object.width ?? 2
        const height = object.boundsHeight ?? object.height ?? 2
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) continue
        minX = Math.min(minX, left)
        minY = Math.min(minY, top)
        maxX = Math.max(maxX, left + width)
        maxY = Math.max(maxY, top + height)
      }
      if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY) && maxX > minX && maxY > minY) {
        return { x: vectorArtLeft() + ((minX + maxX) / 2) * VECTOR_WORKSPACE_SCALE, y: vectorArtTop() + ((minY + maxY) / 2) * VECTOR_WORKSPACE_SCALE }
      }
    }
    return { x: editSurfaceWidth() / 2, y: editSurfaceHeight() / 2 }
  }

  // Toolbar zoom about the selection center (or the artwork center with no
  // selection). The fixed-point math lives in costume-viewport.ts so buttons,
  // wheel, and tests share it.
  // - vector: density-aware Paper-parity step (+0.5 Paper units via
  //   2400/960 = 2.5, i.e. +0.2 CSS; floor-exit 0.1332 -> reset 0.2 mirrors
  //   the audited 0.333 -> 0.5 pattern at this density).
  // - bitmap res2 (explicit stored resolution 2): density-aware Paper-parity
  //   step via density 1.0 (reset 0.5, floor 0.333, floor-exit to reset).
  // - bitmap res1 (explicit stored resolution 1): density-aware Paper-parity
  //   step via decided density 0.5 (reset 1.0, floor 0.666..., button
  //   +/-1.0 CSS, floor-exit to reset 1.0).
  // - bitmap unknown (no explicit stored resolution): legacy
  //   direct-copy step (+/-0.5 CSS, 0.25 floor) UNCHANGED.
  // - expansion ceiling: UI max 5 kept as-is (Scratch is unbounded above;
  //   OUR safety bound, 明記). First-fit runs on the decided res1 density too.
  function currentBitmapDensity(): number | undefined {
    return densityForBitmapStoredResolution(bitmapResolution)
  }

  function zoomCanvasStep(direction: 1 | -1) {
    const bitmapDensity = costumeEditMode === 'vector' ? VECTOR_PAPER_TO_CSS_DENSITY : currentBitmapDensity()
    const activeDensity = costumeEditMode === 'vector' ? VECTOR_PAPER_TO_CSS_DENSITY : bitmapDensity
    const next = costumeEditMode === 'vector'
      ? buttonZoomStepForPaperDensity(viewportScale, direction, VECTOR_PAPER_TO_CSS_DENSITY)
      : bitmapDensity === undefined
        ? buttonZoomStepAdditive(viewportScale, direction)
        : buttonZoomStepForPaperDensity(viewportScale, direction, bitmapDensity)
    const surface = { width: editSurfaceWidth(), height: editSurfaceHeight() }
    const anchor = selectionSurfacePoint()
    const rect = viewportNode?.getBoundingClientRect()
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      setViewport(viewportX, viewportY, clampZoom(next))
      return
    }
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    const zoomed = zoomViewportAtSurfacePoint(
      { x: viewportX, y: viewportY, scale: viewportScale },
      surface,
      center,
      anchor,
      next,
      activeDensity,
    )
    // Fixed-point first, then the workspace clamp wins (reference
    // `zoomOnFixedPoint`: newZoom+translate, setWorkspaceBounds(true), clamp).
    // Unknown keeps the legacy unclamped pin (density undefined).
    setViewportWithPaperClamp(zoomed.viewport.x, zoomed.viewport.y, zoomed.viewport.scale, true)
  }

  function resetViewport() {
    // Paper-reset live behavior (per-mode, Paper 0.5 basis): recenter
    // (x/y = 0 = artwork center) at the per-mode reset scale -- vector 0.2
    // (2400 surface -> 480 CSS px), bitmap res2 0.5 (960 canvas -> 480 CSS px,
    // same container width as the vector artboard at reset), bitmap res1 1.0
    // (480 canvas -> 480 CSS px, same container width), unknown 1
    // (legacy "100%" = scale 1). The label reads per-mode percent
    // (`activeUiPercent()`: reset always "100%"), so the internal scale and
    // the "100%" display are separated. No history entry: viewport-only,
    // scoped state (project + slot + costume + mode) via saveViewportState
    // (activeViewportKey); an explicit reset settles the key (F2).
    // Reference `resetZoom` is zoom=0.5, setWorkspaceBounds(true), clamp
    // (clipEmpty=true, clamp wins over the pin). Our reset additionally
    // recenters to the artwork center (vx=vy=0, existing <1px tests pin it
    // exact) and then applies the same clipped workspace, so a recentered
    // view that overhangs the content (e.g. small edge content) is pulled
    // back identically to the reference (P2: +6.25 CSS px at reset for a
    // (0,0,100,100) item). Unknown stays legacy (no clamp, 明記); res1
    // clamps on the decided 0.5 density.
    const banded = clampZoom(activeResetScale())
    const clamped = applyPaperWorkspaceClamp({ x: 0, y: 0, scale: banded }, true)
    viewportX = clamped.x
    viewportY = clamped.y
    viewportScale = banded
    saveViewportState()
  }

  async function switchCostumeEditMode(nextMode: CostumeEditMode) {
    if (costumeEditMode === nextMode) return
    if (nextMode === 'bitmap') await convertCurrentCostumeToBitmap()
    else await convertCurrentCostumeToVector()
    switchToolForFormat(nextMode)
    costumeEditMode = nextMode
    activeCostumeEditMode = nextMode
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
    // All wheel branches run through costume-viewport.ts so the CSS
    // transform, the unit tests, and the browser measurement tests share one
    // frame: ctrl/meta pins the surface point under the cursor, shift turns a
    // vertical tick into horizontal pan, and line-mode deltas expand x15.
    // - vector: density-aware Paper-parity gain ((-dy/1000)/2.5) via
    //   resolveWheelViewportForPaperDensity (per-mode band 0.1332..5).
    // - bitmap res2 (explicit stored 2): ((-dy/1000)/1.0) via
    //   resolveWheelViewportForPaperDensity (band 0.333..5).
    // - bitmap res1 (explicit stored 1): ((-dy/1000)/0.5) via
    //   resolveWheelViewportForPaperDensity (band 0.666..5).
    // - bitmap unknown (no explicit stored resolution): legacy
    //   direct-copy gain (-dy/1000 CSS) UNCHANGED.
    // - pan is screen-px (no /zoom division): the CSS offsets are already
    //   screen px, unlike Paper scrollBy world units.
    // - workspace clamp (reference `pan` vs `zoomOnFixedPoint` order):
    //   general pan uses clipEmpty=false (workspace covers the new view, only
    //   the expanded-MAX edge clamps); ctrl/meta fixed-point zoom uses
    //   clipEmpty=true (clamp wins over the pin). Unknown keeps the
    //   legacy unclamped path.
    event.preventDefault()
    const containerRect = viewportNode?.getBoundingClientRect()
    const wheelInit = {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }
    const wheelContext = {
      surface: { width: editSurfaceWidth(), height: editSurfaceHeight() },
      containerCenter: containerRect
        ? { x: containerRect.left + containerRect.width / 2, y: containerRect.top + containerRect.height / 2 }
        : undefined,
      screenPoint: { x: event.clientX, y: event.clientY },
    }
    const bitmapDensity = costumeEditMode === 'vector' ? VECTOR_PAPER_TO_CSS_DENSITY : currentBitmapDensity()
    const resolved = costumeEditMode === 'vector'
      ? resolveWheelViewportForPaperDensity(
          { x: viewportX, y: viewportY, scale: viewportScale },
          wheelInit,
          wheelContext,
          VECTOR_PAPER_TO_CSS_DENSITY,
        )
      : bitmapDensity === undefined
        ? resolveWheelViewport({ x: viewportX, y: viewportY, scale: viewportScale }, wheelInit, wheelContext)
        : resolveWheelViewportForPaperDensity(
            { x: viewportX, y: viewportY, scale: viewportScale },
            wheelInit,
            wheelContext,
            bitmapDensity,
          )
    if (resolved.kind === 'none') return
    // Reference order: pan scrollBy then clamp (clipEmpty=false, workspace
    // updated after); zoom fixed-point then setWorkspaceBounds(true)+clamp
    // (clipEmpty=true, clamp wins). The Svelte `setViewport` save settles
    // the key (explicit user gesture, F2) without touching history/data.
    if (resolved.kind === 'pan') setViewportWithPaperClamp(resolved.viewport.x, resolved.viewport.y, resolved.viewport.scale, false)
    else setViewportWithPaperClamp(resolved.viewport.x, resolved.viewport.y, resolved.viewport.scale, true)
  }

  function editSurfaceWidth() {
    return costumeEditMode === 'vector' ? BITMAP_WORKSPACE_WIDTH : bitmapCanvasWidth
  }

  function editSurfaceHeight() {
    return costumeEditMode === 'vector' ? BITMAP_WORKSPACE_HEIGHT : bitmapCanvasHeight
  }

  function setViewport(x: number, y: number, scale = viewportScale) {
    viewportScale = clampZoom(scale)
    viewportX = x
    viewportY = y
    saveViewportState()
  }

  function viewportStateKeyFor(baseKey: string, mode: CostumeEditMode): string {
    return scopedViewportKey(baseKey, mode)
  }

  function baseViewportKey(): string {
    return viewportKey || `costume:${currentCostumeIndex}`
  }

  /**
   * Canonical viewport key: project identity + slot (`targetId:index`) + mode.
   *
   * Slot-stable by design (same project + same slot + same mode share one
   * key across paint/save/Undo/Redo): the settled `bitmapFitState.assetKey`
   * is deliberately NOT part of the key. It mints a new token on every image
   * update (same slot, same artboard), which previously forked a pristine key
   * per edit and re-ran first-fit (viewport jump 480x360 -> 1154x865 plus
   * unbounded map growth on content-hash change alone). Same-slot asset
   * rollover therefore keeps the key: edits and Undo/Redo preserve the user
   * viewport and never refit.
   *
   * True scope changes still fork the key:
   * - target/costume switch changes `slot` (`targetId:index`) -> fresh or
   *   past slot state restore;
   * - project load changes `projectIdentity` (and remounts via the
   *   `{#key projectViewportIdentity}` boundary) -> fresh fit;
   * - mode conversion changes `mode` -> each side keeps its own viewport;
   * - explicit user zoom / reset / first-fit settle the slot key (F2).
   * Structural reorder/delete move with the slot string (rename-safe); a
   * reused slot keeps its slot viewport instead of forking per hash.
   *
   * Identity sources:
   * - project: the `projectIdentity` prop. Absent => legacy project segment.
   * - costume: the explicit `costumeIdentity` prop ONLY when non-empty
   *   (reserved for a future structural generation; currently always '' via
   *   `resolveCostumeViewportIdentity`, so bitmap and vector stay slot-scoped
   *   together). The volatile `bitmapFitState.assetKey` fallback is removed.
   * - fully legacy wiring (no identity anywhere) keeps the exact historical
   *   `slot:mode` shape.
   */
  function scopedViewportKey(slot: string, mode: CostumeEditMode): string {
    const project = typeof projectIdentity === 'string' && projectIdentity !== '' ? projectIdentity : undefined
    const explicitAsset = typeof costumeIdentity === 'string' && costumeIdentity !== '' ? costumeIdentity : undefined
    const asset = explicitAsset
    if (project === undefined && asset === undefined) return buildLegacySlotViewportKey(slot, mode)
    return buildCostumeViewportKey({ projectId: project, slotKey: slot, assetKey: asset, mode })
  }

  function saveViewportState(key = activeViewportKey) {
    // Presence in the map MEANS settled (F2): callers only save explicit
    // user pan/zoom, explicit resets, applied fits, and same-slot
    // inheritances (safety net for explicit-asset forks). Key/mode switches
    // never call this for pristine keys.
    if (!key) return
    viewportStates = new Map(viewportStates).set(key, { x: viewportX, y: viewportY, scale: viewportScale })
  }

  function loadViewportState(key: string) {
    // Scoped state (project + slot + mode, slot-stable): missing entries start
    // at the per-mode Paper reset (vector 0.2 / res2 0.5 / res1 1.0 /
    // unknown 1), never a stale scale from another scope. The stored scale is re-clamped to
    // the CURRENT mode band so a mode switch can never carry an
    // out-of-band value. Loading never saves: a pristine key stays pristine
    // so its delayed first-fit still runs (F2).
    const saved = viewportStates.get(key) ?? { x: 0, y: 0, scale: activeResetScale() }
    viewportX = saved.x
    viewportY = saved.y
    viewportScale = clampZoom(saved.scale)
  }

  // The transparency checkerboard is plain CSS so that it can never be cleared by
  // a canvas repaint (or a dropped GPU canvas texture) while dragging artwork.
  // Cells stay whole pixels and are anchored to the artwork's top-left corner, so
  // zooming and panning move the pattern exactly like the previous canvas painting.
  function viewportBackgroundStyle() {
    const cell = Math.max(2, Math.round(CHECKERBOARD_CELL_SIZE * viewportScale))
    const period = cell * 2
    const offsetX = viewportX - (editSurfaceWidth() * viewportScale) / 2 + period / 2
    const offsetY = viewportY - (editSurfaceHeight() * viewportScale) / 2 + period / 2
    return `background-color:#ffffff;background-image:conic-gradient(#e8eef7 25%, #ffffff 0 50%, #e8eef7 0 75%, #ffffff 0);background-size:${period}px ${period}px;background-position:calc(50% + ${offsetX}px) calc(50% + ${offsetY}px);`
  }

  function viewportWheel(node: HTMLElement) {
    viewportNode = node
    // Container-resize clamp (reference `onViewResize` is setWorkspaceBounds
    // (true)+clamp, clipEmpty=true, clamp wins). A resize keeps the kept
    // viewport (no auto-refit, no history/data write) and re-clamps it
    // against the trimmed workspace (P1: x=200 at res2 reset re-clamps to 0,
    // not the cover-view 66.25). Later resizes keep the viewport (scale
    // untouched). Never settles a pristine key (F2): a pre-fit resize adjusts
    // the live offsets without saving so the delayed first-fit still lands;
    // settled keys re-save the clamped center. Matches view.js clipEmpty.
    // Unknown stays legacy (no clamp, 明記); res1 clamps on 0.5.
    // DPR-independent
    // (CSS px via getBoundingClientRect).
    let resizeObserver: ResizeObserver | undefined
    try {
      let lastW = node.clientWidth
      let lastH = node.clientHeight
      resizeObserver = new ResizeObserver(() => {
        const w = node.clientWidth
        const h = node.clientHeight
        if (w === lastW && h === lastH) return
        lastW = w
        lastH = h
        if (!(w > 0) || !(h > 0)) return
        if (activePaperDensity() === undefined) return
        const clamped = applyPaperWorkspaceClamp({ x: viewportX, y: viewportY, scale: viewportScale }, true)
        if (clamped.x !== viewportX || clamped.y !== viewportY) {
          viewportX = clamped.x
          viewportY = clamped.y
          if (activeViewportKey && viewportStates.has(activeViewportKey)) saveViewportState()
        }
      })
      resizeObserver.observe(node)
    } catch {
      resizeObserver = undefined
    }
    node.addEventListener('wheel', handleViewportWheel, { passive: false })
    node.addEventListener('pointerdown', handleCanvasPointerDown)
    node.addEventListener('pointermove', handleCanvasPointerMove)
    node.addEventListener('pointerleave', handleCanvasPointerLeave)
    node.addEventListener('pointerup', handleCanvasPointerUp)
    node.addEventListener('pointercancel', handleCanvasPointerUp)
    node.addEventListener('lostpointercapture', handleCanvasPointerUp)
    node.addEventListener('dblclick', handleCanvasDoubleClick)
    return {
      destroy() {
        activeCanvasPointerId = undefined
        try {
          resizeObserver?.disconnect()
        } catch {
          // Best effort.
        }
        resizeObserver = undefined
        node.removeEventListener('wheel', handleViewportWheel)
        node.removeEventListener('pointerdown', handleCanvasPointerDown)
        node.removeEventListener('pointermove', handleCanvasPointerMove)
        node.removeEventListener('pointerleave', handleCanvasPointerLeave)
        node.removeEventListener('pointerup', handleCanvasPointerUp)
        node.removeEventListener('pointercancel', handleCanvasPointerUp)
        node.removeEventListener('lostpointercapture', handleCanvasPointerUp)
        node.removeEventListener('dblclick', handleCanvasDoubleClick)
        if (viewportNode === node) viewportNode = undefined
      },
    }
  }

  function selectionStyle(rect: { x: number; y: number; width: number; height: number }) {
    return `left:${(rect.x / bitmapCanvasWidth) * 100}%;top:${(rect.y / bitmapCanvasHeight) * 100}%;width:${(rect.width / bitmapCanvasWidth) * 100}%;height:${(rect.height / bitmapCanvasHeight) * 100}%;`
  }

  // Floating-selection scale handles (8 handles). Positioned in the same
  // canvas-percentage space as the selection outline so viewport zoom/pan
  // move them exactly with the artwork.
  function bitmapFloatingScaleHandleStyle(
    rect: { x: number; y: number; width: number; height: number },
    handle: BitmapFloatingScaleHandle,
  ) {
    const handleX = handle.includes('w') ? rect.x : handle.includes('e') ? rect.x + rect.width : rect.x + rect.width / 2
    const handleY = handle.includes('n') ? rect.y : handle.includes('s') ? rect.y + rect.height : rect.y + rect.height / 2
    return `left:${(handleX / bitmapCanvasWidth) * 100}%;top:${(handleY / bitmapCanvasHeight) * 100}%;transform:translate(-50%, -50%);`
  }

  // Rotation handle: centered above the selection's top edge in the same
  // canvas-percentage space, so zoom/pan track the artwork. The button floats
  // clear of the top-edge scale handles via translate(-50%, -160%).
  function bitmapFloatingRotateHandleStyle(rect: { x: number; y: number; width: number; height: number }) {
    const handleX = rect.x + rect.width / 2
    return `left:${(handleX / bitmapCanvasWidth) * 100}%;top:${(rect.y / bitmapCanvasHeight) * 100}%;transform:translate(-50%, -160%);`
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

  // 共有選択境界 (union) の枠・ハンドル配置。単一枠と同じ文書座標→表示
  // 変換で、全選択を包む 1 つの境界に 8 ハンドルを置く。
  function vectorMultiBoundsStyle(bounds: { x: number; y: number; width: number; height: number }) {
    const left = vectorArtLeft() + bounds.x * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + bounds.y * VECTOR_WORKSPACE_SCALE
    const width = Math.max(8, bounds.width * VECTOR_WORKSPACE_SCALE)
    const height = Math.max(8, bounds.height * VECTOR_WORKSPACE_SCALE)
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`
  }

  function vectorMultiHandleStyle(bounds: { x: number; y: number; width: number; height: number }, handle: VectorResizeHandle) {
    const handleX = handle.includes('w') ? bounds.x : handle.includes('e') ? bounds.x + bounds.width : bounds.x + bounds.width / 2
    const handleY = handle.includes('n') ? bounds.y : handle.includes('s') ? bounds.y + bounds.height : bounds.y + bounds.height / 2
    const left = vectorArtLeft() + handleX * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + handleY * VECTOR_WORKSPACE_SCALE
    return `left:${left}px;top:${top}px;transform:translate(-50%, -50%);`
  }

  // Vector rotation handle: centered above the selection's top edge in the
  // same document-to-display mapping as the resize handles, so viewport
  // zoom/pan track the artwork. translate(-50%, -170%) floats it clear of
  // the top-edge resize handles.
  function vectorRotateHandleStyle(object: VectorObjectInfo) {
    const objectLeft = object.boundsX ?? object.x ?? 0
    const objectTop = object.boundsY ?? object.y ?? 0
    const objectWidth = object.boundsWidth ?? object.width ?? 2
    const left = vectorArtLeft() + (objectLeft + objectWidth / 2) * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + objectTop * VECTOR_WORKSPACE_SCALE
    return `left:${left}px;top:${top}px;transform:translate(-50%, -170%);`
  }

  function vectorMultiRotateHandleStyle(bounds: { x: number; y: number; width: number; height: number }) {
    const left = vectorArtLeft() + (bounds.x + bounds.width / 2) * VECTOR_WORKSPACE_SCALE
    const top = vectorArtTop() + bounds.y * VECTOR_WORKSPACE_SCALE
    return `left:${left}px;top:${top}px;transform:translate(-50%, -170%);`
  }

  // Center-snap drag guide (move-snap parity): a 16 screen-px crosshair at
  // the stage center, faded by drag distance over 10 screen px. Surface-px
  // math keeps the on-screen size constant across zoom: diameter 16/scale,
  // stroke 1/scale. `opacity` comes from the Editor (0 hides the guide).
  function centerGuideSurface() {
    const scale = Number.isFinite(viewportScale) && (viewportScale as number) > 0 ? (viewportScale as number) : 1
    const diameter = 16 / scale
    const stroke = 1 / scale
    return { diameter, stroke }
  }

  function vectorCenterGuideStyle(opacity: number) {
    const { diameter, stroke } = centerGuideSurface()
    const canvasWidth = Number.isFinite(vectorCanvasWidth) && (vectorCanvasWidth as number) > 0 ? (vectorCanvasWidth as number) : 480
    const canvasHeight = Number.isFinite(vectorCanvasHeight) && (vectorCanvasHeight as number) > 0 ? (vectorCanvasHeight as number) : 360
    const cx = vectorArtLeft() + ((canvasWidth * VECTOR_WORKSPACE_SCALE) / 2)
    const cy = vectorArtTop() + ((canvasHeight * VECTOR_WORKSPACE_SCALE) / 2)
    return {
      opacity,
      horizontal: `left:${cx - diameter / 2}px;top:${cy - stroke / 2}px;width:${diameter}px;height:${stroke}px;opacity:${opacity};`,
      vertical: `left:${cx - stroke / 2}px;top:${cy - diameter / 2}px;width:${stroke}px;height:${diameter}px;opacity:${opacity};`,
    }
  }

  function bitmapCenterGuideStyle(opacity: number) {
    const { diameter, stroke } = centerGuideSurface()
    const canvasWidth = Number.isFinite(bitmapCanvasWidth) && (bitmapCanvasWidth as number) > 0 ? (bitmapCanvasWidth as number) : 1
    const canvasHeight = Number.isFinite(bitmapCanvasHeight) && (bitmapCanvasHeight as number) > 0 ? (bitmapCanvasHeight as number) : 1
    // True Scratch center vs canvas center: the live canvas can be a union
    // wider than the artboard (e.g. 1200px union with true center 480, while
    // canvas.width/2 = 600). Editor passes the tracked artboard center
    // (bitmapArtboard.canvasCenterX/Y when settled); only fall back to the
    // canvas middle when the tracked value is missing/non-finite. The drag
    // snap in Editor.svelte uses the same tracked value so guide and snap
    // always share one anchor.
    const cx = Number.isFinite(bitmapArtCenterX) ? (bitmapArtCenterX as number) : canvasWidth / 2
    const cy = Number.isFinite(bitmapArtCenterY) ? (bitmapArtCenterY as number) : canvasHeight / 2
    return {
      opacity,
      horizontal: `left:${((cx - diameter / 2) / canvasWidth) * 100}%;top:${((cy - stroke / 2) / canvasHeight) * 100}%;width:${(diameter / canvasWidth) * 100}%;height:${(stroke / canvasHeight) * 100}%;opacity:${opacity};`,
      vertical: `left:${((cx - stroke / 2) / canvasWidth) * 100}%;top:${((cy - diameter / 2) / canvasHeight) * 100}%;width:${(stroke / canvasWidth) * 100}%;height:${(diameter / canvasHeight) * 100}%;opacity:${opacity};`,
    }
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

  function vectorPointFromEvent(event: MouseEvent | PointerEvent) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect) return undefined
    return {
      x: Math.max(0, Math.min(vectorCanvasWidth, ((event.clientX - rect.left) / rect.width) * vectorCanvasWidth)),
      y: Math.max(0, Math.min(vectorCanvasHeight, ((event.clientY - rect.top) / rect.height) * vectorCanvasHeight)),
    }
  }

  function vectorBrushPointFromEvent(event: MouseEvent) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect) return undefined
    const x = ((event.clientX - rect.left) / rect.width) * editSurfaceWidth()
    const y = ((event.clientY - rect.top) / rect.height) * editSurfaceHeight()
    return {
      x: Math.max(0, Math.min(vectorCanvasWidth, (x - vectorArtLeft()) / VECTOR_WORKSPACE_SCALE)),
      y: Math.max(0, Math.min(vectorCanvasHeight, (y - vectorArtTop()) / VECTOR_WORKSPACE_SCALE)),
    }
  }

  function normalizedRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
    const left = Math.min(start.x, end.x)
    const top = Math.min(start.y, end.y)
    return { x: left, y: top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
  }

  function vectorShapePreviewRect(draft: { shape: 'rect' | 'oval' | 'line'; start: { x: number; y: number }; current: { x: number; y: number }; modifiers: ShapeModifierKeys }): Rect {
    // A line keeps the drag vector (start -> current) so a reverse drag draws
    // from the reverse endpoints; rect/oval use the normalized bounding box.
    if (draft.shape === 'line') return vectorLineRect(draft.start, draft.current)
    return resolveShapeRect(draft.start, draft.current, draft.modifiers)
  }

  // Commit gate for an in-progress vector rect/oval draft. The reference
  // tools discard while `|width * height|` is below 2 screen px divided by
  // the live Paper zoom: clicks, sub-pixel jitter, and axis-zero drags
  // without Shift stay history-free with no selection change, while a Shift
  // drag is squared first so one zero axis still commits the square.
  function vectorShapeDraftShouldCommit(draft: { shape: 'rect' | 'oval' | 'line'; start: { x: number; y: number }; current: { x: number; y: number }; modifiers: ShapeModifierKeys }): boolean {
    if (draft.shape === 'line') return isShapeDrag(draft.start, draft.current)
    return shouldCommitShapeDrag(draft.start, draft.current, draft.modifiers, vectorShapePaperZoom(viewportScale))
  }

  // Transparent-aware preview colors. The hex pickers keep their values while
  // a toggle is on (so untoggling restores them); previews resolve `null` to
  // `none` for solid fills/strokes and to RGB-matched `rgba()` stops for
  // gradients, exactly like the committed artwork. `VectorShapePreview` takes
  // plain color strings, so no changes there were needed.
  let previewGradientStops = $derived(previewGradientEndCss(fillTransparent, paintColor, secondaryTransparent, secondaryPaintColor))
  let previewFillColor = $derived(paintGradient === 'solid' ? (fillTransparent ? 'none' : paintColor) : previewGradientStops.from)
  let previewSecondaryColor = $derived(paintGradient === 'solid' ? secondaryPaintColor : previewGradientStops.to)
  let previewStrokeColor = $derived(strokeTransparent ? 'none' : strokeColor)
  // Independent stroke gradient ends (vector only): a transparent end reuses
  // the surviving end's RGB with alpha 0 so the preview fades opacity
  // without swinging through black — same rule as the fill side.
  let previewStrokeStops = $derived.by(() => {
    const { from, to } = resolveGradientEndpoints(
      strokeTransparent ? null : hexToPaintRgba(strokeColor),
      secondaryStrokeTransparent ? null : hexToPaintRgba(strokeSecondaryColor),
    )
    return { from: paintToCss(from), to: paintToCss(to) }
  })
  let previewStrokeGradientColor = $derived(strokeGradient === 'solid' ? (strokeTransparent ? 'none' : strokeColor) : previewStrokeStops.from)
  let previewStrokeSecondaryGradientColor = $derived(strokeGradient === 'solid' ? strokeSecondaryColor : previewStrokeStops.to)
  // Swatch previews reuse the transparent-aware preview colors so the closed
  // button shows exactly what a solid pick would paint (gradients show a ramp;
  // transparent shows the checker via the popover's swatchTransparent flag).
  let fillSwatchBackground = $derived(
    paintGradient === 'solid' ? previewFillColor : `linear-gradient(135deg, ${previewFillColor} 0%, ${previewSecondaryColor} 100%)`,
  )
  let strokeSwatchBackground = $derived(
    strokeGradient === 'solid' ? previewStrokeColor : `linear-gradient(135deg, ${previewStrokeColor} 0%, ${previewStrokeSecondaryGradientColor} 100%)`,
  )

  // Unknown-stack display (font-fallback audit fix): when the toolbar holds
  // a font stack outside the shortlist (e.g. an external SVG's effective
  // font synced on open), the selects render it as a real option showing the
  // actual value instead of dropping to selectedIndex -1 (blank). Choosing a
  // shortlist entry again removes the extra row; the value itself is only
  // written to the artwork by an explicit session-owned commit.
  let isUnknownVectorTextFont = $derived(
    !VECTOR_TEXT_FONT_OPTIONS.some((option) => option.value === vectorTextFontFamily),
  )

  // MIXED summary flags (read-only selection display): when the vector
  // selection holds differing values the toolbar keeps the last global paint
  // and shows a MIXED badge instead of a concrete color. Badges never write
  // history or artwork; only an explicit user change marks the field dirty.
  let mixedFill = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.fill))
  let mixedFillSecondary = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.fillSecondary))
  let mixedFillGradient = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.fillGradient))
  let mixedStroke = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.stroke))
  let mixedStrokeSecondary = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.strokeSecondary))
  let mixedStrokeGradient = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.strokeGradient))
  let mixedStrokeWidth = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.strokeWidth))
  let mixedOpacity = $derived(costumeEditMode === 'vector' && (selectedVectorObjectIndices?.length ?? 0) > 0 && isMixedSelectionValue(vectorSelectionSummary?.opacity))

  // HSV slider resync epoch (Scratch parity: the sliders keep their local hue
  // through selection-only updates and re-derive from the hex when the epoch,
  // the hex, or the mixed/transparent flags change — eyedropper picks and
  // swaps flow through the hex diff, so no new Editor.svelte prop is needed).
  let hsvSyncKey = $derived(
    `${selectedVectorObjectIndex ?? -1}|${(selectedVectorObjectIndices ?? []).join(',')}`,
  )

  // Reference fill/stroke disabled parity (read from
  // `.tmp/scratch-editor/...`, no code copied):
  // - `containers/fill-color-indicator.jsx` L27: fill disabled while LINE;
  // - `containers/stroke-color-indicator.jsx` L27-L29 and
  //   `containers/stroke-width-indicator.jsx` L67-L70: stroke disabled while
  //   BRUSH/TEXT/FILL.
  // The reference wraps the whole color indicator (button + popover holding
  // HSV/transparent/eyedropper/gradient/swap) in one `pointer-events: none`
  // group (`input-group.css` `.disabled`: opacity 0.3 + no pointer events),
  // so every side operation is unreachable while disabled. This toolbar
  // splits those into top-level controls, so each one carries the same
  // disabled condition explicitly via the shared `paint-toolbar-sizes`
  // predicates (judgment stays in the feature helper, never inline):
  // - vector LINE disables the entire fill side (a line has no interior);
  // - vector BRUSH/TEXT/FILL disable the entire stroke side (the brush uses
  //   its own size; text/fill paint the fill only).
  // - bitmap mode shows the fill side only (reference `paint-editor.jsx`
  //   bitmap branch has no stroke indicator/width); bitmap stroke state stays
  //   stored but hidden, and the shared brush/thickness slider follows the
  //   `mode-tools.jsx` per-tool branches (brush/line always, rect/oval only
  //   while outlined).
  // Native `disabled` keeps keyboard focus and screen-reader semantics for
  // free (unfocusable via Tab, announced as dimmed/disabled). Every toolbar
  // commit path below guards the same flags first: a disabled touch marks
  // nothing dirty, paints no live selection, and writes no stored color, SVG,
  // VM bytes, or history entry — the reference no-op, where the whole
  // popover (HSV/transparent/eyedropper/gradient/swap) is unreachable.
  let fillPaintDisabled = $derived(isVectorFillDisabled(costumeEditMode, vectorTool))
  let strokePaintDisabled = $derived(isVectorStrokeDisabled(costumeEditMode, vectorTool))
  // Bitmap toolbar visibility (reference `paint-editor.jsx` bitmap row shows
  // fill only + `mode-tools.jsx` per-tool branches): stroke/outline controls
  // never render in bitmap mode, and the shared brush/thickness slider only
  // renders for brush/line plus rect/oval while outlined. State (stroke
  // color/width, brushSize) survives hidden so switching modes never resets it.
  let bitmapStrokeVisible = $derived(isBitmapStrokeControlsVisible(costumeEditMode))
  let bitmapBrushSizeVisible = $derived(
    costumeEditMode === 'bitmap' ? isBitmapBrushSizeVisible(bitmapTool, bitmapShapeMode) : false,
  )
  // Popover gating parity: a disabled side is unreachable, so an open dialog
  // whose side just became disabled (tool switch into LINE/BRUSH/TEXT/FILL,
  // or bitmap mode hiding the outline) closes without writing anything.
  // The armed eyedropper owns the canvas: both swatch triggers stay natively
  // disabled (unfocusable via Tab, announced dimmed) so reopening can never
  // steal focus into an input mid-pick; a dialog caught open still closes.
  $effect(() => {
    if (openStylePopover === 'fill' && fillPaintDisabled) closeStylePopover()
    if (openStylePopover === 'stroke' && (strokePaintDisabled || !bitmapStrokeVisible)) closeStylePopover()
    if (eyedropperActive && openStylePopover !== null) closeStylePopover()
  })

  // First/second fill-color swap (Scratch Paint parity): the hex pickers and
  // their transparent flags exchange together, so a transparent primary with
  // an opaque secondary round-trips exactly. Pure helper keeps it unit
  // testable; bindables propagate to Editor.svelte automatically.
  function swapFillPaint() {
    // Honke parity: the swap lives inside the disabled color indicator, so a
    // disabled fill side cannot swap (no stored-color change at all).
    if (fillPaintDisabled) return
    const next = swapFillPaintState({
      primary: paintColor,
      primaryTransparent: fillTransparent,
      secondary: secondaryPaintColor,
      secondaryTransparent,
    })
    paintColor = next.primary
    fillTransparent = next.primaryTransparent
    secondaryPaintColor = next.secondary
    secondaryTransparent = next.secondaryTransparent
  }

  // First/second stroke-color swap (outline parity): same involution for the
  // independent stroke side. Vector-only paint state; bitmap fill/brushSize
  // and the bitmap text outline (solid primary only) are untouched.
  function swapStrokePaint() {
    // Honke parity: same as the fill swap — a disabled stroke side cannot
    // swap, so hidden outline state is never rewritten through it.
    if (strokePaintDisabled) return
    const next = swapStrokePaintState({
      primary: strokeColor,
      primaryTransparent: strokeTransparent,
      secondary: strokeSecondaryColor,
      secondaryTransparent: secondaryStrokeTransparent,
    })
    strokeColor = next.primary
    strokeTransparent = next.primaryTransparent
    strokeSecondaryColor = next.secondary
    secondaryStrokeTransparent = next.secondaryTransparent
  }

  // Selection clipboard enablement shared by the toolbar buttons below.
  // - Copy in vector mode falls back to every object when nothing is selected
  //   (copy-paste-hoc parity), so it needs at least one object; bitmap copy
  //   falls back to the trimmed opaque raster, so it stays enabled once the
  //   destination is settled.
  // - Paste accepts either clipboard (cross-format fallback): same-mode wins
  //   in the Editor dispatch, the other mode converts across instead of
  //   no-op, so the button stays enabled when at least one entry exists and
  //   the destination is settled. Vector mode never locks on the bitmap
  //   workspace; clipboard emptiness stays an independent branch.
  // - Both stay disabled while the eyedropper overlay owns the canvas, while
  //   an inline text draft owns the keyboard, (paste only) while a floating
  //   bitmap drag owns the canvas preview, and (bitmap mode only) while the
  //   destination is loading/verifying or refused — matching the shortcut
  //   guards in Editor.svelte, which swallow copy/paste under the overlay and
  //   report "Finish the bitmap selection drag first" mid-drag or
  //   "Loading bitmap…" while pending.
  let copySelectionDisabled = $derived(
    eyedropperActive ||
      inlineText !== undefined ||
      (costumeEditMode === 'vector' ? vectorObjects.length === 0 : bitmapDestructiveDisabled) ||
      !copyCostumeSelection,
  )
  let pasteSelectionDisabled = $derived(
    eyedropperActive ||
      inlineText !== undefined ||
      bitmapFloatingActive ||
      ((vectorClipboard?.length ?? 0) === 0 && !bitmapClipboard) ||
      !pasteCostumeSelection ||
      (costumeEditMode === 'bitmap' && bitmapDestructiveDisabled),
  )
  // Bitmap-mode destructive toolbar gating (edit/save/paste/delete/flip/rotate):
  // mirrors the Editor owner gate for `disabled`/title only. Vector mode is
  // never gated by the bitmap workspace.
  let bitmapToolbarLocked = $derived(costumeEditMode === 'bitmap' && bitmapDestructiveDisabled)
  let bitmapLoadingVisible = $derived(costumeEditMode === 'bitmap' && bitmapWorkspaceBusy)

  // Responsive action-row overflow (narrow-panel parity): Undo/Redo/Delete
  // stay pinned (always visible, never overflow) while Copy/Paste lead the
  // measured More (⋯) menu as priority actions: inline while they fit, in the
  // menu when the panel narrows. Each entry preserves its original testId/
  // aria-label/title/disabled/handler — the overflow component renders it
  // either inline or in the menu, never both. Keeping only one pinned
  // clipboard button (instead of a three-button cluster) guarantees the
  // trailing More trigger keeps its reserved 36px even in the 411px panel at
  // 1104x763, where three pinned clusters previously squeezed the overflow
  // container to 0px and pushed More past the panel edge (unclickable).
  // Delete stays pinned because existing flows press it directly at any
  // width; Copy/Paste stay one click away inline-or-menu with no hiding.
  let toolbarOverflowActions = $derived<PaintToolbarOverflowAction[]>([
    {
      id: 'copy',
      label: 'Copy selection',
      title: bitmapToolbarLocked ? 'Loading bitmap…' : 'Copy selection',
      testId: 'copy-costume-selection',
      disabled: copySelectionDisabled,
      ariaDisabled: bitmapToolbarLocked ? 'true' : undefined,
      icon: Copy,
      iconSize: 20,
      onClick: () => copyCostumeSelection?.(),
    },
    {
      id: 'paste',
      label: 'Paste selection',
      title: bitmapLoadingVisible ? 'Loading bitmap…' : 'Paste selection',
      testId: 'paste-costume-selection',
      disabled: pasteSelectionDisabled,
      ariaDisabled: bitmapToolbarLocked ? 'true' : undefined,
      icon: ClipboardPaste,
      iconSize: 20,
      onClick: () => pasteCostumeSelection?.(),
    },
    {
      id: 'duplicate',
      label: 'Duplicate costume',
      title: 'Duplicate',
      testId: undefined,
      disabled: false,
      ariaDisabled: undefined,
      icon: Copy,
      iconSize: 20,
      onClick: () => duplicateCurrentCostume(),
    },
    {
      id: 'group',
      label: 'Group',
      title: 'Group',
      testId: undefined,
      disabled: costumeEditMode !== 'vector' || selectedVectorObjectIndices.length < 2,
      ariaDisabled: undefined,
      icon: Group,
      iconSize: 21,
      onClick: () => groupVectorSelection(),
    },
    {
      id: 'ungroup',
      label: 'Ungroup',
      title: 'Ungroup',
      testId: undefined,
      disabled: costumeEditMode !== 'vector' || selectedVectorObjectIndex < 0,
      ariaDisabled: undefined,
      icon: Ungroup,
      iconSize: 21,
      onClick: () => ungroupVectorSelection(),
    },
    {
      id: 'front',
      label: 'Bring to front',
      title: 'Bring to front',
      testId: 'layer-order-front',
      disabled: costumeEditMode !== 'vector' || (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !bringVectorSelectionToFront,
      ariaDisabled: undefined,
      icon: BringToFront,
      iconSize: 21,
      onClick: () => bringVectorSelectionToFront?.(),
    },
    {
      id: 'forward',
      label: 'Bring forward',
      title: 'Bring forward',
      testId: 'layer-order-forward',
      disabled: costumeEditMode !== 'vector' || (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !bringVectorSelectionForward,
      ariaDisabled: undefined,
      icon: AlignStartHorizontal,
      iconSize: 21,
      onClick: () => bringVectorSelectionForward?.(),
    },
    {
      id: 'backward',
      label: 'Send backward',
      title: 'Send backward',
      testId: 'layer-order-backward',
      disabled: costumeEditMode !== 'vector' || (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !sendVectorSelectionBackward,
      ariaDisabled: undefined,
      icon: AlignEndHorizontal,
      iconSize: 21,
      onClick: () => sendVectorSelectionBackward?.(),
    },
    {
      id: 'back',
      label: 'Send to back',
      title: 'Send to back',
      testId: 'layer-order-back',
      disabled: costumeEditMode !== 'vector' || (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !sendVectorSelectionToBack,
      ariaDisabled: undefined,
      icon: SendToBack,
      iconSize: 21,
      onClick: () => sendVectorSelectionToBack?.(),
    },
    {
      id: 'flip-h',
      label: 'Flip horizontal',
      title: bitmapToolbarLocked ? 'Loading bitmap…' : 'Flip horizontal',
      testId: 'flip-bitmap-horizontal',
      disabled: costumeEditMode === 'bitmap' ? bitmapToolbarLocked : (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !flipVectorSelection,
      ariaDisabled: undefined,
      icon: FlipHorizontal2,
      iconSize: 21,
      onClick: () => (costumeEditMode === 'vector' ? flipVectorSelection?.(true) : flipBitmap(true)),
    },
    {
      id: 'flip-v',
      label: 'Flip vertical',
      title: bitmapToolbarLocked ? 'Loading bitmap…' : 'Flip vertical',
      testId: 'flip-bitmap-vertical',
      disabled: costumeEditMode === 'bitmap' ? bitmapToolbarLocked : (selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0) || !flipVectorSelection,
      ariaDisabled: undefined,
      icon: FlipVertical2,
      iconSize: 21,
      onClick: () => (costumeEditMode === 'vector' ? flipVectorSelection?.(false) : flipBitmap(false)),
    },
    {
      id: 'rotate-left',
      label: 'Rotate left',
      title: bitmapToolbarLocked ? 'Loading bitmap…' : 'Rotate left',
      testId: 'rotate-bitmap-left',
      disabled: costumeEditMode !== 'bitmap' || bitmapToolbarLocked,
      ariaDisabled: undefined,
      icon: RotateCcw,
      iconSize: 21,
      onClick: () => rotateBitmap(false),
    },
    {
      id: 'rotate-right',
      label: 'Rotate right',
      title: bitmapToolbarLocked ? 'Loading bitmap…' : 'Rotate right',
      testId: 'rotate-bitmap-right',
      disabled: costumeEditMode !== 'bitmap' || bitmapToolbarLocked,
      ariaDisabled: undefined,
      icon: RotateCw,
      iconSize: 21,
      onClick: () => rotateBitmap(true),
    },
  ])

  function chooseVectorTool(tool: VectorTool) {
    if (vectorTool !== tool) {
      clearFillHoverPreview()
      void flushHsvLive?.()
      // Reference `fill-mode.jsx` parity: activating the fill tool clears the
      // vector selection (no blue box; Delete disabled). Other tools keep
      // their selection so unrelated UI is never cleared accidentally.
      if (tool === 'fill') {
        try {
          clearVectorObjectSelection?.()
        } catch {
          // Best-effort only; tool switch still lands.
        }
      }
    }
    vectorTool = tool
    if (tool === 'rect' || tool === 'oval' || tool === 'line' || tool === 'text') vectorShape = tool
    // Leaving reshape normalizes back to the compound root for the select
    // tool: the group object stays selected (root), the leaf/point sets
    // clear so a later Delete removes the object instead of a stale index.
    if (tool !== 'reshape' && (vectorReshapePointIndex !== undefined || (vectorReshapePointIndices?.length ?? 0) > 0 || (vectorReshapeLeafIndices?.length ?? 0) > 0)) {
      if (normalizeReshapeLeafToSelectRoot) normalizeReshapeLeafToSelectRoot()
      else {
        selectVectorReshapePoints?.([])
        selectVectorReshapePoint?.(undefined)
        selectVectorReshapeLeaves?.([])
      }
    }
    // Popover-open tool-switch parity: the reference picker (with its
    // eyedropper) belongs to the disabled indicator, so an overlay whose
    // target just became disabled closes instead of lingering on a dead side.
    // The cancel writes nothing (no color, SVG, VM, or history change) and the
    // previous paint tool survives untouched.
    if (eyedropperActive && costumeEditMode === 'vector') {
      if (
        (eyedropperTarget === 'fill' && isVectorFillDisabled(costumeEditMode, tool)) ||
        (eyedropperTarget === 'stroke' && isVectorStrokeDisabled(costumeEditMode, tool))
      ) {
        cancelEyedropper()
      }
    }
  }

  function selectedVectorObject() {
    return vectorObjects.find((object: VectorObjectInfo) => object.index === selectedVectorObjectIndex)
  }

  // Reshape anchor style for the Curved/Pointed mode tools (Scratch parity).
  // paperVectorObjectList exposes anchors + non-zero handles in document space;
  // collinearity of (in - anchor) vs (out - anchor) mirrors
  // vector-point-style.ts areSmoothHandles (cross tolerance + opposite direction).
  // The helper remains authoritative (no-op without history); this only drives
  // button enablement so a stale/disabled click never writes history.
  const RESHAPE_STYLE_EPS = 0.001
  function reshapeHandlesSmooth(inX: number, inY: number, outX: number, outY: number): boolean {
    if (Math.abs(inX) < RESHAPE_STYLE_EPS && Math.abs(inY) < RESHAPE_STYLE_EPS) return false
    if (Math.abs(outX) < RESHAPE_STYLE_EPS && Math.abs(outY) < RESHAPE_STYLE_EPS) return false
    const inLength = Math.hypot(inX, inY)
    const outLength = Math.hypot(outX, outY)
    if (!Number.isFinite(inLength) || !Number.isFinite(outLength) || inLength <= 0 || outLength <= 0) return false
    const cross = inX * outY - inY * outX
    const tolerance = Math.max(0.001, inLength * outLength * 0.001)
    if (Math.abs(cross) > tolerance) return false
    return inX * outX + inY * outY < 0
  }

  function selectedReshapeAnchorIndices(): number[] {
    // Action gating (Paper `segment.selected` parity): every mask bit counts,
    // so latent handle-only anchors act. Mirrors Editor
    // `reshapeLiveActionIndices` and the overlay `actionAnchors` — display
    // stays point-bit elsewhere, but Curved/Pointed enablement + styling must
    // see the same targets the actions will mutate.
    const masks = vectorReshapeHandleMasks as Record<number, number> | undefined
    if (masks && Object.keys(masks).length > 0) {
      try {
        const owner = selectedVectorObject()
        const livePoints = owner?.points ?? []
        if (livePoints.length > 0) return liveReshapeActionIndices(livePoints as never, masks as never)
      } catch {
        // Fall through to the point-bit projection on probe failure.
      }
    }
    if (vectorReshapePointIndices !== undefined) return [...vectorReshapePointIndices]
    return vectorReshapePointIndex !== undefined ? [vectorReshapePointIndex] : []
  }

  // Per-anchor style classification shared by the single- and multi-point
  // Curved/Pointed buttons. Mirrors the single-anchor derivation below so a
  // mixed selection enables both actions.
  function reshapeAnchorStyleBits(
    points: VectorPathPointInfo[],
    anchor: VectorPathPointInfo,
    controls: VectorPathPointInfo[],
  ): { hasUncurved: boolean; hasUnpointed: boolean; style: 'curved' | 'pointed' } {
    const hasIn = controls.some((point) => point.controlRole === 'in')
    const hasOut = controls.some((point) => point.controlRole === 'out')
    const hasAny = controls.length > 0
    if (!hasAny) return { hasUncurved: true, hasUnpointed: false, style: 'pointed' as const }
    if (hasIn && hasOut) {
      const inControl = controls.find((point) => point.controlRole === 'in')!
      const outControl = controls.find((point) => point.controlRole === 'out')!
      const smooth = reshapeHandlesSmooth(inControl.x - anchor.x, inControl.y - anchor.y, outControl.x - anchor.x, outControl.y - anchor.y)
      return smooth
        ? { hasUncurved: false, hasUnpointed: true, style: 'curved' as const }
        : { hasUncurved: true, hasUnpointed: true, style: 'pointed' as const }
    }
    const anchorIndices = points
      .filter((point) => point.kind !== 'control')
      .map((point) => point.index)
      .sort((a, b) => a - b)
    const isEndpoint =
      anchorIndices.length > 0 && (anchor.index === anchorIndices[0] || anchor.index === anchorIndices[anchorIndices.length - 1])
    return isEndpoint
      ? { hasUncurved: false, hasUnpointed: true, style: 'curved' as const }
      : { hasUncurved: true, hasUnpointed: true, style: 'pointed' as const }
  }

  let reshapePointStyle = $derived.by(() => {
    const object = selectedVectorObject()
    const indices = selectedReshapeAnchorIndices()
    if (!object?.points || indices.length === 0) {
      return { hasUncurved: false, hasUnpointed: false, style: undefined as 'curved' | 'pointed' | undefined, count: 0 }
    }
    const bits: Array<{ hasUncurved: boolean; hasUnpointed: boolean; style: 'curved' | 'pointed' }> = []
    for (const index of indices) {
      const anchor = object.points.find((point: VectorPathPointInfo) => point.index === index && point.kind !== 'control')
      if (!anchor) continue
      const controls = object.points.filter(
        (point: VectorPathPointInfo) => point.kind === 'control' && point.relatedAnchorIndex === index,
      )
      bits.push(reshapeAnchorStyleBits(object.points, anchor, controls))
    }
    if (bits.length === 0) {
      return { hasUncurved: false, hasUnpointed: false, style: undefined as 'curved' | 'pointed' | undefined, count: 0 }
    }
    const styles = new Set(bits.map((item) => item.style))
    return {
      hasUncurved: bits.some((item) => item.hasUncurved),
      hasUnpointed: bits.some((item) => item.hasUnpointed),
      style: styles.size === 1 ? ([...styles][0] as 'curved' | 'pointed') : undefined,
      count: bits.length,
    }
  })

  function reshapeAddAtClient(clientX: number, clientY: number) {
    if (costumeEditMode !== 'vector' || vectorTool !== 'reshape') return
    if (inlineText) return
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    const x = Math.max(0, Math.min(vectorCanvasWidth, ((clientX - rect.left) / rect.width) * vectorCanvasWidth))
    const y = Math.max(0, Math.min(vectorCanvasHeight, ((clientY - rect.top) / rect.height) * vectorCanvasHeight))
    // Zoom-aware reshape budget: 6.25 screen px divided by the measured
    // surface scale (== 5 * viewportScale). A fixed 6 SVG-unit tolerance
    // would span 7.5 screen px at 25% but 150 screen px at 500%.
    const surfaceScale = rect.width / vectorCanvasWidth
    const tolerance = Number.isFinite(surfaceScale) && surfaceScale > 0
      ? vectorReshapeToleranceFromSurfaceScale(surfaceScale)
      : vectorReshapeToleranceSvgUnits(viewportScale)
    void addVectorPathPointAt?.({ x, y }, tolerance)
  }

  function reshapeLeafAtClient(clientX: number, clientY: number, append = false): Promise<boolean> {
    if (costumeEditMode !== 'vector' || vectorTool !== 'reshape') return Promise.resolve(false)
    if (inlineText) return Promise.resolve(false)
    if (selectedVectorObjectIndex === undefined || (selectedVectorObjectIndex ?? -1) < 0) return Promise.resolve(false)
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return Promise.resolve(false)
    const x = Math.max(0, Math.min(vectorCanvasWidth, ((clientX - rect.left) / rect.width) * vectorCanvasWidth))
    const y = Math.max(0, Math.min(vectorCanvasHeight, ((clientY - rect.top) / rect.height) * vectorCanvasHeight))
    const surfaceScale = rect.width / vectorCanvasWidth
    const tolerance = Number.isFinite(surfaceScale) && surfaceScale > 0
      ? vectorReshapeToleranceFromSurfaceScale(surfaceScale)
      : vectorReshapeToleranceSvgUnits(viewportScale)
    try {
      const result = selectVectorReshapeLeafAtPoint?.({ x, y }, append, tolerance)
      if (result instanceof Promise) return result.then((hit) => hit === true).catch(() => false)
      return Promise.resolve(result === true)
    } catch {
      return Promise.resolve(false)
    }
  }

  function reshapeLeafTranslateBeginAtClient(clientX: number, clientY: number, event: PointerEvent, append = false): Promise<boolean> {
    if (costumeEditMode !== 'vector' || vectorTool !== 'reshape') return Promise.resolve(false)
    if (inlineText) return Promise.resolve(false)
    if (selectedVectorObjectIndex === undefined || (selectedVectorObjectIndex ?? -1) < 0) return Promise.resolve(false)
    if (!beginVectorLeafTranslateDragAtPoint) return Promise.resolve(false)
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return Promise.resolve(false)
    const x = Math.max(0, Math.min(vectorCanvasWidth, ((clientX - rect.left) / rect.width) * vectorCanvasWidth))
    const y = Math.max(0, Math.min(vectorCanvasHeight, ((clientY - rect.top) / rect.height) * vectorCanvasHeight))
    const surfaceScale = rect.width / vectorCanvasWidth
    const scale = Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1
    try {
      const result = beginVectorLeafTranslateDragAtPoint({ x, y }, event, scale)
      if (result instanceof Promise) return result.then((hit) => hit === true).catch(() => false)
      return Promise.resolve(result === true)
    } catch {
      return Promise.resolve(false)
    }
  }

  $effect(() => {
    if (selectedVectorObjectIndex < 0 && (vectorReshapePointIndex !== undefined || (vectorReshapePointIndices?.length ?? 0) > 0 || (vectorReshapeLeafIndices?.length ?? 0) > 0)) {
      selectVectorReshapePoints?.([])
      selectVectorReshapePoint?.(undefined)
      selectVectorReshapeLeaves?.([])
    }
  })

  $effect(() => {
    // Viewport scope: project identity + slot (targetId:index) + mode (see
    // `scopedViewportKey`), so each side keeps its own pan/zoom, a replaced
    // project starts unsettled, and same-slot paint/save/Undo/Redo keeps the
    // key (no refit, no map growth on content-hash change alone).
    // F2: only settled keys occupy `viewportStates`. The outgoing key is
    // saved only when it is settled -- a pristine placeholder (pre-fit reset,
    // undecoded arrival) is never persisted, so a revisit still runs its
    // delayed first-fit instead of finding a saved reset. Delayed fits,
    // explicit resets, and user pan/zoom insert via `setViewport`.
    const slot = viewportKey || `costume:${currentCostumeIndex}`
    const nextKey = viewportStateKeyFor(slot, costumeEditMode)
    if (nextKey === activeViewportKey) return
    if (activeViewportKey !== '' && viewportStates.has(activeViewportKey)) saveViewportState()
    // Same-slot rollover safety net (an explicit future `costumeIdentity`
    // fork, or the same slot re-resolving while pristine): inherit the settled
    // outgoing viewport so the pending fit does not clobber the user's
    // pre-fit zoom/wheel. With the slot-stable key, paint/save/Undo/Redo no
    // longer fork at all (early return above), so this only fires on true
    // scope changes. Cross-slot switches never inherit (F3); cross-mode
    // switches never inherit (conversion keeps each side's own viewport).
    if (!viewportStates.has(nextKey) && activeViewportSlot === slot && activeViewportMode === costumeEditMode) {
      const outgoing = activeViewportKey !== '' ? viewportStates.get(activeViewportKey) : undefined
      if (outgoing) viewportStates = new Map(viewportStates).set(nextKey, { ...outgoing })
    }
    vectorBrushPoints = []
    vectorEraserPoints = []
    pendingBrushPreviews = []
    vectorShapeDraft = undefined
    vectorShapeLastPoint = undefined
    vectorShapeLastModifiers = undefined
    vectorShapeDelegated = false
    // Retire any pending selected-shape hit: the target/costume/project
    // scope changed, so the stale resolve must never drag or draw.
    vectorShapeLiveGesture = undefined
    vectorHitGesture = undefined
    vectorShapeReleaseSeen = undefined
    pendingShapePreviews = []
    // A text draft belongs to the previous artwork; drop it without history.
    inlineText = undefined
    inlineTextCommitting = false
    inlineTextComposing = false
    // A loupe sample belongs to the previous artwork too; cancel the overlay
    // (colors stay untouched) so a stale cache can never tint the new canvas.
    eyedropperActive = false
    eyedropperHover = undefined
    eyedropperPressed = false
    lastEyedropperClient = undefined
    vectorEyedropperCache = undefined
    vectorEyedropperCacheKey = ''
    invalidateVectorEyedropperPending()
    // The fill hover snapshot also belongs to the previous artwork: drop the
    // overlay (live SVG untouched) and invalidate in-flight resolves.
    clearFillHoverPreview()
    fillHoverUnitsCache = null
    activeViewportKey = nextKey
    activeViewportSlot = slot
    activeViewportMode = costumeEditMode
    loadViewportState(nextKey)
  })

  $effect(() => {
    if (costumeEditMode === activeCostumeEditMode) return
    // Format switch: save the outgoing mode's viewport under its own key,
    // then load the incoming mode's state (or its Paper reset when first
    // visited). This keeps vector 0.2 and bitmap res2 0.5 independent.
    // First-fit guard: when the key-change effect above already moved
    // `activeViewportKey` onto the incoming mode key (combined costume +
    // mode switch, or a mode conversion whose key also changed), the
    // outgoing state was already saved there under the old key. Saving here
    // would store the freshly loaded reset fallback under the NEW key and
    // falsely mark it settled, blocking first-fit. Only save while still on
    // the outgoing key -- and only when that key is settled (F2: a pristine
    // placeholder must never become a saved value).
    const incomingModeKey = viewportStateKeyFor(baseViewportKey(), costumeEditMode)
    if (activeViewportKey !== incomingModeKey && activeViewportKey !== '' && viewportStates.has(activeViewportKey)) {
      saveViewportState()
    }
    // Do not carry a text draft across bitmap/vector conversion.
    inlineText = undefined
    inlineTextCommitting = false
    inlineTextComposing = false
    // Keep the eyedropper overlay across conversions (it works in both
    // modes) but drop the live sample; the vector cache refreshes below.
    eyedropperHover = undefined
    eyedropperPressed = false
    // Fill hover never survives a format conversion either.
    clearFillHoverPreview()
    switchToolForFormat(costumeEditMode)
    activeCostumeEditMode = costumeEditMode
    activeViewportKey = incomingModeKey
    loadViewportState(incomingModeKey)
  })

  $effect(() => {
    // First-visit fit (reference `shouldZoomToFit`/`zoomToFit` basis).
    // - Scoped gate (project + slot + mode, slot-stable -- see
    //   `scopedViewportKey`): when the key already has a saved state (prior
    //   fit, explicit reset, or user pan/zoom) we never touch it, so
    //   reselecting preserves the viewport. `setViewport` saves the fit and
    //   settles the key; a pre-fit user zoom settles first, so the delayed
    //   continuation finds the key settled and drops instead of clobbering
    //   the user (F2). Pristine keys hold no entry at all: revisits and
    //   replaced projects still run their fit.
    // - Viewport-only: only `viewportX/Y/Scale` + the saved-state map change.
    //   No VM write, no history capture, no drawing-data mutation.
    // - Async/race/target-switch: bitmap gates on the settled `bitmapFitState`
    //   owner (committed loads only; stale serial/revision never commits), and
    //   vector gates on the settled preview string. Both re-verify the key and
    //   artwork identity after `tick()` so a switch/undo/paint during the
    //   layout flush drops the stale fit. Undo/redo never refits: the slot
    //   key is unchanged and already settled, so later bounds updates for the
    //   same slot are ignored (no per-edit key fork, no map growth).
    // - Resize/mode conversion: the live container size is measured at fit
    //   time (explicit `canvas.clientWidth/Height` analogue); later resizes
    //   keep the viewport (no auto-refit). Density/mode flow through
    //   `activePaperDensity()` (vector 2.5 / res2 1.0 / res1 0.5; unknown
    //   fails closed to the legacy reset inside the helper).
    const mode = costumeEditMode
    const baseKey = viewportKey || `costume:${currentCostumeIndex}`
    const fitKey = viewportStateKeyFor(baseKey, mode)
    if (viewportStates.has(fitKey)) return
    if (mode === 'vector') {
      const seenSvg = currentCostumePreviewSvg ?? ''
      if (!seenSvg) return // cleared during switch; blank-SVG empty still fits to reset
      const seenObjects = Array.isArray(vectorObjects) ? [...vectorObjects] : []
      void (async () => {
        await tick()
        const curBase = viewportKey || `costume:${currentCostumeIndex}`
        const curKey = viewportStateKeyFor(curBase, costumeEditMode)
        if (curKey !== fitKey) return
        if (costumeEditMode !== 'vector') return
        if ((currentCostumePreviewSvg ?? '') !== seenSvg) return
        if (viewportStates.has(fitKey)) return
        const rect = viewportNode?.getBoundingClientRect()
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return
        const surface = { width: editSurfaceWidth(), height: editSurfaceHeight() }
        if (!(surface.width > 0) || !(surface.height > 0)) return
        const artLeft = vectorArtLeft()
        const artTop = vectorArtTop()
        const surfaceRects = seenObjects.map((object) => {
          const left = object.boundsX ?? object.x ?? 0
          const top = object.boundsY ?? object.y ?? 0
          const width = object.boundsWidth ?? object.width ?? 0
          const height = object.boundsHeight ?? object.height ?? 0
          if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
            return undefined
          }
          return {
            x: artLeft + left * VECTOR_WORKSPACE_SCALE,
            y: artTop + top * VECTOR_WORKSPACE_SCALE,
            width: width * VECTOR_WORKSPACE_SCALE,
            height: height * VECTOR_WORKSPACE_SCALE,
          }
        })
        const union = unionFitRects(surfaceRects)
        const density = VECTOR_PAPER_TO_CSS_DENSITY
        const result = resolveInitialFitViewport({
          contentBoundsSurface: union,
          surfaceSize: surface,
          containerSize: { width: rect.width, height: rect.height },
          paperToCssDensity: density,
          isBitmap: false,
        })
        if (!result.viewport) return
        // Post-fit workspace clamp (reference `zoomToFit` tail:
        // center/zoom then clampViewBounds). The fit centering is
        // authoritative (existing tests pin <2px exact): the workspace covers
        // the fit view itself (clipEmpty=false, like pan), so only the
        // expanded-MAX edge can still clamp (huge/offboard). A clipped
        // workspace (clipEmpty=true) would shift small edge fits off-center
        // (e.g. 100x100 at SVG top-left needs -51..251 vs board 0..960);
        // that shift is deliberately NOT applied here (現状維持, 明記).
        // Viewport-only, no data writes; the save settles the key (F2).
        setViewportWithPaperClamp(result.viewport.x, result.viewport.y, result.viewport.scale, false)
      })()
      return
    }
    // Bitmap: settled owner only (committed load for this costume slot).
    // Primary: the Editor-published `bitmapFitState` (committed loads only;
    // stale serial/revision never commits). Fallback: a live-canvas scan for
    // conversions that commit the workspace owner WITHOUT publishing a fit
    // state (vector->bitmap convert draws directly and skips the reload path,
    // so `bitmapFitState` stays absent/stale and the primary gate never fires;
    // the viewport would sit at the 0.5 reset until the next Undo reload
    // publishes bounds and jumps to ~1.2).
    // State design (deliberately NOT `canRedo`):
    // - `canRedo` is global history, not per-slot scope: gating first-fit on
    //   it would block the legitimate first fit of a newly selected costume
    //   (or an empty-costume Undo revisit) just because an unrelated slot left
    //   a redo entry. Scope stays per-slot in `viewportStates` presence (F2):
    //   settled keys never refit (same-slot paint/save/Undo/Redo preserved),
    //   pristine keys always fit regardless of the global redo flag.
    // - Fallback runs only while the Editor reports the workspace settled
    //   (`!bitmapWorkspaceBusy && !bitmapDestructiveDisabled`): an in-flight
    //   reload (switch/Undo/Redo/new asset pending) must never settle the key
    //   with the stale canvas. A pre-fit user zoom/wheel already settles via
    //   `setViewport`, and a pre-fit paint gesture settles in
    //   `handleCanvasPointerDown`, so both delayed continuations find the key
    //   settled and drop instead of clobbering the user.
    // - Honke parity: Scratch `zoomToFit(isBitmap=true)` fits the opaque hit
    //   bounds (`getHitBounds(getRaster())`), not the placed source rect; the
    //   fallback scans the same alpha!==0 rect read-only (no VM/history/data
    //   write). Empty/unreadable scans publish null => base reset, same as the
    //   load path. Project switch remounts (fresh map => fresh fit), mode
    //   conversion keeps each side's own key, resize only clamps (no refit).
    const seenFit = bitmapFitState
    const seenSlotMatches = !!seenFit && `${seenFit.targetId}:${seenFit.index}` === baseKey
    if (!seenSlotMatches) {
      // No authoritative bounds for this slot (conversion path): fit from the
      // live settled canvas instead of waiting for the next Undo reload.
      if (bitmapWorkspaceBusy || bitmapDestructiveDisabled) return
      const fallbackCanvas = bitmapCanvas
      if (!fallbackCanvas) return
      const fallbackWidth = bitmapCanvasWidth
      const fallbackHeight = bitmapCanvasHeight
      if (!(fallbackWidth > 0) || !(fallbackHeight > 0)) return
      const fallbackDensityInput = bitmapResolution
      void (async () => {
        await tick()
        const curBase = viewportKey || `costume:${currentCostumeIndex}`
        const curKey = viewportStateKeyFor(curBase, costumeEditMode)
        if (curKey !== fitKey) return
        if (costumeEditMode !== 'bitmap') return
        // The authoritative state may have arrived while we waited: let the
        // primary path own the fit instead of settling twice.
        const curFit = bitmapFitState
        if (curFit && `${curFit.targetId}:${curFit.index}` === curBase) return
        if (bitmapWorkspaceBusy || bitmapDestructiveDisabled) return
        if (viewportStates.has(fitKey)) return
        if (bitmapCanvas !== fallbackCanvas) return
        if (bitmapCanvasWidth !== fallbackWidth || bitmapCanvasHeight !== fallbackHeight) return
        if (bitmapResolution !== fallbackDensityInput) return
        const rect = viewportNode?.getBoundingClientRect()
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return
        const surface = { width: fallbackWidth, height: fallbackHeight }
        let bounds: { x: number; y: number; width: number; height: number } | null = null
        try {
          const scanned = scanBitmapOpaqueBounds(fallbackCanvas)
          if (scanned && scanned.width > 0 && scanned.height > 0) {
            bounds = { x: scanned.x, y: scanned.y, width: scanned.width, height: scanned.height }
          }
        } catch {
          bounds = null
        }
        const density = densityForBitmapStoredResolution(fallbackDensityInput)
        const result = resolveInitialFitViewport({
          contentBoundsSurface: bounds,
          surfaceSize: surface,
          containerSize: { width: rect.width, height: rect.height },
          paperToCssDensity: density,
          isBitmap: true,
        })
        if (!result.viewport) return
        // Post-fit workspace clamp (same fit-centering contract as vector:
        // clipEmpty=false covers the fit view, only expanded-MAX clamps).
        // Viewport-only; unknown keeps the legacy reset (no clamp, 明記).
        setViewportWithPaperClamp(result.viewport.x, result.viewport.y, result.viewport.scale, false)
      })()
      return
    }
    const seenDensityInput = bitmapResolution
    void (async () => {
      await tick()
      const curBase = viewportKey || `costume:${currentCostumeIndex}`
      const curKey = viewportStateKeyFor(curBase, costumeEditMode)
      if (curKey !== fitKey) return
      if (costumeEditMode !== 'bitmap') return
      if (bitmapFitState !== seenFit) return
      if (viewportStates.has(fitKey)) return
      const rect = viewportNode?.getBoundingClientRect()
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return
      const surface = { width: seenFit.surfaceWidth, height: seenFit.surfaceHeight }
      if (!(surface.width > 0) || !(surface.height > 0)) return
      const density = densityForBitmapStoredResolution(seenDensityInput)
      const result = resolveInitialFitViewport({
        contentBoundsSurface: seenFit.bounds,
        surfaceSize: surface,
        containerSize: { width: rect.width, height: rect.height },
        paperToCssDensity: density,
        isBitmap: true,
      })
      if (!result.viewport) return
      // Post-fit workspace clamp (same fit-centering contract as vector:
      // clipEmpty=false covers the fit view, only expanded-MAX clamps).
      // Viewport-only; unknown keeps the legacy reset (no clamp, 明記).
      setViewportWithPaperClamp(result.viewport.x, result.viewport.y, result.viewport.scale, false)
    })()
  })

  // Fill hover clear paths (each only resets overlay state; the live
  // artwork / history are untouched). These effects deliberately never read
  // the preview state itself: reading it would re-trigger the effect when a
  // new preview lands and immediately clear what was just set.
  // - selection change (hover never targets the selection),
  // - paint change (the snapshot would show a stale color),
  // - artwork change (commit / undo / redo / costume switch swap the units),
  // - fill tool / eyedropper / text-draft transitions.
  $effect(() => {
    // Track selection + tool + mode + overlay flags as clear triggers.
    void selectedVectorObjectIndex
    void selectedVectorObjectIndices
    void vectorTool
    void costumeEditMode
    void eyedropperActive
    void inlineText
    clearFillHoverPreview()
  })

  $effect(() => {
    // Track every paint input as a clear trigger. Reading them here keeps
    // the overlay honest: the next move rebuilds with the new paint instead
    // of showing a stale color.
    void paintColor
    void secondaryPaintColor
    void paintGradient
    void fillTransparent
    void secondaryTransparent
    void strokeColor
    void strokeSecondaryColor
    void strokeGradient
    void strokeTransparent
    void secondaryStrokeTransparent
    void strokeWidth
    void vectorOpacity
    clearFillHoverPreview()
  })

  $effect(() => {
    // Track the artwork string: commits, undo/redo, and costume switches all
    // swap it, and the cached units + snapshot belong to the previous text.
    void currentCostumePreviewSvg
    fillHoverUnitsCache = null
    clearFillHoverPreview()
  })

  // Escape clears the fill hover overlay without touching colors, selection,
  // history, or the artwork (the inline-text and eyedropper paths own Escape
  // while they are active, so this only runs when they do not).
  $effect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (fillHoverPreviewSvg === null && fillHoverPreviewKey === null) return
      event.stopPropagation()
      clearFillHoverPreview()
    }
    window.addEventListener('keydown', onWindowKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown, { capture: true })
    }
  })

  // Keep the vector raster cache warm in vector mode (not only while the
  // overlay is active): a new preview (paint, undo/redo) re-rasterizes so a
  // pick right after an edit rarely waits, a failure keeps the previous
  // cache, and leaving vector mode drops it to free memory.
  $effect(() => {
    if (costumeEditMode === 'vector') void refreshVectorEyedropperCache()
    if (!eyedropperActive && (eyedropperHover !== undefined || eyedropperPressed)) {
      eyedropperHover = undefined
      eyedropperPressed = false
      lastEyedropperClient = undefined
    }
  })

  // Eyedropper owns Escape in one key even when a swatch dialog stole focus:
  // the popover's bubble handler would otherwise close only the dialog and
  // leave the overlay armed (the Editor typing-target guard also skips the
  // cancel while focus sits in an input). Capture runs first, closes the
  // dialog and cancels together, and stops the bubble so the cancel lands
  // exactly once. Inline IME composition and the open text draft keep
  // priority: the textarea commits first and the key is never stolen mid-IME.
  $effect(() => {
    const onEyedropperEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!eyedropperActive) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (shouldDeferInlineTextKeyToIme(event, inlineTextComposing)) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('[data-inline-text-editor]')) return
      event.preventDefault()
      event.stopPropagation()
      closeStylePopover()
      cancelEyedropper()
    }
    window.addEventListener('keydown', onEyedropperEscape, { capture: true })
    return () => {
      window.removeEventListener('keydown', onEyedropperEscape, { capture: true })
    }
  })

  // Escape retires a pending selected-shape hit before the Editor clears the
  // selection: the stale resolve must neither resurrect the selection nor
  // start a move drag. Runs at capture so the retire lands synchronously
  // while the hit is still pending; inline-text and eyedropper own Escape
  // while active and are never disturbed here.
  $effect(() => {
    const onShapeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      cancelPendingVectorShapeHitForEscape()
    }
    window.addEventListener('keydown', onShapeEscape, { capture: true })
    return () => {
      window.removeEventListener('keydown', onShapeEscape, { capture: true })
    }
  })

  function vectorEyedropperOwnerFor(): string {
    return `${viewportKey || `costume:${currentCostumeIndex}`}:${costumeEditMode}`
  }

  function invalidateVectorEyedropperPending() {
    // Retire in-flight raster decodes so a stale resolve can never install
    // an accidental cache after an owner switch or overlay cancel.
    vectorEyedropperCachePending += 1
  }

  function toggleEyedropper(target: EyedropperTarget) {
    // Honke parity: the eyedropper lives inside the disabled color indicator
    // (`color-picker.jsx` inside the `pointer-events: none` group), so a
    // disabled side can neither open the picker nor switch to it — the stored
    // colors stay untouched.
    if (costumeEditMode === 'vector') {
      if (target === 'fill' && fillPaintDisabled) return
      if (target === 'stroke' && strokePaintDisabled) return
    }
    void flushHsvLive?.()
    if (eyedropperActive && eyedropperTarget === target) {
      eyedropperActive = false
      eyedropperHover = undefined
      eyedropperPressed = false
      lastEyedropperClient = undefined
      invalidateVectorEyedropperPending()
      return
    }
    eyedropperTarget = target
    eyedropperActive = true
    eyedropperHover = undefined
    eyedropperPressed = false
    // The picker lives inside the popover: activating it closes the dialog so
    // the loupe overlay has the canvas, while the stored tool survives.
    openStylePopover = null
    if (costumeEditMode === 'vector') void refreshVectorEyedropperCache()
  }

  function cancelEyedropper() {
    void flushHsvLive?.()
    eyedropperActive = false
    eyedropperHover = undefined
    eyedropperPressed = false
    lastEyedropperClient = undefined
    invalidateVectorEyedropperPending()
  }

  // Compare the complete source: even same-length SVGs can share a short hash
  // while rendering different pixels. Strings are immutable, so the retained
  // key also identifies the exact input used for an asynchronous rasterization.
  // No hashes are used anywhere on this path: exact-string equality decides.
  function vectorEyedropperCacheKeyFor(): string {
    return buildVectorEyedropperCacheKey(currentCostumePreviewSvg ?? '', vectorCanvasWidth, vectorCanvasHeight)
  }

  async function refreshVectorEyedropperCache(): Promise<boolean> {
    // Bounded gated refresh: the exact-string key is captured before the
    // async decode and compared again after the await. A mismatch means the
    // SVG/dims changed without a new refresh (held decode + same-length
    // external replacement, or an edit racing the raster): the stale raster
    // is discarded and the refresh retries bounded times. Serial + owner/mode
    // guards discard superseded or switched-away decodes without installing
    // an accidental cache.
    const maxAttempts = VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const key = vectorEyedropperCacheKeyFor()
      if (isVectorEyedropperKeyCurrent(key, vectorEyedropperCacheKey) && vectorEyedropperCache !== undefined) return true
      // Empty preview still records its key so the next press does not spin:
      // `rasterizeVectorPreview` returns undefined for empty markup and the
      // sampler then reports no cache (pick cancels, no VM edit).
      if (key === vectorEyedropperCacheKey) return true
      const seenSvg = currentCostumePreviewSvg ?? ''
      const seenWidth = vectorCanvasWidth
      const seenHeight = vectorCanvasHeight
      const seenOwner = vectorEyedropperOwnerFor()
      const seenMode = costumeEditMode
      const serial = ++vectorEyedropperCachePending
      const raster = await rasterizeVectorPreview(seenSvg, seenWidth, seenHeight)
      if (serial !== vectorEyedropperCachePending) return false
      if (costumeEditMode !== seenMode) return false
      if (vectorEyedropperOwnerFor() !== seenOwner) return false
      const currentKey = vectorEyedropperCacheKeyFor()
      if (!isVectorEyedropperKeyCurrent(key, currentKey)) continue
      vectorEyedropperCache = raster
      vectorEyedropperCacheKey = key
      // The hover may have arrived before the cache; recompute from the last
      // known cursor so the loupe appears without requiring another move.
      // Never repopulate after a cancel/switch: the guards above already
      // retired those decodes, and this rechecks the overlay liveness.
      if (raster && eyedropperActive && lastEyedropperClient && costumeEditMode === 'vector') {
        if (isVectorEyedropperKeyCurrent(vectorEyedropperCacheKey, vectorEyedropperCacheKeyFor())) {
          updateEyedropperHover(lastEyedropperClient)
        }
      }
      return true
    }
    return false
  }

  function readBitmapEyedropper(clientX: number, clientY: number) {
    const canvas = bitmapCanvas
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect) return undefined
    const location = eyedropperPixelFromClient(clientX, clientY, rect, canvas.width, canvas.height)
    if (!location.inside) return { inside: false as const, surfaceX: 0, surfaceY: 0, pixel: { r: 0, g: 0, b: 0, a: 0 }, pixels: new Uint8ClampedArray(0), blockSize: 0 }
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const [r, g, b, a] = context.getImageData(location.x, location.y, 1, 1).data
    const pixel = { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 0 }
    const source = loupeSourceRect(location.x, location.y, EYEDROPPER_LOUPE_RADIUS, canvas.width, canvas.height)
    let rows = new Uint8ClampedArray(0)
    if (source.sw > 0 && source.sh > 0) rows = context.getImageData(source.sx, source.sy, source.sw, source.sh).data
    const padded = padLoupePixels(rows, source, location.x, location.y, EYEDROPPER_LOUPE_RADIUS)
    return { inside: true as const, surfaceX: location.x, surfaceY: location.y, pixel, pixels: padded.data, blockSize: padded.size }
  }

  function readVectorEyedropper(clientX: number, clientY: number) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return undefined
    const artX = ((clientX - rect.left) / rect.width) * editSurfaceWidth()
    const artY = ((clientY - rect.top) / rect.height) * editSurfaceHeight()
    const localX = (artX - vectorArtLeft()) / VECTOR_WORKSPACE_SCALE
    const localY = (artY - vectorArtTop()) / VECTOR_WORKSPACE_SCALE
    if (!(localX >= 0) || !(localY >= 0) || localX >= vectorCanvasWidth || localY >= vectorCanvasHeight) {
      return { inside: false as const, surfaceX: 0, surfaceY: 0, pixel: { r: 0, g: 0, b: 0, a: 0 }, pixels: new Uint8ClampedArray(0), blockSize: 0 }
    }
    const cache = vectorEyedropperCache
    if (!cache) return undefined
    const context = cache.canvas.getContext('2d')
    if (!context) return undefined
    const cacheX = Math.floor(localX * cache.scale)
    const cacheY = Math.floor(localY * cache.scale)
    if (cacheX < 0 || cacheY < 0 || cacheX >= cache.canvas.width || cacheY >= cache.canvas.height) {
      return { inside: false as const, surfaceX: 0, surfaceY: 0, pixel: { r: 0, g: 0, b: 0, a: 0 }, pixels: new Uint8ClampedArray(0), blockSize: 0 }
    }
    const [r, g, b, a] = context.getImageData(cacheX, cacheY, 1, 1).data
    const radius = Math.max(1, Math.round(EYEDROPPER_LOUPE_RADIUS * cache.scale / VECTOR_WORKSPACE_SCALE))
    const source = loupeSourceRect(cacheX, cacheY, radius, cache.canvas.width, cache.canvas.height)
    let rows = new Uint8ClampedArray(0)
    if (source.sw > 0 && source.sh > 0) rows = context.getImageData(source.sx, source.sy, source.sw, source.sh).data
    const resampled = resampleLoupeBlock(rows, source, cacheX, cacheY, radius, cache.canvas.width, cache.canvas.height)
    const surfaceX = vectorArtLeft() + localX * VECTOR_WORKSPACE_SCALE
    const surfaceY = vectorArtTop() + localY * VECTOR_WORKSPACE_SCALE
    return { inside: true as const, surfaceX, surfaceY, pixel: { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 0 }, pixels: resampled.data, blockSize: resampled.size }
  }

  // Nearest-neighbor resample of a cache-scale neighborhood down to the shared
  // loupe grid. Output cell (x, y) maps to the ideal (unclamped) source pixel
  // `center - radius + floor(cell / diameter * radius * 2)`; positions outside
  // the artwork stay transparent padding so edges keep a stable loupe size.
  function resampleLoupeBlock(
    rows: Uint8ClampedArray,
    source: { sx: number; sy: number; sw: number; sh: number },
    centerX: number,
    centerY: number,
    radius: number,
    artworkWidth: number,
    artworkHeight: number,
  ) {
    const diameter = EYEDROPPER_LOUPE_RADIUS * 2
    const padded = new Uint8ClampedArray(diameter * diameter * 4)
    const span = Math.max(1, radius) * 2
    if (source.sw <= 0 || source.sh <= 0) return { data: padded, size: diameter }
    for (let y = 0; y < diameter; y += 1) {
      for (let x = 0; x < diameter; x += 1) {
        const srcX = centerX - Math.max(1, radius) + Math.floor((x / diameter) * span)
        const srcY = centerY - Math.max(1, radius) + Math.floor((y / diameter) * span)
        if (srcX < 0 || srcY < 0 || srcX >= artworkWidth || srcY >= artworkHeight) continue
        const blockX = srcX - source.sx
        const blockY = srcY - source.sy
        if (blockX < 0 || blockY < 0 || blockX >= source.sw || blockY >= source.sh) continue
        const from = (blockY * source.sw + blockX) * 4
        const to = (y * diameter + x) * 4
        padded[to] = rows[from] ?? 0
        padded[to + 1] = rows[from + 1] ?? 0
        padded[to + 2] = rows[from + 2] ?? 0
        padded[to + 3] = rows[from + 3] ?? 0
      }
    }
    return { data: padded, size: diameter }
  }

  function updateEyedropperHover(event: { clientX: number; clientY: number }) {
    if (!eyedropperActive) return false
    const sample = costumeEditMode === 'bitmap' ? readBitmapEyedropper(event.clientX, event.clientY) : readVectorEyedropper(event.clientX, event.clientY)
    if (!sample) {
      eyedropperHover = undefined
      return false
    }
    if (!sample.inside) {
      eyedropperHover = undefined
      return false
    }
    eyedropperHover = { surfaceX: sample.surfaceX, surfaceY: sample.surfaceY, clientX: event.clientX, clientY: event.clientY, pixel: sample.pixel, inside: true, pixels: sample.pixels, blockSize: sample.blockSize }
    return true
  }

  function eyedropperLoupeLayout() {
    const hover = eyedropperHover
    if (!eyedropperActive || !hover?.inside) return undefined
    // Reference loupe centers on the cursor in screen px and overlays outside
    // the artwork: no clamping to the surface. Fixed positioning (outside the
    // scaled surface) keeps the CSS size constant across zoom and escapes the
    // viewport overflow clip at artwork edges. pointer-events:none preserves
    // click capture. Sampling/alpha behavior is unchanged.
    const cssSize = EYEDROPPER_LOUPE_CANVAS_SIZE
    // The 1px circular border (content-box) adds 1px per side: offset by an
    // extra 1px so both the content disc and the outer border stay centered
    // on the cursor in screen px.
    const left = hover.clientX - cssSize / 2 - 1
    const top = hover.clientY - cssSize / 2 - 1
    const color = eyedropperCss(hover.pixel)
    return { left, top, cssSize, canvasSize: EYEDROPPER_LOUPE_CANVAS_SIZE, pixels: hover.pixels, blockSize: hover.blockSize, ringColor: color, centerColor: color }
  }

  let loupeLayout = $derived(eyedropperLoupeLayout())

  function updateEraserCursor(event: PointerEvent) {
    const rect = editSurfaceNode?.getBoundingClientRect()
    const viewport = viewportNode?.getBoundingClientRect()
    if (!rect || !viewport || event.clientX < viewport.left || event.clientX >= viewport.right || event.clientY < viewport.top || event.clientY >= viewport.bottom || event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) {
      eraserCursor = undefined
      return
    }
    const x = (event.clientX - rect.left) * editSurfaceWidth() / rect.width
    const y = (event.clientY - rect.top) * editSurfaceHeight() / rect.height
    eraserCursor = costumeEditMode === 'bitmap' ? { x: Math.trunc(x), y: Math.trunc(y) } : { x, y }
  }

  function handleCanvasPointerLeave() {
    eraserCursor = undefined
    if (!eyedropperPressed) eyedropperHover = undefined
    // Leaving the surface drops the fill hover overlay (live SVG untouched)
    // and invalidates in-flight resolves so nothing paints after the leave.
    clearFillHoverPreview()
  }

  function isCanvasPrimaryPointerDown(event: PointerEvent) {
    if (activeCanvasPointerId !== undefined) return false
    // Touch contact reports button -1, so gate on the pointer type instead of
    // `button === 0`. Mouse secondary buttons (middle/right) and non-primary
    // pen buttons (barrel/eraser) still report a non-zero button and must not
    // start a stroke; primary pen contact (button 0) keeps working.
    if (event.pointerType === 'touch') return true
    return event.button === 0
  }

  function handleCanvasPointerDown(event: PointerEvent) {
    if (!isCanvasPrimaryPointerDown(event)) return
    // Clicks inside the inline text overlay belong to the textarea, not the
    // canvas gesture handlers. Clicking outside commits the draft (Scratch
    // TEXT_EDIT_MODE parity: clicking away ends text editing).
    if ((event.target as HTMLElement).closest?.('[data-inline-text-editor]')) return
    // A pending draft resolves first: commit it (or keep it on failure) and
    // let the next click start a fresh gesture, so one click never writes two
    // history entries.
    if (inlineText) {
      void commitInlineText()
      return
    }
    // Clicking the viewport background (outside the artwork) cancels the
    // picker without touching colors, matching the reference mouse-up-outside
    // behavior. This must run before the contains-guard below, which would
    // otherwise swallow the gesture entirely.
    if (eyedropperActive && !editSurfaceNode?.contains(event.target as Node)) {
      cancelEyedropper()
      return
    }
    // Tail click of a double-click that started as a pick: the first press
    // already committed, so the second press (detail > 1) must not paint a
    // dot. Time-boxed so normal rapid painting is never affected.
    if (!eyedropperActive && lastEyedropperCommitAt > 0 && Date.now() - lastEyedropperCommitAt < 500 && event.detail > 1) {
      return
    }
    if (!editSurfaceNode?.contains(event.target as Node)) return
    if ((event.target as HTMLElement).closest('[data-vector-object]')) return
    // The floating-scale/rotate handles own their own pointer flow (capture on
    // the button, Editor-side session); the generic canvas gesture must ignore
    // them like the vector resize handles.
    if ((event.target as HTMLElement).closest('[data-bitmap-floating-handle]')) return
    if ((event.target as HTMLElement).closest('[data-bitmap-floating-rotate-handle]')) return
    // Same-slot user-gesture settle: a paint/select gesture starting before the
    // delayed first-fit continuation runs settles the pristine key with the
    // live (reset) viewport, so the continuation finds the key settled and
    // drops instead of jumping mid-stroke. Honke fits synchronously before any
    // paint; this only covers the async-tick interleaving window. Viewport
    // pan/zoom already settles via `setViewport`; this covers paint/select
    // starts. Never touches history/data: viewport-only.
    if (activeViewportKey !== '' && !viewportStates.has(activeViewportKey)) saveViewportState()
    activeCanvasPointerId = event.pointerId
    if (costumeEditMode === 'bitmap' && bitmapTool === 'eraser') eraserCursor = undefined
    else updateEraserCursor(event)
    try {
      viewportNode?.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is best-effort (touch re-parenting can reject it);
      // the drag still tracks by the active pointer id.
    }
    handleCanvasMouseDown(event)
  }

  function handleCanvasPointerMove(event: PointerEvent) {
    // The loupe follows the pointer even without buttons pressed (like the
    // reference picker loop); painting gestures still need the pointer id.
    if (eyedropperActive) {
      lastEyedropperClient = { clientX: event.clientX, clientY: event.clientY }
      updateEyedropperHover(event)
    }
    if (!(costumeEditMode === 'bitmap' && activeCanvasPointerId !== undefined) && !eyedropperActive) updateEraserCursor(event)
    else if (eyedropperActive) eraserCursor = undefined
    if (activeCanvasPointerId === event.pointerId) handleCanvasMouseMove(event)
    // Fill hover preview: pointermove only (mouseover/out bubble per child
    // and miss moves inside one shape), no buttons pressed, fill tool only.
    // The point mapping matches the click commit (`vectorPointFromEvent`);
    // resolution is async with stale-result drops, so rapid moves never show
    // an outdated target.
    if (event.buttons !== 0 || activeCanvasPointerId !== undefined) return
    if (!isVectorFillHoverActive()) {
      if (fillHoverPreviewSvg !== null) clearFillHoverPreview()
      return
    }
    const hoverPoint = vectorPointFromEvent(event)
    if (!hoverPoint) {
      clearFillHoverPreview()
      return
    }
    void requestVectorFillHover(hoverPoint)
  }

  function handleCanvasPointerUp(event: PointerEvent) {
    if (activeCanvasPointerId !== event.pointerId) return
    const finishedPointerId = event.pointerId
    activeCanvasPointerId = undefined
    if (event.type === 'pointerup') updateEraserCursor(event)
    else eraserCursor = undefined
    try {
      if (viewportNode?.hasPointerCapture(finishedPointerId)) viewportNode.releasePointerCapture(finishedPointerId)
    } catch {
      // Releasing capture is best-effort; the gesture state is already reset.
    }
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
      // Genuine capture loss cancels the live selected-shape gesture: retire
      // its token synchronously so the stale hit resolve (still awaiting the
      // gated VM load) can never commit. The implicit auto-loss trailing a
      // normal pointerup must NOT cancel the commit (or the next gesture):
      // a gesture that already saw its pointerup is settling, so its trailing
      // loss is ignored here and the normal end path owns the verdict.
      if (event.type === 'lostpointercapture' && vectorShapeReleaseSeen !== undefined && vectorShapeReleaseSeen === vectorShapeLiveGesture) {
        return
      }
      if (costumeEditMode === 'vector' && (vectorHitPromise || vectorShapeDelegated || vectorShapeDraft)) {
        // Retire only the currently live gesture; a newer press mints a new
        // id afterwards and is never affected by this old cancel.
        vectorShapeLiveGesture = undefined
        vectorHitGesture = undefined
        vectorShapeDelegated = false
        vectorShapeDraft = undefined
        vectorShapeLastPoint = undefined
        vectorShapeLastModifiers = undefined
        if (discardCancelledVectorGesture()) return
        // Pending-hit cancel is fully handled by the token retire above: the
        // awaiting release drops via its post-await token check without
        // calling `endVectorObjectDrag`, so no move commits and no history
        // entry is written. Never fall through to the commit path here.
        if (vectorTool === 'rect' || vectorTool === 'oval') return
      }
      if (discardCancelledVectorGesture()) return
      // Bitmap strokes cancel through `endBitmapPaint`'s pointercancel guard
      // (pre-stroke snapshot restore, no history — vector parity), and vector
      // object drags need the Editor-side session to finish, so those keep
      // the normal end path to avoid a stuck preview.
      void handleCanvasMouseUp(event)
      return
    }
    if (event.type === 'pointerup' && costumeEditMode === 'vector' && (vectorTool === 'rect' || vectorTool === 'oval')) {
      // Claim synchronously: the trailing implicit `lostpointercapture`
      // auto-loss after this release must not cancel the settling gesture.
      vectorShapeReleaseSeen = vectorShapeLiveGesture
    }
    void handleCanvasMouseUp(event)
  }

  function discardCancelledVectorGesture() {
    // An interrupted vector gesture (touchCancel, browser takeover) discards
    // the local draft without writing history. Returns true when the cancel
    // was fully handled here. The eyedropper overlay survives (pressed reset
    // only, no commit).
    if (eyedropperActive) eyedropperPressed = false
    if (costumeEditMode !== 'vector') return eyedropperActive
    if (eyedropperActive) {
      vectorMarquee = undefined
      vectorBrushPoints = []
      vectorEraserPoints = []
      vectorShapeDraft = undefined
      vectorShapeLastPoint = undefined
      vectorShapeLastModifiers = undefined
      return true
    }
    // A pending selected-shape hit retired by its token (pointercancel /
    // genuine lostpointercapture / Escape / scope switch) is already fully
    // handled: the awaiting release drops without committing, so report
    // handled here and never route through `endVectorObjectDrag`. An
    // initialized delegated move is aborted the same way (local draft
    // cleared, no commit); with the hit window gated no live preview exists
    // yet, so there is nothing to restore beyond the local state.
    if ((vectorTool === 'rect' || vectorTool === 'oval') && vectorHitPromise === undefined && vectorHitGesture === undefined) {
      if (vectorShapeDraft || vectorShapeLastPoint) {
        vectorMarquee = undefined
        vectorBrushPoints = []
        vectorEraserPoints = []
        vectorShapeDraft = undefined
        vectorShapeLastPoint = undefined
        vectorShapeLastModifiers = undefined
        vectorShapeDelegated = false
        return true
      }
    }
    // A still-live pending hit test (or an active delegated move) must settle
    // through the normal end path (select parity): discarding here would
    // strand an `endVectorObjectDrag` that owns the live preview.
    if (vectorHitPromise || vectorShapeDelegated) return false
    if (vectorTool === 'brush' || vectorTool === 'eraser' || vectorTool === 'rect' || vectorTool === 'oval' || vectorTool === 'line' || vectorMarquee) {
      vectorMarquee = undefined
      vectorBrushPoints = []
      vectorEraserPoints = []
      vectorShapeDraft = undefined
      vectorShapeLastPoint = undefined
      vectorShapeLastModifiers = undefined
      return true
    }
    return false
  }

  /** Escape retires a pending selected-shape hit without touching artwork/history. */
  function cancelPendingVectorShapeHitForEscape() {
    if (costumeEditMode !== 'vector') return
    if (eyedropperActive || inlineText) return
    if (vectorTool !== 'rect' && vectorTool !== 'oval') return
    if (vectorHitPromise === undefined && !vectorShapeDelegated && !vectorShapeDraft) return
    vectorShapeLiveGesture = undefined
    vectorHitGesture = undefined
    vectorShapeDelegated = false
    vectorShapeDraft = undefined
    vectorShapeLastPoint = undefined
    vectorShapeLastModifiers = undefined
  }

  function handleCanvasMouseDown(event: MouseEvent) {
    // Text keeps priority over the picker: an open draft commits first and
    // one gesture never writes two history entries (commit + pick).
    if (eyedropperActive && !inlineText) {
      if (!editSurfaceNode?.contains(event.target as Node)) {
        cancelEyedropper()
        return
      }
      if ((event.target as HTMLElement).closest('[data-vector-object]')) return
      eyedropperPressed = true
      updateEyedropperHover(event)
      return
    }
    if (costumeEditMode === 'bitmap') {
      // Bitmap text opens a focused overlay at the click point and rasterizes
      // once on commit, instead of stamping the toolbar string immediately.
      if (bitmapTool === 'text') {
        const bitmapPoint = bitmapPointFromEvent(event)
        if (bitmapPoint) openBitmapInlineText(bitmapPoint)
        return
      }
      return beginBitmapPaint(event)
    }
    if (costumeEditMode === 'vector') {
      if ((event.target as HTMLElement).closest('[data-vector-object]')) return
      const point = vectorPointFromEvent(event)
      if (!point) return
      if (vectorTool === 'select' || vectorTool === 'reshape') {
        // Start a provisional marquee, then hit-test the drawn shapes like
        // scratch-paint's select tool. A hit hands control to the object drag
        // and discards the marquee; a miss keeps the marquee for drag selection.
        vectorMarquee = { start: point, current: point, append: event.shiftKey || event.metaKey || event.ctrlKey }
        const surfaceRect = editSurfaceNode?.getBoundingClientRect()
        const dragScale = surfaceRect ? Math.min(surfaceRect.width / vectorCanvasWidth, surfaceRect.height / vectorCanvasHeight) : 1
        vectorHitPromise = Promise.resolve(beginVectorObjectDragAtPoint?.(point, event as PointerEvent, dragScale)).then(
          (hit) => {
            vectorHitPromise = undefined
            if (hit) vectorMarquee = undefined
            return hit
          },
          () => {
            vectorHitPromise = undefined
            return false
          },
        )
        return
      }
      if (vectorTool === 'brush') {
        const brushPoint = vectorBrushPointFromEvent(event)
        if (brushPoint) vectorBrushPoints = [brushPoint]
        return
      }
      if (vectorTool === 'fill') {
        // The click commits through Editor.svelte (one history entry on
        // change, none on no-op); the overlay must go first so a stale
        // snapshot never lingers over the committed paint. The artwork and
        // selection effects below clear again when the commit lands.
        clearFillHoverPreview()
        return fillVectorObjectAtPoint(point)
      }
      if (vectorTool === 'eraser') {
        const eraserPoint = vectorBrushPointFromEvent(event)
        if (eraserPoint) vectorEraserPoints = [eraserPoint]
        return
      }
      if (vectorTool === 'rect' || vectorTool === 'oval') {
        const shapePoint = vectorBrushPointFromEvent(event)
        if (shapePoint) {
          // Narrow once for the async continuations below (reactive
          // `vectorTool` narrowing does not survive into closures).
          const shape = vectorTool
          // Reference parity (rect/oval `BoundingBoxTool` first): a press
          // that hits the live selection starts a move drag under the same
          // tool; only a miss clears and draws a fresh shape. The selection
          // set is read synchronously so a target/costume switch racing the
          // async hit test falls back to a fresh shape instead of dragging a
          // stale index (the drag starter re-checks membership on resolve).
          // A delete can also leave the scalar index pointing at a removed
          // object while the array is already empty (e.g. an input-focused
          // select-all never touched the canvas selection, so only the
          // deleted rect was removed): filter to live objects so the press
          // falls through to a fresh shape instead of a ghost hit test that
          // never commits.
          const allowed = (
            selectedVectorObjectIndices.length > 0
              ? [...selectedVectorObjectIndices]
              : selectedVectorObjectIndex >= 0
                ? [selectedVectorObjectIndex]
                : []
          ).filter((index) => vectorObjects.some((object: VectorObjectInfo) => object.index === index))
          if (allowed.length > 0 && beginVectorSelectedDragAtPoint) {
            const pressModifiers = readShapeModifiers(event)
            const surfaceRect = editSurfaceNode?.getBoundingClientRect()
            const dragScale = surfaceRect
              ? Math.min(surfaceRect.width / vectorCanvasWidth, surfaceRect.height / vectorCanvasHeight)
              : 1
            // Mint a fresh generation: any older pending hit (or its awaiting
            // release) is now stale and must never touch state. A cancel that
            // retired the previous gesture never affects this new id.
            vectorShapeGestureSeq += 1
            const shapeGesture = vectorShapeGestureSeq
            vectorShapeLiveGesture = shapeGesture
            vectorHitGesture = shapeGesture
            vectorShapeReleaseSeen = undefined
            vectorShapeLastPoint = shapePoint
            vectorShapeLastModifiers = pressModifiers
            vectorShapeDelegated = false
            vectorHitPromise = Promise.resolve(
              beginVectorSelectedDragAtPoint?.(shapePoint, event as PointerEvent, dragScale, allowed),
            ).then(
              (hit) => {
                // Stale resolve (cancel / Escape / switch / next press won the
                // race): never move, never clear, never draft, never resurrect.
                if (shapeGesture !== vectorShapeLiveGesture || shapeGesture !== vectorHitGesture) return false
                vectorHitPromise = undefined
                vectorHitGesture = undefined
                if (hit) {
                  vectorShapeDelegated = true
                  vectorShapeLastPoint = undefined
                  return true
                }
                // Miss (blank canvas, unselected shape, or bbox corner
                // outside an ellipse): clear first, then draw from the
                // latest pointer so pre-resolve moves are not lost.
                // Pressing on empty canvas with a shape tool clears the
                // selection; a miss-drag then selects only the new shape
                // on commit.
                clearVectorObjectSelection?.()
                vectorShapeDraft = {
                  shape,
                  start: shapePoint,
                  current: vectorShapeLastPoint ?? shapePoint,
                  modifiers: vectorShapeLastModifiers ?? pressModifiers,
                }
                vectorShapeLastPoint = undefined
                return false
              },
              () => {
                if (shapeGesture !== vectorShapeLiveGesture || shapeGesture !== vectorHitGesture) return false
                vectorHitPromise = undefined
                vectorHitGesture = undefined
                clearVectorObjectSelection?.()
                vectorShapeDraft = {
                  shape,
                  start: shapePoint,
                  current: vectorShapeLastPoint ?? shapePoint,
                  modifiers: vectorShapeLastModifiers ?? pressModifiers,
                }
                vectorShapeLastPoint = undefined
                return false
              },
            )
            return
          }
          // No live selection: reference clears (no-op) and draws. A fresh
          // immediate draft still retires any older pending hit so its late
          // resolve can never clear this new draft.
          vectorShapeGestureSeq += 1
          vectorShapeLiveGesture = vectorShapeGestureSeq
          vectorHitGesture = undefined
          vectorShapeReleaseSeen = undefined
          clearVectorObjectSelection?.()
          vectorShapeDraft = { shape, start: shapePoint, current: shapePoint, modifiers: readShapeModifiers(event) }
        }
        return
      }
      if (vectorTool === 'line') {
        const shapePoint = vectorBrushPointFromEvent(event)
        if (shapePoint) {
          // Reference parity: pressing on empty canvas with a shape tool
          // clears the selection; a miss-drag then selects only the new
          // shape on commit, while a click restores nothing.
          clearVectorObjectSelection?.()
          vectorShapeDraft = { shape: vectorTool, start: shapePoint, current: shapePoint, modifiers: readShapeModifiers(event) }
        }
        return
      }
      const x = point.x
      const y = point.y
      // Vector text opens a focused inline editor at the click point (or
      // re-opens the clicked text item) instead of stamping the toolbar
      // string; commit writes history exactly once.
      if (vectorTool === 'text') {
        void openVectorInlineText({ x: Math.max(0, Math.min(vectorCanvasWidth, x)), y: Math.max(0, Math.min(vectorCanvasHeight, y)) })
        return
      }
      return saveVectorCostume({ x: Math.max(0, Math.min(vectorCanvasWidth, x)), y: Math.max(0, Math.min(vectorCanvasHeight, y)) })
    }
  }

  function handleCanvasMouseMove(event: MouseEvent) {
    // Drag updates the loupe live (touch parity: slide to the right pixel,
    // release to commit); painting stays disabled under the overlay.
    if (eyedropperActive) {
      updateEyedropperHover(event)
      return
    }
    if (costumeEditMode === 'bitmap') paintBitmap(event)
    // Retained shape tools (rect/oval) route object moves through the same
    // drag as select: the call no-ops without an active drag, so drawing
    // drafts are unaffected.
    if (costumeEditMode === 'vector' && (vectorTool === 'select' || vectorTool === 'reshape' || vectorTool === 'rect' || vectorTool === 'oval')) {
      dragVectorObject?.(event as unknown as PointerEvent)
    }
    if (costumeEditMode === 'vector' && vectorMarquee) {
      const point = vectorPointFromEvent(event)
      if (point) vectorMarquee = { ...vectorMarquee, current: point }
    }
    if (costumeEditMode === 'vector' && vectorTool === 'brush' && vectorBrushPoints.length > 0) {
      const point = vectorBrushPointFromEvent(event)
      if (point) vectorBrushPoints = [...vectorBrushPoints, point]
    }
    if (costumeEditMode === 'vector' && vectorTool === 'eraser' && vectorEraserPoints.length > 0) {
      const point = vectorBrushPointFromEvent(event)
      if (point) vectorEraserPoints = [...vectorEraserPoints, point]
    }
    if (costumeEditMode === 'vector' && vectorShapeDraft) {
      const point = vectorBrushPointFromEvent(event)
      if (point) vectorShapeDraft = { ...vectorShapeDraft, current: point, modifiers: readShapeModifiers(event) }
    }
    // While a retained shape-tool hit test is still pending, track the
    // latest pointer so the miss fallback draws from here (not the press).
    // Stale gestures (retired by cancel/Escape/switch/next press) never
    // overwrite the live tracking.
    if (costumeEditMode === 'vector' && (vectorTool === 'rect' || vectorTool === 'oval') && vectorHitPromise && !vectorShapeDraft) {
      if (vectorHitGesture !== undefined && vectorHitGesture === vectorShapeLiveGesture) {
        const point = vectorBrushPointFromEvent(event)
        if (point) {
          vectorShapeLastPoint = point
          vectorShapeLastModifiers = readShapeModifiers(event)
        }
      }
    }
  }

  async function handleCanvasMouseUp(event: MouseEvent) {
    if (eyedropperActive) {
      // pointercancel / lostpointercapture never commits a pick (vector
      // parity: the overlay survives with pressed reset, no color write).
      if ((event as PointerEvent)?.type === 'pointercancel' || (event as PointerEvent)?.type === 'lostpointercapture') {
        eyedropperPressed = false
        return
      }
      const pressed = eyedropperPressed
      eyedropperPressed = false
      if (!pressed) return
      // A pick immediately after an edit can outrun the raster cache; wait
      // for it here so the release always samples the current artwork. A
      // present-but-stale cache (key mismatch after delete/draw/undo) must
      // also refresh: sampling it would commit the previous artwork instead
      // of merely cancelling on a cache that is in flight.
      // Race gate: the preview may change DURING the await (held decode +
      // same-length external replacement, or a selection-target switch while
      // armed). Re-verify the exact-string key after every await and retry
      // bounded times; on a persistent mismatch discard the pick with no
      // stale sample, no wrong preview, and no VM edit.
      if (costumeEditMode === 'vector') {
        let fresh =
          vectorEyedropperCache !== undefined &&
          isVectorEyedropperKeyCurrent(vectorEyedropperCacheKey, vectorEyedropperCacheKeyFor())
        if (!fresh) {
          for (let attempt = 0; attempt < VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS; attempt += 1) {
            if (!eyedropperActive) return
            if (costumeEditMode !== 'vector') return
            const refreshed = await refreshVectorEyedropperCache()
            if (!eyedropperActive) return
            if (costumeEditMode !== 'vector') return
            if (!refreshed) break
            fresh =
              vectorEyedropperCache !== undefined &&
              isVectorEyedropperKeyCurrent(vectorEyedropperCacheKey, vectorEyedropperCacheKeyFor())
            if (fresh) break
          }
        }
        if (!eyedropperActive) return
        if (costumeEditMode !== 'vector') return
        if (
          !fresh ||
          vectorEyedropperCache === undefined ||
          !isVectorEyedropperKeyCurrent(vectorEyedropperCacheKey, vectorEyedropperCacheKeyFor())
        ) {
          // Discard the press: no stale sample, no loupe preview, no color
          // write, no VM edit, no history. The overlay closes so the next
          // press starts from the current artwork.
          eyedropperActive = false
          eyedropperHover = undefined
          lastEyedropperClient = undefined
          return
        }
      }
      // Release outside the artwork cancels; release inside commits to the
      // effective target (Shift picks the opposite side for one commit only).
      const inside = updateEyedropperHover(event)
      // The artwork may have changed between the fresh-cache check and the
      // sample (same-tick external write): re-verify before committing so a
      // held decode can never tint with the previous pixels.
      if (costumeEditMode === 'vector') {
        if (!isVectorEyedropperKeyCurrent(vectorEyedropperCacheKey, vectorEyedropperCacheKeyFor())) {
          eyedropperActive = false
          eyedropperHover = undefined
          lastEyedropperClient = undefined
          return
        }
      }
      const hover = eyedropperHover
      const target = resolveEyedropperCommitTarget(eyedropperTarget, event.shiftKey)
      eyedropperActive = false
      eyedropperHover = undefined
      lastEyedropperClient = undefined
      // Honke parity (Shift-pick included): the disabled side is unreachable,
      // so a release resolving to it just closes the overlay — no stored
      // color, selection SVG, VM bytes, or history change.
      if (
        costumeEditMode === 'vector' &&
        ((target === 'fill' && fillPaintDisabled) || (target === 'stroke' && strokePaintDisabled))
      ) {
        return
      }
      if (inside && hover) {
        lastEyedropperCommitAt = Date.now()
        await applyEyedropperColor(hover.pixel, target)
      }
      return
    }
    if (costumeEditMode === 'bitmap') return endBitmapPaint(event)
    // True data-change race gate: capture the pending hit reference + its
    // generation, then judge AFTER the await. A retired token (pointercancel
    // / genuine lostpointercapture / Escape / scope switch / next press)
    // drops here without touching bytes/history/selection: an already
    // initialized move is aborted the same way (local state cleared, no
    // `endVectorObjectDrag` commit, so no history entry).
    if (vectorHitPromise) {
      const pendingHit = vectorHitPromise
      const pendingGesture = vectorHitGesture
      try {
        await pendingHit
      } catch {
        // A failed hit test falls through to marquee handling below.
      }
      if (pendingGesture !== undefined && pendingGesture !== vectorShapeLiveGesture) {
        vectorShapeDelegated = false
        vectorShapeDraft = undefined
        vectorShapeLastPoint = undefined
        vectorShapeLastModifiers = undefined
        return
      }
      // pointercancel / lostpointercapture that arrived as the release itself
      // (not pending-hit) never commits either: abort without history.
      if ((event as PointerEvent)?.type === 'pointercancel' || (event as PointerEvent)?.type === 'lostpointercapture') {
        vectorShapeDelegated = false
        vectorShapeDraft = undefined
        vectorShapeLastPoint = undefined
        vectorShapeLastModifiers = undefined
        vectorShapeLiveGesture = undefined
        vectorHitGesture = undefined
        return
      }
    } else if ((event as PointerEvent)?.type === 'pointercancel' || (event as PointerEvent)?.type === 'lostpointercapture') {
      // Cancel with no pending hit and an initialized delegated move: abort
      // (no commit) instead of routing through the normal drag end.
      if (vectorShapeDelegated || vectorShapeDraft) {
        vectorShapeDelegated = false
        vectorShapeDraft = undefined
        vectorShapeLastPoint = undefined
        vectorShapeLastModifiers = undefined
        vectorShapeLiveGesture = undefined
        vectorHitGesture = undefined
        return
      }
    }
    if (costumeEditMode === 'vector' && vectorMarquee) {
      const rect = normalizedRect(vectorMarquee.start, vectorMarquee.current)
      const dragged = rect.width > 2 || rect.height > 2
      const append = vectorMarquee.append
      vectorMarquee = undefined
      // Reshape blank-drag is a point marquee over the selected object
      // (anchors only, edges inclusive): plain drag replaces, Shift drag
      // toggles matched anchors. No object selection change, no history.
      if (vectorTool === 'reshape' && selectedVectorObjectIndex >= 0 && selectVectorReshapePointsInRect) {
        if (dragged) void selectVectorReshapePointsInRect(rect, append)
        else if (!append) {
          selectVectorReshapePoints?.([])
          selectVectorReshapeLeaves?.([])
        }
        return
      }
      if (dragged) void selectVectorObjectsInRect?.(rect, append)
      else if (!append) clearVectorObjectSelection?.()
    }
    if (costumeEditMode === 'vector' && (vectorTool === 'select' || vectorTool === 'reshape' || vectorTool === 'rect' || vectorTool === 'oval')) {
      // A fresh miss-draft on rect/oval owns no move: this release never
      // started a drag, so it must not drive an older pointerup-claimed commit
      // here. Awaiting it would serialize the stamp behind the move — the
      // stamp's fail-closed barrier would then start after the slot idles and
      // silently order after instead of observing the in-flight slot and
      // rejecting at the 2s bound. The move's own release already drives its
      // end (same pointer id for mouse); delegated hits still end below.
      const freshMissDraft =
        (vectorTool === 'rect' || vectorTool === 'oval') && !vectorShapeDelegated && vectorShapeDraft !== undefined
      if (!freshMissDraft) {
        await endVectorObjectDrag?.(event as unknown as PointerEvent)
      }
      vectorShapeDelegated = false
      // Settle the shape generation: the trailing auto-loss after this
      // release (same pointer id) must not retire anything, and the next
      // press mints a fresh id.
      if (vectorTool === 'rect' || vectorTool === 'oval') {
        vectorShapeLiveGesture = undefined
        vectorHitGesture = undefined
        vectorShapeReleaseSeen = undefined
      }
    }
    if (costumeEditMode === 'vector' && vectorTool === 'brush' && vectorBrushPoints.length > 0) {
      const points = vectorBrushPoints
      vectorBrushPoints = []
      // Closed-fill brush uses the solid fill color (Scratch fill parity),
      // never the stroke color or gradient. Transparent fill paints nothing:
      // skip both the pending preview and the save so no empty Undo entry is
      // recorded, matching the commit-side no-op in Editor.svelte.
      const brushFill = fillTransparent ? 'none' : paintColor
      if (brushFill.trim().toLowerCase() === 'none' || brushFill.trim().toLowerCase() === 'transparent') {
        void Promise.resolve(saveVectorBrushStroke(points))
      } else {
        const id = nextBrushPreviewId++
        pendingBrushPreviews = [...pendingBrushPreviews, { id, points, color: brushFill, width: normalizeVectorBrushSize(vectorBrushSize), opacity: vectorOpacity }]
        void Promise.resolve(saveVectorBrushStroke(points)).finally(() => {
          pendingBrushPreviews = pendingBrushPreviews.filter((preview) => preview.id !== id)
        })
      }
    }
    if (costumeEditMode === 'vector' && vectorTool === 'eraser' && vectorEraserPoints.length > 0) {
      const points = vectorEraserPoints
      vectorEraserPoints = []
      await eraseVectorStroke(points)
    }
    if (costumeEditMode === 'vector' && vectorShapeDraft) {
      const draft = vectorShapeDraft
      vectorShapeDraft = undefined
      const modifiers = readShapeModifiers(event)
      // Keep the preview rect and the saved rect identical: lines preserve the
      // drag vector via vectorLineRect, rect/oval use the normalized box.
      const rect = draft.shape === 'line' ? vectorLineRect(draft.start, draft.current) : resolveShapeRect(draft.start, draft.current, modifiers)
      // Reference parity: tiny boxes (clicks, sub-pixel jitter, axis-zero
      // drags without Shift) are discarded below `2 / paperZoom` with no
      // history and no selection change; Shift squares first so one zero
      // axis still commits the square. Pointer-cancel already discarded the
      // draft above, so reaching here is a real release.
      const commitDraft = draft.shape === 'line'
        ? isShapeDrag(draft.start, draft.current)
        : shouldCommitShapeDrag(draft.start, draft.current, modifiers, vectorShapePaperZoom(viewportScale))
      if (commitDraft) {
        // Reference parity: rect/oval stay armed after commit (the new shape
        // stays selected under the same tool, like tools/rect-tool.js and
        // tools/oval-tool.js which never change mode on mouseUp). The line
        // tool keeps the historical flip to select.
        if (draft.shape === 'line') chooseVectorTool('select')
        const id = nextShapePreviewId++
        pendingShapePreviews = [...pendingShapePreviews, { id, shape: draft.shape, rect, color: previewFillColor, secondaryColor: previewSecondaryColor, gradient: paintGradient, stroke: previewStrokeGradientColor, strokeSecondary: previewStrokeSecondaryGradientColor, strokeGradient, width: strokeWidth, opacity: vectorOpacity }]
        void Promise.resolve(saveVectorShapeInRect(draft.shape, rect)).finally(() => {
          pendingShapePreviews = pendingShapePreviews.filter((preview) => preview.id !== id)
        })
      }
      if (draft.shape === 'rect' || draft.shape === 'oval') {
        vectorShapeLiveGesture = undefined
        vectorHitGesture = undefined
        vectorShapeReleaseSeen = undefined
      }
    }
  }

  function handleCanvasDoubleClick(event: MouseEvent) {
    // The overlay owns picking while active; the legacy double-click shortcut
    // stays bitmap-only and never double-applies under the overlay.
    if (eyedropperActive) return
    if (costumeEditMode === 'bitmap') pickBitmapColor(event)
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-white">
  <div data-testid="paint-toolbar" class="flex min-h-[64px] shrink-0 flex-col gap-2 overflow-visible border-b border-slate-700 bg-slate-900 px-4 py-2 text-slate-100">
    <div class="flex h-9 min-w-0 items-center gap-3 overflow-visible">
      <div class="flex min-w-0 shrink items-center gap-2">
      <span class="hidden whitespace-nowrap text-xs font-bold text-slate-200 min-[500px]:inline">コスチューム</span>
      <input class="h-9 w-16 min-w-0 max-w-full shrink rounded-full border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300 min-[500px]:w-20 sm:w-24" value={currentCostumeName} aria-label={`Rename ${currentCostumeName || 'costume'}`} onchange={updateCurrentCostumeName} />
      </div>
        <div class="flex shrink-0 overflow-hidden rounded-md border border-slate-600 bg-slate-800">
          <button class="flex h-8 w-9 items-center justify-center text-purple-300 disabled:opacity-30" aria-label="Undo" title="Undo" disabled={!canUndo} onclick={() => { clearFillHoverPreview(); void undoAssetEdit() }}><Undo2 size={17} /></button>
          <button class="flex h-8 w-9 items-center justify-center border-l border-slate-600 text-purple-300 disabled:opacity-30" aria-label="Redo" title="Redo" disabled={!canRedo} onclick={() => { clearFillHoverPreview(); void redoAssetEdit() }}><Redo2 size={17} /></button>
        </div>
        <!-- Pinned Undo/Redo/Delete (always visible, never overflow).
          Copy/Paste lead the measured ⋯ menu as priority actions (inline
          while they fit, one click away in the menu when narrow) so the
          trailing More trigger never loses its reserved width. Delete stays
          pinned because selection clearing is pressed directly at any
          width; every entry keeps its testId/aria/title/disabled. -->
        <div class="flex shrink-0 items-center gap-1 text-purple-300">
          <button class="toolbar-icon disabled:opacity-30" aria-label="Delete selection" title={bitmapToolbarLocked ? 'Loading bitmap…' : 'Delete'} data-testid="delete-editor-selection" disabled={costumeEditMode === 'vector' ? selectedVectorObjectIndex < 0 && selectedVectorObjectIndices.length === 0 : (!bitmapSelection || bitmapToolbarLocked)} onclick={deleteEditorSelection}><Trash2 size={21} /></button>
        </div>
        <PaintToolbarOverflow actions={toolbarOverflowActions} />
      </div>

      <div class="flex min-h-9 flex-wrap items-center gap-2" data-testid="paint-style-bar">
        {#if costumeEditMode === 'vector' && vectorTool === 'reshape'}
          <!-- Scratch mode-tools parity: Curved makes the selected anchor smooth,
            Pointed clears its handles. Enabled only from the live anchor state
            so a disabled click never reaches the helper or history. -->
          <div class="flex h-9 shrink-0 items-center overflow-hidden rounded-md border border-slate-600 bg-slate-800" role="group" aria-label="Point style">
            <button
              type="button"
              data-testid="reshape-curve-point"
              class={`h-full px-3 text-xs font-bold ${reshapePointStyle.hasUncurved ? 'text-purple-300 hover:bg-slate-700' : 'text-slate-500'}`}
              aria-label="Curved"
              title="Curved"
              aria-pressed={reshapePointStyle.style === 'curved'}
              disabled={!reshapePointStyle.hasUncurved}
              onclick={() => void curveVectorReshapePoint?.()}
            >
              Curved
            </button>
            <button
              type="button"
              data-testid="reshape-point-point"
              class={`h-full border-l border-slate-600 px-3 text-xs font-bold ${reshapePointStyle.hasUnpointed ? 'text-purple-300 hover:bg-slate-700' : 'text-slate-500'}`}
              aria-label="Pointed"
              title="Pointed"
              aria-pressed={reshapePointStyle.style === 'pointed'}
              disabled={!reshapePointStyle.hasUnpointed}
              onclick={() => void pointVectorReshapePoint?.()}
            >
              Pointed
            </button>
          </div>
        {/if}
        {#if (costumeEditMode === 'bitmap' && bitmapTool === 'eraser') || (costumeEditMode === 'vector' && vectorTool === 'eraser')}
          <label class="flex shrink-0 items-center gap-2 text-sm font-bold text-slate-200">
            消しゴムの太さ
            {#if costumeEditMode === 'bitmap'}
              <input class="w-28 accent-purple-300" type="range" min="1" max="100" bind:value={bitmapEraserSize} aria-label="Eraser size" />
              <input class="w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-center text-slate-100" type="number" min="1" max="100" value={bitmapEraserSize} aria-label="Eraser size value" onchange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) bitmapEraserSize = Math.min(100, Math.max(1, Math.trunc(value))); event.currentTarget.value = String(bitmapEraserSize) }} />
            {:else}
              <input class="w-28 accent-purple-300" type="range" min="1" max="100" bind:value={vectorEraserSize} aria-label="Eraser size" />
              <input class="w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-center text-slate-100" type="number" min="1" max="100" value={vectorEraserSize} aria-label="Eraser size value" onchange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) vectorEraserSize = Math.min(100, Math.max(1, Math.trunc(value))); event.currentTarget.value = String(vectorEraserSize) }} />
            {/if}
          </label>
        {:else}
        <!-- Compact Fill swatch: the full fill controls live in the anchored
          dialog (same handlers/state as before, just hidden until opened) so
          the closed toolbar stays one row tall. -->
        <PaintSwatchPopover
          testId="fill-style"
          triggerLabel="Fill style"
          triggerText="Fill"
          dialogLabel="Fill style"
          swatchBackground={fillSwatchBackground}
          swatchTransparent={paintGradient === 'solid' && fillTransparent}
          mixed={mixedFill}
          disabled={fillPaintDisabled || eyedropperActive}
          open={openStylePopover === 'fill'}
          onToggle={() => { if (!fillPaintDisabled && !eyedropperActive) openStylePopover = openStylePopover === 'fill' ? null : 'fill' }}
          onClose={closeStylePopover}
        >
          <label class="flex items-center gap-2 text-sm font-bold text-slate-100">
            塗りつぶし
            <span class="flex h-9 overflow-hidden rounded border border-slate-600 bg-slate-800">
              <input class="h-9 w-10 border-0 bg-slate-800 p-0 disabled:opacity-40" type="color" bind:value={paintColor} aria-label="Paint color" disabled={fillPaintDisabled} onchange={() => { if (!fillPaintDisabled) markVectorStyleDirty?.('fill') }} />
              <span class="flex h-9 w-5 items-center justify-center border-l border-slate-600 text-xs text-slate-400">▼</span>
            </span>
            {#if mixedFill}<span data-testid="mixed-fill" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed fill colors in the selection">MIXED</span>{/if}
          </label>
          <!-- Scratch-parity HSV sliders for the primary fill: same hex as the
            native picker beside it, three 0-100 sliders with numeric readouts.
            Every slider tick repaints only the fill side at once; the gesture
            commits exactly one Undo entry when it closes. -->
          <HsvColorPicker
            idPrefix="fill"
            hex={paintColor}
            mixed={mixedFill}
            transparent={fillTransparent}
            disabled={fillPaintDisabled}
            syncKey={hsvSyncKey}
            hueLabel="Fill hue"
            saturationLabel="Fill saturation"
            brightnessLabel="Fill brightness"
            onHexInput={(hex) => {
              if (fillPaintDisabled) return
              if (applyHsvLive) applyHsvLive('fill', hex)
              else paintColor = hex
            }}
            onHexCommit={() => {
              if (fillPaintDisabled) return
              if (commitHsvLive) commitHsvLive('fill')
              else markVectorStyleDirty?.('fill')
            }}
          />
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center gap-1 rounded border px-2 text-xs font-bold disabled:opacity-40 ${fillTransparent ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Transparent fill"
              aria-pressed={fillTransparent}
              title="Transparent fill (keeps the color for restore)"
              disabled={fillPaintDisabled}
              onclick={() => { if (!fillPaintDisabled) { fillTransparent = !fillTransparent; markVectorStyleDirty?.('fill') } }}
            >
              <span class="inline-block h-4 w-4 rounded-sm border border-slate-500" style="background:conic-gradient(#64748b 25%, #0f172a 0 50%, #64748b 0 75%, #0f172a 0);background-size:8px 8px;" aria-hidden="true"></span>
              透明
            </button>
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center justify-center rounded border px-2 disabled:opacity-40 ${eyedropperActive && eyedropperTarget === 'fill' ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Pick fill color"
              aria-pressed={eyedropperActive && eyedropperTarget === 'fill'}
              title="Pick fill color (Shift+click picks the stroke)"
              data-testid="eyedropper-fill"
              disabled={fillPaintDisabled}
              onclick={() => toggleEyedropper('fill')}
            >
              <Pipette size={17} />
            </button>
            <button
              type="button"
              class="flex h-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-800 px-2 text-slate-100 hover:bg-slate-700 disabled:opacity-40"
              aria-label="Swap fill colors"
              title="Swap the first and second fill colors (with transparency)"
              data-testid="swap-fill-colors"
              disabled={fillPaintDisabled}
              onclick={swapFillPaint}
            >
              <ArrowLeftRight size={17} />
            </button>
          </div>
          {#if costumeEditMode === 'bitmap'}
            <select class="h-9 rounded-md border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300" bind:value={paintGradient} aria-label="Bitmap paint style">
              <option value="solid">Solid</option>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
              <option value="radial">Radial</option>
            </select>
          {:else}
            <select class="h-9 rounded-md border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300 disabled:opacity-40" bind:value={paintGradient} disabled={fillPaintDisabled} onchange={() => { if (!fillPaintDisabled) markVectorStyleDirty?.('fillGradient') }} aria-label="Vector paint style">
              <option value="solid">Solid</option>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
              <option value="radial">Radial</option>
            </select>
            {#if mixedFillGradient}<span data-testid="mixed-fill-gradient" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed gradient kinds in the selection">MIXED</span>{/if}
            <label class="flex min-w-36 items-center gap-2 text-xs font-semibold text-slate-200">
              Opacity
              <input class="w-24 accent-purple-300" type="range" min="0" max="100" bind:value={vectorOpacity} onchange={() => markVectorStyleDirty?.('opacity')} aria-label="Vector opacity" />
              {#if mixedOpacity}<span data-testid="mixed-opacity" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed opacity in the selection">MIXED</span>{/if}
            </label>
          {/if}
          {#if paintGradient !== 'solid'}
            <label class="flex items-center gap-2 text-sm font-bold text-slate-100">
              終色
              <span class="flex h-9 overflow-hidden rounded border border-slate-600 bg-slate-800">
                <input class="h-9 w-10 border-0 bg-slate-800 p-0 disabled:opacity-40" type="color" bind:value={secondaryPaintColor} disabled={fillPaintDisabled} onchange={() => { if (!fillPaintDisabled) markVectorStyleDirty?.('fillSecondary') }} aria-label="Secondary paint color" />
                <span class="flex h-9 w-5 items-center justify-center border-l border-slate-600 text-xs text-slate-400">▼</span>
              </span>
              {#if mixedFillSecondary}<span data-testid="mixed-fill-secondary" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed secondary fill in the selection">MIXED</span>{/if}
            </label>
            <HsvColorPicker
              idPrefix="fill-secondary"
              hex={secondaryPaintColor}
              mixed={mixedFillSecondary}
              transparent={secondaryTransparent}
              disabled={fillPaintDisabled}
              syncKey={hsvSyncKey}
              hueLabel="Secondary fill hue"
              saturationLabel="Secondary fill saturation"
              brightnessLabel="Secondary fill brightness"
              onHexInput={(hex) => {
                if (fillPaintDisabled) return
                if (applyHsvLive) applyHsvLive('fillSecondary', hex)
                else secondaryPaintColor = hex
              }}
              onHexCommit={() => {
                if (fillPaintDisabled) return
                if (commitHsvLive) commitHsvLive('fillSecondary')
                else markVectorStyleDirty?.('fillSecondary')
              }}
            />
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center gap-1 rounded border px-2 text-xs font-bold disabled:opacity-40 ${secondaryTransparent ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Transparent secondary"
              aria-pressed={secondaryTransparent}
              title="Transparent gradient end (keeps the color for restore)"
              disabled={fillPaintDisabled}
              onclick={() => { if (!fillPaintDisabled) { secondaryTransparent = !secondaryTransparent; markVectorStyleDirty?.('fillSecondary') } }}
            >
              <span class="inline-block h-4 w-4 rounded-sm border border-slate-500" style="background:conic-gradient(#64748b 25%, #0f172a 0 50%, #64748b 0 75%, #0f172a 0);background-size:8px 8px;" aria-hidden="true"></span>
              透明
            </button>
          {/if}
        </PaintSwatchPopover>
        {#if bitmapStrokeVisible}
        <!-- Compact Outline swatch: vector-only outline controls in the anchored
          dialog; bitmap mode hides the whole swatch (fill-only parity). -->
        <PaintSwatchPopover
          testId="outline-style"
          triggerLabel="Outline style"
          triggerText="Outline"
          dialogLabel="Outline style"
          swatchBackground={strokeSwatchBackground}
          swatchTransparent={strokeGradient === 'solid' && strokeTransparent}
          mixed={mixedStroke}
          disabled={strokePaintDisabled || eyedropperActive}
          open={openStylePopover === 'stroke'}
          onToggle={() => { if (!strokePaintDisabled && !eyedropperActive) openStylePopover = openStylePopover === 'stroke' ? null : 'stroke' }}
          onClose={closeStylePopover}
        >
          <label class="flex items-center gap-2 text-sm font-bold text-slate-100">
            枠線
            <span class="flex h-9 overflow-hidden rounded border border-slate-600 bg-slate-800">
              <input class="h-9 w-10 border-0 bg-slate-800 p-0 disabled:opacity-40" type="color" bind:value={strokeColor} aria-label="Stroke color" disabled={strokePaintDisabled} onchange={() => { if (!strokePaintDisabled) markVectorStyleDirty?.('stroke') }} />
              <span class="flex h-9 w-5 items-center justify-center border-l border-slate-600 text-xs text-slate-400">▼</span>
            </span>
            {#if mixedStroke}<span data-testid="mixed-stroke" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed stroke colors in the selection">MIXED</span>{/if}
          </label>
          <HsvColorPicker
            idPrefix="stroke"
            hex={strokeColor}
            mixed={mixedStroke}
            transparent={strokeTransparent}
            disabled={strokePaintDisabled}
            syncKey={hsvSyncKey}
            hueLabel="Stroke hue"
            saturationLabel="Stroke saturation"
            brightnessLabel="Stroke brightness"
            onHexInput={(hex) => {
              if (strokePaintDisabled) return
              if (applyHsvLive) applyHsvLive('stroke', hex)
              else strokeColor = hex
            }}
            onHexCommit={() => {
              if (strokePaintDisabled) return
              if (commitHsvLive) commitHsvLive('stroke')
              else markVectorStyleDirty?.('stroke')
            }}
          />
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center gap-1 rounded border px-2 text-xs font-bold disabled:opacity-40 ${strokeTransparent ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Transparent stroke"
              aria-pressed={strokeTransparent}
              title="Transparent stroke (keeps the color for restore)"
              disabled={strokePaintDisabled}
              onclick={() => { if (!strokePaintDisabled) { strokeTransparent = !strokeTransparent; markVectorStyleDirty?.('stroke') } }}
            >
              <span class="inline-block h-4 w-4 rounded-sm border border-slate-500" style="background:conic-gradient(#64748b 25%, #0f172a 0 50%, #64748b 0 75%, #0f172a 0);background-size:8px 8px;" aria-hidden="true"></span>
              透明
            </button>
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center justify-center rounded border px-2 disabled:opacity-40 ${eyedropperActive && eyedropperTarget === 'stroke' ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Pick stroke color"
              aria-pressed={eyedropperActive && eyedropperTarget === 'stroke'}
              title="Pick stroke color (Shift+click picks the fill)"
              data-testid="eyedropper-stroke"
              disabled={strokePaintDisabled}
              onclick={() => toggleEyedropper('stroke')}
            >
              <Pipette size={17} />
            </button>
            <button
              type="button"
              class="flex h-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-800 px-2 text-slate-100 hover:bg-slate-700 disabled:opacity-40"
              aria-label="Swap stroke colors"
              title="Swap the first and second stroke colors (with transparency)"
              data-testid="swap-stroke-colors"
              disabled={strokePaintDisabled}
              onclick={swapStrokePaint}
            >
              <ArrowLeftRight size={17} />
              <span class="ml-1 text-[10px] font-bold">枠</span>
            </button>
          </div>
          <select class="h-9 rounded-md border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300 disabled:opacity-40" bind:value={strokeGradient} disabled={strokePaintDisabled} onchange={() => { if (!strokePaintDisabled) markVectorStyleDirty?.('strokeGradient') }} aria-label="Vector stroke style" data-testid="vector-stroke-gradient">
            <option value="solid">Stroke solid</option>
            <option value="horizontal">Stroke horiz</option>
            <option value="vertical">Stroke vert</option>
            <option value="radial">Stroke radial</option>
          </select>
          {#if mixedStrokeGradient}<span data-testid="mixed-stroke-gradient" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed stroke gradients in the selection">MIXED</span>{/if}
          {#if strokeGradient !== 'solid'}
            <label class="flex items-center gap-2 text-sm font-bold text-slate-100">
              枠終色
              <span class="flex h-9 overflow-hidden rounded border border-slate-600 bg-slate-800">
                <input class="h-9 w-10 border-0 bg-slate-800 p-0 disabled:opacity-40" type="color" bind:value={strokeSecondaryColor} disabled={strokePaintDisabled} onchange={() => { if (!strokePaintDisabled) markVectorStyleDirty?.('strokeSecondary') }} aria-label="Secondary stroke color" />
                <span class="flex h-9 w-5 items-center justify-center border-l border-slate-600 text-xs text-slate-400">▼</span>
              </span>
              {#if mixedStrokeSecondary}<span data-testid="mixed-stroke-secondary" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed secondary stroke in the selection">MIXED</span>{/if}
            </label>
            <HsvColorPicker
              idPrefix="stroke-secondary"
              hex={strokeSecondaryColor}
              mixed={mixedStrokeSecondary}
              transparent={secondaryStrokeTransparent}
              disabled={strokePaintDisabled}
              syncKey={hsvSyncKey}
              hueLabel="Secondary stroke hue"
              saturationLabel="Secondary stroke saturation"
              brightnessLabel="Secondary stroke brightness"
              onHexInput={(hex) => {
                if (strokePaintDisabled) return
                if (applyHsvLive) applyHsvLive('strokeSecondary', hex)
                else strokeSecondaryColor = hex
              }}
              onHexCommit={() => {
                if (strokePaintDisabled) return
                if (commitHsvLive) commitHsvLive('strokeSecondary')
                else markVectorStyleDirty?.('strokeSecondary')
              }}
            />
            <button
              type="button"
              class={`flex h-9 shrink-0 items-center gap-1 rounded border px-2 text-xs font-bold disabled:opacity-40 ${secondaryStrokeTransparent ? 'border-purple-300 bg-purple-300 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
              aria-label="Transparent secondary stroke"
              aria-pressed={secondaryStrokeTransparent}
              title="Transparent stroke gradient end (keeps the color for restore)"
              disabled={strokePaintDisabled}
              onclick={() => { if (!strokePaintDisabled) { secondaryStrokeTransparent = !secondaryStrokeTransparent; markVectorStyleDirty?.('strokeSecondary') } }}
            >
              <span class="inline-block h-4 w-4 rounded-sm border border-slate-500" style="background:conic-gradient(#64748b 25%, #0f172a 0 50%, #64748b 0 75%, #0f172a 0);background-size:8px 8px;" aria-hidden="true"></span>
              透明
            </button>
          {/if}
        </PaintSwatchPopover>
        <input class="h-9 w-16 rounded-full border border-slate-600 bg-slate-800 px-4 text-center text-sm font-semibold text-slate-100 outline-none focus:border-purple-300 disabled:opacity-40" type="number" min={STROKE_WIDTH_MIN} max={STROKE_WIDTH_MAX} value={costumeEditMode === 'vector' && selectedVectorObjectIndex >= 0 ? (vectorObjects.find((object: VectorObjectInfo) => object.index === selectedVectorObjectIndex)?.strokeWidth ?? strokeWidth) : strokeWidth} onchange={(event) => { if (strokePaintDisabled) return; updateVectorObjectStrokeWidth(event) }} aria-label="Stroke width" disabled={strokePaintDisabled} />
        {#if mixedStrokeWidth}<span data-testid="mixed-stroke-width" class="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-100" title="Mixed line widths in the selection">MIXED</span>{/if}
        {/if}
        {#if costumeEditMode === 'bitmap' && (bitmapTool === 'rect' || bitmapTool === 'oval')}
          <div class="flex h-9 shrink-0 items-center overflow-hidden rounded-md border border-slate-600 bg-slate-800" role="group" aria-label="Bitmap shape mode">
            <button
              type="button"
              data-testid="bitmap-shape-mode-filled"
              class={`h-full px-3 text-xs font-bold ${bitmapShapeMode === 'filled' ? 'bg-purple-300 text-slate-900' : 'text-slate-100 hover:bg-slate-700'}`}
              aria-label="Filled"
              aria-pressed={bitmapShapeMode === 'filled'}
              title="Filled: paint the shape interior"
              onclick={() => (bitmapShapeMode = 'filled')}
            >
              Filled
            </button>
            <button
              type="button"
              data-testid="bitmap-shape-mode-outlined"
              class={`h-full border-l border-slate-600 px-3 text-xs font-bold ${bitmapShapeMode === 'outlined' ? 'bg-purple-300 text-slate-900' : 'text-slate-100 hover:bg-slate-700'}`}
              aria-label="Outlined"
              aria-pressed={bitmapShapeMode === 'outlined'}
              title="Outlined: paint the shape contour with the fill color and brush size"
              onclick={() => (bitmapShapeMode = 'outlined')}
            >
              Outlined
            </button>
          </div>
        {/if}
        {#if (costumeEditMode === 'bitmap' && (bitmapPendingHas || bitmapPendingGap || bitmapPendingQuarantined)) || bitmapPendingRecoveryHas}
          <div data-testid="bitmap-pending-status" class="flex shrink-0 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800" role="status">
            {#if bitmapPendingQuarantined || bitmapPendingRecoveryHas}
              <span>Pending shape quarantined (external change preserved). Export or discard explicitly.</span>
              <button type="button" data-testid="bitmap-pending-export" class="rounded border border-amber-300 bg-white px-2 py-0.5" onclick={async () => { const bytes = await exportBitmapPendingQuarantined?.(); if (bytes && bytes.byteLength > 0) { const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' }); const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = 'pending-shape.png'; link.click(); URL.revokeObjectURL(href); } }}>Export</button>
              <button type="button" data-testid="bitmap-pending-discard" class="rounded border border-amber-300 bg-white px-2 py-0.5" onclick={() => { void discardBitmapPendingQuarantine?.(); }}>Discard</button>
            {:else if bitmapPendingGap}
              <span>History gap: shape committed without undo entry. Undo unavailable for last stroke. Acknowledge to continue.</span>
              <button type="button" data-testid="bitmap-pending-acknowledge-gap" class="rounded border border-amber-300 bg-white px-2 py-0.5" onclick={() => { void acknowledgeBitmapPendingGap?.('ui-acknowledged'); }}>Acknowledge</button>
            {:else}
              <span>Pending {bitmapPendingKind ?? 'shape'} ({bitmapPendingMode ?? 'filled'}) staged — restyle/move stays uncommitted, deselect commits, Delete/Undo discards.</span>
            {/if}
          </div>
        {/if}
        {#if costumeEditMode === 'bitmap'}
          {#if bitmapBrushSizeVisible}
          <label class="ml-1 flex min-w-32 shrink-0 items-center gap-2 text-xs font-semibold text-slate-200">
            Size
            <input class="w-24 shrink-0 accent-purple-300" type="range" min={BITMAP_BRUSH_MIN_SIZE} max={BITMAP_BRUSH_MAX_SIZE} bind:value={brushSize} aria-label="Brush size" />
          </label>
          {/if}
          {#if bitmapTool === 'text'}
            <label class="flex min-w-32 shrink-0 items-center gap-2 text-xs font-semibold text-slate-200">
              Font size
              <input class="w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-center text-slate-100" type="number" min="8" max="200" bind:value={vectorTextFontSize} aria-label="Text font size" data-testid="bitmap-text-font-size" />
            </label>
            <select class="h-9 max-w-32 shrink-0 rounded-md border border-slate-600 bg-slate-800 px-2 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300" bind:value={vectorTextFontFamily} aria-label="Text font" data-testid="bitmap-text-font">
              {#each VECTOR_TEXT_FONT_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
              {#if isUnknownVectorTextFont}
                <option value={vectorTextFontFamily}>{vectorTextFontFamily}</option>
              {/if}
            </select>
          {/if}
        {:else}
          {#if vectorTool === 'brush'}
            <label class="ml-1 flex min-w-32 shrink-0 items-center gap-2 text-xs font-semibold text-slate-200">
              Brush
              <input class="w-24 shrink-0 accent-purple-300" type="range" min={VECTOR_BRUSH_MIN_SIZE} max={VECTOR_BRUSH_MAX_SIZE} bind:value={vectorBrushSize} onchange={() => { vectorBrushSize = normalizeVectorBrushSize(vectorBrushSize) }} aria-label="Brush size" />
            </label>
          {/if}
          {#if vectorShape === 'text'}
            <select class="h-9 max-w-32 shrink-0 rounded-md border border-slate-600 bg-slate-800 px-2 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300" bind:value={vectorTextFontFamily} aria-label="Vector font" data-testid="vector-text-font">
              {#each VECTOR_TEXT_FONT_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
              {#if isUnknownVectorTextFont}
                <option value={vectorTextFontFamily}>{vectorTextFontFamily}</option>
              {/if}
            </select>
            <input class="h-9 w-20 shrink-0 rounded-md border border-slate-600 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100 outline-none focus:border-purple-300" type="number" min="8" max="144" bind:value={vectorTextFontSize} aria-label="Vector font size" data-testid="vector-text-font-size" />
            <input class="h-9 w-32 min-w-0 shrink rounded-md border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 outline-none focus:border-purple-300" bind:value={vectorText} aria-label="Vector text" title="Default text (canvas editing starts empty)" />
          {/if}
        {/if}
        {#if costumeEditMode === 'vector'}
          <button
            type="button"
            data-testid="apply-vector-style"
            class="h-9 shrink-0 rounded-md bg-purple-300 px-3 text-sm font-bold text-slate-900 hover:bg-purple-200 disabled:opacity-40"
            aria-label="Apply fill and stroke"
            title="Apply the current fill, stroke and opacity to the selection"
            disabled={(selectedVectorObjectIndex ?? -1) < 0 && (selectedVectorObjectIndices ?? []).length === 0}
            onclick={() => void applyVectorStyle?.()}
          >
            Apply
          </button>
        {/if}
        {/if}
      </div>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden bg-white">
    <div data-testid="paint-tool-rail" class="paint-tool-rail grid w-[132px] shrink-0 grid-cols-2 content-start gap-x-5 gap-y-5 overflow-y-auto px-7 py-7">
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
        <!-- Dedicated bitmap picker: overlay, not a BitmapTool value, so the
          previous brush/fill/text tool survives a cancel untouched. -->
        <button
          data-testid="bitmap-tool-eyedropper"
          class={`flex h-11 w-11 items-center justify-center rounded transition ${eyedropperActive ? 'bg-[#8d5de8] text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
          aria-label="Eyedropper"
          aria-pressed={eyedropperActive}
          title="Eyedropper (click to pick the fill, Shift+click for the stroke, Esc to cancel)"
          onclick={() => toggleEyedropper('fill')}
        >
          <Pipette size={27} strokeWidth={2.4} />
        </button>
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
        <button
          data-testid="vector-tool-eyedropper"
          class={`flex h-11 w-11 items-center justify-center rounded transition ${eyedropperActive ? 'bg-[#8d5de8] text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
          aria-label="Eyedropper"
          aria-pressed={eyedropperActive}
          title="Eyedropper (click to pick the fill, Shift+click for the stroke, Esc to cancel)"
          onclick={() => toggleEyedropper('fill')}
        >
          <Pipette size={27} strokeWidth={2.4} />
        </button>
      {/if}
    </div>

    <div
      data-testid="costume-paint-surface"
      class="relative min-w-0 flex-1 touch-none overflow-hidden bg-white"
      role="application"
      aria-label="Costume paint canvas"
      style={viewportBackgroundStyle()}
      use:viewportWheel
    >
      {#if eyedropperActive}
        <div
          data-testid="eyedropper-hint"
          class="pointer-events-none absolute left-3 top-3 z-30 max-w-[70%] rounded-md bg-[#1e1b4b]/90 px-3 py-1.5 text-xs font-semibold text-white shadow"
        >
          スポイト: クリックで{eyedropperTarget === 'fill' ? '塗り' : '枠線'}を取得 (Shift+クリックで{eyedropperTarget === 'fill' ? '枠線' : '塗り'}へ) / Escで取消
        </div>
      {/if}
      {#if bitmapLoadingVisible}
        <div
          data-testid="bitmap-workspace-loading-overlay"
          role="status"
          aria-live="polite"
          aria-label="Loading bitmap"
          class="absolute left-3 top-3 z-30 max-w-[70%] rounded-md bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-white shadow"
        >
          Loading bitmap…
        </div>
      {/if}
      <div
        bind:this={editSurfaceNode}
        data-vector-stage-surface={costumeEditMode === 'vector' ? 'true' : undefined}
        class="absolute left-1/2 top-1/2"
        style={`width:${editSurfaceWidth()}px;height:${editSurfaceHeight()}px;transform:translate(calc(-50% + ${viewportX}px), calc(-50% + ${viewportY}px)) scale(${viewportScale});transform-origin:center;${eyedropperActive ? 'cursor:none;' : ''}`}
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
              {@html sanitizeSvgForDisplay(currentCostumePreviewSvg)}
            </div>
          {:else if currentCostumePreviewUrl}
            <img class="absolute select-none rounded border border-slate-200" style={vectorArtStyle()} src={currentCostumePreviewUrl} alt="" draggable="false" />
          {:else}
            <div class="absolute rounded border border-slate-200" style={vectorArtStyle()}></div>
          {/if}
          {#if fillHoverPreviewSvg && vectorTool === 'fill' && !eyedropperActive}
            <!-- Fill hover preview: draw-only snapshot above the base artwork
              and below selection UI (overlay order), `pointer-events: none`
              so it never blocks clicks, marquees, handles, or later hover
              passes. The live SVG is untouched; only this layer re-renders. -->
            <VectorFillHoverPreview previewSvg={fillHoverPreviewSvg} artStyle={vectorArtStyle()} />
          {/if}
        {/if}
        <div class="pointer-events-none absolute inset-0 border border-dashed border-slate-500/70"></div>
        {#if eraserCursor && ((costumeEditMode === 'bitmap' && bitmapTool === 'eraser') || (costumeEditMode === 'vector' && vectorTool === 'eraser'))}
          <EraserCursor x={eraserCursor.x} y={eraserCursor.y} size={costumeEditMode === 'bitmap' ? Math.max(1, Math.trunc(bitmapEraserSize)) : Math.max(1, vectorEraserSize) * VECTOR_WORKSPACE_SCALE} bitmap={costumeEditMode === 'bitmap'} />
        {/if}
        {#if bitmapSelection && costumeEditMode === 'bitmap'}
          <div data-testid="bitmap-selection" class="pointer-events-none absolute border border-dashed border-blue-500 bg-blue-500/5" style={selectionStyle(bitmapSelection)}></div>
        {/if}
        {#if costumeEditMode === 'bitmap' && (bitmapCenterGuideOpacity ?? 0) > 0}
          {@const bitmapGuide = bitmapCenterGuideStyle(bitmapCenterGuideOpacity ?? 0)}
          <div data-testid="move-center-crosshair" data-guide-mode="bitmap" class="pointer-events-none absolute" style={bitmapGuide.horizontal} aria-hidden="true">
            <div class="h-full w-full bg-rose-500"></div>
          </div>
          <div data-testid="move-center-crosshair-vertical" data-guide-mode="bitmap" class="pointer-events-none absolute" style={bitmapGuide.vertical} aria-hidden="true">
            <div class="h-full w-full bg-rose-500"></div>
          </div>
        {/if}
        {#if bitmapSelection && costumeEditMode === 'bitmap' && (bitmapTool === 'select' || bitmapTool === 'rect' || bitmapTool === 'oval') && !eyedropperActive && beginBitmapFloatingScale}
          <!-- Floating-selection scale handles (8 handles): the diagonal
            fixed point stays pinned (Alt pins the selection center instead),
            corner handles stay uniform unless Shift is held, edge handles
            scale a single axis, and crossing the fixed point mirrors. The
            generic canvas gesture ignores these buttons via the
            data-bitmap-floating-handle guard; inline-text and eyedropper
            sessions keep priority. The SE handle keeps the legacy test id so
            existing E2E keeps addressing it. -->
          {#each bitmapFloatingHandles as handle}
            <button
              data-bitmap-floating-handle={handle.id}
              data-testid={handle.id === 'se' ? 'bitmap-floating-scale-handle' : `bitmap-floating-scale-handle-${handle.id}`}
              class={`absolute h-4 w-4 rounded-sm border-2 border-white bg-blue-600 shadow pointer-events-auto ${handle.cursor}`}
              style={bitmapFloatingScaleHandleStyle(bitmapSelection, handle.id)}
              aria-label={`Scale bitmap selection ${handle.id}`}
              onpointerdown={(event) => {
                if (inlineText) {
                  void commitInlineText()
                  return
                }
                if (eyedropperActive) return
                event.preventDefault()
                event.stopPropagation()
                beginBitmapFloatingScale?.(event, handle.id)
              }}
              onpointermove={(event) => moveBitmapFloatingScale?.(event)}
              onpointerup={(event) => {
                void endBitmapFloatingScale?.(event)
              }}
              onpointercancel={(event) => {
                void endBitmapFloatingScale?.(event)
              }}
              onlostpointercapture={(event) => {
                // Browser fires lostpointercapture after pointerup (auto-loss
                // on release) as well as on capture loss/takeover. The Editor
                // end routes pointercancel/lostpointercapture to
                // cancelBitmapFloatingDrag and clears the drag on pointerup
                // first, so a trailing auto-loss after a committed pointerup
                // is a no-op (idempotent, exactly one history entry).
                void endBitmapFloatingScale?.(event)
              }}
            ></button>
          {/each}
          <!-- Rotation handle: centered above the selection, arbitrary angle
            around the selection center (Shift snaps to 45 degrees). Same
            guards as the scale handles (select tool, no eyedropper/text
            session) plus pointer capture on the button. -->
          {#if beginBitmapFloatingRotate}
            <button
              data-bitmap-floating-rotate-handle="rotate"
              data-testid="bitmap-floating-rotate-handle"
              class="absolute flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-green-600 text-white shadow pointer-events-auto cursor-grab"
              style={bitmapFloatingRotateHandleStyle(bitmapSelection)}
              aria-label="Rotate bitmap selection (Shift snaps to 45 degrees)"
              title="Rotate (Shift: snap to 45°)"
              onpointerdown={(event) => {
                if (inlineText) {
                  void commitInlineText()
                  return
                }
                if (eyedropperActive) return
                event.preventDefault()
                event.stopPropagation()
                beginBitmapFloatingRotate?.(event)
              }}
              onpointermove={(event) => moveBitmapFloatingRotate?.(event)}
              onpointerup={(event) => {
                void endBitmapFloatingRotate?.(event)
              }}
              onpointercancel={(event) => {
                void endBitmapFloatingRotate?.(event)
              }}
              onlostpointercapture={(event) => {
                // Same idempotent cancel route as the scale handles: a
                // trailing auto-loss after a committed pointerup no-ops
                // because the Editor already cleared the drag.
                void endBitmapFloatingRotate?.(event)
              }}
            ><RotateCw size={14} /></button>
          {/if}
        {/if}
        {#if costumeEditMode === 'vector'}
          {#each pendingBrushPreviews as preview (preview.id)}
            <VectorBrushPreview points={preview.points} color={preview.color} width={preview.width} opacity={preview.opacity} scale={VECTOR_WORKSPACE_SCALE} left={vectorArtLeft()} top={vectorArtTop()} />
          {/each}
          {#if vectorBrushPoints.length && !(fillTransparent)}
            <VectorBrushPreview points={vectorBrushPoints} color={paintColor} width={normalizeVectorBrushSize(vectorBrushSize)} opacity={vectorOpacity} scale={VECTOR_WORKSPACE_SCALE} left={vectorArtLeft()} top={vectorArtTop()} />
          {/if}
          {#each vectorObjects as object}
            <div
              data-vector-object
              data-vector-selection-outline
              class={`pointer-events-none absolute border-2 bg-transparent ${selectedVectorObjectIndices.includes(object.index) || selectedVectorObjectIndex === object.index ? 'border-blue-500' : 'border-transparent'}`}
              style={vectorObjectStyle(object)}
              aria-hidden="true"
            ></div>
          {/each}
          {#if vectorMarquee}
            <div class="pointer-events-none absolute border border-dashed border-blue-500 bg-blue-500/10" style={vectorMarqueeStyle()}></div>
          {/if}
          {#if (vectorCenterGuideOpacity ?? 0) > 0}
            {@const vectorGuide = vectorCenterGuideStyle(vectorCenterGuideOpacity ?? 0)}
            <div data-testid="move-center-crosshair" data-guide-mode="vector" class="pointer-events-none absolute" style={vectorGuide.horizontal} aria-hidden="true">
              <div class="h-full w-full bg-rose-500"></div>
            </div>
            <div data-testid="move-center-crosshair-vertical" data-guide-mode="vector" class="pointer-events-none absolute" style={vectorGuide.vertical} aria-hidden="true">
              <div class="h-full w-full bg-rose-500"></div>
            </div>
          {/if}
          {#each pendingShapePreviews as preview (preview.id)}
            <VectorShapePreview shape={preview.shape} rect={preview.rect} color={preview.color} secondaryColor={preview.secondaryColor} gradient={preview.gradient} stroke={preview.stroke} strokeSecondaryColor={preview.strokeSecondary} strokeGradient={preview.strokeGradient} width={preview.width} opacity={preview.opacity} left={vectorArtLeft()} top={vectorArtTop()} scale={VECTOR_WORKSPACE_SCALE} />
          {/each}
          {#if vectorShapeDraft && vectorShapeDraftShouldCommit(vectorShapeDraft)}
            <VectorShapePreview shape={vectorShapeDraft.shape} rect={vectorShapePreviewRect(vectorShapeDraft)} color={previewFillColor} secondaryColor={previewSecondaryColor} gradient={paintGradient} stroke={previewStrokeGradientColor} strokeSecondaryColor={previewStrokeSecondaryGradientColor} strokeGradient={strokeGradient} width={strokeWidth} opacity={vectorOpacity} left={vectorArtLeft()} top={vectorArtTop()} scale={VECTOR_WORKSPACE_SCALE} />
          {/if}
          {#if vectorTool === 'reshape' && !eyedropperActive && beginVectorPathPointDrag && selectedVectorObject() && ((selectedVectorObject()?.points?.length ?? 0) > 0 || selectedVectorObject()?.tag === 'g')}
            <VectorReshapeOverlay svg={currentCostumePreviewSvg} object={selectedVectorObject()!} left={vectorArtLeft()} top={vectorArtTop()} width={vectorCanvasWidth} height={vectorCanvasHeight} scale={VECTOR_WORKSPACE_SCALE} zoom={viewportScale} begin={beginVectorPathPointDrag} move={dragVectorPathPoint} end={endVectorPathPointDrag} selectedPointIndex={vectorReshapePointIndex} selectedPointIndices={vectorReshapePointIndices} selectedHandleMasks={vectorReshapeHandleMasks} selectedLeafIndices={vectorReshapeLeafIndices} onSelectPoint={(index) => selectVectorReshapePoint?.(index)} onSelectPoints={(indices) => selectVectorReshapePoints?.(indices)} onTogglePoint={(index, append) => toggleVectorReshapePoint?.(index, append)} addAtClient={(clientX, clientY) => reshapeAddAtClient(clientX, clientY)} selectLeafAtClient={(clientX, clientY, append) => reshapeLeafAtClient(clientX, clientY, append)} beginLeafTranslateAtClient={(clientX, clientY, event, append) => reshapeLeafTranslateBeginAtClient(clientX, clientY, event, append)} moveLeafTranslate={dragVectorLeafTranslate} endLeafTranslate={endVectorLeafTranslateDrag} deleteAt={(index) => { void deleteVectorReshapePoint?.(index) }} deleteSelectionAt={(indices) => { void deleteVectorReshapePoints?.(indices) }} />
          {/if}
          {#if (vectorTool === 'select' || vectorTool === 'rect' || vectorTool === 'oval') && !eyedropperActive && beginVectorObjectResize && selectedVectorObject() && !vectorMultiBounds}
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
            {#if beginVectorObjectRotate}
              <button
                data-vector-object
                data-testid="vector-rotate-handle"
                class="absolute flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-green-600 text-white shadow pointer-events-auto cursor-grab"
                style={vectorRotateHandleStyle(selectedObject)}
                aria-label="Rotate vector selection (Shift snaps to 45 degrees)"
                title="Rotate (Shift: snap to 45°)"
                onpointerdown={(event) => {
                  if (inlineText) {
                    void commitInlineText()
                    return
                  }
                  beginVectorObjectRotate?.(selectedObject, event)
                }}
                onpointermove={(event) => dragVectorObjectRotate?.(event)}
                onpointerup={(event) => {
                  void endVectorObjectRotate?.(event)
                }}
                onpointercancel={(event) => {
                  // Touch interruption / capture loss cancels the rotate with
                  // exact snapshot+metadata restore (bitmap/point/leaf
                  // parity); trailing auto-loss after a normal pointerup
                  // no-ops inside the Editor via the committing guard.
                  void endVectorObjectRotate?.(event)
                }}
                onlostpointercapture={(event) => {
                  void endVectorObjectRotate?.(event)
                }}
              ><RotateCw size={14} /></button>
            {/if}
          {/if}
          {#if (vectorTool === 'select' || vectorTool === 'rect' || vectorTool === 'oval') && !eyedropperActive && vectorMultiBounds && beginVectorMultiResize}
            <div
              data-vector-multi-selection
              class="pointer-events-none absolute border-2 border-blue-500 bg-transparent"
              style={vectorMultiBoundsStyle(vectorMultiBounds)}
              aria-hidden="true"
            ></div>
            {#each vectorResizeHandles as handle}
              <button
                data-vector-object
                class={`absolute h-4 w-4 rounded-sm border-2 border-white bg-blue-600 shadow pointer-events-auto ${handle.cursor}`}
                style={vectorMultiHandleStyle(vectorMultiBounds, handle.id)}
                aria-label={`Resize vector selection ${handle.id}`}
                onpointerdown={(event) => beginVectorMultiResize?.(handle.id, event)}
                onpointermove={(event) => dragVectorObjectResize?.(event)}
                onpointerup={(event) => endVectorObjectResize?.(event)}
                onpointercancel={() => undefined}
              ></button>
            {/each}
            {#if beginVectorMultiRotate}
              <button
                data-vector-object
                data-testid="vector-rotate-handle-multi"
                class="absolute flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-green-600 text-white shadow pointer-events-auto cursor-grab"
                style={vectorMultiRotateHandleStyle(vectorMultiBounds)}
                aria-label="Rotate vector selection (Shift snaps to 45 degrees)"
                title="Rotate (Shift: snap to 45°)"
                onpointerdown={(event) => {
                  if (inlineText) {
                    void commitInlineText()
                    return
                  }
                  beginVectorMultiRotate?.(event)
                }}
                onpointermove={(event) => dragVectorObjectRotate?.(event)}
                onpointerup={(event) => {
                  void endVectorObjectRotate?.(event)
                }}
                onpointercancel={(event) => {
                  void endVectorObjectRotate?.(event)
                }}
                onlostpointercapture={(event) => {
                  void endVectorObjectRotate?.(event)
                }}
              ><RotateCw size={14} /></button>
            {/if}
          {/if}
        {/if}
        {#if inlineText}
          <!-- Canvas inline text editor, shared by both modes: focused at the
            click point (vector SVG units or bitmap canvas pixels). Scratch
            parity (TEXT_EDIT_MODE): Enter inserts a newline, plain Escape
            commits, clicking outside commits. During IME composition
            Escape/Enter go to the IME (no commit/blur/shortcut). Typing never
            writes history; commit writes one entry; Cancel discards the
            draft. RTL drafts (strong RTL content or an RTL document) anchor
            the overlay's right edge at the click and grow left with
            `dir="auto"` text; LTR/CJK drafts keep the centered box. OS
            Japanese IME on real hardware is UNCONFIRMED in CI. -->
          <div
            data-inline-text-editor
            dir={inlineTextDirection}
            class={`absolute z-10 w-max max-w-[80%] rounded border-2 border-blue-500 bg-white shadow-lg ${inlineTextDirection === 'rtl' ? '-translate-x-full -translate-y-1/2' : '-translate-x-1/2 -translate-y-1/2'}`}
            style={inlineTextStyle()}
          >
            <textarea
              class="block min-h-10 min-w-44 bg-transparent px-2 py-1 leading-snug text-slate-900 outline-none"
              dir="auto"
              style={`font-family:${previewTextFontFamily()};text-align:start;`}
              rows={Math.min(5, Math.max(1, inlineText.draft.split('\n').length))}
              placeholder="Type text… (Enter: new line, Esc: done)"
              aria-label={inlineText.mode === 'vector' && inlineText.targetIndex !== undefined ? 'Edit vector text' : inlineText.mode === 'vector' ? 'New vector text' : 'New bitmap text'}
              bind:value={inlineText.draft}
              use:focusInlineText
              onkeydown={handleInlineTextKeydown}
              oncompositionstart={handleInlineTextCompositionStart}
              oncompositionend={handleInlineTextCompositionEnd}
            ></textarea>
            <div class="flex items-center justify-end gap-1 border-t border-slate-200 bg-slate-50 px-1 py-1">
              <button
                class="rounded bg-[#8d5de8] px-2 py-0.5 text-xs font-bold text-white disabled:opacity-40"
                aria-label="Commit text"
                disabled={inlineTextCommitting}
                onclick={() => void commitInlineText()}
              >確定</button>
              <button
                class="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-bold text-slate-600 disabled:opacity-40"
                aria-label="Cancel text editing"
                disabled={inlineTextCommitting}
                onclick={cancelInlineText}
              >取消</button>
            </div>
          </div>
        {/if}
      </div>
      {#if loupeLayout}
        <!-- Eyedropper loupe: fixed-positioned outside the scaled surface so its
          CSS size stays constant across zoom and it overlays outside the
          artwork centered on the cursor. pointer-events:none keeps click
          capture on the canvas. -->
        <EyedropperLoupe left={loupeLayout.left} top={loupeLayout.top} cssSize={loupeLayout.cssSize} canvasSize={loupeLayout.canvasSize} pixels={loupeLayout.pixels} blockSize={loupeLayout.blockSize} ringColor={loupeLayout.ringColor} centerColor={loupeLayout.centerColor} />
      {/if}
      <div class="absolute bottom-2 right-3 flex overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
        <button class="flex h-9 w-10 items-center justify-center text-slate-600" aria-label="Zoom out" title="Zoom out" onclick={() => zoomCanvasStep(-1)}><ZoomOut size={17} /></button>
        <button class="flex h-9 w-12 items-center justify-center border-l border-r border-slate-200 text-xs font-semibold text-slate-600" aria-label="Reset zoom" title="Reset zoom" onclick={resetViewport}>{activeUiPercent()}%</button>
        <button class="flex h-9 w-10 items-center justify-center text-slate-600" aria-label="Zoom in" title="Zoom in" onclick={() => zoomCanvasStep(1)}><ZoomIn size={17} /></button>
      </div>
    </div>
  </div>

  <div data-testid="paint-footer" class="paint-footer flex min-h-[48px] shrink-0 items-center gap-3 overflow-visible border-t border-slate-100 px-4">
    {#if costumeEditMode === 'bitmap'}
      <button class="flex items-center gap-2 rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-bold text-white disabled:opacity-40" disabled={bitmapToolbarLocked} title={bitmapLoadingVisible ? 'Loading bitmap…' : 'Convert to vector'} onclick={() => switchCostumeEditMode('vector')}>
        <Image size={18} />
        ベクターに変換
      </button>
      {#if bitmapLoadingVisible}
        <span data-testid="bitmap-workspace-loading" role="status" aria-live="polite" class="text-xs font-semibold text-slate-500">Loading bitmap…</span>
      {/if}
      <button data-testid="save-bitmap-costume" class="ml-auto rounded-md bg-[#8d5de8] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" disabled={bitmapToolbarLocked} title={bitmapLoadingVisible ? 'Loading bitmap…' : 'Save bitmap'} onclick={saveBitmapCostume}>Save bitmap</button>
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
