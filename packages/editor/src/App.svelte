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

  async function handleInitializationError(cause: unknown) {
    // Only the initial canvas/audio setup can call this; never replace a live project.
    const failedId = activeId
    context = undefined
    if (failedId === DEFAULT_RUNTIME_BACKEND_ID) {
      error = `実行環境を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`
      return
    }
    error = `保存された実行環境を読み込めなかったため、現行 VM を使用します。理由: ${cause instanceof Error ? cause.message : String(cause)}`
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
  let runtimeOptions: { value: string; label: string }[] = []

  function refreshRuntimeOptions() {
    const available = runtimeBackends.list()
    runtimeOptions = available.length > 1
      ? available.map(({ id, label }) => ({ value: id, label: `${label}（次回起動時）` }))
      : []
  }

  async function saveBackendPreference(id: string) {
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
      const selected = runtimeBackends.getSelectedId()
      selectedId = selected
      try {
        let backend
        try {
          backend = await runtimeBackends.create(selected)
        } catch (cause) {
          if (selected === DEFAULT_RUNTIME_BACKEND_ID) throw cause
          backend = await runtimeBackends.create(DEFAULT_RUNTIME_BACKEND_ID)
          error = `保存された実行環境を読み込めなかったため、現行 VM を使用します。理由: ${cause instanceof Error ? cause.message : String(cause)}`
        }
        if (destroyed) {
          backend.renderer.dispose()
          await backend.dispose?.()
          return
        }
        activeId = error ? DEFAULT_RUNTIME_BACKEND_ID : selected
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
