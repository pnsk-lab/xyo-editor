<script lang="ts">
  import { sanitizeSvgForDisplay } from '../costumes/svg-sanitize';

  let {
    previewSvg,
    artStyle,
  }: {
    previewSvg: string;
    artStyle: string;
  } = $props();
</script>

<!--
  Fill-tool hover preview layer (draw-only, never a hit target).
  - Full-document snapshot with exactly one side previewed (see
    `vector-fill-hover-overlay.ts`); the live SVG / VM / history are untouched.
  - `pointer-events: none` + `aria-hidden` so it never blocks clicks, marquees,
    handles, or later hover passes, and stays below selection UI in DOM order.
-->
<div
  data-testid="vector-fill-hover-preview"
  data-fill-hover-preview="true"
  class="vector-fill-hover-preview pointer-events-none absolute select-none overflow-hidden rounded"
  style={artStyle}
  aria-hidden="true"
>
  {@html sanitizeSvgForDisplay(previewSvg)}
</div>

<style>
  .vector-fill-hover-preview :global(svg) {
    display: block;
    height: 100%;
    width: 100%;
    pointer-events: none;
  }
</style>
