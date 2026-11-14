// Test-only Vite config for the bitmap commit-gate browser test.
//
// Another agent edits UI source concurrently in this checkout, and the
// default dev server would push HMR updates / full reloads into the test
// browser mid-run (vanishing toolbar, remounting canvas, torn gestures).
// This wrapper pins the served modules: `server.watch: null` disables the
// file watcher entirely (no HMR, no reload on foreign saves); `hmr: false`
// is belt-and-braces. First-request transforms are served as-is.
//
// Usage (test spawns its own server, independent port):
//   bun x vite --config vite.gate.config.ts --host 127.0.0.1 --port 4390 --strictPort
// Never used by the product dev/build paths.
import base from './vite.config'

export default {
  ...(base as Record<string, unknown>),
  server: {
    ...(((base as Record<string, unknown>).server as Record<string, unknown>) ?? {}),
    watch: null,
    hmr: false,
  },
}
