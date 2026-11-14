<script lang="ts">
  import { EYEDROPPER_LOUPE_CANVAS_SIZE } from '../costumes/eyedropper';

  // Magnifier shown while the dedicated eyedropper is active (clean-room
  // rendering from observed behavior):
  // - `pixels` is a full square block (`size * size` RGBA entries, transparent
  //   padding included by the caller) sampled around the cursor.
  // - The canvas draws the block scaled up with smoothing off, then a 5px
  //   picked-color center cell with a 1px black outline, then a 15px outer
  //   ring in the picked color so the active color reads at a glance.
  // - The element is fixed-positioned centered on the cursor (parent passes
  //   client-centered screen px), with a 1px border and circular clipping.
  // - Fully transparent centers read as empty: the canvas starts white and
  //   transparent source pixels stay white, matching the editor's white
  //   artwork background (the checkerboard lives behind the surface).
  let {
    left = 0,
    top = 0,
    cssSize = EYEDROPPER_LOUPE_CANVAS_SIZE,
    canvasSize = EYEDROPPER_LOUPE_CANVAS_SIZE,
    pixels,
    blockSize = EYEDROPPER_LOUPE_CANVAS_SIZE / 3,
    ringColor = 'rgb(0, 0, 0)',
    centerColor = 'rgb(0, 0, 0)',
  } = $props<{
    left: number;
    top: number;
    cssSize: number;
    canvasSize: number;
    pixels: Uint8ClampedArray | undefined;
    blockSize: number;
    ringColor: string;
    centerColor: string;
  }>();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    const node = canvas;
    if (!node) return;
    const cssEdge = Math.max(2, Math.round(cssSize));
    const deviceRatio =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && (window.devicePixelRatio as number) > 0
        ? (window.devicePixelRatio as number)
        : 1;
    void canvasSize;
    const backing = Math.max(2, Math.round(cssEdge * deviceRatio));
    if (node.width !== backing || node.height !== backing) {
      node.width = backing;
      node.height = backing;
    }
    const context = node.getContext('2d');
    if (!context) return;
    context.setTransform(deviceRatio, 0, 0, deviceRatio, 0, 0);
    const diameter = Math.max(1, Math.round(blockSize));
    const edge = cssEdge;
    const radius = edge / 2;
    context.clearRect(0, 0, edge, edge);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, edge, edge);
    if (pixels && pixels.length >= diameter * diameter * 4) {
      const source = document.createElement('canvas');
      source.width = diameter;
      source.height = diameter;
      const sourceContext = source.getContext('2d');
      if (sourceContext) {
        const image = sourceContext.createImageData(diameter, diameter);
        image.data.set(pixels.subarray(0, diameter * diameter * 4));
        sourceContext.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = false;
        context.drawImage(source, 0, 0, edge, edge);
      }
    }
    // Center cell: exactly oneloupe-grid cell at the cursor, filled with the
    // picked color and outlined in black.
    const cell = 5;
    const cellLeft = (edge - cell) / 2;
    context.fillStyle = centerColor;
    context.fillRect(cellLeft, cellLeft, cell, cell);
    context.lineWidth = 1;
    context.strokeStyle = '#000000';
    context.strokeRect(cellLeft + 0.5, cellLeft + 0.5, cell - 1, cell - 1);
    // Outer ring in the picked color (alpha preserved: a transparent pick
    // yields a transparent ring over the white disc).
    context.lineWidth = 15;
    context.strokeStyle = ringColor;
    context.beginPath();
    context.arc(radius, radius, radius, 0, Math.PI * 2);
    context.stroke();
  });
</script>

<canvas
  bind:this={canvas}
  data-testid="eyedropper-loupe"
  aria-hidden="true"
  class="pointer-events-none fixed z-20"
  style={`left:${left}px;top:${top}px;width:${Math.max(2, Math.round(cssSize))}px;height:${Math.max(2, Math.round(cssSize))}px;box-sizing:content-box;border:1px solid #222;border-radius:100%;background:#ffffff;`}
></canvas>
