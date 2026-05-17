<script lang="ts">
  import { tick } from 'svelte'
  import { ArrowLeftRight, Box, Circle, Eye, EyeOff, ImagePlus, MoveVertical, Plus, Shuffle, Sparkles, Trash2, Upload } from 'lucide-svelte'
  import type { ScratchTarget } from '@hikkaku/vm'
  import type { LibraryPanel } from '../../lib/editor-types'
  import type { spriteLibrary } from '../../lib/editor-libraries'

  let {
    selectedTarget,
    stage,
    sprites,
    targetThumbnailUrls,
    spriteContextMenu,
    targetThumbnailKey,
    activateOnEnter,
    paintNewSprite,
    openLibrary,
    openSpritePicker,
    surpriseSprite,
    addSprite,
    paintNewBackdrop,
    openBackdropPicker,
    surpriseBackdrop,
    addLibrarySprite,
    selectTarget,
    beginSpriteDrag,
    dropSpriteOn,
    clearSpriteDrag,
    openSpriteContextMenu,
    duplicateSpriteByName,
    exportSpriteByName,
    deleteSpriteByName,
    libraryItems,
    updateTargetName,
    updateNumber,
    setDirection,
    updateDirectionDial,
    setRotationStyle,
    setVisible,
  } = $props<{
    selectedTarget: ScratchTarget | undefined
    stage: ScratchTarget | undefined
    sprites: ScratchTarget[]
    targetThumbnailUrls: Record<string, string>
    spriteContextMenu: { name: string; x: number; y: number } | undefined
    targetThumbnailKey: (target: ScratchTarget) => string
    activateOnEnter: (event: KeyboardEvent, action: () => void) => void
    paintNewSprite: () => void
    openLibrary: (kind: NonNullable<LibraryPanel>) => void
    openSpritePicker: () => void
    surpriseSprite: () => void | Promise<void>
    addSprite: () => void
    paintNewBackdrop: () => void
    openBackdropPicker: () => void
    surpriseBackdrop: () => void | Promise<void>
    addLibrarySprite: (item: (typeof spriteLibrary)[number]) => void | Promise<void>
    selectTarget: (name: string) => void
    beginSpriteDrag: (spriteName: string, event: DragEvent) => void
    dropSpriteOn: (spriteName: string, event?: DragEvent) => void
    clearSpriteDrag: () => void
    openSpriteContextMenu: (name: string, event: MouseEvent) => void
    duplicateSpriteByName: (name: string) => void
    exportSpriteByName: (name: string) => void | Promise<void>
    deleteSpriteByName: (name: string, confirmDelete?: boolean) => void | Promise<void>
    libraryItems: typeof spriteLibrary
    updateTargetName: (event: Event) => void
    updateNumber: (field: 'x' | 'y' | 'direction' | 'size' | 'volume', event: Event) => void
    setDirection: (direction: number) => void
    updateDirectionDial: (event: Event) => void
    setRotationStyle: (style: NonNullable<ScratchTarget['rotationStyle']>) => void
    setVisible: (visible: boolean) => void
  }>()

  let directionPickerOpen = $state(false)
  let directionInput: HTMLInputElement | undefined = $state()
  let directionPicker: HTMLDivElement | undefined = $state()
  let directionPickerStyle = $state('')
  let directionDragPointerId: number | undefined = $state()

  function stopClick(event: MouseEvent, action: () => void | Promise<void>) {
    event.stopPropagation()
    void action()
  }

  function directionNeedleStyle(direction = 90) {
    return `transform:translate(-50%, -100%) rotate(${direction}deg)`
  }

  function setDirectionAndKeepOpen(direction: number) {
    setDirection(direction)
    directionPickerOpen = true
    updateDirectionPickerPosition()
  }

  function setRotationStyleAndKeepOpen(style: NonNullable<ScratchTarget['rotationStyle']>) {
    setRotationStyle(style)
    directionPickerOpen = true
    updateDirectionPickerPosition()
  }

  async function openDirectionPicker() {
    directionPickerOpen = true
    await tick()
    updateDirectionPickerPosition()
  }

  function updateDirectionPickerPosition() {
    if (!directionInput) return
    const inputRect = directionInput.getBoundingClientRect()
    const pickerRect = directionPicker?.getBoundingClientRect()
    const pickerWidth = pickerRect?.width ?? 168
    const pickerHeight = pickerRect?.height ?? 220
    const margin = 8
    const maxLeft = Math.max(margin, window.innerWidth - pickerWidth - margin)
    const left = Math.min(Math.max(margin, inputRect.left + inputRect.width / 2 - pickerWidth / 2), maxLeft)
    const spaceAbove = inputRect.top - margin
    const spaceBelow = window.innerHeight - inputRect.bottom - margin
    const openAbove = spaceAbove >= pickerHeight || spaceAbove >= spaceBelow
    const top = openAbove
      ? Math.max(margin, inputRect.top - pickerHeight - margin)
      : Math.min(Math.max(margin, inputRect.bottom + margin), window.innerHeight - pickerHeight - margin)
    directionPickerStyle = `left:${left}px;top:${top}px`
  }

  function scratchDirectionFromPointer(event: PointerEvent, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)
    const degrees = Math.round(Math.atan2(dx, -dy) * 180 / Math.PI)
    return degrees === -180 ? 180 : degrees
  }

  function updateDirectionFromPointer(event: PointerEvent, element: HTMLElement) {
    setDirectionAndKeepOpen(scratchDirectionFromPointer(event, element))
  }

  function beginDirectionDrag(event: PointerEvent) {
    const element = event.currentTarget as HTMLElement
    directionDragPointerId = event.pointerId
    element.setPointerCapture(event.pointerId)
    updateDirectionFromPointer(event, element)
  }

  function dragDirection(event: PointerEvent) {
    if (directionDragPointerId !== event.pointerId) return
    updateDirectionFromPointer(event, event.currentTarget as HTMLElement)
  }

  function endDirectionDrag(event: PointerEvent) {
    if (directionDragPointerId !== event.pointerId) return
    directionDragPointerId = undefined
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  }

  function closeDirectionPickerOnOutside(event: MouseEvent) {
    if (!directionPickerOpen) return
    const target = event.target as Node
    if (directionPicker?.contains(target) || directionInput?.contains(target)) return
    directionPickerOpen = false
  }

  function closeDirectionPickerOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') directionPickerOpen = false
  }
</script>

<svelte:window onclick={closeDirectionPickerOnOutside} onkeydown={closeDirectionPickerOnEscape} onresize={updateDirectionPickerPosition} />

<section class="min-h-0 flex-1 overflow-hidden px-4 pb-4">
  <div class="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_88px] gap-2">
    <div class="relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-[#c9d7e8] bg-[#e8f1fc]">
      <div class="shrink-0 bg-white px-3 pb-3 pt-2">
        <h2 class="mb-1 text-xs font-bold text-[#575e75]">スプライト</h2>
        {#if selectedTarget && !selectedTarget.isStage}
          <div class="flex flex-wrap items-center gap-x-[7px] gap-y-2">
            <input
              class="h-[35px] min-w-[130px] flex-1 rounded-full border border-[#c8c8d0] px-4 text-xs font-semibold text-[#575e75] outline-none focus:border-[#855cd6]"
              aria-label="Sprite name"
              value={selectedTarget.name}
              onchange={updateTargetName}
            />
            <div class="flex min-w-[82px] items-center gap-[5px]">
              <MoveVertical size={17} class="shrink-0 rotate-90 text-[#575e75]" strokeWidth={3} />
              <span class="shrink-0 text-xs font-bold text-[#575e75]">x</span>
              <input class="h-9 w-[52px] min-w-0 rounded-full border border-[#dddde3] px-2 text-center text-xs font-semibold text-[#575e75] outline-none focus:border-[#855cd6]" aria-label="Sprite x" type="number" value={Math.round(selectedTarget.x ?? 0)} onchange={(event) => updateNumber('x', event)} />
            </div>
            <div class="flex min-w-[82px] items-center gap-[5px]">
              <MoveVertical size={19} class="shrink-0 text-[#575e75]" strokeWidth={3} />
              <span class="shrink-0 text-xs font-bold text-[#575e75]">y</span>
              <input class="h-9 w-[52px] min-w-0 rounded-full border border-[#dddde3] px-2 text-center text-xs font-semibold text-[#575e75] outline-none focus:border-[#855cd6]" aria-label="Sprite y" type="number" value={Math.round(selectedTarget.y ?? 0)} onchange={(event) => updateNumber('y', event)} />
            </div>
            <span class="whitespace-nowrap text-[11px] font-bold text-[#575e75]">0 clones</span>
          </div>
          <div class="mt-2 flex flex-wrap items-end gap-2">
            <div class="w-[80px]">
              <span class="block text-xs font-bold text-[#575e75]">表示する</span>
              <div class="mt-1 flex overflow-hidden rounded border border-[#dddde3]">
                <button class={`flex h-9 w-[37px] items-center justify-center border-r border-[#dddde3] ${selectedTarget.visible !== false ? 'bg-[#eee9fb] text-[#855cd6]' : 'bg-white text-[#9aa0ab]'}`} aria-label="Show sprite" title="Show sprite" onclick={() => setVisible(true)}>
                  <Eye size={18} strokeWidth={3} />
                </button>
                <button class={`flex h-9 w-[37px] items-center justify-center ${selectedTarget.visible === false ? 'bg-[#eee9fb] text-[#855cd6]' : 'bg-white text-[#b5b9c2]'}`} aria-label="Hide sprite" title="Hide sprite" onclick={() => setVisible(false)}>
                  <EyeOff size={18} strokeWidth={3} />
                </button>
              </div>
            </div>
            <div class="w-[94px]">
              <span class="block text-center text-xs font-bold text-[#575e75]">大きさ</span>
              <input class="mt-1 h-9 w-full rounded-full border border-[#dddde3] px-3 text-center text-xs font-semibold text-[#575e75] outline-none focus:border-[#855cd6]" aria-label="Sprite size" type="number" value={Math.round(selectedTarget.size ?? 100)} onchange={(event) => updateNumber('size', event)} />
            </div>
            <div class="relative w-[74px]">
              <span class="block text-center text-xs font-bold text-[#575e75]">向き</span>
              <input
                bind:this={directionInput}
                class="mt-1 h-9 w-full rounded-full border border-[#dddde3] px-3 text-center text-xs font-semibold text-[#575e75] outline-none focus:border-[#855cd6] focus:ring-4 focus:ring-[#855cd6]/30"
                aria-label="Sprite direction"
                type="number"
                value={Math.round(selectedTarget.direction ?? 90)}
                onfocus={() => void openDirectionPicker()}
                onclick={() => void openDirectionPicker()}
                onchange={(event) => updateNumber('direction', event)}
              />
              {#if directionPickerOpen}
                <div bind:this={directionPicker} class="fixed z-[80] w-[168px] rounded bg-white p-6 shadow-[0_4px_14px_rgb(0_0_0/0.24)]" style={directionPickerStyle} role="dialog" tabindex="-1" aria-label="Direction picker" onmousedown={(event) => event.stopPropagation()}>
                  <div
                    class="relative mx-auto h-[120px] w-[120px] cursor-pointer touch-none rounded-full border border-[#d5c4ff] bg-[#eee9fb]"
                    role="slider"
                    aria-label="Direction dial"
                    aria-valuemin="-179"
                    aria-valuemax="180"
                    aria-valuenow={Math.round(selectedTarget.direction ?? 90)}
                    tabindex="0"
                    onpointerdown={beginDirectionDrag}
                    onpointermove={dragDirection}
                    onpointerup={endDirectionDrag}
                    onpointercancel={endDirectionDrag}
                  >
                    {#each Array.from({ length: 24 }) as _, index}
                      <span class="absolute left-1/2 top-1/2 h-[1px] w-2 origin-[0_0] bg-[#c7c3d8]" style={`transform:rotate(${index * 15}deg) translateX(42px)`}></span>
                    {/each}
                    <div class="absolute left-1/2 top-1/2 h-[55px] w-[2px] origin-bottom bg-[#855cd6]" style={directionNeedleStyle(selectedTarget.direction ?? 90)}></div>
                    <button class="absolute right-[-20px] top-1/2 flex h-[38px] w-[38px] -translate-y-1/2 items-center justify-center rounded-full border-4 border-[#d5c4ff] bg-[#855cd6] text-white shadow-sm" aria-label="Direction 90" title="Direction 90" onclick={() => setDirectionAndKeepOpen(90)}>
                      <ArrowLeftRight size={20} strokeWidth={4} />
                    </button>
                  </div>
                  <div class="mt-7 flex justify-center">
                    <div class="flex overflow-hidden rounded border border-[#d9d9d9]">
                      <button class={`flex h-10 w-[37px] items-center justify-center border-r border-[#d9d9d9] ${selectedTarget.rotationStyle !== 'left-right' && selectedTarget.rotationStyle !== "don't rotate" ? 'bg-[#eee9fb] text-[#855cd6]' : 'bg-white text-[#b5b9c2]'}`} aria-label="All around" title="All around" onclick={() => setRotationStyleAndKeepOpen('all around')}>
                        <Circle size={16} strokeWidth={3} />
                      </button>
                      <button class={`flex h-10 w-[37px] items-center justify-center border-r border-[#d9d9d9] ${selectedTarget.rotationStyle === 'left-right' ? 'bg-[#eee9fb] text-[#855cd6]' : 'bg-white text-[#b5b9c2]'}`} aria-label="Left right" title="Left right" onclick={() => setRotationStyleAndKeepOpen('left-right')}>
                        <ArrowLeftRight size={17} strokeWidth={3} />
                      </button>
                      <button class={`flex h-10 w-[37px] items-center justify-center ${selectedTarget.rotationStyle === "don't rotate" ? 'bg-[#eee9fb] text-[#855cd6]' : 'bg-white text-[#b5b9c2]'}`} aria-label="Don't rotate" title="Don't rotate" onclick={() => setRotationStyleAndKeepOpen("don't rotate")}>
                        <EyeOff size={17} strokeWidth={3} />
                      </button>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <div class="flex h-[102px] items-center text-sm font-semibold text-[#575e75]">
            ステージが選択されています
          </div>
        {/if}
      </div>
      <div class="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden border-t border-[#d8e2ef] bg-[#e8f1fc] p-2 pb-20">
        <div class="flex flex-wrap content-start gap-2">
          {#each sprites as sprite}
            <div
              data-testid={`target-card-${sprite.name}`}
              role="button"
              tabindex="0"
              draggable="true"
              class={`relative h-[76px] w-[76px] rounded-lg border-4 bg-white text-center ${selectedTarget?.name === sprite.name ? 'border-[#855cd6] shadow-[0_0_0_3px_#bda6ef]' : 'border-transparent hover:border-[#c9d7e8]'}`}
              onclick={() => selectTarget(sprite.name)}
              onkeydown={(event) => activateOnEnter(event, () => selectTarget(sprite.name))}
              ondragstart={(event) => beginSpriteDrag(sprite.name, event)}
              ondragover={(event) => event.preventDefault()}
              ondrop={(event) => dropSpriteOn(sprite.name, event)}
              ondragend={clearSpriteDrag}
              oncontextmenu={(event) => openSpriteContextMenu(sprite.name, event)}
            >
              {#if selectedTarget?.name === sprite.name}
                <button class="absolute -right-3 -top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full border-4 border-[#bda6ef] bg-[#855cd6] text-white" aria-label="Delete sprite" title="Delete sprite" onclick={(event) => stopClick(event, () => deleteSpriteByName(sprite.name))}>
                  <Trash2 size={14} strokeWidth={3} />
                </button>
              {/if}
              <div class="flex h-[48px] items-center justify-center px-1 pt-1">
                {#if targetThumbnailUrls[targetThumbnailKey(sprite)]}
                  <img class="max-h-full max-w-full object-contain" src={targetThumbnailUrls[targetThumbnailKey(sprite)]} alt="" />
                {:else}
                  <Circle size={26} />
                {/if}
              </div>
              <p class={`mx-[-4px] mt-0 truncate px-1 py-1 text-xs font-bold ${selectedTarget?.name === sprite.name ? 'bg-[#855cd6] text-white' : 'text-[#575e75]'}`}>{sprite.name}</p>
            </div>
          {/each}
        </div>
        <div class="absolute bottom-3 right-3">
          <button data-testid="open-sprite-library" class="flex h-14 w-14 items-center justify-center rounded-full border-4 border-[#bda6ef] bg-[#855cd6] text-white shadow-sm hover:bg-[#7c4fd1]" aria-label="Choose sprite" title="Choose sprite" onclick={() => openLibrary('sprite')}>
            <Sparkles size={24} strokeWidth={3} />
          </button>
        </div>
      </div>
    </div>

    <div class="relative min-h-0 overflow-hidden rounded-lg border border-[#c9d7e8] bg-white p-2 text-center">
      <h2 class="mb-3 text-xs font-bold text-[#575e75]">ステージ</h2>
      <div
        data-testid="target-card-stage"
        role="button"
        tabindex="0"
        class={`mx-auto flex h-[54px] w-[72px] items-center justify-center rounded border bg-white ${selectedTarget?.isStage ? 'border-[#855cd6] ring-2 ring-[#bda6ef]' : 'border-[#d9d9d9]'}`}
        onclick={() => stage && selectTarget(stage.name)}
        onkeydown={(event) => activateOnEnter(event, () => stage && selectTarget(stage.name))}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => stage && dropSpriteOn(stage.name, event)}
      >
        {#if stage && targetThumbnailUrls[targetThumbnailKey(stage)]}
          <img class="max-h-full max-w-full object-contain" src={targetThumbnailUrls[targetThumbnailKey(stage)]} alt="" />
        {:else}
          <Box size={22} class="text-[#9aa0ab]" />
        {/if}
      </div>
      <p class="mt-3 text-xs font-semibold text-[#575e75]">背景</p>
      <p class="text-xs font-semibold text-[#855cd6]">{stage?.costumes.length ?? 0}</p>
      <button data-testid="open-backdrop-library" class="absolute bottom-3 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full border-4 border-[#bda6ef] bg-[#855cd6] text-white shadow-sm hover:bg-[#7c4fd1]" aria-label="Choose backdrop" title="Choose backdrop" onclick={() => openLibrary('backdrop')}>
        <ImagePlus size={24} strokeWidth={3} />
      </button>
    </div>
  </div>

  <div class="mt-2 hidden">
    <button onclick={paintNewSprite}>Paint sprite</button>
    <button onclick={openSpritePicker}><Upload size={16} /></button>
    <button onclick={surpriseSprite}><Shuffle size={16} /></button>
    <button onclick={addSprite}><Plus size={16} /></button>
    <button onclick={paintNewBackdrop}>Paint backdrop</button>
    <button onclick={openBackdropPicker}>Upload backdrop</button>
    <button onclick={surpriseBackdrop}>Surprise backdrop</button>
    {#each libraryItems as item}
      <button onclick={() => addLibrarySprite(item)}>{item.name}</button>
    {/each}
  </div>

  {#if spriteContextMenu}
    <div
      class="fixed z-[80] w-36 rounded-md border border-slate-200 bg-white py-1 text-sm font-semibold shadow-lg"
      style={`left:${spriteContextMenu.x}px;top:${spriteContextMenu.y}px`}
      role="menu"
      tabindex="-1"
      onmousedown={(event) => event.stopPropagation()}
    >
      <button class="block w-full px-3 py-2 text-left hover:bg-slate-50" role="menuitem" onclick={() => duplicateSpriteByName(spriteContextMenu!.name)}>Duplicate</button>
      <button class="block w-full px-3 py-2 text-left hover:bg-slate-50" role="menuitem" onclick={() => exportSpriteByName(spriteContextMenu!.name)}>Export</button>
      <button class="block w-full px-3 py-2 text-left text-rose-600 hover:bg-rose-50" role="menuitem" onclick={() => deleteSpriteByName(spriteContextMenu!.name, true)}>Delete</button>
    </div>
  {/if}
</section>
