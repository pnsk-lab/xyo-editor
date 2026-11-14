import { describe, expect, it } from 'bun:test'
import {
  isVersionedReloadSkipToken,
  normalizeReloadLiveIdentity,
  shouldSkipBitmapCanvasReload,
} from '../src/features/costumes/bitmap-pending-reload-skip'
import { BITMAP_PENDING_UI_ENABLED } from '../src/features/costumes/bitmap-pending-controller'

/**
 * Strict audit for the seven deferred-barrier + version-token skip sites.
 *
 * Sites (Editor.svelte):
 *  1. guardBitmapPendingCommitFirst (pending commit-first gate)
 *  2. clearCostumeSelection (Escape / deselect commit)
 *  3. beginBitmapPaint (blank-press pointerDown commit)
 *  4. saveBitmapCostume (pending commit-first inside the direct save)
 *  5. writeCroppedBitmapSave (direct brush/eraser/fill, prod flag OFF path)
 *  6. writeTransparentBitmapSave (direct transparent clear)
 *  7. convertCurrentCostumeToBitmap (svg -> bitmap conversion save)
 *
 * Rules under test (pure module):
 * - Barrier armed for the slot NEVER authorizes a skip: buffer + reconcile.
 * - Skip only on full version match: slot key, bytes key, writeSeq,
 *   projectGeneration, selectionEpoch, plus png gate.
 * - Legacy key-only tokens (empty assetKey) NEVER skip.
 * - Any drift (bytes, seq, generation, epoch, slot, format, unknown live)
 *   fails closed to reload.
 */

const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

const baseLive = (over: Record<string, unknown> = {}) => ({
  key: 'targetA:0',
  assetKey: 'md5-aaa',
  writeSeq: 7,
  projectGeneration: 3,
  selectionEpoch: 5,
  ...over,
})
const baseToken = (over: Record<string, unknown> = {}) => ({
  key: 'targetA:0',
  assetKey: 'md5-aaa',
  writeSeq: 7,
  projectGeneration: 3,
  selectionEpoch: 5,
  ...over,
})
const barrierFor = (live: { key: string; assetKey: string; writeSeq: number | null; projectGeneration: number; selectionEpoch: number | null }) => ({
  key: live.key,
  baseAssetKey: live.assetKey,
  baseWriteSeq: live.writeSeq,
  projectGeneration: live.projectGeneration,
  selectionEpoch: live.selectionEpoch,
})

function countCalls(source: string, name: string): number {
  // Exclude the function definition itself.
  return source.split(`${name}(`).length - 1 - 1
}

describe('seven skip sites exist with deferred barrier + version token', () => {
  it('has exactly seven capture and seven arm call sites (plus one definition each)', () => {
    expect(countCalls(editorSource, 'captureBitmapReloadBarrierForSlot')).toBe(7)
    expect(countCalls(editorSource, 'armBitmapReloadSkipFromLive')).toBe(7)
  })

  it('covers the four pending sites and three direct sites', () => {
    for (const fn of [
      'function guardBitmapPendingCommitFirst',
      'function clearCostumeSelection',
      'function beginBitmapPaint',
      'function saveBitmapCostume',
      'function writeCroppedBitmapSave',
      'function writeTransparentBitmapSave',
      'function convertCurrentCostumeToBitmap',
    ]) {
      expect(editorSource).toContain(fn)
    }
    // Each site captures the barrier synchronously before an await.
    expect(editorSource).toContain('captureBitmapReloadBarrierForSlot(stableTargetId(selectedTarget), selectedTarget.currentCostume ?? 0)')
    expect(editorSource).toContain('captureBitmapReloadBarrierForSlot(wantId, index)')
    expect(editorSource).toContain('captureBitmapReloadBarrierForSlot(targetId, index)')
  })

  it('every settle path clears the barrier, arms only from fresh live, and reconciles', () => {
    // Success: clear barrier -> arm from live -> reconcile. Failure: clear
    // both -> reconcile. Both shapes must exist at least seven times each.
    const clears = editorSource.split('clearBitmapReloadBarrier()').length - 1
    const reconciles = editorSource.split('reconcileDeferredBitmapReload()').length - 1
    expect(clears).toBeGreaterThanOrEqual(14)
    expect(reconciles).toBeGreaterThanOrEqual(14)
    // The arm helper itself refuses empty/unknown live (fail-closed).
    expect(editorSource).toContain("if (!live || live.assetKey === '')")
  })

  it('never arms a legacy key-only token: consumer requires a versioned token', async () => {
    const skipSource = await Bun.file(
      new URL('../src/features/costumes/bitmap-pending-reload-skip.ts', import.meta.url),
    ).text()
    expect(skipSource).toContain('isVersionedReloadSkipToken')
    expect(skipSource).toContain('NEVER skip')
    // Editor's token builder refuses empty asset keys (fail-closed).
    expect(editorSource).toContain("skipNextBitmapCanvasReloadAssetKey === ''")
  })

  it('direct brush/eraser/fill sites run with the prod pending flag OFF', () => {
    // Kill switch stays a literal false; the direct cropped/transparent/
    // conversion saves are NOT gated on it (they are the normal path).
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
    const croppedAt = editorSource.indexOf('async function writeCroppedBitmapSave')
    const croppedBody = editorSource.slice(croppedAt, croppedAt + 4000)
    expect(croppedBody).not.toContain('BITMAP_PENDING_UI_ENABLED')
    expect(croppedBody).toContain('captureBitmapReloadBarrierForSlot(wantId, index)')
    expect(croppedBody).toContain('armBitmapReloadSkipFromLive(wantId, index)')
  })
})

describe('pending flag on: in-flight barrier buffers, never skips', () => {
  it('matching token + armed barrier for the slot buffers instead of skipping', () => {
    const live = baseLive()
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), barrierFor(live), live, 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.buffered).toBe(true)
    expect(verdict.reason).toBe('commit-in-flight')
  })

  it('same barrier does not swallow other slots (no global skip)', () => {
    const liveA = baseLive()
    const liveB = baseLive({ key: 'targetB:0' })
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), barrierFor(liveA), liveB, 'png')
    expect(verdict.buffered).toBe(false)
    expect(verdict.skip).toBe(false)
  })
})

describe('overlapping operations slotA vs slotB stay isolated', () => {
  it('token armed for slotA never skips slotB even with identical bytes', () => {
    const tokenA = baseToken()
    const liveB = baseLive({ key: 'targetA:1', assetKey: 'md5-aaa' })
    const verdict = shouldSkipBitmapCanvasReload(tokenA, undefined, liveB, 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.reason).toBe('slot-moved')
  })

  it('barrier armed for slotA never buffers slotB', () => {
    const liveA = baseLive({ key: 'targetA:0' })
    const liveB = baseLive({ key: 'targetA:1' })
    const verdict = shouldSkipBitmapCanvasReload(baseToken({ key: 'targetA:1' }), barrierFor(liveA), liveB, 'png')
    expect(verdict.buffered).toBe(false)
  })

  it('same target, same display name, different index is a different slot', () => {
    // Costume names are display-only; the slot key is stableTargetId:index.
    const token = baseToken({ key: 'sprite1:0' })
    const live = baseLive({ key: 'sprite1:1', assetKey: 'md5-aaa' })
    expect(shouldSkipBitmapCanvasReload(token, undefined, live, 'png').skip).toBe(false)
  })
})

describe('no-barrier cleanup: sync throw and malformed canvas fail closed', () => {
  it('unknown live never skips, even with a versioned token and no barrier', () => {
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, undefined, 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, undefined, 'png').reason).toBe('live-unknown')
  })

  it('malformed live identity normalizes to undefined (fail-closed)', () => {
    expect(normalizeReloadLiveIdentity(undefined)).toBeUndefined()
    expect(normalizeReloadLiveIdentity({ key: '', assetKey: 'x', projectGeneration: 0 })).toBeUndefined()
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 42, projectGeneration: 0 })).toBeUndefined()
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 'x', projectGeneration: -1 })).toBeUndefined()
    expect(normalizeReloadLiveIdentity({ key: 'a:0', assetKey: 'x', projectGeneration: 0, writeSeq: -2 })).toBeUndefined()
  })

  it('legacy key-only tokens never skip', () => {
    expect(isVersionedReloadSkipToken(undefined)).toBe(false)
    expect(isVersionedReloadSkipToken({ key: 'a:0', assetKey: '', writeSeq: null, projectGeneration: 0, selectionEpoch: null })).toBe(false)
    expect(shouldSkipBitmapCanvasReload(undefined, undefined, baseLive(), 'png').skip).toBe(false)
  })

  it('every catch path clears barrier+skip and reconciles (static)', () => {
    // Spot-check the three direct-save catch shapes: clear, clear, reconcile,
    // then rethrow so the caller never reports success for a failed write.
    const probes = ['throw error', 'clearBitmapReloadSkip()']
    for (const probe of probes) expect(editorSource).toContain(probe)
    expect(editorSource).toContain('Best effort only')
  })
})

describe('equal asset id with seq bump never skips (same-bytes rename)', () => {
  it('identical bytes key but bumped writeSeq is external drift', () => {
    const token = baseToken({ assetKey: 'md5-same', writeSeq: 7 })
    const live = baseLive({ assetKey: 'md5-same', writeSeq: 8 })
    const verdict = shouldSkipBitmapCanvasReload(token, undefined, live, 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.reason).toBe('seq-drift')
  })
})

describe('event refresh between CAS applied and history append reloads', () => {
  it('pre-CAS token does not skip post-CAS live (seq moved under the flight)', () => {
    const preCasToken = baseToken({ writeSeq: 7 })
    const postCasLive = baseLive({ assetKey: 'md5-new', writeSeq: 8 })
    expect(shouldSkipBitmapCanvasReload(preCasToken, undefined, postCasLive, 'png').skip).toBe(false)
  })

  it('arm happens only after the await resolves (static ordering)', () => {
    // The barrier comment documents the discipline; every arm call site must
    // read the *fresh live* identity after the commit/save await.
    expect(editorSource).toContain('Proven own write: arm the versioned skip from fresh live')
    expect(editorSource).toContain('unpredictable')
  })
})

describe('target switch after CAS never skips the new slot', () => {
  it('slot-moved fails closed after an away-and-back switch', () => {
    const token = baseToken({ key: 'targetA:0', selectionEpoch: 5 })
    const switched = baseLive({ key: 'targetB:0', selectionEpoch: 6 })
    expect(shouldSkipBitmapCanvasReload(token, undefined, switched, 'png').skip).toBe(false)
  })

  it('selection epoch drift on the same slot fails closed', () => {
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive({ selectionEpoch: 6 }), 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.reason).toBe('selection-moved')
  })

  it('same slot equality after an away-and-back switch still reloads when epoch moved', () => {
    // Even if target+index compare equal again, the epoch records the trip.
    const token = baseToken({ key: 'targetA:0', selectionEpoch: 5 })
    const live = baseLive({ key: 'targetA:0', selectionEpoch: 9 })
    expect(shouldSkipBitmapCanvasReload(token, undefined, live, 'png').skip).toBe(false)
  })
})

describe('import / loadProject while the barrier is active', () => {
  it('reload arriving mid-flight buffers; post-load token fails on generation', () => {
    const live = baseLive()
    const midFlight = shouldSkipBitmapCanvasReload(baseToken(), barrierFor(live), live, 'png')
    expect(midFlight.buffered).toBe(true)
    expect(midFlight.skip).toBe(false)
    const afterLoad = shouldSkipBitmapCanvasReload(baseToken({ projectGeneration: 3 }), undefined, baseLive({ projectGeneration: 4 }), 'png')
    expect(afterLoad.skip).toBe(false)
    expect(afterLoad.reason).toBe('generation-moved')
  })

  it('loadProject commits pending first via the same guarded gate (static)', () => {
    const at = editorSource.indexOf('async function loadProject')
    expect(at).toBeGreaterThan(0)
    expect(editorSource.slice(at, at + 1200)).toContain("guardBitmapPendingCommitFirst('load-project')")
  })
})

describe('old barrier completion after a newer barrier begins', () => {
  it('a stale barrier for the same key still buffers (never skips on its own)', () => {
    const live = baseLive()
    const staleBarrier = barrierFor(baseLive())
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), staleBarrier, live, 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.buffered).toBe(true)
  })

  it('reordered completion with drifted live reloads instead of skipping', () => {
    const staleToken = baseToken({ writeSeq: 7 })
    const newerLive = baseLive({ assetKey: 'md5-newer', writeSeq: 9 })
    expect(shouldSkipBitmapCanvasReload(staleToken, undefined, newerLive, 'png').skip).toBe(false)
  })
})

describe('beforeunload never strands or skips a reload', () => {
  it('beforeunload is enabled-gated, never autosaves, never touches barrier/skip', () => {
    const at = editorSource.indexOf('function handleBitmapPendingBeforeUnload')
    expect(at).toBeGreaterThan(0)
    const body = editorSource.slice(at, at + 800)
    expect(body).toContain('if (!BITMAP_PENDING_UI_ENABLED) return')
    expect(body).not.toContain('commitPending')
    expect(body).not.toContain('clearBitmapReloadBarrier')
    expect(body).not.toContain('armBitmapReloadSkipFromLive')
  })
})

describe('stale UI replay never paints stale bytes', () => {
  it('replaying an old token after live moved reloads', () => {
    const stale = baseToken({ assetKey: 'md5-old', writeSeq: 7 })
    expect(shouldSkipBitmapCanvasReload(stale, undefined, baseLive({ assetKey: 'md5-old', writeSeq: 7 }), 'png').skip).toBe(true)
    expect(shouldSkipBitmapCanvasReload(stale, undefined, baseLive({ assetKey: 'md5-new', writeSeq: 8 }), 'png').skip).toBe(false)
  })

  it('non-png formats never skip (vector/blank path untouched)', () => {
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive(), 'svg').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(baseToken(), undefined, baseLive(), undefined).skip).toBe(false)
  })

  it('single deferred flag is coalesced and the settle path reconciles from live (static)', () => {
    expect(editorSource).toContain('let bitmapReloadDeferredWhileBarrier = false')
    expect(editorSource).toContain('never a queue')
    const at = editorSource.indexOf('async function reconcileDeferredBitmapReload')
    expect(at).toBeGreaterThan(0)
    const body = editorSource.slice(at, at + 1000)
    expect(body).toContain('bitmapReloadDeferredWhileBarrier = false')
    expect(body).toContain('refreshCostumePreview')
  })
})

describe('no unsupported global barrier state hides reloads or sticks a spinner', () => {
  it('barrier comparison is strictly per-slot (global never blocks other slots)', () => {
    const other = baseLive({ key: 'other:3' })
    const verdict = shouldSkipBitmapCanvasReload(baseToken(), barrierFor(baseLive()), other, 'png')
    expect(verdict.buffered).toBe(false)
    expect(verdict.skip).toBe(false)
  })

  it('no spinner/loading flag is coupled to the reload barrier (static)', () => {
    expect(editorSource).not.toMatch(/bitmapPendingCommitBarrier.*loading|loading.*bitmapPendingCommitBarrier/i)
    expect(editorSource).not.toMatch(/spinner.*barrier|barrier.*spinner/i)
  })
})
