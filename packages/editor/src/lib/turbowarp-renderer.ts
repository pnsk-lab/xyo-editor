import type { RuntimeSnapshot, ScratchBounds } from '@hikkaku/vm'
import type { RuntimeRenderer } from './runtime-backends'

type Canvas = HTMLCanvasElement | OffscreenCanvas

/** Public operations used from TurboWarp's RenderWebGL (not its private fields). */
export interface TurboWarpRenderer {
  readonly canvas: HTMLCanvasElement
  draw(): void
  resize(width: number, height: number): void
  pick(x: number, y: number, width?: number, height?: number, candidates?: number[]): number
  getBounds(id: number): { left: number; right: number; top: number; bottom: number } | null
  getFencedPositionOfDrawable(id: number, position: [number, number]): [number, number]
}

/** A live mapping, including clones, in renderer layer order (back to front). */
export interface TurboWarpDrawableTarget {
  targetId: string
  drawableId: number
  isStage?: boolean
}

export interface TurboWarpRendererOptions {
  /** Must update the official renderer's drawables and skins for this snapshot.
   * An official TurboWarp VM already owning these objects can provide a synchronizer
   * appropriate to that VM. A hikkaku snapshot is not itself a renderer scene. */
  syncSnapshot(renderer: TurboWarpRenderer, snapshot: RuntimeSnapshot): void
  getTargets(): readonly TurboWarpDrawableTarget[]
  /** Invalidate the scene owner's costume cache without breaking live skins. */
  clearCachedCostumes?: () => void
  /** Release resources owned by the caller, if any. RenderWebGL has no public dispose. */
  dispose?: (renderer: TurboWarpRenderer) => void
}

/**
 * Adapt the official browser RenderWebGL to the editor's renderer surface.
 * RenderWebGL creates its WebGL context in its constructor and cannot move it to
 * another canvas. The constructor is deferred until the first attachCanvas call.
 * The host must synchronize scene state and supply live target/drawable mappings;
 * neither can be derived from RenderWebGL alone.
 *
 * https://github.com/TurboWarp/scratch-render/blob/develop/src/RenderWebGL.js
 */
export function createTurboWarpRenderer(
  Renderer: new (canvas: HTMLCanvasElement) => TurboWarpRenderer,
  options: TurboWarpRendererOptions,
): RuntimeRenderer {
  let renderer: TurboWarpRenderer | undefined
  let disposed = false
  const requireRenderer = () => {
    if (disposed) throw new Error('TurboWarp renderer adapter is disposed')
    if (!renderer) throw new Error('Attach a canvas before using the TurboWarp renderer')
    return renderer
  }
  const drawable = (id: string | number): number | undefined => typeof id === 'number'
    ? id : options.getTargets().find((target) => target.targetId === id)?.drawableId
  const dimensions = (r: TurboWarpRenderer) => {
    const width = r.canvas.clientWidth
    const height = r.canvas.clientHeight
    if (!(width > 0 && height > 0)) throw new Error('TurboWarp picking requires a canvas with nonzero CSS dimensions')
    return [width, height] as const
  }
  return {
    attachCanvas(canvas: Canvas) {
      if (disposed) throw new Error('TurboWarp renderer adapter is disposed')
      if (renderer) {
        if (renderer.canvas !== canvas) throw new Error('TurboWarp renderer cannot be moved to another canvas')
        return
      }
      // RenderWebGL depends on HTML canvas clientWidth, DOM events and window.
      if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('TurboWarp renderer requires an HTMLCanvasElement; OffscreenCanvas is unsupported')
      }
      renderer = new Renderer(canvas)
      if (renderer.canvas !== canvas) throw new Error('TurboWarp renderer was constructed with a different canvas')
    },
    requestDraw(snapshot) {
      const r = requireRenderer()
      options.syncSnapshot(r, snapshot)
      r.draw()
    },
    resize(width, height) { requireRenderer().resize(width, height) },
    pick(x, y, touchWidth = 1, touchHeight = 1, candidateIds) {
      const r = requireRenderer()
      const [width, height] = dimensions(r)
      const targets = options.getTargets().filter((target) => !target.isStage && (!candidateIds || candidateIds.includes(target.targetId)))
      if (!targets.length) return null
      // Editor coordinates are centered Scratch units (+y up); TurboWarp uses
      // CSS pixels relative to the canvas (+y down), independent of devicePixelRatio.
      const id = r.pick((x + 240) * width / 480, (180 - y) * height / 360,
        touchWidth * width / 480, touchHeight * height / 360, targets.map((target) => target.drawableId))
      return targets.find((target) => target.drawableId === id)?.targetId ?? null
    },
    getBounds(id): ScratchBounds | null {
      const r = requireRenderer()
      const mapped = drawable(id)
      if (mapped === undefined) return null
      const bounds = r.getBounds(mapped)
      if (!bounds) return null
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
        width: bounds.right - bounds.left, height: bounds.top - bounds.bottom }
    },
    getFencedPositionOfDrawable(id, position) {
      const r = requireRenderer()
      const mapped = drawable(id)
      // The scene may be reloading during a drag. RenderWebGL itself leaves
      // positions unchanged when a drawable is missing; mirror that behavior.
      if (mapped === undefined) return position
      return r.getFencedPositionOfDrawable(mapped, position)
    },
    clearCachedCostumes() {
      // Skins belong to the external VM/scene owner. Destroying them here would
      // invalidate live drawable IDs; silently doing nothing would be misleading.
      if (!options.clearCachedCostumes) throw new Error('TurboWarp costume cache is owned by the scene synchronizer')
      options.clearCachedCostumes()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (renderer) options.dispose?.(renderer)
    },
  }
}
