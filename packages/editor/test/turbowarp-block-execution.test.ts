import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  createTurboWarpBlockExecution,
  type TurboWarpClickTarget,
} from '../src/lib/turbowarp-block-execution'

function fixture() {
  const target: TurboWarpClickTarget = {
    id: 'tw',
    blocks: { getBlock: (id) => (['root', 'nested'].includes(id) ? {} : undefined) },
  }
  const events = new EventEmitter()
  const calls: unknown[][] = []
  const reports: unknown[] = []
  let current = true
  const runtime = Object.assign(events, {
    targets: [target] as unknown[],
    setEditingTarget: (value: TurboWarpClickTarget) => calls.push(['editing', value]),
    toggleScript: (id: string, options: { target: TurboWarpClickTarget; stackClick: true }) =>
      calls.push(['toggle', id, options]),
  })
  const bridge = createTurboWarpBlockExecution({
    runtime,
    runtimeTargetId: (id) => (id === 'editor' ? 'tw' : undefined),
    isCurrent: () => current,
    report: (value) => reports.push(value),
  })
  return {
    runtime,
    target,
    calls,
    reports,
    bridge,
    setCurrent: (value: boolean) => {
      current = value
    },
  }
}

describe('TurboWarp block click bridge', () => {
  test('maps target and forwards root commands and nested reporters as stack clicks', () => {
    const f = fixture()
    f.bridge.click('root', 'editor')
    f.bridge.click('nested', 'editor')
    f.bridge.click('root', 'editor')
    expect(f.calls).toEqual([
      ['editing', f.target],
      ['toggle', 'root', { target: f.target, stackClick: true }],
      ['editing', f.target],
      ['toggle', 'nested', { target: f.target, stackClick: true }],
      ['editing', f.target],
      ['toggle', 'root', { target: f.target, stackClick: true }],
    ])
  })

  test('rejects unsynchronized, unmapped, ambiguous and nonexistent targets or blocks', () => {
    const f = fixture()
    f.setCurrent(false)
    expect(() => f.bridge.click('root', 'editor')).toThrow('not synchronized')
    f.setCurrent(true)
    expect(() => f.bridge.click('root', 'missing')).toThrow('could not be mapped')
    expect(() => f.bridge.click('missing', 'editor')).toThrow('block not found')
    f.runtime.targets.push(f.target)
    expect(() => f.bridge.click('root', 'editor')).toThrow('ambiguous')
    expect(f.calls).toEqual([])
  })

  test('forwards asynchronous visual reports only while current and subscribed', async () => {
    const f = fixture()
    f.bridge.click('nested', 'editor')
    await Promise.resolve()
    f.runtime.emit('VISUAL_REPORT', { id: 'nested', value: '42' })
    f.runtime.emit('VISUAL_REPORT', { id: 'nested', value: 42 })
    f.setCurrent(false)
    f.runtime.emit('VISUAL_REPORT', { id: 'nested', value: 'stale' })
    f.setCurrent(true)
    f.bridge.dispose()
    f.bridge.dispose()
    f.runtime.emit('VISUAL_REPORT', { id: 'nested', value: 'disposed' })
    expect(f.reports).toEqual([{ id: 'nested', value: '42' }])
    expect(() => f.bridge.click('nested', 'editor')).toThrow('disposed')
    expect(f.runtime.listenerCount('VISUAL_REPORT')).toBe(0)
  })
})
