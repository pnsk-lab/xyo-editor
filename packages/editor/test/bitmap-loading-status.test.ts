import { describe, expect, it } from 'bun:test'
import {
  BITMAP_LOADING_STATUS,
  BITMAP_LOAD_SETTLED_STATUS,
  resolveBitmapLoadingSettleStatus,
  shouldResolveBitmapLoadingStatus,
} from '../src/features/costumes/bitmap-loading-status'

const baseOwner = {
  targetId: 'target-1',
  index: 0,
  loadSerial: 7,
  revision: 3,
  generation: 11,
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    status: BITMAP_LOADING_STATUS,
    owner: { ...baseOwner },
    pending: undefined,
    serial: 7,
    revision: 3,
    generation: 11,
    liveTargetId: 'target-1',
    liveIndex: 0,
    refused: false,
    ...overrides,
  }
}

describe('bitmap-loading-status helper', () => {
  it('resolves pending-derived Loading only on the same settled load', () => {
    expect(shouldResolveBitmapLoadingStatus(baseInput())).toBe(true)
    expect(resolveBitmapLoadingSettleStatus(baseInput())).toBe(BITMAP_LOAD_SETTLED_STATUS)
  })

  it('never overwrites a later operation or a different error status', () => {
    expect(shouldResolveBitmapLoadingStatus(baseInput({ status: 'Bitmap selection copied' }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ status: 'Bitmap paste: cancelled (artwork changed — original kept unchanged)' }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ status: 'Vector objects nudged' }))).toBe(false)
    expect(resolveBitmapLoadingSettleStatus(baseInput({ status: 'Ready' }))).toBeUndefined()
  })

  it('preserves inspection refusal / huge-image display', () => {
    expect(
      shouldResolveBitmapLoadingStatus(
        baseInput({ status: 'Image too large to edit safely — original kept unchanged' }),
      ),
    ).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ refused: true }))).toBe(false)
  })

  it('requires settled pending and matching owner/revision/serial/generation', () => {
    // Still loading: no completion write.
    expect(shouldResolveBitmapLoadingStatus(baseInput({ pending: { loadSerial: 7 } }))).toBe(false)
    // Target/costume switch.
    expect(shouldResolveBitmapLoadingStatus(baseInput({ liveTargetId: 'other' }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ liveIndex: 1 }))).toBe(false)
    // Late stale load: serial / revision / generation drift.
    expect(shouldResolveBitmapLoadingStatus(baseInput({ serial: 8 }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ revision: 4 }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ generation: 12 }))).toBe(false)
    expect(shouldResolveBitmapLoadingStatus(baseInput({ owner: undefined }))).toBe(false)
  })

  it('does not perform a static Loading string replacement', async () => {
    const editorSource = await Bun.file(
      new URL('../src/Editor.svelte', import.meta.url),
    ).text()
    // Guarded settle must go through the helper, not a bare status rewrite.
    expect(editorSource).toContain('shouldResolveBitmapLoadingStatus')
    expect(editorSource).toContain('maybeResolveBitmapLoadingStatus')
    expect(editorSource).toContain('bitmap-loading-status')
  })
})
