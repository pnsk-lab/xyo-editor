<script lang="ts">
  import { getBitmapEraserMark } from '../costumes/bitmap-eraser'

  let { x, y, size, bitmap }: { x: number; y: number; size: number; bitmap: boolean } = $props()
  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    if (!bitmap || !canvas) return
    const mark = getBitmapEraserMark(size, '#009dec')
    canvas.width = mark.width
    canvas.height = mark.height
    canvas.getContext('2d')?.drawImage(mark, 0, 0)
  })
</script>

{#if bitmap}
  <canvas
    bind:this={canvas}
    data-testid="eraser-cursor-preview"
    aria-hidden="true"
    class="pointer-events-none absolute z-10"
    style={`left:${x}px;top:${y}px;transform:translate(-50%, -50%);image-rendering:pixelated;`}
  ></canvas>
{:else}
  <div
    data-testid="eraser-cursor-preview"
    aria-hidden="true"
    class="pointer-events-none absolute z-10"
    style={`left:${x}px;top:${y}px;width:${size}px;height:${size}px;transform:translate(-50%, -50%);background:white;border:1px solid cornflowerblue;box-sizing:border-box;border-radius:50%;`}
  ></div>
{/if}
