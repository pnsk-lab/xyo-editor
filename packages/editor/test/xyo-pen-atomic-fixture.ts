import { ScratchCanvasRenderer, type PenLine } from '@hikkaku/vm'

/** Browser canvas fault injection: no mocked renderer or fake drawing context. */
export function exerciseAtomicPenFailure() {
  const renderer = new ScratchCanvasRenderer()
  const stage = document.createElement('canvas')
  stage.width = 960
  stage.height = 720
  renderer.attachCanvas(stage)
  const line = (y: number, color: string): PenLine => ({
    x1: -50,
    y1: y,
    x2: 50,
    y2: y,
    size: 5,
    transparency: 0,
    color,
  })
  renderer.penBatchAtomic([{ type: 'line', line: line(0, '#ff0000') }])
  const internal = renderer as unknown as {
    penCanvas: HTMLCanvasElement
    pendingPenLines: PenLine[]
  }
  const originalCanvas = internal.penCanvas
  const pixel = () => originalCanvas.toDataURL()
  const before = pixel()
  renderer.penLine(line(15, '#00ff00'))
  const previous = CanvasRenderingContext2D.prototype.stroke
  let strokes = 0,
    message = ''
  try {
    CanvasRenderingContext2D.prototype.stroke = function (...args: Parameters<typeof previous>) {
      if (++strokes === 2) throw new Error('injected stroke failure')
      return previous.apply(this, args)
    }
    try {
      renderer.penBatchAtomic([{ type: 'line', line: line(-15, '#0000ff') }])
    } catch (error) {
      message = (error as Error).message
    }
  } finally {
    CanvasRenderingContext2D.prototype.stroke = previous
  }
  const preserved =
    internal.penCanvas === originalCanvas &&
    pixel() === before &&
    internal.pendingPenLines.length === 1
  renderer.resize(240, 180)
  renderer.penBatchAtomic([{ type: 'line', line: line(-15, '#0000ff') }])
  const committed =
    internal.penCanvas !== originalCanvas &&
    internal.pendingPenLines.length === 0 &&
    internal.penCanvas.toDataURL() !== before
  const dimensions = [internal.penCanvas.width, internal.penCanvas.height]
  renderer.penLine(line(30, '#ffffff'))
  const create = document.createElement
  let discardSucceeded = false
  try {
    document.createElement = (() => {
      throw new Error('unexpected allocation')
    }) as typeof document.createElement
    renderer.discardPenLayer()
    discardSucceeded = !internal.penCanvas && internal.pendingPenLines.length === 0
  } finally {
    document.createElement = create
  }
  renderer.dispose()
  return {
    message,
    strokes,
    preserved,
    committed,
    dimensions,
    stageDimensions: [stage.width, stage.height],
    discardSucceeded,
  }
}
