import { afterEach, describe, expect, it } from 'bun:test'
import { loadCostumeThumbnail, thumbnailUrls } from '../src/features/AssetLibrary/costume-thumbnails'

describe('costume thumbnails', () => {
  const originalImage = globalThis.Image
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  afterEach(() => {
    globalThis.Image = originalImage
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  })

  it('waits for decoding before publishing the object URL', async () => {
    let finish!: () => void
    const decoded = new Promise<void>((resolve) => { finish = resolve })
    URL.createObjectURL = () => 'blob:new'
    globalThis.Image = class { src = ''; decode() { return decoded } } as unknown as typeof Image
    let published = false
    const result = loadCostumeThumbnail(new Uint8Array([1]), 'png').then((url) => { published = true; return url })
    await Promise.resolve()
    expect(published).toBe(false)
    finish()
    expect(await result).toBe('blob:new')
  })

  it('revokes a URL whose image cannot be decoded', async () => {
    const revoked: string[] = []
    URL.createObjectURL = () => 'blob:invalid'
    URL.revokeObjectURL = (url) => { revoked.push(url) }
    globalThis.Image = class { src = ''; async decode() { throw new Error('invalid image') } } as unknown as typeof Image
    expect(await loadCostumeThumbnail(new Uint8Array([1]), 'svg')).toBeUndefined()
    expect(revoked).toEqual(['blob:invalid'])
  })

  it('preserves stable slot keys when mapping entries to URLs', () => {
    expect(thumbnailUrls({ 'sprite:0': { assetKey: 'new.svg:svg', url: 'blob:new' } })).toEqual({ 'sprite:0': 'blob:new' })
  })
})
