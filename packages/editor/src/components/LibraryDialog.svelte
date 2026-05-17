<script lang="ts">
  import type { LibraryPanel, LibraryItem } from '../lib/editor-types'

  let {
    libraryPanel,
    librarySearch = $bindable(''),
    items,
    chooseItem,
    close,
    bytesToLocalBase64,
    librarySvg,
  } = $props<{
    libraryPanel: LibraryPanel
    librarySearch: string
    items: LibraryItem[]
    chooseItem: (item: LibraryItem) => void | Promise<void>
    close: () => void
    bytesToLocalBase64: (bytes: Uint8Array) => string
    librarySvg: (shape: string, color: string) => string
  }>()

  const assetPageSize = 120
  let visibleAssetCount = $state(assetPageSize)
  let lastLibraryKey = $state('')

  $effect(() => {
    const nextKey = `${libraryPanel ?? ''}:${librarySearch}:${items.length}`
    if (nextKey === lastLibraryKey) return
    lastLibraryKey = nextKey
    visibleAssetCount = assetPageSize
  })

  const visibleItems = $derived(libraryPanel === 'extension' ? items : items.slice(0, visibleAssetCount))

  function stopMouseDown(event: MouseEvent) {
    event.stopPropagation()
  }

  function extensionDescription(item: LibraryItem) {
    if (!('extensionId' in item)) return ''
    const descriptions: Record<string, string> = {
      music: '楽器やドラムを演奏する。',
      pen: 'スプライトで絵を描く。',
      videoSensing: 'カメラで動きを検知する。',
      translate: '色々な言語にテキストを翻訳する。',
      text2speech: '言葉をしゃべるプロジェクトを作ろう。',
      speech2text: '声を聞き取ってテキストにする。',
      microbit: 'プロジェクトを現実の世界と接続する。',
      makeymakey: 'なんでもキーボードにしてみる。',
      ev3: '対話型ロボットなどを作る。',
      wedo2: 'モーターやセンサーを使う。',
      boost: 'LEGO BOOST と接続する。',
      gdxfor: '押す力、引く力、動き、回転を検出する。',
      faceSensing: 'Sense faces with the camera.',
    }
    return descriptions[item.extensionId] ?? item.tags.join(' / ')
  }
</script>

{#if libraryPanel}
  <div class={`fixed inset-0 z-[90] ${libraryPanel === 'extension' ? 'bg-[#e8f1fc]' : 'bg-slate-950/30 p-4'}`} role="presentation" onmousedown={close}>
    <div class={libraryPanel === 'extension' ? 'flex h-full flex-col overflow-hidden bg-[#e8f1fc]' : 'mx-auto flex max-h-[min(42rem,calc(100svh-2rem))] max-w-3xl flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl'} role="dialog" aria-modal="true" aria-label={`${libraryPanel} library`} tabindex="-1" onmousedown={stopMouseDown}>
      {#if libraryPanel === 'extension'}
        <div class="grid h-11 shrink-0 grid-cols-[8rem_1fr_8rem] items-center bg-[#855cd6] px-3 text-white">
          <button class="flex h-full items-center gap-2 justify-self-start text-lg font-bold" type="button" onclick={close} aria-label="戻る">
            <span class="text-2xl leading-none">←</span>
            <span>戻る</span>
          </button>
          <h2 class="justify-self-center text-base font-bold">拡張機能を選ぶ</h2>
        </div>
        <div class="grid flex-1 auto-rows-[17.5rem] grid-cols-[repeat(auto-fill,minmax(min(15.5rem,100%),1fr))] gap-4 overflow-auto p-3 sm:p-4">
          {#each visibleItems as item}
            <button data-testid={`library-item-${item.name}`} class="group overflow-hidden rounded-md border border-[#c8c8c8] bg-white text-left shadow-sm transition hover:border-[#855cd6] hover:shadow-md" onclick={() => chooseItem(item)}>
              <div class="relative h-[8.5rem] overflow-hidden" style={`background:${'color' in item ? item.color : '#855cd6'}`}>
                <div class="absolute inset-0 opacity-25" style="background: radial-gradient(circle at 25% 20%, white 0 9%, transparent 10% 100%), radial-gradient(circle at 80% 25%, white 0 7%, transparent 8% 100%), linear-gradient(140deg, transparent 0 45%, rgba(255,255,255,.35) 46% 52%, transparent 53% 100%);"></div>
                {#if 'extensionId' in item}
                  <div class="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-white/95 text-5xl font-black text-[#4c97ff] shadow">
                    {item.icon}
                  </div>
                  <div class="absolute bottom-[-1rem] left-4 flex h-12 w-12 items-center justify-center rounded-md border-4 border-white bg-[#0fbd8c] text-2xl font-black text-white shadow">
                    {item.icon}
                  </div>
                {/if}
              </div>
              <div class="flex min-h-32 flex-col px-4 pb-4 pt-7 text-[#575e75]">
                <div class="text-base font-bold">{item.name}</div>
                <div class="mt-1.5 min-h-10 text-sm leading-snug">{extensionDescription(item)}</div>
                {#if 'extensionId' in item && ['text2speech', 'translate', 'microbit', 'ev3', 'gdxfor'].includes(item.extensionId)}
                  <div class="mt-auto grid grid-cols-2 gap-3 pt-4 text-[11px] font-bold text-[#777c90]">
                    <div>
                      <div class="mb-1">必要なもの</div>
                      <div class="text-base leading-none">⌁</div>
                    </div>
                    <div>
                      <div class="mb-1">協力</div>
                      <div>{item.extensionId === 'translate' ? 'Google' : item.extensionId === 'ev3' ? 'LEGO' : item.extensionId === 'gdxfor' ? 'Vernier' : item.extensionId === 'microbit' ? 'micro:bit' : 'Amazon Web Services'}</div>
                    </div>
                  </div>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {:else}
      <div class="flex items-center gap-3 border-b border-slate-200 p-3">
        <h2 class="text-base font-bold capitalize">{libraryPanel} Library</h2>
        <input class="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm" placeholder="Search names or tags" bind:value={librarySearch} aria-label="Search library" />
        <button class="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50" onclick={close}>Close</button>
      </div>
      <div class="grid flex-1 gap-3 overflow-auto p-3 sm:grid-cols-2 md:grid-cols-3">
        {#each visibleItems as item}
          <button data-testid={`library-item-${item.name}`} class="rounded-md border border-slate-200 bg-slate-50 p-3 text-left hover:border-blue-300 hover:bg-blue-50" onclick={() => chooseItem(item)}>
            <div class="mb-2 flex aspect-square items-center justify-center rounded bg-white">
              {#if 'extensionId' in item}
                <div class="flex h-20 w-20 items-center justify-center rounded-2xl text-4xl font-black text-white" style={`background:${item.color}`}>
                  {item.icon}
                </div>
              {:else if 'costumes' in item}
                <img class="max-h-full max-w-full object-contain" src={`/assets-scratch/images/${item.costumes[0]?.md5ext}`} alt="" />
              {:else if 'sampleCount' in item}
                <div class="flex h-16 w-24 items-center gap-1">
                  {#each [0.25, 0.65, 0.4, 0.9, 0.55, 0.75, 0.32, 0.6] as peak}
                    <span class="flex-1 rounded-sm bg-[#cf63cf]" style={`height:${Math.max(8, peak * 64)}px`}></span>
                  {/each}
                </div>
              {:else if 'md5ext' in item}
                <img class="max-h-full max-w-full object-contain" src={`/assets-scratch/images/${item.md5ext}`} alt="" />
              {:else if 'shape' in item}
                <img class="max-h-full max-w-full object-contain" src={`data:image/svg+xml;base64,${bytesToLocalBase64(new TextEncoder().encode(librarySvg(item.shape, item.color)))}`} alt="" />
              {/if}
            </div>
            <div class="font-semibold">{item.name}</div>
            {#if 'sampleCount' in item}
              <div class="mt-0.5 text-xs font-semibold text-slate-500">{((item.sampleCount ?? 0) / Math.max(1, item.rate ?? 44100)).toFixed(2)}s</div>
            {:else if 'costumes' in item}
              <div class="mt-0.5 text-xs font-semibold text-slate-500">{item.costumes.length} costume{item.costumes.length === 1 ? '' : 's'}</div>
            {/if}
            <div class="mt-1 flex flex-wrap gap-1">
              {#each item.tags as tag}
                <span class="rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">{tag}</span>
              {/each}
            </div>
          </button>
        {:else}
          <div class="col-span-full rounded-md border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">No library items match.</div>
        {/each}
        {#if visibleItems.length < items.length}
          <button class="col-span-full rounded-md border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-[#575e75] hover:border-blue-300 hover:bg-blue-50" type="button" onclick={() => (visibleAssetCount += assetPageSize)}>
            Show more ({visibleItems.length} / {items.length})
          </button>
        {/if}
      </div>
      {/if}
    </div>
  </div>
{/if}
