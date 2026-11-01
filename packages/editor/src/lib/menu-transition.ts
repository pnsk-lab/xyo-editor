import { cubicOut } from 'svelte/easing'

/** A shared, reduced-motion-aware transition for floating menus and pickers. */
export function menuTransition(_node: Element) {
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return {
    duration: reducedMotion ? 0 : 140,
    easing: cubicOut,
    css: (t: number) => `opacity: ${t}; scale: ${0.97 + 0.03 * t};`,
  }
}
