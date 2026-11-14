import { describe, expect, it } from 'bun:test'
import {
  VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS,
  buildVectorEyedropperCacheKey,
  gatedRefreshVectorEyedropperCache,
  isVectorEyedropperKeyCurrent,
  type VectorEyedropperSnapshot,
} from '../src/features/costumes/eyedropper'

// Collision + race gate for the vector eyedropper raster cache.
//
// The pre-fix key was a vulnerable 32-bit FNV-1a (`<len>:<hex>`). This suite
// proves deterministically that two DISTINCT valid same-length SVGs share one
// FNV-32 value (same deterministic birthday search as
// `vector-reshape-selection-history-collision.test.ts`, fixed seed, <=200k
// candidates), so a hash can NEVER authorize cache reuse. The post-fix key is
// the exact SVG string plus dimensions: the colliding pair must produce
// different keys, and the async gate must discard a held decode that resolves
// after a same-length external replacement or a target switch, with bounded
// retry and no stale install / no VM edit.

const textEncoder = new TextEncoder()

function fnv1a32Legacy(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${bytes.length}:${hash.toString(16)}`
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0)
  }
}

const HEX_DIGITS = '0123456789abcdef'

function svgForToken(token: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg"><g id="v"><rect width="8" height="8" fill="red"/></g><!--${token}--></svg>`
}

function svgBytesForToken(token: string): Uint8Array {
  return textEncoder.encode(svgForToken(token))
}

function findFnvCollision(): { a: string; b: string } {
  const random = mulberry32(1)
  const seen = new Map<string, string>()
  for (let n = 0; n < 200000; n += 1) {
    let token = ''
    for (let k = 0; k < 8; k += 1) token += HEX_DIGITS[random() % 16]
    const svg = svgForToken(token)
    const digest = fnv1a32Legacy(textEncoder.encode(svg))
    const prev = seen.get(digest)
    if (prev !== undefined) {
      if (prev === svg) continue
      return { a: prev, b: svg }
    }
    seen.set(digest, svg)
  }
  throw new Error('no FNV-1a 32 collision within 200k deterministic candidates')
}

describe('eyedropper exact-string cache key vs FNV-32 collision', () => {
  it('uses exact strings, no hashes: colliding SVGs get different keys', () => {
    const { a, b } = findFnvCollision()
    expect(a).not.toBe(b)
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(0)
    for (const svg of [a, b] as const) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
      expect(svg).toContain('<!--')
    }
    const bytesA = textEncoder.encode(a)
    const bytesB = textEncoder.encode(b)
    // Pre-fix product: FNV equality accepts different artwork as fresh.
    expect(fnv1a32Legacy(bytesA)).toBe(fnv1a32Legacy(bytesB))
    // Post-fix: exact-string keys distinguish the pair. The key embeds the
    // full source (no hash), so no short digest can alias them.
    const keyA = buildVectorEyedropperCacheKey(a, 96, 96)
    const keyB = buildVectorEyedropperCacheKey(b, 96, 96)
    expect(keyA).not.toBe(keyB)
    expect(keyA).toContain(a)
    expect(keyB).toContain(b)
    expect(isVectorEyedropperKeyCurrent(keyA, keyB)).toBe(false)
    expect(isVectorEyedropperKeyCurrent(keyA, keyA)).toBe(true)
    // Dimensions are part of the identity: same SVG at different sizes differs.
    expect(buildVectorEyedropperCacheKey(a, 96, 96)).not.toBe(buildVectorEyedropperCacheKey(a, 97, 96))
  })

  it('bounded attempts constant exists for the Svelte retry loops', () => {
    expect(VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS).toBe(3)
  })
})

describe('eyedropper gated refresh: held decode + same-length replacement', () => {
  function makeDeferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('discards a held raster when the SVG changes mid-decode, returns current (no stale sample)', async () => {
    const { a, b } = findFnvCollision()
    // Same-length external replacement: the colliding pair is same-length by construction.
    expect(a.length).toBe(b.length)
    let liveSvg = a
    const W = 96
    const H = 96
    const readSnapshot = (): VectorEyedropperSnapshot => ({
      key: buildVectorEyedropperCacheKey(liveSvg, W, H),
      svgText: liveSvg,
      width: W,
      height: H,
    })
    const rasterizedFor: string[] = []
    let held: { promise: Promise<{ canvas: unknown; scale: number } | undefined>; resolve: (v: { canvas: unknown; scale: number } | undefined) => void } | undefined
    let calls = 0
    const rasterize = async (snap: VectorEyedropperSnapshot) => {
      calls += 1
      rasterizedFor.push(snap.svgText)
      if (calls === 1) {
        // First decode is held: the UI replaces the SVG (same length, different
        // pixels) while the raster is still in flight.
        held = makeDeferred()
        // Deterministic switch before resolve.
        liveSvg = b
        const out = await held.promise
        return out as unknown as { canvas: HTMLCanvasElement; scale: number }
      }
      // Retry decodes the current artwork.
      return { canvas: { __tag: snap.svgText } as unknown as HTMLCanvasElement, scale: 3 }
    }
    const gate = gatedRefreshVectorEyedropperCache(readSnapshot, rasterize, () => false, 3)
    // Let the first rasterize start and hold.
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(1)
    expect(rasterizedFor[0]).toBe(a)
    // Resolve the held decode with STALE pixels (for artwork A).
    const staleCanvas = { __tag: a } as unknown as HTMLCanvasElement
    held!.resolve({ canvas: staleCanvas, scale: 3 })
    const result = await gate
    // Bounded retry: the stale first attempt is discarded, the second attempt
    // rasterizes the current artwork. No stale sample survives.
    expect(calls).toBe(2)
    expect(rasterizedFor[1]).toBe(b)
    expect(result).toBeDefined()
    expect(result!.key).toBe(buildVectorEyedropperCacheKey(b, W, H))
    expect((result!.raster!.canvas as unknown as { __tag: string }).__tag).toBe(b)
    expect((result!.raster!.canvas as unknown as { __tag: string }).__tag).not.toBe(a)
  })

  it('selection-target switch / cancel during decode discards with no install', async () => {
    const { a, b } = findFnvCollision()
    let liveSvg = a
    const readSnapshot = (): VectorEyedropperSnapshot => ({
      key: buildVectorEyedropperCacheKey(liveSvg, 96, 96),
      svgText: liveSvg,
      width: 96,
      height: 96,
    })
    let cancelled = false
    const gate = gatedRefreshVectorEyedropperCache(
      readSnapshot,
      async (snap) => {
        // Target switches while the decode is in flight (same-length or not).
        liveSvg = b
        cancelled = true
        await new Promise((r) => setTimeout(r, 0))
        return { canvas: { __tag: snap.svgText } as unknown as HTMLCanvasElement, scale: 3 }
      },
      () => cancelled,
      3,
    )
    const result = await gate
    // Owner switch/cancel: no accidental cache. The caller must not install.
    expect(result).toBeUndefined()
  })

  it('persistent churn discards after a bounded number of decodes (no spin)', async () => {
    let liveSvg = svgForToken('aaaaaaaa')
    let n = 0
    const readSnapshot = (): VectorEyedropperSnapshot => ({
      key: buildVectorEyedropperCacheKey(liveSvg, 96, 96),
      svgText: liveSvg,
      width: 96,
      height: 96,
    })
    let calls = 0
    const result = await gatedRefreshVectorEyedropperCache(
      readSnapshot,
      async (snap) => {
        calls += 1
        // Every decode observes a newer artwork on completion: never settles.
        n += 1
        liveSvg = svgForToken(String(n).padStart(8, '0'))
        await new Promise((r) => setTimeout(r, 0))
        return { canvas: { __tag: snap.svgText } as unknown as HTMLCanvasElement, scale: 3 }
      },
      () => false,
      VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS,
    )
    expect(result).toBeUndefined()
    expect(calls).toBe(VECTOR_EYEDROPPER_CACHE_MAX_ATTEMPTS)
  })
})
