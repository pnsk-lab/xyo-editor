<script lang="ts">
  import {
    Clipboard,
    Copy,
    FlipHorizontal2,
    Gauge,
    Pause,
    Play,
    Redo2,
    Scissors,
    Snail,
    Trash2,
    Undo2,
    Volume1,
    Volume2,
    Wand2,
    Waves,
  } from 'lucide-svelte'
  import type { ScratchTarget } from '@hikkaku/vm'
  import type { AssetHistoryEntry, SoundEffect } from '../../lib/editor-types'

  let {
    selectedTarget,
    selectedSoundIndex,
    assetUndoStack,
    assetRedoStack,
    soundClipboard,
    soundWaveform,
    soundTrimStart = $bindable(0),
    soundTrimEnd = $bindable(1),
    soundPlayhead,
    previewAudio,
    soundTrimDrag = $bindable(),
    undoAssetEdit,
    redoAssetEdit,
    updateSoundName,
    addSoundToBackpack,
    restoreSoundFromBackpack,
    generateTone,
    previewSound,
    stopPreviewSound,
    copySound,
    pasteSound,
    copySoundToNew,
    exportSound,
    deleteSoundSelection,
    editSound,
    beginSoundWaveformSelection,
    updateSoundWaveformSelection,
    endSoundWaveformSelection,
    beginSoundTrimHandle,
    dragSoundTrimHandle,
    endSoundTrimHandle,
    updateSoundTrim,
  } = $props<{
    selectedTarget: ScratchTarget | undefined
    selectedSoundIndex: number
    assetUndoStack: AssetHistoryEntry[]
    assetRedoStack: AssetHistoryEntry[]
    soundClipboard: Uint8Array | undefined
    soundWaveform: number[]
    soundTrimStart: number
    soundTrimEnd: number
    soundPlayhead: number
    previewAudio: AudioBufferSourceNode | undefined
    soundTrimDrag: 'start' | 'end' | undefined
    undoAssetEdit: () => void | Promise<void>
    redoAssetEdit: () => void | Promise<void>
    updateSoundName: (index: number, event: Event) => void
    addSoundToBackpack: () => void | Promise<void>
    restoreSoundFromBackpack: () => void | Promise<void>
    generateTone: () => void | Promise<void>
    previewSound: (index: number) => void | Promise<void>
    stopPreviewSound: () => void
    copySound: (index: number) => void | Promise<void>
    pasteSound: (index: number) => void | Promise<void>
    copySoundToNew: (index: number) => void | Promise<void>
    exportSound: (index: number) => void | Promise<void>
    deleteSoundSelection: (index: number, keepSelection?: boolean) => void | Promise<void>
    editSound: (index: number, effect: SoundEffect) => void | Promise<void>
    beginSoundWaveformSelection: (event: MouseEvent) => void
    updateSoundWaveformSelection: (event: MouseEvent) => void
    endSoundWaveformSelection: (event: MouseEvent) => void
    beginSoundTrimHandle: (which: 'start' | 'end', event: PointerEvent) => void
    dragSoundTrimHandle: (event: PointerEvent) => void
    endSoundTrimHandle: (event: PointerEvent) => void
    updateSoundTrim: (which: 'start' | 'end', event: Event) => void
  }>()

  const effects: Array<{ id: SoundEffect; label: string; icon: typeof Gauge; testId?: string }> = [
    { id: 'faster', label: '速く', icon: Gauge, testId: 'sound-effect-faster' },
    { id: 'slower', label: '遅く', icon: Snail },
    { id: 'louder', label: '大きく', icon: Volume2, testId: 'sound-effect-louder' },
    { id: 'softer', label: '小さく', icon: Volume1 },
    { id: 'mute', label: 'ミュート', icon: Waves },
    { id: 'fade-in', label: 'フェードイン', icon: Waves },
    { id: 'fade-out', label: 'フェードアウト', icon: Waves },
    { id: 'reverse', label: '逆向き', icon: FlipHorizontal2, testId: 'sound-effect-reverse' },
    { id: 'robot', label: 'ロボット', icon: Wand2 },
  ]

  function waveformAreaPath(peaks: number[]) {
    const rawValues = peaks.length ? peaks : Array.from({ length: 34 }, (_, index) => 0.55 + Math.sin(index / 4) * 0.1)
    const maxPeak = Math.max(0.01, ...rawValues)
    const values = rawValues.map((peak) => Math.min(0.96, (peak / maxPeak) * 0.88))
    const width = 1000
    const middle = 150
    const top = values.map((peak, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width
      const y = middle - Math.max(0.06, peak) * 118
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    const bottom = values
      .map((peak, index) => {
        const x = ((values.length - 1 - index) / Math.max(1, values.length - 1)) * width
        const y = middle + Math.max(0.06, values[values.length - 1 - index]) * 118
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
    return `${top.join(' ')} ${bottom} Z`
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-white">
  <div class="flex min-h-[94px] shrink-0 items-center gap-6 overflow-x-auto border-b border-slate-100 px-5 py-4">
    <div class="flex min-w-[220px] items-center gap-3">
      <span class="text-xs font-bold text-[#575e75]">音</span>
      <input class="h-9 w-44 rounded-full border border-slate-200 bg-white px-5 text-sm font-bold text-[#575e75] outline-none transition focus:border-[#8d5de8] focus:ring-2 focus:ring-[#8d5de8]/25 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400" value={selectedTarget?.sounds[selectedSoundIndex]?.name ?? ''} aria-label={`Rename ${selectedTarget?.sounds[selectedSoundIndex]?.name || 'sound'}`} disabled={!selectedTarget?.sounds[selectedSoundIndex]} onchange={(event) => updateSoundName(selectedSoundIndex, event)} />
    </div>

    <div class="flex overflow-hidden rounded border border-slate-200 bg-white">
      <button class="sound-icon-button" type="button" aria-label="Undo" title="Undo" disabled={assetUndoStack.length === 0} onclick={undoAssetEdit}><Undo2 size={18} /></button>
      <button class="sound-icon-button border-l border-slate-200" type="button" aria-label="Redo" title="Redo" disabled={assetRedoStack.length === 0} onclick={redoAssetEdit}><Redo2 size={18} /></button>
    </div>

    <div class="h-11 border-l border-dashed border-slate-200"></div>

    <div class="flex items-center gap-7 text-[#8d5de8]">
      <button class="sound-top-tool" type="button" aria-label="Copy sound to new" title="コピー" onclick={() => copySoundToNew(selectedSoundIndex)}>
        <Copy size={23} />
        <span>コピー</span>
      </button>
      <button class="sound-top-tool" type="button" aria-label="Paste sound" title="貼り付け" disabled={!soundClipboard} onclick={() => pasteSound(selectedSoundIndex)}>
        <Clipboard size={23} />
        <span>貼り付け</span>
      </button>
      <button class="sound-top-tool" type="button" aria-label="Copy sound" title="音をコピー" onclick={() => copySound(selectedSoundIndex)}>
        <Copy size={23} />
        <span>音をコピー</span>
      </button>
    </div>

    <div class="h-11 border-l border-dashed border-slate-200"></div>

    <button class="sound-top-tool" type="button" aria-label="Delete selection" title="削除" onclick={() => deleteSoundSelection(selectedSoundIndex, false)}>
      <Scissors size={24} />
      <span>削除</span>
    </button>
    <button class="sr-only" onclick={addSoundToBackpack}>Pack</button>
    <button class="sr-only" onclick={restoreSoundFromBackpack}>Unpack</button>
    <button data-testid="generate-tone" class="sr-only" onclick={generateTone}>Generate tone</button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col px-5 py-7">
    {#if selectedTarget?.sounds[selectedSoundIndex]}
      <div
        class="relative h-[302px] shrink-0 cursor-crosshair overflow-hidden rounded-md border border-[#dac9df] bg-[#f7e8f7]"
        role="slider"
        tabindex="0"
        aria-label="Sound waveform selection"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(soundTrimEnd * 100)}
        onmousedown={beginSoundWaveformSelection}
        onmousemove={updateSoundWaveformSelection}
        onmouseup={endSoundWaveformSelection}
        onmouseleave={endSoundWaveformSelection}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            soundTrimStart = 0
            soundTrimEnd = 1
          }
        }}
      >
        <svg class="absolute inset-0 h-full w-full" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
          <path d={waveformAreaPath(soundWaveform)} fill="#d77ed8" stroke="#c93dc9" stroke-width="2.2" vector-effect="non-scaling-stroke" />
        </svg>
        {#if Math.abs(soundTrimEnd - soundTrimStart) < 0.995}
          <div class="pointer-events-none absolute inset-y-0 bg-blue-300/25" style={`left:${Math.min(soundTrimStart, soundTrimEnd) * 100}%;width:${Math.max(0.5, Math.abs(soundTrimEnd - soundTrimStart) * 100)}%`}></div>
        {/if}
        <button
          style={`left:${Math.min(soundTrimStart, soundTrimEnd) * 100}%`}
          class={`sound-trim-handle absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded bg-[#8d5de8]/80 ${Math.abs(soundTrimEnd - soundTrimStart) >= 0.995 ? 'opacity-0 focus:opacity-100' : ''}`}
          aria-label="Move selection start"
          onpointerdown={(event) => beginSoundTrimHandle('start', event)}
          onpointermove={dragSoundTrimHandle}
          onpointerup={endSoundTrimHandle}
          onpointercancel={() => (soundTrimDrag = undefined)}
        ></button>
        <button
          style={`left:${Math.max(soundTrimStart, soundTrimEnd) * 100}%`}
          class={`sound-trim-handle absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded bg-[#8d5de8]/80 ${Math.abs(soundTrimEnd - soundTrimStart) >= 0.995 ? 'opacity-0 focus:opacity-100' : ''}`}
          aria-label="Move selection end"
          onpointerdown={(event) => beginSoundTrimHandle('end', event)}
          onpointermove={dragSoundTrimHandle}
          onpointerup={endSoundTrimHandle}
          onpointercancel={() => (soundTrimDrag = undefined)}
        ></button>
        {#if previewAudio}
          <div class="pointer-events-none absolute inset-y-1 w-0.5 rounded bg-[#8d5de8]" style={`left:${Math.max(0, Math.min(100, soundPlayhead * 100))}%`}></div>
        {/if}
      </div>

      <div class="sound-tool-grid mt-12 shrink-0">
        <button data-testid="preview-sound" class="sound-round-button sound-round-primary" type="button" aria-label="Play selection" title="Play" aria-pressed={Boolean(previewAudio)} onclick={() => previewSound(selectedSoundIndex)}>
          <Play size={22} fill="currentColor" />
        </button>
        <button data-testid="stop-preview-sound" class="sound-round-button sound-round-stop" type="button" aria-label="Stop" title="Stop" onclick={stopPreviewSound}>
          <Pause size={22} fill="currentColor" />
        </button>
        <button class="sound-round-button sound-round-copy" type="button" aria-label="Copy selected sound" title="Copy" onclick={() => copySoundToNew(selectedSoundIndex)}>
          <Copy size={20} />
        </button>
        <div class="h-12 border-l border-dashed border-slate-200"></div>
        {#each effects as effect}
          {@const Icon = effect.icon}
          <button data-testid={effect.testId} class="sound-effect-tool" type="button" aria-label={effect.label} title={effect.label} onclick={() => editSound(selectedSoundIndex, effect.id)}>
            <Icon size={19} />
            <span>{effect.label}</span>
          </button>
        {/each}
        <button class="sound-effect-tool" type="button" aria-label="Export sound" title="Export" onclick={() => exportSound(selectedSoundIndex)}>
          <Waves size={19} />
          <span>書き出し</span>
        </button>
        <button class="sound-effect-tool danger" type="button" aria-label="Keep selection" title="Keep selection" onclick={() => deleteSoundSelection(selectedSoundIndex, true)}>
          <Trash2 size={19} />
          <span>切り抜き</span>
        </button>
      </div>
    {:else}
      <div class="flex min-h-[420px] flex-1 flex-col items-center justify-center rounded-md border border-dashed border-[#d7c8ec] bg-[#fbf7ff] px-6 text-center">
        <div class="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-[#8d5de8] text-white shadow-md ring-8 ring-[#e7d9fb]">
          <Waves size={38} />
        </div>
        <h2 class="text-xl font-bold text-[#575e75]">音を追加しましょう</h2>
        <p class="mt-2 max-w-sm text-sm font-semibold leading-6 text-slate-500">左下の音ボタンから新しい音を追加できます。ライブラリから選ぶ、録音する、アップロードすることもできます。</p>
      </div>
      <div class="sound-tool-grid mt-8 shrink-0">
        <button data-testid="preview-sound" class="sound-round-button sound-round-primary" type="button" aria-label="Play selection" title="Play" aria-pressed={Boolean(previewAudio)} onclick={() => previewSound(selectedSoundIndex)}>
          <Play size={22} fill="currentColor" />
        </button>
        <button data-testid="stop-preview-sound" class="sound-round-button sound-round-stop" type="button" aria-label="Stop" title="Stop" onclick={stopPreviewSound}>
          <Pause size={22} fill="currentColor" />
        </button>
        <button class="sound-round-button sound-round-copy" type="button" aria-label="Copy selected sound" title="Copy" onclick={() => copySoundToNew(selectedSoundIndex)}>
          <Copy size={20} />
        </button>
        <div class="h-12 border-l border-dashed border-slate-200"></div>
        {#each effects as effect}
          {@const Icon = effect.icon}
          <button data-testid={effect.testId} class="sound-effect-tool" type="button" aria-label={effect.label} title={effect.label} onclick={() => editSound(selectedSoundIndex, effect.id)}>
            <Icon size={19} />
            <span>{effect.label}</span>
          </button>
        {/each}
        <button class="sound-effect-tool danger" type="button" aria-label="Keep selection" title="Keep selection" onclick={() => deleteSoundSelection(selectedSoundIndex, true)}>
          <Trash2 size={19} />
          <span>切り抜き</span>
        </button>
      </div>
    {/if}

    <div class="mt-auto grid gap-2 opacity-0 md:grid-cols-2">
      <label class="text-xs font-semibold text-slate-600">
        Selection start {Math.round(soundTrimStart * 100)}%
        <input class="mt-1 w-full" type="range" min="0" max="100" value={Math.round(soundTrimStart * 100)} oninput={(event) => updateSoundTrim('start', event)} />
      </label>
      <label class="text-xs font-semibold text-slate-600">
        Selection end {Math.round(soundTrimEnd * 100)}%
        <input class="mt-1 w-full" type="range" min="0" max="100" value={Math.round(soundTrimEnd * 100)} oninput={(event) => updateSoundTrim('end', event)} />
      </label>
    </div>
  </div>
</div>

<style>
  .sound-icon-button {
    display: inline-flex;
    height: 2.25rem;
    width: 2.5rem;
    align-items: center;
    justify-content: center;
    color: #8d5de8;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .sound-top-tool {
    display: inline-flex;
    min-width: 3.25rem;
    min-height: 3.45rem;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    border: 1px solid #ead7f2;
    border-radius: 0.5rem;
    background: #ffffff;
    padding: 0.45rem 0.55rem;
    box-shadow: 0 1px 2px rgb(15 23 42 / 0.06);
    font-size: 0.68rem;
    font-weight: 700;
    color: #8d5de8;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .sound-top-tool:disabled,
  .sound-effect-tool:disabled,
  .sound-icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.35;
    box-shadow: none;
  }

  .sound-tool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(4.15rem, max-content));
    align-items: start;
    gap: 0.85rem;
    overflow: visible;
  }

  .sound-effect-tool {
    display: inline-flex;
    min-width: 4.15rem;
    min-height: 3.75rem;
    flex-shrink: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: 1px solid #ead7f2;
    border-radius: 0.5rem;
    background: #ffffff;
    padding: 0.5rem 0.55rem;
    box-shadow: 0 1px 2px rgb(15 23 42 / 0.06);
    color: #cf63cf;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.1;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .sound-top-tool:not(:disabled):hover,
  .sound-effect-tool:not(:disabled):hover,
  .sound-icon-button:not(:disabled):hover {
    border-color: #cf63cf;
    background: #fbf2ff;
    color: #8d3fc7;
    box-shadow: 0 5px 14px rgb(141 93 232 / 0.16);
  }

  .sound-top-tool:not(:disabled):active,
  .sound-effect-tool:not(:disabled):active,
  .sound-icon-button:not(:disabled):active,
  .sound-round-button:not(:disabled):active {
    transform: translateY(1px) scale(0.98);
  }

  .sound-top-tool:focus-visible,
  .sound-effect-tool:focus-visible,
  .sound-icon-button:focus-visible,
  .sound-round-button:focus-visible,
  .sound-trim-handle:focus-visible {
    outline: 3px solid #4c97ff;
    outline-offset: 3px;
  }

  .sound-effect-tool.danger {
    border-color: #fecdd3;
    color: #e11d48;
  }

  .sound-effect-tool.danger:not(:disabled):hover {
    border-color: #fb7185;
    background: #fff1f2;
    color: #be123c;
  }

  .sound-round-button {
    display: inline-flex;
    height: 3rem;
    width: 3rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: #ffffff;
    box-shadow: 0 6px 14px rgb(15 23 42 / 0.16);
    transition:
      filter 120ms ease,
      transform 80ms ease,
      box-shadow 120ms ease;
  }

  .sound-round-button:hover {
    filter: brightness(1.06);
    box-shadow: 0 9px 20px rgb(15 23 42 / 0.2);
  }

  .sound-round-button[aria-pressed='true'] {
    outline: 3px solid #4c97ff;
    outline-offset: 3px;
  }

  .sound-round-primary {
    background: #8d5de8;
    box-shadow: 0 6px 14px rgb(141 93 232 / 0.24), 0 0 0 4px #d8c4f5;
  }

  .sound-round-stop {
    background: #ffbf42;
    box-shadow: 0 6px 14px rgb(255 191 66 / 0.24), 0 0 0 4px #ffe4ad;
  }

  .sound-round-copy {
    background: #cf63cf;
    box-shadow: 0 6px 14px rgb(207 99 207 / 0.24), 0 0 0 4px #f0b4f0;
  }

  .sound-trim-handle {
    transition:
      opacity 120ms ease,
      background-color 120ms ease,
      box-shadow 120ms ease;
  }

  .sound-trim-handle:hover,
  .sound-trim-handle:focus-visible {
    background: #6f3fca;
    box-shadow: 0 0 0 3px rgb(76 151 255 / 0.35);
  }
</style>
