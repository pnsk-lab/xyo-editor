import { describe, expect, it } from 'bun:test'
import {
  settleVectorGestureSlotCompletion,
  waitForVectorSlotQuiescenceGate,
  type VectorGestureSettleState,
} from '../src/features/costumes/vector-slot-quiescence'

describe('vector-slot-quiescence gate', () => {
  it('resolves ok when idle and drains the captured completion', async () => {
    let drained = 0
    let cancelled = 0
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => false,
        drain: async () => {
          drained += 1
        },
        waitCancel: async () => {
          cancelled += 1
        },
      },
      2000,
      10,
    )
    expect(res.ok).toBe(true)
    expect(drained).toBe(1)
    expect(cancelled).toBe(1)
  })

  it('waits for a busy token to settle then drains once', async () => {
    let busy = true
    setTimeout(() => {
      busy = false
    }, 60)
    let drained = 0
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => busy,
        drain: async () => {
          drained += 1
        },
        waitCancel: async () => undefined,
      },
      2000,
      10,
    )
    expect(res.ok).toBe(true)
    expect(drained).toBe(1)
  })

  it('times out explicitly after 2s without speculative resume', async () => {
    let drained = 0
    const start = Date.now()
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => true,
        drain: async () => {
          drained += 1
        },
        waitCancel: async () => undefined,
      },
      2000,
      10,
    )
    const elapsed = Date.now() - start
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('timeout')
    // No drain ran while busy: the caller must abort without writing.
    expect(drained).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(1900)
  })

  it('fails closed on barrier rejection', async () => {
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => false,
        drain: async () => {
          throw new Error('injected barrier failure')
        },
        waitCancel: async () => undefined,
      },
      2000,
      10,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('barrier')
  })

  it('fails closed on cancel barrier rejection', async () => {
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => false,
        drain: async () => undefined,
        waitCancel: async () => {
          throw new Error('cancel barrier failure')
        },
      },
      2000,
      10,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('barrier')
  })

  it('rechecks stragglers enqueued during the drain', async () => {
    let calls = 0
    let busy = false
    const res = await waitForVectorSlotQuiescenceGate(
      {
        isBusy: () => busy,
        drain: async () => {
          calls += 1
          if (calls === 1) {
            // Straggler lands during the first drain: must wait again.
            busy = true
            setTimeout(() => {
              busy = false
            }, 30)
          }
        },
        waitCancel: async () => undefined,
      },
      2000,
      10,
    )
    expect(res.ok).toBe(true)
    expect(calls).toBe(2)
  })
})

describe('settleVectorGestureSlotCompletion', () => {
  it('drains twice when already settled and returns', async () => {
    let drains = 0
    await settleVectorGestureSlotCompletion(
      (): VectorGestureSettleState => 'settled',
      async () => {
        drains += 1
      },
    )
    expect(drains).toBe(2)
  })

  it('returns immediately when the global was taken over (gone)', async () => {
    let drains = 0
    await settleVectorGestureSlotCompletion(
      (): VectorGestureSettleState => 'gone',
      async () => {
        drains += 1
      },
    )
    expect(drains).toBe(0)
  })

  it('waits while busy, then drains the exact completion', async () => {
    let state: VectorGestureSettleState = 'busy'
    let drains = 0
    setTimeout(() => {
      state = 'settled'
    }, 50)
    await settleVectorGestureSlotCompletion(
      () => state,
      async () => {
        drains += 1
      },
    )
    expect(drains).toBe(2)
  })

  it('expires bounded instead of hanging forever', async () => {
    let drains = 0
    const start = Date.now()
    await settleVectorGestureSlotCompletion(
      (): VectorGestureSettleState => 'busy',
      async () => {
        drains += 1
      },
      5,
      10,
    )
    // Fail-safe expiry: proceeds after the bound (plus one final drain).
    expect(Date.now() - start).toBeLessThan(5000)
    expect(drains).toBe(1)
  })
})
