import { describe, expect, it } from 'bun:test'
import { createThumbnailThrottle } from '../src/lib/thumbnail-throttle'
import { createTargetThumbnails } from '../src/features/Targets/target-thumbnails'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('thumbnail throttling', () => {
  it('runs immediately, then coalesces bursts to the latest value', async () => {
    const calls: string[] = []
    let invalidations = 0
    const throttle = createThumbnailThrottle((value: string) => calls.push(value), () => { invalidations++ })
    throttle.request('first')
    throttle.request('middle')
    throttle.request('latest')
    expect(calls).toEqual(['first'])
    expect(invalidations).toBe(3)
    await wait(120)
    expect(calls).toEqual(['first'])
    await wait(230)
    expect(calls).toEqual(['first', 'latest'])
    throttle.dispose()
  })

  it('flushes target changes immediately and cancels pending work on reset and disposal', async () => {
    const calls: string[] = []
    const throttle = createThumbnailThrottle((value: string) => calls.push(value), () => {})
    throttle.request('first')
    throttle.request('pending')
    throttle.request('other target', true)
    throttle.request('cancelled')
    throttle.reset()
    throttle.request('after reset')
    throttle.request('disposed')
    throttle.dispose()
    throttle.request('ignored')
    await wait(350)
    expect(calls).toEqual(['first', 'other target', 'after reset'])
  })

  it('invalidates in-flight target loads as soon as a newer request is queued', async () => {
    let resolve!: (bytes: Uint8Array) => void
    const load = new Promise<Uint8Array>((done) => { resolve = done })
    const published: Record<string, string>[] = []
    const manager = createTargetThumbnails(() => load, (urls) => published.push(urls), async () => {})
    const source = (key: string) => [{ slot: 'sprite', key, assetKey: key, format: 'svg' }]
    const throttle = createThumbnailThrottle((key: string) => { void manager.refresh(source(key)) }, manager.invalidate)
    throttle.request('old')
    throttle.request('new')
    resolve(new Uint8Array([1]))
    await Promise.resolve()
    await Promise.resolve()
    expect(published).toEqual([])
    throttle.dispose()
    manager.reset()
  })
})
