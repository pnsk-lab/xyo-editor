<script lang="ts">
  import { Download, Trash2 } from 'lucide-svelte'
  import type { ScratchTarget } from '@hikkaku/vm'

  let {
    selectedTarget,
    selectedVariables,
    selectedLists,
    lastDeletedSprite,
    renameSelectedTarget,
    duplicateSelectedTarget,
    exportSelectedSprite,
    addSpriteToBackpack,
    restoreSpriteFromBackpack,
    beginCodeDrag,
    addCodeToBackpack,
    restoreCodeFromBackpack,
    restoreDeletedSprite,
    deleteSelectedTarget,
    updateTargetName,
    updateNumber,
    setDirection,
    updateDirectionDial,
    updateRotationStyle,
    setVisible,
    toggleDraggable,
    createVariable,
    showVariableMonitor,
    renameVariable,
    deleteVariable,
    createList,
    showListMonitor,
    renameList,
    deleteList,
  } = $props<{
    selectedTarget: ScratchTarget | undefined
    selectedVariables: [string, ScratchTarget['variables'][string]][]
    selectedLists: [string, ScratchTarget['lists'][string]][]
    lastDeletedSprite: Uint8Array | undefined
    renameSelectedTarget: () => void
    duplicateSelectedTarget: () => void
    exportSelectedSprite: () => void | Promise<void>
    addSpriteToBackpack: () => void | Promise<void>
    restoreSpriteFromBackpack: () => void
    beginCodeDrag: (event: DragEvent) => void
    addCodeToBackpack: () => void
    restoreCodeFromBackpack: () => void
    restoreDeletedSprite: () => void
    deleteSelectedTarget: () => void | Promise<void>
    updateTargetName: (event: Event) => void
    updateNumber: (field: 'x' | 'y' | 'direction' | 'size' | 'volume', event: Event) => void
    setDirection: (direction: number) => void
    updateDirectionDial: (event: Event) => void
    updateRotationStyle: (event: Event) => void
    setVisible: (visible: boolean) => void
    toggleDraggable: () => void
    createVariable: () => void
    showVariableMonitor: (variableId: string) => void
    renameVariable: (id: string) => void
    deleteVariable: (id: string) => void
    createList: () => void
    showListMonitor: (listId: string) => void
    renameList: (id: string) => void
    deleteList: (id: string) => void
  }>()
</script>

<section class="p-3">
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-sm font-bold text-slate-700">Target</h2>
    <div class="flex gap-1">
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Rename target" title="Rename target" disabled={!selectedTarget || selectedTarget.isStage} onclick={renameSelectedTarget}>
        Rename
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Duplicate target" title="Duplicate target" disabled={!selectedTarget || selectedTarget.isStage} onclick={duplicateSelectedTarget}>
        Copy
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Export target" title="Export target" disabled={!selectedTarget || selectedTarget.isStage} onclick={exportSelectedSprite}>
        <Download size={16} />
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Backpack target" title="Backpack target" disabled={!selectedTarget || selectedTarget.isStage} onclick={addSpriteToBackpack}>
        Pack
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600" aria-label="Restore target" title="Restore target" onclick={restoreSpriteFromBackpack}>
        Unpack
      </button>
      <button
        class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40"
        aria-label="Backpack code"
        title="Drag to another target to share code"
        disabled={!selectedTarget}
        draggable={selectedTarget ? 'true' : 'false'}
        ondragstart={beginCodeDrag}
        onclick={addCodeToBackpack}
      >
        Code
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Restore code" title="Restore code" disabled={!selectedTarget} onclick={restoreCodeFromBackpack}>
        Uncode
      </button>
      <button class="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-40" aria-label="Restore deleted sprite" title="Restore deleted sprite" disabled={!lastDeletedSprite} onclick={restoreDeletedSprite}>
        Restore
      </button>
      <button
        class="rounded-md border border-rose-200 p-2 text-rose-600 disabled:opacity-40"
        aria-label="Delete target"
        title="Delete target"
        disabled={!selectedTarget || selectedTarget.isStage}
        onclick={deleteSelectedTarget}
      >
        <Trash2 size={16} />
      </button>
    </div>
  </div>

  {#if selectedTarget}
    <div class="space-y-3">
      <div>
        <label class="mb-1 block text-xs font-semibold text-slate-500" for="target-name">Name</label>
        <input id="target-name" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" value={selectedTarget.name} readonly={selectedTarget.isStage} onchange={updateTargetName} />
      </div>
      {#if !selectedTarget.isStage}
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs font-semibold text-slate-500">X<input class="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" type="number" value={Math.round(selectedTarget.x ?? 0)} onchange={(event) => updateNumber('x', event)} /></label>
          <label class="text-xs font-semibold text-slate-500">Y<input class="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" type="number" value={Math.round(selectedTarget.y ?? 0)} onchange={(event) => updateNumber('y', event)} /></label>
          <label class="text-xs font-semibold text-slate-500">Size<input class="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" type="number" value={Math.round(selectedTarget.size ?? 100)} onchange={(event) => updateNumber('size', event)} /></label>
          <label class="text-xs font-semibold text-slate-500">Direction<input class="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" type="number" value={Math.round(selectedTarget.direction ?? 90)} onchange={(event) => updateNumber('direction', event)} /></label>
        </div>
        <div class="rounded-md border border-slate-200 bg-slate-50 p-2">
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-slate-500">Direction</span>
            <span class="font-mono text-xs font-bold text-slate-700">{Math.round(selectedTarget.direction ?? 90)}°</span>
          </div>
          <div class="grid grid-cols-[72px_1fr] items-center gap-3">
            <div class="relative h-[72px] w-[72px] rounded-full border border-slate-300 bg-white">
              <div class="absolute left-1/2 top-1/2 h-8 w-1 origin-bottom rounded-full bg-blue-500" style={`transform:translate(-50%, -100%) rotate(${(selectedTarget.direction ?? 90) - 90}deg)`}></div>
              <button class="absolute left-1/2 top-1 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold" style="transform:translateX(-50%)" onclick={() => setDirection(0)}>0</button>
              <button class="absolute right-1 top-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold" style="transform:translateY(-50%)" onclick={() => setDirection(90)}>90</button>
              <button class="absolute bottom-1 left-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold" style="transform:translateX(-50%)" onclick={() => setDirection(180)}>180</button>
              <button class="absolute left-1 top-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold" style="transform:translateY(-50%)" onclick={() => setDirection(-90)}>-90</button>
            </div>
            <input aria-label="Direction dial" class="w-full" type="range" min="-179" max="180" value={Math.round(selectedTarget.direction ?? 90)} oninput={updateDirectionDial} />
          </div>
        </div>
        <label class="block text-xs font-semibold text-slate-500">
          Rotation style
          <select class="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" value={selectedTarget.rotationStyle ?? 'all around'} onchange={updateRotationStyle}>
            <option value="all around">all around</option>
            <option value="left-right">left-right</option>
            <option value="don't rotate">don't rotate</option>
          </select>
        </label>
        <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2">
          <span class="text-xs font-semibold text-slate-500">Visibility</span>
          <button class={`rounded-md border px-3 py-1.5 text-xs font-semibold ${selectedTarget.visible !== false ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'}`} onclick={() => setVisible(true)}>Show</button>
          <button class={`rounded-md border px-3 py-1.5 text-xs font-semibold ${selectedTarget.visible === false ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'}`} onclick={() => setVisible(false)}>Hide</button>
        </div>
        <label class="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={selectedTarget.draggable === true} onchange={toggleDraggable} />
          Draggable
        </label>
      {/if}

      <div>
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-xs font-bold uppercase text-slate-500">Variables</h3>
          <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700" onclick={createVariable}>Make</button>
        </div>
        <div class="space-y-1">
          {#each selectedVariables as [id, variable]}
            <div class="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm">
              <span class="truncate">{variable[0]}</span>
              <div class="ml-2 flex items-center gap-2">
                <span class="font-mono text-xs text-slate-500">{variable[1]}</span>
                <button class="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold" onclick={() => showVariableMonitor(id)}>Show</button>
                <button class="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold" onclick={() => renameVariable(id)}>Rename</button>
                <button class="rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-rose-600" onclick={() => deleteVariable(id)}>Delete</button>
              </div>
            </div>
          {:else}
            <p class="text-sm text-slate-500">No variables.</p>
          {/each}
        </div>
      </div>
      <div>
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-xs font-bold uppercase text-slate-500">Lists</h3>
          <button class="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700" onclick={createList}>Make</button>
        </div>
        <div class="space-y-1">
          {#each selectedLists as [id, list]}
            <div class="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm">
              <span class="truncate">{list[0]}</span>
              <div class="ml-2 flex items-center gap-2">
                <span class="font-mono text-xs text-slate-500">{list[1].length}</span>
                <button class="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold" onclick={() => showListMonitor(id)}>Show</button>
                <button class="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold" onclick={() => renameList(id)}>Rename</button>
                <button class="rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-rose-600" onclick={() => deleteList(id)}>Delete</button>
              </div>
            </div>
          {:else}
            <p class="text-sm text-slate-500">No lists.</p>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</section>
