// Test-only Vite config: real Editor + in-memory pending UI + direct-VM harness.
//
// - On-disk `src/features/costumes/bitmap-pending-controller.ts` still contains
//   `export const BITMAP_PENDING_UI_ENABLED = false as const` (asserted
//   before+after by the browser test).
// - `vite-bitmap-pending-enabled-plugin.ts` flips that ONE string to `true`
//   in memory only (single expected replacement, throws otherwise).
// - `vite-bitmap-pending-direct-vm-plugin.ts` exposes the ACTUAL existing `vm`
//   instance from Editor (`window.__directVm` + `__hikkakuEditorTest.directVm`)
//   and instruments deferred barriers at `updateCostumeIfMatch` / `storeAsset`
//   / history-append (`direct-cas-pre`, `direct-store`, `direct-history-append`).
//   No env vars, query params, or storage: the transforms are the sole mechanism.
// - HMR/watch OFF (pinned modules): `server.watch: null` + `server.hmr: false`
//   so foreign saves mid-run cannot remount the canvas or tear gestures.
// - Independent port (4693) so this suite can run alongside the 4691 audit.
//
// Usage (test spawns its own server, independent port):
//   bun x vite --config test/vite.bitmap-pending-direct.config.ts --host 127.0.0.1 --port 4693 --strictPort
// Never used by the product dev/build paths.
import base from '../vite.config'
import { bitmapPendingEnabledPlugin } from './vite-bitmap-pending-enabled-plugin'
import { bitmapPendingDirectVmPlugin } from './vite-bitmap-pending-direct-vm-plugin'

const baseRecord = base as unknown as Record<string, unknown>
const basePlugins = (baseRecord.plugins as unknown[] | undefined) ?? []
const baseServer = (baseRecord.server as Record<string, unknown> | undefined) ?? {}

export default {
  ...baseRecord,
  plugins: [...basePlugins, bitmapPendingEnabledPlugin(), bitmapPendingDirectVmPlugin()],
  server: {
    ...baseServer,
    watch: null,
    hmr: false,
  },
}
