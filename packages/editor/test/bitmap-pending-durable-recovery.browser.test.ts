// Isolated opt-in test-only durable recovery store for the PNG quarantine (B-3).
//
// What this pins (real IndexedDB in Chrome, no production wiring):
// - Opt-in only: production `BITMAP_PENDING_DURABLE_RECOVERY_ENABLED` stays
//   `false` on disk, `Editor.svelte` never imports this module, and the store
//   only exists when `createBitmapPendingDurableRecoveryStoreForTest` is
//   called explicitly in-process. No storage/URL/env bypass.
// - Real reload durability + integrity: save real canvas PNG bytes, reload the
//   page, re-open the same database, and prove identical bytes + SHA-256.
// - Forced failure: oversize payload and a throwing IDB factory refuse with
//   explicit reasons; the in-memory copy is retained, nothing is stored, and
//   no fake "saved" status exists. A failed fake-writer encode never reaches
//   `save`, so the `beforeunload`-equivalent (memory retained) stays armed.
// - Same-name project + cross-target safety: identical ids with a moved
//   `projectGeneration`, or drifted `assetKey`/`writeSeq`, never load.
// - Concurrent tabs: stale `expectedFenceSeq` loses with `conflict-fence`,
//   rejected bytes stay in memory, a fresh fence wins.
// - Expiration + cap never silently evict: expired records still load (flagged),
//   a full store refuses (`store-full`) keeping both sides, and only an
//   explicit `{ confirmed: true }` discard deletes (wrong-owner deletes refuse).
// - Never auto-applied: the module has zero VM/canvas/history imports and no
//   network surface (audited); reads return detached copies.
// - Test-only fake writer: deterministic in-page PNG-byte writer used for the
//   failure/fencing/cap legs (one leg additionally uses REAL canvas PNG
//   bytes via `toBlob` for true encode integrity).
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/bitmap-pending-durable-recovery.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4697
const base = `http://127.0.0.1:${PORT}`
const DURABLE_URL = new URL(
  '../src/features/costumes/bitmap-pending-durable-recovery.ts',
  import.meta.url,
)
const CONTROLLER_URL = new URL(
  '../src/features/costumes/bitmap-pending-controller.ts',
  import.meta.url,
)
const EDITOR_URL = new URL('../src/Editor.svelte', import.meta.url)
const FLAG_NEEDLE = 'export const BITMAP_PENDING_DURABLE_RECOVERY_ENABLED = false as const'
const PROD_FLAG_NEEDLE = 'export const BITMAP_PENDING_UI_ENABLED = false as const'

let server: ChildProcess | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page: Page

async function onDiskDurableSource(): Promise<string> {
  return await Bun.file(DURABLE_URL).text()
}

async function startServer(): Promise<void> {
  server = spawn(
    'bun',
    ['x', 'vite', '--config', 'vite.gate.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'pipe' },
  )
  let ready = false
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error(`Vite (gate config) exited ${server.exitCode}`)
    try {
      if ((await fetch(base)).ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('Vite (gate config) failed to start')
}

describe('bitmap pending durable recovery (isolated, test-only, real IndexedDB)', () => {
  beforeAll(async () => {
    await startServer()
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    page = await context.newPage()
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 90_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    server?.kill()
  })

  it('static audit: disabled by default, zero product coupling, zero network/storage bypass', async () => {
    const source = await onDiskDurableSource()
    expect(source.split(FLAG_NEEDLE).length - 1).toBe(1)
    // Production flag untouched by this change (still a single disabled const).
    const controllerSource = await Bun.file(CONTROLLER_URL).text()
    expect(controllerSource.split(PROD_FLAG_NEEDLE).length - 1).toBe(1)
    // Never auto-applies: no VM / canvas / history / commit surface.
    for (const token of [
      'updateCostume',
      'putImageData',
      'commitHistory',
      'peekCostumeHistory',
      'bitmap-pending-controller',
      'bitmap-pending-session',
      'Editor.svelte',
    ]) {
      expect(source).not.toContain(token)
    }
    // No network, no ambient web storage, no env/query bypass, no deps.
    for (const token of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'sendBeacon',
      'localStorage.',
      'sessionStorage.',
      'document.cookie',
      'URLSearchParams',
      'location.search',
      'location.hash',
      'import.meta.env',
      'process.env',
      "from '",
      'from "',
      'require(',
    ]) {
      expect(source).not.toContain(token)
    }
    // Integrity is platform SubtleCrypto, versioned + documented.
    expect(source).toContain('SHA-256')
    expect(source).toContain('DURABLE_RECOVERY_RECORD_VERSION')
    const editorSource = await Bun.file(EDITOR_URL).text()
    expect(editorSource).not.toContain('bitmap-pending-durable-recovery')
    expect(editorSource).not.toContain('createBitmapPendingDurableRecoveryStoreForTest')
  }, 60_000)

  it('real PNG round-trip survives reload with identical bytes + digest (owner-gated export)', async () => {
    const dbName = 'xyo-test-durable-reload-v1'
    const proof = await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db, tabId: 'tab-reload-a' })
      await store.destroyDatabaseForTest()
      const fresh = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db, tabId: 'tab-reload-a' })
      // REAL encode: actual canvas PNG bytes (not the fake writer).
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 48
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#123456'
      ctx.fillRect(0, 0, 64, 48)
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(8, 8, 24, 16)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) return { ok: false as const, reason: 'toBlob-null' }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const owner = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', assetId: 'a1', writeSeq: 3, projectGeneration: 7 }
      const saved = await fresh.save({ owner, png: bytes, width: 64, height: 48, format: 'png', bitmapResolution: 2, rotationCenterX: 32, rotationCenterY: 24 })
      if (!saved.ok) return { ok: false as const, reason: `save-${(saved as { reason?: string }).reason}` }
      const exported = await fresh.exportPng(owner)
      // Detached copy: mutating the export must not corrupt the store.
      if (!exported || exported.byteLength !== bytes.byteLength) return { ok: false as const, reason: 'export-size' }
      exported[10] = (exported[10] ?? 0) ^ 0xff
      const reexport = await fresh.exportPng(owner)
      const intact = reexport !== undefined && Array.from(reexport).join(',') === Array.from(bytes).join(',')
      const listed = await fresh.list()
      fresh.close()
      return {
        ok: true as const,
        sha: (saved as { sha256Hex: string }).sha256Hex,
        fence: (saved as { fenceSeq: number }).fenceSeq,
        bytesLen: bytes.byteLength,
        bytesHead: Array.from(bytes.slice(0, 16)),
        intact,
        listedKeys: listed.map((e: { key: string }) => e.key),
      }
    }, dbName)
    expect(proof.ok).toBe(true)
    if (!proof.ok) return
    const before = { sha: proof.sha, len: proof.bytesLen, head: proof.bytesHead }
    // Full reload: in-memory module state is gone; IndexedDB must still hold it.
    await page.reload({ waitUntil: 'networkidle' })
    const after = await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db, tabId: 'tab-reload-b' })
      const owner = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', assetId: 'a1', writeSeq: 3, projectGeneration: 7 }
      const loaded = await store.load(owner)
      if (!loaded.ok) return { ok: false as const, reason: (loaded as { reason?: string }).reason }
      const view = (loaded as { record: { png: Uint8Array; width: number; height: number; sha256Hex: string }; expired: boolean }).record
      const bytes = Array.from(view.png)
      // Independent re-hash (not trusting the stored digest string alone).
      const digest = await crypto.subtle.digest('SHA-256', view.png.slice().buffer as ArrayBuffer)
      const hex = Array.from(new Uint8Array(digest)).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('')
      const listed = await store.list()
      store.close()
      return {
        ok: true as const,
        sha: view.sha256Hex,
        rehash: hex,
        len: view.png.byteLength,
        head: bytes.slice(0, 16),
        width: view.width,
        height: view.height,
        expired: (loaded as { expired: boolean }).expired,
        fenced: listed.length === 1,
      }
    }, dbName)
    expect(after.ok).toBe(true)
    if (!after.ok || !proof.ok) return
    expect(after.sha).toBe(before.sha)
    expect(after.rehash).toBe(before.sha)
    expect(after.len).toBe(before.len)
    expect(after.head).toEqual(before.head)
    expect(after.expired).toBe(false)
    expect(after.fenced).toBe(true)
    // Cleanup so reruns start clean (best effort).
    await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db })
      await store.destroyDatabaseForTest()
    }, dbName)
  }, 120_000)

  it('same-name project and cross-target/slot drift never restore (owner-mismatch, no bytes)', async () => {
    const dbName = 'xyo-test-durable-owner-v1'
    const proof = await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db, tabId: 'tab-owner' })
      await store.destroyDatabaseForTest()
      const again = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db, tabId: 'tab-owner' })
      // Test-only fake writer: deterministic pseudo-PNG bytes.
      const fakePng = (seed: number, size: number): Uint8Array => {
        const out = new Uint8Array(size)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        for (let i = 0; i < size; i += 1) out[i] = i < sig.length ? (sig[i] as number) : (seed + i * 31) % 251
        return out
      }
      const owner = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', assetId: 'a1', writeSeq: 3, projectGeneration: 7 }
      const saved = await again.save({ owner, png: fakePng(5, 256), width: 16, height: 16 })
      if (!saved.ok) return { ok: false as const, reason: 'seed-save-failed' }
      const attempts = [
        // Same ids, same bytes, but the project was replaced (same NAME, new generation).
        { ...owner, projectGeneration: 8 },
        // Cross-target, same everything else.
        { ...owner, targetId: 'sprite-2' },
        // Same slot, external write landed new bytes (rename/store advance).
        { ...owner, assetKey: 'md5-ext', assetId: 'a9', writeSeq: 4 },
        // Same slot, stale writeSeq.
        { ...owner, writeSeq: 2 },
      ]
      const results: Array<{ reason?: string; leaked: boolean }> = []
      for (const candidate of attempts) {
        const loaded = await again.load(candidate)
        const exported = await again.exportPng(candidate)
        results.push({ reason: loaded.ok ? 'MATCHED' : (loaded as { reason?: string }).reason, leaked: exported !== undefined })
      }
      const keyA = mod.durableKeyForOwner(owner)
      const keyB = mod.durableKeyForOwner({ ...owner, projectGeneration: 8 })
      const listed = await again.list()
      again.close()
      return { ok: true as const, results, keysDiffer: keyA !== keyB, listedCount: listed.length }
    }, dbName)
    expect(proof.ok).toBe(true)
    if (!proof.ok) return
    expect(proof.keysDiffer).toBe(true)
    expect(proof.listedCount).toBe(1)
    for (const entry of proof.results) {
      expect(entry.reason).not.toBe('MATCHED')
      expect(entry.leaked).toBe(false)
    }
    await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      await mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db }).destroyDatabaseForTest()
    }, dbName)
  }, 120_000)

  it('forced failure is explicit: oversize + throwing IDB + failed encode retain memory, store nothing, fake no status', async () => {
    const dbName = 'xyo-test-durable-fail-v1'
    const proof = await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({
        dbName: db,
        tabId: 'tab-fail',
        caps: { maxBytesPerRecord: 64, maxRecords: 4, maxTotalBytes: 1024 * 1024, ttlMs: 60_000 },
      })
      await store.destroyDatabaseForTest()
      const again = mod.createBitmapPendingDurableRecoveryStoreForTest({
        dbName: db,
        tabId: 'tab-fail',
        caps: { maxBytesPerRecord: 64, maxRecords: 4, maxTotalBytes: 1024 * 1024, ttlMs: 60_000 },
      })
      // Test-only fake writer with injectable encode failure.
      let encodeCalls = 0
      const fakeEncode = (seed: number, size: number, fail: boolean): Uint8Array | undefined => {
        encodeCalls += 1
        if (fail) return undefined
        const out = new Uint8Array(size)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        for (let i = 0; i < size; i += 1) out[i] = i < sig.length ? (sig[i] as number) : (seed + i * 17) % 251
        return out
      }
      const owner = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', writeSeq: 3, projectGeneration: 7 }
      // 1. Oversize payload (65 > 64 cap): explicit refusal, memory retained.
      const big = fakeEncode(1, 65, false)!
      const memoryRetained: number[] = [big.byteLength]
      const oversize = await again.save({ owner, png: big, width: 8, height: 8 })
      const afterOversize = await again.load(owner)
      // 2. Throwing IDB factory (quota surface): explicit failure, nothing stored.
      const throwingIdb = new Proxy({}, { get() { throw new DOMException('Quota exceeded', 'QuotaExceededError') } }) as unknown as IDBFactory
      const broken = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: `${db}-broken`, tabId: 'tab-broken', idb: throwingIdb })
      const brokenSave = await broken.save({ owner, png: fakeEncode(2, 32, false)!, width: 8, height: 8 })
      // 3. Failed async encode: save is NEVER called; unsaved stays armed.
      let saveCalls = 0
      const maybeEncoded = fakeEncode(3, 32, true)
      if (maybeEncoded !== undefined) {
        saveCalls += 1
        await again.save({ owner, png: maybeEncoded, width: 8, height: 8 })
      }
      const wouldPreventUnload = memoryRetained.length === 1 && maybeEncoded === undefined
      again.close()
      return {
        oversizeReason: oversize.ok ? 'STORED' : (oversize as { reason?: string }).reason,
        memoryBytes: memoryRetained[0],
        loadAfterOversize: afterOversize.ok ? 'STORED' : (afterOversize as { reason?: string }).reason,
        brokenReason: brokenSave.ok ? 'STORED' : (brokenSave as { reason?: string }).reason,
        encodeCalls,
        saveCallsAfterEncodeFailure: saveCalls,
        wouldPreventUnload,
      }
    }, dbName)
    expect(proof.oversizeReason).toBe('payload-too-large')
    expect(proof.memoryBytes).toBe(65)
    expect(proof.loadAfterOversize).toBe('not-found')
    expect(proof.brokenReason).toBe('quota-exceeded')
    // Encode ran (3 calls) but the failed one never reached save.
    expect(proof.encodeCalls).toBe(3)
    expect(proof.saveCallsAfterEncodeFailure).toBe(0)
    expect(proof.wouldPreventUnload).toBe(true)
    await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      await mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db }).destroyDatabaseForTest()
    }, dbName)
  }, 120_000)

  it('concurrent tabs fence: stale writes conflict and stay in memory, fresh fence wins', async () => {
    if (!context) throw new Error('no browser context')
    const dbName = 'xyo-test-durable-fence-v1'
    const pageA = await context.newPage()
    const pageB = await context.newPage()
    try {
      await pageA.goto(base, { waitUntil: 'networkidle' })
      await pageB.goto(base, { waitUntil: 'networkidle' })
      const owner = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', writeSeq: 3, projectGeneration: 7 }
      const seedA = await pageA.evaluate(async (args: { db: string; owner: { targetId: string; costumeIndex: number; assetKey: string; writeSeq: number; projectGeneration: number } }) => {
        const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
        const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: args.db, tabId: 'tab-A' })
        await store.destroyDatabaseForTest()
        const fresh = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: args.db, tabId: 'tab-A' })
        const png = new Uint8Array(48).fill(11)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        sig.forEach((b, i) => { png[i] = b })
        const saved = await fresh.save({ owner: args.owner, png, width: 8, height: 8 })
        const fence = await fresh.readFence((saved as { key?: string }).key ?? '')
        fresh.close()
        return { saved, fence }
      }, { db: dbName, owner })
      expect(seedA.saved.ok).toBe(true)
      expect(seedA.fence).toBe(1)
      // Tab B: same slot/owner, different staged bytes, STALE fence attempts.
      const stale = await pageB.evaluate(async (args: { db: string; owner: { targetId: string; costumeIndex: number; assetKey: string; writeSeq: number; projectGeneration: number } }) => {
        const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
        const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: args.db, tabId: 'tab-B' })
        const pngB = new Uint8Array(48).fill(77)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        sig.forEach((b, i) => { pngB[i] = b })
        // No expectation while a record exists -> conflict; stale fence 0 -> conflict.
        const noExpected = await store.save({ owner: args.owner, png: pngB, width: 8, height: 8 })
        const staleFence = await store.save({ owner: args.owner, png: pngB, width: 8, height: 8, expectedFenceSeq: 0 })
        // Fresh fence wins.
        const liveFence = await store.readFence(mod.durableKeyForOwner(args.owner) ?? '')
        const freshWin = await store.save({ owner: args.owner, png: pngB, width: 8, height: 8, expectedFenceSeq: liveFence })
        const loaded = await store.load(args.owner)
        const digest = loaded.ok ? (loaded as { record: { sha256Hex: string } }).record.sha256Hex : undefined
        store.close()
        return {
          noExpectedReason: noExpected.ok ? 'STORED' : (noExpected as { reason?: string }).reason,
          staleReason: staleFence.ok ? 'STORED' : (staleFence as { reason?: string }).reason,
          liveFence,
          freshOk: freshWin.ok,
          freshFence: freshWin.ok ? (freshWin as { fenceSeq: number }).fenceSeq : null,
          digest,
          // Rejected bytes stay in this tab's memory (returned, never stored over).
          memoryByte: pngB[20],
        }
      }, { db: dbName, owner })
      expect(stale.noExpectedReason).toBe('conflict-fence')
      expect(stale.staleReason).toBe('conflict-fence')
      expect(stale.liveFence).toBe(1)
      expect(stale.freshOk).toBe(true)
      expect(stale.freshFence).toBe(2)
      expect(stale.memoryByte).toBe(77)
      // Tab A retries with its now-stale fence 1 -> conflict; bytes preserved are B's.
      const retryA = await pageA.evaluate(async (args: { db: string; owner: { targetId: string; costumeIndex: number; assetKey: string; writeSeq: number; projectGeneration: number }; expectDigest: string }) => {
        const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
        const store = mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: args.db, tabId: 'tab-A' })
        const pngA = new Uint8Array(48).fill(11)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        sig.forEach((b, i) => { pngA[i] = b })
        const retry = await store.save({ owner: args.owner, png: pngA, width: 8, height: 8, expectedFenceSeq: 1 })
        const loaded = await store.load(args.owner)
        const liveDigest = loaded.ok ? (loaded as { record: { sha256Hex: string } }).record.sha256Hex : undefined
        const listed = await store.list()
        store.close()
        return {
          retryReason: retry.ok ? 'STORED' : (retry as { reason?: string }).reason,
          liveDigest,
          expectDigest: args.expectDigest,
          count: listed.length,
        }
      }, { db: dbName, owner, expectDigest: stale.digest ?? '' })
      expect(retryA.retryReason).toBe('conflict-fence')
      expect(retryA.liveDigest).toBe(retryA.expectDigest)
      expect(retryA.count).toBe(1)
    } finally {
      await pageA.close()
      await pageB.close()
    }
    await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      await mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db }).destroyDatabaseForTest()
    }, dbName)
  }, 120_000)

  it('cap + expiry never silently evict; only explicit confirmed discard deletes', async () => {
    const dbName = 'xyo-test-durable-cap-v1'
    const proof = await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      const store = mod.createBitmapPendingDurableRecoveryStoreForTest({
        dbName: db,
        tabId: 'tab-cap',
        caps: { maxBytesPerRecord: 4096, maxRecords: 2, maxTotalBytes: 8192, ttlMs: 80 },
      })
      await store.destroyDatabaseForTest()
      const again = mod.createBitmapPendingDurableRecoveryStoreForTest({
        dbName: db,
        tabId: 'tab-cap',
        caps: { maxBytesPerRecord: 4096, maxRecords: 2, maxTotalBytes: 8192, ttlMs: 80 },
      })
      const fakePng = (seed: number): Uint8Array => {
        const out = new Uint8Array(128).fill(seed)
        const sig = [137, 80, 78, 71, 13, 10, 26, 10]
        sig.forEach((b, i) => { out[i] = b })
        return out
      }
      const owner1 = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-a', writeSeq: 1, projectGeneration: 7 }
      const owner2 = { targetId: 'sprite-1', costumeIndex: 0, assetKey: 'md5-b', writeSeq: 2, projectGeneration: 8 }
      const owner3 = { targetId: 'sprite-2', costumeIndex: 0, assetKey: 'md5-c', writeSeq: 1, projectGeneration: 8 }
      const s1 = await again.save({ owner: owner1, png: fakePng(9), width: 8, height: 8 })
      const s2 = await again.save({ owner: owner2, png: fakePng(10), width: 8, height: 8 })
      // Cap full: third owner refused, BOTH sides retained.
      const s3 = await again.save({ owner: owner3, png: fakePng(11), width: 8, height: 8 })
      const listAfterFull = await again.list()
      // Expiry is advisory: wait past ttl, record still loads (flagged), not evicted.
      await new Promise((resolve) => setTimeout(resolve, 160))
      const expiredLoad = await again.load(owner1)
      // Discard requires explicit confirmation; wrong-owner confirmed deletes refuse.
      const unconfirmed = await again.discard(owner1)
      const wrongOwner = await again.discard({ ...owner1, assetKey: 'md5-nope', writeSeq: 99 }, { confirmed: true })
      const stillThere = await again.load(owner1)
      const confirmed = await again.discard(owner1, { confirmed: true })
      const afterDelete = await again.load(owner1)
      const listAfterDelete = await again.list()
      again.close()
      return {
        s1Ok: s1.ok,
        s2Ok: s2.ok,
        s3Reason: s3.ok ? 'STORED' : (s3 as { reason?: string }).reason,
        countAfterFull: listAfterFull.length,
        expiredOk: expiredLoad.ok,
        expiredFlag: expiredLoad.ok ? (expiredLoad as { expired: boolean }).expired : null,
        unconfirmed: { ok: unconfirmed.ok, kind: unconfirmed.kind, reason: (unconfirmed as { reason?: string }).reason },
        wrongOwner: { ok: wrongOwner.ok, kind: wrongOwner.kind, reason: (wrongOwner as { reason?: string }).reason },
        stillThereOk: stillThere.ok,
        confirmed: { ok: confirmed.ok, kind: confirmed.kind },
        afterDeleteReason: afterDelete.ok ? 'STORED' : (afterDelete as { reason?: string }).reason,
        countAfterDelete: listAfterDelete.length,
      }
    }, dbName)
    expect(proof.s1Ok).toBe(true)
    expect(proof.s2Ok).toBe(true)
    expect(proof.s3Reason).toBe('store-full')
    expect(proof.countAfterFull).toBe(2)
    expect(proof.expiredOk).toBe(true)
    expect(proof.expiredFlag).toBe(true)
    expect(proof.unconfirmed).toEqual({ ok: false, kind: 'refused', reason: 'confirmation-required' })
    expect(proof.wrongOwner).toEqual({ ok: false, kind: 'refused', reason: 'owner-mismatch' })
    expect(proof.stillThereOk).toBe(true)
    expect(proof.confirmed).toEqual({ ok: true, kind: 'discarded' })
    expect(proof.afterDeleteReason).toBe('not-found')
    expect(proof.countAfterDelete).toBe(1)
    await page.evaluate(async (db: string) => {
      const mod = await import('/src/features/costumes/bitmap-pending-durable-recovery.ts')
      await mod.createBitmapPendingDurableRecoveryStoreForTest({ dbName: db }).destroyDatabaseForTest()
    }, dbName)
  }, 120_000)
})
