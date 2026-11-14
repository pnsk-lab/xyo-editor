// Test-only Vite config: serves the REAL Editor with the bitmap pending UI
// enabled IN MEMORY ONLY via `vite-bitmap-pending-enabled-plugin.ts`.
//
// - On-disk `src/features/costumes/bitmap-pending-controller.ts` still contains
//   `export const BITMAP_PENDING_UI_ENABLED = false as const` (asserted
//   before+after by the browser test).
// - The plugin replaces exactly that one string with `true` during transform;
//   any other count throws and the server refuses to serve.
// - No env vars, no query params, no storage: the transform is the sole
//   mechanism (the test asserts the source contains no bypass tokens).
// - HMR/watch OFF (pinned modules, same rationale as `vite.gate.config.ts`):
//   `server.watch: null` + `server.hmr: false` so foreign saves mid-run cannot
//   remount the canvas or tear gestures.
//
// Usage (test spawns its own server, independent port):
//   bun x vite --config test/vite.bitmap-pending.config.ts --host 127.0.0.1 --port 4691 --strictPort
// Never used by the product dev/build paths.
import base from '../vite.config'
import { bitmapPendingEnabledPlugin } from './vite-bitmap-pending-enabled-plugin'
import { bitmapPendingRaceInstrumentPlugin } from './vite-bitmap-pending-race-instrument'

const baseRecord = base as unknown as Record<string, unknown>
const basePlugins = (baseRecord.plugins as unknown[] | undefined) ?? []
const baseServer = (baseRecord.server as Record<string, unknown> | undefined) ?? {}

export default {
  ...baseRecord,
  plugins: [...basePlugins, bitmapPendingEnabledPlugin(), bitmapPendingRaceInstrumentPlugin()],
  server: {
    ...baseServer,
    watch: null,
    hmr: false,
  },
}
