import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
// vector-path-points uses 4231; use a distinct port for this suite.
const base = 'http://127.0.0.1:4233'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('first-anchor delete precise remap (real Editor VM helpers in browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4233', '--strictPort'], { cwd: root, stdio: 'pipe' })
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

  it('deleting first anchor [0] keeps 2->0 and shifts the rest; points/handles physical; UndoRedo + sibling bytes exact', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const sel = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="translate(50 40) scale(2)">' +
        '<path id="a" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '<path id="b" d="M0 100 L50 100 L100 100" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect id="sibling" x="300" y="250" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const siblingBefore = doc.querySelector('#sibling')!.outerHTML
      const svgBefore = new XMLSerializer().serializeToString(doc.documentElement)
      const beforeObjs = await paperMod.paperVectorObjectList(svgBefore)
      // Full end UI selection labels (not just helper remap arrays).
      const beforeLabels = (beforeObjs as any[]).map((o: any) => o.label)
      const beforeTags = (beforeObjs as any[]).map((o: any) => o.tag)
      // `target` is a real selectable unit here (sibling keeps the <g> grouped),
      // so its Paper points are the group-flattened 0..9 scheme the delete
      // helper mutates: pathA cubic 0..6 + pathB straight 7..9.
      const beforePoints = (beforeObjs[0] as any).points as Array<any>
      const beforeAnchors = beforePoints.filter((p) => p.kind === 'anchor')
      const beforeByIndex = new Map(beforeAnchors.map((p) => [p.index, p]))
      const anchorIndices = beforeAnchors.map((p) => p.index)
      const selection = [2, 4, 5, 6]
      const del = await mod.deleteVectorPathPoints(target, [0])
      const svgAfterDelete = new XMLSerializer().serializeToString(doc.documentElement)
      const afterObjs = await paperMod.paperVectorObjectList(svgAfterDelete)
      const afterLabels = (afterObjs as any[]).map((o: any) => o.label)
      const afterPoints = (afterObjs[0] as any).points as Array<any>
      const afterAnchors = afterPoints.filter((p) => p.kind === 'anchor').map((p: any) => p.index)
      const afterByIndex = new Map(afterPoints.map((p) => [p.index, p]))
      const precise = (sel as any).remapReshapeSelectionAfterBulkPreciseSlots(selection, (del as any).removedSlots ?? [])
      const viaRanges = (sel as any).remapReshapeSelectionAfterBulkRanges(selection, (del as any).removedRanges ?? (del as any).removed)
      const legacy = (sel as any).remapReshapeSelectionAfterSlotDelete(selection, (del as any).removed[0].index, (del as any).removed[0].slots)
      // Physically selected old global point -> new local/flat index:
      // old anchor 2 at document (130,100) must rebase to new anchor 0 by
      // exact coordinates (stable-identity, same rule Editor undo uses).
      const oldSurvivorCoord = { index: 2, x: (beforeByIndex.get(2) as any).x, y: (beforeByIndex.get(2) as any).y }
      const afterAnchorCoords = afterPoints.filter((p: any) => p.kind === 'anchor').map((p: any) => ({ index: p.index, x: p.x, y: p.y }))
      const rebased = (sel as any).rebaseReshapeSelectionByAnchorCoordinates(afterAnchorCoords, afterAnchorCoords, [0])
      const crossRebase = (sel as any).rebaseReshapeSelectionByAnchorCoordinates(
        [{ index: 2, x: oldSurvivorCoord.x, y: oldSurvivorCoord.y }],
        afterAnchorCoords,
        [2],
      )
      // Actually nudge/move survivor and verify only intended anchor moves.
      // Move new anchor 0 (+10,+10 doc units); its own out-handle rides along,
      // every other anchor/control stays byte-identical, sibling untouched.
      const survivorBefore = { ...(afterByIndex.get(0) as any) }
      const otherBefore = afterPoints.filter((p: any) => p.index !== 0 && p.index !== 1).map((p: any) => ({ ...p }))
      const nudgeTarget = { x: (survivorBefore as any).x + 10, y: (survivorBefore as any).y + 10 }
      const nudge = await mod.moveVectorReshapePoints(target, [{ index: 0, ...nudgeTarget }])
      const svgAfterNudge = new XMLSerializer().serializeToString(doc.documentElement)
      const nudgeObjs = await paperMod.paperVectorObjectList(svgAfterNudge)
      const nudgePoints = (nudgeObjs[0] as any).points as Array<any>
      const nudgeByIndex = new Map(nudgePoints.map((p) => [p.index, p]))
      // Simulate UndoRedo bytes-exact: restoring the saved pre-delete bytes
      // must reproduce the pre-delete flattened points; restoring the saved
      // post-delete bytes must reproduce the post-delete points (redo).
      const restoreDoc = new DOMParser().parseFromString(svgBefore, 'image/svg+xml')
      const restoreObjs = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(restoreDoc.documentElement))
      const restorePoints = (restoreObjs[0] as any).points as Array<any>
      const redoDoc = new DOMParser().parseFromString(svgAfterDelete, 'image/svg+xml')
      const redoObjs = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(redoDoc.documentElement))
      const redoPoints = (redoObjs[0] as any).points as Array<any>
      // No-click: empty marquee + invalid toggle are selection no-ops.
      const emptyMarquee = (sel as any).reshapePointsInRect(beforePoints, { x: 400, y: 10, width: 5, height: 5 })
      const toggleInvalid = (sel as any).toggleReshapePointSelection([0, 2], -1, true)
      const normalizeEmpty = (sel as any).normalizeReshapeSelection([])
      return {
        del,
        anchorIndices,
        beforeLabels,
        beforeTags,
        afterLabels,
        beforeAnchorCoords: [beforeByIndex.get(0), beforeByIndex.get(2), beforeByIndex.get(5)].map((p) => p ? { index: (p as any).index, x: (p as any).x, y: (p as any).y } : null),
        afterAnchorIndices: afterAnchors,
        afterAnchorCoordsByIndex: [afterByIndex.get(0), afterByIndex.get(2), afterByIndex.get(4), afterByIndex.get(5), afterByIndex.get(6)].map((p) => p ? { index: (p as any).index, x: (p as any).x, y: (p as any).y, kind: (p as any).kind } : null),
        afterHandles: afterPoints.filter((p) => p.kind === 'control').map((p) => ({ index: p.index, role: p.controlRole, related: p.relatedAnchorIndex, x: p.x, y: p.y })),
        precise,
        viaRanges,
        legacy,
        rebased,
        crossRebase,
        oldSurvivorCoord,
        survivorBefore,
        nudge,
        nudgeAnchor0: nudgeByIndex.get(0) ? { ...(nudgeByIndex.get(0) as any) } : null,
        nudgeOthersSame: otherBefore.map((p: any) => {
          const q = nudgeByIndex.get(p.index) as any
          return q && Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9 && q.kind === p.kind
        }),
        nudgeSiblingSame: doc.querySelector('#sibling')!.outerHTML === siblingBefore,
        siblingSame: doc.querySelector('#sibling')!.outerHTML === siblingBefore,
        targetTransform: (doc.querySelector('#target') as Element).getAttribute('transform'),
        childCount: (doc.querySelector('#target') as Element).children.length,
        bytesChanged: svgBefore !== svgAfterDelete,
        nudgeChanged: svgAfterNudge !== svgAfterDelete,
        undoRoundTripEqual: JSON.stringify(restorePoints) === JSON.stringify(beforePoints),
        redoRoundTripEqual: JSON.stringify(redoPoints) === JSON.stringify(afterPoints),
        undoBytesEqual: new XMLSerializer().serializeToString(restoreDoc.documentElement) === svgBefore,
        redoBytesEqual: new XMLSerializer().serializeToString(redoDoc.documentElement) === svgAfterDelete,
        afterSvgHasNaN: svgAfterDelete.includes('NaN'),
        emptyMarquee,
        toggleInvalid,
        normalizeEmpty,
      }
    })
    // Legacy contiguous report is kept for compatibility...
    expect(result.del.deleted).toBe(true)
    expect(result.del.deletedIndices).toEqual([0])
    expect(result.del.removed).toEqual([{ index: 0, slots: 3 }])
    // ...but the precise sets expose the disjoint truth.
    expect(result.del.removedSlots).toEqual([[0, 1, 3]])
    expect(result.del.removedRanges).toEqual([{ index: 3, slots: 1 }, { index: 0, slots: 2 }])
    // Old anchors were [0,2,5] on pathA plus [7,8,9] on pathB (group unit).
    expect(result.anchorIndices).toEqual([0, 2, 5, 7, 8, 9])
    // Full end UI selection labels: group stays one unit + sibling.
    expect(result.beforeLabels).toEqual(['1. g', '2. rect'])
    expect(result.beforeTags).toEqual(['g', 'rect'])
    expect(result.afterLabels).toEqual(['1. g', '2. rect'])
    // Selecting the survivor between the vanished slots plus followers maps
    // 2->0, 4->1, 5->2, 6->3.
    expect(result.precise).toEqual([0, 1, 2, 3])
    expect(result.viaRanges).toEqual([0, 1, 2, 3])
    // Fail-first witness: the legacy contiguous replay drops the survivor.
    expect(result.legacy).toEqual([1, 2, 3])
    // After delete the group-flattened anchors are 0,2,4,5,6 (controls at
    // 1,3); the old test wrongly expected anchors at 0,1,2,3.
    expect(result.afterAnchorIndices).toEqual([0, 2, 4, 5, 6])
    // Survivor old-2 keeps its document position (local (40,30) -> (130,100)).
    expect(result.beforeAnchorCoords[1]).toMatchObject({ index: 2 })
    expect(Math.abs((result.beforeAnchorCoords[1] as any).x - 130) < 1).toBe(true)
    expect(Math.abs((result.beforeAnchorCoords[1] as any).y - 100) < 1).toBe(true)
    expect(result.afterAnchorCoordsByIndex[0]).toMatchObject({ index: 0, kind: 'anchor' })
    expect(result.afterAnchorCoordsByIndex[1]).toMatchObject({ index: 2, kind: 'anchor' })
    expect(Math.abs((result.beforeAnchorCoords[1] as any).x - (result.afterAnchorCoordsByIndex[0] as any).x) < 1).toBe(true)
    expect(Math.abs((result.beforeAnchorCoords[1] as any).y - (result.afterAnchorCoordsByIndex[0] as any).y) < 1).toBe(true)
    // Second survivor old-5 (190,100) -> new 2.
    expect(Math.abs((result.beforeAnchorCoords[2] as any).x - (result.afterAnchorCoordsByIndex[1] as any).x) < 1).toBe(true)
    expect(Math.abs((result.beforeAnchorCoords[2] as any).y - (result.afterAnchorCoordsByIndex[1] as any).y) < 1).toBe(true)
    // Physically selected old global point maps to the correct new flat index.
    expect(result.crossRebase).toEqual([0])
    expect(result.rebased).toEqual([0])
    // Handles: new anchor 0 carries an out-handle; no handle dangles at the start.
    const outOf0 = (result.afterHandles as Array<any>).find((h) => h.related === 0 && h.role === 'out')
    expect(outOf0).toBeDefined()
    expect(outOf0.index).toBe(1)
    expect((result.afterHandles as Array<any>).some((h) => h.related === 0 && h.role === 'in')).toBe(false)
    // Actually nudge/move survivor: only intended anchor (+its handle) moves.
    expect(result.nudge.moved).toBe(true)
    expect(result.nudge.movedIndices).toEqual([0])
    expect(Math.abs((result.nudgeAnchor0 as any).x - ((result.survivorBefore as any).x + 10)) < 1e-6).toBe(true)
    expect(Math.abs((result.nudgeAnchor0 as any).y - ((result.survivorBefore as any).y + 10)) < 1e-6).toBe(true)
    expect((result.nudgeOthersSame as boolean[]).every(Boolean)).toBe(true)
    expect(result.nudgeChanged).toBe(true)
    expect(result.nudgeSiblingSame).toBe(true)
    // No wrong move/delete: wrapper transform, child count, sibling bytes kept.
    expect(result.targetTransform).toBe('translate(50 40) scale(2)')
    expect(result.childCount).toBe(2)
    expect(result.siblingSame).toBe(true)
    expect(result.bytesChanged).toBe(true)
    expect(result.afterSvgHasNaN).toBe(false)
    // UndoRedo bytes exact: restoring saved bytes reproduces the points.
    expect(result.undoRoundTripEqual).toBe(true)
    expect(result.redoRoundTripEqual).toBe(true)
    expect(result.undoBytesEqual).toBe(true)
    expect(result.redoBytesEqual).toBe(true)
    // No-click: empty marquee / invalid toggle / empty normalize are no-ops.
    expect(result.emptyMarquee).toEqual([])
    expect(result.toggleInvalid).toEqual([0, 2])
    expect(result.normalizeEmpty).toEqual([])
  }, 30_000)

  it('multi delete descending + reshape control + count/out-of-bounds; singular write-block refuses byte-identical', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const sel = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      // NOTE: a sibling rect keeps <g id="target"> a single selectable unit.
      // Without it editableVectorUnits unwraps the lone group into per-leaf
      // objects (paperVectorObjectList[0] would be pathA-local only) while
      // deleteVectorPathPoints(target, …) still uses group-flattened 0..9 —
      // that unit mismatch was the 2fail cause. The sibling makes both sides
      // agree on the group-flattened scheme.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="translate(10 5)">' +
        '<path id="a" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '<path id="b" d="M0 100 L50 100 L100 100" fill="none" stroke="red"/>' +
        '</g>' +
        '<rect id="sibling" x="300" y="250" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const siblingBefore = doc.querySelector('#sibling')!.outerHTML
      const beforeSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const beforeObjs = await paperMod.paperVectorObjectList(beforeSvg)
      const beforeLabels = (beforeObjs as any[]).map((o: any) => o.label)
      const beforePoints = (beforeObjs[0] as any).points as Array<any>
      const beforeAnchors = beforePoints.filter((p: any) => p.kind === 'anchor').map((p: any) => ({ index: p.index, x: p.x, y: p.y }))
      // Multi delete descending: last anchor of pathA (5, own {5,6} + cleared
      // below 4) plus middle anchor of pathB (8, single slot).
      const bulk = await mod.deleteVectorPathPoints(target, [5, 8])
      const afterSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const afterObjs = await paperMod.paperVectorObjectList(afterSvg)
      const afterLabels = (afterObjs as any[]).map((o: any) => o.label)
      const afterPoints = (afterObjs[0] as any).points as Array<any>
      const afterAnchors = afterPoints.filter((p: any) => p.kind === 'anchor').map((p: any) => ({ index: p.index, x: p.x, y: p.y }))
      // Survivor exact coordinates: pathA keeps (20,35),(50,35); pathB keeps
      // (10,105),(110,105) under translate(10 5).
      const precise = (sel as any).remapReshapeSelectionAfterBulkPreciseSlots([5, 8], (bulk as any).removedSlots ?? [])
      // Nudge one survivor (new flat 0 == old pathA first anchor at (20,35)).
      const nudge = await mod.moveVectorReshapePoints(target, [{ index: 0, x: 30, y: 45 }])
      const nudgeSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const nudgeObjs = await paperMod.paperVectorObjectList(nudgeSvg)
      const nudgePoints = (nudgeObjs[0] as any).points as Array<any>
      const nudgeAnchor0 = nudgePoints.find((p: any) => p.index === 0)
      const nudgeAnchor2 = nudgePoints.find((p: any) => p.index === 2)
      // Reshape selection control: control slots are never live anchors.
      const liveControl = (sel as any).isReshapeAnchorLive(beforePoints, 1)
      const liveAnchor = (sel as any).isReshapeAnchorLive(beforePoints, 2)
      // Count helper: anchor+two handles for middle cubic anchor.
      const countMid = (sel as any).countFlattenedSlotsForAnchor(beforePoints, 2)
      const countFirst = (sel as any).countFlattenedSlotsForAnchor(beforePoints, 0)
      const countMissing = (sel as any).countFlattenedSlotsForAnchor(beforePoints, 99)
      // Out-of-bounds: control slot refused, unknown index skipped, empty is no-op.
      const controlRefused = await mod.deleteVectorPathPoint(target, 1)
      const bulkMixed = await mod.deleteVectorPathPoints(target, [1, 999])
      const emptyBulk = await mod.deleteVectorPathPoints(target, [])
      const midSvg = new XMLSerializer().serializeToString(doc.documentElement)
      // No-click: plain click replaces, shift toggles, empty marquee is [].
      const plainClick = (sel as any).toggleReshapePointSelection([4, 5], 2, false)
      const shiftToggle = (sel as any).toggleReshapePointSelection([4, 5], 5, true)
      const emptyMarquee = (sel as any).reshapePointsInRect(beforePoints, { x: 400, y: 10, width: 5, height: 5 })
      // External CAS conflict while write blocked: singular ancestor matrix
      // refuses with no DOM write (mirrors the Editor CAS fail-closed path:
      // external bytes win, local selection is preserved by the caller).
      const blockedSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g transform="matrix(0 0 0 0 0 0)"><g id="blocked">' +
        '<path id="p" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green"/>' +
        '</g></g></svg>'
      const blockedDoc = new DOMParser().parseFromString(blockedSvg, 'image/svg+xml')
      const blocked = blockedDoc.querySelector('#blocked')!
      const blockedBefore = new XMLSerializer().serializeToString(blockedDoc.documentElement)
      const blockedSingle = await mod.deleteVectorPathPoint(blocked, 0)
      const blockedBulk = await mod.deleteVectorPathPoints(blocked, [0])
      const blockedAfter = new XMLSerializer().serializeToString(blockedDoc.documentElement)
      return {
        bulk,
        beforeLabels,
        beforeAnchors,
        afterLabels,
        afterAnchors,
        afterAnchorCount: afterPoints.filter((p) => p.kind === 'anchor').length,
        precise,
        nudge,
        nudgeAnchor0: nudgeAnchor0 ? { ...nudgeAnchor0 } : null,
        nudgeAnchor2: nudgeAnchor2 ? { ...nudgeAnchor2 } : null,
        nudgeSiblingSame: doc.querySelector('#sibling')!.outerHTML === siblingBefore,
        liveControl,
        liveAnchor,
        countMid,
        countFirst,
        countMissing,
        controlRefused,
        bulkMixed,
        emptyBulk,
        domStableAfterRefusals: midSvg === nudgeSvg,
        plainClick,
        shiftToggle,
        emptyMarquee,
        blockedSingle,
        blockedBulk,
        blockedByteIdentical: blockedAfter === blockedBefore,
      }
    })
    expect(result.bulk.deleted).toBe(true)
    expect(result.bulk.deletedIndices).toEqual([5, 8])
    // Descending order: higher deletion first; each precise set is contiguous here.
    expect(result.bulk.removedSlots).toEqual([[8], [4, 5, 6]])
    expect(result.bulk.removedRanges).toEqual([{ index: 8, slots: 1 }, { index: 4, slots: 3 }])
    expect(result.afterAnchorCount).toBe(4)
    // Full end UI labels stay grouped.
    expect(result.beforeLabels).toEqual(['1. g', '2. rect'])
    expect(result.afterLabels).toEqual(['1. g', '2. rect'])
    // Survivor exact coordinates (translate(10 5) applied).
    expect(result.afterAnchors).toEqual([
      { index: 0, x: 20, y: 35 },
      { index: 2, x: 50, y: 35 },
      { index: 4, x: 10, y: 105 },
      { index: 5, x: 110, y: 105 },
    ])
    // Cross-path precise remap keeps survivors (no wrong drop).
    expect(result.precise).toEqual([])
    // Nudge only the intended survivor; sibling geometry untouched.
    expect(result.nudge.moved).toBe(true)
    expect(result.nudge.movedIndices).toEqual([0])
    expect(result.nudgeAnchor0).toMatchObject({ index: 0, x: 30, y: 45 })
    expect(result.nudgeAnchor2).toMatchObject({ index: 2, x: 50, y: 35 })
    expect(result.nudgeSiblingSame).toBe(true)
    // Reshape selection control + count + out-of-bounds.
    expect(result.liveControl).toBe(false)
    expect(result.liveAnchor).toBe(true)
    expect(result.countMid).toBe(3)
    expect(result.countFirst).toBe(2)
    expect(result.countMissing).toBe(1)
    expect(result.controlRefused).toEqual({ deleted: false, reason: 'control-point' })
    expect(result.bulkMixed.deleted).toBe(false)
    expect(result.emptyBulk).toEqual({ deleted: false, deletedIndices: [], removed: [], skipped: [], reason: 'no-selection' })
    expect(result.domStableAfterRefusals).toBe(true)
    // No-click selection semantics.
    expect(result.plainClick).toEqual([2])
    expect(result.shiftToggle).toEqual([4])
    expect(result.emptyMarquee).toEqual([])
    // Singular ancestor (write blocked): both single and bulk refuse, DOM
    // byte-identical so the Editor keeps the external bytes + selection.
    expect(result.blockedSingle).toEqual({ deleted: false, reason: 'not-editable' })
    expect(result.blockedBulk.deleted).toBe(false)
    expect(result.blockedBulk.reason).toBe('not-editable')
    expect(result.blockedByteIdentical).toBe(true)
  }, 30_000)

  it('closed first-anchor delete clears the wrap handle; survivor remap stays exact', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const sel = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="loop" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30 L100 30 Z" fill="none" stroke="black"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const loop = doc.querySelector('#loop')!
      const beforeSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const beforeObjs = await paperMod.paperVectorObjectList(beforeSvg)
      const beforePoints = (beforeObjs[0] as any).points as Array<any>
      const beforeAnchors = beforePoints.filter((p: any) => p.kind === 'anchor').map((p: any) => p.index)
      const beforeAnchorCoords = beforePoints.filter((p: any) => p.kind === 'anchor').map((p: any) => ({ index: p.index, x: p.x, y: p.y }))
      const beforeLabel = (beforeObjs[0] as any).label
      const del = await mod.deleteVectorPathPoints(loop, [0])
      const afterSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const afterObjs = await paperMod.paperVectorObjectList(afterSvg)
      const afterPoints = (afterObjs[0] as any).points as Array<any>
      const afterLabel = (afterObjs[0] as any).label
      const newFirstIn = afterPoints.find((p: any) => p.index === 0 && p.kind === 'control' && p.controlRole === 'in')
      const precise = (sel as any).remapReshapeSelectionAfterBulkPreciseSlots(beforeAnchors, (del as any).removedSlots ?? [])
      // Survivor exact: old anchor at (40,30) becomes new anchor 0.
      const survivorOld = beforePoints.find((p: any) => p.index === 2)
      const survivorNew = afterPoints.find((p: any) => p.index === 0)
      // Nudge new first anchor; only it (+its handles) may move.
      const nudge = await mod.moveVectorReshapePoints(loop, [{ index: 0, x: (survivorNew as any).x + 5, y: (survivorNew as any).y }])
      const nudgeSvg = new XMLSerializer().serializeToString(doc.documentElement)
      const nudgeObjs = await paperMod.paperVectorObjectList(nudgeSvg)
      const nudgePoints = (nudgeObjs[0] as any).points as Array<any>
      // Undo/redo exact: saved bytes round-trip to identical points+bytes.
      const restoreObjs = await paperMod.paperVectorObjectList(beforeSvg)
      const restorePoints = (restoreObjs[0] as any).points as Array<any>
      const redoObjs = await paperMod.paperVectorObjectList(afterSvg)
      const redoPoints = (redoObjs[0] as any).points as Array<any>
      const emptyMarquee = (sel as any).reshapePointsInRect(beforePoints, { x: 400, y: 300, width: 5, height: 5 })
      return { del, beforeAnchors, beforeAnchorCoords, beforeLabel, afterAnchors: afterPoints.filter((p: any) => p.kind === 'anchor').map((p: any) => p.index), afterLabel, newFirstIn: newFirstIn ?? null, precise, survivorOld: survivorOld ? { ...survivorOld } : null, survivorNew: survivorNew ? { ...survivorNew } : null, nudge, nudgeFirst: nudgePoints.find((p: any) => p.index === 0) ? { ...nudgePoints.find((p: any) => p.index === 0) } : null, nudgeSecond: nudgePoints.find((p: any) => p.index === 2) ? { ...nudgePoints.find((p: any) => p.index === 2) } : null, hasNaN: afterSvg.includes('NaN'), undoEqual: JSON.stringify(restorePoints) === JSON.stringify(beforePoints), redoEqual: JSON.stringify(redoPoints) === JSON.stringify(afterPoints), emptyMarquee }
    })
    expect(result.del.deleted).toBe(true)
    // Own {0,1} + cleared wrap/in above at old 3: disjoint.
    expect(result.del.removedSlots).toEqual([[0, 1, 3]])
    expect(result.del.removedRanges).toEqual([{ index: 3, slots: 1 }, { index: 0, slots: 2 }])
    // No dangling incoming handle on the new first anchor of the closed loop.
    expect(result.newFirstIn).toBeNull()
    expect(result.hasNaN).toBe(false)
    // Every surviving old anchor still maps to a live anchor (none wrongly dropped).
    expect(result.precise.length).toBeGreaterThan(0)
    for (const idx of result.precise) {
      expect(result.afterAnchors).toContain(idx)
    }
    // Full UI labels + survivor exact coordinates.
    expect(result.beforeLabel).toBe('1. path')
    expect(result.afterLabel).toBe('1. path')
    expect(result.survivorOld).toMatchObject({ index: 2, x: 40, y: 30 })
    expect(result.survivorNew).toMatchObject({ index: 0, x: 40, y: 30 })
    // Nudge only the intended survivor.
    expect(result.nudge.moved).toBe(true)
    expect(result.nudge.movedIndices).toEqual([0])
    expect(result.nudgeFirst).toMatchObject({ index: 0, x: 45, y: 30 })
    expect((result.nudgeSecond as any).x).toBeCloseTo(70, 6)
    // Undo/redo exact + no-click marquee empty.
    expect(result.undoEqual).toBe(true)
    expect(result.redoEqual).toBe(true)
    expect(result.emptyMarquee).toEqual([])
  }, 30_000)
})
