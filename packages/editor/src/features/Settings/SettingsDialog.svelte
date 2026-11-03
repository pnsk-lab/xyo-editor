<script lang="ts">
  import { onMount } from 'svelte'
  import { X, Zap } from 'lucide-svelte'
  import type { PluginHost, PluginRecordInfo, PluginStatus } from '../../lib/plugins'

  let { turboMode, toggleTurboMode, close, runtimeOptions = [], selectedRuntime = '', onRuntimeChange, plugins } = $props<{
    runtimeOptions?: { value: string; label: string; disabled?: boolean }[]
    selectedRuntime?: string
    onRuntimeChange?: (value: string) => void
    turboMode: boolean
    toggleTurboMode: () => void
    close: () => void
    plugins?: PluginHost
  }>()

  let dialog: HTMLDialogElement
  let closing = $state(false)
  let backdropPressed = false
  let section = $state<'runtime' | 'plugins'>('runtime')
  let pluginRecords = $state<PluginRecordInfo[]>([])
  let pluginUrl = $state('')
  let pluginBusy = $state(false)
  let pluginError = $state('')

  onMount(() => dialog.showModal())

  $effect(() => {
    if (!plugins) return
    return plugins.subscribe((records: PluginRecordInfo[]) => {
      pluginRecords = records
    })
  })

  function statusLabel(status: PluginStatus): string {
    switch (status) {
      case 'active':
        return '有効'
      case 'activating':
        return '読み込み中'
      case 'error':
        return 'エラー'
      default:
        return '無効'
    }
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function togglePlugin(record: PluginRecordInfo) {
    if (!plugins) return
    pluginError = ''
    try {
      await plugins.setEnabled(record.manifest.id, !record.enabled)
    } catch (error) {
      pluginError = messageOf(error)
    }
  }

  async function removePlugin(id: string) {
    if (!plugins) return
    pluginError = ''
    try {
      await plugins.uninstall(id)
    } catch (error) {
      pluginError = messageOf(error)
    }
  }

  async function addPlugin(event: SubmitEvent) {
    event.preventDefault()
    if (!plugins || pluginBusy) return
    const url = pluginUrl.trim()
    if (!url) return
    pluginBusy = true
    pluginError = ''
    try {
      await plugins.installFromUrl(url)
      pluginUrl = ''
    } catch (error) {
      pluginError = messageOf(error)
    } finally {
      pluginBusy = false
    }
  }

  function requestClose() {
    if (closing) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) dialog.close()
    else closing = true
  }

  function isOutside(event: MouseEvent | PointerEvent) {
    const rect = dialog.getBoundingClientRect()
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
  }
</script>

<dialog bind:this={dialog} onclose={close} oncancel={(event) => { event.preventDefault(); requestClose() }} onpointerdown={(event) => { backdropPressed = isOutside(event) }} onclick={(event) => { if (backdropPressed && isOutside(event)) requestClose(); backdropPressed = false }} onanimationend={(event) => { if (event.target === dialog && closing) dialog.close() }} aria-labelledby="settings-title" class="settings-dialog" class:closing>
  <div class="settings-heading">
    <h2 id="settings-title">設定</h2>
    <button type="button" class="close-button" aria-label="設定を閉じる" onclick={requestClose}><X size={20} /></button>
  </div>
  <div class="settings-body">
    <nav class="settings-sections" aria-label="設定セクション">
      <button type="button" aria-current={section === 'runtime' ? 'page' : undefined} onclick={() => (section = 'runtime')}>ランタイム</button>
      {#if plugins}
        <button type="button" aria-current={section === 'plugins' ? 'page' : undefined} onclick={() => (section = 'plugins')}>プラグイン</button>
      {/if}
    </nav>

    {#if section === 'runtime'}
      <section class="settings-content" aria-labelledby="runtime-title">
        <h3 id="runtime-title">ランタイム</h3>
        {#if runtimeOptions.length > 0}
        <div class="setting-row">
          <label for="runtime-select" class="setting-label">ランタイムの選択</label>
          <select id="runtime-select" value={selectedRuntime} disabled={runtimeOptions.length === 0 || !onRuntimeChange} onchange={(event) => onRuntimeChange?.(event.currentTarget.value)}>
            {#if !runtimeOptions.some((option: { value: string; label: string }) => option.value === selectedRuntime)}
              <option value="" disabled>選択してください</option>
            {/if}
            {#each runtimeOptions as option (option.value)}
              <option value={option.value} disabled={option.disabled}>{option.label}</option>
            {/each}
          </select>
        </div>
        <p>変更は次回起動時に適用されます。現在の作業は続けられます。適用するにはプロジェクトを保存してから再読み込みしてください。</p>
        {#if selectedRuntime === 'turbowarp'}
          <p>TurboWarp は外部から読み込まれます。実行中に編集するとスクリプトが停止し、クローンやペンの描画などの実行状態は消去されます。</p>
        {/if}
        {/if}
        <div class="setting-row">
          <div>
            <div class="setting-label"><Zap size={18} /> ターボモード</div>
            <p>プロジェクトを高速で実行します。</p>
          </div>
          <button type="button" role="switch" aria-label="ターボモード" aria-checked={turboMode} class:enabled={turboMode} class="switch" onclick={toggleTurboMode}>
            <span></span>
          </button>
        </div>
      </section>
    {:else if plugins}
      <section class="settings-content" aria-labelledby="plugins-title">
        <h3 id="plugins-title">プラグイン</h3>
        <p class="plugin-note">
          プラグインはこのエディタと同じ権限で JavaScript を実行します。信頼できる提供元のものだけを追加してください。
        </p>

        {#if pluginRecords.length === 0}
          <p class="plugin-empty">プラグインはまだありません。</p>
        {:else}
          <ul class="plugin-list">
            {#each pluginRecords as record (record.manifest.id)}
              <li class="plugin-item" data-testid={`plugin-${record.manifest.id}`}>
                <div class="plugin-head">
                  <div class="plugin-copy">
                    <div class="plugin-name">
                      {record.manifest.name}
                      {#if record.manifest.version}<span class="plugin-version">v{record.manifest.version}</span>{/if}
                    </div>
                    <div class="plugin-meta">
                      <span class="plugin-source">{record.source === 'builtin' ? '内蔵' : '外部'}</span>
                      <span aria-hidden="true">・</span>
                      <span class:plugin-status-error={record.status === 'error'}>{statusLabel(record.status)}</span>
                      {#if record.url}
                        <span class="plugin-url" title={record.url}>{record.url}</span>
                      {/if}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label={`${record.manifest.name}を${record.enabled ? '無効' : '有効'}にする`}
                    aria-checked={record.enabled}
                    class:enabled={record.enabled}
                    class="switch"
                    disabled={record.status === 'activating'}
                    onclick={() => togglePlugin(record)}
                  >
                    <span></span>
                  </button>
                </div>
                {#if record.manifest.description}
                  <p class="plugin-description">{record.manifest.description}</p>
                {/if}
                {#if record.error}
                  <p class="plugin-error">{record.error}</p>
                {/if}
                {#if record.source === 'external'}
                  <button type="button" class="plugin-remove" onclick={() => removePlugin(record.manifest.id)}>削除</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <form class="plugin-install" onsubmit={addPlugin}>
          <label for="plugin-url">URL からプラグインを追加</label>
          <div class="plugin-install-row">
            <input id="plugin-url" bind:value={pluginUrl} placeholder="https://example.com/plugin.js" autocomplete="off" spellcheck="false" />
            <button type="submit" disabled={pluginBusy || !pluginUrl.trim()}>{pluginBusy ? '読み込み中…' : '追加'}</button>
          </div>
        </form>
        {#if pluginError}
          <p class="plugin-error" role="alert">{pluginError}</p>
        {/if}
      </section>
    {/if}
  </div>
</dialog>

<style>
  .settings-dialog { margin: auto; width: min(42rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); padding: 0; border: 1px solid #d9dfea; border-radius: 10px; color: #172b4d; background: white; box-shadow: 0 20px 60px rgb(15 23 42 / .3); }
  .settings-dialog[open] { animation: settings-enter 100ms ease-out both; }
  .settings-dialog[open].closing { animation: settings-exit 80ms ease-in both; }
  .settings-dialog::backdrop { background: rgb(15 23 42 / .5); animation: backdrop-enter 100ms ease-out both; }
  .settings-dialog.closing::backdrop { animation: backdrop-exit 80ms ease-in both; }
  @keyframes settings-enter { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes settings-exit { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(6px) scale(.98); } }
  @keyframes backdrop-enter { from { opacity: 0; } to { opacity: 1; } }
  @keyframes backdrop-exit { from { opacity: 1; } to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .settings-dialog[open], .settings-dialog::backdrop { animation: none; } }
  .settings-heading { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; font-size: 18px; font-weight: 700; }
  .close-button { padding: 6px; border-radius: 5px; }
  .close-button:hover { background: #f1f5f9; }
  .settings-body { display: grid; grid-template-columns: 10rem 1fr; min-height: 18rem; }
  .settings-sections { padding: 16px 10px; border-right: 1px solid #e2e8f0; background: #f8fafc; }
  .settings-sections button { width: 100%; padding: 10px 12px; text-align: left; border-radius: 6px; color: #6741b2; font-weight: 700; }
  .settings-sections button[aria-current='page'] { background: #eee8fc; }
  .settings-sections button:not([aria-current='page']):hover { background: #eef2f7; }
  .settings-content { padding: 22px; overflow-y: auto; max-height: calc(100vh - 10rem); }
  .settings-content h3 { font-size: 17px; font-weight: 700; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 22px; }
  .setting-label { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  select { max-width: 60%; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 5px; color: inherit; background: transparent; }
  select:disabled { opacity: .6; }
  :global(:root[data-theme='dark']) select option { color: #e2e8f0; background: #1e293b; }
  .setting-row p { margin-top: 5px; color: #64748b; font-size: 13px; }
  .switch { flex: none; width: 44px; height: 24px; padding: 3px; border-radius: 999px; background: #94a3b8; }
  .switch.enabled { background: #855cd6; }
  .switch span { display: block; width: 18px; height: 18px; border-radius: 50%; background: white; transition: transform 120ms ease; }
  .switch.enabled span { transform: translateX(20px); }
  .switch:disabled { opacity: .5; }
  .plugin-note { margin-top: 8px; color: #64748b; font-size: 13px; line-height: 1.5; }
  .plugin-empty { margin-top: 18px; color: #64748b; font-size: 13px; }
  .plugin-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; padding: 0; list-style: none; }
  .plugin-item { padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
  .plugin-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .plugin-copy { min-width: 0; }
  .plugin-name { display: flex; align-items: baseline; gap: 6px; font-weight: 700; }
  .plugin-version { color: #64748b; font-size: 12px; font-weight: 600; }
  .plugin-meta { display: flex; align-items: center; gap: 4px; margin-top: 3px; color: #64748b; font-size: 12px; }
  .plugin-source { padding: 1px 6px; border-radius: 999px; background: #e2e8f0; color: #475569; font-weight: 700; }
  .plugin-url { margin-left: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 18rem; }
  .plugin-status-error { color: #b91c1c; font-weight: 700; }
  .plugin-description { margin-top: 8px; color: #475569; font-size: 13px; line-height: 1.5; }
  .plugin-error { margin-top: 8px; color: #b91c1c; font-size: 12px; line-height: 1.5; word-break: break-word; }
  .plugin-remove { margin-top: 8px; padding: 4px 10px; border: 1px solid #fecaca; border-radius: 5px; color: #b91c1c; font-size: 12px; font-weight: 700; }
  .plugin-remove:hover { background: #fef2f2; }
  .plugin-install { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .plugin-install label { font-size: 13px; font-weight: 700; }
  .plugin-install-row { display: flex; gap: 8px; margin-top: 8px; }
  .plugin-install input { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 5px; color: inherit; background: transparent; font-size: 13px; }
  .plugin-install button { flex: none; padding: 7px 14px; border-radius: 5px; background: #855cd6; color: white; font-size: 13px; font-weight: 700; }
  .plugin-install button:disabled { opacity: .5; }
  :global(:root[data-theme='dark']) .settings-dialog { color: #e2e8f0; background: #1e293b; border-color: #475569; }
  :global(:root[data-theme='dark']) .settings-heading, :global(:root[data-theme='dark']) .settings-sections { border-color: #475569; }
  :global(:root[data-theme='dark']) .settings-sections { background: #182334; }
  :global(:root[data-theme='dark']) .settings-sections button { color: #d7c4ff; }
  :global(:root[data-theme='dark']) .settings-sections button[aria-current='page'] { background: #493772; color: #f1eaff; }
  :global(:root[data-theme='dark']) .settings-sections button:not([aria-current='page']):hover { background: #223049; }
  :global(:root[data-theme='dark']) .setting-row p, :global(:root[data-theme='dark']) .plugin-note, :global(:root[data-theme='dark']) .plugin-empty, :global(:root[data-theme='dark']) .plugin-meta, :global(:root[data-theme='dark']) .plugin-version { color: #cbd5e1; }
  :global(:root[data-theme='dark']) .plugin-item { background: #182334; border-color: #334155; }
  :global(:root[data-theme='dark']) .plugin-description { color: #cbd5e1; }
  :global(:root[data-theme='dark']) .plugin-source { background: #334155; color: #e2e8f0; }
  :global(:root[data-theme='dark']) .plugin-remove { border-color: #7f1d1d; color: #fca5a5; }
  :global(:root[data-theme='dark']) .plugin-remove:hover { background: #3f1d1d; }
  :global(:root[data-theme='dark']) .plugin-install { border-color: #334155; }
  :global(:root[data-theme='dark']) .plugin-install input { border-color: #475569; }
  :global(:root[data-theme='dark']) .close-button:hover { background: #334155; }
  @media (max-width: 480px) { .settings-body { grid-template-columns: 7rem 1fr; } .settings-content { padding: 16px; } }
</style>
