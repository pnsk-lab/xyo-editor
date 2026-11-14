// True bitmap snap/guide center (clean-room, pure, DOM-free).
//
// The live bitmap canvas can be a union wider than the artboard (e.g. a
// 1000x100 res2 source at center 280,50 grows to a 1200px union whose true
// Scratch center is 480 while canvas.width/2 is 600). Drag snap AND the
// center guide must share the tracked artboard center
// (bitmapArtboard.canvasCenterX/Y), never the apparent canvas middle.
//
// Fail-closed: every unsafe shape returns undefined so callers skip snapping
// and hide the guide instead of guessing (refused workspace, unsettled or
// pending owner, target/index/serial/revision mismatch covering target
// switches / different resolutions / newer loads in flight, live size
// mismatch covering resize races, non-finite centers). Rotation-handle drags
// keep this anchor unchanged (they never snap).

export type BitmapTrueCenterArtboard = {
  width: number
  height: number
  canvasCenterX: number
  canvasCenterY: number
  refused: boolean
}

export type BitmapTrueCenterOwner = {
  targetId: string
  index: number
  loadSerial: number
  revision: number
}

export type BitmapTrueCenterTarget = {
  targetId: string
  index: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function resolveBitmapTrueCenter(input: {
  artboard: BitmapTrueCenterArtboard
  canvasWidth: number
  canvasHeight: number
  owner: BitmapTrueCenterOwner | undefined
  pending: unknown
  serial: number
  revision: number
  target: BitmapTrueCenterTarget | undefined
}): { x: number; y: number } | undefined {
  try {
    const { artboard, canvasWidth, canvasHeight, owner, pending, serial, revision, target } = input
    if (!artboard || artboard.refused === true) return undefined
    if (!owner || pending) return undefined
    if (!target) return undefined
    if (owner.targetId !== target.targetId || owner.index !== target.index) return undefined
    if (owner.loadSerial !== serial || owner.revision !== revision) return undefined
    if (!isFiniteNumber(canvasWidth) || !isFiniteNumber(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) return undefined
    if (artboard.width !== canvasWidth || artboard.height !== canvasHeight) return undefined
    if (!isFiniteNumber(artboard.canvasCenterX) || !isFiniteNumber(artboard.canvasCenterY)) return undefined
    return { x: artboard.canvasCenterX, y: artboard.canvasCenterY }
  } catch {
    return undefined
  }
}
