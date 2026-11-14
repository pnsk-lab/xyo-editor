<script lang="ts">
  import { buildVectorBrushFillPathData } from '../costumes/vector-brush-fill'

  let { points, color, width, opacity, scale, left, top }: {
    points: Array<{ x: number; y: number }>
    color: string
    width: number
    opacity: number
    scale: number
    left: number
    top: number
  } = $props()

  // Closed-fill preview parity with the committed brush shape: the same
  // `buildVectorBrushFillPathData(points, width)` outline, `fill`-only with
  // `stroke="none"`, single dots as `<circle>` with the same
  // `max(1, width) / 2` radius. `color === 'none'` (transparent fill) paints
  // nothing, matching the commit no-op.
  let hidden = $derived(!color || color.trim().toLowerCase() === 'none' || color.trim().toLowerCase() === 'transparent')
  let pathData = $derived(points.length > 1 && !hidden ? buildVectorBrushFillPathData(points, width) : '')
</script>

<svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" data-testid="vector-brush-preview">
  <g transform={`translate(${left} ${top})`}>
    <g transform={`scale(${scale})`}>
      {#if !hidden}
        {#if points.length === 1}
          <circle cx={points[0].x} cy={points[0].y} r={Math.max(1, width) / 2} fill={color} stroke="none" opacity={opacity / 100} />
        {:else if pathData}
          <path d={pathData} fill={color} stroke="none" opacity={opacity / 100} />
        {/if}
      {/if}
    </g>
  </g>
</svg>
