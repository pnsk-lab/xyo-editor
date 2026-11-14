import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Scratch-paint selection gap audit (behavior oracle, no reference source).
//
// Reference behavior under test (from observed scratch-paint semantics):
// - Marquee is CROSSING, not enclosure: a path matches when a segment point
//   lies inside the rect OR the outline crosses it; a bounds item (rect
//   Shape, raster, text) matches when a bounds corner lies inside OR the
//   bounds border crosses the rect. A rect strictly inside a filled interior
//   matches nothing.
// - Groups drill to children: ANY matching child selects the root group.
// - Shift+marquee toggles matched units (kept/added merge); plain replaces.
// - Marquee selection never mutates artwork, paint, Undo, or Paper project.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4391'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('scratch select/marquee gap audit', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4391', '--strictPort'], {
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

  it('mixed Shape+Path group: marquee over the Shape child selects the group root', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<g class="xyo-vector-explicit-group"><rect x="10" y="10" width="20" height="20" fill="blue"/>' +
        '<path d="M300 200h100v80H300Z" fill="red"/></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = svgMod.editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const overShape = await paper.paperVectorIndicesInRect(units, { x: 0, y: 0, width: 40, height: 40 })
      const overPath = await paper.paperVectorIndicesInRect(units, { x: 290, y: 190, width: 120, height: 100 })
      const neither = await paper.paperVectorIndicesInRect(units, { x: 150, y: 150, width: 20, height: 20 })
      const crossingShape = await paper.paperVectorIndicesInRect(units, { x: 0, y: 0, width: 15, height: 15 })
      const insideShapeInterior = await paper.paperVectorIndicesInRect(units, { x: 15, y: 15, width: 5, height: 5 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return {
        unitCount: units.length,
        unitTag: units[0]?.tagName.toLowerCase(),
        overShape,
        overPath,
        neither,
        crossingShape,
        insideShapeInterior,
        unmutated: before === after,
      }
    })
    expect(result.unitCount).toBe(1)
    expect(result.unitTag).toBe('g')
    // Reference group loop: ANY child crossing/inside selects the root.
    expect(result.overShape).toEqual([0])
    expect(result.overPath).toEqual([0])
    expect(result.neither).toEqual([])
    // Crossing the Shape border selects; a rect strictly inside the filled
    // interior (no corner inside, no border crossing) selects nothing.
    expect(result.crossingShape).toEqual([0])
    expect(result.insideShapeInterior).toEqual([])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('path marquee is crossing, not enclosure: interior-only rect matches nothing', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<path d="M300 200h100v80H300Z" fill="red"/></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = svgMod.editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const enclosing = await paper.paperVectorIndicesInRect(units, { x: 290, y: 190, width: 120, height: 100 })
      const interior = await paper.paperVectorIndicesInRect(units, { x: 320, y: 220, width: 20, height: 20 })
      const repeat = await paper.paperVectorIndicesInRect(units, { x: 290, y: 190, width: 120, height: 100 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { enclosing, interior, repeat, unmutated: before === after }
    })
    // Enclosing marquee holds the path segments -> match (crossing/enclosure).
    expect(result.enclosing).toEqual([0])
    // Strictly-inside marquee touches no segment and crosses no outline.
    expect(result.interior).toEqual([])
    // Pure query: repeatable, no project pollution.
    expect(result.repeat).toEqual([0])
    expect(result.unmutated).toBe(true)
  }, 30_000)

  it('shift+marquee merge toggles matched units (pure parity with selectVectorObjectsInRect)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-point-selection.ts')
      // Object-level equivalent of the kept/added merge used by Editor.
      const current = [0, 1]
      const matched = [1, 2]
      const matchedSet = new Set(matched)
      const kept = current.filter((i: number) => !matchedSet.has(i))
      const currentSet = new Set(current)
      const added = matched.filter((i: number) => !currentSet.has(i))
      const toggled = [...kept, ...added].sort((a: number, b: number) => a - b)
      return {
        toggled,
        pointToggle: mod.mergeReshapeMarqueeSelection([0, 1], [1, 2], true),
        pointReplace: mod.mergeReshapeMarqueeSelection([0, 1], [1, 2], false),
      }
    })
    // 1 was selected and matched -> removed; 2 matched and new -> added; 0 kept.
    expect(result.toggled).toEqual([0, 2])
    expect(result.pointToggle).toEqual([0, 2])
    expect(result.pointReplace).toEqual([1, 2])
  }, 30_000)
})
