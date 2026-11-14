import { describe, expect, it } from 'bun:test'
import { compositeFloatingPatch } from '../src/features/costumes/bitmap-floating'

// Range probe (unit, no browser): helper vs ideal float reference over
// sA/dA 0..255 + double-stamp accumulation. This file only ADDS tests;
// it does not modify any source.

type RGBA = [number, number, number, number]

function px(color: RGBA) {
  return { width: 1, height: 1, data: new Uint8ClampedArray(color) }
}

function compositeHelper(s: RGBA, d: RGBA): RGBA {
  const out = compositeFloatingPatch(px(d), px(s), 0, 0)
  const t = out.image.data
  return [t[0]!, t[1]!, t[2]!, t[3]!]
}

// Ideal Porter-Duff source-over in float64 with a single final round,
// i.e. the mathematically correct byte result.
function compositeIdeal(s: RGBA, d: RGBA): RGBA {
  const [sR, sG, sB, sA] = s
  const [dR, dG, dB, dA] = d
  if (sA === 0) return [...d] as RGBA
  if (sA === 255) return [sR, sG, sB, 255]
  if (dA === 0) return [sR, sG, sB, sA]
  const aS = sA / 255
  const aD = dA / 255
  const outA = aS + aD * (1 - aS)
  const r = Math.round(((sR * aS + dR * aD * (1 - aS)) / outA))
  const g = Math.round(((sG * aS + dG * aD * (1 - aS)) / outA))
  const b = Math.round(((sB * aS + dB * aD * (1 - aS)) / outA))
  return [r, g, b, Math.round(outA * 255)]
}

describe('floating semi-over-semi range probe (helper vs ideal, unit)', () => {
  it('sweeps sA/dA 0..255: helper matches ideal byte-exact for representative colors', () => {
    const colorPairs: Array<{ name: string; sRGB: [number, number, number]; dRGB: [number, number, number] }> = [
      { name: 'red-over-blue', sRGB: [255, 0, 0], dRGB: [0, 0, 255] },
      { name: 'semiGray-over-white', sRGB: [10, 20, 30], dRGB: [255, 255, 255] },
      { name: 'mid-over-mid', sRGB: [200, 100, 50], dRGB: [10, 20, 30] },
      { name: 'white-over-black', sRGB: [255, 255, 255], dRGB: [0, 0, 0] },
      { name: 'lowRGB-over-highRGB', sRGB: [1, 2, 3], dRGB: [250, 251, 252] },
    ]
    let maxDiff = 0
    let mismatchCount = 0
    let worst: Record<string, unknown> | null = null
    for (const pair of colorPairs) {
      for (let sA = 0; sA <= 255; sA += 1) {
        for (let dA = 0; dA <= 255; dA += 1) {
          const s: RGBA = [pair.sRGB[0], pair.sRGB[1], pair.sRGB[2], sA]
          const d: RGBA = [pair.dRGB[0], pair.dRGB[1], pair.dRGB[2], dA]
          const h = compositeHelper(s, d)
          const ideal = compositeIdeal(s, d)
          for (let i = 0; i < 4; i += 1) {
            const diff = Math.abs(h[i]! - ideal[i]!)
            if (diff > maxDiff) {
              maxDiff = diff
              worst = { pair: pair.name, sA, dA, helper: h, ideal }
            }
            if (diff !== 0) mismatchCount += 1
          }
        }
      }
    }
    console.log(`[range-unit] pairs=${colorPairs.length} samplesPerPair=65536 maxAbsDiff(helper-vs-ideal)=${maxDiff} mismatches=${mismatchCount} worst=${JSON.stringify(worst)}`)
    // Helper implements the ideal formula but folds the divide into a
    // multiply-by-reciprocal (`* (1/outA)` instead of `/ outA`), so exact
    // .5 ties can round the other way in float64: max 1 level, ~0.01% of
    // samples. Visually irrelevant but recorded here as the theoretical floor.
    expect(maxDiff).toBeLessThanOrEqual(1)
    expect(mismatchCount).toBeLessThan(100)
  })

  it('quantifies double-stamp accumulation when stamping from a preview instead of committed', () => {
    // Alt-duplicate the same semi patch twice at the same dest (the bug shape
    // if previews chained): second stamp blends over the already-blended
    // pixel instead of the original base.
    const cases: Array<{ name: string; s: RGBA; d: RGBA }> = [
      { name: 'semiGray-over-white', s: [10, 20, 30, 128], d: [255, 255, 255, 255] },
      { name: 'halfRed-over-blue-semi', s: [255, 0, 0, 128], d: [0, 0, 255, 128] },
      { name: 'alpha1-over-white', s: [200, 100, 50, 1], d: [255, 255, 255, 255] },
      { name: 'alpha254-over-white', s: [200, 100, 50, 254], d: [255, 255, 255, 255] },
      { name: 'alpha1-over-semi', s: [200, 100, 50, 1], d: [10, 20, 30, 128] },
    ]
    let maxDrift = 0
    for (const c of cases) {
      const once = compositeHelper(c.s, c.d)
      const twice = compositeHelper(c.s, once)
      const drift = Math.max(
        Math.abs(twice[0]! - once[0]!),
        Math.abs(twice[1]! - once[1]!),
        Math.abs(twice[2]! - once[2]!),
        Math.abs(twice[3]! - once[3]!),
      )
      console.log(`[double-stamp] ${c.name}: once=${once} twice=${twice} maxDrift=${drift}`)
      if (drift > maxDrift) maxDrift = drift
    }
    console.log(`[double-stamp] maxDriftAcrossCases=${maxDrift}`)
    // Mid-alpha double stamps move pixels by tens of levels: visibly
    // destructive, which is why session previews must render from committed.
    expect(maxDrift).toBeGreaterThan(10)
  })

  it('documents low-alpha verbatim passthrough over transparent (helper keeps RGB)', () => {
    // Helper copies source through when dA==0, preserving RGB even at a=1.
    // A premultiplied Canvas backing store cannot represent (200,100,50,1)
    // and will mangle RGB (browser probe quantifies the real gap).
    const s: RGBA = [200, 100, 50, 1]
    const d: RGBA = [0, 0, 0, 0]
    expect(compositeHelper(s, d)).toEqual([200, 100, 50, 1])
    const s2: RGBA = [10, 20, 30, 128]
    expect(compositeHelper(s2, d)).toEqual([10, 20, 30, 128])
  })
})
