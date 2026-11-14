// Test-only Vite plugin: expose the ACTUAL existing `vm` instance from Editor
// + deferred barriers at updateCostumeIfMatch / storeAsset / history-append.
//
// - NEVER touches on-disk product sources; all changes are in-memory transforms.
// - NEVER introduces a production runtime switch (no env vars, query params,
//   storage reads): the transform itself is the sole mechanism.
// - Exactly-once anchors: every needle must occur exactly once, otherwise the
//   transform throws and the server refuses to serve (fail-closed).
// - Pairs with `vite-bitmap-pending-enabled-plugin.ts` (flag flip) in
//   `test/vite.bitmap-pending-direct.config.ts`. This plugin does NOT flip the
//   flag itself, so on-disk `BITMAP_PENDING_UI_ENABLED = false` stays assertable.
// - AGENTS split: test-only code, no AGPL copy, no Editor product edits on disk.

const APP_DIV = '<div id="app"></div>'

const VM_ANCHOR = 'const vm = context.vm'
const TEST_API_ANCHOR = 'snapshot: () => vm.snapshot(),'
const WRITER_BYTES_ANCHOR = 'const bytesCopy = new Uint8Array(pngBytes)'
const WRITER_RESULT_ANCHOR = 'if (!isValidCasResult(raw)) {'

const PUSH_FN = `(globalThis as unknown as { __directRace?: { push: (kind: string, detail?: unknown) => void } }).__directRace?.push`
const GATE_FN = `(globalThis as unknown as { __directRace?: { gate: (name: string) => Promise<void> } }).__directRace?.gate`

const RUNTIME_SNIPPET = `<script>
window.__directRace = (function () {
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
window.__directVm = null;
</script>`

function applyOnce(code: string, id: string, needle: string, replace: string): string {
  const count = code.split(needle).length - 1
  if (count !== 1) {
    throw new Error(
      `[test:bitmap-pending-direct-vm] expected exactly 1 ${JSON.stringify(needle)} in ${id}, found ${count}; refusing to serve a partially-instrumented module`,
    )
  }
  return code.replace(needle, replace)
}

export function bitmapPendingDirectVmPlugin() {
  return {
    name: 'test:bitmap-pending-direct-vm',
    enforce: 'pre' as const,
    transformIndexHtml(html: string) {
      const count = html.split(APP_DIV).length - 1
      if (count !== 1) {
        throw new Error(
          `[test:bitmap-pending-direct-vm] expected exactly 1 ${JSON.stringify(APP_DIV)} in index.html, found ${count}; refusing to serve without the direct race runtime`,
        )
      }
      return html.replace(APP_DIV, `${APP_DIV}\n    ${RUNTIME_SNIPPET}`)
    },
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0]
      if (cleanId.endsWith('src/Editor.svelte')) {
        let out = code
        // 1) Wrap the ACTUAL existing vm instance with deferred barriers and
        // expose it as window.__directVm (the live object, never a snapshot).
        out = applyOnce(
          out,
          cleanId,
          VM_ANCHOR,
          `${VM_ANCHOR}
  // test-only direct-VM harness (in-memory only; no prod switch).
  try {
    const __dvm = vm as unknown as Record<string, unknown>
    if (!__dvm['__directWrapped']) {
      __dvm['__directWrapped'] = true
      try { (window as unknown as Record<string, unknown>)['__directVm'] = vm } catch { /* noop */ }
      const __origCas = typeof __dvm['updateCostumeIfMatch'] === 'function'
        ? ((__dvm['updateCostumeIfMatch'] as (...a: unknown[]) => Promise<unknown>).bind(vm))
        : undefined
      const __origStore = typeof __dvm['storeAsset'] === 'function'
        ? ((__dvm['storeAsset'] as (...a: unknown[]) => Promise<unknown>).bind(vm))
        : undefined
      if (__origCas) {
        __dvm['updateCostumeIfMatch'] = (async (...a: unknown[]) => {
          try { ${PUSH_FN}('direct-cas-pre', { argc: a.length }) } catch { /* test hook only */ }
          await ${GATE_FN}('direct-cas-pre')
          await ${GATE_FN}('direct-store')
          let __out: unknown
          try {
            __out = await __origCas(...a)
          } catch (__e) {
            try { ${PUSH_FN}('direct-cas-error', {}) } catch { /* test hook only */ }
            throw __e
          }
          try { ${PUSH_FN}('direct-cas-post', { applied: (__out as { applied?: unknown } | null | undefined)?.applied ?? null }) } catch { /* test hook only */ }
          return __out
        }) as unknown
      }
      if (__origStore) {
        __dvm['storeAsset'] = (async (...a: unknown[]) => {
          try { ${PUSH_FN}('direct-store-pre', {}) } catch { /* test hook only */ }
          await ${GATE_FN}('direct-store')
          const __out = await __origStore(...a)
          try { ${PUSH_FN}('direct-store-post', {}) } catch { /* test hook only */ }
          return __out
        }) as unknown
      }
    } else {
      try { (window as unknown as Record<string, unknown>)['__directVm'] = vm } catch { /* noop */ }
    }
  } catch { /* test hook only; never blocks the editor */ }`,
        )
        // 2) Expose the same live instance via the test API (snapshot stays).
        out = applyOnce(
          out,
          cleanId,
          TEST_API_ANCHOR,
          `${TEST_API_ANCHOR}\n      directVm: () => vm,`,
        )
        return { code: out, map: null as unknown as undefined }
      }
      if (cleanId.endsWith('features/costumes/bitmap-pending-vm-writer.ts')) {
        let out = code
        // Deferred CAS barrier (async-safe, before the atomic mutation).
        out = applyOnce(
          out,
          cleanId,
          WRITER_BYTES_ANCHOR,
          `try { ${PUSH_FN}('direct-writer-cas-pre', { slotId, slotIndex }) } catch { /* test hook only */ }\n    await ${GATE_FN}('direct-cas-pre')\n    ${WRITER_BYTES_ANCHOR}`,
        )
        // Deferred history-append barrier (async-safe, after CAS resolves,
        // before the coordinator's synchronous history append).
        out = applyOnce(
          out,
          cleanId,
          WRITER_RESULT_ANCHOR,
          `try { ${PUSH_FN}('direct-writer-cas-post', { applied: (raw as { applied?: unknown } | null | undefined)?.applied ?? null }) } catch { /* test hook only */ }\n    await ${GATE_FN}('direct-history-append')\n    ${WRITER_RESULT_ANCHOR}`,
        )
        return { code: out, map: null as unknown as undefined }
      }
      if (cleanId.endsWith('features/costumes/bitmap-pending-ports.ts')) {
        let out = code
        // Sync commit cannot await a deferred gate without breaking its
        // contract, so log the append path only (the async writer gate above
        // is the deferrable history-append barrier).
        const COMMIT_ANCHOR = `    commit: (entry: E) => {
      try {
        return source.commit(entry)
      } catch {
        return false
      }
    },`
        out = applyOnce(
          out,
          cleanId,
          COMMIT_ANCHOR,
          `    commit: (entry: E) => {
      try { ${PUSH_FN}('direct-history-append-attempt', {}) } catch { /* test hook only */ }
      let __directAppendOk = false
      try {
        __directAppendOk = source.commit(entry)
      } catch {
        __directAppendOk = false
      }
      try { ${PUSH_FN}('direct-history-append-result', { ok: __directAppendOk }) } catch { /* test hook only */ }
      return __directAppendOk
    },`,
        )
        return { code: out, map: null as unknown as undefined }
      }
      return undefined
    },
  }
}

export const BITMAP_PENDING_DIRECT_VM_PLUGIN_NAME = 'test:bitmap-pending-direct-vm'
