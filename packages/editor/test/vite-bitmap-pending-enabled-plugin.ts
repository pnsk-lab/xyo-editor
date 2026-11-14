// Test-only Vite plugin: enables the bitmap pending UI for the E2E server
// WITHOUT touching the on-disk product flag.
//
// During transform it replaces ONLY
//   `export const BITMAP_PENDING_UI_ENABLED = false as const`
// in `src/features/costumes/bitmap-pending-controller.ts` with
//   `export const BITMAP_PENDING_UI_ENABLED = true as const`
// Exactly one replacement is expected; any mismatch fails loudly (throws).
// No env vars, no query params, no storage reads: the transform is the sole
// mechanism. HMR/watch are disabled in the test config that uses this plugin.
//
// AGENTS split: no AGPL copy, no production source edits (Editor /
// BitmapEditor / controller untouched on disk).

const NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'
const REPLACEMENT = 'export const BITMAP_PENDING_UI_ENABLED = true as const'
const TARGET_SUFFIX = 'features/costumes/bitmap-pending-controller.ts'

export function bitmapPendingEnabledPlugin() {
  return {
    name: 'test:bitmap-pending-enabled',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0]
      if (!cleanId.endsWith(TARGET_SUFFIX)) return undefined
      const occurrences = code.split(NEEDLE).length - 1
      if (occurrences !== 1) {
        throw new Error(
          `[test:bitmap-pending-enabled] expected exactly 1 replacement of ${JSON.stringify(NEEDLE)} in ${cleanId}, found ${occurrences}; refusing to serve a partially-patched flag`,
        )
      }
      return {
        code: code.replace(NEEDLE, REPLACEMENT),
        map: null as unknown as undefined,
      }
    },
  }
}

export const BITMAP_PENDING_ENABLED_NEEDLE = NEEDLE
export const BITMAP_PENDING_ENABLED_REPLACEMENT = REPLACEMENT
