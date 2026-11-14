<script lang="ts">
  import { vectorLineEndpoints } from '../costumes/vector-shapes'
  import { vectorLineSvgForUi, vectorStrokeUiToSvg } from '../costumes/vector-stroke-scale'
  import { resolveVectorLinearUserSpace, resolveVectorRadialUserSpace } from '../costumes/paint-colors'

  let { shape, rect, color, secondaryColor, gradient, stroke, strokeSecondaryColor = '#ffffff', strokeGradient = 'solid', width, opacity, left, top, scale }: {
    shape: 'rect' | 'oval' | 'line'
    rect: { x: number; y: number; width: number; height: number }
    color: string
    secondaryColor: string
    gradient: 'solid' | 'horizontal' | 'vertical' | 'radial'
    stroke: string
    strokeSecondaryColor?: string
    strokeGradient?: 'solid' | 'horizontal' | 'vertical' | 'radial'
    width: number
    opacity: number
    left: number
    top: number
    scale: number
  } = $props()
  const id = `shape-preview-${Math.random().toString(36).slice(2)}`
  const strokeId = `${id}-stroke`
  const lineEndpoints = $derived(vectorLineEndpoints(rect))
  const showStrokeGradient = $derived(strokeGradient !== 'solid' && stroke !== 'none')
  const showFillGradient = $derived(gradient !== 'solid')
  // Commit parity: the saved artwork builds `userSpaceOnUse` ramps over the
  // normalized drag bounds (`vectorDragGradientBounds` in Editor.svelte:
  // min-corner + absolute size, so signed line rects collapse to the same
  // bbox). The preview must use the identical bounds, not the legacy
  // `objectBoundingBox` percentages, or rect/oval/line ramps drift from the
  // commit. Degenerate orthogonal spans (horizontal line + vertical ramp,
  // vertical line + horizontal ramp) stay non-degenerate via the shared
  // `0.01` minimum in `resolveVectorLinearUserSpace`.
  const gradientBounds = $derived.by(() => {
    const x0 = Number.isFinite(rect.x) ? rect.x : 0
    const y0 = Number.isFinite(rect.y) ? rect.y : 0
    const w = Number.isFinite(rect.width) ? rect.width : 0
    const h = Number.isFinite(rect.height) ? rect.height : 0
    return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), width: Math.abs(w), height: Math.abs(h) }
  })
  function formatPreviewNumber(value: number): string {
    if (!Number.isFinite(value)) return '0'
    const rounded = Number(value.toFixed(3))
    return String(Object.is(rounded, -0) ? 0 : rounded)
  }
  const fillLinear = $derived(resolveVectorLinearUserSpace(gradientBounds, gradient))
  const fillRadial = $derived(resolveVectorRadialUserSpace(gradientBounds, undefined))
  const strokeLinear = $derived(resolveVectorLinearUserSpace(gradientBounds, strokeGradient))
  const strokeRadial = $derived(resolveVectorRadialUserSpace(gradientBounds, undefined))
</script>

<svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" data-testid="vector-shape-preview">
  <defs>
    {#if showFillGradient}
      {#if gradient === 'radial'}
        <radialGradient {id} gradientUnits="userSpaceOnUse" cx={formatPreviewNumber(fillRadial.cx)} cy={formatPreviewNumber(fillRadial.cy)} r={formatPreviewNumber(fillRadial.r)}><stop offset="0%" stop-color={color} /><stop offset="100%" stop-color={secondaryColor} /></radialGradient>
      {:else}
        <linearGradient {id} gradientUnits="userSpaceOnUse" x1={formatPreviewNumber(fillLinear.x1)} y1={formatPreviewNumber(fillLinear.y1)} x2={formatPreviewNumber(fillLinear.x2)} y2={formatPreviewNumber(fillLinear.y2)}><stop offset="0%" stop-color={color} /><stop offset="100%" stop-color={secondaryColor} /></linearGradient>
      {/if}
    {/if}
    {#if showStrokeGradient}
      {#if strokeGradient === 'radial'}
        <radialGradient id={strokeId} gradientUnits="userSpaceOnUse" cx={formatPreviewNumber(strokeRadial.cx)} cy={formatPreviewNumber(strokeRadial.cy)} r={formatPreviewNumber(strokeRadial.r)}><stop offset="0%" stop-color={stroke} /><stop offset="100%" stop-color={strokeSecondaryColor} /></radialGradient>
      {:else}
        <linearGradient id={strokeId} gradientUnits="userSpaceOnUse" x1={formatPreviewNumber(strokeLinear.x1)} y1={formatPreviewNumber(strokeLinear.y1)} x2={formatPreviewNumber(strokeLinear.x2)} y2={formatPreviewNumber(strokeLinear.y2)}><stop offset="0%" stop-color={stroke} /><stop offset="100%" stop-color={strokeSecondaryColor} /></linearGradient>
      {/if}
    {/if}
  </defs>
  <g transform={`translate(${left} ${top}) scale(${scale})`} opacity={Math.max(0, Math.min(1, opacity / 100))}>
    {#if shape === 'rect'}
      <rect x={rect.x} y={rect.y} width={Math.max(1, rect.width)} height={Math.max(1, rect.height)} fill={gradient === 'solid' ? color : `url(#${id})`} stroke={showStrokeGradient ? `url(#${strokeId})` : stroke} stroke-width={vectorStrokeUiToSvg(Math.max(0, width))} />
    {:else if shape === 'oval'}
      <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={Math.max(1, rect.width / 2)} ry={Math.max(1, rect.height / 2)} fill={gradient === 'solid' ? color : `url(#${id})`} stroke={showStrokeGradient ? `url(#${strokeId})` : stroke} stroke-width={vectorStrokeUiToSvg(Math.max(0, width))} />
    {:else}
      <line x1={lineEndpoints.x1} y1={lineEndpoints.y1} x2={lineEndpoints.x2} y2={lineEndpoints.y2} stroke={showStrokeGradient ? `url(#${strokeId})` : stroke} stroke-width={vectorLineSvgForUi(width)} stroke-linecap="round" />
    {/if}
  </g>
</svg>
