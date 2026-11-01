<script lang="ts">
  let { shape, rect, color, secondaryColor, gradient, stroke, width, opacity, left, top, scale }: {
    shape: 'rect' | 'oval' | 'line'
    rect: { x: number; y: number; width: number; height: number }
    color: string
    secondaryColor: string
    gradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
    stroke: string
    width: number
    opacity: number
    left: number
    top: number
    scale: number
  } = $props()
  const id = `shape-preview-${Math.random().toString(36).slice(2)}`
</script>

<svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" data-testid="vector-shape-preview">
  <defs>
    {#if gradient === 'radial'}
      <radialGradient {id}><stop offset="0%" stop-color={color} /><stop offset="100%" stop-color={secondaryColor} /></radialGradient>
    {:else}
      <linearGradient {id} x1="0%" y1="0%" x2={gradient === 'vertical' ? '0%' : '100%'} y2={gradient === 'vertical' ? '100%' : '0%'}><stop offset="0%" stop-color={color} /><stop offset="100%" stop-color={secondaryColor} /></linearGradient>
    {/if}
  </defs>
  <g transform={`translate(${left} ${top}) scale(${scale})`} opacity={Math.max(0, Math.min(1, opacity / 100))}>
    {#if shape === 'rect'}
      <rect x={rect.x} y={rect.y} width={Math.max(1, rect.width)} height={Math.max(1, rect.height)} rx="8" fill={gradient === 'solid' ? color : `url(#${id})`} stroke={stroke} stroke-width={Math.max(0, width)} />
    {:else if shape === 'oval'}
      <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={Math.max(1, rect.width / 2)} ry={Math.max(1, rect.height / 2)} fill={gradient === 'solid' ? color : `url(#${id})`} stroke={stroke} stroke-width={Math.max(0, width)} />
    {:else}
      <line x1={rect.x} y1={rect.y} x2={rect.x + rect.width} y2={rect.y + rect.height} stroke={stroke} stroke-width={Math.max(1, width * 2)} stroke-linecap="round" />
    {/if}
  </g>
</svg>
