// Critical V-7 delete->Undo selection parity: live reference measurement.
//
// What this proves (independent clean runtime, no source-derived assumption):
//  1. S-shaped 4-anchor open path, select neighboring curves 0+1 then toggle
//     curve 0 off, yields segment selection masks [0,4,3,0] ("masks 4,3").
//  2. `paper.project.exportJSON({asString:false})` DOES serialize per-segment
//     selection flags (selection int is the 4th element of the segment entry),
//     and clear+importJSON restores each segment `_selection`, point/handle
//     selected flags, and `project.selectedItems` exactly.
//  3. Scratch-exact undo-stack timing: snapshot on initial import and on
//     updates (delete/nudge call onUpdateImage -> snapshot post-state); mere
//     segment/curve selection pushes NOTHING; delete snapshots post-delete;
//     performUndo restores stack[pointer-1] with pointer-1. Consequence: a
//     selection made after the last snapshot is LOST by delete->Undo unless a
//     post-selection edit snapshot recorded it first.
//
// Reference runtime: the INSTALLED `paper` package, exact version asserted at
// runtime (`paper.version === '0.12.18'`, packages/editor dependency).
// scratch-paint pins `@scratch/paper@0.11.20221201200345`
// (.tmp/scratch-editor/packages/scratch-paint/package.json); that tarball is
// NOT installed here and network install is prohibited, so it could not be
// executed. Identity of the exercised code paths was verified against the
// MIT-licensed scratchfoundation/paper.js `develop` sources (web-fetched):
// Segment._serialize appends the selection int, SegmentSelection is
// POINT=1/HANDLE_IN=2/HANDLE_OUT=4, Curve.selected sets
// point1|handle1-out|handle2-in|point2, Item serializes `selected`, and
// Project export/import round-trips both -- character-for-character the same
// behavior as the installed 0.12.18 dist quoted in this file's assertions.
// If the fork ever diverges on these paths, the runtime assertions below
// (version pin + mask/JSON expectations) fail loudly instead of passing
// silently.
//
// Select calls used (documented; same API scratch-paint reshape uses):
//   path.getCurves()[0].selected = true
//   path.getCurves()[1].selected = true   // neighboring curves -> [5,7,3,0]
//   path.getCurves()[0].selected = false  // toggle one off -> [0,4,3,0]
//
// Run with:
//   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome bun test test/vector-delete-undo-selection-parity.browser.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4751
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector delete->undo selection parity (live paper reference)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start on 4751')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto(base)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('neighboring curve select + toggle yields masks [0,4,3,0] with documented select calls', async () => {
    const report = await page.evaluate(async () => {
      const loadPaper = async (): Promise<any> => {
        const w = window as any
        if (w.paper?.PaperScope) return w.paper
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.src = '/node_modules/paper/dist/paper-full.js'
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('paper UMD failed to load'))
          document.head.appendChild(script)
        })
        if (!w.paper?.PaperScope) throw new Error('paper UMD did not install window.paper')
        return w.paper
      }
      const paperNs = await loadPaper()
      const scope = new paperNs.PaperScope()
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 480
        canvas.height = 360
        scope.setup(canvas)
        scope.activate()
        // S-shaped 4-anchor open path (alternating handle lean).
        const path = new paperNs.Path({
          segments: [
            [[40, 180], null, [60, -70]],
            [[140, 110], [-60, 70], [60, -70]],
            [[240, 40], [-60, 70], [60, -70]],
            [[340, 110], [-60, 70], null],
          ],
        })
        const curves = path.getCurves()
        // Documented select sequence (Curve.selected setter, as reshape does).
        curves[0].selected = true
        curves[1].selected = true
        const afterBoth = path.segments.map((s: any) => s.selection)
        const curvesBoth = curves.map((c: any) => c.selected)
        curves[0].selected = false // toggle one neighboring curve off
        const masks = path.segments.map((s: any) => s.selection)
        const segSelected = path.segments.map((s: any) => s.selected)
        const pointSelected = path.segments.map((s: any) => s.point.selected)
        const handleInSelected = path.segments.map((s: any) => s.handleIn.selected)
        const handleOutSelected = path.segments.map((s: any) => s.handleOut.selected)
        const curvesAfter = curves.map((c: any) => c.selected)
        const leaf = scope.project.selectedItems
          .filter((item: any) => !(item instanceof paperNs.Layer) && !(item instanceof paperNs.Group))
          .map((item: any) => item.className)
        return {
          paperVersion: paperNs.version,
          segmentCount: path.segments.length,
          afterBoth,
          curvesBoth,
          masks,
          segSelected,
          pointSelected,
          handleInSelected,
          handleOutSelected,
          curvesAfter,
          pathSelected: path.selected,
          selectedItems: scope.project.selectedItems.map((item: any) => item.className),
          leaf,
        }
      } finally {
        scope.remove()
      }
    })
    expect(report.paperVersion).toBe('0.12.18')
    expect(report.segmentCount).toBe(4)
    // Both neighboring curves selected: seg0 = point|out (5), seg1 = all (7), seg2 = point|in (3).
    expect(report.afterBoth).toEqual([5, 7, 3, 0])
    expect(report.curvesBoth).toEqual([true, true, false])
    // Toggle curve 0 off clears its 4 bits (seg0 -> 0, seg1 point+in cleared -> out-only 4).
    expect(report.masks).toEqual([0, 4, 3, 0])
    expect(report.segSelected).toEqual([false, true, true, false])
    expect(report.pointSelected).toEqual([false, false, true, false])
    expect(report.handleInSelected).toEqual([false, false, true, false])
    expect(report.handleOutSelected).toEqual([false, true, false, false])
    // Latent state: no whole curve remains selected (seg1 lacks point, seg2 lacks out).
    expect(report.curvesAfter).toEqual([false, false, false])
    expect(report.pathSelected).toBe(true)
    expect(report.selectedItems).toEqual(['Path'])
    expect(report.leaf).toEqual(['Path'])
  }, 30_000)

  it('exportJSON includes segment flags; clear/reimport restores masks, point/handle, selectedItems', async () => {
    const report = await page.evaluate(async () => {
      const paperNs = (window as any).paper
      const scope = new paperNs.PaperScope()
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 480
        canvas.height = 360
        scope.setup(canvas)
        scope.activate()
        const path = new paperNs.Path({
          segments: [
            [[40, 180], null, [60, -70]],
            [[140, 110], [-60, 70], [60, -70]],
            [[240, 40], [-60, 70], [60, -70]],
            [[340, 110], [-60, 70], null],
          ],
        })
        const curves = path.getCurves()
        curves[0].selected = true
        curves[1].selected = true
        curves[0].selected = false
        const before = path.segments.map((s: any) => s.selection)
        const json: any = scope.project.exportJSON({ asString: false })
        // Structural walk: segment entries with a trailing selection int
        // [point, handleIn, handleOut, selection].
        const found: number[] = []
        const walk = (node: any): void => {
          if (Array.isArray(node)) {
            for (const v of node) walk(v)
            return
          }
          if (node && typeof node === 'object') {
            if (Array.isArray(node.segments)) {
              for (const entry of node.segments) {
                if (
                  Array.isArray(entry) &&
                  entry.length === 4 &&
                  Number.isInteger(entry[3]) &&
                  Array.isArray(entry[0]) &&
                  Array.isArray(entry[1]) &&
                  Array.isArray(entry[2])
                ) {
                  found.push(entry[3])
                }
              }
            }
            for (const k of Object.keys(node)) walk(node[k])
          }
        }
        walk(json)
        const jsonText = JSON.stringify(json)
        scope.project.clear()
        const afterClear = {
          layers: scope.project.layers.length,
          selectedItems: scope.project.selectedItems.length,
        }
        scope.project.importJSON(json)
        const paths: any[] = []
        const collect = (items: any[]): void => {
          for (const item of items) {
            if (item.segments) paths.push(item)
            if (item.children) collect(Array.from(item.children))
          }
        }
        collect(scope.project.layers.flatMap((layer: any) => Array.from(layer.children)))
        const restored = paths[0]
        const masks = restored.segments.map((s: any) => s.selection)
        return {
          paperVersion: paperNs.version,
          before,
          jsonIsObject: typeof json === 'object' && json !== null,
          segmentFlagsInJson: found,
          jsonTextHas4: jsonText.includes(',4]'),
          jsonTextHas3: jsonText.includes(',3]'),
          afterClear,
          restoredCount: paths.length,
          masks,
          segSelected: restored.segments.map((s: any) => s.selected),
          pointSelected: restored.segments.map((s: any) => s.point.selected),
          handleInSelected: restored.segments.map((s: any) => s.handleIn.selected),
          handleOutSelected: restored.segments.map((s: any) => s.handleOut.selected),
          curvesAfter: restored.getCurves().map((c: any) => c.selected),
          pathSelected: restored.selected,
          selectedItems: scope.project.selectedItems.map((item: any) => item.className),
          leaf: scope.project.selectedItems
            .filter((item: any) => !(item instanceof paperNs.Layer) && !(item instanceof paperNs.Group))
            .map((item: any) => item.className),
        }
      } finally {
        scope.remove()
      }
    })
    expect(report.paperVersion).toBe('0.12.18')
    expect(report.before).toEqual([0, 4, 3, 0])
    expect(report.jsonIsObject).toBe(true)
    // JSON carries exactly the two segment selection flags, in segment order.
    expect(report.segmentFlagsInJson).toEqual([4, 3])
    expect(report.jsonTextHas4).toBe(true)
    expect(report.jsonTextHas3).toBe(true)
    expect(report.afterClear).toEqual({ layers: 0, selectedItems: 0 })
    expect(report.restoredCount).toBe(1)
    // Round-trip is exact.
    expect(report.masks).toEqual([0, 4, 3, 0])
    expect(report.segSelected).toEqual([false, true, true, false])
    expect(report.pointSelected).toEqual([false, false, true, false])
    expect(report.handleInSelected).toEqual([false, false, true, false])
    expect(report.handleOutSelected).toEqual([false, true, false, false])
    expect(report.curvesAfter).toEqual([false, false, false])
    expect(report.pathSelected).toBe(true)
    // Import also lists the selected parent layer; the leaf filter excludes it.
    expect(report.selectedItems).toEqual(['Path', 'Layer'])
    expect(report.leaf).toEqual(['Path'])
  }, 30_000)

  it('scratch-exact undo timing: import/update snapshots, selection snapshots nothing, delete->undo pointer-1', async () => {
    const report = await page.evaluate(async () => {
      const paperNs = (window as any).paper
      const buildS = (scope: any): any => {
        scope.activate()
        return new paperNs.Path({
          segments: [
            [[40, 180], null, [60, -70]],
            [[140, 110], [-60, 70], [60, -70]],
            [[240, 40], [-60, 70], [60, -70]],
            [[340, 110], [-60, 70], null],
          ],
        })
      }
      const masksOf = (scope: any): number[] => {
        const found: any[] = []
        const collect = (items: any[]): void => {
          for (const item of items) {
            if (item.segments) found.push(item)
            if (item.children) collect(Array.from(item.children))
          }
        }
        collect(scope.project.layers.flatMap((layer: any) => Array.from(layer.children)))
        if (found.length === 0) return []
        return found[0].segments.map((s: any) => s.selection)
      }
      // Minimal harness of scratch reducers/undo.js + helper/undo.js semantics:
      // snapshots are post-states pushed by import/updates; selection pushes
      // nothing; undo restores stack[pointer-1] with pointer-1 and NO snapshot.
      const makeUndo = () => ({
        stack: [] as any[],
        pointer: -1,
        snapshot(json: any, format: string) {
          this.stack = this.stack.slice(0, this.pointer + 1).concat([{ json, paintEditorFormat: format }])
          this.pointer += 1
        },
        undo(scope: any) {
          if (this.pointer <= 0) return false
          const entry = this.stack[this.pointer - 1]
          scope.project.clear()
          scope.project.importJSON(entry.json)
          this.pointer -= 1
          return true
        },
      })
      const leafCount = (scope: any): number =>
        scope.project.selectedItems.filter(
          (item: any) => !(item instanceof paperNs.Layer) && !(item instanceof paperNs.Group),
        ).length
      const deleteSelectedSegments = (scope: any): boolean => {
        const items = scope.project.selectedItems.filter(
          (item: any) => !(item instanceof paperNs.Layer) && !(item instanceof paperNs.Group),
        )
        const doomed: any[] = []
        for (const item of items) {
          if (!item.segments) continue
          for (const seg of item.segments) if (seg.selected) doomed.push(seg)
        }
        for (const seg of doomed) seg.remove()
        return doomed.length > 0
      }

      // Scenario A: select, delete, undo with NO edit snapshot in between.
      const scopeA = new paperNs.PaperScope()
      const canvasA = document.createElement('canvas')
      canvasA.width = 480
      canvasA.height = 360
      scopeA.setup(canvasA)
      const undoA = makeUndo()
      const pathA = buildS(scopeA)
      undoA.snapshot(scopeA.project.exportJSON({ asString: false }), 'VECTOR') // initial import
      const aAfterImport = { len: undoA.stack.length, pointer: undoA.pointer }
      const curvesA = pathA.getCurves()
      curvesA[0].selected = true
      curvesA[1].selected = true
      curvesA[0].selected = false
      const aMasksSelected = masksOf(scopeA)
      const aLenAfterSelect = undoA.stack.length // mere selection: no snapshot
      const aDeleted = deleteSelectedSegments(scopeA)
      undoA.snapshot(scopeA.project.exportJSON({ asString: false }), 'VECTOR') // delete -> update
      const aAfterDelete = {
        len: undoA.stack.length,
        pointer: undoA.pointer,
        segments: masksOf(scopeA).length,
      }
      const aUndone = undoA.undo(scopeA) // performUndo: pointer-1, no snapshot
      const aAfterUndo = {
        undone: aUndone,
        len: undoA.stack.length,
        pointer: undoA.pointer,
        masks: masksOf(scopeA),
        leaf: leafCount(scopeA),
      }
      scopeA.remove()

      // Scenario B: same, but a post-selection edit snapshot records the 4,3 state first.
      const scopeB = new paperNs.PaperScope()
      const canvasB = document.createElement('canvas')
      canvasB.width = 480
      canvasB.height = 360
      scopeB.setup(canvasB)
      const undoB = makeUndo()
      let pathB = buildS(scopeB)
      undoB.snapshot(scopeB.project.exportJSON({ asString: false }), 'VECTOR') // initial import
      const curvesB = pathB.getCurves()
      curvesB[0].selected = true
      curvesB[1].selected = true
      curvesB[0].selected = false
      pathB = scopeB.project.layers.flatMap((l: any) => Array.from(l.children))[0]
      pathB.segments[3].point = pathB.segments[3].point.add(new paperNs.Point(6, 0)) // prior edit
      undoB.snapshot(scopeB.project.exportJSON({ asString: false }), 'VECTOR') // edit -> update
      const bMasksRecorded = masksOf(scopeB)
      const bAfterEdit = { len: undoB.stack.length, pointer: undoB.pointer }
      deleteSelectedSegments(scopeB)
      undoB.snapshot(scopeB.project.exportJSON({ asString: false }), 'VECTOR') // delete -> update
      undoB.undo(scopeB)
      const bAfterUndo = {
        len: undoB.stack.length,
        pointer: undoB.pointer,
        masks: masksOf(scopeB),
        leaf: leafCount(scopeB),
      }
      // Nudged x of the surviving 4th anchor proves the restored entry is the edit snapshot.
      const bNudgedX = (() => {
        const found: any[] = []
        const collect = (items: any[]): void => {
          for (const item of items) {
            if (item.segments) found.push(item)
            if (item.children) collect(Array.from(item.children))
          }
        }
        collect(scopeB.project.layers.flatMap((l: any) => Array.from(l.children)))
        return found[0].segments[3].point.x
      })()
      scopeB.remove()

      return {
        paperVersion: paperNs.version,
        aAfterImport,
        aMasksSelected,
        aLenAfterSelect,
        aDeleted,
        aAfterDelete,
        aAfterUndo,
        bMasksRecorded,
        bAfterEdit,
        bAfterUndo,
        bNudgedX,
      }
    })
    expect(report.paperVersion).toBe('0.12.18')
    // Scratch timing, scenario A.
    expect(report.aAfterImport).toEqual({ len: 1, pointer: 0 }) // snapshot on initial import
    expect(report.aMasksSelected).toEqual([0, 4, 3, 0])
    expect(report.aLenAfterSelect).toBe(1) // mere selection triggers NO snapshot
    expect(report.aDeleted).toBe(true)
    expect(report.aAfterDelete).toEqual({ len: 2, pointer: 1, segments: 2 }) // delete -> update snapshot
    // Undo restores stack[pointer-1] (the pre-selection import state): selection lost.
    expect(report.aAfterUndo).toEqual({ undone: true, len: 2, pointer: 0, masks: [0, 0, 0, 0], leaf: 0 })
    // Scenario B: a post-selection edit snapshot records the selection.
    expect(report.bMasksRecorded).toEqual([0, 4, 3, 0])
    expect(report.bAfterEdit).toEqual({ len: 2, pointer: 1 })
    expect(report.bAfterUndo).toEqual({ len: 3, pointer: 1, masks: [0, 4, 3, 0], leaf: 1 })
    expect(report.bNudgedX).toBe(346) // 340 + 6: restored entry is the edit snapshot
  }, 30_000)
})
