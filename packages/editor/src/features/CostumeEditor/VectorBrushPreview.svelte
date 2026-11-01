<script lang="ts">
  let { points, color, width, opacity, scale, left, top }: {
    points: Array<{ x: number; y: number }>
    color: string
    width: number
    opacity: number
    scale: number
    left: number
    top: number
  } = $props()
</script>

<svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" data-testid="vector-brush-preview">
  <g transform={`translate(${left} ${top})`}>
    {#if points.length === 1}
      <circle cx={points[0].x * scale} cy={points[0].y * scale} r={Math.max(1, width) * scale / 2} fill={color} opacity={opacity / 100} />
    {:else if points.length > 1}
      <polyline points={points.map((point) => `${point.x * scale},${point.y * scale}`).join(' ')} fill="none" stroke={color} stroke-width={Math.max(1, width) * scale} stroke-linecap="round" stroke-linejoin="round" opacity={opacity / 100} />
    {/if}
  </g>
</svg>
