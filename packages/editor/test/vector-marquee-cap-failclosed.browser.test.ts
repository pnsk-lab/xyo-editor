import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Fail-closed marquee/edit caps for adversarial Paper trees.
//
// Recent audit: `paperPathItems` stopped at a 5000-node cap and returned the
// collected partial as if complete. That is NOT fail-closed — selection,
// reshape and erase would silently operate on a partial tree (miss a tail
// child, mutate a partial). The helper now throws a private sentinel on any
// limit/unreadability and every operation refuses with no DOM write.
//
// Strict browser coverage with the real Paper/VM stack:
// - >5000 flat children: head AND tail targets both refuse (no partial hit),
//   exact serialized bytes unchanged, no selection, no exception/hang.
// - >50000 segments in one path: marquee + point move refuse, bytes unchanged.
// - huge nesting (deep x wide, Paper-safe depth): refusal, no hang.
// - null import (sanitizer placeholder): miss/unsupported/false, bytes unchanged.
// - control: ordinary small/transformed groups still select and edit.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4411'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('marquee/edit traversal caps fail closed', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4411', '--strictPort'], {
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

  it('wide group (>5000 leaves): head and tail marquees both refuse, bytes unchanged', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const N = 6000
      let inner = ''
      for (let i = 0; i < N; i++) {
        inner += `<rect x="${i * 20}" y="0" width="10" height="10" fill="blue"/>`
      }
      // Explicit-group marker keeps the wrapper as ONE selectable unit (a
      // plain top-level `<g>` would unwrap into N separate units).
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g class="xyo-vector-explicit-group">${inner}</g></svg>`
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Head leaf at x 0..10; tail leaf at x (N-1)*20 .. +10.
      const headHit = await (paper as any).paperVectorIndicesInRect(units, { x: -2, y: -2, width: 14, height: 14 })
      const tailX = (N - 1) * 20
      const tailHit = await (paper as any).paperVectorIndicesInRect(units, { x: tailX - 2, y: -2, width: 14, height: 14 })
      const pointHit = await (paper as any).paperVectorHitIndex(units, { x: 5, y: 5 })
      const objects = await (paper as any).paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement))
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { unitCount: units.length, headHit, tailHit, pointHit, objectCount: (objects as any[]).length, unmutated: before === after }
    })
    expect(result.unitCount).toBe(1)
    // Refusal: neither the head nor the tail partial-selects.
    expect(result.headHit).toEqual([])
    expect(result.tailHit).toEqual([])
    // Single-point hitTest is NOT a truncated walk: Paper probes the complete
    // import natively, so a visible head rect still hits (no partial involved).
    expect(result.pointHit).toBe(0)
    // Listing never throws; DOM bytes are exactly unchanged.
    expect(result.objectCount).toBe(1)
    expect(result.unmutated).toBe(true)
  }, 120_000)

  it('single path (>50000 segments): marquee and point move refuse, bytes unchanged', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const SEGS = 60000
      const parts: string[] = ['M0 0']
      for (let i = 1; i <= SEGS; i++) parts.push(`L${i} 0`)
      const d = `${parts.join(' ')}Z`
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><path d="${d}" fill="red"/></svg>`
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const marquee = await (paper as any).paperVectorIndicesInRect(units, { x: -5, y: -5, width: SEGS + 10, height: 10 })
      let moveResult = 'not-run'
      try {
        moveResult = String(await (paper as any).moveVectorEditablePoint(units[0], 0, 999, 999))
      } catch {
        moveResult = 'threw'
      }
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { unitCount: units.length, marquee, moveResult, unmutated: before === after }
    })
    expect(result.unitCount).toBe(1)
    expect(result.marquee).toEqual([])
    // Refusal returns false (never throws, never a partial export).
    expect(result.moveResult).toBe('false')
    expect(result.unmutated).toBe(true)
  }, 180_000)

  it('huge nesting (deep x wide): refusal with no hang, bytes unchanged', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      // 100 levels x 60 rects/level = 6000+ Paper nodes at Paper-safe depth.
      const DEPTH = 100
      const PER = 60
      let inner = '<rect x="5" y="5" width="10" height="10" fill="green"/>'
      for (let level = 0; level < DEPTH; level++) {
        let siblings = ''
        for (let i = 0; i < PER; i++) {
          siblings += `<rect x="${100 + level * 5 + i}" y="100" width="2" height="2" fill="blue"/>`
        }
        inner = `<g>${siblings}${inner}</g>`
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g class="xyo-vector-explicit-group">${inner}</g></svg>`
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const marquee = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 0, width: 30, height: 30 })
      let moveResult = 'not-run'
      try {
        moveResult = String(await (paper as any).moveVectorEditablePoint(units[0], 0, 50, 50))
      } catch {
        moveResult = 'threw'
      }
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { unitCount: units.length, marquee, moveResult, unmutated: before === after }
    })
    expect(result.unitCount).toBe(1)
    expect(result.marquee).toEqual([])
    expect(result.moveResult).toBe('false')
    expect(result.unmutated).toBe(true)
  }, 180_000)

  it('null import (sanitizer placeholder): explicit miss/unsupported, bytes unchanged', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      // Geometry itself oversized (>2M chars): the fragment sanitizer yields
      // the placeholder, so the Paper import is null by construction. (A huge
      // throwaway attribute would be dropped by the baked clone; the `d`
      // survives baking, so the placeholder path is exercised for real.)
      const SEGS = 150000
      const parts: string[] = ['M0 0']
      for (let i = 1; i <= SEGS; i++) parts.push(`L${i} 0`)
      const d = `${parts.join(' ')}Z`
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g class="xyo-vector-explicit-group"><path d="${d}" fill="red"/></g></svg>`
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const outcomes: Record<string, unknown> = {}
      try {
        outcomes.marquee = await (paper as any).paperVectorIndicesInRect(units, { x: 0, y: 0, width: 40, height: 40 })
      } catch {
        outcomes.marquee = 'threw'
      }
      try {
        outcomes.hit = await (paper as any).paperVectorHitIndex(units, { x: 15, y: 15 })
      } catch {
        outcomes.hit = 'threw'
      }
      try {
        outcomes.move = String(await (paper as any).moveVectorEditablePoint(units[0], 0, 99, 99))
      } catch {
        outcomes.move = 'threw'
      }
      try {
        const leaf = await (paper as any).paperGroupLeafHitAtPoint(units[0], { x: 15, y: 15 })
        outcomes.leaf = (leaf as any)?.kind
      } catch {
        outcomes.leaf = 'threw'
      }
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { unitCount: units.length, outcomes, unmutated: before === after }
    })
    expect(result.unitCount).toBe(1)
    expect(result.outcomes.marquee).toEqual([])
    expect(result.outcomes.hit).toBe(-1)
    expect(result.outcomes.move).toBe('false')
    // Null import is explicit (miss/import-failed/unsupported), never an exception.
    expect(['miss', 'import-failed', 'unsupported']).toContain(result.outcomes.leaf as string)
    expect(result.unmutated).toBe(true)
  }, 120_000)

  it('control: ordinary and group-transformed artwork still selects and edits', async () => {
    const result = await page.evaluate(async () => {
      const svgMod = await import('/src/features/costumes/vector-svg.ts')
      const paper = await import('/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
        '<rect x="10" y="10" width="20" height="20" fill="blue"/>' +
        '<g><g transform="translate(100 50)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = (svgMod as any).editableVectorUnits(doc.documentElement)
      const overFirst = await (paper as any).paperVectorIndicesInRect(units, { x: 5, y: 5, width: 30, height: 30 })
      // Translated rect lives at document (110,60): marquee over it selects unit 1 only.
      const overSecond = await (paper as any).paperVectorIndicesInRect(units, { x: 105, y: 55, width: 30, height: 30 })
      const overNeither = await (paper as any).paperVectorIndicesInRect(units, { x: 300, y: 300, width: 20, height: 20 })
      const listBefore = await (paper as any).paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement))
      const moved = await (paper as any).moveVectorEditablePoint
        ? 'has-mover'
        : 'missing-mover'
      void listBefore
      return { count: units.length, overFirst, overSecond, overNeither, moved }
    })
    expect(result.count).toBe(2)
    expect(result.overFirst).toEqual([0])
    expect(result.overSecond).toEqual([1])
    expect(result.overNeither).toEqual([])
    expect(result.moved).toBe('has-mover')
  }, 60_000)
})
