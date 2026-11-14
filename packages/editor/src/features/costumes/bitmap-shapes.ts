type Point = { x: number; y: number }

export function drawBitmapShape(
  context: CanvasRenderingContext2D,
  shape: 'line' | 'rect' | 'oval',
  start: Point,
  end: Point,
  strokeWidth: number,
) {
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  const hasStroke = Number.isFinite(strokeWidth) && strokeWidth > 0
  if (hasStroke) context.lineWidth = strokeWidth

  if (shape === 'line') {
    if (!hasStroke) return
    context.beginPath()
    context.moveTo(start.x, start.y)
    context.lineTo(end.x, end.y)
    context.stroke()
  } else if (shape === 'rect') {
    context.fillRect(left, top, width, height)
    if (hasStroke) context.strokeRect(left, top, width, height)
  } else {
    context.beginPath()
    context.ellipse(left + width / 2, top + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2)
    context.fill()
    if (hasStroke) context.stroke()
  }
}
