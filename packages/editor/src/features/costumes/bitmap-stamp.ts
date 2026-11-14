// Shared bitmap stamp footprint for the brush and the eraser.
// The ellipse implementation was moved from bitmap-eraser.ts and is derived
// from Scratch Paint's bitmap helper (AGPL-3.0-only); review its provenance
// and distribution obligations before release.
//
// Both tools stamp a pre-rendered mark along a Bresenham line: solid squares
// at diameters of 5 or less, and a crisp pixel disc above that. The disc is
// drawn by stepping a sheared ellipse with integer `fillRect` spans, so every
// stamp pixel stays fully opaque (no anti-aliasing) and the brush and eraser
// footprints cancel exactly at the same diameter and anchor.
function solveQuadratic(a: number, b: number, c: number): [number, number] {
  const discriminant = b * b - 4 * a * c;
  const root = Math.sqrt(discriminant);
  const soln1 = (-b + root) / 2 / a;
  const soln2 = (-b - root) / 2 / a;
  return soln1 > soln2 ? [soln1, soln2] : [soln2, soln1];
}

export type ShearedEllipseOptions = {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  shearSlope: number;
  isFilled: boolean;
  drawFn?: (x: number, y: number) => void;
};

export function drawShearedEllipse(options: ShearedEllipseOptions, context: CanvasRenderingContext2D): boolean {
  const centerX = ~~options.centerX;
  const centerY = ~~options.centerY;
  const radiusX = ~~Math.abs(options.radiusX) - 0.5;
  const radiusY = ~~Math.abs(options.radiusY) - 0.5;
  const shearSlope = options.shearSlope;
  const isFilled = options.isFilled;
  const drawFn = options.drawFn;
  if (shearSlope === Infinity || radiusX < 1 || radiusY < 1) return false;

  const A = 1 / radiusX / radiusX + (shearSlope * shearSlope) / radiusY / radiusY;
  const B = (-2 * shearSlope) / radiusY / radiusY;
  const C = 1 / radiusY / radiusY;
  const slope1 = (-2 * A - B) / (2 * C + B);
  const slope2 = (-2 * A + B) / (-2 * C + B);
  const verticalStepsFirst = slope1 > slope2;

  const drawStepVertical = (startY: number, condition: (x: number, y: number) => boolean) => {
    let y = startY;
    let x = solveQuadratic(A, B * y, C * y * y - 1);
    let pY = 0;
    let pX1 = 0;
    let pX2 = 0;
    let drew = false;
    while (condition(x[0]!, y)) {
      pY = Math.floor(y);
      pX1 = Math.floor(x[0]!);
      pX2 = Math.floor(x[1]!);
      drew = true;
      if (isFilled) {
        context.fillRect(centerX - pX1 - 1, centerY + pY, pX1 - pX2 + 1, 1);
        context.fillRect(centerX + pX2, centerY - pY - 1, pX1 - pX2 + 1, 1);
      } else {
        drawFn?.(centerX - pX1 - 1, centerY + pY);
        drawFn?.(centerX + pX1, centerY - pY - 1);
      }
      y -= 1;
      x = solveQuadratic(A, B * y, C * y * y - 1);
    }
    return drew ? { x: pX1, y: pY } : null;
  };

  const drawStepHorizontal = (startX: number, condition: (x: number, y: [number, number]) => boolean) => {
    let x = startX;
    let y = solveQuadratic(C, B * x, A * x * x - 1);
    let pX = 0;
    let pY1 = 0;
    let pY2 = 0;
    let drew = false;
    while (condition(x, y)) {
      pX = Math.floor(x);
      pY1 = Math.floor(y[0]!);
      pY2 = Math.floor(y[1]!);
      drew = true;
      if (isFilled) {
        context.fillRect(centerX - pX - 1, centerY + pY2, 1, pY1 - pY2 + 1);
        context.fillRect(centerX + pX, centerY - pY1 - 1, 1, pY1 - pY2 + 1);
      } else {
        drawFn?.(centerX - pX - 1, centerY + pY1);
        drawFn?.(centerX + pX, centerY - pY1 - 1);
      }
      x += 1;
      y = solveQuadratic(C, B * x, A * x * x - 1);
    }
    return drew ? { x: pX, y: pY1 } : null;
  };

  let lastPoint: { x: number; y: number } | null = null;
  if (verticalStepsFirst) {
    const forwardLeaning = slope1 > 0;
    lastPoint = drawStepVertical(forwardLeaning ? -radiusY : radiusY, (x, y) => {
      if (x === 0 && y > 0) return true;
      if (x === 0 && y < 0) return false;
      return y / x > slope1;
    });
    const horizontal = drawStepHorizontal(lastPoint ? -lastPoint.x + 0.5 : 0.5, (x, y) => y[0]! / x > slope2);
    lastPoint = horizontal ?? (lastPoint ? { x: -lastPoint.x - 0.5, y: -lastPoint.y - 0.5 } : null);
    if (lastPoint) {
      drawStepVertical(lastPoint.y - 0.5, (x, y) => {
        if (forwardLeaning) return y > -radiusY;
        return y > radiusY;
      });
    }
  } else {
    lastPoint = drawStepHorizontal(0.5, (x, y) => y[0]! / x > slope2);
    const vertical =
      drawStepVertical(lastPoint ? lastPoint.y - 0.5 : radiusY, (x, y) => {
        if (x === 0 && y > 0) return true;
        if (x === 0 && y < 0) return false;
        return y / x > slope1;
      }) ?? lastPoint;
    lastPoint = vertical;
    if (lastPoint) drawStepHorizontal(-lastPoint.x + 0.5, (x) => x < 0);
  }
  return true;
}

/** Fill a crisp disc stamp for the given diameter with the current fillStyle. */
export function fillStampDisc(context: CanvasRenderingContext2D, diameter: number): void {
  drawShearedEllipse(
    {
      centerX: diameter / 2,
      centerY: diameter / 2,
      radiusX: diameter / 2,
      radiusY: diameter / 2,
      shearSlope: 0,
      isFilled: true,
    },
    context,
  );
}

/** Draw the 1px guide outline for the eraser stamp with the current fillStyle. */
export function outlineStampDisc(context: CanvasRenderingContext2D, diameter: number): void {
  drawShearedEllipse(
    {
      centerX: diameter / 2,
      centerY: diameter / 2,
      radiusX: diameter / 2,
      radiusY: diameter / 2,
      shearSlope: 0,
      isFilled: false,
      drawFn: (x, y) => context.fillRect(x, y, 1, 1),
    },
    context,
  );
}
