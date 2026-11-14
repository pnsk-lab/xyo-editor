// Reshape-nudge helper contract (pure, DOM-free).
//
// Covers `vector-reshape-nudge.ts`: the keyboard path moves selected anchors
// by exactly one screen px (Shift/Alt ignored), keys the pending session by
// owning unit + normalized points, filters to still-live anchors, and builds
// absolute document targets without mutating the inputs.

import { describe, expect, it } from 'bun:test'
import {
  liveReshapeNudgeIndices,
  reshapeNudgeSelectionKey,
  reshapeNudgeStep,
  reshapeNudgeTargets,
} from '../src/features/costumes/vector-reshape-nudge'
import { referenceVectorNudgeStep } from '../src/features/costumes/nudge-parity'

const anchors = [
  { index: 0, x: 10, y: 30, kind: 'anchor' },
  { index: 1, x: 20, y: 30, kind: 'control' },
  { index: 2, x: 40, y: 30, kind: 'anchor' },
  { index: 3, x: 50, y: 30, kind: 'control' },
  { index: 4, x: 60, y: 30, kind: 'control' },
  { index: 5, x: 70, y: 30, kind: 'anchor' },
]

describe('reshape nudge step (zoom screen step, modifiers ignored)', () => {
  it('is shift/alt-independent and screen-constant at exactly 25/100/500', () => {
    for (const viewportScale of [0.25, 1, 5]) {
      const plain = reshapeNudgeStep(viewportScale)
      // Reference parity with no Shift multiplier: Alt never clones on the
      // keyboard path either, so both modifiers must equal the plain step.
      expect(plain).toBe(referenceVectorNudgeStep(viewportScale, false))
      expect(plain).not.toBe(referenceVectorNudgeStep(viewportScale, true))
      // One plain keydown travels exactly one screen pixel.
      expect(plain * 5 * viewportScale).toBeCloseTo(1, 9)
    }
    // Exact pinned values (SVG units): 25% -> 0.8, 100% -> 0.2, 500% -> 0.04.
    expect(reshapeNudgeStep(0.25)).toBeCloseTo(0.8, 9)
    expect(reshapeNudgeStep(1)).toBeCloseTo(0.2, 9)
    expect(reshapeNudgeStep(5)).toBeCloseTo(0.04, 9)
  })
})

describe('reshape nudge selection key (stable pending identity)', () => {
  it('names the owning unit plus normalized points', () => {
    expect(reshapeNudgeSelectionKey(2, [5, 0, 0])).toBe('vr:2:0,5')
    // Object-move sessions keep the `v:` namespace: no collision.
    expect(reshapeNudgeSelectionKey(2, [5, 0])).not.toMatch(/^v:/)
  })

  it('refuses empty/invalid selections without history', () => {
    expect(reshapeNudgeSelectionKey(-1, [0])).toBeUndefined()
    expect(reshapeNudgeSelectionKey(0, [])).toBeUndefined()
    expect(reshapeNudgeSelectionKey(0, [-1])).toBeUndefined()
  })
})

describe('reshape nudge targets (fail-closed translation)', () => {
  it('moves only live anchors by the exact delta', () => {
    const targets = reshapeNudgeTargets(anchors, [0, 2, 5], 0.2, 0)
    expect(targets).toEqual([
      { index: 0, x: 10.2, y: 30 },
      { index: 2, x: 40.2, y: 30 },
      { index: 5, x: 70.2, y: 30 },
    ])
  })

  it('excludes control slots and stale indices instead of moving the object', () => {
    // Control slots (1, 3) and the out-of-range slot (9) resolve to nothing
    // to move: the caller must no-op, never fall back to the whole object.
    expect(reshapeNudgeTargets(anchors, [1, 3], 0.2, 0)).toEqual([])
    expect(reshapeNudgeTargets(anchors, [9], 0.2, 0)).toEqual([])
    expect(liveReshapeNudgeIndices(anchors, [0, 1, 9])).toEqual([0])
  })

  it('refuses zero/non-finite deltas without touching inputs', () => {
    const before = structuredClone(anchors)
    expect(reshapeNudgeTargets(anchors, [0], 0, 0)).toEqual([])
    expect(reshapeNudgeTargets(anchors, [0], Number.NaN, 0)).toEqual([])
    expect(anchors).toEqual(before)
  })
})
