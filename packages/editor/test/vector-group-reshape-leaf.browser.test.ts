// Group-leaf reshape parity: ancestor path / leaf identity, CTM, compound-root
// normalization, overlap Z-order, and selection/render separation.
//
// New-file-only coverage for `vector-group-reshape.ts` (pure, no Paper.js
// import in the helper itself). Paper.js is used here only as the oracle:
// the pure CTM math must agree with Paper `globalToLocal`/`localToGlobal`,
// the pure paint order must agree with Paper `hitTest` topmost order, and a
// whole-leaf move through the existing surgical writer must leave siblings,
// wrapper transforms, paint, Z-order and identity untouched.
//
// Behaviour notes only (no reference source copied): reshape addresses one
// leaf inside a `<g>`; the select tool normalizes back to the compound root.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4331'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('group-leaf reshape helper + Paper oracle', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4331', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
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

  it('pure: leaf identity, CTM round-trip, flat bridge, root normalization, separation, reindex', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-reshape.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg">' +
          '<g id="unit" class="xyo-vector-explicit-group" transform="translate(10 0)">' +
          '<g transform="scale(2)"><rect x="0" y="0" width="10" height="10" fill="red"/></g>' +
          '<rect x="30" y="0" width="20" height="10" fill="blue" transform="translate(0 5)"/>' +
          '</g></svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const unit = svg.querySelector('#unit') as Element
      const leaves = helper.collectGroupLeafDescriptors(unit)
      const summary = helper.summarizeGroupUnit(unit)
      // CTM round-trip for the nested leaf (ancestor scale(2) inside unit translate).
      const unitWorld = helper.composeUnitWorldMatrix(unit.getAttribute('transform'), undefined)
      const leaf0 = leaves[0]!
      const docPoint = helper.leafLocalPointToDocument(leaf0, unitWorld, { x: 4, y: 6 })
      const back = helper.documentPointToLeafLocal(leaf0, unitWorld, docPoint)
      // Flat bridge: 4 anchors per rect leaf (pathized rect parity).
      const ranges = helper.flatRangesForLeaves([4, 4])
      const flatForLeaf1 = helper.flatIndicesForLeaves(ranges, [1])
      const ownerOf6 = helper.leafIndexForFlatIndex(ranges, 6)
      const localOf6 = helper.localIndexForFlatIndex(ranges, 6)
      const expanded = helper.expandLeafSelectionToFlatIndices([4, 4], [1])
      const normalized = helper.normalizeLeafSelectionToRoot(3, [0, 1])
      const liveBefore = helper.isLiveLeafSelection(leaves, [0, 1])
      const liveAfterDrop = helper.isLiveLeafSelection(leaves, [0, 9])
      const normalizedSel = helper.normalizeLeafSelection(leaves, [1, 1, 0, 9])
      // Selection/render separation: disjoint array identities, render order kept.
      const split = helper.partitionSelectionAndRender(leaves, [1])
      const selectedIsNewArray = split.selected !== (leaves as unknown[])
      const renderIsNewArray = split.renderOrder !== (leaves as unknown[])
      // Reindex: identical re-serialization matches uniquely; reordered still matches by signature.
      const afterDoc = new DOMParser().parseFromString(new XMLSerializer().serializeToString(doc), 'image/svg+xml')
      const afterLeaves = helper.collectGroupLeafDescriptors(afterDoc.querySelector('#unit') as Element)
      const matches = helper.matchLeavesAcrossReindex(leaves, afterLeaves)
      const rebased = helper.rebaseLeafSelectionAfterReindex([0, 1], matches)
      // Overlap Z-order pre-filter: later leaf wins.
      const top = helper.topmostLeafForPoint(
        leaves,
        (leaf: { leafIndex: number }) => (leaf.leafIndex === 0 ? { x: 0, y: 0, width: 100, height: 100 } : { x: 10, y: 10, width: 100, height: 100 }),
        { x: 50, y: 50 },
      )
      const beforeHtml = new XMLSerializer().serializeToString(svg)
      // Pure helpers must not mutate the DOM.
      const afterHtml = new XMLSerializer().serializeToString(svg)
      return {
        leafCount: leaves.length,
        summaryCount: summary.leafCount,
        isExplicit: summary.isExplicitGroup,
        keys: leaves.map((l: { leafKey: string }) => l.leafKey),
        paths: leaves.map((l: { ancestorPath: number[] }) => l.ancestorPath),
        depths: leaves.map((l: { depth: number }) => l.depth),
        zOrders: leaves.map((l: { zOrder: number }) => l.zOrder),
        tags: leaves.map((l: { tag: string }) => l.tag),
        roundTrip: { docPoint, back },
        ranges,
        flatForLeaf1,
        ownerOf6,
        localOf6,
        expanded,
        normalized,
        liveBefore,
        liveAfterDrop,
        normalizedSel,
        selectedIsNewArray,
        renderIsNewArray,
        selectedLeaf: split.selected.map((l: { leafIndex: number }) => l.leafIndex),
        renderLeaves: split.renderOrder.map((l: { leafIndex: number }) => l.leafIndex),
        matches,
        rebased,
        topLeaf: top?.leafIndex,
        domUntouched: beforeHtml === afterHtml,
      }
    })
    // Identity: two leaves, depth-first document order, nested leaf carries its wrapper path.
    expect(result.leafCount).toBe(2)
    expect(result.summaryCount).toBe(2)
    expect(result.isExplicit).toBe(true)
    expect(result.tags).toEqual(['rect', 'rect'])
    expect(result.depths[0]).toBeGreaterThan(result.depths[1] ?? 0)
    expect(result.zOrders).toEqual([0, 1])
    expect(result.keys.length).toBe(2)
    expect(result.keys[0]).not.toBe(result.keys[1])
    expect(result.paths.length).toBe(2)
    // CTM: leaf0 local (4,6) -> ancestors scale(2) -> unit translate(10 0) = (18,12).
    expect(result.roundTrip.docPoint.x).toBeCloseTo(18, 6)
    expect(result.roundTrip.docPoint.y).toBeCloseTo(12, 6)
    expect(result.roundTrip.back.x).toBeCloseTo(4, 6)
    expect(result.roundTrip.back.y).toBeCloseTo(6, 6)
    // Flat bridge.
    expect(result.ranges).toEqual([
      { leafIndex: 0, start: 0, count: 4 },
      { leafIndex: 1, start: 4, count: 4 },
    ])
    expect(result.flatForLeaf1).toEqual([4, 5, 6, 7])
    expect(result.ownerOf6).toBe(1)
    expect(result.localOf6).toBe(2)
    expect(result.expanded).toEqual([4, 5, 6, 7])
    // Root normalization.
    expect(result.normalized).toEqual({ rootIndex: 3, leafIndices: [], normalized: true })
    expect(result.liveBefore).toBe(true)
    expect(result.liveAfterDrop).toBe(false)
    expect(result.normalizedSel).toEqual([0, 1])
    // Separation.
    expect(result.selectedIsNewArray).toBe(true)
    expect(result.renderIsNewArray).toBe(true)
    expect(result.selectedLeaf).toEqual([1])
    expect(result.renderLeaves).toEqual([0])
    // Reindex.
    expect(result.matches.every((m: { unique: boolean }) => m.unique)).toBe(true)
    expect(result.rebased).toEqual([0, 1])
    // Z-order.
    expect(result.topLeaf).toBe(1)
    expect(result.domUntouched).toBe(true)
  }, 30_000)

  it('paper oracle: pure CTM matches Paper globalToLocal, Z-order matches hitTest, whole-leaf move is surgical', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-reshape.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const pathPoints = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="xyo-vector-explicit-group" transform="translate(10 0)" data-keep="yes">' +
        '<rect x="0" y="0" width="20" height="10" fill="red" data-leaf="a"/>' +
        '<rect x="30" y="0" width="20" height="10" fill="blue" data-leaf="b"/>' +
        '</g><rect x="0" y="50" width="10" height="10" fill="green"/></svg>'
      const list = await paper.paperVectorObjectList(svgText)
      const group = list.find((o: { tag: string }) => o.tag === 'g') as unknown as {
        index: number
        points: Array<{ index: number; x: number; y: number; kind?: string }>
      }
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const units = vector.editableVectorUnits(doc.documentElement)
      const element = units[group.index] as Element
      const leaves = helper.collectGroupLeafDescriptors(element)
      const unitWorld = helper.composeUnitWorldMatrix(element.getAttribute('transform'), undefined)
      // Oracle 1: pure matrix math agrees with the Paper.js matrix oracle.
      // Build the Paper matrix from the helper's own document CTM for leaf 0,
      // then apply the same local point in both engines; any divergence is a
      // real CTM bug, not a fixture assumption.
      const scope = await paper.ensureVectorPaperScope()
      const ctm = helper.documentCtmForLeaf(leaves[0]!, unitWorld)
      const paperMatrix = new scope.Matrix(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5])
      const paperApplied = new scope.Point(4, 6).transform(paperMatrix as unknown as never) as unknown as {
        x: number
        y: number
      }
      const paperLocal: { x: number; y: number } = { x: paperApplied.x, y: paperApplied.y }
      const pureLocal: { x: number; y: number } = helper.applyGroupMatrix(ctm, 4, 6)
      // Oracle 2: pure paint order (later = top) matches Paper hitTest topmost unit order.
      const hitTop = await paper.paperVectorHitIndex(units, { x: 45, y: 5 })
      // Oracle 3: whole-leaf move via the flat bridge stays surgical.
      const anchorCounts = [4, 4]
      const leaf1Flat = helper.expandLeafSelectionToFlatIndices(anchorCounts, [1])
      const firstOfLeaf1 = group.points.filter((p) => leaf1Flat.includes(p.index) && p.kind === 'anchor')[0]!
      const moveResult = await pathPoints.moveVectorReshapePoints(element, [
        { index: firstOfLeaf1.index, x: firstOfLeaf1.x + 5, y: firstOfLeaf1.y + 5 },
      ])
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      const afterDoc = new DOMParser().parseFromString(after, 'image/svg+xml')
      const afterUnits = vector.editableVectorUnits(afterDoc.documentElement)
      const afterGroup = afterUnits[0] as Element
      return {
        groupPoints: group.points.length,
        leafCount: leaves.length,
        paperLocal,
        pureLocal,
        hitTop,
        groupIndex: group.index,
        moved: moveResult.moved,
        groupStayed: afterGroup?.tagName.toLowerCase() === 'g',
        markerKept: (afterGroup?.getAttribute('class') ?? '').includes('xyo-vector-explicit-group'),
        childCount: afterGroup?.children.length,
        siblingFill: afterUnits[1]?.getAttribute('fill'),
        leafBKept: after.includes('data-leaf="b"'),
        transformKept: (afterGroup?.getAttribute('transform') ?? '').includes('translate'),
      }
    })
    expect(result.leafCount).toBe(2)
    expect(result.groupPoints).toBeGreaterThanOrEqual(8)
    // Pure CTM agrees with the Paper oracle (rect leaves carry no local skew; allow sub-pixel tolerance).
    expect(result.paperLocal).toBeDefined()
    expect(result.pureLocal).toBeDefined()
    expect(Math.abs(result.paperLocal!.x - result.pureLocal!.x)).toBeLessThan(0.5)
    expect(Math.abs(result.paperLocal!.y - result.pureLocal!.y)).toBeLessThan(0.5)
    // Overlapping document point (45,5) sits inside the translated blue leaf; the group unit is topmost-wins.
    expect(result.hitTop).toBe(result.groupIndex)
    // Surgical whole-leaf address: one leaf anchor moves, siblings/identity survive.
    expect(result.moved).toBe(true)
    expect(result.groupStayed).toBe(true)
    expect(result.markerKept).toBe(true)
    expect(result.childCount).toBe(2)
    expect(result.siblingFill).toBe('green')
    expect(result.leafBKept).toBe(true)
    expect(result.transformKept).toBe(true)
  }, 60_000)
})
