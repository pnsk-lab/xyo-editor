<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Editor from './Editor.svelte'
  import { createEditorContext, type EditorContext } from './lib/editor-context'
  import type { PluginHost } from './lib/plugins'
  import { DEFAULT_RUNTIME_BACKEND_ID, runtimeBackends } from './lib/runtime-backends'

  export let plugins: PluginHost | undefined = undefined

  let context: EditorContext | undefined
  let error = ''
  let selectedId = DEFAULT_RUNTIME_BACKEND_ID
  let activeId = DEFAULT_RUNTIME_BACKEND_ID
  let destroyed = false
  let availability: Record<string, boolean> = {}

  function labelOf(id: string): string {
    return runtimeBackends.list().find((entry) => entry.id === id)?.label ?? id
  }

  function unavailableMessage(id: string): string {
    const reason = runtimeBackends.unavailableReason(id)
    return `前回選択した実行環境「${labelOf(id)}」はこのビルドでは利用できないため、現行 VM を使用します。${reason ? `（${reason}）` : ''}`
  }

  async function handleInitializationError(cause: unknown) {
    // Only the initial canvas/audio setup can call this; never replace a live project.
    const failedId = activeId
    context = undefined
    if (failedId === DEFAULT_RUNTIME_BACKEND_ID) {
      error = `実行環境を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`
      return
    }
    error = `実行環境「${labelOf(failedId)}」を読み込めなかったため、現行 VM を使用します。`
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
      if (!destroyed) error = `実行環境を読み込めませんでした: ${fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause)}`
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
        error = unavailableMessage(selected)
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
          backend = await runtimeBackends.create(DEFAULT_RUNTIME_BACKEND_ID)
          error = `実行環境「${labelOf(selected)}」を読み込めなかったため、現行 VM を使用します。`
          runtimeBackends.setSelectedId(DEFAULT_RUNTIME_BACKEND_ID)
          selectedId = DEFAULT_RUNTIME_BACKEND_ID
        }
        if (destroyed) {
          backend.renderer.dispose()
          await backend.dispose?.()
          return
        }
        activeId = selectedId
        context = createEditorContext({ backend, plugins })
      } catch (cause) {
        if (!destroyed) error = `実行環境を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
    void initialize()
    return () => {
      destroyed = true
      unsubscribePlugins?.()
    }
  })
</script>

{#if error}
  <p role="alert">{error}</p>
{/if}
{#if context}
  <Editor {context} {runtimeOptions} selectedRuntime={selectedId} onRuntimeChange={saveBackendPreference} onInitializationError={handleInitializationError} />
{:else if !error}
  <p role="status">実行環境を読み込んでいます…</p>
{/if}
