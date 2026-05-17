<script lang="ts">
  let {
    host = $bindable(),
    visible,
  } = $props<{
    host?: HTMLDivElement
    visible: boolean
  }>()
</script>

<div data-testid="blockly-host" bind:this={host} class={`h-[calc(100svh-9.5rem)] min-h-[28rem] w-full ${visible ? '' : 'hidden'}`}></div>
