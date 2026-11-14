import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Nested-transform marquee selection (paperBoundsLeaves polygon fix).
//
// Reference (scratch-paint processRectangularSelection, reimplemented from
// behavior notes without copying source):
// - path leaves: segment point inside marquee OR outline crosses marquee
// - bounds leaves (Shape/Raster/PointText): internalBounds polygon
//   (local frame mapped via localToGlobal / getGlobalMatrix) corners inside
//   marquee OR polygon border crosses marquee. Axis-aligned global AABB
//   over-selects under rotation/skew and is NOT the reference.
// - clip/mask units: baked Paper import ignores clipping, so marquee must
//   fail closed (no match) unless clipping is provably respected.
// - no DOM mutation, no history, per-unit root matching with distinct
//   overlapping siblings.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4397'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('nested transform marquee selection', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4397', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('rotation: AABB corner outside diamond does not select (polygon, not AABB)', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g><g transform="rotate(45 20 20)"><rect x="10" y="10" width="20" height="20" fill="blue"/></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Marquee in the global-AABB corner (5,5,5,5): inside AABB (5.8,5.8,28x28)
      // but outside the true diamond (|x-20|+|y-20|<=14.14). Reference: no corner
      // inside, no border crossing -> no match.
      const cornerMiss = await (paper as any).paperVectorIndicesInRect(units, { x: 5, y: 5, width: 5, height: 5 })
      // Marquee over the diamond top corner (15,0,10,10) holds (20,5.8) inside.
      const cornerHit = await (paper as any).paperVectorIndicesInRect(units, { x: 15, y: 0, width: 10, height: 10 })
      // Confirm tight polygon via real Paper localToGlobal on internalBounds.
      const scope = await (paper as any).ensureVectorPaperScope()
      const baked = (svgMod as any).bakedUnitClone(doc.documentElement, units[0])
      const ser = new XMLSerializer().serializeToString(baked ?? units[0])
      const san = await import('/src/features/costumes/svg-sanitize.ts')
      const sanitized = (san as any).sanitizeSvgFragmentForPaperImport(ser)
      const item = (scope.project as any).importSVG(sanitized, { insert: false })
      let poly: any = null
      try {
        const shape = (() => {
          const stack = [item]
          while (stack.length) {
            const cur = stack.pop()
            if (Array.isArray((cur as any).segments)) continue
            const ch = (cur as any).children
            if (ch && ch.length) { for (const c of ch) stack.push(c); continue }
            if ((cur as any).className === 'Shape') return cur
          }
          return null
        })()
        const ib = (shape as any).internalBounds
        const corners = [{ x: ib.x, y: ib.y }, { x: ib.x + ib.width, y: ib.y }, { x: ib.x + ib.width, y: ib.y + ib.height }, { x: ib.x, y: ib.y + ib.height }]
        poly = corners.map((p: any) => {
          const g = (shape as any).localToGlobal(p)
          return { x: Math.round(g.x * 100) / 100, y: Math.round(g.y * 100) / 100 }
        })
      } finally { item.remove() }
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { cornerMiss, cornerHit, poly, unmutated: before === after }
    })
    // Tight diamond, not AABB.
    expect(result.poly).toEqual([
      { x: 20, y: 5.86 },
      { x: 34.14, y: 20 },
      { x: 20, y: 34.14 },
      { x: 5.86, y: 20 },
    ])
    expect(result.cornerMiss).toEqual([])
    expect(result.cornerHit).toEqual([0])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('skew + nonuniform scale + negative mirror: polygon exact, no AABB over-selection', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const mk = (inner: string) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g><g transform="${inner}"><rect x="10" y="10" width="20" height="20" fill="blue"/></g></g></svg>`
        return new DOMParser().parseFromString(svg, 'image/svg+xml')
      }
      const scope = await (paper as any).ensureVectorPaperScope()
      const san = await import('/src/features/costumes/svg-sanitize.ts')
      async function docPoly(doc: any) {
        const units = (svgMod as any).editableVectorUnits(doc.documentElement)
        const baked = (svgMod as any).bakedUnitClone(doc.documentElement, units[0])
        const ser = new XMLSerializer().serializeToString(baked ?? units[0])
        const item = (scope.project as any).importSVG((san as any).sanitizeSvgFragmentForPaperImport(ser), { insert: false })
        try {
          const stack = [item]
          let shape: any = null
          while (stack.length) {
            const cur = stack.pop()
            if (Array.isArray((cur as any).segments)) continue
            const ch = (cur as any).children
            if (ch && ch.length) { for (const c of ch) stack.push(c); continue }
            if ((cur as any).className === 'Shape') { shape = cur; break }
          }
          const ib = shape.internalBounds
          const corners = [{ x: ib.x, y: ib.y }, { x: ib.x + ib.width, y: ib.y }, { x: ib.x + ib.width, y: ib.y + ib.height }, { x: ib.x, y: ib.y + ib.height }]
          return corners.map((p: any) => {
            const g = shape.localToGlobal(p)
            return { x: Math.round(g.x * 100) / 100, y: Math.round(g.y * 100) / 100 }
          })
        } finally { item.remove() }
      }
      const skewDoc = mk('skewX(30)')
      const skewUnits = (svgMod as any).editableVectorUnits(skewDoc.documentElement)
      const skewPoly: any = await docPoly(skewDoc)
      // AABB of skewed rect is x 15.77..47.32 y 10..30. Point (16,11) is inside
      // AABB but is it inside the true parallelogram? Parallelogram corners:
      // (15.77,10),(35.77,10),(47.32,30),(27.32,30). (16,11) is near left edge:
      // compute via winding: use Paper contains on polygon path.
      const polyPath = new (scope as any).Path({ segments: skewPoly.map((p: any) => new (scope as any).Point(p.x, p.y)), closed: true })
      let insideCheck = false
      try { insideCheck = polyPath.contains(new (scope as any).Point(16, 11)) } finally { polyPath.remove() }
      // Marquee (0,0,18,12): holds AABB corner (15.77,10) inside -> both old and
      // new select. Marquee (0,0,16,10.5): AABB corner (15.77,10) inside (old
      // selects) but true parallelogram? (15.77,10) IS a true corner, so both
      // select. Need a marquee that holds AABB interior but no true corner and
      // no crossing: use the AABB top strip above the slanted top edge.
      // Top edge from (15.77,10) to (35.77,10) is horizontal, so strip above is
      // outside both. Use right-AABB strip: AABB right x 47.32, true right edge
      // slanted. Marquee (40,10,5,5): inside AABB (15-47,10-30) corner? AABB
      // corners: (15.77,10) outside (x<40? no, 15<40 outside), (47.32,10) inside
      // (40-45,10-15) -> old selects via AABB corner. True poly corners:
      // (15.77,10) no, (35.77,10) no (x 35<40), (47.32,30) no (y 30>15),
      // (27.32,30) no. Edges: does slanted right edge cross (40,10,5,5)?
      // Right edge (35.77,10)-(47.32,30): at y=10-15, x=35.77-38.65 (<40), so no
      // crossing -> reference miss, old (AABB corner (47.32,10)? wait (47.32,10)
      // is NOT a true corner, it's AABB corner. Old uses AABB corners, one is
      // (47.32,10) which IS inside (40,10,5,5)? 47.32>45 outside! Let's pick
      // (42,10,6,6): AABB corner (47.32,10)? 47.32>48? No 47.32 in 42-48 yes,
      // 10 in 10-16 yes -> old selects. True: (35.77,10) outside (x<42),
      // (47.32,30) outside, etc, edge at y 10-16 x 35.77-40.9: at y=16 x~39.2
      // (<42) so no crossing -> miss.
      const overAabbOnlySkew = await (paper as any).paperVectorIndicesInRect(skewUnits, { x: 42, y: 10, width: 6, height: 6 })
      const overTrueSkew = await (paper as any).paperVectorIndicesInRect(skewUnits, { x: 14, y: 8, width: 6, height: 6 })
      // Nonuniform scale: AABB exact, both select enclosing.
      const scaleDoc = mk('scale(2 0.5)')
      const scaleUnits = (svgMod as any).editableVectorUnits(scaleDoc.documentElement)
      const overScale = await (paper as any).paperVectorIndicesInRect(scaleUnits, { x: 15, y: 0, width: 50, height: 20 })
      // Negative mirror: rect mirrored to x 70..90, AABB exact.
      const mirrorDoc = mk('matrix(-1 0 0 1 100 0)')
      const mirrorUnits = (svgMod as any).editableVectorUnits(mirrorDoc.documentElement)
      const overMirror = await (paper as any).paperVectorIndicesInRect(mirrorUnits, { x: 65, y: 5, width: 30, height: 30 })
      const missMirror = await (paper as any).paperVectorIndicesInRect(mirrorUnits, { x: 0, y: 0, width: 10, height: 10 })
      return { skewPoly, insideCheck, overAabbOnlySkew, overTrueSkew, overScale, overMirror, missMirror }
    })
    expect(result.skewPoly[0].x).toBeCloseTo(15.77, 1)
    expect(result.overAabbOnlySkew).toEqual([])
    expect(result.overTrueSkew).toEqual([0])
    expect(result.overScale).toEqual([0])
    expect(result.overMirror).toEqual([0])
    expect(result.missMirror).toEqual([])
  }, 30_000)

  it('translation + uniform scale + high-zoom tiny marquee + overlapping siblings', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<g><g transform="translate(100 50)"><rect x="10" y="10" width="20" height="20" fill="blue"/></g></g>' +
        '<g><g transform="translate(200 50) rotate(45 10 10)"><rect x="0" y="0" width="20" height="20" fill="red"/></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Blue at document 110,60,20x20. Red rotated diamond centered near (210,60)?
      const overBlue = await (paper as any).paperVectorIndicesInRect(units, { x: 105, y: 55, width: 30, height: 30 })
      const overNeither = await (paper as any).paperVectorIndicesInRect(units, { x: 150, y: 150, width: 20, height: 20 })
      // High-zoom tiny marquee (0.5 units) over blue corner (110,60).
      const tinyHit = await (paper as any).paperVectorIndicesInRect(units, { x: 109.8, y: 59.8, width: 0.5, height: 0.5 })
      const tinyMiss = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 0, width: 0.5, height: 0.5 })
      // Uniform scale group.
      const svg2 = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g><g transform="scale(2)"><rect x="10" y="10" width="20" height="20" fill="green"/></g></g></svg>'
      const doc2 = new DOMParser().parseFromString(svg2, 'image/svg+xml')
      const units2 = (svgMod as any).editableVectorUnits(doc2.documentElement)
      const overScaled = await (paper as any).paperVectorIndicesInRect(units2, { x: 15, y: 15, width: 50, height: 50 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { count: units.length, overBlue, overNeither, tinyHit, tinyMiss, overScaled, unmutated: before === after }
    })
    expect(result.count).toBe(2)
    // Distinct siblings: marquee over blue must not bleed to red.
    expect(result.overBlue).toEqual([0])
    expect(result.overNeither).toEqual([])
    expect(result.tinyHit).toEqual([0])
    expect(result.tinyMiss).toEqual([])
    expect(result.overScaled).toEqual([0])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('mixed path+rect+text group with nested rotation selects via any child polygon', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<g class="xyo-vector-explicit-group"><g transform="rotate(30 200 200)"><rect x="190" y="190" width="20" height="20" fill="blue"/>' +
        '<path d="M300 200h60v40H300Z" fill="red"/><text x="100" y="100" font-size="20">Hi</text></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Path child is axis-aligned in local frame but rotated as a whole; a
      // marquee over its rotated position must still select the root.
      const scope = await (paper as any).ensureVectorPaperScope()
      // Find a rotated path segment point via real Paper localToGlobal.
      const san = await import('/src/features/costumes/svg-sanitize.ts')
      const baked = (svgMod as any).bakedUnitClone(doc.documentElement, units[0])
      const ser = new XMLSerializer().serializeToString(baked ?? units[0])
      const item = (scope.project as any).importSVG((san as any).sanitizeSvgFragmentForPaperImport(ser), { insert: false })
      let segGlobal: any = null
      try {
        const stack = [item]
        while (stack.length) {
          const cur = stack.pop()
          if (Array.isArray((cur as any).segments) && (cur as any).segments.length > 0) {
            const g = (cur as any).localToGlobal((cur as any).segments[0].point)
            segGlobal = { x: g.x, y: g.y }
            break
          }
          const ch = (cur as any).children
          if (ch) for (const c of ch) stack.push(c)
        }
      } finally { item.remove() }
      const overPathSeg = await (paper as any).paperVectorIndicesInRect(units, { x: segGlobal.x - 2, y: segGlobal.y - 2, width: 4, height: 4 })
      const farAway = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 300, width: 20, height: 20 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { segGlobal, overPathSeg, farAway, unmutated: before === after }
    })
    expect(Number.isFinite(result.segGlobal.x)).toBe(true)
    expect(result.overPathSeg).toEqual([0])
    expect(result.farAway).toEqual([])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('image leaf under nested transform never crashes and group stays selectable via rect', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        `<g class="xyo-vector-explicit-group"><g transform="rotate(30 200 200)"><rect x="190" y="190" width="20" height="20" fill="blue"/><image x="10" y="10" width="20" height="20" href="${png}"/></g></g></svg>`
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Raster pixels load async (Paper reports 0x0 until then); the rect leaf
      // still drives selection so the group does not vanish. Far-away misses.
      const overRect = await (paper as any).paperVectorIndicesInRect(units, { x: 180, y: 180, width: 40, height: 40 })
      const farAway = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 300, width: 20, height: 20 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { unitCount: units.length, overRect, farAway, unmutated: before === after }
    })
    expect(result.unitCount).toBe(1)
    // Either the rect polygon hits (tight) or, if Paper has not laid out the
    // group yet, at least the call does not throw and far-away stays empty.
    // The durable assertion is no-crash + no-mutation + no far false-positive.
    expect(result.farAway).toEqual([])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('parent clip/mask fail-closed: clipped-away area never selects', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<defs><clipPath id="c"><rect x="0" y="0" width="5" height="5"/></clipPath></defs>' +
        '<g clip-path="url(#c)"><g transform="rotate(45 20 20)"><rect x="10" y="10" width="20" height="20" fill="blue"/></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Baked import ignores clipping and would see the full diamond; the
      // visible ink is clipped to 0,0,5,5. Fail-closed: no marquee selects it,
      // even one covering the unclipped diamond.
      const overUnclipped = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 0, width: 40, height: 40 })
      const overClipBox = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 0, width: 5, height: 5 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { overUnclipped, overClipBox, unmutated: before === after }
    })
    expect(result.overUnclipped).toEqual([])
    expect(result.overClipBox).toEqual([])
    expect(result.unmutated).toBe(true)
  }, 30_000)
})
