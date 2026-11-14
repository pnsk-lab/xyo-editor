import { sanitizeSvgForDisplay } from '../costumes/svg-sanitize'

export interface CostumeThumbnailEntry {
  assetKey: string
  url: string
}

/** Decode before publishing a new URL so the previous thumbnail remains visible. */
export async function loadCostumeThumbnail(bytes: Uint8Array, dataFormat: string): Promise<string | undefined> {
  // Thumbnails render through `<img>` (no script execution), but sanitize SVG
  // bytes first so a stored payload cannot linger in a blob URL.
  let source: Uint8Array = bytes
  if (dataFormat === 'svg') {
    try {
      source = new TextEncoder().encode(sanitizeSvgForDisplay(new TextDecoder().decode(bytes)))
    } catch {
      source = bytes
    }
  }
  const type = dataFormat === 'svg' ? 'image/svg+xml' : dataFormat === 'jpg' ? 'image/jpeg' : dataFormat === 'png' ? 'image/png' : 'application/octet-stream'
  const url = URL.createObjectURL(new Blob([new Uint8Array(source)], { type }))
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
