<script lang="ts">
  let {
    fileInput = $bindable(),
    spriteFileInput = $bindable(),
    costumeFileInput = $bindable(),
    soundFileInput = $bindable(),
    loadProject,
    importSpriteFile,
    uploadCostume,
    uploadSound,
  } = $props<{
    fileInput?: HTMLInputElement
    spriteFileInput?: HTMLInputElement
    costumeFileInput?: HTMLInputElement
    soundFileInput?: HTMLInputElement
    loadProject: (event: Event) => void
    importSpriteFile: (event: Event) => void
    uploadCostume: (event: Event) => void
    uploadSound: (event: Event) => void
  }>()
</script>

<input
  data-testid="project-file-input"
  bind:this={fileInput}
  class="hidden"
  type="file"
  accept=".json,.sb3,.sb2,application/json"
  onchange={loadProject}
/>
<input
  data-testid="sprite-file-input"
  bind:this={spriteFileInput}
  class="hidden"
  type="file"
  accept=".sprite3,.sprite2,.json,application/json,.svg,.png,.jpg,.jpeg,.gif,image/*"
  multiple
  onchange={importSpriteFile}
/>
<input
  data-testid="costume-file-input"
  bind:this={costumeFileInput}
  class="hidden"
  type="file"
  accept=".svg,.png,.jpg,.jpeg,.gif,image/*"
  multiple
  onchange={uploadCostume}
/>
<input
  data-testid="sound-file-input"
  bind:this={soundFileInput}
  class="hidden"
  type="file"
  accept=".wav,.mp3,.ogg,audio/*"
  multiple
  onchange={uploadSound}
/>
