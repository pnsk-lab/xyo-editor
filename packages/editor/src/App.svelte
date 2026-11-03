<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Editor from './Editor.svelte'
  import { createEditorContext, type EditorContext } from './lib/editor-context'
  import type { PluginHost } from './lib/plugins'
  import { DEFAULT_RUNTIME_BACKEND_ID, runtimeBackends } from './lib/runtime-backends'

  export let plugins: PluginHost | undefined = undefined

  let context: EditorContext | undefined
  let message = ''
  let messageDismissible = false
  let messageTimer: ReturnType<typeof setTimeout> | undefined
  let selectedId = DEFAULT_RUNTIME_BACKEND_ID
  let activeId = DEFAULT_RUNTIME_BACKEND_ID
  let destroyed = false
  let availability: Record<string, boolean> = {}

  /** Fatal problems stay on screen; fallback notices can be dismissed or time out. */
  function setMessage(text: string, options: { dismissible?: boolean; timeoutMs?: number } = {}): void {
    message = text
    messageDismissible = options.dismissible ?? false
    if (messageTimer) {
      clearTimeout(messageTimer)
      messageTimer = undefined
    }
    if (messageDismissible) messageTimer = setTimeout(dismissMessage, options.timeoutMs ?? 12000)
  }

  function dismissMessage(): void {
    if (messageTimer) {
      clearTimeout(messageTimer)
      messageTimer = undefined
    }
    message = ''
  }

  function labelOf(id: string): string {
    return runtimeBackends.list().find((entry) => entry.id === id)?.label ?? id
  }

  function unavailableMessage(id: string): string {
    const reason = runtimeBackends.unavailableReason(id)
    return `「${labelOf(id)}」はこのビルドでは利用できないため、現行 VM で起動しました。${reason ? `（${reason}）` : ''}`
  }

  async function handleInitializationError(cause: unknown) {
    // Only the initial canvas/audio setup can call this; never replace a live project.
    const failedId = activeId
    context = undefined
    if (failedId === DEFAULT_RUNTIME_BACKEND_ID) {
      setMessage(`実行環境を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    setMessage(`「${labelOf(failedId)}」を読み込めなかったため、現行 VM を使用します。`, { dismissible: true })
    try {
      // Allow the failed editor to unmount and dispose its resources first.
      await tick()
      if (destroyed) return
      const backend = await runtimeBackends.create(DEFAULT_RUNTIME_BACKEND_ID)
      if (destroyed) {
        backend.renderer.dispose()
        await backend.dispose?.()
        return
      }
      activeId = DEFAULT_RUNTIME_BACKEND_ID
      context = createEditorContext({ backend, plugins })
    } catch (fallbackCause) {
      if (!destroyed) setMessage(`実行環境を読み込めませんでした: ${fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause)}`)
    }
  }
  // Registrations are supplied by the host before this component mounts, but
  // plugins may add or remove runtimes while the editor is open.
  let runtimeOptions: { value: string; label: string; disabled?: boolean }[] = []

  function refreshRuntimeOptions() {
    const available = runtimeBackends.list()
    runtimeOptions = available.length > 1
      ? available.map(({ id, label }) => availability[id] === false
        ? { value: id, label: `${label}（このビルドでは利用不可）`, disabled: true }
        : { value: id, label: `${label}（次回起動時）` })
      : []
  }

  async function probeRuntimeOptions(): Promise<void> {
    const entries = runtimeBackends.list()
    const results = await Promise.all(entries.map(async ({ id }) => [id, await runtimeBackends.probe(id)] as const))
    for (const [id, ok] of results) availability[id] = ok
    refreshRuntimeOptions()
  }

  async function saveBackendPreference(id: string) {
    if (availability[id] === false) {
      window.alert(`${labelOf(id)} はこのビルドでは利用できません。`)
      // Force the controlled select back to the previously saved value.
      const previous = selectedId
      selectedId = ''
      await tick()
      selectedId = previous
      return
    }
    if (runtimeBackends.setSelectedId(id)) {
      selectedId = id
      window.alert('次回起動時に適用します。再読み込みする前にプロジェクトを保存してください。')
    } else {
      // Force the controlled select back to the previously saved value.
      const previous = selectedId
      selectedId = ''
      await tick()
      selectedId = previous
      window.alert('設定を保存できませんでした。')
    }
  }

  onMount(() => {
    refreshRuntimeOptions()
    const unsubscribePlugins = plugins?.subscribe(() => refreshRuntimeOptions())
    const initialize = async () => {
      // URL plugins may provide the runtime saved from the previous session, so
      // let them register before resolving the selection.
      await plugins?.restoreExternalPlugins()
      await probeRuntimeOptions()
      let selected = runtimeBackends.getSelectedId()
      if (selected !== DEFAULT_RUNTIME_BACKEND_ID && availability[selected] === false) {
        // Deterministic: this build will never serve the backend, so forget the
        // choice instead of asking again on the next visit.
        setMessage(unavailableMessage(selected), { dismissible: true })
        runtimeBackends.setSelectedId(DEFAULT_RUNTIME_BACKEND_ID)
        selected = DEFAULT_RUNTIME_BACKEND_ID
      }
      selectedId = selected
      try {
        let backend
        try {
          backend = await runtimeBackends.create(selected)
        } catch (cause) {
          if (selected === DEFAULT_RUNTIME_BACKEND_ID) throw cause
          // Transient (network, CDN, blocked module): keep the choice for next time.
          backend = await runtimeBackends.create(DEFAULT_RUNTIME_BACKEND_ID)
          setMessage(`「${labelOf(selected)}」を読み込めなかったため、現行 VM を使用します。`, { dismissible: true })
        }
        if (destroyed) {
          backend.renderer.dispose()
          await backend.dispose?.()
          return
        }
        activeId = selected
        context = createEditorContext({ backend, plugins })
      } catch (cause) {
        if (!destroyed) setMessage(`実行環境を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    void initialize()
    return () => {
      destroyed = true
      unsubscribePlugins?.()
      if (messageTimer) clearTimeout(messageTimer)
    }
  })
</script>

{#if message}
  <div class="runtime-notice" role="alert">
    <span>{message}</span>
    {#if messageDismissible}
      <button type="button" aria-label="通知を閉じる" onclick={dismissMessage}>×</button>
    {/if}
  </div>
{/if}
{#if context}
  <Editor {context} {runtimeOptions} selectedRuntime={selectedId} onRuntimeChange={saveBackendPreference} onInitializationError={handleInitializationError} />
{:else if !message}
  <p role="status">実行環境を読み込んでいます…</p>
{/if}

<style>
  .runtime-notice {
    align-items: center;
    background: var(--app-surface-raised, #ffffff);
    border: 1px solid var(--app-border, #cbd5e1);
    border-radius: 999px;
    box-shadow: 0 8px 24px rgb(15 23 42 / 0.18);
    color: var(--app-text, #334155);
    display: flex;
    font-size: 13px;
    gap: 10px;
    left: 50%;
    max-width: min(40rem, calc(100vw - 2rem));
    padding: 8px 10px 8px 16px;
    position: fixed;
    top: 60px;
    transform: translateX(-50%);
    z-index: 120;
  }

  .runtime-notice button {
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    height: 22px;
    line-height: 1;
    opacity: 0.65;
    padding: 0;
    width: 22px;
  }

  .runtime-notice button:hover {
    opacity: 1;
  }
</style>
