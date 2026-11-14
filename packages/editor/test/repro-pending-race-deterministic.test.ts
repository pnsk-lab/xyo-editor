import { describe, expect, it } from 'bun:test'
import { createBitmapPendingSession } from '../src/features/costumes/bitmap-pending-session'
import { createTestWorld } from './bitmap-pending-test-harness'

const STYLE = { fill: '#ff0000', secondary: '#ffffff', gradient: 'solid', fillTransparent: false, secondaryTransparent: false, brushSize: 6 }

describe('deterministic repro: commit vs target-switch race (no sleeps)', () => {
  it('deferred CAS + switch mid-flight -> bytes land, history append blocked, gap sticky', async () => {
    const order: string[] = []
    const world = createTestWorld()
    // Deferred CAS: deterministic gate, no timers.
    let releaseCas: (() => void) | undefined
    const casGate = new Promise<void>((r) => { releaseCas = r })
    const origCas = world.vm.updateCostumeIfMatch!
    ;(world.vm as any).updateCostumeIfMatch = async (...a: unknown[]) => {
      order.push('cas-entry')
      await casGate
      order.push('cas-exit')
      const r = await (origCas as any)(...a)
      order.push(`cas-result:${JSON.stringify(r)}`)
      return r
    }
    // Controller/Editor-mirroring history wrapper: blocks cross-slot appends
    // (mirrors BitmapPendingController.historyPortsFor: live target/index must
    // still equal the entry slot, else return false; plus Editor paintScope
    // clear on switch). No timing involved.
    let liveSlot = { targetId: 'sprite-1', costumeIndex: 0 }
    const entrySlot = { targetId: 'sprite-1', costumeIndex: 0 }
    let innerCommits = 0
    const crossSlotBlocked = () => liveSlot.targetId !== entrySlot.targetId || liveSlot.costumeIndex !== entrySlot.costumeIndex
    const wrappedHistory = {
      ...world.history.ports,
      commit: (e: unknown) => {
        order.push(`history-append-attempt live=${liveSlot.targetId}:${liveSlot.costumeIndex} entry=${entrySlot.targetId}:${entrySlot.costumeIndex}`)
        if (crossSlotBlocked()) {
          order.push('history-append-return:false (cross-slot blocked, mirrors controller guard)')
          return false
        }
        innerCommits += 1
        const ok = world.history.ports.commit(e)
        order.push(`history-append-return:${ok} (inner)`)
        return ok
      },
      beginReservation: (e: unknown) => {
        // Mirrors the real chain: reservation.commit routes through the same
        // controller cross-slot guard (source.commit), not around it.
        let released = false
        return {
          isCurrent: () => !released && !crossSlotBlocked(),
          commit: () => {
            order.push(`reservation-commit-attempt live=${liveSlot.targetId}:${liveSlot.costumeIndex}`)
            if (released || crossSlotBlocked()) {
              order.push('reservation-commit-return:false (cross-slot blocked)')
              return false
            }
            released = true
            innerCommits += 1
            const ok = world.history.ports.commit(e)
            order.push(`reservation-commit-return:${ok} (inner)`)
            return ok
          },
          cancel: () => { released = true },
        }
      },
    }
    const session = createBitmapPendingSession(world.vm, 'sprite-1', 0, { loadSerial: 1, sessionGeneration: 1 }, world.canvas.ports, wrappedHistory, { onStatus: (t) => order.push(`status:${t}`) }, {})
    await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE as any)
    session.pointerMove({ x: 100, y: 75 })
    const up = await session.pointerUp({ x: 100, y: 75 })
    expect(up.ok).toBe(true)
    order.push(`staged projectGeneration=${(world.vm.getProjectGeneration as any)()} identity=${JSON.stringify((world.vm.getCostumeIdentity as any)('sprite-1', 0))} selection=sprite-1 depth=${world.history.entries.length}`)
    // Escape: start commit (takes pending, calls writer, blocks at deferred CAS).
    const commitP = session.commitPending()
    order.push('commit-started (Escape); pending taken, CAS deferred')
    await Promise.resolve(); await Promise.resolve()
    expect(session.snapshot().commitInFlight).toBe(true)
    // Deterministic target switch WHILE CAS gated (mirrors guardedSelectTarget
    // skipping in-flight + ensure(slotB) updating currentSlot + paintScope clear).
    liveSlot = { targetId: 'sprite-2', costumeIndex: 0 }
    order.push(`target-switch live=${liveSlot.targetId} projectGeneration=${(world.vm.getProjectGeneration as any)()} identityA=${JSON.stringify((world.vm.getCostumeIdentity as any)('sprite-1', 0))}`)
    releaseCas!()
    const result = await commitP
    order.push(`commit-result:${JSON.stringify(result)}`)
    order.push(`post-wait projectGeneration=${(world.vm.getProjectGeneration as any)()} identityA=${JSON.stringify((world.vm.getCostumeIdentity as any)('sprite-1', 0))} currentSelection=${liveSlot.targetId} historyDepth=${world.history.entries.length} innerCommits=${innerCommits}`)
    order.push(`sessionSnap:${JSON.stringify(session.snapshot())}`)
    // Reselect original target and inspect Undo there (mirrors audit switch-back).
    liveSlot = { targetId: 'sprite-1', costumeIndex: 0 }
    order.push(`switch-back live=${liveSlot.targetId} depth=${world.history.entries.length} gap=${session.snapshot().historyGap}`)
    console.log(`[repro:ordering]\n${order.join('\n')}`)
    // Fail-first pins for the silent-loss shape:
    expect(world.vm.state.writeSeq).toBe(2) // bytes landed
    expect(innerCommits).toBe(0) // append never ran (blocked cross-slot)
    expect(world.history.entries.length).toBe(0) // no Undo entry
    expect((result as any).kind).toBe('committed-without-history')
    expect(session.snapshot().historyGap).toBe(true) // sticky gap must survive switch-back
    // Explicit acknowledgement clears the sticky gap (no bytes touched, no reapply).
    expect(session.acknowledgeHistoryGap('repro-ack').acknowledged).toBe(true)
    expect(session.snapshot().historyGap).toBe(false)
  })

  it('clean commit without switch -> single entry, no gap (control sequence)', async () => {
    const world = createTestWorld()
    const session = createBitmapPendingSession(world.vm, 'sprite-1', 0, { loadSerial: 1, sessionGeneration: 1 }, world.canvas.ports, world.history.ports, {}, {})
    await session.pointerDown({ x: 20, y: 15 }, 'rect', 'filled', STYLE as any)
    session.pointerMove({ x: 100, y: 75 })
    const up = await session.pointerUp({ x: 100, y: 75 })
    expect(up.ok).toBe(true)
    const before = world.vm.state.writeSeq
    const result = await session.commitPending()
    expect((result as any).kind).toBe('committed')
    expect(world.vm.state.writeSeq).toBe(before + 1) // bytes landed exactly once
    expect(world.history.entries.length).toBe(1) // exactly one Undo entry
    expect(session.snapshot().historyGap).toBe(false)
    // Retry with no pending stays nothing-to-commit (never reapplied, gap preserved as false).
    const retry = await session.commitPending()
    expect((retry as any).kind).toBe('nothing-to-commit')
    expect(world.vm.state.writeSeq).toBe(before + 1)
    expect(world.history.entries.length).toBe(1)
  })
})
