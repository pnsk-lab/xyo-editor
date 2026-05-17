<script lang="ts">
  import { Mic, Paintbrush, Plus, Search, Sparkles, Trash2, Upload, Volume2 } from 'lucide-svelte'
  import type { ScratchCostume, ScratchSound, ScratchTarget } from '@hikkaku/vm'
  import type { AssetHistoryEntry, EditorTab, LibraryPanel, SoundEffect } from '../../lib/editor-types'
  import type { costumeLibrary, soundLibrary } from '../../lib/editor-libraries'

  let {
    selectedTab = $bindable('code'),
    paintColor = $bindable('#ffab19'),
    secondaryPaintColor = $bindable('#ffffff'),
    selectedTarget,
    selectedSoundIndex,
    isRecordingSound,
    recordingLevel,
    costumeThumbnailUrls,
    lastDeletedCostume,
    lastDeletedCostumeRestore,
    lastDeletedSound,
    lastDeletedSoundRestore,
    costumeThumbnailKey,
    costumeDisplaySize,
    fillCurrentCostume,
    openLibrary,
    surpriseCostume,
    addCostume,
    openCostumeUpload,
    addLibraryCostume,
    beginCostumeDrag,
    dropCostumeOn,
    clearCostumeDrag,
    selectCostume,
    updateCostumeName,
    renameCostume,
    duplicateCostume,
    exportCostume,
    moveCostume,
    deleteCostume,
    restoreDeletedCostume,
    generateTone,
    stopRecordingSound,
    startRecordingSound,
    surpriseSound,
    addSound,
    openSoundUpload,
    addLibrarySound,
    beginSoundDrag,
    dropSoundOn,
    clearSoundDrag,
    updateSoundName,
    selectSound,
    renameSound,
    duplicateSound,
    exportSound,
    moveSound,
    editSound,
    deleteSound,
    restoreDeletedSound,
    costumeItems,
    soundItems,
  } = $props<{
    selectedTab: EditorTab
    paintColor: string
    secondaryPaintColor: string
    selectedTarget: ScratchTarget | undefined
    selectedSoundIndex: number
    isRecordingSound: boolean
    recordingLevel: number
    costumeThumbnailUrls: Record<string, string>
    lastDeletedCostume: AssetHistoryEntry | undefined
    lastDeletedCostumeRestore: (() => void) | undefined
    lastDeletedSound: AssetHistoryEntry | undefined
    lastDeletedSoundRestore: (() => void) | undefined
    costumeThumbnailKey: (target: ScratchTarget, costume: ScratchCostume, index: number) => string
    costumeDisplaySize: (target: ScratchTarget | undefined, costume: ScratchCostume) => string
    fillCurrentCostume: () => void | Promise<void>
    openLibrary: (kind: NonNullable<LibraryPanel>) => void
    surpriseCostume: () => void | Promise<void>
    addCostume: () => void | Promise<void>
    openCostumeUpload: () => void
    addLibraryCostume: (item: (typeof costumeLibrary)[number]) => void | Promise<void>
    beginCostumeDrag: (index: number, event: DragEvent) => void
    dropCostumeOn: (index: number) => void
    clearCostumeDrag: () => void
    selectCostume: (index: number) => void | Promise<void>
    updateCostumeName: (index: number, event: Event) => void
    renameCostume: (index: number) => void
    duplicateCostume: (index: number) => void
    exportCostume: (index: number) => void | Promise<void>
    moveCostume: (index: number, direction: -1 | 1) => void
    deleteCostume: (index: number) => void | Promise<void>
    restoreDeletedCostume: () => void | Promise<void>
    generateTone: () => void | Promise<void>
    stopRecordingSound: (save?: boolean) => void | Promise<void>
    startRecordingSound: () => void | Promise<void>
    surpriseSound: () => void | Promise<void>
    addSound: () => void
    openSoundUpload: () => void
    addLibrarySound: (item: (typeof soundLibrary)[number]) => void | Promise<void>
    beginSoundDrag: (index: number, event: DragEvent) => void
    dropSoundOn: (index: number) => void
    clearSoundDrag: () => void
    updateSoundName: (index: number, event: Event) => void
    selectSound: (index: number) => void | Promise<void>
    renameSound: (index: number) => void
    duplicateSound: (index: number) => void
    exportSound: (index: number) => void | Promise<void>
    moveSound: (index: number, direction: -1 | 1) => void
    editSound: (index: number, effect: SoundEffect) => void | Promise<void>
    deleteSound: (index: number) => void | Promise<void>
    restoreDeletedSound: () => void | Promise<void>
    costumeItems: typeof costumeLibrary
    soundItems: typeof soundLibrary
  }>()

  let costumeAddMenuOpen = $state(false)
  let soundAddMenuOpen = $state(false)

  function chooseCostumeFromLibrary() {
    costumeAddMenuOpen = false
    openLibrary('costume')
  }

  function uploadCostumeFromMenu() {
    costumeAddMenuOpen = false
    openCostumeUpload()
  }

  function surpriseCostumeFromMenu() {
    costumeAddMenuOpen = false
    surpriseCostume()
  }

  function chooseSoundFromLibrary() {
    soundAddMenuOpen = false
    openLibrary('sound')
  }

  function uploadSoundFromMenu() {
    soundAddMenuOpen = false
    openSoundUpload()
  }

  function recordSoundFromMenu() {
    soundAddMenuOpen = false
    startRecordingSound()
  }

  function surpriseSoundFromMenu() {
    soundAddMenuOpen = false
    surpriseSound()
  }
</script>

<aside class={`h-full min-h-0 shrink-0 overflow-y-auto overflow-x-hidden border-r border-[#c6d2e2] ${selectedTab === 'sounds' ? 'w-[152px]' : 'w-[145px]'} ${selectedTab === 'costumes' || selectedTab === 'sounds' ? 'bg-[#dfe8f6]' : 'bg-white'}`}>
  {#if selectedTab === 'costumes'}
    <div class="relative flex h-full min-h-0 flex-col overflow-auto px-2 py-2">
      <div class="space-y-2 pb-20">
        {#each selectedTarget?.costumes ?? [] as costume, index}
          <div
            data-testid={`costume-card-${index}`}
            role="listitem"
            class={`group relative rounded-lg border p-1.5 shadow-sm ${index === selectedTarget?.currentCostume ? 'border-[#7c3fdd] bg-white shadow-[#7c3fdd]/25 ring-2 ring-[#8d5de8]' : 'border-[#98a8ba] bg-[#f4f8fd]'}`}
            draggable="true"
            ondragstart={(event) => beginCostumeDrag(index, event)}
            ondragover={(event) => event.preventDefault()}
            ondrop={() => dropCostumeOn(index)}
            ondragend={clearCostumeDrag}
          >
            <div class="absolute left-1.5 top-1 text-xs font-bold text-[#26364d]">{index + 1}</div>
            <button class="flex h-[58px] w-full items-center justify-center rounded-md bg-white shadow-[inset_0_0_0_1px_rgb(152_168_186/0.22)]" aria-label={`Select ${costume.name}`} onclick={() => selectCostume(index)}>
              {#if selectedTarget && costumeThumbnailUrls[costumeThumbnailKey(selectedTarget, costume, index)]}
                <img class="max-h-full max-w-full object-contain" src={costumeThumbnailUrls[costumeThumbnailKey(selectedTarget, costume, index)]} alt="" />
              {:else}
                <span class="h-10 w-10 rounded-full bg-[#ffab19]"></span>
              {/if}
            </button>
            <input class={`mt-1 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-center text-xs font-bold focus:border-[#7c3fdd] focus:bg-white focus:text-[#26364d] ${index === selectedTarget?.currentCostume ? 'bg-[#7c3fdd] text-white' : 'text-[#3f4d63]'}`} value={costume.name} aria-label={`Rename ${costume.name}`} onchange={(event) => updateCostumeName(index, event)} />
            <p class="mt-0.5 text-center text-[9px] font-bold text-[#4b5870]">{costumeDisplaySize(selectedTarget, costume)}</p>
            {#if index === selectedTarget?.currentCostume}
              <button class="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#7c3fdd] text-white shadow-[0_2px_8px_rgb(38_54_77/0.24)] disabled:bg-[#9aa4b2]" aria-label={`Delete ${costume.name}`} title="Delete" disabled={(selectedTarget?.costumes.length ?? 0) <= 1} onclick={() => deleteCostume(index)}>
                <span class="text-base leading-none">×</span>
              </button>
            {/if}
          </div>
        {/each}
      </div>
      <div class="sticky bottom-3 mt-auto flex justify-center">
        <div class="relative">
          {#if costumeAddMenuOpen}
            <div class="asset-add-menu absolute bottom-14 left-1/2 z-20 w-44 -translate-x-1/2 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-left shadow-xl" role="menu" aria-label="Costume options">
              <button data-testid="choose-costume-library" class="asset-add-menu-item" type="button" role="menuitem" onclick={chooseCostumeFromLibrary}>
                <Search size={16} />
                <span>Choose costume</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={uploadCostumeFromMenu}>
                <Upload size={16} />
                <span>Upload costume</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={surpriseCostumeFromMenu}>
                <Sparkles size={16} />
                <span>Surprise</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={() => {
                costumeAddMenuOpen = false
                addCostume()
              }}>
                <Paintbrush size={16} />
                <span>Paint</span>
              </button>
            </div>
          {/if}
          <button class="asset-add-fab" type="button" aria-label="Add costume" title="Add costume" aria-haspopup="menu" aria-expanded={costumeAddMenuOpen} onclick={() => (costumeAddMenuOpen = !costumeAddMenuOpen)}>
            <Paintbrush size={22} />
          </button>
          <button data-testid="open-costume-library" class="asset-add-quick" type="button" aria-label="Choose costume from library" title="Choose costume" onclick={chooseCostumeFromLibrary}>+</button>
        </div>
      </div>
      <div class="sr-only">
        <button onclick={openCostumeUpload}><Upload size={16} />Upload</button>
        {#each costumeItems as item}
          <button onclick={() => addLibraryCostume(item)}>{item.name}</button>
        {/each}
      </div>
      {#if lastDeletedCostume || lastDeletedCostumeRestore}
        <button class="mt-3 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-xs font-semibold hover:bg-slate-50" onclick={restoreDeletedCostume}>Restore deleted</button>
      {/if}
    </div>
  {:else}
    <div class="relative flex h-full min-h-0 flex-col overflow-auto px-2 py-2">
      <div class="space-y-2 pb-20">
        {#if isRecordingSound}
          <div class="rounded-lg border border-red-200 bg-red-50 p-2">
            <div class="mb-2 flex items-center justify-between text-xs font-bold text-red-700">
              <span>Recording</span>
              <button class="rounded border border-red-200 bg-white px-2 py-1 text-[11px]" onclick={() => stopRecordingSound(false)}>Cancel</button>
            </div>
            <div class="h-3 overflow-hidden rounded-full bg-white">
              <div class="h-full bg-red-500" style={`width:${Math.round(recordingLevel * 100)}%`}></div>
            </div>
            <button class="mt-2 w-full rounded-md bg-red-500 px-2 py-1 text-xs font-bold text-white" onclick={() => stopRecordingSound(true)}>Stop rec</button>
          </div>
        {/if}
        {#each selectedTarget?.sounds ?? [] as sound, index}
          <div
            data-testid={`sound-card-${index}`}
            role="listitem"
            class={`group relative rounded-lg border p-1.5 shadow-sm ${selectedSoundIndex === index ? 'border-[#7c3fdd] bg-white shadow-[#7c3fdd]/25 ring-2 ring-[#8d5de8]' : 'border-[#98a8ba] bg-[#f4f8fd]'}`}
            draggable="true"
            ondragstart={(event) => beginSoundDrag(index, event)}
            ondragover={(event) => event.preventDefault()}
            ondrop={() => dropSoundOn(index)}
            ondragend={clearSoundDrag}
          >
            <div class="absolute left-1.5 top-1 text-xs font-bold text-[#26364d]">{index + 1}</div>
            <button class="flex h-[50px] w-full items-center justify-center rounded-md bg-white text-[#3f4d63] shadow-[inset_0_0_0_1px_rgb(152_168_186/0.22)]" aria-label={`Select ${sound.name}`} onclick={() => selectSound(index)}>
              <Volume2 size={26} fill="#3f4d63" />
            </button>
            <input class={`mt-1 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-center text-xs font-bold focus:border-[#7c3fdd] focus:bg-white focus:text-[#26364d] ${selectedSoundIndex === index ? 'bg-[#7c3fdd] text-white' : 'text-[#3f4d63]'}`} value={sound.name} aria-label={`Rename ${sound.name}`} onchange={(event) => updateSoundName(index, event)} />
            <p class="mt-0.5 text-center text-[9px] font-bold text-[#4b5870]">{((sound.sampleCount ?? 0) / Math.max(1, sound.rate ?? 44100)).toFixed(2)}</p>
            {#if selectedSoundIndex === index}
              <button class="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#7c3fdd] text-white shadow-[0_2px_8px_rgb(38_54_77/0.24)] disabled:bg-[#9aa4b2]" aria-label={`Delete ${sound.name}`} title="Delete" disabled={(selectedTarget?.sounds.length ?? 0) <= 1} onclick={() => deleteSound(index)}>
                <Trash2 size={17} />
              </button>
            {/if}
            <div class="sr-only">
              <button onclick={() => renameSound(index)}>Rename</button>
              <button onclick={() => duplicateSound(index)}>Copy</button>
              <button onclick={() => exportSound(index)}>Export</button>
              <button disabled={index === 0} onclick={() => moveSound(index, -1)}>Up</button>
              <button disabled={index >= (selectedTarget?.sounds.length ?? 1) - 1} onclick={() => moveSound(index, 1)}>Down</button>
              <button onclick={() => editSound(index, 'reverse')}>Reverse</button>
            </div>
          </div>
        {:else}
          <p class="rounded-lg bg-white p-3 text-center text-xs font-bold leading-5 text-slate-500">音はまだありません</p>
        {/each}
      </div>
      <div class="sticky bottom-3 mt-auto flex justify-center">
        <div class="relative">
          {#if soundAddMenuOpen}
            <div class="absolute bottom-14 left-1/2 z-20 w-44 -translate-x-1/2 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-left shadow-xl" role="menu" aria-label="Sound options">
              <button data-testid="choose-sound-library" class="asset-add-menu-item" type="button" role="menuitem" onclick={chooseSoundFromLibrary}>
                <Search size={16} />
                <span>Choose sound</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={uploadSoundFromMenu}>
                <Upload size={16} />
                <span>Upload sound</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={recordSoundFromMenu}>
                <Mic size={16} />
                <span>Record sound</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={surpriseSoundFromMenu}>
                <Sparkles size={16} />
                <span>Surprise</span>
              </button>
              <button class="asset-add-menu-item" type="button" role="menuitem" onclick={() => {
                soundAddMenuOpen = false
                addSound()
              }}>
                <Plus size={16} />
                <span>Blank sound</span>
              </button>
            </div>
          {/if}
          <button class="asset-add-fab" type="button" aria-label="Add sound" title="Add sound" aria-haspopup="menu" aria-expanded={soundAddMenuOpen} onclick={() => (soundAddMenuOpen = !soundAddMenuOpen)}>
            <Volume2 size={22} />
          </button>
          <button data-testid="open-sound-library" class="asset-add-quick" type="button" aria-label="Choose sound from library" title="Choose sound" onclick={chooseSoundFromLibrary}>+</button>
        </div>
      </div>
      <div class="sr-only">
        <button onclick={generateTone}>Tone</button>
        <button onclick={startRecordingSound}>Record</button>
        <button onclick={surpriseSound}>Surprise</button>
        <button onclick={openSoundUpload}><Upload size={16} />Upload</button>
        {#each soundItems as item}
          <button onclick={() => addLibrarySound(item)}>{item.name}</button>
        {/each}
      </div>
      {#if lastDeletedSound || lastDeletedSoundRestore}
        <button class="mt-3 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-xs font-semibold hover:bg-slate-50" onclick={restoreDeletedSound}>Restore deleted</button>
      {/if}
    </div>
  {/if}
  </aside>

<style>
  .asset-add-menu-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    font-size: 0.78rem;
    font-weight: 700;
    color: #575e75;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 80ms ease;
  }

  .asset-add-menu-item:hover,
  .asset-add-menu-item:focus-visible {
    background: #f3e9fb;
    color: #8d5de8;
  }

  .asset-add-menu-item:focus-visible,
  .asset-add-fab:focus-visible,
  .asset-add-quick:focus-visible {
    outline: 3px solid #4c97ff;
    outline-offset: 3px;
  }

  .asset-add-menu-item:active,
  .asset-add-fab:active,
  .asset-add-quick:active {
    transform: translateY(1px) scale(0.98);
  }

  .asset-add-fab {
    display: flex;
    height: 3rem;
    width: 3rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: #8d5de8;
    color: #ffffff;
    box-shadow: 0 8px 18px rgb(141 93 232 / 0.24);
    transition:
      background-color 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .asset-add-fab:hover,
  .asset-add-fab[aria-expanded='true'] {
    background: #7d45df;
    box-shadow: 0 10px 22px rgb(141 93 232 / 0.32), 0 0 0 4px rgb(255 255 255 / 0.7);
  }

  .asset-add-quick {
    position: absolute;
    right: -0.5rem;
    top: -0.5rem;
    display: flex;
    height: 1.35rem;
    width: 1.35rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: #8d5de8;
    color: #ffffff;
    font-size: 0.75rem;
    font-weight: 800;
    box-shadow: 0 0 0 2px #ffffff;
    transition:
      background-color 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .asset-add-quick:hover {
    background: #7d45df;
    box-shadow: 0 0 0 2px #ffffff, 0 6px 14px rgb(141 93 232 / 0.28);
  }
</style>
