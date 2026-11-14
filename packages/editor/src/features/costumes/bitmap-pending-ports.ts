import { compositePendingBitmapShapePreview } from './bitmap-pending-shape-preview'
import type { PendingBitmapShape } from './bitmap-pending-shape'
import type {
  BitmapPendingSessionHistoryPorts,
  BitmapPendingHistoryReservation,
  BitmapPendingSessionCanvasPorts,
} from './bitmap-pending-session'

/**
 * Editor canvas/history ports for the pending rect/oval session (B-3).
 *
 * Focused feature helper (AGENTS split): builds the injected
 * `CanvasPorts` / `HistoryPorts` the isolated session needs from the live
 * `Editor.svelte` bitmap canvas and paint-history callbacks. No VM import,
 * no Svelte state, no status strings. Every canvas touch is ownership-gated
 * by the session itself (scope + generation + asset + selection tokens and
 * geometry re-read synchronously before the touch); these ports only expose
 * the raw read/paint primitives.
 */

export type EditorHistoryPeek<E> = () => Promise<E | undefined>
export type EditorHistoryCommit<E> = (entry: E) => boolean
export type EditorHistoryDepth = () => number
export type EditorHistoryIsCurrent = () => boolean

export type EditorHistorySource<E> = {
  peek: EditorHistoryPeek<E>
  commit: EditorHistoryCommit<E>
  depth: EditorHistoryDepth
  isCurrent?: EditorHistoryIsCurrent
  /** Optional synchronous removal for the reentrant post-append gate. */
  tryRemove?: (entry: E) => boolean
}

/** Canvas ports bound to one live bitmap canvas element. */
export function createEditorCanvasPorts(canvas: HTMLCanvasElement): BitmapPendingSessionCanvasPorts {
  const context = canvas.getContext('2d')
  return {
    getCanvasSize: () => {
      if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height)) return undefined
      return { width: canvas.width, height: canvas.height }
    },
    captureBase: () => {
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return undefined
        return ctx.getImageData(0, 0, canvas.width, canvas.height)
      } catch {
        return undefined
      }
    },
    paintOverlay: (base: ImageData, shape: PendingBitmapShape) => {
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx || !context) return undefined
        // Single-pass `base + shape` through the shared preview composer
        // (never `live + shape`, so restyles never double-compose).
        return compositePendingBitmapShapePreview(ctx, base, shape) ?? undefined
      } catch {
        return undefined
      }
    },
    restoreBase: (base: ImageData) => {
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.putImageData(base, 0, 0)
        return true
      } catch {
        return false
      }
    },
    rasterize: (base: ImageData, shape: PendingBitmapShape) => {
      // Detached commit raster: never touches the live canvas so a failed
      // encode cannot leave a half pass on screen.
      try {
        const off = document.createElement('canvas')
        off.width = base.width
        off.height = base.height
        const offCtx = off.getContext('2d')
        if (offCtx) return compositePendingBitmapShapePreview(offCtx, base, shape) ?? undefined
      } catch {
        // Fall through to the live-context composite below.
      }
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return undefined
        return compositePendingBitmapShapePreview(ctx, base, shape) ?? undefined
      } catch {
        return undefined
      }
    },
    encodePng: async (image: ImageData) => {
      try {
        const off = document.createElement('canvas')
        off.width = image.width
        off.height = image.height
        const offCtx = off.getContext('2d')
        if (!offCtx) return undefined
        offCtx.putImageData(image, 0, 0)
        if (typeof off.toBlob !== 'function') return undefined
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            off.toBlob((b) => resolve(b), 'image/png')
          } catch {
            resolve(null)
          }
        })
        if (!blob) return undefined
        return new Uint8Array(await blob.arrayBuffer())
      } catch {
        return undefined
      }
    },
  }
}

/**
 * History ports bound to the Editor paint-history side.
 *
 * The reservation mirrors the backend `commit` guard (scope key +
 * generation): `isCurrent()` is re-checked synchronously immediately before
 * the CAS, so a history-side switch/clear blocks the write fail-closed
 * (`history-unavailable`, zero bytes touched) instead of landing
 * un-undoable art. After a landed write (`applied: true`) the append runs
 * synchronously with no await in between; a `false` / throw while still
 * owned is surfaced by the session as `committed-without-history` (never a
 * failure, never reapplied).
 */
export function createEditorHistoryPorts<E>(source: EditorHistorySource<E>): BitmapPendingSessionHistoryPorts<E> {
  let depthBefore = 0
  const isCurrent = (): boolean => {
    try {
      if (typeof source.isCurrent === 'function') return source.isCurrent() !== false
    } catch {
      return false
    }
    return true
  }
  return {
    peek: () => source.peek(),
    commit: (entry: E) => {
      try {
        return source.commit(entry)
      } catch {
        return false
      }
    },
    depth: () => {
      try {
        return source.depth()
      } catch {
        return depthBefore
      }
    },
    isCurrent,
    tryRemove: source.tryRemove,
    beginReservation: (entry: E): BitmapPendingHistoryReservation<E> | undefined => {
      try {
        depthBefore = source.depth()
      } catch {
        depthBefore = 0
      }
      let released = false
      return {
        isCurrent: () => {
          if (released) return false
          return isCurrent()
        },
        commit: () => {
          if (released) return false
          let ok = false
          try {
            ok = source.commit(entry) === true
          } catch {
            ok = false
          }
          released = true
          // Verify the append actually landed when still owned: a stale
          // guard drops the push (returns false), so a concurrent clear
          // cannot be mistaken for a landed entry.
          if (!ok) return false
          try {
            if (!isCurrent()) return false
          } catch {
            return false
          }
          return true
        },
        cancel: () => {
          released = true
        },
      }
    },
  }
}
