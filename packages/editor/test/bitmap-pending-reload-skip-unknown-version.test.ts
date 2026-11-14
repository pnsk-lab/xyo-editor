import { describe, expect, it } from 'bun:test'
import { ScratchVM, createDefaultProject } from '@hikkaku/vm'
import {
  isVersionedReloadSkipToken,
  normalizeReloadLiveIdentity,
  shouldSkipBitmapCanvasReload,
} from '../src/features/costumes/bitmap-pending-reload-skip'
import { BITMAP_PENDING_UI_ENABLED } from '../src/features/costumes/bitmap-pending-controller'

/**
 * Unknown-version fail-closed audit for `bitmap-pending-reload-skip.ts`.
 *
 * Contract (header): skip only the proven own committed version — same slot,
 * same bytes key, same `writeSeq` (same-byte external writes bump it), same
 * `projectGeneration`, same `selectionEpoch` (away-and-back switch), plus the
 * png gate. Version unknown => fail-closed to reload, never skip a stale
 * canvas. `writeSeq`/`selectionEpoch` are optional on the VM surface
 * (`getCostumeIdentity` / `getSelectionEpoch` may be missing or return
 * unknown), so a `null`/`undefined` version must never authorize a skip.
 *
 * Bug under test: `isVersionedReloadSkipToken` accepts `writeSeq` /
 * `selectionEpoch` `null`/`undefined`, and `shouldSkipBitmapCanvasReload`
 * skips when `token.writeSeq == null` (even with live known + drifted) and
 * when either `selectionEpoch` is unknown. A stale unknown-version token
 * then hides foreign art behind a stale canvas.
 *
 * AGENTS split: pure helper only, no Editor/DOM/VM-history edits. No flag
 * flip (disabled baseline asserted). No AGPL copy: real-VM legs use the
 * in-repo `@hikkaku/vm` public API only.
 */

const baseToken = (over: Record<string, unknown> = {}) => ({
  key: 'targetA:0',
  assetKey: 'md5-aaa',
  writeSeq: 7,
  projectGeneration: 3,
  selectionEpoch: 5,
  ...over,
})

const baseLive = (over: Record<string, unknown> = {}) => ({
  key: 'targetA:0',
  assetKey: 'md5-aaa',
  writeSeq: 7,
  projectGeneration: 3,
  selectionEpoch: 5,
  ...over,
})

function freshVM(): { vm: ScratchVM; tid: string } {
  const vm = new ScratchVM()
  vm.loadProject(createDefaultProject())
  const sprite = vm.getSprites()[0]!
  return { vm, tid: sprite.id as string }
}

const enc = new TextDecoder()

async function bytesOf(vm: ScratchVM, targetId: string, index: number): Promise<string | undefined> {
  const t = vm.getTarget(targetId)
  const c = t?.costumes[index]
  const key = c?.md5ext ?? c?.assetId
  if (!key) return undefined
  const b = await vm.loadAsset(key, c?.dataFormat ?? 'svg')
  return b ? enc.decode(b) : undefined
}

describe('version gate: unknown writeSeq/selectionEpoch never version a token', () => {
  it('null/undefined versions are unversioned (fail-closed)', () => {
    expect(isVersionedReloadSkipToken(baseToken({ writeSeq: null }))).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ writeSeq: undefined }))).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ selectionEpoch: null }))).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ selectionEpoch: undefined }))).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ writeSeq: null, selectionEpoch: null }))).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ writeSeq: undefined, selectionEpoch: undefined }))).toBe(false)
  })

  it('zero is a valid version (fast skip path needs it)', () => {
    expect(isVersionedReloadSkipToken(baseToken({ writeSeq: 0, selectionEpoch: 0 }))).toBe(true)
  })

  it('NaN / non-counter versions never pass', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, '7', true, {}, []]) {
      expect(isVersionedReloadSkipToken(baseToken({ writeSeq: bad }))).toBe(false)
      expect(isVersionedReloadSkipToken(baseToken({ selectionEpoch: bad }))).toBe(false)
    }
  })

  it('legacy key-only tokens still never pass', () => {
    expect(isVersionedReloadSkipToken(undefined)).toBe(false)
    expect(isVersionedReloadSkipToken(baseToken({ assetKey: '' }))).toBe(false)
  })
})

describe('skip matrix: version unknown forces reload (never a stale skip)', () => {
  it('null/undefined token version vs known live reloads', () => {
    for (const over of [
      { writeSeq: null },
      { writeSeq: undefined },
      { selectionEpoch: null },
      { selectionEpoch: undefined },
      { writeSeq: null, selectionEpoch: null },
      { writeSeq: undefined, selectionEpoch: undefined },
    ]) {
      const verdict = shouldSkipBitmapCanvasReload(baseToken(over), undefined, baseLive(), 'png')
      expect(verdict.skip).toBe(false)
      expect(verdict.buffered).toBe(false)
    }
  })

  it('stale unknown-version token cannot hide live known drift (same bytes, bumped seq)', () => {
    // Same-byte external write: identical assetKey, live seq moved.
    const live = baseLive({ writeSeq: 8 })
    for (const over of [{ writeSeq: null }, { writeSeq: undefined }, { selectionEpoch: null }, { selectionEpoch: undefined }]) {
      expect(shouldSkipBitmapCanvasReload(baseToken(over), undefined, live, 'png').skip).toBe(false)
    }
  })

  it('known token vs unknown live version reloads (both directions)', () => {
    for (const liveOver of [
      { writeSeq: null },
      { writeSeq: undefined },
      { selectionEpoch: null },
      { selectionEpoch: undefined },
    ]) {
      const verdict = shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive(liveOver), 'png')
      expect(verdict.skip).toBe(false)
      expect(verdict.buffered).toBe(false)
    }
  })

  it('unknown vs unknown never skips', () => {
    const verdict = shouldSkipBitmapCanvasReload(
      baseToken({ writeSeq: null, selectionEpoch: null }),
      undefined,
      baseLive({ writeSeq: null, selectionEpoch: null }),
      'png',
    )
    expect(verdict.skip).toBe(false)
  })

  it('NaN versions fail closed, zero versions still skip on exact match', () => {
    expect(shouldSkipBitmapCanvasReload(baseToken({ writeSeq: Number.NaN }), undefined, baseLive(), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive({ writeSeq: Number.NaN }), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken({ selectionEpoch: Number.NaN }), undefined, baseLive(), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive({ selectionEpoch: Number.NaN }), 'png').skip).toBe(false)
    // Exact zero match is a real version: proven own write still fast-skips.
    const zero = baseLive({ writeSeq: 0, selectionEpoch: 0 })
    expect(shouldSkipBitmapCanvasReload(baseToken({ writeSeq: 0, selectionEpoch: 0 }), undefined, zero, 'png')).toEqual({
      skip: true,
      buffered: false,
      reason: 'own-committed-version',
    })
  })

  it('shouldSkip is pure: unknown-version verdict mutates nothing', () => {
    const token = baseToken({ writeSeq: null })
    const live = baseLive({ writeSeq: 8 })
    const frozenToken = structuredClone(token)
    const frozenLive = structuredClone(live)
    const verdict = shouldSkipBitmapCanvasReload(token, undefined, live, 'png')
    expect(verdict.skip).toBe(false)
    expect(token).toEqual(frozenToken)
    expect(live).toEqual(frozenLive)
  })

  it('valid versioned match still fast-skips exactly once (no regression)', () => {
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive(), 'png')
    expect(verdict).toEqual({ skip: true, buffered: false, reason: 'own-committed-version' })
  })

  it('barrier still buffers (unknown version never skips through the flight)', () => {
    const live = baseLive()
    const barrier = {
      key: live.key,
      baseAssetKey: live.assetKey,
      baseWriteSeq: live.writeSeq,
      projectGeneration: live.projectGeneration,
      selectionEpoch: live.selectionEpoch,
    }
    const verdict = shouldSkipBitmapCanvasReload(baseToken({ writeSeq: null }), undefined, live, 'png')
    expect(verdict.skip).toBe(false)
    const held = shouldSkipBitmapCanvasReload(baseToken({ writeSeq: null }), barrier, live, 'png')
    expect(held.skip).toBe(false)
    expect(held.buffered).toBe(true)
  })
})

describe('normalize: unknown VM versions become null and then fail closed', () => {
  it('missing/invalid VM fields normalize to null or undefined-live', () => {
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 'x', projectGeneration: 0 })?.writeSeq).toBe(null)
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 'x', projectGeneration: 0 })?.selectionEpoch).toBe(null)
    // Invalid counters (NaN) normalize to undefined-live: also fail-closed.
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 'x', projectGeneration: 0, writeSeq: Number.NaN })).toBeUndefined()
    expect(normalizeReloadLiveIdentity(undefined)).toBeUndefined()
  })

  it('mocked unknown optional VM surface (missing fns) forces reload', () => {
    // Older/partial VM without the optional version readers: Editor maps the
    // missing reads to null versions; the skip must fail closed.
    const vmLike: { getCostumeIdentity?: unknown; getSelectionEpoch?: unknown } = {}
    const writeSeq = typeof vmLike.getCostumeIdentity === 'function' ? 7 : null
    const selectionEpoch = typeof vmLike.getSelectionEpoch === 'function' ? 5 : null
    const live = baseLive({ writeSeq, selectionEpoch })
    expect(shouldSkipBitmapCanvasReload(baseToken({ writeSeq: null }), undefined, live, 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, live, 'png').skip).toBe(false)
  })

  it('mocked throwing VM readers fail closed to live-unknown', () => {
    const throwing = {
      getCostumeIdentity: () => {
        throw new Error('no identity')
      },
      getSelectionEpoch: () => {
        throw new Error('no epoch')
      },
    }
    let live: ReturnType<typeof normalizeReloadLiveIdentity>
    try {
      live = normalizeReloadLiveIdentity(throwing.getCostumeIdentity())
    } catch {
      live = undefined
    }
    void throwing
    expect(live).toBeUndefined()
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, live, 'png').reason).toBe('live-unknown')
  })
})

describe('real VM: same asset + external metadata write is never hidden by a stale token', () => {
  it('rename keeps bytes, bumps writeSeq; stale unknown-version token must reload, valid token skips, nothing deleted', async () => {
    const { vm, tid } = freshVM()
    const before = vm.getCostumeIdentity(tid, 0)!
    const bytesBefore = await bytesOf(vm, tid, 0)
    expect(before.md5ext).toBeDefined()
    const costumeCountBefore = vm.getTarget(tid)?.costumes.length

    expect(vm.renameCostume(tid, 0, `ext-meta-${Date.now() % 100000}`)).toBe(true)
    const after = vm.getCostumeIdentity(tid, 0)!
    // Same stored bytes, strictly bumped version: the exact hole the stale
    // skip hides when it ignores the version.
    expect(after.md5ext).toBe(before.md5ext)
    expect(after.assetId).toBe(before.assetId)
    expect((after.writeSeq as number)).toBeGreaterThan(before.writeSeq as number)
    expect(await bytesOf(vm, tid, 0)).toBe(bytesBefore)

    const liveOf = (identity: { md5ext?: unknown; assetId?: unknown; writeSeq?: unknown }) => ({
      key: `${tid}:0`,
      assetKey: (identity.md5ext as string) ?? (identity.assetId as string) ?? '',
      writeSeq: typeof identity.writeSeq === 'number' ? (identity.writeSeq as number) : null,
      projectGeneration: 0,
      selectionEpoch: 0,
    })

    // Stale token armed without a version (unknown) must NOT skip the live
    // reload even though the bytes key matches: the rename bump is the signal.
    const staleToken = { ...liveOf(after), writeSeq: null, selectionEpoch: null }
    const staleVerdict = shouldSkipBitmapCanvasReload(staleToken, undefined, liveOf(after), 'png')
    expect(staleVerdict.skip).toBe(false)

    // Proven own version (fresh live re-read after the write) still skips.
    const provenVerdict = shouldSkipBitmapCanvasReload(liveOf(after), undefined, liveOf(after), 'png')
    expect(provenVerdict.skip).toBe(true)

    // No delete/resurrection: same slot, same bytes, same count survive.
    expect(vm.getTarget(tid)?.costumes.length).toBe(costumeCountBefore)
    expect(vm.getCostumeIdentity(tid, 0)?.md5ext).toBe(after.md5ext)
    expect(await bytesOf(vm, tid, 0)).toBe(bytesBefore)
  })
})

describe('disabled baseline: pending flag stays off, no prod bypass', () => {
  it('BITMAP_PENDING_UI_ENABLED remains false on disk', () => {
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
  })
})
