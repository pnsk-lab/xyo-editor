import { loadCostumeThumbnail, thumbnailUrls, type CostumeThumbnailEntry } from '../AssetLibrary/costume-thumbnails'

export interface TargetThumbnailSource {
  slot: string
  assetKey: string
  key: string
  format: string
}

/** Owns target thumbnail URLs and only publishes the latest completed refresh. */
export function createTargetThumbnails(
  loadAsset: (key: string, format: string) => Promise<Uint8Array | undefined>,
  publish: (urls: Record<string, string>) => void,
  afterPublish: () => Promise<unknown>,
) {
  let entries: Record<string, CostumeThumbnailEntry> = {}
  let request = 0

  async function refresh(sources: TargetThumbnailSource[]) {
    const current = ++request
    const previous = entries
    const next: Record<string, CostumeThumbnailEntry> = {}
    const created: string[] = []
    await Promise.all(sources.map(async ({ slot, assetKey, key, format }) => {
      const old = previous[slot]
      if (old?.assetKey === assetKey) {
        next[slot] = old
        return
      }
      try {
        const bytes = await loadAsset(key, format)
        if (current !== request) return
        const url = bytes ? await loadCostumeThumbnail(bytes, format) : undefined
        if (url) {
          created.push(url)
          next[slot] = { assetKey, url }
        } else if (old) next[slot] = old
      } catch {
        if (old) next[slot] = old
      }
    }))
    if (current !== request) {
      created.forEach((url) => URL.revokeObjectURL(url))
      return
    }
    entries = next
    publish(thumbnailUrls(next))
    await afterPublish()
    const retained = new Set(Object.values(next).map((entry) => entry.url))
    for (const entry of Object.values(previous)) {
      if (!retained.has(entry.url)) URL.revokeObjectURL(entry.url)
    }
  }

  function invalidate() {
    request += 1
  }

  function reset() {
    invalidate()
    Object.values(entries).forEach((entry) => URL.revokeObjectURL(entry.url))
    entries = {}
    publish({})
  }

  return { refresh, invalidate, reset }
}
