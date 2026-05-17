<script lang="ts">
  import { Flag, Maximize2, Minimize2, Pause, Square } from 'lucide-svelte'
  import type { RuntimeSnapshot } from '@hikkaku/vm'

  type Monitor = RuntimeSnapshot['project']['monitors'][number]

  let {
    stageCanvas = $bindable(),
    stageFullscreen,
    snapshot,
    fps,
    visibleMonitors,
    toggleStageFullscreen,
    pickSprite,
    updateMouse,
    beginStageSpriteDrag,
    dragStageSprite,
    endStageSpriteDrag,
    cancelStageSpriteDrag,
    cycleMonitorMode,
    setMonitorMode,
    hideMonitor,
    editMonitorSliderLimit,
    updateMonitorSlider,
    greenFlag,
    stopAll,
    stepRuntime,
  } = $props<{
    stageCanvas?: HTMLCanvasElement
    stageFullscreen: boolean
    snapshot: RuntimeSnapshot
    fps: number
    visibleMonitors: Monitor[]
    toggleStageFullscreen: () => void
    pickSprite: (event: MouseEvent) => void
    updateMouse: (event: MouseEvent | PointerEvent) => void
    beginStageSpriteDrag: (event: PointerEvent) => void
    dragStageSprite: (event: PointerEvent) => void
    endStageSpriteDrag: (event: PointerEvent) => void
    cancelStageSpriteDrag: (event?: PointerEvent) => void
    cycleMonitorMode: (id: string) => void
    setMonitorMode: (id: string, mode: string) => void
    hideMonitor: (id: string) => void
    editMonitorSliderLimit: (id: string, field: 'sliderMin' | 'sliderMax') => void
    updateMonitorSlider: (id: string, field: 'sliderMin' | 'sliderMax', event: Event) => void
    greenFlag: () => void
    stopAll: () => void
    stepRuntime: () => void
  }>()

  let stageFrame: HTMLDivElement | undefined
  let monitorContextMenu = $state<{ monitorId: string; x: number; y: number } | undefined>()

  function monitorLabel(monitor: Monitor) {
    if (monitor.params.VARIABLE) return String(monitor.params.VARIABLE)
    if (monitor.params.LIST) return String(monitor.params.LIST)
    const labels: Record<string, string> = {
      motion_xposition: 'x position',
      motion_yposition: 'y position',
      motion_direction: 'direction',
      looks_size: 'size',
      looks_costumenumbername: `costume ${monitor.params.NUMBER_NAME ?? 'number'}`,
      looks_backdropnumbername: `backdrop ${monitor.params.NUMBER_NAME ?? 'number'}`,
      sound_volume: 'volume',
      sensing_answer: 'answer',
      sensing_mousedown: 'mouse down?',
      sensing_mousex: 'mouse x',
      sensing_mousey: 'mouse y',
      sensing_loudness: 'loudness',
      sensing_timer: 'timer',
      sensing_current: `current ${String(monitor.params.CURRENTMENU ?? 'YEAR').toLowerCase()}`,
      sensing_dayssince2000: 'days since 2000',
      sensing_username: 'username',
      control_get_counter: 'counter',
      music_getTempo: 'tempo',
      translate_getViewerLanguage: 'language',
      speech2text_getSpeech: 'speech',
    }
    return labels[monitor.opcode] ?? monitor.opcode
  }

  function monitorText(value: Monitor['value']) {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
    return String(value ?? '')
  }

  function monitorPosition(monitor: Monitor, index: number) {
    const x = typeof monitor.x === 'number' ? monitor.x : 5
    const y = typeof monitor.y === 'number' ? monitor.y : 5 + index * 34
    return `left: ${(x / 480) * 100}%; top: ${(y / 360) * 100}%;`
  }

  function openMonitorContextMenu(monitor: Monitor, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    openMonitorContextMenuAt(monitor, event.clientX, event.clientY)
  }

  function openMonitorKeyboardContextMenu(monitor: Monitor, event: KeyboardEvent) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    openMonitorContextMenuAt(monitor, rect.left + 8, rect.bottom + 4)
  }

  function openMonitorContextMenuAt(monitor: Monitor, clientX: number, clientY: number) {
    const rect = stageFrame?.getBoundingClientRect()
    const x = rect ? Math.min(Math.max(clientX - rect.left, 4), Math.max(4, rect.width - 180)) : 4
    const y = rect ? Math.min(Math.max(clientY - rect.top, 4), Math.max(4, rect.height - 160)) : 4
    monitorContextMenu = { monitorId: monitor.id, x, y }
  }

  function closeMonitorContextMenu() {
    monitorContextMenu = undefined
  }

  function contextMonitor(): Monitor | undefined {
    return visibleMonitors.find((monitor: Monitor) => monitor.id === monitorContextMenu?.monitorId)
  }

  function chooseMonitorMode(id: string, mode: string) {
    setMonitorMode(id, mode)
    closeMonitorContextMenu()
  }

  function editSliderLimit(id: string, field: 'sliderMin' | 'sliderMax') {
    editMonitorSliderLimit(id, field)
    closeMonitorContextMenu()
  }
</script>

<section class="shrink-0 px-4 pb-2 pt-1">
  <div class="mb-1 flex h-10 items-center justify-between">
    <div class="flex items-center gap-2">
      <button
        class={`flex h-8 w-8 items-center justify-center rounded text-[#40bf4a] transition-[background-color,transform] hover:scale-105 ${snapshot.running ? 'bg-[#855cd6]/35 hover:bg-[#855cd6]/35' : 'hover:bg-[#855cd6]/15'}`}
        aria-label="Green flag"
        title="Green flag"
        onclick={greenFlag}
      >
        <Flag size={25} fill="currentColor" strokeWidth={1.5} />
      </button>
      <button class="flex h-8 w-8 items-center justify-center text-[#ffab19] hover:text-[#ff8c1a]" aria-label="Pause" title="Pause" onclick={stepRuntime}>
        <Pause size={25} fill="currentColor" strokeWidth={1.5} />
      </button>
      <button class="flex h-8 w-8 items-center justify-center text-[#ec8c99] hover:text-[#ff6680]" aria-label="Stop all" title="Stop all" onclick={stopAll}>
        <Square size={22} fill="currentColor" strokeWidth={1.5} class="rotate-45 rounded" />
      </button>
      <span class="min-w-12 text-left font-mono text-[11px] font-semibold tabular-nums text-[#575e75]" aria-label="FPS" title="FPS" data-testid="stage-fps">
        {fps} fps
      </span>
    </div>
    <div class="flex overflow-hidden rounded border border-[#c8c8d0] bg-white">
      <button class="flex h-9 w-10 items-center justify-center text-[#575e75] hover:bg-[#f2f2f2]" aria-label={stageFullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={stageFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onclick={toggleStageFullscreen}>
        {#if stageFullscreen}
          <Minimize2 size={20} strokeWidth={3} />
        {:else}
          <Maximize2 size={20} strokeWidth={3} />
        {/if}
      </button>
    </div>
  </div>
  <div bind:this={stageFrame} class="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-[#b8c6d8] bg-white">
    <canvas
      data-testid="stage-canvas"
      bind:this={stageCanvas}
      class="block h-full w-full touch-none bg-white"
      width="480"
      height="360"
      aria-label="Scratch stage"
      onclick={(event) => {
        closeMonitorContextMenu()
        pickSprite(event)
      }}
      onpointerdown={beginStageSpriteDrag}
      onpointermove={dragStageSprite}
      onpointerup={endStageSpriteDrag}
      onpointercancel={endStageSpriteDrag}
      onlostpointercapture={cancelStageSpriteDrag}
      onpointerleave={updateMouse}
    ></canvas>
    {#each visibleMonitors as monitor, index}
      <div
        class={`group absolute z-10 max-w-[48%] select-none border border-black/15 bg-[#f7f7f7] text-[11px] leading-none text-[#575e75] shadow-[0_1px_2px_rgba(0,0,0,.25)] ${monitor.mode === 'large' ? 'rounded px-1.5 py-1' : monitor.mode === 'list' ? 'min-w-28 rounded bg-[#fffaf0]' : 'rounded px-1 py-0.5'}`}
        style={monitorPosition(monitor, index)}
        role="button"
        aria-label={`${monitorLabel(monitor)} monitor`}
        tabindex="0"
        oncontextmenu={(event) => openMonitorContextMenu(monitor, event)}
        onkeydown={(event) => openMonitorKeyboardContextMenu(monitor, event)}
      >
        {#if monitor.mode === 'list'}
          <div class="border-b border-black/10 bg-[#f7f7f7] px-1.5 py-1 text-center font-semibold text-[#575e75]">
            <button class="max-w-full truncate" title="Change monitor mode" onclick={() => cycleMonitorMode(monitor.id)}>{monitorLabel(monitor)}</button>
          </div>
          <div class="max-h-28 min-h-16 overflow-auto bg-white px-1 py-1 text-[#222]">
            {#each monitorText(monitor.value) as item, itemIndex}
              <div class="mb-0.5 flex min-w-0 items-center gap-1">
                <span class="w-4 shrink-0 text-right text-[10px] text-[#8a8a8a]">{itemIndex + 1}</span>
                <span class="min-w-0 flex-1 rounded border border-[#ff8c1a]/40 bg-[#fff8e8] px-1 py-0.5 font-mono text-[11px] leading-tight">{item}</span>
              </div>
            {/each}
          </div>
        {:else if monitor.mode === 'large'}
          <button class="block min-w-14 text-center font-mono text-[22px] font-bold leading-none text-white [text-shadow:0_1px_1px_rgba(0,0,0,.35)]" title={monitorLabel(monitor)} onclick={() => cycleMonitorMode(monitor.id)}>
            {monitorText(monitor.value)}
          </button>
        {:else}
          <div class="flex items-center gap-1">
            <button class="max-w-28 truncate font-semibold" title="Change monitor mode" onclick={() => cycleMonitorMode(monitor.id)}>{monitorLabel(monitor)}</button>
            <span class="rounded bg-[#ff8c1a] px-2 py-1 font-mono text-[11px] font-bold leading-none text-white shadow-inner">{monitorText(monitor.value)}</span>
          </div>
        {/if}
        {#if monitor.mode === 'slider'}
          <div class="mt-1 flex items-center gap-1">
            <input class="h-1.5 min-w-20 accent-[#ff8c1a]" aria-label="Monitor slider" type="range" min={monitor.sliderMin ?? 0} max={monitor.sliderMax ?? 100} value={Number(monitor.value ?? 0)} />
            <button class="rounded bg-white px-1 text-[10px] font-semibold" title="Hide monitor" onclick={() => hideMonitor(monitor.id)}>x</button>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-1">
            <input class="min-w-0 rounded border border-black/10 bg-white px-1 py-0.5 text-[10px]" aria-label="Monitor slider min" type="number" value={monitor.sliderMin ?? 0} onchange={(event) => updateMonitorSlider(monitor.id, 'sliderMin', event)} />
            <input class="min-w-0 rounded border border-black/10 bg-white px-1 py-0.5 text-[10px]" aria-label="Monitor slider max" type="number" value={monitor.sliderMax ?? 100} onchange={(event) => updateMonitorSlider(monitor.id, 'sliderMax', event)} />
          </div>
        {:else}
          <button class="absolute -right-1.5 -top-1.5 hidden h-4 w-4 rounded-full border border-black/20 bg-white text-[10px] font-bold leading-3 text-[#575e75] group-hover:block" title="Hide monitor" onclick={() => hideMonitor(monitor.id)}>x</button>
        {/if}
      </div>
    {/each}
    {#if monitorContextMenu && contextMonitor()}
      {@const monitor = contextMonitor()!}
      <div
        class="absolute z-30 w-44 overflow-hidden rounded border border-black/15 bg-white py-1 text-[12px] text-[#575e75] shadow-xl"
        style={`left:${monitorContextMenu.x}px;top:${monitorContextMenu.y}px`}
        role="menu"
        tabindex="-1"
        aria-label="Monitor options"
      >
        {#if monitor.opcode === 'data_listcontents'}
          <button class={`block w-full px-3 py-2 text-left hover:bg-[#f2f2f2] ${monitor.mode === 'list' ? 'font-bold text-[#855cd6]' : ''}`} role="menuitem" onclick={() => chooseMonitorMode(monitor.id, 'list')}>リスト</button>
        {:else}
          <button class={`block w-full px-3 py-2 text-left hover:bg-[#f2f2f2] ${monitor.mode === 'default' ? 'font-bold text-[#855cd6]' : ''}`} role="menuitem" onclick={() => chooseMonitorMode(monitor.id, 'default')}>普通の表示</button>
          <button class={`block w-full px-3 py-2 text-left hover:bg-[#f2f2f2] ${monitor.mode === 'large' ? 'font-bold text-[#855cd6]' : ''}`} role="menuitem" onclick={() => chooseMonitorMode(monitor.id, 'large')}>大きな表示</button>
          <button class={`block w-full px-3 py-2 text-left hover:bg-[#f2f2f2] ${monitor.mode === 'slider' ? 'font-bold text-[#855cd6]' : ''}`} role="menuitem" onclick={() => chooseMonitorMode(monitor.id, 'slider')}>スライダー</button>
          <div class="my-1 border-t border-slate-200"></div>
          <button class="block w-full px-3 py-2 text-left hover:bg-[#f2f2f2]" role="menuitem" onclick={() => editSliderLimit(monitor.id, 'sliderMin')}>最小値を変更</button>
          <button class="block w-full px-3 py-2 text-left hover:bg-[#f2f2f2]" role="menuitem" onclick={() => editSliderLimit(monitor.id, 'sliderMax')}>最大値を変更</button>
        {/if}
        <div class="my-1 border-t border-slate-200"></div>
        <button class="block w-full px-3 py-2 text-left text-rose-600 hover:bg-rose-50" role="menuitem" onclick={() => { hideMonitor(monitor.id); closeMonitorContextMenu() }}>隠す</button>
      </div>
    {/if}
  </div>
</section>
