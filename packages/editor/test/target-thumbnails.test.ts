import { afterEach, describe, expect, it } from 'bun:test'
import { createTargetThumbnails, type TargetThumbnailSource } from '../src/features/Targets/target-thumbnails'

const source = (key: string, slot = 'sprite'): TargetThumbnailSource => ({ slot, key, assetKey: `${key}:svg`, format: 'svg' })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('target thumbnails', () => {
  const image = globalThis.Image
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  afterEach(() => { globalThis.Image = image; URL.createObjectURL = create; URL.revokeObjectURL = revoke })

  it('keeps the old decoded image until replacement is published and reuses unchanged URLs', async () => {
    let number = 0
    const revoked: string[] = []
    const decode = deferred<void>()
    const painted = deferred<void>()
    const published = deferred<void>()
    URL.createObjectURL = () => `blob:${++number}`
    URL.revokeObjectURL = (url) => { revoked.push(url) }
    globalThis.Image = class { src = ''; decode() { return this.src === 'blob:2' ? decode.promise : Promise.resolve() } } as unknown as typeof Image
    let urls: Record<string, string> = {}
    let waitForPaint = false
    const manager = createTargetThumbnails(async () => new Uint8Array([1]), (next) => { urls = next; if (next.sprite === 'blob:2') published.resolve() }, () => waitForPaint ? painted.promise : Promise.resolve())
    await manager.refresh([source('old')])
    await manager.refresh([source('old')])
    expect(number).toBe(1)
    waitForPaint = true
    const update = manager.refresh([source('new')])
    await Promise.resolve(); await Promise.resolve()
    expect(urls.sprite).toBe('blob:1')
    decode.resolve()
    await published.promise
    expect(urls.sprite).toBe('blob:2')
    expect(revoked).toEqual([])
    painted.resolve()
    await update
    expect(revoked).toEqual(['blob:1'])
    manager.reset()
    expect(revoked).toEqual(['blob:1', 'blob:2'])
  })

  it('discards stale decoded URLs on overlapping refresh and reset', async () => {
    let number = 0
    const revoked: string[] = []
    const decode = deferred<void>()
    URL.createObjectURL = () => `blob:${++number}`
    URL.revokeObjectURL = (url) => { revoked.push(url) }
    globalThis.Image = class { src = ''; decode() { return this.src === 'blob:1' ? decode.promise : Promise.resolve() } } as unknown as typeof Image
    let urls: Record<string, string> = {}
    const manager = createTargetThumbnails(async () => new Uint8Array([1]), (next) => { urls = next }, async () => {})
    const old = manager.refresh([source('old')])
    await Promise.resolve()
    await manager.refresh([source('new')])
    decode.resolve()
    await old
    expect(urls.sprite).toBe('blob:2')
    expect(revoked).toEqual(['blob:1'])
    manager.reset()
    expect(urls).toEqual({})
    expect(revoked).toEqual(['blob:1', 'blob:2'])
  })

  it('invalidates an in-flight decode when reset', async () => {
    const decode = deferred<void>()
    const revoked: string[] = []
    URL.createObjectURL = () => 'blob:pending'
    URL.revokeObjectURL = (url) => { revoked.push(url) }
    globalThis.Image = class { src = ''; decode() { return decode.promise } } as unknown as typeof Image
    let urls: Record<string, string> = {}
    const manager = createTargetThumbnails(async () => new Uint8Array([1]), (next) => { urls = next }, async () => {})
    const pending = manager.refresh([source('old')])
    await Promise.resolve()
    manager.reset()
    decode.resolve()
    await pending
    expect(urls).toEqual({})
    expect(revoked).toEqual(['blob:pending'])
  })

  it('retains the previous image on decode failure and removes deleted targets', async () => {
    let number = 0
    const revoked: string[] = []
    URL.createObjectURL = () => `blob:${++number}`
    URL.revokeObjectURL = (url) => { revoked.push(url) }
    globalThis.Image = class { src = ''; async decode() { if (this.src === 'blob:2') throw Error('bad') } } as unknown as typeof Image
    let urls: Record<string, string> = {}
    const manager = createTargetThumbnails(async () => new Uint8Array([1]), (next) => { urls = next }, async () => {})
    await manager.refresh([source('old')])
    await manager.refresh([source('bad')])
    expect(urls.sprite).toBe('blob:1')
    expect(revoked).toEqual(['blob:2'])
    await manager.refresh([])
    expect(urls).toEqual({})
    expect(revoked).toEqual(['blob:2', 'blob:1'])
  })
})
