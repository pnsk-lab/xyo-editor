import { describe, expect, it } from 'bun:test'
import {
  beginVectorWriteGesture,
  cancelVectorWriteGesture,
  enqueueVectorCostumeWrite,
  isVectorSlotWritePending,
  isVectorWriteGestureCancelled,
  resetVectorWriteGateForTests,
  vectorWriteSlotKey,
  vectorWriteSlotKeyFor,
} from '../src/features/costumes/vector-costume-write-gate'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('vector-costume-write-gate', () => {
  it('slot keys separate by stable id, never by display name', () => {
    resetVectorWriteGateForTests()
    expect(vectorWriteSlotKey('dupA', 0)).not.toBe(vectorWriteSlotKey('dupB', 0))
    expect(vectorWriteSlotKeyFor({ id: 'dupA', name: 'DupSprite' }, 0)).toBe(vectorWriteSlotKey('dupA', 0))
    expect(vectorWriteSlotKeyFor({ id: 'dupB', name: 'DupSprite' }, 0)).toBe(vectorWriteSlotKey('dupB', 0))
    // Rename keeps the slot (id stable).
    expect(vectorWriteSlotKeyFor({ id: 'sprite1', name: 'Old' }, 2)).toBe(
      vectorWriteSlotKeyFor({ id: 'sprite1', name: 'New' }, 2),
    )
    // Different costume indices are different slots.
    expect(vectorWriteSlotKey('sprite1', 0)).not.toBe(vectorWriteSlotKey('sprite1', 1))
  })

  it('same-slot writes complete in initiation order even when out of order (preview -> restore barrier is final)', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    const order: string[] = []
    const slowPreview = enqueueVectorCostumeWrite(slot, gesture, 'preview', async () => {
      await tick(120)
      order.push('preview')
      return 'preview'
    })
    const restore = enqueueVectorCostumeWrite(slot, gesture, 'restore', async () => {
      order.push('restore')
      return 'restore'
    })
    expect(await slowPreview).toBe('preview')
    expect(await restore).toBe('restore')
    expect(order).toEqual(['preview', 'restore'])
  })

  it('old preview -> cancel -> new edit out of order: the new edit still wins, restore does not erase it', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    const applied: string[] = []
    const slowPreview = enqueueVectorCostumeWrite(slot, gesture, 'preview', async () => {
      await tick(120)
      applied.push('preview-bytes')
      return 'preview'
    })
    // Cancel retires the gesture, then the barrier restore enqueues, then a
    // newer legitimate edit enqueues after the restore. The slow preview was
    // enqueued before the cancel but had not started writing when the cancel
    // landed, so it is skipped (never touches the asset); the restore still
    // runs as the final write of its gesture and the newer edit lands after
    // it — the latest legitimate edit always wins.
    cancelVectorWriteGesture(gesture)
    const restore = enqueueVectorCostumeWrite(slot, gesture, 'restore', async () => {
      applied.push('restore-bytes')
      return 'restore'
    })
    const newEdit = enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {
      applied.push('new-edit-bytes')
      return 'new-edit'
    })
    expect(await slowPreview).toBeUndefined()
    expect(await restore).toBe('restore')
    expect(await newEdit).toBe('new-edit')
    // FIFO: restore lands after its own previews, the new edit lands after
    // the restore, so the latest legitimate edit is the final write.
    expect(applied).toEqual(['restore-bytes', 'new-edit-bytes'])
  })

  it('in-flight preview write is never skipped: cancel during the write still orders the restore after it', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    const order: string[] = []
    let writeStarted = false
    const preview = enqueueVectorCostumeWrite(slot, gesture, 'preview', async () => {
      writeStarted = true
      await tick(120)
      order.push('preview')
      return 'preview'
    })
    // Let the preview write actually start before cancelling (in-flight).
    for (let i = 0; i < 100 && !writeStarted; i += 1) await tick(5)
    expect(writeStarted).toBe(true)
    cancelVectorWriteGesture(gesture)
    const restore = enqueueVectorCostumeWrite(slot, gesture, 'restore', async () => {
      order.push('restore')
      return 'restore'
    })
    expect(await preview).toBe('preview')
    expect(await restore).toBe('restore')
    expect(order).toEqual(['preview', 'restore'])
  })

  it('a preview enqueued after its own cancel is skipped (stale frame never lands on the restore)', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    let wrote = false
    cancelVectorWriteGesture(gesture)
    const late = await enqueueVectorCostumeWrite(slot, gesture, 'preview', async () => {
      wrote = true
      return 'late'
    })
    expect(late).toBeUndefined()
    expect(wrote).toBe(false)
  })

  it('restore always runs (barrier), even for a cancelled gesture, and writes only its own bytes', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    cancelVectorWriteGesture(gesture)
    let wrote: string | undefined
    const restore = await enqueueVectorCostumeWrite(slot, gesture, 'restore', async () => {
      wrote = 'source-bytes'
      return 'restore'
    })
    expect(restore).toBe('restore')
    expect(wrote).toBe('source-bytes')
  })

  it('a rejection never breaks the slot chain (promise/exception safety)', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const failing = enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {
      await tick(10)
      throw new Error('boom')
    })
    const after = enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => 'after')
    await expect(failing).rejects.toThrow('boom')
    expect(await after).toBe('after')
  })

  it('different slots proceed independently (outside-slot asset untouched)', async () => {
    resetVectorWriteGateForTests()
    const a = vectorWriteSlotKey('VecA', 0)
    const b = vectorWriteSlotKey('VecB', 0)
    const order: string[] = []
    const slowA = enqueueVectorCostumeWrite(a, undefined, 'edit', async () => {
      await tick(80)
      order.push('a')
      return 'a'
    })
    const fastB = enqueueVectorCostumeWrite(b, undefined, 'edit', async () => {
      order.push('b')
      return 'b'
    })
    expect(await fastB).toBe('b')
    expect(await slowA).toBe('a')
    // b never waited for a's slow write.
    expect(order).toEqual(['b', 'a'])
  })

  it('cancel survives 1001 later cancels: queued stale preview and late arrival both skip (token, no prune)', async () => {
    // ------------------------------------------------------------------
    // 回帰テスト (旧 prune 欠陥の再現条件をそのまま踏む):
    // 旧 cancelledGestures Set は size>=1000 で古い cancel id を無条件削除
    // (pruneCancelled: 先頭 size-1000 件を delete)。同 slot の VM 書き込みが
    // 長時間止まると、その slot の FIFO 内に古い preview が実行待ちで残り、
    // その後の 1000 回超の開始/取消で旧 cancel id が消えて stale preview が
    // 復活する。
    //
    // queue の cancel 参照タイミング (vector-costume-write-gate.ts):
    // - enqueue 時 (同期) に行うのは seenEpoch の capture と token 参照の
    //   capture のみ。
    // - gesture cancelled の参照は queue 実行時である:
    //   next = prev.catch().then(async () => { ...epoch barrier...
    //     if (kind==='preview' && gesture.cancelled) return undefined;
    //     return await write() })
    //   すなわち FIFO の前任が settle してから (in-flight blocker の後)、
    //   かつ structure barrier を抜けた後に token.cancelled を見る。
    //   enqueue 時にスナップショットしないため、cancel が enqueue 後に
    //   来ても正しく skip できる。token は prune されないため、実行時
    //   までの長期滞留でも skip できる。
    //
    // 本テストの織り交ぜ (全て同一テスト内で安全に再現):
    //  異なる slot (VecB) / in-flight blocker (deferred promise, tick なし) /
    //  restore + new edit / 1001 回の gesture cancel / 遅延到着 preview。
    //  deferred で blocker 解放を完全制御するため、tick 競合なし・高速・
    //  ハングなし (finally で必ず release)。
    //
    // 修正後 (token object 方式): begin が {cancelled:false} を返し、preview
    // は token 参照を capture、cancel は token.cancelled=true のみ。global
    // set / prune なし、メモリは live token のみ。以下 4 assert が通る。
    // 補足: enqueue refcount では enqueue 前に await している遅延到着を
    // 守れないため不可。token 参照保持がその経路も covering する。
    // ------------------------------------------------------------------
    resetVectorWriteGateForTests()
    const victimSlot = vectorWriteSlotKey('VecA', 0)
    const otherSlot = vectorWriteSlotKey('VecB', 0)
    const applied: string[] = []

    // In-flight blocker: 同 slot の VM 書き込みが長時間止まる状況を
    // deferred promise で決定的に再現 (実時間 sleep なし)。
    let releaseBlocker!: () => void
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    let blockerStarted = false
    const blocker = enqueueVectorCostumeWrite(victimSlot, undefined, 'edit', async () => {
      blockerStarted = true
      await blockerGate
      applied.push('blocker')
      return 'blocker'
    })
    try {
      // blocker の write 本体が開始するまで待つ (FIFO 先頭なので microtask 数回)。
      for (let i = 0; i < 100 && !blockerStarted; i += 1) {
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 0))
      }
      expect(blockerStarted).toBe(true)

      // 古い gesture: preview を blocker の後ろに queue 残留させる。
      const victim = beginVectorWriteGesture()
      let earlyWrote = false
      const early = enqueueVectorCostumeWrite(victimSlot, victim, 'preview', async () => {
        earlyWrote = true
        applied.push('early-stale')
        return 'early'
      })
      // Cancel は同期的 (preview はまだ実行されていないので本来 skip される)。
      cancelVectorWriteGesture(victim)
      // restore (barrier, 必ず実行) と後続の正規 edit を織り交ぜる。
      // FIFO: blocker -> early -> restore -> newEdit の順で実行予定。
      const restore = enqueueVectorCostumeWrite(victimSlot, victim, 'restore', async () => {
        applied.push('restore')
        return 'restore'
      })
      const newEdit = enqueueVectorCostumeWrite(victimSlot, undefined, 'edit', async () => {
        applied.push('new-edit')
        return 'new-edit'
      })

      // 異なる slot は blocker 中でも独立進行することを証明 (in-flight の対比)。
      const otherFast = await enqueueVectorCostumeWrite(otherSlot, undefined, 'edit', async () => 'other-0')
      expect(otherFast).toBe('other-0')
      expect(blockerStarted).toBe(true)
      expect(applied).toEqual([]) // victim slot はまだ blocker で止まっている。

      // 1001 回の開始/取消で旧 cancel id を追い出す。途中で異なる slot の
      // 書き込みも挟み、filler が victim slot の FIFO を詰まらせないこと・
      // victim の queue が残留したまま cancel だけ消えることを示す。
      for (let i = 0; i < 1001; i += 1) {
        const g = beginVectorWriteGesture()
        cancelVectorWriteGesture(g)
        if (i % 250 === 0) {
          const v = await enqueueVectorCostumeWrite(otherSlot, undefined, 'edit', async () => `other-${i}`)
          expect(v).toBe(`other-${i}`)
        }
      }
      // token 方式では cancel 印は token 自体に残る (prune なし) が、
      // queue 内の early/restore/newEdit はまだ未実行で残留している。
      expect(isVectorWriteGestureCancelled(victim)).toBe(true)
      expect(earlyWrote).toBe(false)
      expect(applied).toEqual([])

      // 遅延到着 preview: 低速な非同期計算が cancel+1001 回取消の後に完了し、
      // restore/newEdit の後ろに enqueue される frame を模す。これが
      // restore を上書きして最終勝者になると破壊 (last-writer-wins 違反)。
      let lateWrote = false
      const late = enqueueVectorCostumeWrite(victimSlot, victim, 'preview', async () => {
        lateWrote = true
        applied.push('late-stale')
        return 'late'
      })

      // ブロック解放 → FIFO 順に実行。token 参照は cancel 済みのまま。
      releaseBlocker()
      const [blockerResult, earlyResult, restoreResult, newEditResult, lateResult] =
        await Promise.all([blocker, early, restore, newEdit, late])

      expect(blockerResult).toBe('blocker')
      expect(restoreResult).toBe('restore')
      expect(newEditResult).toBe('new-edit')
      // cancel 済み gesture の preview は queue 残留・遅延到着のいずれも
      // skip し、VM 書き込みもしない。
      expect(earlyResult).toBeUndefined()
      expect(earlyWrote).toBe(false)
      expect(lateResult).toBeUndefined()
      expect(lateWrote).toBe(false)
      expect(applied).toEqual(['blocker', 'restore', 'new-edit'])
    } finally {
      // 診断失敗時もハングさせない (安全な再現のための保証)。
      releaseBlocker()
    }
  })

  it('per-slot pending tracks exact execution: true while running, false after settle, other slots unaffected', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const other = vectorWriteSlotKey('VecA', 1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {
      await gate
      return 'done'
    })
    // Queued but not yet running: the write starts after the microtask turn.
    await tick(0)
    await tick(0)
    expect(isVectorSlotWritePending(slot)).toBe(true)
    expect(isVectorSlotWritePending(other)).toBe(false)
    expect(isVectorSlotWritePending(vectorWriteSlotKey('VecB', 0))).toBe(false)
    release()
    expect(await running).toBe('done')
    expect(isVectorSlotWritePending(slot)).toBe(false)
  })

  it('per-slot pending releases on throwing writes (no stuck busy)', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const failing = enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {
      await tick(10)
      throw new Error('injected write failure')
    })
    await tick(0)
    await tick(0)
    expect(isVectorSlotWritePending(slot)).toBe(true)
    await expect(failing).rejects.toThrow('injected write failure')
    expect(isVectorSlotWritePending(slot)).toBe(false)
    // The slot chain still proceeds after the rejection.
    expect(await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => 'next')).toBe('next')
    expect(isVectorSlotWritePending(slot)).toBe(false)
  })

  it('skipped previews (cancelled/epoch-stale) never mark the slot pending', async () => {
    resetVectorWriteGateForTests()
    const slot = vectorWriteSlotKey('VecA', 0)
    const gesture = beginVectorWriteGesture()
    cancelVectorWriteGesture(gesture)
    expect(await enqueueVectorCostumeWrite(slot, gesture, 'preview', async () => 'never')).toBeUndefined()
    expect(isVectorSlotWritePending(slot)).toBe(false)
  })
})
