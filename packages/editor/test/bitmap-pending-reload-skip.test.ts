import { describe, expect, it } from 'bun:test'
import { shouldSkipBitmapCanvasReload } from '../src/features/costumes/bitmap-pending-reload-skip'

const live = (over: Record<string, unknown> = {}) => ({
  key: 'target:0',
  assetKey: 'md5-a',
  writeSeq: 7,
  projectGeneration: 3,
  selectionEpoch: 5,
  ...over,
})

describe('bitmap pending reload skip (versioned + barrier)', () => {
  it('skips only the proven own committed version (same slot/bytes/seq/generation/epoch, png)', () => {
    const token = { key: 'target:0', assetKey: 'md5-a', writeSeq: 7, projectGeneration: 3, selectionEpoch: 5 }
    expect(shouldSkipBitmapCanvasReload(token, undefined, live(), 'png').skip).toBe(true)
  })
  it('legacy unversioned tokens never skip', () => {
    expect(shouldSkipBitmapCanvasReload(undefined, undefined, live(), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload({ key: 'target:0', assetKey: '', writeSeq: null, projectGeneration: 3, selectionEpoch: 5 }, undefined, live(), 'png').skip).toBe(false)
  })
  it('in-flight barrier buffers instead of skipping (external green never swallowed)', () => {
    const token = { key: 'target:0', assetKey: 'md5-a', writeSeq: 7, projectGeneration: 3, selectionEpoch: 5 }
    const barrier = { key: 'target:0', baseAssetKey: 'md5-a', baseWriteSeq: 7, projectGeneration: 3, selectionEpoch: 5 }
    const verdict = shouldSkipBitmapCanvasReload(token, barrier, live(), 'png')
    expect(verdict.skip).toBe(false)
    expect(verdict.buffered).toBe(true)
  })
  it('external same-slot drift fails closed (bytes, seq, generation, epoch, format)', () => {
    const token = { key: 'target:0', assetKey: 'md5-a', writeSeq: 7, projectGeneration: 3, selectionEpoch: 5 }
    expect(shouldSkipBitmapCanvasReload(token, undefined, live({ assetKey: 'md5-green' }), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(token, undefined, live({ writeSeq: 8 }), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(token, undefined, live({ projectGeneration: 4 }), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(token, undefined, live({ selectionEpoch: 6 }), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload({ ...token, key: 'other:0' }, undefined, live(), 'png').skip).toBe(false)
    expect(shouldSkipBitmapCanvasReload(token, undefined, live(), 'svg').skip).toBe(false)
  })
})
