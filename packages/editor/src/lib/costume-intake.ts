// Costume intake metadata (clean-room, no third-party paint source).
//
// - Library imports respect the Scratch library JSON item metadata
//   (`bitmapResolution` / `rotationCenterX|Y`) verbatim. Fallbacks apply only
//   when the item omits metadata (never for the bundled 978-item library).
// - File uploads follow scratch `file-uploader` / `load-costume` observable
//   behavior: bitmaps resolve at resolution 2 with the rotation center at the
//   actual image middle (width/2, height/2). SVG uploads keep the editor's
//   existing forced centers (handled by callers, not here).
// - Dimension decoding is sync-first (IHDR / SOF / GIF / BMP headers) with an
//   async Image fallback. Failures throw so callers can report via `status`
//   without touching stored assets.

export type LibraryIntakeItem = {
  dataFormat?: string
  bitmapResolution?: unknown
  rotationCenterX?: unknown
  rotationCenterY?: unknown
}

export type LibraryIntakeMeta = {
  bitmapResolution: number
  rotationCenterX: number
  rotationCenterY: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeResolution(value: unknown, fallback: number): number {
  if (isFiniteNumber(value) && (value as number) > 0) return value as number
  return fallback > 0 ? fallback : 1
}

function normalizeCenter(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? (value as number) : fallback
}

/**
 * Resolve library costume/backdrop metadata, respecting item metadata.
 * SVG stays at resolution 1; bitmaps default to 2 when the item omits it.
 * Centers fall back to stage/sprite defaults only when missing.
 */
export function libraryCostumeIntakeMeta(item: LibraryIntakeItem, targetIsStage: boolean): LibraryIntakeMeta {
  const isSvg = item.dataFormat === 'svg'
  const bitmapResolution = isSvg ? 1 : normalizeResolution(item.bitmapResolution, 2)
  const fallbackX = targetIsStage ? (bitmapResolution === 2 ? 480 : 240) : 48
  // Sprite default Y is 50 (vm spriteCostume); stage Y is 180/360 by resolution.
  const fallbackY = targetIsStage ? (bitmapResolution === 2 ? 360 : 180) : 50
  return {
    bitmapResolution,
    rotationCenterX: normalizeCenter(item.rotationCenterX, fallbackX),
    rotationCenterY: normalizeCenter(item.rotationCenterY, fallbackY),
  }
}

/** Minimal PNG IHDR parse. Returns undefined when not a PNG. */
export function pngDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    if (!bytes || bytes.length < 33) return undefined
    // 8-byte signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d ||
      bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a ||
      bytes[7] !== 0x0a
    ) {
      return undefined
    }
    // First chunk must be IHDR (length 13 at offset 8, type at 12..15).
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined
    const width = (bytes[16]! * 0x1000000 + bytes[17]! * 0x10000 + bytes[18]! * 0x100 + bytes[19]!) >>> 0
    const height = (bytes[20]! * 0x1000000 + bytes[21]! * 0x10000 + bytes[22]! * 0x100 + bytes[23]!) >>> 0
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
    if (width > 20000 || height > 20000) return undefined
    return { width, height }
  } catch {
    return undefined
  }
}

/** Minimal GIF header parse (GIF87a/GIF89a, width/height LE at 6..9). */
export function gifDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    if (!bytes || bytes.length < 10) return undefined
    if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined
    const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8)
    const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8)
    if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return undefined
    return { width, height }
  } catch {
    return undefined
  }
}

/** Minimal BMP header parse (BM, width/height at 18..25). */
export function bmpDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    if (!bytes || bytes.length < 26) return undefined
    if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = Math.abs(view.getInt32(18, true))
    const height = Math.abs(view.getInt32(22, true))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
    if (width > 20000 || height > 20000) return undefined
    return { width, height }
  } catch {
    return undefined
  }
}

/** Minimal JPEG SOF parse (scan for SOF0..SOF3/C2 markers). */
export function jpegDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    if (!bytes || bytes.length < 4) return undefined
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1] ?? 0
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (exclude DHT/DAC/SOI).
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (marker === 0xd9 || marker === 0xda) return undefined // EOI / SOS: no SOF found
      if (offset + 3 >= bytes.length) return undefined
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
      if (length < 2) return undefined
      if (isSof) {
        if (offset + 9 >= bytes.length) return undefined
        const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
        const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
        if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return undefined
        return { width, height }
      }
      offset += 2 + length
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Sync-first bitmap dimension sniff (PNG/JPEG/GIF/BMP). */
export function bitmapDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | undefined {
  return (
    pngDimensionsFromBytes(bytes) ??
    jpegDimensionsFromBytes(bytes) ??
    gifDimensionsFromBytes(bytes) ??
    bmpDimensionsFromBytes(bytes)
  )
}

function decodeViaImageElement(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') {
        reject(new Error('image decode unavailable'))
        return
      }
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      const cleanup = () => {
        try {
          URL.revokeObjectURL(url)
        } catch {
          // ignore
        }
      }
      img.onload = () => {
        const width = img.naturalWidth
        const height = img.naturalHeight
        cleanup()
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          resolve({ width, height })
        } else {
          reject(new Error('Could not decode image dimensions'))
        }
      }
      img.onerror = () => {
        cleanup()
        reject(new Error('Could not decode image dimensions'))
      }
      img.src = url
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not decode image dimensions'))
    }
  })
}

/**
 * Resolve bitmap dimensions for a file-upload intake. Sync header sniff wins;
 * the async Image fallback covers encodings the sniff misses. Throws on
 * failure so callers can report without mutating stored assets.
 */
export async function decodeBitmapDimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const sync = bitmapDimensionsFromBytes(bytes)
  if (sync) return sync
  return decodeViaImageElement(bytes)
}

/**
 * Resolve the Scratch file-upload intake for a bitmap: resolution 2 with the
 * rotation center at the actual image middle. Throws when dimensions cannot
 * be determined.
 */
export async function bitmapUploadIntakeMeta(bytes: Uint8Array): Promise<LibraryIntakeMeta & { width: number; height: number }> {
  const { width, height } = await decodeBitmapDimensions(bytes)
  return {
    bitmapResolution: 2,
    rotationCenterX: width / 2,
    rotationCenterY: height / 2,
    width,
    height,
  }
}
