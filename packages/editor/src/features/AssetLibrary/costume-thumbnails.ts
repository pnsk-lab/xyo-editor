export interface CostumeThumbnailEntry {
  assetKey: string
  url: string
}

/** Decode before publishing a new URL so the previous thumbnail remains visible. */
export async function loadCostumeThumbnail(bytes: Uint8Array, dataFormat: string): Promise<string | undefined> {
  const type = dataFormat === 'svg' ? 'image/svg+xml' : dataFormat === 'jpg' ? 'image/jpeg' : dataFormat === 'png' ? 'image/png' : 'application/octet-stream'
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return url
  } catch {
    URL.revokeObjectURL(url)
    return undefined
  }
}

export function thumbnailUrls(entries: Record<string, CostumeThumbnailEntry>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.url]))
}
