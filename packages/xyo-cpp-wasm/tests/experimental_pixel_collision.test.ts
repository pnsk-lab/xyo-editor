import { describe, expect, it } from 'bun:test'
import { ExperimentalPixelCollision, type GridQuestion } from '../src/experimental_pixel_collision'

const one = { epoch: 1, serial: 1 }, clone = { epoch: 1, serial: 2 }
const scene = (): GridQuestion => ({ epoch: 1, subject: one, candidates: [clone], targets: [
  { id: one, asset: 'a:v1', x: 0, y: 0 }, { id: clone, asset: 'a:v1', x: 1, y: 0 },
] })

describe('experimental integer pixel grid (not Scratch)', () => {
  it('uses copied predecoded alpha, including transparent holes and same-question motion', () => {
    const c = new ExperimentalPixelCollision(), alpha = new Uint8Array([255, 0])
    c.register('a:v1', 2, 1, alpha); alpha[0] = 0; alpha[1] = 255
    expect(c.question(scene())).toEqual({ status: 'ok', touching: false })
    const q = scene()
    expect(c.question({ ...q, targets: [q.targets[0]!, { ...q.targets[1]!, x: 0 }] })).toEqual({ status: 'ok', touching: true })
    c.invalidate('a:v1')
    expect(c.question(q)).toEqual({ status: 'unsupported', reason: 'asset not decoded' })
  })
  it('fails closed for invalid identities, missing candidates and unsupported transforms', () => {
    const c = new ExperimentalPixelCollision(); c.register('a:v1', 1, 1, new Uint8Array([1]))
    const q = scene()
    expect(c.question({ ...q, candidates: [one, { epoch: 1, serial: 999 }] }).status).toBe('unsupported')
    expect(c.question({ ...q, targets: [q.targets[0]!, q.targets[0]!] }).status).toBe('unsupported')
    expect(c.question({ ...q, targets: [q.targets[0]!, { ...q.targets[1]!, x: 0.5 }] }).status).toBe('unsupported')
    expect(c.question({ ...q, epoch: 2 }).status).toBe('unsupported')
    expect(() => c.register('bad', 2, 2, new Uint8Array(1))).toThrow()
  })
  it('rejects recursive questions and recovers from throwing payloads', () => {
    const c = new ExperimentalPixelCollision(); c.register('a:v1', 1, 1, new Uint8Array([1]))
    const q = scene(); let nested = ''
    const recursive = { ...q, get targets() { nested = c.question(q).status; return q.targets } }
    expect(c.question(recursive).status).toBe('ok'); expect(nested).toBe('unsupported')
    expect(c.question({ ...q, get targets(): GridQuestion['targets'] { throw new Error('bad payload') } })).toEqual({ status: 'unsupported', reason: 'bad payload' })
    expect(c.question(q).status).toBe('ok')
  })
})
