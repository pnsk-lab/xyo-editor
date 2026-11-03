// Design model only: does not exercise the production adapter or native ABI.
import { test } from 'node:test'
import assert from 'node:assert/strict'

class Frames {
  epoch = 0
  project = 'p'
  frame = { ink: [], pen: {} }
  invalidate() { return ++this.epoch }
  replace(project) { this.invalidate(); this.project = project; this.frame = { ink: [], pen: {} } }
  commit(epoch, bundle) {
    if (epoch !== this.epoch || bundle.project !== this.project) return false
    const ids = Object.keys(bundle.pen)
    if (new Set(bundle.originals).size !== bundle.originals.length || ids.length !== bundle.originals.length || ids.some(id => !bundle.originals.includes(id))) throw Error('identity')
    if (ids.some(id => typeof bundle.pen[id].down !== 'boolean' || !Number.isFinite(bundle.pen[id].size))) throw Error('invalid pen')
    this.frame = structuredClone({ ink: [...this.frame.ink, ...bundle.ink], pen: bundle.pen })
    return true
  }
}
const bundle = (ink, pen, originals = Object.keys(pen), project = 'p') => ({ ink, pen, originals, project })
const down = { down: true, size: 3, hue: 31 }

test('last complete frame survives stop and rejects stale operation', () => {
  const m = new Frames()
  m.commit(0, bundle(['dot'], { a: down }))
  const epoch = m.invalidate()
  assert.equal(m.commit(0, bundle(['stale'], { a: { ...down, size: 9 } })), false)
  assert.deepEqual(m.frame, { ink: ['dot'], pen: { a: down } })
  assert.equal(m.commit(epoch, bundle(['line'], { a: down })), true)
  assert.deepEqual(m.frame.ink, ['dot', 'line'])
})

test('clone ink persists but clone state never enters originals', () => {
  const m = new Frames()
  m.commit(0, bundle(['clone-line'], { a: down }))
  assert.throws(() => m.commit(0, bundle([], { a: down, clone: down }, ['a'])), /identity/)
  assert.deepEqual(m.frame, { ink: ['clone-line'], pen: { a: down } })
})

test('replacement clears both sidecar and ink and rejects old reply', () => {
  const m = new Frames()
  m.commit(0, bundle(['dot'], { a: down }))
  m.replace('q')
  assert.equal(m.commit(0, bundle(['old'], { a: down })), false)
  assert.deepEqual(m.frame, { ink: [], pen: {} })
})

test('invalid bundle is atomic and duplicate originals are rejected', () => {
  const m = new Frames()
  m.commit(0, bundle(['dot'], { a: down }))
  assert.throws(() => m.commit(0, bundle(['bad'], { a: { ...down, size: NaN } })), /invalid/)
  assert.throws(() => m.commit(0, bundle(['bad'], { a: down }, ['a', 'a'])), /identity/)
  assert.deepEqual(m.frame, { ink: ['dot'], pen: { a: down } })
})
