// Test-only Vite plugin: deterministic race instrumentation for the pending
// bitmap commit vs target-switch / viewport-resize audit.
//
// What it does (IN MEMORY ONLY, never on disk):
// - Installs `window.__pendingRace` (log + named hold/release gates) via the
//   served `index.html`. Production `index.html` on disk is untouched.
// - Wraps the real Editor+VM ordering points with log + gate hooks:
//   - `bitmap-pending-vm-writer.ts`: scope capture (stable slot id / index /
//     asset + writeSeq / projectGeneration / selectionEpoch / structureSeq),
//     a `cas-pre` gate immediately before `updateCostumeIfMatch`, and a
//     `history-append` gate + result log after the CAS resolves (i.e. after
//     applied, before the synchronous history append in the session).
//   - `bitmap-pending-session.ts`: every `status()` transition (commit /
//     refuse / history-gap / quarantine lines) is logged.
//   - `bitmap-pending-ports.ts`: `peek` / `commit` / `isCurrent` decisions of
//     the real Editor history backend are logged (attempt + result).
//   - `Editor.svelte`: `guardedSelectTarget` / `selectCostume` requests and
//     their proceed/refuse outcomes, `syncPaintScope` key transitions,
//     `commitPaintHistory` results, and `clearPaintHistory` (the intentional
//     scope clear) are logged with the live stable selection + scope key +
//     generation + undo depth, so the audit can differentiate an actual bug
//     (bytes landed, no entry, no gap, no clear) from an intentional clear
//     (entry appended, then cleared by an explicit user switch).
//
// Discipline (same as the flag plugin): every replacement anchor must occur
// exactly once; any other count throws and the server refuses to serve.
// No env vars, no query params, no storage. HMR/watch stay OFF in the audit
// config that uses this plugin. Own test-only code only (no AGPL copy).
//
// Usage: add `bitmapPendingRaceInstrumentPlugin()` to the audit config
// plugins. The browser test arms holds with
// `window.__pendingRace.hold('cas-pre')`, drives the UI, asserts refusal /
// retention via the log, then `release()`s — no sleeps.

const RUNTIME_SNIPPET = `<script>
window.__pendingRace = (function () {
  var log = [];
  var seq = 0;
  var holds = new Map();
  function push(kind, detail) {
    seq += 1;
    try {
      log.push({ seq: seq, t: Date.now(), kind: kind, detail: detail === undefined ? null : detail });
    } catch (e) {}
  }
  function gate(name) {
    var h = holds.get(name);
    if (!h) return Promise.resolve();
    push('gate-wait', { name: name });
    return h.promise.then(function () {
      push('gate-released', { name: name });
    });
  }
  return {
    log: log,
    push: push,
    gate: gate,
    hold: function (name) {
      if (!holds.has(name)) {
        var releaseFn = function () {};
        var promise = new Promise(function (resolve) {
          releaseFn = function () {
            holds.delete(name);
            push('hold-released', { name: name });
            resolve();
          };
        });
        holds.set(name, { promise: promise, release: releaseFn });
        push('hold-armed', { name: name });
      }
    },
    release: function (name) {
      if (name) {
        var h = holds.get(name);
        if (h) h.release();
      } else {
        Array.from(holds.values()).forEach(function (h) {
          h.release();
        });
      }
    },
    clear: function () {
      log.length = 0;
    },
  };
})();
</script>`

const APP_DIV = '<div id="app"></div>'

type Replacement = { needle: string; replace: string }

function applyReplacements(code: string, id: string, reps: Replacement[]): string {
  let out = code
  for (const { needle, replace } of reps) {
    const count = out.split(needle).length - 1
    if (count !== 1) {
      throw new Error(
        `[test:bitmap-pending-race] expected exactly 1 ${JSON.stringify(needle)} in ${id}, found ${count}; refusing to serve a partially-instrumented module`,
      )
    }
    out = out.replace(needle, replace)
  }
  return out
}

// Shorthand used inside injected module code (kept tiny; every use is
// guarded so a missing runtime is a no-op, never a break).
const PUSH_FN = `(globalThis as unknown as { __pendingRace?: { push: (kind: string, detail?: unknown) => void } }).__pendingRace?.push`
const GATE_FN = `(globalThis as unknown as { __pendingRace?: { gate: (name: string) => Promise<void> } }).__pendingRace?.gate`

export function bitmapPendingRaceInstrumentPlugin() {
  return {
    name: 'test:bitmap-pending-race-instrument',
    enforce: 'pre' as const,
    transformIndexHtml(html: string) {
      const count = html.split(APP_DIV).length - 1
      if (count !== 1) {
        throw new Error(
          `[test:bitmap-pending-race] expected exactly 1 ${JSON.stringify(APP_DIV)} in index.html, found ${count}; refusing to serve without the race runtime`,
        )
      }
      return html.replace(APP_DIV, `${APP_DIV}\n    ${RUNTIME_SNIPPET}`)
    },
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0]
      if (cleanId.endsWith('features/costumes/bitmap-pending-vm-writer.ts')) {
        return {
          code: applyReplacements(code, cleanId, [
            {
              needle: 'const bytesCopy = new Uint8Array(pngBytes)',
              replace: `try { ${PUSH_FN}('cas-pre', { slotId, slotIndex, expected: { ...(expected as object) }, captureProject, captureSelection }) } catch { /* test hook only */ }\n    await ${GATE_FN}('cas-pre')\n    const bytesCopy = new Uint8Array(pngBytes)`,
            },
            {
              needle: 'if (!isValidCasResult(raw)) {',
              replace: `try { ${PUSH_FN}('cas-post', { slotId, slotIndex, applied: (raw as { applied?: unknown } | null | undefined)?.applied ?? null, reason: (raw as { reason?: unknown } | null | undefined)?.reason ?? null }) } catch { /* test hook only */ }\n    await ${GATE_FN}('history-append')\n    if (!isValidCasResult(raw)) {`,
            },
          ]),
          map: null as unknown as undefined,
        }
      }
      if (cleanId.endsWith('features/costumes/bitmap-pending-session.ts')) {
        return {
          code: applyReplacements(code, cleanId, [
            {
              needle: 'function status(text: string): void {',
              replace: `function status(text: string): void {\n    try { ${PUSH_FN}('session-status', { text }) } catch { /* test hook only */ }`,
            },
          ]),
          map: null as unknown as undefined,
        }
      }
      if (cleanId.endsWith('features/costumes/bitmap-pending-ports.ts')) {
        return {
          code: applyReplacements(code, cleanId, [
            {
              needle: 'peek: () => source.peek(),',
              replace: `peek: async () => {
      try { ${PUSH_FN}('history-peek-pre', {}) } catch { /* test hook only */ }
      const __peeked = await source.peek();
      try { ${PUSH_FN}('history-peek-post', { present: __peeked !== undefined }) } catch { /* test hook only */ }
      return __peeked;
    },`,
            },
            {
              needle: `    commit: (entry: E) => {
      try {
        return source.commit(entry)
      } catch {
        return false
      }
    },`,
              replace: `    commit: (entry: E) => {
      try { ${PUSH_FN}('history-append-attempt', {}) } catch { /* test hook only */ }
      let __appendOk = false
      try {
        __appendOk = source.commit(entry)
      } catch {
        __appendOk = false
      }
      try { ${PUSH_FN}('history-append-result', { ok: __appendOk }) } catch { /* test hook only */ }
      return __appendOk
    },`,
            },
            {
              needle: `      return {
        isCurrent: () => {
          if (released) return false
          return isCurrent()
        },
        commit: () => {
          if (released) return false
          let ok = false
          try {
            ok = source.commit(entry) === true
          } catch {
            ok = false
          }
          released = true`,
              replace: `      return {
        isCurrent: () => {
          if (released) return false
          let __reservationCurrent = true
          try {
            __reservationCurrent = isCurrent()
          } catch {
            __reservationCurrent = false
          }
          try { ${PUSH_FN}('history-isCurrent', { value: __reservationCurrent, via: 'reservation' }) } catch { /* test hook only */ }
          return __reservationCurrent
        },
        commit: () => {
          if (released) return false
          let ok = false
          try { ${PUSH_FN}('history-append-attempt', { via: 'reservation' }) } catch { /* test hook only */ }
          try {
            ok = source.commit(entry) === true
          } catch {
            ok = false
          }
          try { ${PUSH_FN}('history-append-result', { ok, via: 'reservation' }) } catch { /* test hook only */ }
          released = true`,
            },
            {
              needle: '    isCurrent,',
              replace: `    isCurrent: () => {
      let __current = true
      try {
        __current = isCurrent()
      } catch {
        __current = false
      }
      try { ${PUSH_FN}('history-isCurrent', { value: __current }) } catch { /* test hook only */ }
      return __current
    },`,
            },
          ]),
          map: null as unknown as undefined,
        }
      }
      if (cleanId.endsWith('src/Editor.svelte')) {
        return {
          code: applyReplacements(code, cleanId, [
            {
              needle: 'async function guardedSelectTarget(name: string): Promise<void> {',
              replace: `async function guardedSelectTarget(name: string): Promise<void> {
    try { ${PUSH_FN}('select-target-request', { name, live: selectedTarget ? selectedTarget.name ?? null : null }) } catch { /* test hook only */ }`,
            },
            {
              needle: 'vm.selectTarget(name)',
              replace: `void (() => { try { ${PUSH_FN}('select-target-proceed', { name }) } catch { /* test hook only */ } })()\n    vm.selectTarget(name)`,
            },
            {
              needle: 'async function selectCostume(index: number) {',
              replace: `async function selectCostume(index: number) {
    try { ${PUSH_FN}('select-costume-request', { index, live: selectedTarget ? (selectedTarget.currentCostume ?? 0) : null }) } catch { /* test hook only */ }`,
            },
            {
              needle: 'vm.setCurrentCostume(selectedTarget.name, index)',
              replace: `void (() => { try { ${PUSH_FN}('select-costume-proceed', { index }) } catch { /* test hook only */ } })()\n    vm.setCurrentCostume(selectedTarget.name, index)`,
            },
            {
              needle: 'function syncPaintScope(): void {',
              replace: `function syncPaintScope(): void {
    try { ${PUSH_FN}('paint-scope-sync', { key: activePaintScopeKey(), paintScopeKey, paintScopeGeneration }) } catch { /* test hook only */ }`,
            },
            {
              needle: 'function commitPaintHistory(entry: AssetHistoryEntry) {',
              replace: `function commitPaintHistory(entry: AssetHistoryEntry) {
    try { ${PUSH_FN}('paint-commit-pre', { undoDepth: paintUndoStack.length }) } catch { /* test hook only */ }`,
            },
            {
              needle: 'function clearPaintHistory(): void {',
              replace: `function clearPaintHistory(): void {
    try { ${PUSH_FN}('paint-clear', { key: paintScopeKey, paintScopeGeneration, undoDepth: paintUndoStack.length }) } catch { /* test hook only */ }`,
            },
          ]),
          map: null as unknown as undefined,
        }
      }
      return undefined
    },
  }
}

export const BITMAP_PENDING_RACE_INSTRUMENTATION_PLUGIN_NAME = 'test:bitmap-pending-race-instrument'
