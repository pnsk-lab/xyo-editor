<!-- Compact paint swatch popover (Scratch Paint parity, layout only).
  A small labeled swatch button opens an anchored dialog holding the full
  paint controls (slotted). Closed state is one row tall so the toolbar stays
  under 110px; open state floats absolutely and never shifts canvas geometry.
  - Accessible: trigger has aria-haspopup/expanded, dialog has role + label,
    Escape and outside pointer close, focus moves into the dialog on open and
    returns to the trigger on close.
  - Dark theme: slate-900 dialog with light text; slotted controls keep their
    own inputs (native ranges keep keyboard/touch/screen-reader behavior).
  - Responsive: dialog caps at min(20rem, 100vw-2rem) with internal scroll so
    narrow widths never overflow horizontally.
  - No behavior change: open/close never writes paint, history, or artwork;
    the parent owns disabled gating and live/undo callbacks. -->
<script lang="ts">
  import { editorRootFor, isPopoverEscapeInTextDraft, isPlainEscapeKey, shouldDeferPopoverEscapeToIme } from '../costumes/paint-popover-escape'

  let {
    open = false,
    disabled = false,
    triggerLabel,
    triggerText,
    dialogLabel,
    swatchBackground = '#ffffff',
    swatchTransparent = false,
    mixed = false,
    testId = 'paint-swatch',
    align = 'left',
    onToggle,
    onClose,
    children,
  } = $props<{
    open?: boolean
    disabled?: boolean
    triggerLabel: string
    /** Short visible caption (keeps the closed bar narrow); aria uses triggerLabel. */
    triggerText: string
    dialogLabel: string
    swatchBackground?: string
    swatchTransparent?: boolean
    mixed?: boolean
    testId?: string
    align?: 'left' | 'right'
    onToggle: () => void
    onClose: () => void
    children?: import('svelte').Snippet
  }>()

  let wrapperNode: HTMLDivElement | undefined = $state(undefined)
  let triggerNode: HTMLButtonElement | undefined = $state(undefined)
  let dialogNode: HTMLDivElement | undefined = $state(undefined)

  $effect(() => {
    if (open) {
      // Move focus into the dialog so keyboard users land on the controls;
      // the first range/input wins, otherwise the dialog itself.
      queueMicrotask(() => {
        if (!dialogNode) return
        const first = dialogNode.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]',
        )
        ;(first ?? dialogNode).focus()
      })
    } else if (triggerNode && document.activeElement instanceof HTMLElement && dialogNode?.contains(document.activeElement)) {
      triggerNode.focus()
    }
  })

  function handleWindowPointerDown(event: PointerEvent) {
    if (!open) return
    const target = event.target as Node | null
    if (wrapperNode && target && !wrapperNode.contains(target)) onClose()
  }

  function handleWindowKeyDown(event: KeyboardEvent) {
    if (!open) return
    // Bubble fallback for typing-focus Escape (the Editor capture guard
    // returns early for inputs, so the dialog must close itself here). The
    // Editor capture path already closed button/canvas-focus popovers and
    // stopped the key, so this is a no-op for them. IME composition and an
    // open text draft own the key and must not close; cross-editor keys
    // (target outside our own editor root) never close here.
    if (!isPlainEscapeKey(event)) return
    if (shouldDeferPopoverEscapeToIme(event, false)) return
    if (isPopoverEscapeInTextDraft(event.target)) return
    const ownRoot = editorRootFor(wrapperNode)
    const targetRoot = editorRootFor(event.target)
    if (ownRoot && targetRoot && ownRoot !== targetRoot) return
    if (ownRoot && event.target instanceof Node && !ownRoot.contains(event.target)) return
    event.stopPropagation()
    onClose()
    triggerNode?.focus()
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeyDown} />

<div bind:this={wrapperNode} class="relative inline-flex shrink-0" data-paint-popover-root={testId} data-paint-popover-open={open ? 'true' : 'false'}>
  <button
    bind:this={triggerNode}
    type="button"
    class="flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-2 text-xs font-bold text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-300 disabled:opacity-40"
    aria-label={triggerLabel}
    aria-haspopup="dialog"
    aria-expanded={open}
    title={triggerLabel}
    data-testid={testId}
    {disabled}
    onclick={onToggle}
  >
    <span
      class="inline-block h-5 w-7 shrink-0 rounded border border-slate-500"
      style={swatchTransparent
        ? 'background:conic-gradient(#475569 25%, #0f172a 0 50%, #475569 0 75%, #0f172a 0);background-size:8px 8px;'
        : `background:${swatchBackground};`}
      aria-hidden="true"
    ></span>
    <span class="whitespace-nowrap">{triggerText}</span>
    {#if mixed}<span class="rounded bg-slate-600 px-1 text-[10px] font-bold text-slate-100" title="Mixed colors in the selection">MIXED</span>{/if}
    <span class="text-[10px] text-slate-400" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div
      bind:this={dialogNode}
      role="dialog"
      aria-label={dialogLabel}
      data-testid={`${testId}-dialog`}
      tabindex="-1"
      class={`absolute top-full z-50 mt-2 flex max-h-[min(24rem,calc(100vh-12rem))] w-72 max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-3 overflow-auto rounded-lg border border-slate-600 bg-slate-900 p-3 text-slate-100 shadow-xl focus:outline-none ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      {@render children?.()}
    </div>
  {/if}
</div>
