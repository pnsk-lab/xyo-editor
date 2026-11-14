<script lang="ts">
  import type { VectorObjectInfo, VectorPathPointInfo } from '../../lib/editor-types'
  import { editableVectorUnits } from '../costumes/vector-svg'
  import { sanitizeSvgForDisplay } from '../costumes/svg-sanitize'
  import { liveReshapeActionIndices } from '../costumes/vector-reshape-handle-masks'

  let { svg, object, left, top, scale, zoom, width, height, begin, move, end, selectedPointIndex = undefined, selectedPointIndices = undefined, selectedHandleMasks = undefined, selectedLeafIndices = undefined, onSelectPoint = undefined, onSelectPoints = undefined, onTogglePoint = undefined, addAtClient = undefined, selectLeafAtClient = undefined, beginLeafTranslateAtClient = undefined, moveLeafTranslate = undefined, endLeafTranslate = undefined, deleteAt = undefined, deleteSelectionAt = undefined }: {
    svg: string
    object: VectorObjectInfo
    left: number
    top: number
    scale: number
    zoom: number
    width: number
    height: number
    begin: (object: VectorObjectInfo, index: number, event: PointerEvent) => void
    move?: (event: PointerEvent) => void
    end?: (event: PointerEvent) => void
    selectedPointIndex?: number | undefined
    selectedPointIndices?: number[] | undefined
    selectedHandleMasks?: Record<number, number> | undefined
    selectedLeafIndices?: number[] | undefined
    onSelectPoint?: (index: number | undefined) => void
    onSelectPoints?: (indices: number[]) => void
    onTogglePoint?: (index: number, append: boolean) => void
    addAtClient?: (clientX: number, clientY: number) => void
    selectLeafAtClient?: (clientX: number, clientY: number, append: boolean) => boolean | Promise<boolean>
    beginLeafTranslateAtClient?: (clientX: number, clientY: number, event: PointerEvent, append: boolean) => boolean | Promise<boolean>
    moveLeafTranslate?: (event: PointerEvent) => void
    endLeafTranslate?: (event: PointerEvent) => void | Promise<void>
    deleteAt?: (index: number) => void
    deleteSelectionAt?: (indices: number[]) => void
  } = $props()

  let selectedAnchor = $state<number | undefined>(undefined)
  let selectedAnchors = $state<number[]>([])
  let selectedObjectIndex = $state<number | undefined>()
  let container = $state<HTMLDivElement | undefined>()
  let nearestIndex = $state<number | undefined>()
  let activeIndex = $state<number | undefined>()
  let rafId = 0
  // Screen-space radius inside which the closest handle pops larger, so the
  // next drag target is visible before the pointer reaches it.
  const NEAREST_THRESHOLD_PX = 48
  $effect(() => {
    if (object.index !== selectedObjectIndex) {
      selectedObjectIndex = object.index
      setSelectedAnchors([])
      nearestIndex = undefined
      activeIndex = undefined
    }
  })
  // Controlled selection from the editor (global Delete uses it). Both the
  // legacy single prop and the multi array are honored; props stay the source
  // of truth for mount and later updates such as curve-click select or
  // post-mutation remaps. Internal state mirrors them for highlight.
  const controlledSelection = $derived(
    selectedPointIndices !== undefined
      ? [...selectedPointIndices]
      : selectedPointIndex !== undefined
        ? [selectedPointIndex]
        : [],
  )
  $effect(() => {
    const next = [...controlledSelection].sort((a, b) => a - b)
    const current = [...selectedAnchors].sort((a, b) => a - b)
    if (next.length !== current.length || next.some((value, offset) => value !== current[offset])) {
      selectedAnchors = next
      selectedAnchor = next[0]
    }
  })
  // A style/mutation (curved/pointed/add/delete/undo) can shift flattened
  // indices or remove anchors entirely. If a selected index no longer
  // resolves to a live anchor, drop it (multi-aware) so a stale point never
  // blocks object-level Delete nor enables Curved/Pointed for a missing point.
  $effect(() => {
    if (selectedAnchors.length === 0) {
      if (selectedAnchor !== undefined) selectedAnchor = undefined
      return
    }
    const live = selectedAnchors.filter((index) => points.some((point) => point.index === index && point.kind !== 'control'))
    if (live.length !== selectedAnchors.length) setSelectedAnchors(live)
    else if (selectedAnchor !== selectedAnchors[0]) selectedAnchor = selectedAnchors[0]
  })

  function setSelectedAnchor(index: number | undefined) {
    setSelectedAnchors(index === undefined ? [] : [index])
  }

  function setSelectedAnchors(indices: number[]) {
    const next = [...new Set(indices.filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b)
    selectedAnchors = next
    selectedAnchor = next[0]
    onSelectPoints?.(next)
    onSelectPoint?.(next[0])
  }

  function toggleSelectedAnchor(index: number, append: boolean) {
    if (!Number.isInteger(index) || index < 0) return
    if (onTogglePoint) {
      onTogglePoint(index, append)
      return
    }
    if (!append) {
      setSelectedAnchors([index])
      return
    }
    // Legacy single-prop fallback: Shift+click toggles in/out locally.
    if (selectedAnchors.includes(index)) setSelectedAnchors(selectedAnchors.filter((item) => item !== index))
    else setSelectedAnchors([...selectedAnchors, index])
  }

  function outlineMarkup(source: string, index: number) {
    if (!source) return ''
    // Trust boundary: the reshape outline is rendered via `{@html}`, so
    // sanitize the incoming preview SVG first and the built outline again.
    const clean = sanitizeSvgForDisplay(source)
    const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
    const root = doc.documentElement
    if (root.localName !== 'svg') return ''
    if (doc.getElementsByTagName('parsererror').length > 0) return ''
    const selected = editableVectorUnits(root)[index]
    if (!selected) return ''
    // Keep only the selected subtree: prune siblings at every level from the
    // selection up to the svg root (the selection may be nested in groups).
    let node: Element | null = selected
    while (node && node !== root) {
      const parent: Element | null = node.parentElement
      if (!parent) break
      for (const child of Array.from(parent.children)) if (child !== node) (child as Element).remove()
      node = parent
    }
    for (const element of [selected, ...Array.from(selected.querySelectorAll('*'))]) {
      if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(element.localName)) continue
      element.setAttribute('style', 'fill:none!important;stroke:#00a8ed!important;stroke-width:1!important;opacity:1!important;vector-effect:non-scaling-stroke')
    }
    root.setAttribute('width', '100%')
    root.setAttribute('height', '100%')
    return sanitizeSvgForDisplay(new XMLSerializer().serializeToString(root))
  }

  const outline = $derived(sanitizeSvgForDisplay(outlineMarkup(svg, object.index)))
  // Group reshape shows the flattened leaf anchors of the whole `<g>` unit
  // (rect/ellipse/line leaves are pathized in the Paper import, same ordering
  // as the move/add/delete helpers). A leaf click (curve/fill area, not a
  // handle) first resolves one child shape with a real Paper.js `hitTest`
  // (topmost wins, never a bbox guess) and narrows the anchor selection to
  // exactly that leaf's anchors — Shift toggles leaves in/out. Curve clicks
  // that miss every leaf fall through to point-add; unsupported units
  // (text/raster/clip/compound/ambiguous) stay fail-closed with no selection
  // change. `selectedLeafIndices` is advisory state owned by the editor.
  const points = $derived(object.points ?? [])
  // Paper-truth handle masks (1 point, 2 in, 4 out). When provided, they are
  // the display source of truth: explicit anchors are 7, curve pairs are
  // start 5 / end 3. When absent (legacy callers), fall back to both-handles
  // for every selected anchor so older tests keep passing.
  const maskMap = $derived(selectedHandleMasks ?? {})
  const hasMasks = $derived(selectedHandleMasks !== undefined)
  const maskOf = (flat: number): number => {
    const raw = (maskMap as Record<number, number>)[flat]
    return typeof raw === 'number' && Number.isInteger(raw) ? raw & 7 : 0
  }
  const selectedSet = $derived(new Set(selectedAnchors))
  const isAnchorPressed = (flat: number): boolean => {
    if (hasMasks) return (maskOf(flat) & 1) !== 0
    return selectedSet.has(flat)
  }
  const isControlVisible = (point: VectorPathPointInfo): boolean => {
    if (point.kind !== 'control' || point.relatedAnchorIndex === undefined) return false
    if (hasMasks) {
      const mask = maskOf(point.relatedAnchorIndex)
      if (point.controlRole === 'in') return (mask & 2) !== 0
      if (point.controlRole === 'out') return (mask & 4) !== 0
      return (mask & 1) !== 0
    }
    return selectedSet.has(point.relatedAnchorIndex)
  }
  const controls = $derived(points.filter((point) => isControlVisible(point)))
  // Display points: anchors always; controls only when their Paper-truth bit
  // is set (curve-selected anchors show only the attached handle).
  const displayPoints = $derived(points.filter((point) => point.kind !== 'control').concat(controls))
  // While dragging, keep the grabbed handle enlarged; otherwise emphasize the
  // handle closest to the pointer.
  const emphasizedIndex = $derived(activeIndex ?? nearestIndex)
  $effect(() => {
    if (nearestIndex !== undefined && !displayPoints.some((point) => point.index === nearestIndex)) {
      nearestIndex = undefined
    }
    if (activeIndex !== undefined && !displayPoints.some((point) => point.index === activeIndex)) {
      activeIndex = undefined
    }
  })
  function position(point: VectorPathPointInfo, emphasized: boolean) {
    return `left:${left + point.x * scale}px;top:${top + point.y * scale}px;transform:translate(-50%, -50%) scale(${1 / zoom});z-index:${emphasized ? 10 : 1};`
  }
  function handleClass(point: VectorPathPointInfo, emphasized: boolean) {
    const base = 'block transition-all duration-100'
    if (point.kind === 'control') {
      return emphasized
        ? `${base} h-3.5 w-3.5 rotate-45 border-2 border-[#00a8ed] bg-white shadow-[0_0_0_2px_white]`
        : `${base} h-2 w-2 rotate-45 border border-[#00a8ed] bg-white`
    }
    return emphasized
      ? `${base} h-4 w-4 rounded-full bg-[#00a8ed] shadow-[0_0_0_2px_white,0_0_0_3px_#00a8ed]`
      : `${base} h-2 w-2 rounded-full bg-[#00a8ed]`
  }
  function updateNearestFromClient(clientX: number, clientY: number) {
    if (!container) {
      nearestIndex = undefined
      return
    }
    const elements = container.querySelectorAll('[data-vector-path-point]')
    let best: number | undefined
    let bestDistance = NEAREST_THRESHOLD_PX
    for (const element of elements) {
      const rect = (element as HTMLElement).getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const distance = Math.hypot(clientX - centerX, clientY - centerY)
      if (distance < bestDistance) {
        bestDistance = distance
        best = Number((element as HTMLElement).dataset.pointIndex)
      }
    }
    nearestIndex = best
  }
  function scheduleNearestUpdate(event: PointerEvent) {
    if (event.pointerType === 'touch' && event.buttons === 0 && event.type !== 'pointerdown') return
    const clientX = event.clientX
    const clientY = event.clientY
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      rafId = 0
      updateNearestFromClient(clientX, clientY)
    })
  }
  function start(point: VectorPathPointInfo, event: PointerEvent) {
    // Selection ownership lives in `begin` (the editor): Shift+click toggles
    // the anchor in/out, a plain press on an unselected anchor replaces the
    // selection, and a plain press on an already-selected anchor keeps the
    // set so the drag moves every selected anchor together. Control handles
    // never change the anchor selection: they drag alone (bulk moves are
    // anchor-only). This handler only gives immediate local feedback; the
    // authoritative set flows back through the selection props.
    activeIndex = point.index
    nearestIndex = point.index
    begin(object, point.index, event)
  }
  function handleDoubleClick(point: VectorPathPointInfo, event: MouseEvent) {
    if (point.kind === 'control') return
    event.preventDefault()
    event.stopPropagation()
    setSelectedAnchors([point.index])
    deleteAt?.(point.index)
  }
  async function handleCurvePointerDown(event: PointerEvent) {
    // Curve clicks add a point; stop them reaching the canvas marquee/object
    // drag so a click never writes an extra history entry.
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // Whole-leaf translate drag first for mixed groups (text/image): press
    // selects the leaf and starts the atomic translate drag in one gesture so
    // press-move-release moves the leaf. A miss falls through to the anchor
    // leaf path below. No history on click-select; one entry on real moves.
    if (beginLeafTranslateAtClient && object.tag === 'g') {
      try {
        const append = event.shiftKey === true || event.metaKey === true || event.ctrlKey === true
        const handled = await beginLeafTranslateAtClient(event.clientX, event.clientY, event, append)
        if (handled === true) return
      } catch {
        // Fall through to the anchor leaf path on probe failure.
      }
    }
    // Group-leaf subselect first: a fill/stroke/curve hit on one child shape
    // narrows the anchors to that leaf (Shift toggles). A miss (or an
    // unsupported unit) falls through to point-add, which no-ops honestly.
    if (selectLeafAtClient && object.tag === 'g') {
      try {
        const append = event.shiftKey === true || event.metaKey === true || event.ctrlKey === true
        const hit = await selectLeafAtClient(event.clientX, event.clientY, append)
        if (hit === true) return
      } catch {
        // Fall through to point-add on probe failure.
      }
    }
    addAtClient?.(event.clientX, event.clientY)
  }
  function handleCurvePointerMove(event: PointerEvent) {
    try {
      moveLeafTranslate?.(event)
    } catch {
      // Best-effort preview; the drag tracks by pointer id.
    }
  }
  function handleCurvePointerUp(event: PointerEvent) {
    try {
      const result = endLeafTranslate?.(event)
      if (result instanceof Promise) void result.catch(() => undefined)
    } catch {
      // Best-effort commit; no history on failure.
    }
  }
  function handleCurvePointerCancel(event: PointerEvent) {
    try {
      const result = endLeafTranslate?.(event)
      if (result instanceof Promise) void result.catch(() => undefined)
    } catch {
      // Cancel restores the snapshot without history.
    }
  }
  function selectedAnchorPoint() {
    return points.find((point) => point.index === selectedAnchor && point.kind !== 'control')
  }
  // Action-only selection (Paper `segment.selected` parity): every mask bit
  // counts, so latent handle-only 2/4/6 anchors delete/nudge/drag together.
  // Display/pressed stay on the point-bit projection; this helper is only for
  // the overlay delete affordance so it matches the Delete key (reference).
  const actionAnchors = $derived(
    hasMasks ? liveReshapeActionIndices(points, maskMap as Record<number, number>) : [...selectedAnchors],
  )
  function actionAnchorPoint() {
    const first = actionAnchors[0]
    if (first === undefined) return undefined
    return points.find((point) => point.index === first && point.kind !== 'control')
  }
  function deleteSelectedPoints() {
    const targets = hasMasks ? [...actionAnchors] : [...selectedAnchors]
    if (targets.length === 0) return
    if (deleteSelectionAt && targets.length > 1) {
      deleteSelectionAt(targets)
      return
    }
    const single = targets[0]
    if (single !== undefined) deleteAt?.(single)
  }
  // Hit layer covers only the selected object (expanded by the add tolerance)
  // so empty-canvas clicks still reach the marquee/object handlers. Geometry
  // itself is validated by the helper's nearest-curve tolerance; misses are
  // no-ops without history.
  const hitBounds = $derived(() => {
    const pad = 10
    const bx = object.boundsX ?? object.x
    const by = object.boundsY ?? object.y
    const bw = object.boundsWidth ?? object.width
    const bh = object.boundsHeight ?? object.height
    if ([bx, by, bw, bh].every((value) => Number.isFinite(value as number)) && (bw as number) > 0 && (bh as number) > 0) {
      return { x: (bx as number) - pad, y: (by as number) - pad, width: (bw as number) + pad * 2, height: (bh as number) + pad * 2 }
    }
    if (points.length > 0) {
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      return {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2,
        height: Math.max(...ys) - Math.min(...ys) + pad * 2,
      }
    }
    return { x: 0, y: 0, width, height }
  })
  const hitStyle = $derived(
    `left:${left + hitBounds().x * scale}px;top:${top + hitBounds().y * scale}px;width:${Math.max(24, hitBounds().width * scale)}px;height:${Math.max(24, hitBounds().height * scale)}px;pointer-events:auto;cursor:copy;`,
  )
  function finish(event: PointerEvent) {
    activeIndex = undefined
    updateNearestFromClient(event.clientX, event.clientY)
    end?.(event)
  }
  function cancel(event: PointerEvent) {
    // pointercancel is a cancel, not a commit: forward the event so the
    // editor can restore the pre-drag snapshot without touching history.
    activeIndex = undefined
    end?.(event)
  }
</script>

<svelte:window onpointermove={scheduleNearestUpdate} onpointerup={() => { activeIndex = undefined }} onpointercancel={() => { activeIndex = undefined }} />

<div bind:this={container} class="pointer-events-none absolute inset-0">
  <div class="pointer-events-none absolute" style={`left:${left}px;top:${top}px;width:${width * scale}px;height:${height * scale}px;`} aria-hidden="true">
    {@html outline}
  </div>
  <div
    class="absolute"
    data-reshape-curve-layer
    data-vector-object
    style={hitStyle}
    aria-hidden="true"
    onpointerdown={handleCurvePointerDown}
    onpointermove={handleCurvePointerMove}
    onpointerup={handleCurvePointerUp}
    onpointercancel={handleCurvePointerCancel}
    onlostpointercapture={handleCurvePointerCancel}
  ></div>
  <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
    {#each controls as point}
      {@const anchor = points.find((item) => item.index === point.relatedAnchorIndex && item.kind !== 'control')}
      {#if anchor}
        <line x1={left + anchor.x * scale} y1={top + anchor.y * scale} x2={left + point.x * scale} y2={top + point.y * scale} stroke="#00a8ed" stroke-width="1" vector-effect="non-scaling-stroke" />
      {/if}
    {/each}
  </svg>
  {#each displayPoints as point (point.index)}
    {@const emphasized = emphasizedIndex === point.index}
    {@const selected = point.kind === 'control'
      ? (point.relatedAnchorIndex !== undefined &&
        (hasMasks
          ? (point.controlRole === 'in'
            ? (maskOf(point.relatedAnchorIndex) & 2) !== 0
            : (maskOf(point.relatedAnchorIndex) & 4) !== 0)
          : selectedSet.has(point.relatedAnchorIndex)))
      : isAnchorPressed(point.index)}
    <button
      data-vector-object
      data-vector-path-point
      data-point-index={point.index}
      class="pointer-events-auto absolute flex h-5 w-5 cursor-move items-center justify-center border-0 bg-transparent p-0"
      style={`${position(point, emphasized || selected)}${selected ? 'outline:2px solid #00a8ed;outline-offset:1px;border-radius:9999px;' : ''}`}
      aria-label={point.kind === 'control' ? `Move control point ${point.index + 1} (double-click does nothing)` : `Move path point ${point.index + 1} (double-click deletes)`}
      aria-pressed={selected}
      onpointerdown={(event) => start(point, event)}
      onpointermove={(event) => { scheduleNearestUpdate(event); move?.(event) }}
      onpointerup={finish}
      onpointercancel={cancel}
      ondblclick={(event) => handleDoubleClick(point, event)}
      onfocus={() => { nearestIndex = point.index; if (point.kind !== 'control' && !selectedSet.has(point.index)) toggleSelectedAnchor(point.index, false) }}
      onblur={() => { if (nearestIndex === point.index) nearestIndex = undefined }}
    ><span class={handleClass(point, emphasized || selected)}></span></button>
  {/each}
  {#if actionAnchorPoint()}
    {@const selectedPoint = actionAnchorPoint()!}
    <button
      data-vector-object
      data-testid="delete-reshape-point"
      class="pointer-events-auto absolute rounded bg-white px-2 py-1 text-xs font-bold text-red-600 shadow ring-1 ring-red-300 hover:bg-red-50"
      style={`left:${left + selectedPoint.x * scale}px;top:${Math.max(0, top + selectedPoint.y * scale - 34)}px;z-index:20;transform:translate(-50%,0);`}
      aria-label={actionAnchors.length > 1 ? `Delete ${actionAnchors.length} selected points` : `Delete selected point ${actionAnchors[0]! + 1}`}
      onclick={(event) => { event.stopPropagation(); deleteSelectedPoints() }}
    >{actionAnchors.length > 1 ? `Delete ${actionAnchors.length} points` : 'Delete point'}</button>
  {/if}
</div>
