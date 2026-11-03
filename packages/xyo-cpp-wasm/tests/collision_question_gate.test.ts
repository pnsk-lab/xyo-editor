import { describe, expect, it } from 'bun:test'
import { CollisionQuestionGate, type CollisionQuestion } from '../src/collision_question_gate'

describe('disconnected collision question gate', () => {
  it('never claims an exact answer even with a complete predecoded scene', () => {
    const gate = new CollisionQuestionGate()
    const epoch = gate.reset(), original = gate.create(), clone = gate.create()
    gate.markDecoded('costume:hash:svg:v1')
    const q: CollisionQuestion = { epoch, targets: [original, clone].map(identity => ({ identity, assetKey: 'costume:hash:svg:v1' })), subject: original, candidates: [clone] }
    expect(gate.inspect(q)).toEqual({ status: 'degraded', reason: 'exact synchronous collision backend unavailable' })
    expect(gate.inspect({ ...q, targets: q.targets.slice(0, 1) }).reason).toBe('incomplete target set')
    expect(gate.inspect({ ...q, targets: [q.targets[0]!, q.targets[0]!] }).reason).toBe('invalid or duplicate target identity')
    gate.invalidateAsset('costume:hash:svg:v1')
    expect(gate.inspect(q).reason).toBe('asset not decoded')
    gate.markDecoded('costume:hash:svg:v1')
    gate.remove(clone)
    const newClone = gate.create()
    expect(newClone.serial).not.toBe(clone.serial)
    expect(gate.inspect(q).reason).toBe('invalid or duplicate target identity')
    expect(() => gate.remove(clone)).toThrow()
    gate.reset()
    expect(gate.inspect(q).reason).toBe('stale epoch')
  })

  it('rejects unknown candidates, failed setup and recursive callbacks', () => {
    const gate = new CollisionQuestionGate()
    expect(() => gate.create()).toThrow()
    const epoch = gate.reset(), id = gate.create()
    expect(() => gate.markDecoded('')).toThrow()
    gate.markDecoded('a')
    const q: CollisionQuestion = { epoch, targets: [{ identity: id, assetKey: 'a' }], subject: id, candidates: [{ epoch, serial: 100 }] }
    expect(gate.inspect(q).reason).toBe('unknown question target')
    let nested = ''
    const recursive = { ...q, get targets() { nested = gate.inspect(q).reason; return q.targets } }
    gate.inspect(recursive)
    expect(nested).toBe('reentrant question')
    const bad = { ...q, get targets(): CollisionQuestion['targets'] { throw new Error('bad payload') } }
    expect(gate.inspect(bad).reason).toBe('invalid question')
    expect(gate.inspect(q).reason).toBe('unknown question target')
  })
})
