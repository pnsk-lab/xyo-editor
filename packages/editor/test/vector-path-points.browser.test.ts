import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
// Other browser tests use 4173/4178/4179/4180/4183/4189/4197/4198/4213/4227.
const base = 'http://127.0.0.1:4231'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector path points DOM wrappers with transforms', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4231', '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('adds a point on a curve whose parent group is translated (document coords)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black" stroke-width="2"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const curve = doc.querySelector('#curve')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      // Local midpoint of the first cubic is near (25, 30); document frame adds (50, 40).
      // Contract under test: x/y are document coords, same space as moveVectorEditablePoint.
      const add = await mod.addVectorPathPoint(curve, 75, 70)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const outer = doc.querySelector('#outer')!
      return {
        add,
        beforePoints: (before[0] as any).points,
        afterPoints: (after[0] as any)?.points ?? null,
        outerTransform: outer.getAttribute('transform'),
        outerChildCount: outer.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    // Must succeed with document coordinates per the module contract.
    expect(result.add.added).toBe(true)
    const anchors = (result.afterPoints as Array<{ x: number; y: number; kind: string }>).filter((p) => p.kind === 'anchor')
    expect(anchors.some((p) => Math.abs(p.x - 75) < 1.5 && Math.abs(p.y - 70) < 1.5)).toBe(true)
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.outerChildCount).toBe(1)
  }, 30_000)

  it('adds a point on a group that itself carries a transform', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="translate(30 20)">' +
        '<path id="a" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '<path id="b" d="M0 0 L100 0 L100 30" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect x="300" y="200" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const beforeB = ((before[0] as any).points as Array<any>).slice(-3)
      // Local (25, 30) on path #a -> document (55, 50).
      const add = await mod.addVectorPathPoint(target, 55, 50)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const targetAfter = doc.querySelector('#target')!
      return {
        add,
        beforeB,
        afterAll: (after[0] as any)?.points ?? null,
        afterSiblingDoc: (after[1] as any)?.points ?? null,
        targetTransform: targetAfter?.getAttribute('transform'),
        childCount: targetAfter?.children.length,
        childTags: targetAfter ? Array.from(targetAfter.children).map((c) => c.tagName.toLowerCase()) : [],
        siblingKept: !!doc.querySelector('rect'),
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.add.added).toBe(true)
    // Sibling path geometry must survive in document coordinates (last 3 anchors ~ (30,20),(130,20),(130,50)).
    const pts = result.afterAll as Array<{ x: number; y: number; kind: string }>
    expect(pts.some((p) => p.kind === 'anchor' && Math.abs(p.x - 55) < 1.5 && Math.abs(p.y - 50) < 1.5)).toBe(true)
    expect(result.childCount).toBe(2)
    expect(result.childTags).toEqual(['path', 'path'])
    expect(result.siblingKept).toBe(true)
    // Group wrapper transform and sibling document position survive the round-trip.
    expect(result.targetTransform ?? '').toContain('translate(30 20)')
  }, 30_000)

  it('adds a point on a child path that carries its own transform', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target">' +
        '<path id="a" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" transform="translate(10 5)" fill="none" stroke="black"/>' +
        '<path id="b" d="M0 100 L100 100 L100 130" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect x="300" y="200" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      // Local (25, 30) on path #a plus its own translate -> document (35, 35).
      const add = await mod.addVectorPathPoint(target, 35, 35)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      return {
        add,
        beforeDoc: (before[0] as any).points,
        afterDoc: (after[0] as any)?.points ?? null,
        childCount: doc.querySelector('#target')?.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.add.added).toBe(true)
    const pts = result.afterDoc as Array<{ x: number; y: number; kind: string }>
    // New anchor lands at the clicked document position; sibling tail (100,100) stays.
    expect(pts.some((p) => p.kind === 'anchor' && Math.abs(p.x - 35) < 1.5 && Math.abs(p.y - 35) < 1.5)).toBe(true)
    expect(pts.some((p) => p.kind === 'anchor' && Math.abs(p.x - 100) < 1.5 && Math.abs(p.y - 100) < 1.5)).toBe(true)
    expect(result.childCount).toBe(2)
  }, 30_000)

  it('deletes a point under a translated parent and keeps position/appearance/structure', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="quad" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green" stroke="black"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const quad = doc.querySelector('#quad')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      // Quad has 4 anchors; index 1 = local (60,0) -> document (110,40).
      const del = await mod.deleteVectorPathPoint(quad, 1)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const outer = doc.querySelector('#outer')!
      return {
        del,
        beforeAnchors: ((before[0] as any).points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterAnchors: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'anchor'),
        outerTransform: outer.getAttribute('transform'),
        childCount: outer.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.del.deleted).toBe(true)
    // Survivors stay at translated document positions: (50,40), (110,90), (50,90).
    const at = (x: number, y: number) =>
      (result.afterAnchors as Array<{ x: number; y: number }>).some((p) => Math.abs(p.x - x) < 1.5 && Math.abs(p.y - y) < 1.5)
    expect(at(50, 40)).toBe(true)
    expect(at(110, 90)).toBe(true)
    expect(at(50, 90)).toBe(true)
    expect(result.afterAnchors.length).toBe(3)
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.childCount).toBe(1)
  }, 30_000)

  it('deletes a point from a transformed group and keeps siblings/transforms', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="scale(2)">' +
        '<path id="a" d="M0 0 L20 0 L20 15 L0 15 Z" fill="yellow" stroke="black"/>' +
        '<path id="b" d="M100 100 L150 100 L150 120" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect x="10" y="200" width="30" height="20" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      // Flattened: #a owns 0-3, #b owns 4-6. Delete middle anchor of #a (index 1: local (20,0) -> doc (40,0)).
      const del = await mod.deleteVectorPathPoint(target, 1)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const targetAfter = doc.querySelector('#target')!
      return {
        del,
        beforeDoc: (before[0] as any).points,
        afterDoc: (after[0] as any)?.points ?? null,
        targetTransform: targetAfter?.getAttribute('transform'),
        childCount: targetAfter?.children.length,
        siblingKept: !!doc.querySelector('rect'),
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.del.deleted).toBe(true)
    const pts = result.afterDoc as Array<{ x: number; y: number; kind: string }>
    const anchors = pts.filter((p) => p.kind === 'anchor')
    // #a loses one anchor (4->3); #b keeps 3 anchors; survivors at document (0,0),(40,30),(0,30); #b tail at (300,240) stays.
    expect(anchors.length).toBe(6)
    expect(anchors.some((p) => Math.abs(p.x - 0) < 1.5 && Math.abs(p.y - 0) < 1.5)).toBe(true)
    expect(anchors.some((p) => Math.abs(p.x - 300) < 1.5 && Math.abs(p.y - 240) < 1.5)).toBe(true)
    expect(result.childCount).toBe(2)
    expect(result.siblingKept).toBe(true)
    expect(result.targetTransform ?? '').toContain('scale(2)')
  }, 30_000)

  it('re-aims cubic neighbours by the handle ratio under nested transforms, keeping styles', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40) scale(2)">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="#00ff00" stroke="#123456" stroke-width="3"/>' +
        '<path id="sibling" d="M0 0 L20 0 L20 10" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect x="300" y="200" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const curve = doc.querySelector('#curve')!
      // Flattened index 2 = middle anchor (local (40,30) -> doc (130,100)).
      const del = await mod.deleteVectorPathPoint(curve, 2)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const outer = doc.querySelector('#outer')!
      const curveAfter = doc.querySelector('#curve')!
      return {
        del,
        afterPoints: (after[0] as any)?.points ?? null,
        outerTransform: outer.getAttribute('transform'),
        childCount: outer.children.length,
        fill: curveAfter.getAttribute('fill'),
        stroke: curveAfter.getAttribute('stroke'),
        strokeWidth: curveAfter.getAttribute('stroke-width'),
        siblingD: doc.querySelector('#sibling')?.getAttribute('d'),
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.del.deleted).toBe(true)
    const pts = result.afterPoints as Array<{ x: number; y: number; kind: string; controlRole?: string; relatedAnchorIndex?: number }>
    const anchors = pts.filter((p) => p.kind === 'anchor')
    // Survivors at document (70,100) and (190,100), plus the 3 straight
    // sibling anchors (50,40),(90,40),(90,60).
    expect(anchors.length).toBe(5)
    expect(anchors.some((p) => Math.abs(p.x - 70) < 0.5 && Math.abs(p.y - 100) < 0.5)).toBe(true)
    expect(anchors.some((p) => Math.abs(p.x - 190) < 0.5 && Math.abs(p.y - 100) < 0.5)).toBe(true)
    // Exact handle geometry in document space: local handles of +-60*0.3902628565
    // around (10,30)/(70,30), mapped through translate(50 40) scale(2).
    const outHandle = pts.find((p) => p.kind === 'control' && p.controlRole === 'out' && p.relatedAnchorIndex === 0)
    const inHandle = pts.find((p) => p.kind === 'control' && p.controlRole === 'in' && p.relatedAnchorIndex === 2)
    expect(outHandle).toBeDefined()
    expect(inHandle).toBeDefined()
    expect(outHandle!.x).toBeCloseTo(70 + 2 * 60 * 0.3902628565, 1)
    expect(outHandle!.y).toBeCloseTo(100, 1)
    expect(inHandle!.x).toBeCloseTo(190 - 2 * 60 * 0.3902628565, 1)
    expect(inHandle!.y).toBeCloseTo(100, 1)
    // Wrapper transform, sibling geometry, presentation attributes survive.
    expect(result.outerTransform).toBe('translate(50 40) scale(2)')
    expect(result.childCount).toBe(2)
    expect(result.fill).toBe('#00ff00')
    expect(result.stroke).toBe('#123456')
    expect(result.strokeWidth).toBe('3')
    expect(result.siblingD).toBe('M0 0 L20 0 L20 10')
    expect(result.exported).not.toContain('NaN')
  }, 30_000)

  it('bulk-deletes across a transformed group with exact slot bookkeeping', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="scale(2)">' +
        '<path id="a" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '<path id="b" d="M0 100 L50 100 L100 100" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect x="300" y="250" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      // Flattened: #a owns 0-6 (anchors 0,2,5), #b owns 7-9. Delete #b's
      // middle anchor (8, straight) and #a's last anchor (5, cubic end).
      const del = await mod.deleteVectorPathPoints(target, [8, 5])
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const targetAfter = doc.querySelector('#target')!
      return {
        del,
        afterAnchors: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'anchor'),
        targetTransform: targetAfter?.getAttribute('transform'),
        childCount: targetAfter?.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.del.deleted).toBe(true)
    expect(result.del.deletedIndices).toEqual([5, 8])
    // #b's straight middle: 1 own slot. #a's cubic end: anchor + in-handle
    // plus the cleared dangling out-handle below -> recorded at 4 with 3 slots.
    expect(result.del.removed).toEqual([{ index: 8, slots: 1 }, { index: 4, slots: 3 }])
    expect(result.del.skipped).toEqual([])
    const at = (x: number, y: number) =>
      (result.afterAnchors as Array<{ x: number; y: number }>).some((p) => Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1)
    // #a survivors (20,60),(80,60); #b survivors (0,200),(200,200) in document coords.
    expect(result.afterAnchors.length).toBe(4)
    expect(at(20, 60)).toBe(true)
    expect(at(80, 60)).toBe(true)
    expect(at(0, 200)).toBe(true)
    expect(at(200, 200)).toBe(true)
    expect(result.childCount).toBe(2)
    expect(result.targetTransform ?? '').toContain('scale(2)')
    expect(result.exported).not.toContain('NaN')
  }, 30_000)

  it('leaves the DOM byte-identical when a delete is refused', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const curve = doc.querySelector('#curve')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Flattened index 1 is the out-handle slot of the first anchor: not deletable.
      const del = await mod.deleteVectorPathPoint(curve, 1)
      const bulk = await mod.deleteVectorPathPoints(curve, [])
      return {
        del,
        bulk,
        after: new XMLSerializer().serializeToString(doc.documentElement),
        before,
      }
    })
    expect(result.del).toEqual({ deleted: false, reason: 'control-point' })
    expect(result.bulk).toEqual({ deleted: false, deletedIndices: [], removed: [], skipped: [], reason: 'no-selection' })
    // No-op: no DOM write, so no history entry can mint and redo is preserved.
    expect(result.after).toBe(result.before)
  }, 30_000)
})
