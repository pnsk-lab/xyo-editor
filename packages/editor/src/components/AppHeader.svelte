<script lang="ts">
  import { Blocks, Bug, ChevronDown, Download, FileText, Flag, FolderOpen, Lightbulb, Moon, Pencil, Plus, Settings, Square, StepForward, Sun, Zap } from 'lucide-svelte'
  import type { RuntimeSnapshot } from '@hikkaku/vm'

  let {
    projectTitle = $bindable(''),
    status,
    snapshot,
    openProject,
    newProject,
    exportProject,
    exportSb3,
    toggleTurboMode,
    greenFlag,
    stopAll,
    stepRuntime,
    colorScheme,
    toggleColorScheme,
  } = $props<{
    projectTitle: string
    status: string
    snapshot: RuntimeSnapshot
    openProject: () => void
    newProject: () => void
    exportProject: () => void
    exportSb3: () => void
    toggleTurboMode: () => void
    greenFlag: () => void
    stopAll: () => void
    stepRuntime: () => void
    colorScheme: 'light' | 'dark'
    toggleColorScheme: () => void
  }>()

  const closeOpenMenu = (event: MouseEvent) => {
    const details = (event.currentTarget as HTMLElement).closest('details')
    details?.removeAttribute('open')
  }
</script>

<header class="relative z-40 flex h-[52px] shrink-0 items-center border-b border-[#774dc5] bg-[#855cd6] text-white shadow-sm">
  <div class="flex h-full min-w-max flex-1 items-center">
    <div class="flex h-full w-[108px] items-center justify-center border-r border-white/10">
      <div class="scratch-wordmark" title={projectTitle || 'Scratch'}>
        <Blocks size={16} aria-hidden="true" />
        <span>SCRATCH</span>
      </div>
    </div>

    <nav class="flex h-full items-center text-[13px] font-bold">
      <details class="menu">
        <summary class="menu-trigger">
          <Settings size={20} strokeWidth={3} />
          <span>設定</span>
          <ChevronDown size={14} strokeWidth={3} />
        </summary>
        <div class="menu-panel w-52">
          <button class="menu-item" onclick={toggleColorScheme}>
            {#if colorScheme === 'dark'}
              <Sun size={17} />
              <span>ライトモード</span>
            {:else}
              <Moon size={17} />
              <span>ダークモード</span>
            {/if}
          </button>
          <button class="menu-item" onclick={toggleTurboMode}>
            <Zap size={17} class={snapshot.turboMode ? 'text-[#ffab19]' : ''} />
            <span>{snapshot.turboMode ? 'Turbo をオフ' : 'Turbo をオン'}</span>
          </button>
        </div>
      </details>

      <details class="menu">
        <summary class="menu-trigger">
          <FileText size={20} strokeWidth={3} />
          <span>ファイル</span>
          <ChevronDown size={14} strokeWidth={3} />
        </summary>
        <div class="menu-panel w-64">
          <label class="mb-2 block px-3 pt-2 text-[11px] font-bold text-slate-500">
            プロジェクト名
            <input
              class="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm font-semibold text-slate-800 outline-none focus:border-[#855cd6]"
              bind:value={projectTitle}
              aria-label="Project title"
            />
          </label>
          <button class="menu-item" onclick={(event) => { newProject(); closeOpenMenu(event) }}>
            <Plus size={17} />
            <span>新規</span>
          </button>
          <button class="menu-item" aria-label="Open project" onclick={(event) => { openProject(); closeOpenMenu(event) }}>
            <FolderOpen size={17} />
            <span>読み込む</span>
          </button>
          <button class="menu-item" aria-label="Export project" onclick={(event) => { exportProject(); closeOpenMenu(event) }}>
            <Download size={17} />
            <span>JSON で保存</span>
          </button>
          <button class="menu-item" onclick={(event) => { exportSb3(); closeOpenMenu(event) }}>
            <Download size={17} />
            <span>SB3 で保存</span>
          </button>
        </div>
      </details>

      <details class="menu">
        <summary class="menu-trigger">
          <Pencil size={19} strokeWidth={3} />
          <span>編集</span>
          <ChevronDown size={14} strokeWidth={3} />
        </summary>
        <div class="menu-panel w-48">
          <button class="menu-item" onclick={(event) => { greenFlag(); closeOpenMenu(event) }}>
            <Flag size={17} class={snapshot.running ? 'text-[#40bf4a]' : ''} />
            <span>実行</span>
          </button>
          <button class="menu-item" onclick={(event) => { stopAll(); closeOpenMenu(event) }}>
            <Square size={17} />
            <span>停止</span>
          </button>
          <button class="menu-item" onclick={(event) => { stepRuntime(); closeOpenMenu(event) }}>
            <StepForward size={17} />
            <span>1 ステップ進める</span>
          </button>
        </div>
      </details>

      <div class="mx-3 h-full w-px bg-white/10"></div>

      <button class="menu-trigger" type="button">
        <Lightbulb size={22} strokeWidth={3} />
        <span>チュートリアル</span>
      </button>

      <button class="menu-trigger" type="button" onclick={stepRuntime}>
        <Bug size={22} strokeWidth={3} />
        <span>デバッグ</span>
      </button>
    </nav>
  </div>

  <div class="flex h-full min-w-max items-center gap-7 px-5 text-[13px] font-bold">
    <button class="header-link" type="button">Scratchに参加しよう</button>
    <button class="header-link" type="button">サインイン</button>
  </div>

  <span class="sr-only" aria-live="polite">{status}</span>
</header>

<style>
  .scratch-wordmark {
    align-items: center;
    background: #ffffff;
    border: 2px solid #ffab19;
    border-radius: 8px;
    box-shadow: 0 1px 0 rgb(0 0 0 / 0.12);
    color: #ffab19;
    display: inline-flex;
    font-size: 14px;
    font-weight: 900;
    gap: 1px;
    letter-spacing: 0;
    line-height: 1;
    padding: 4px 6px 3px;
    text-shadow:
      -1px -1px 0 #ffffff,
      1px -1px 0 #ffffff,
      -1px 1px 0 #ffffff,
      1px 1px 0 #ffffff;
  }

  .scratch-wordmark :global(svg) {
    color: #ffab19;
    flex: 0 0 auto;
  }

  .menu {
    height: 100%;
    position: relative;
  }

  .menu > summary {
    list-style: none;
  }

  .menu > summary::-webkit-details-marker {
    display: none;
  }

  .menu-trigger {
    align-items: center;
    color: #ffffff;
    display: flex;
    gap: 7px;
    height: 100%;
    padding: 0 18px;
    transition: background-color 120ms ease;
    white-space: nowrap;
  }

  .menu-trigger:hover,
  .menu[open] > .menu-trigger {
    background: rgb(255 255 255 / 0.14);
  }

  .menu-panel {
    background: #ffffff;
    border: 1px solid rgb(0 0 0 / 0.16);
    border-radius: 0 0 6px 6px;
    box-shadow: 0 10px 24px rgb(15 23 42 / 0.18);
    color: #172b4d;
    left: 0;
    padding: 6px 0;
    position: absolute;
    top: 100%;
    z-index: 60;
  }

  .menu-item {
    align-items: center;
    display: flex;
    gap: 10px;
    min-height: 36px;
    padding: 8px 12px;
    text-align: left;
    width: 100%;
  }

  .menu-item:hover {
    background: #eef2ff;
  }

  .header-link {
    color: #ffffff;
    white-space: nowrap;
  }

  .header-link:hover {
    text-decoration: underline;
  }
</style>
