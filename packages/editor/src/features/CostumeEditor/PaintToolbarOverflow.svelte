<!-- Responsive paint-toolbar overflow (Scratch-like cleaner UI).
  Holds the lower-priority action buttons inline while they fit and moves the
  rest into an explicit More (⋯) menu. No duplication: each action renders
  either inline or in the menu, never both.
  - Measured, not breakpoint-guessed: a ResizeObserver on the flex container
    shrinks/grows `visibleCount` until the inline list fits without scrolling.
  - The outer container reserves `min-w-[2.75rem]` (the 36px More trigger, no
    list gap when the list is empty) so the trigger itself can never be
    squeezed to 0 and pushed past a narrow panel edge; the flex-1 inline
    list absorbs the deficit instead.
  - Accessible menu: trigger has aria-haspopup/expanded, menu has role + label,
    items keep their original testIds/aria-labels/titles/disabled/handlers,
    ArrowUp/Down/Home/End move, Escape closes with focus return, Tab moves
    naturally (focusout closes), outside pointer closes.
  - Theme: dark slate-900 menu matching the toolbar (visible over the light
    canvas too). Absolute positioning so opening never shifts canvas geometry.
  - No behavior change: open/close never writes paint/history/artwork. -->
<script lang="ts">
  import { Ellipsis } from 'lucide-svelte'
  import { tick } from 'svelte'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PaintToolbarOverflowAction = {
    id: string
    label: string
    title: string
    testId?: string
    disabled: boolean
    ariaDisabled?: string | undefined
    icon: any
    iconSize?: number
    onClick: () => void
  }

  let {
    actions = [],
    moreTestId = 'paint-toolbar-more',
    moreLabel = 'More toolbar actions',
  } = $props<{
    actions: PaintToolbarOverflowAction[]
    moreTestId?: string
    moreLabel?: string
  }>()

  let containerNode: HTMLDivElement | undefined = $state(undefined)
  let listNode: HTMLDivElement | undefined = $state(undefined)
  let moreButtonNode: HTMLButtonElement | undefined = $state(undefined)
  let menuNode: HTMLDivElement | undefined = $state(undefined)
  // Start with everything inline so SSR/jsdom/unit tests see the full set
  // synchronously; the ResizeObserver effect below shrinks to fit in real
  // browsers. (svelte-check warns state_referenced_locally here; the warning
  // is benign — the initial value is intentionally a snapshot.)
  // svelte-ignore state_referenced_locally
  let visibleCount = $state(actions.length)
  let menuOpen = $state(false)
  let adjusting = false

  let visibleActions = $derived(actions.slice(0, visibleCount))
  let overflowActions = $derived(actions.slice(visibleCount))
  let hasOverflow = $derived(overflowActions.length > 0)

  // Clamp when the action set itself changes (mode switch changes length? no,
  // length is stable, but keep fail-closed).
  $effect(() => {
    const total = actions.length
    if (visibleCount > total) visibleCount = total
    if (visibleCount < 0) visibleCount = 0
    if (total === 0) menuOpen = false
  })

  // Close the menu when nothing overflows any more (wide again).
  $effect(() => {
    if (!hasOverflow && menuOpen) menuOpen = false
  })

  async function adjust() {
    if (adjusting) return
    if (!listNode || !containerNode) return
    // jsdom (unit tests) reports 0x0 for every box: keep the full set so the
    // toolbar-icon buttons stay synchronously queryable.
    try {
      const rect = listNode.getBoundingClientRect()
      if (rect.width === 0 && listNode.scrollWidth === 0) return
    } catch {
      return
    }
    adjusting = true
    try {
      // Shrink until the inline list fits (no horizontal scroll).
      for (let i = 0; i < actions.length + 2; i += 1) {
        await tick()
        if (!listNode) return
        const over = listNode.scrollWidth > listNode.clientWidth + 1
        if (over && visibleCount > 0) {
          visibleCount -= 1
        } else {
          break
        }
      }
      // Grow while one more fits (wide again after a shrink).
      for (let i = 0; i < actions.length + 2; i += 1) {
        if (visibleCount >= actions.length) break
        visibleCount += 1
        await tick()
        if (!listNode) return
        if (listNode.scrollWidth > listNode.clientWidth + 1) {
          visibleCount -= 1
          await tick()
          break
        }
      }
    } finally {
      adjusting = false
    }
  }

  $effect(() => {
    if (!containerNode) return
    if (typeof ResizeObserver === 'undefined') return
    void adjust()
    const ro = new ResizeObserver(() => {
      void adjust()
    })
    ro.observe(containerNode)
    return () => ro.disconnect()
  })

  // Re-fit when the number of actions changes (same effect re-runs via length
  // read inside adjust; this explicit watch covers font/zoom-only changes too
  // because the RO fires on container resize).
  $effect(() => {
    void actions.length
    void adjust()
  })

  function menuItems(): HTMLButtonElement[] {
    if (!menuNode) return []
    return Array.from(menuNode.querySelectorAll<HTMLButtonElement>('[data-overflow-menu-item]'))
  }

  // Disabled entries can never take focus (a disabled button ignores
  // .focus()), so keyboard travel skips them: arrows step to the nearest
  // enabled neighbor, Home/End jump to the first/last enabled entry. Without
  // the skip, Home/End/arrows landing on a disabled entry would silently do
  // nothing while the menu stays open.
  function enabledMenuItems(): HTMLButtonElement[] {
    return menuItems().filter((item) => !item.disabled)
  }

  function focusFirstEnabledMenuItem() {
    enabledMenuItems()[0]?.focus()
  }

  function focusLastEnabledMenuItem() {
    const items = enabledMenuItems()
    items[items.length - 1]?.focus()
  }

  function focusAdjacentEnabledMenuItem(delta: 1 | -1) {
    const items = menuItems()
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0) {
      if (delta > 0) focusFirstEnabledMenuItem()
      else focusLastEnabledMenuItem()
      return
    }
    const step = delta > 0 ? 1 : -1
    for (let i = current + step; i >= 0 && i < items.length; i += step) {
      const candidate = items[i]
      if (candidate && !candidate.disabled) {
        candidate.focus()
        return
      }
    }
  }

  function openMenu() {
    if (!hasOverflow) return
    menuOpen = true
    queueMicrotask(() => focusFirstEnabledMenuItem())
  }

  function closeMenu(returnFocus: boolean) {
    if (!menuOpen) return
    menuOpen = false
    if (returnFocus) moreButtonNode?.focus()
  }

  function toggleMenu() {
    if (menuOpen) closeMenu(true)
    else openMenu()
  }

  function handleMoreKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      if (!menuOpen) {
        event.preventDefault()
        openMenu()
      }
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowDown') focusAdjacentEnabledMenuItem(1)
      else if (event.key === 'ArrowUp') focusAdjacentEnabledMenuItem(-1)
      else if (event.key === 'Home') focusFirstEnabledMenuItem()
      else focusLastEnabledMenuItem()
    }
    // Tab is intentionally not intercepted: focus moves naturally and the
    // focusout handler below closes the menu when focus leaves the wrapper.
  }

  function handleWrapperFocusOut(event: FocusEvent) {
    if (!menuOpen) return
    const next = event.relatedTarget as Node | null
    if (next && containerNode?.contains(next)) return
    menuOpen = false
  }

  function handleWindowPointerDown(event: PointerEvent) {
    if (!menuOpen) return
    const target = event.target as Node | null
    if (containerNode && target && !containerNode.contains(target)) menuOpen = false
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div
  bind:this={containerNode}
  class="flex min-w-[2.75rem] flex-1 items-center"
  data-testid="paint-toolbar-overflow"
  onfocusout={handleWrapperFocusOut}
>
  <div bind:this={listNode} class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" aria-label="Paint toolbar actions">
    {#each visibleActions as action (action.id)}
      {@const Icon = action.icon}
      <button
        type="button"
        class="toolbar-icon shrink-0 rounded text-purple-300 hover:bg-slate-700 disabled:opacity-30"
        aria-label={action.label}
        title={action.title}
        data-testid={action.testId}
        disabled={action.disabled}
        aria-disabled={action.ariaDisabled}
        onclick={action.onClick}
      >
        <Icon size={action.iconSize ?? 21} />
      </button>
    {/each}
  </div>
  {#if hasOverflow}
    <div class={`relative shrink-0 ${visibleActions.length > 0 ? 'ml-2' : ''}`}>
      <button
        bind:this={moreButtonNode}
        type="button"
        class="flex h-8 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-800 text-purple-300 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-300"
        aria-label={moreLabel}
        title={moreLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid={moreTestId}
        onclick={toggleMenu}
        onkeydown={handleMoreKeyDown}
      >
        <Ellipsis size={20} />
      </button>
      {#if menuOpen}
        <div
          bind:this={menuNode}
          role="menu"
          tabindex="-1"
          aria-label={moreLabel}
          data-testid={`${moreTestId}-menu`}
          class="absolute right-0 top-full z-50 mt-2 flex max-h-[min(20rem,calc(100vh-12rem))] w-60 max-w-[min(16rem,calc(100vw-2rem))] flex-col gap-1 overflow-auto rounded-lg border border-slate-600 bg-slate-900 p-2 text-slate-100 shadow-xl"
          onkeydown={handleMenuKeyDown}
        >
          {#each overflowActions as action, index (action.id)}
            {@const MenuIcon = action.icon}
            <button
              type="button"
              role="menuitem"
              data-overflow-menu-item=""
              data-menu-index={index}
              class="flex h-9 w-full items-center gap-3 rounded px-2 text-left text-sm font-semibold text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-purple-300 disabled:opacity-40"
              aria-label={action.label}
              title={action.title}
              data-testid={action.testId}
              disabled={action.disabled}
              aria-disabled={action.ariaDisabled}
              onclick={() => {
                const run = action.onClick
                closeMenu(true)
                run()
              }}
            >
              <span class="flex h-8 w-8 shrink-0 items-center justify-center text-purple-300" aria-hidden="true">
                <MenuIcon size={18} />
              </span>
              <span class="min-w-0 flex-1 truncate">{action.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
