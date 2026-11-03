import { describe, expect, it } from 'bun:test'
import type { PenBridge } from '../../xyo-cpp-wasm/src/pen-bridge'
import type { XyoWorkerRuntime } from '../src/lib/xyo-worker-protocol'
import { withXyoPenSnapshots } from '../src/lib/xyo-pen-worker-runtime'

describe('isolated pen worker decorator', () => {
  it('preserves question identity, audio and receiver binding', async () => {
    const audio = { sentinel: true }
    const runtime = {
      audio,
      marker: 5,
      snapshot() {
        return { targets: [], io: { question: 'Q?', questionId: '3' }, value: this.marker }
      },
      answerIfQuestion(id: string, answer: string) {
        return id === '3' && answer === 'A'
      },
    } as unknown as XyoWorkerRuntime
    const pen = { drain: () => [{ type: 'clear' }] } as unknown as PenBridge
    const decorated = withXyoPenSnapshots(runtime, pen)
    expect(decorated.audio).toBe(audio as unknown as XyoWorkerRuntime['audio'])
    expect(await decorated.snapshot()).toEqual({
      targets: [],
      io: { question: 'Q?', questionId: '3' },
      value: 5,
      penEvents: [{ type: 'clear' }],
    })
    expect(await decorated.answerIfQuestion!('3', 'A')).toBe(true)
  })
  it('never publishes a snapshot if batch drain fails', async () => {
    const runtime = { snapshot: () => ({ targets: [] }) } as unknown as XyoWorkerRuntime
    const pen = {
      drain: () => {
        throw new Error('overflow')
      },
    } as unknown as PenBridge
    await expect(withXyoPenSnapshots(runtime, pen).snapshot()).rejects.toThrow('overflow')
  })
})
