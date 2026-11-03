import { describe, expect, test } from 'bun:test'
import { AudioEventQueue } from '../src/audio-event-queue'

describe('worker audio event queue', () => {
  test('play and stop preserve order and do not fake an outcome', () => {
    const q = new AudioEventQueue()
    const token = q.play('sprite', 2, true)
    q.stop('sprite', 2)
    q.stopAll()
    expect(q.drainCommands()).toEqual([
      { type: 'play', token, target: 'sprite', soundId: 2, wait: true },
      { type: 'stop', target: 'sprite', soundId: 2 },
      { type: 'stop-all' },
    ])
    expect(q.drainEvents()).toEqual([])
    expect(q.receive({ token, outcome: 'stopped' })).toBe(true)
    expect(q.drainEvents()).toEqual([{ token, outcome: 'stopped' }])
    expect(q.receive({ token, outcome: 'ended' })).toBe(false)
  })

  test('only actual distinct outcomes are delivered once', () => {
    const q = new AudioEventQueue()
    const a = q.play('a', 1, true)
    const b = q.play('a', 1, false)
    expect(q.receive({ token: b, outcome: 'failed' })).toBe(true)
    expect(q.receive({ token: a, outcome: 'ended' })).toBe(true)
    expect(q.receive({ token: a, outcome: 'ended' })).toBe(false)
    expect(q.drainEvents()).toEqual([{ token: b, outcome: 'failed' }, { token: a, outcome: 'ended' }])
    expect(q.drainEvents()).toEqual([])
  })

  test('reset rejects previous generation even when an id is reused', () => {
    const q = new AudioEventQueue()
    const old = q.play('old', 0, true)
    q.receive({ token: old, outcome: 'ended' })
    q.reset()
    const current = q.play('new', 0, true)
    expect(current.id).toBe(old.id)
    expect(q.receive({ token: old, outcome: 'ended' })).toBe(false)
    expect(q.drainEvents()).toEqual([])
    expect(q.drainCommands().map(command => command.type)).toEqual(['play', 'stop-all', 'play'])
    expect(q.receive({ token: current, outcome: 'ended' })).toBe(true)
  })
})
