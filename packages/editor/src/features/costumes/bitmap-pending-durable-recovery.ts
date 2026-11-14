/**
 * Isolated opt-in test-only durable recovery store for the PNG quarantine (B-3).
 *
 * Focused feature helper (AGENTS split): the ONLY durable-storage surface for
 * the bitmap pending path. It persists quarantined `base + shape` PNG bytes
 * across reload/navigation so a `beforeunload`-armed close does not silently
 * lose staged work. It is NOT wired to any product UI:
 *
 * - Production gate: `BITMAP_PENDING_DURABLE_RECOVERY_ENABLED` is `false`.
 *   The product shell component never imports this module (pinned by test);
 *   the only constructor is `createBitmapPendingDurableRecoveryStoreForTest`,
 *   which requires an explicit in-process call. There is no storage / URL /
 *   env bypass anywhere in this file.
 * - Never auto-applies: this module imports NOTHING from the VM, canvas,
 *   history, session, controller, or product-shell layers. It performs no
 *   store writes, no canvas pixel writes, and no history appends. Reads return
 *   detached copies for VISIBLE export (`exportPng`) and deletion requires
 *   (`discard(..., { confirmed: true })`). Applying bytes stays the caller's
 *   user-confirmed decision.
 * - Privacy / security: records live in IndexedDB as binary `Uint8Array`
 *   (structured clone, never base64 in ambient web storage). Same-origin only,
 *   no network (fetch / XHR / socket / beacon delivery all absent by audit),
 *   no logging of bytes, explicit confirmed discard deletes the key.
 * - Data integrity: every record is self-contained (PNG bytes + dimensions +
 *   format + identity + metadata) with a SHA-256 digest (`crypto.subtle`,
 *   no new deps, no copied third-party code). Loads re-hash and refuse with
 *   `digest-mismatch` instead of returning corrupt bytes.
 * - Bounded: per-record byte cap, record-count cap, total-byte cap. Oversize
 *   or full stores REFUSE with an explicit reason; the caller's in-memory
 *   pending is untouched (retained) and no fake "saved" status is produced.
 *   Quota failures surface as `quota-exceeded`, never as silent success.
 * - Identity: `targetId + costumeIndex + assetKey (+ writeSeq when known) +
 *   projectGeneration`. The store KEY embeds `projectGeneration`, so a
 *   same-name project replacement (ids reused, generation moved) never
 *   restores onto the wrong owner. `load`/`exportPng` additionally require a
 *   full owner match; stale bytes report `owner-mismatch` and are never
 *   returned as usable.
 * - Expiration / cap never silently evict: records are NEVER auto-deleted
 *   (no TTL sweeper, no LRU). `load` reports `expired: true` past `ttlMs`
 *   but still returns the bytes; only explicit confirmed `discard` deletes.
 *   A full store refuses the new write (`store-full`) and keeps every
 *   existing record: both retained, caller decides.
 * - Concurrent tabs: same-transaction read-modify-write fencing. Each record
 *   carries a monotonic `fenceSeq`; writers pass `expectedFenceSeq` and a
 *   stale expectation loses with `conflict-fence` (rejected bytes stay in the
 *   caller's memory, nothing overwritten). Retrying re-reads the fence.
 * - Encode discipline: `save` only accepts already-encoded non-empty bytes.
 *   A failed async encode means `save` is never called, so `beforeunload`
 *   state stays armed and no fake saved status exists. Empty input is refused
 *   (`invalid-png`), never stored.
 *
 * Persistence guarantee (actual, browser-defined): IndexedDB SURVIVES reload
 * and navigation in the same origin/profile, but the browser MAY evict it
 * under storage pressure, in private modes, or on explicit user clearing.
 * This store is therefore best-effort recovery export, NOT a promise of
 * durability: `beforeunload`/`pagehide` retain-only guards remain required,
 * and the UI must never claim "saved" from a durable write.
 *
 * Architectural remaining requirements (NOT implemented here, needed before
 * any production wiring):
 * 1. Product wiring does not exist: no product-shell / paint-view call
 *    sites, no lifecycle (`beforeunload`/`pagehide`) hook into this store,
 *    no recovery banner UI (visible export / confirmed discard buttons).
 * 2. Quarantine -> store handoff is unowned: the session quarantine holds
 *    `ImageData` bases, this store needs PNG bytes; the encode + ownership
 *    snapshot must happen synchronously at quarantine time (else the canvas
 *    may already belong to a new owner). No such bridge exists yet.
 * 3. No recovery-application path by design: a user-confirmed "restore"
 *    that re-stages bytes onto the RIGHT owner (generation/sequence checked
 *    at click time) still needs design + tests; this module only exports.
 * 4. Eviction UX: `quota-exceeded` / `store-full` currently only refuse;
 *    product copy guiding the user (free space / discard old recovery)
 *    does not exist.
 * 5. Cross-profile/private-mode behavior is browser-defined and untested
 *    beyond the same-profile reload leg in the browser test.
 */

export const BITMAP_PENDING_DURABLE_RECOVERY_ENABLED = false as const

/** Stored-record schema version. Unknown versions refuse (`unknown-version`). */
export const DURABLE_RECOVERY_RECORD_VERSION = 1 as const

/** IndexedDB database version for the recovery database. */
export const DURABLE_RECOVERY_DB_VERSION = 1 as const

/** Default database name (tests override with an isolated name per run). */
export const DURABLE_RECOVERY_DB_NAME = 'xyo-bitmap-pending-durable-recovery'

/** Default object-store name. */
export const DURABLE_RECOVERY_STORE_NAME = 'png-quarantine'

function defaultTabId(): string {
  try {
    const scope = globalThis as { crypto?: { randomUUID?: () => string } }
    const uuid = scope.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid.length > 0) return `tab-${uuid}`
  } catch {
    // Fall through to the counter fallback below.
  }
  return `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff_ffff).toString(36)}`
}

export type DurableRecoveryCaps = {
  /** Refuse any single PNG larger than this (bytes). */
  maxBytesPerRecord: number
  /** Refuse new keys once this many records exist. */
  maxRecords: number
  /** Refuse writes that would push stored bytes past this total. */
  maxTotalBytes: number
  /** Advisory TTL (ms); expiry is REPORTED, never auto-deleted. */
  ttlMs: number
}

export const DEFAULT_DURABLE_RECOVERY_CAPS: DurableRecoveryCaps = {
  maxBytesPerRecord: 6 * 1024 * 1024,
  maxRecords: 4,
  maxTotalBytes: 12 * 1024 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
}

export type DurableRecoveryOwner = {
  /** Stable target id (never a display-name alias). */
  targetId: string
  costumeIndex: number
  /** Stored-bytes key at quarantine time (`md5ext ?? assetId`). */
  assetKey: string
  assetId?: string | null
  /** Monotonic per-slot version at quarantine time (when known). */
  writeSeq?: number | null
  /** Whole-project generation at quarantine time (when known). */
  projectGeneration?: number | null
}

export type DurableRecoverySaveInput = {
  owner: DurableRecoveryOwner
  /** Already-encoded PNG bytes (non-empty; encode failure => never call). */
  png: Uint8Array
  width: number
  height: number
  format?: string
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
  /**
   * CAS expectation: the `fenceSeq` observed via `readFence`/`load`. `null`
   * (default) means "no record expected yet"; a stale number loses with
   * `conflict-fence` and nothing is overwritten.
   */
  expectedFenceSeq?: number | null
}

export type DurableRecoverySaveResult =
  | { ok: true; key: string; sha256Hex: string; fenceSeq: number }
  | { ok: false; reason: string; detail?: string }

export type DurableRecoveryRecordView = {
  key: string
  owner: DurableRecoveryOwner
  png: Uint8Array
  width: number
  height: number
  format: string
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
  sha256Hex: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  fenceSeq: number
}

export type DurableRecoveryLoadResult =
  | { ok: true; record: DurableRecoveryRecordView; expired: boolean }
  | { ok: false; reason: string; detail?: string }

export type DurableRecoveryListEntry = {
  key: string
  targetId: string
  costumeIndex: number
  assetKey: string
  writeSeq: number | null
  projectGeneration: number | null
  bytes: number
  sha256Hex: string
  expired: boolean
  fenceSeq: number
}

export type DurableRecoveryStoreOptions = {
  dbName?: string
  storeName?: string
  caps?: Partial<DurableRecoveryCaps>
  /** Owning-tab label recorded on each write (concurrent-tab fencing). */
  tabId?: string
  /** Injectable factory for forced-failure tests (defaults to global IDB). */
  idb?: IDBFactory | null | undefined
  subtle?: SubtleCrypto | null | undefined
  now?: () => number
}

type StoredDurableRecord = {
  version: number
  key: string
  targetId: string
  costumeIndex: number
  assetKey: string
  assetId: string | null
  writeSeq: number | null
  projectGeneration: number | null
  png: Uint8Array
  width: number
  height: number
  format: string
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
  sha256Hex: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  fenceSeq: number
  ownerTabId: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Store key embeds the project generation: same ids + new project = new key. */
export function durableKeyForOwner(owner: DurableRecoveryOwner): string | undefined {
  try {
    if (!owner || !isNonEmptyString(owner.targetId)) return undefined
    if (!Number.isInteger(owner.costumeIndex) || owner.costumeIndex < 0) return undefined
    if (!isNonEmptyString(owner.assetKey)) return undefined
    const gen = owner.projectGeneration
    const genPart =
      typeof gen === 'number' && Number.isInteger(gen) && gen >= 0 ? String(gen) : 'unknown-gen'
    return `${owner.targetId}\u001f${owner.costumeIndex}\u001f${genPart}`
  } catch {
    return undefined
  }
}

function normalizeOwner(owner: DurableRecoveryOwner): DurableRecoveryOwner | undefined {
  try {
    if (!owner || !isNonEmptyString(owner.targetId)) return undefined
    if (!Number.isInteger(owner.costumeIndex) || owner.costumeIndex < 0) return undefined
    if (!isNonEmptyString(owner.assetKey)) return undefined
    const writeSeq =
      typeof owner.writeSeq === 'number' && Number.isInteger(owner.writeSeq) && owner.writeSeq >= 0
        ? owner.writeSeq
        : null
    const projectGeneration =
      typeof owner.projectGeneration === 'number' &&
      Number.isInteger(owner.projectGeneration) &&
      owner.projectGeneration >= 0
        ? owner.projectGeneration
        : null
    return {
      targetId: owner.targetId,
      costumeIndex: owner.costumeIndex,
      assetKey: owner.assetKey,
      assetId: typeof owner.assetId === 'string' ? owner.assetId : null,
      writeSeq,
      projectGeneration,
    }
  } catch {
    return undefined
  }
}

/**
 * Full owner match for `load`/`exportPng`: same slot AND same stored bytes
 * AND same project generation. Same-name projects (ids reused, generation
 * moved) and same-slot external writes (assetKey/writeSeq drift) NEVER match:
 * the caller gets `owner-mismatch` and no bytes.
 */
export function isDurableOwnerMatch(
  record: Pick<
    StoredDurableRecord,
    'targetId' | 'costumeIndex' | 'assetKey' | 'writeSeq' | 'projectGeneration'
  >,
  owner: DurableRecoveryOwner,
): { match: boolean; reason: string } {
  if (!owner || owner.targetId !== record.targetId) return { match: false, reason: 'target-mismatch' }
  if (owner.costumeIndex !== record.costumeIndex) return { match: false, reason: 'slot-mismatch' }
  if (!isNonEmptyString(owner.assetKey) || owner.assetKey !== record.assetKey) {
    return { match: false, reason: 'bytes-mismatch' }
  }
  const wantSeq =
    typeof owner.writeSeq === 'number' && Number.isInteger(owner.writeSeq) && owner.writeSeq >= 0
      ? owner.writeSeq
      : null
  if (wantSeq !== null && record.writeSeq !== null && wantSeq !== record.writeSeq) {
    return { match: false, reason: 'seq-mismatch' }
  }
  const wantGen =
    typeof owner.projectGeneration === 'number' &&
    Number.isInteger(owner.projectGeneration) &&
    owner.projectGeneration >= 0
      ? owner.projectGeneration
      : null
  if (wantGen !== null && record.projectGeneration !== null && wantGen !== record.projectGeneration) {
    return { match: false, reason: 'generation-mismatch' }
  }
  return { match: true, reason: 'owner-match' }
}

export function isDurableRecordExpired(record: { expiresAt: number }, nowMs: number): boolean {
  try {
    if (!Number.isFinite(nowMs) || !Number.isFinite(record.expiresAt)) return false
    return nowMs >= record.expiresAt
  } catch {
    return false
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0
    out += (byte < 16 ? '0' : '') + byte.toString(16)
  }
  return out
}

/** SHA-256 hex over every byte (SubtleCrypto; no third-party code). */
export async function computeDurableSha256Hex(
  png: Uint8Array,
  subtle?: SubtleCrypto | null | undefined,
): Promise<string | undefined> {
  try {
    const cryptoSubtle =
      subtle ??
      (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle ??
      null
    if (!cryptoSubtle || typeof cryptoSubtle.digest !== 'function') return undefined
    const copy = new Uint8Array(png.byteLength)
    copy.set(png)
    const digest = await cryptoSubtle.digest(
      'SHA-256',
      copy.buffer as unknown as ArrayBuffer,
    )
    return bytesToHex(new Uint8Array(digest))
  } catch {
    return undefined
  }
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      try {
        request.transaction?.abort()
      } catch {
        // Best effort only.
      }
      reject(request.error ?? new Error('indexeddb-request-failed'))
    }
  })
}

function isQuotaError(error: unknown): boolean {
  try {
    const record = error as { name?: unknown; code?: unknown } | null | undefined
    if (!record || typeof record !== 'object') return false
    if (record.name === 'QuotaExceededError') return true
    // Legacy DOMException code for quota (22) — explicit, no silent mapping.
    if (record.code === 22) return true
    return false
  } catch {
    return false
  }
}

function resolveIdb(options: DurableRecoveryStoreOptions): IDBFactory | undefined {
  try {
    if (options.idb !== undefined && options.idb !== null) return options.idb
  } catch {
    return undefined
  }
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    return typeof factory?.open === 'function' ? factory : undefined
  } catch {
    return undefined
  }
}

export type BitmapPendingDurableRecoveryStore = {
  readonly tabId: string
  readonly caps: DurableRecoveryCaps
  save: (input: DurableRecoverySaveInput) => Promise<DurableRecoverySaveResult>
  load: (owner: DurableRecoveryOwner) => Promise<DurableRecoveryLoadResult>
  exportPng: (owner: DurableRecoveryOwner) => Promise<Uint8Array | undefined>
  list: () => Promise<DurableRecoveryListEntry[]>
  readFence: (key: string) => Promise<number | null>
  discard: (
    owner: DurableRecoveryOwner,
    options?: { confirmed?: boolean },
  ) => Promise<{ ok: boolean; kind: string; reason?: string }>
  close: () => void
  destroyDatabaseForTest: () => Promise<void>
}

/**
 * Explicit opt-in constructor for tests. Calling it IS the opt-in: there is
 * no global init, no side effect on import, and production code never calls
 * it (no product-shell import; production gate stays `false`).
 */
export function createBitmapPendingDurableRecoveryStoreForTest(
  options: DurableRecoveryStoreOptions = {},
): BitmapPendingDurableRecoveryStore {
  const dbName =
    typeof options.dbName === 'string' && options.dbName.length > 0
      ? options.dbName
      : DURABLE_RECOVERY_DB_NAME
  const storeName =
    typeof options.storeName === 'string' && options.storeName.length > 0
      ? options.storeName
      : DURABLE_RECOVERY_STORE_NAME
  const caps: DurableRecoveryCaps = {
    ...DEFAULT_DURABLE_RECOVERY_CAPS,
    ...(options.caps ?? {}),
  }
  const tabId =
    typeof options.tabId === 'string' && options.tabId.length > 0
      ? options.tabId
      : defaultTabId()
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const subtle =
    options.subtle !== undefined
      ? (options.subtle ?? null)
      : ((globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle ?? null)
  let db: IDBDatabase | undefined

  function quotaDetail(error: unknown): string {
    if (error instanceof Error && error.message) return error.message.slice(0, 200)
    try {
      return String(error).slice(0, 200)
    } catch {
      return 'quota failure'
    }
  }

  async function open(): Promise<IDBDatabase> {
    if (db) return db
    const factory = resolveIdb(options)
    if (!factory) throw new Error('storage-unavailable')
    const database: IDBDatabase = await new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest
      try {
        request = factory.open(dbName, DURABLE_RECOVERY_DB_VERSION)
      } catch (error) {
        reject(error)
        return
      }
      request.onupgradeneeded = () => {
        try {
          const target = request.result
          if (!target.objectStoreNames.contains(storeName)) {
            target.createObjectStore(storeName, { keyPath: 'key' })
          }
        } catch (error) {
          reject(error)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexeddb-open-failed'))
      request.onblocked = () => {
        // Another tab holds the old version open: refuse rather than hang.
        try {
          request.result?.close()
        } catch {
          // Best effort only.
        }
        reject(new Error('indexeddb-open-blocked'))
      }
    })
    try {
      database.onversionchange = () => {
        try {
          database.close()
        } catch {
          // Best effort only.
        }
        if (db === database) db = undefined
      }
    } catch {
      // Best effort only.
    }
    db = database
    return database
  }

  function viewOf(stored: StoredDurableRecord): DurableRecoveryRecordView {
    const pngCopy = new Uint8Array(stored.png.byteLength)
    try {
      pngCopy.set(stored.png)
    } catch {
      // Byte copy failure is digest-relevant: fall through; digest check below
      // still guards. (Length preserved; content best-effort.)
    }
    return {
      key: stored.key,
      owner: {
        targetId: stored.targetId,
        costumeIndex: stored.costumeIndex,
        assetKey: stored.assetKey,
        assetId: stored.assetId,
        writeSeq: stored.writeSeq,
        projectGeneration: stored.projectGeneration,
      },
      png: pngCopy,
      width: stored.width,
      height: stored.height,
      format: stored.format,
      bitmapResolution: stored.bitmapResolution,
      rotationCenterX: stored.rotationCenterX,
      rotationCenterY: stored.rotationCenterY,
      sha256Hex: stored.sha256Hex,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      expiresAt: stored.expiresAt,
      fenceSeq: stored.fenceSeq,
    }
  }

  async function save(input: DurableRecoverySaveInput): Promise<DurableRecoverySaveResult> {
    try {
      const owner = normalizeOwner(input?.owner as DurableRecoveryOwner)
      if (!owner) return { ok: false, reason: 'invalid-owner' }
      const key = durableKeyForOwner(owner)
      if (!key) return { ok: false, reason: 'invalid-owner' }
      const png = input?.png
      if (!(png instanceof Uint8Array) || png.byteLength === 0) {
        // Failed async encode must surface here, never as stored bytes: the
        // caller keeps its in-memory pending and `beforeunload` stays armed.
        return { ok: false, reason: 'invalid-png', detail: 'encode missing or empty; save never attempted' }
      }
      if (!Number.isSafeInteger(input?.width) || (input.width as number) <= 0) {
        return { ok: false, reason: 'invalid-png', detail: 'width missing' }
      }
      if (!Number.isSafeInteger(input?.height) || (input.height as number) <= 0) {
        return { ok: false, reason: 'invalid-png', detail: 'height missing' }
      }
      if (png.byteLength > caps.maxBytesPerRecord) {
        return {
          ok: false,
          reason: 'payload-too-large',
          detail: `png ${png.byteLength} bytes exceeds cap ${caps.maxBytesPerRecord}; in-memory pending retained`,
        }
      }
      const format =
        typeof input.format === 'string' && input.format.length > 0 ? input.format : 'png'
      if (format !== 'png') return { ok: false, reason: 'invalid-png', detail: 'only png quarantines persist' }
      const expected =
        input.expectedFenceSeq === undefined || input.expectedFenceSeq === null
          ? null
          : input.expectedFenceSeq
      if (expected !== null && (!Number.isInteger(expected) || expected < 0)) {
        return { ok: false, reason: 'invalid-fence' }
      }
      const sha256Hex = await computeDurableSha256Hex(png, subtle)
      if (!sha256Hex) {
        return { ok: false, reason: 'digest-unavailable', detail: 'SHA-256 unavailable; refusing undigested write' }
      }
      const database = await open()
      const tx = database.transaction(storeName, 'readwrite')
      const store = tx.objectStore(storeName)
      const existing = (await idbRequest(store.get(key))) as StoredDurableRecord | undefined
      if (existing !== undefined && existing !== null) {
        if (typeof existing.version !== 'number' || existing.version !== DURABLE_RECOVERY_RECORD_VERSION) {
          return { ok: false, reason: 'unknown-version', detail: 'existing record version unreadable; refusing overwrite' }
        }
        const currentFence = typeof existing.fenceSeq === 'number' ? existing.fenceSeq : 0
        if (expected === null || expected !== currentFence) {
          // Concurrent-tab fencing: stale expectation loses; rejected bytes
          // stay in the caller's memory, nothing overwritten.
          return {
            ok: false,
            reason: 'conflict-fence',
            detail: `stale fence (expected ${expected === null ? 'none' : String(expected)}, live ${currentFence}); retry after readFence`,
          }
        }
      } else if (expected !== null) {
        // Expected a record that is gone (confirmed discard elsewhere): the
        // write is stale, not a fresh insert.
        return { ok: false, reason: 'conflict-fence', detail: 'expected record missing; re-read before writing' }
      }
      // Bounded count + total bytes (new keys only consume the count cap;
      // same-key rewrites re-check the total against the other records).
      const allKeys = (await idbRequest(store.getAllKeys())) as unknown[]
      const isNewKey = existing === undefined || existing === null
      if (isNewKey && allKeys.length >= caps.maxRecords) {
        return {
          ok: false,
          reason: 'store-full',
          detail: `record cap ${caps.maxRecords} reached; both retained, explicit discard required`,
        }
      }
      if (isNewKey) {
        const all = (await idbRequest(
          store.getAll(),
        )) as StoredDurableRecord[] | undefined
        let total = 0
        try {
          for (const entry of all ?? []) {
            const size = (entry?.png as Uint8Array | undefined)?.byteLength
            if (typeof size === 'number' && Number.isFinite(size)) total += size
          }
        } catch {
          return { ok: false, reason: 'storage-unavailable' }
        }
        if (total + png.byteLength > caps.maxTotalBytes) {
          return {
            ok: false,
            reason: 'store-full',
            detail: `total cap ${caps.maxTotalBytes} bytes exceeded; both retained, explicit discard required`,
          }
        }
      }
      const at = now()
      const previousFence =
        existing !== undefined && existing !== null && typeof existing.fenceSeq === 'number'
          ? existing.fenceSeq
          : 0
      const stored: StoredDurableRecord = {
        version: DURABLE_RECOVERY_RECORD_VERSION,
        key,
        targetId: owner.targetId,
        costumeIndex: owner.costumeIndex,
        assetKey: owner.assetKey,
        assetId: owner.assetId ?? null,
        writeSeq: owner.writeSeq ?? null,
        projectGeneration: owner.projectGeneration ?? null,
        png: (() => {
          const copy = new Uint8Array(png.byteLength)
          copy.set(png)
          return copy
        })(),
        width: input.width,
        height: input.height,
        format,
        bitmapResolution:
          typeof input.bitmapResolution === 'number' ? input.bitmapResolution : undefined,
        rotationCenterX:
          typeof input.rotationCenterX === 'number' ? input.rotationCenterX : undefined,
        rotationCenterY:
          typeof input.rotationCenterY === 'number' ? input.rotationCenterY : undefined,
        sha256Hex,
        createdAt:
          existing !== undefined && existing !== null && typeof existing.createdAt === 'number'
            ? existing.createdAt
            : at,
        updatedAt: at,
        expiresAt: at + caps.ttlMs,
        fenceSeq: previousFence + 1,
        ownerTabId: tabId,
      }
      await idbRequest(store.put(stored))
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('indexeddb-commit-failed'))
        tx.onabort = () => reject(tx.error ?? new Error('indexeddb-commit-aborted'))
      })
      return { ok: true, key, sha256Hex, fenceSeq: stored.fenceSeq }
    } catch (error) {
      if (isQuotaError(error)) {
        return { ok: false, reason: 'quota-exceeded', detail: quotaDetail(error) }
      }
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'storage-unavailable' || message === 'indexeddb-open-blocked') {
        return { ok: false, reason: 'storage-unavailable', detail: message }
      }
      return { ok: false, reason: 'storage-unavailable', detail: quotaDetail(error) }
    }
  }

  async function load(owner: DurableRecoveryOwner): Promise<DurableRecoveryLoadResult> {
    try {
      const normalized = normalizeOwner(owner)
      if (!normalized) return { ok: false, reason: 'invalid-owner' }
      const key = durableKeyForOwner(normalized)
      if (!key) return { ok: false, reason: 'invalid-owner' }
      const database = await open()
      const tx = database.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const stored = (await idbRequest(store.get(key))) as StoredDurableRecord | undefined
      if (stored === undefined || stored === null) return { ok: false, reason: 'not-found' }
      if (stored.version !== DURABLE_RECOVERY_RECORD_VERSION) {
        // Unknown schema: never auto-apply, never migrate silently.
        return { ok: false, reason: 'unknown-version' }
      }
      const match = isDurableOwnerMatch(stored, normalized)
      if (!match.match) return { ok: false, reason: 'owner-mismatch', detail: match.reason }
      if (!(stored.png instanceof Uint8Array) || stored.png.byteLength === 0) {
        return { ok: false, reason: 'digest-mismatch', detail: 'stored bytes missing' }
      }
      const recomputed = await computeDurableSha256Hex(stored.png, subtle)
      if (!recomputed || recomputed !== stored.sha256Hex) {
        // Corrupt at rest: report, keep the record (no silent evict), no bytes.
        return { ok: false, reason: 'digest-mismatch' }
      }
      const view = viewOf(stored)
      return { ok: true, record: view, expired: isDurableRecordExpired(stored, now()) }
    } catch (error) {
      if (isQuotaError(error)) return { ok: false, reason: 'quota-exceeded', detail: quotaDetail(error) }
      return { ok: false, reason: 'storage-unavailable', detail: quotaDetail(error) }
    }
  }

  async function exportPng(owner: DurableRecoveryOwner): Promise<Uint8Array | undefined> {
    try {
      const result = await load(owner)
      if (!result.ok) return undefined
      const copy = new Uint8Array(result.record.png.byteLength)
      copy.set(result.record.png)
      return copy
    } catch {
      return undefined
    }
  }

  async function list(): Promise<DurableRecoveryListEntry[]> {
    try {
      const database = await open()
      const tx = database.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const all = (await idbRequest(store.getAll())) as StoredDurableRecord[] | undefined
      const at = now()
      const entries: DurableRecoveryListEntry[] = []
      for (const stored of all ?? []) {
        try {
          if (!stored || typeof stored.key !== 'string') continue
          entries.push({
            key: stored.key,
            targetId: typeof stored.targetId === 'string' ? stored.targetId : '',
            costumeIndex: typeof stored.costumeIndex === 'number' ? stored.costumeIndex : -1,
            assetKey: typeof stored.assetKey === 'string' ? stored.assetKey : '',
            writeSeq: typeof stored.writeSeq === 'number' ? stored.writeSeq : null,
            projectGeneration:
              typeof stored.projectGeneration === 'number' ? stored.projectGeneration : null,
            bytes: (stored.png as Uint8Array | undefined)?.byteLength ?? 0,
            sha256Hex: typeof stored.sha256Hex === 'string' ? stored.sha256Hex : '',
            expired: isDurableRecordExpired(stored, at),
            fenceSeq: typeof stored.fenceSeq === 'number' ? stored.fenceSeq : 0,
          })
        } catch {
          // Skip unreadable entries; never fail the whole listing.
        }
      }
      return entries
    } catch {
      return []
    }
  }

  async function readFence(key: string): Promise<number | null> {
    try {
      if (!isNonEmptyString(key)) return null
      const database = await open()
      const tx = database.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const stored = (await idbRequest(store.get(key))) as StoredDurableRecord | undefined
      if (stored === undefined || stored === null) return null
      return typeof stored.fenceSeq === 'number' ? stored.fenceSeq : 0
    } catch {
      return null
    }
  }

  async function discard(
    owner: DurableRecoveryOwner,
    options?: { confirmed?: boolean },
  ): Promise<{ ok: boolean; kind: string; reason?: string }> {
    try {
      if (options?.confirmed !== true) {
        // Explicit refusal: without confirmation the recovery is kept.
        return { ok: false, kind: 'refused', reason: 'confirmation-required' }
      }
      const normalized = normalizeOwner(owner)
      if (!normalized) return { ok: false, kind: 'refused', reason: 'invalid-owner' }
      const key = durableKeyForOwner(normalized)
      if (!key) return { ok: false, kind: 'refused', reason: 'invalid-owner' }
      const database = await open()
      const tx = database.transaction(storeName, 'readwrite')
      const store = tx.objectStore(storeName)
      const stored = (await idbRequest(store.get(key))) as StoredDurableRecord | undefined
      if (stored === undefined || stored === null) return { ok: true, kind: 'nothing-pending' }
      const match = isDurableOwnerMatch(stored, normalized)
      if (!match.match) {
        // Never delete another owner's recovery via a mismatched identity.
        return { ok: false, kind: 'refused', reason: 'owner-mismatch' }
      }
      await idbRequest(store.delete(key))
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('indexeddb-commit-failed'))
        tx.onabort = () => reject(tx.error ?? new Error('indexeddb-commit-aborted'))
      })
      return { ok: true, kind: 'discarded' }
    } catch (error) {
      if (isQuotaError(error)) return { ok: false, kind: 'refused', reason: 'quota-exceeded' }
      return { ok: false, kind: 'refused', reason: 'storage-unavailable' }
    }
  }

  function close(): void {
    try {
      db?.close()
    } catch {
      // Best effort only.
    }
    db = undefined
  }

  async function destroyDatabaseForTest(): Promise<void> {
    close()
    const factory = resolveIdb(options)
    if (!factory || typeof factory.deleteDatabase !== 'function') return
    await new Promise<void>((resolve) => {
      try {
        const request = factory.deleteDatabase(dbName)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  return { tabId, caps, save, load, exportPng, list, readFence, discard, close, destroyDatabaseForTest }
}
