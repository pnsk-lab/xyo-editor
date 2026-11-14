import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
// Other browser tests use 4173/4178/4179/4180/4183/4189/4191/4197-4199/
// 4205/4213/4227/4231/4232/4234-4238/4241/4242/4245/4249/4255/4256/
// 4261/4263/4277/4281/4288/4289/4291/4295/4297/4317/4321.
const base = 'http://127.0.0.1:4247'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector multi-point selection with real Paper geometry', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4247', '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
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

  it('marquee-selects anchors in document coordinates under a translated wrapper', async () => {
    const result = await page.evaluate(async () => {
      const multi = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="quad" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green" stroke="black"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const list = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const points = (list[0] as any).points as Array<{ index: number; x: number; y: number; kind: string }>
      // Quad anchors in document coords: (50,40), (110,40), (110,90), (50,90).
      const leftHalf = multi.reshapePointsInRect(points, { x: 0, y: 0, width: 80, height: 130 })
      const toggled = multi.mergeReshapeMarqueeSelection(leftHalf, [2], true)
      const replaced = multi.mergeReshapeMarqueeSelection(leftHalf, [2], false)
      return { points, leftHalf, toggled, replaced }
    })
    expect(result.leftHalf).toEqual([0, 3])
    // Shift+marquee toggles: 2 is added, current kept.
    expect(result.toggled).toEqual([0, 2, 3])
    expect(result.replaced).toEqual([2])
  }, 30_000)

  it('bulk anchor moves travel rigidly via the existing writer and spare other segments', async () => {
    const result = await page.evaluate(async () => {
      const multi = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svgMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="curve" d="M 10 30 C 20 30 30 30 40 30 C 50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const element = doc.querySelector('#curve')!
      const before = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0] as any
      const points = before.points as Array<{ index: number; x: number; y: number; kind: string; relatedAnchorIndex?: number }>
      const anchor = points.find((p) => p.kind === 'anchor' && Math.abs(p.x - 40) < 0.01)!
      const targets = multi.reshapeBulkMoveTargets(points, [anchor.index], 0, 5)
      const anchorTargets = targets.filter((t: { index: number }) =>
        (points as Array<any>).find((p) => p.index === t.index)?.kind === 'anchor',
      )
      // Paper-backed application: anchors only (handles follow the segment point).
      for (const target of anchorTargets) {
        await paperMod.moveVectorEditablePoint(element, target.index, target.x, target.y)
      }
      const after = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0] as any
      const movedAnchor = (after.points as Array<any>).find((p) => p.index === anchor.index)
      const unit = svgMod.editableVectorUnits(doc.documentElement)[0]!
      return {
        anchorIndex: anchor.index,
        anchorTargets,
        targetCount: targets.length,
        movedAnchor,
        survivor0: (after.points as Array<any>).find((p) => p.kind === 'anchor' && Math.abs(p.x - 10) < 0.01),
        tagKept: unit.tagName.toLowerCase(),
      }
    })
    // Only one anchor target; the pure helper also predicts its handle offsets.
    expect(result.anchorTargets).toHaveLength(1)
    expect(result.targetCount).toBeGreaterThan(1)
    expect(result.movedAnchor.x).toBeCloseTo(40, 4)
    expect(result.movedAnchor.y).toBeCloseTo(35, 4)
    expect(result.survivor0.x).toBeCloseTo(10, 4)
    expect(result.tagKept).toBe('path')
  }, 30_000)

  it('delete remap tracks the surviving anchor with real flattened indices', async () => {
    const result = await page.evaluate(async () => {
      const multi = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="quad" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green" stroke="black"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const quad = doc.querySelector('#quad')!
      const before = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0] as any
      const points = before.points as Array<{ index: number; x: number; y: number; kind: string }>
      const selection = multi.reshapePointsInRect(points, { x: -5, y: -5, width: 70, height: 30 })
      const deleted = selection[1]!
      const remapped = multi.remapReshapeSelectionAfterAnchorDelete(selection, points, deleted)
      const del = await mod.deleteVectorPathPoint(quad, deleted)
      const after = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0] as any
      const live = remapped.every((index: number) => multi.isReshapeAnchorLive(after.points, index))
      return { selection, deleted, remapped, del, live, afterCount: (after.points as Array<any>).filter((p) => p.kind === 'anchor').length }
    })
    // Top edge marquee catches anchors 0 and 1; deleting 1 shifts old 2/3 down.
    expect(result.selection).toEqual([0, 1])
    expect(result.del.deleted).toBe(true)
    expect(result.remapped).toEqual([0])
    expect(result.live).toBe(true)
    expect(result.afterCount).toBe(3)
  }, 30_000)
})
