import type { RuntimeSnapshot, ScratchCanvasRenderer, ScratchTarget } from '../../../vm/src/index'
import {
  createRendererCallbackTable,
  type RendererCallbacksOptions,
  type RendererScene,
  type RendererWasmModule,
} from '../../../xyo-cpp-wasm/src/renderer_callbacks'

/** The subset of the unified module the renderer bridge needs. */
export interface RendererHostModule extends RendererWasmModule {
  _xyo_browser_target_count(handle: number): number
  _xyo_browser_target_at(handle: number, index: number): number
  _xyo_browser_set_target_drawable(handle: number, target: number, drawable: number): number
  _xyo_browser_internal_snapshot(handle: number): number
  _xyo_browser_renderer_attach(handle: number, table: number, size: number): number
  _xyo_browser_renderer_detach(handle: number): number
}

export interface UnifiedRendererOptions {
  renderer: ScratchCanvasRenderer
  /** Editor model snapshot used to resolve target identities and draw order. */
  snapshot(): RuntimeSnapshot
}

interface LiveTarget {
  id: string
  name: string
  isStage: boolean
  isOriginal: boolean
}

const STAGE_LEFT = -240
const STAGE_RIGHT = 240
const STAGE_TOP = 180
const STAGE_BOTTOM = -180

/**
 * Attaches xyo-cpp's renderer callbacks to the unified runtime so collision
 * sensing and pen reach the editor's renderer.
 *
 * Collision geometry is approximate by contract: `ScratchCanvasRenderer` paints
 * asynchronously and exposes no GPU fence, so `fenceRect` is the stage rectangle
 * and every query is acknowledged as approximate rather than pixel-exact.
 */
export function createUnifiedRendererBridge(m: RendererHostModule, handle: number, options: UnifiedRendererOptions) {
  const { renderer } = options
  const drawables = new Map<number, { scratch: ScratchTarget; id: number }>()
  let attached = false
  const decoder = new TextDecoder()

  const readLiveTargets = (): LiveTarget[] => {
    // Unguarded variant: callbacks run inside another ABI call.
    const pointer = m._xyo_browser_internal_snapshot(handle)
    if (!pointer) return []
    let end = pointer
    while (m.HEAPU8[end]) end++
    const parsed = JSON.parse(decoder.decode(m.HEAPU8.subarray(pointer, end))) as { targets?: LiveTarget[] }
    return Array.isArray(parsed.targets) ? parsed.targets : []
  }

  const scene = (): RendererScene => {
    const snapshot = options.snapshot()
    const live = readLiveTargets()
    const originals = snapshot.project.targets.filter((target) => !target.isClone)
    const targets = []
    for (let index = 0; index < live.length; index++) {
      const runtimeTarget = live[index]!
      const pointer = m._xyo_browser_target_at(handle, index)
      if (!pointer) continue
      // Never skip a runtime target: `drawableOfTarget` returning -1 makes the
      // runtime pass an unknown id back into the other callbacks. Unmatched
      // targets get a synthetic identity carrying the runtime name.
      const scratch = (runtimeTarget.isOriginal
        ? originals.find((candidate) => (runtimeTarget.isStage ? candidate.isStage : candidate.name === runtimeTarget.name))
        : snapshot.project.targets.find((candidate) => candidate.isClone && candidate.name === runtimeTarget.name))
        ?? ({ id: runtimeTarget.name, name: runtimeTarget.name } as ScratchTarget)
      let entry = drawables.get(pointer)
      if (!entry) {
        const id = renderer.createDrawable('sprite')
        if (id < 0) continue
        entry = { scratch, id }
        drawables.set(pointer, entry)
      }
      // The runtime passes Target::drawableID into collision callbacks; without
      // this write-back every query would see -1.
      m._xyo_browser_set_target_drawable(handle, pointer, entry.id)
      entry.scratch = scratch
      targets.push({ targetPointer: pointer, drawableId: entry.id, target: scratch })
    }
    return { snapshot, targets }
  }

  const callbackOptions: RendererCallbacksOptions = {
    renderer,
    sync: scene,
    // No GPU fence is exposed; the stage rectangle is the documented stand-in.
    fenceRect: () => [STAGE_LEFT, STAGE_RIGHT, STAGE_BOTTOM, STAGE_TOP],
    // Mouse coordinates already arrive in Scratch space from the editor canvas.
    pickToScratch: (x, y) => [x, y],
    setDrawableOrder: (drawableId, order, group, relative) => {
      renderer.setDrawableOrder(drawableId, order, group, relative)
      return renderer.getDrawableOrder(drawableId)
    },
    destroyDrawable: (drawableId) => {
      for (const [pointer, entry] of drawables) if (entry.id === drawableId) drawables.delete(pointer)
      renderer.destroyDrawable(drawableId)
    },
    visualChange: () => { /* the snapshot is re-read on every callback */ },
    collisionMode: 'approximate',
  }

  const table = createRendererCallbackTable(m, callbackOptions)
  try {
    if (!m._xyo_browser_renderer_attach(handle, table.table, (21 + 1) * 4)) {
      throw new Error('renderer attach failed')
    }
    attached = true
  } catch (error) {
    table.dispose()
    throw error
  }
  return {
    get attached() { return attached },
    dispose() {
      if (!attached) return
      attached = false
      m._xyo_browser_renderer_detach(handle)
      for (const entry of drawables.values()) renderer.destroyDrawable(entry.id)
      drawables.clear()
      table.dispose()
    },
  }
}
