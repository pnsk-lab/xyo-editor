// Browser oracle for the singular-fallback fail-closed fix (Paper.js paths).
//
// Runs the REAL editor code (paper-vector.ts / vector-path-points.ts /
// vector-point-style.ts) inside Chromium via Vite, with real
// DOMParser/XMLSerializer and Paper.js. Each case uses a degenerate ancestor
// (scale(0), scale(0,1), matrix(1 2 2 4 0 0)) and asserts the write is
// refused with history/selection/DOM untouched (applied=false, DOM
// byte-identical). Reversible skew/rotate/non-uniform and transform-free
// zero-area shapes stay editable; near-singular scale(1e-12) stays editable
// by design (representable amplification, documented in the unit audit).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4191'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('singular fallback browser oracle (fail-closed)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4191', '--strictPort'], {
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

  it('moveVectorElementBy on a rect under scale(0) is refused (no invisible move)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="5" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('rect')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const applied = await mod.moveVectorElementBy(leaf, 30, 15)
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { applied, changed: before !== after, afterX: doc.querySelector('rect')!.getAttribute('x') }
    })
    // Fail-closed: singular ancestor has no unique preimage, so no DOM write
    // and no history entry is needed.
    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.afterX).toBe('10')
  }, 30_000)

  it('resizeVectorElementBy under scale(0 1) is refused (no spurious history)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0 1)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('rect')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const applied = await mod.resizeVectorElementBy(leaf, 'se', 20, 20)
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { applied, changed: before !== after, after }
    })
    expect(result.changed).toBe(false)
    expect(result.applied).toBe(false)
  }, 30_000)

  it('paper path reshape under matrix(1 2 2 4 0 0) is refused', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="matrix(1 2 2 4 0 0)"><path d="M 10 10 L 30 10 L 30 30 Z" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('path')!
      const before = leaf.getAttribute('d')
      const applied = await mod.moveVectorEditablePoint(leaf, 0, 50, 50)
      return { before, after: doc.querySelector('path')!.getAttribute('d'), applied }
    })
    expect(result.applied).toBe(false)
    expect(result.after).toBe(result.before)
  }, 30_000)

  it('applyWorldMatrix under singular ancestor is refused (no conjugation hazard)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('rect')!
      const before = leaf.getAttribute('transform')
      const applied = mod.applyWorldMatrixToVectorElement(leaf, [1, 0, 0, 1, 10, 0])
      return { before, after: doc.querySelector('rect')!.getAttribute('transform'), applied }
    })
    expect(result.applied).toBe(false)
    expect(result.before).toBeNull()
    expect(result.after).toBeNull()
  }, 30_000)

  it('rotate / flip under singular ancestor refuse the whole arrangement', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('rect')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const rotated = mod.rotateVectorElementsAroundCenter([leaf], 90, { x: 0, y: 0 })
      const mid = new XMLSerializer().serializeToString(doc.documentElement)
      const flipped = mod.flipVectorElementsAroundCenter([leaf], true, { x: 0, y: 0 })
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { rotated, flipped, changedRotate: before !== mid, changedFlip: mid !== after }
    })
    expect(result.rotated).toBe(false)
    expect(result.flipped).toBe(false)
    expect(result.changedRotate).toBe(false)
    expect(result.changedFlip).toBe(false)
  }, 30_000)

  it('scaleVectorElementsByCommonBounds under scale(0) stays a no-op (empty history prevention)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('rect')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const applied = mod.scaleVectorElementsByCommonBounds([leaf], 'se', 20, 20)
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { applied, changed: before !== after }
    })
    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
  }, 30_000)

  it('scaleVectorElementsByCommonBounds under scale(0 1) is refused (partial collapse)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0 1)"><rect x="10" y="10" width="20" height="20" fill="red"/><rect x="40" y="40" width="20" height="20" fill="blue"/></g></svg>',
        'image/svg+xml',
      )
      const leaves = Array.from(doc.querySelectorAll('rect'))
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const applied = mod.scaleVectorElementsByCommonBounds(leaves, 'se', 20, 20)
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { applied, changed: before !== after }
    })
    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
  }, 30_000)

  it('group unit path move under scale(0) is refused (no leaf d rewrite)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><path d="M 10 10 L 30 10 L 30 30 Z" fill="red"/><path d="M 40 40 L 60 40 L 60 60 Z" fill="blue"/></g></svg>',
        'image/svg+xml',
      )
      const unit = doc.querySelector('g')!
      const before = Array.from(unit.querySelectorAll('path')).map((l) => l.getAttribute('d'))
      const applied = await mod.moveVectorEditablePoint(unit, 0, 50, 50)
      const after = Array.from(unit.querySelectorAll('path')).map((l) => l.getAttribute('d'))
      return { before, after, applied }
    })
    expect(result.applied).toBe(false)
    expect(result.after).toEqual(result.before)
  }, 30_000)

  it('reshape add / bulk-move / delete under scale(0) are refused (no history)', async () => {
    const result = await page.evaluate(async () => {
      const pathMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('path')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const added = await pathMod.addVectorPathPoint(leaf, 30, 10)
      const mid = new XMLSerializer().serializeToString(doc.documentElement)
      const moved = await pathMod.moveVectorReshapePoints(leaf, [{ index: 0, x: 99, y: 99 }])
      const mid2 = new XMLSerializer().serializeToString(doc.documentElement)
      const deleted = await pathMod.deleteVectorPathPoints(leaf, [0])
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return {
        added: added.added,
        moved: moved.moved,
        deleted: deleted.deleted,
        changedAdd: before !== mid,
        changedMove: mid !== mid2,
        changedDelete: mid2 !== after,
      }
    })
    expect(result.added).toBe(false)
    expect(result.moved).toBe(false)
    expect(result.deleted).toBe(false)
    expect(result.changedAdd).toBe(false)
    expect(result.changedMove).toBe(false)
    expect(result.changedDelete).toBe(false)
  }, 30_000)

  it('point style under scale(0) is refused (no whole-replace fallback)', async () => {
    const result = await page.evaluate(async () => {
      const styleMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-point-style.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" fill="red"/></g></svg>',
        'image/svg+xml',
      )
      const leaf = doc.querySelector('path')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // Curve anchor 0: would insert handles in the detached Paper import, but
      // the outer singular ancestor makes the edit invisible, so refuse.
      const curved = await styleMod.curveVectorPointStyle(leaf, [0])
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { changed: curved.changed, same: before === after }
    })
    expect(result.changed).toBe(false)
    expect(result.same).toBe(true)
  }, 30_000)

  it('reversible skew and plain units stay editable (no regression)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="skewX(20)"><rect x="10" y="10" width="20" height="20" fill="red"/></g><rect x="10" y="10" width="20" height="5" fill="blue"/></svg>',
        'image/svg+xml',
      )
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      const skewedApplied = await mod.moveVectorElementBy(doc.querySelector('g rect')!, 10, 0)
      const mid = new XMLSerializer().serializeToString(doc.documentElement)
      // Re-query after the Paper round-trip replaced the node.
      const plainApplied = await mod.moveVectorElementBy(doc.querySelectorAll('rect')[1]!, 10, 0)
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return {
        skewedApplied,
        plainApplied,
        skewedChanged: before !== mid,
        plainChanged: mid !== after,
      }
    })
    expect(result.skewedApplied).toBe(true)
    expect(result.plainApplied).toBe(true)
    expect(result.skewedChanged).toBe(true)
    expect(result.plainChanged).toBe(true)
  }, 30_000)

  it('single-unit applyPaperScale/Rotation/Flip refuse under scale(0) ancestors (rect/path/group)', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const out: Record<string, unknown> = {}
      for (const tag of ['rect', 'path', 'group'] as const) {
        const leafSvg =
          tag === 'rect'
            ? '<rect x="10" y="10" width="20" height="20" fill="red"/>'
            : tag === 'path'
              ? '<path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" fill="red"/>'
              : '<g><rect x="10" y="10" width="20" height="20" fill="red"/><path d="M 40 40 L 60 40 L 60 60 Z" fill="blue"/></g>'
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)">${leafSvg}</g></svg>`,
          'image/svg+xml',
        )
        const unit = doc.querySelector('g > rect, g > path, g > g')!
        const before = new XMLSerializer().serializeToString(doc.documentElement)
        const scaled = await mod.applyPaperScale(unit, 1.1)
        const mid = new XMLSerializer().serializeToString(doc.documentElement)
        const rotated = await mod.applyPaperRotation(unit, 15)
        const mid2 = new XMLSerializer().serializeToString(doc.documentElement)
        const flippedH = await mod.applyPaperFlip(unit, true)
        const mid3 = new XMLSerializer().serializeToString(doc.documentElement)
        const flippedV = await mod.applyPaperFlip(unit, false)
        const after = new XMLSerializer().serializeToString(doc.documentElement)
        out[tag] = { scaled, rotated, flippedH, flippedV, unchanged: before === mid && mid === mid2 && mid2 === mid3 && mid3 === after }
      }
      return out
    })
    for (const tag of ['rect', 'path', 'group'] as const) {
      const entry = result[tag] as { scaled: boolean; rotated: boolean; flippedH: boolean; flippedV: boolean; unchanged: boolean }
      expect(entry.scaled).toBe(false)
      expect(entry.rotated).toBe(false)
      expect(entry.flippedH).toBe(false)
      expect(entry.flippedV).toBe(false)
      expect(entry.unchanged).toBe(true)
    }
  }, 30_000)

  it('single/multi applyPaper + arrangement stay reversible under nonuniform/skew ancestors', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const out: Record<string, unknown> = {}
      for (const ancestor of ['scale(2 3)', 'skewX(20)', 'skewY(15)', 'rotate(30)'] as const) {
        const doc = new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><g transform="${ancestor}"><rect x="10" y="10" width="20" height="20" fill="red"/><path d="M 40 40 L 80 40 L 80 70 L 40 70 Z" fill="blue"/></g></svg>`,
          'image/svg+xml',
        )
        const leaves = Array.from(doc.querySelectorAll('rect, path'))
        const before = new XMLSerializer().serializeToString(doc.documentElement)
        const single = await mod.applyPaperRotation(leaves[0]!, 15)
        const mid = new XMLSerializer().serializeToString(doc.documentElement)
        const multiRotate = mod.rotateVectorElementsAroundCenter(leaves, 15, { x: 50, y: 50 })
        const mid2 = new XMLSerializer().serializeToString(doc.documentElement)
        const multiFlip = mod.flipVectorElementsAroundCenter(leaves, true, { x: 50, y: 50 })
        const after = new XMLSerializer().serializeToString(doc.documentElement)
        out[ancestor] = { single, multiRotate, multiFlip, changedSingle: before !== mid, changedRotate: mid !== mid2, changedFlip: mid2 !== after }
      }
      return out
    })
    for (const ancestor of ['scale(2 3)', 'skewX(20)', 'skewY(15)', 'rotate(30)'] as const) {
      const entry = result[ancestor] as { single: boolean; multiRotate: boolean; multiFlip: boolean; changedSingle: boolean; changedRotate: boolean; changedFlip: boolean }
      expect(entry.single).toBe(true)
      expect(entry.multiRotate).toBe(true)
      expect(entry.multiFlip).toBe(true)
      expect(entry.changedSingle).toBe(true)
      expect(entry.changedRotate).toBe(true)
      expect(entry.changedFlip).toBe(true)
    }
  }, 30_000)

  it('nested own singular (own scale(0) / inner scale(0)) refuses single and multi paths', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      // Own singular: the unit itself carries scale(0) with clean ancestors.
      const ownDoc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="20" fill="red" transform="scale(0)"/></svg>',
        'image/svg+xml',
      )
      const ownLeaf = ownDoc.querySelector('rect')!
      const ownBefore = new XMLSerializer().serializeToString(ownDoc.documentElement)
      const ownScaled = await mod.applyPaperScale(ownLeaf, 1.1)
      const ownMid = new XMLSerializer().serializeToString(ownDoc.documentElement)
      const ownRotated = await mod.applyPaperRotation(ownLeaf, 15)
      const ownMid2 = new XMLSerializer().serializeToString(ownDoc.documentElement)
      const ownFlipped = await mod.applyPaperFlip(ownLeaf, true)
      const ownAfter = new XMLSerializer().serializeToString(ownDoc.documentElement)
      // In-unit singular: outer group unit contains an inner scale(0) wrapper.
      const innerDoc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/></g><path d="M 40 40 L 60 40 L 60 60 Z" fill="blue"/></g></svg>',
        'image/svg+xml',
      )
      const innerUnit = innerDoc.querySelector('svg > g')!
      const innerBefore = new XMLSerializer().serializeToString(innerDoc.documentElement)
      const innerScaled = await mod.applyPaperScale(innerUnit, 1.1)
      const innerMid = new XMLSerializer().serializeToString(innerDoc.documentElement)
      const innerRotated = await mod.applyPaperRotation(innerUnit, 15)
      const innerAfter = new XMLSerializer().serializeToString(innerDoc.documentElement)
      // Multi arrangement over a nested-own-singular leaf refuses as a whole.
      const multiDoc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/></g></g><rect x="100" y="100" width="20" height="20" fill="blue"/></svg>',
        'image/svg+xml',
      )
      const multiLeaves = [multiDoc.querySelector('g rect')!, multiDoc.querySelector('svg > rect')!]
      const multiBefore = new XMLSerializer().serializeToString(multiDoc.documentElement)
      const multiRotate = mod.rotateVectorElementsAroundCenter(multiLeaves, 15, { x: 50, y: 50 })
      const multiMid = new XMLSerializer().serializeToString(multiDoc.documentElement)
      const multiFlip = mod.flipVectorElementsAroundCenter(multiLeaves, false, { x: 50, y: 50 })
      const multiAfter = new XMLSerializer().serializeToString(multiDoc.documentElement)
      // Stale-shaped world input (singular document matrix) refuses without write.
      const staleDoc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="20" fill="red"/></svg>',
        'image/svg+xml',
      )
      const staleLeaf = staleDoc.querySelector('rect')!
      const staleBefore = new XMLSerializer().serializeToString(staleDoc.documentElement)
      const staleApplied = mod.applyWorldMatrixToVectorElement(staleLeaf, [0, 0, 0, 0, 0, 0])
      const staleAfter = new XMLSerializer().serializeToString(staleDoc.documentElement)
      return {
        ownScaled, ownRotated, ownFlipped,
        ownUnchanged: ownBefore === ownMid && ownMid === ownMid2 && ownMid2 === ownAfter,
        innerScaled, innerRotated, innerUnchanged: innerBefore === innerMid && innerMid === innerAfter,
        multiRotate, multiFlip, multiUnchanged: multiBefore === multiMid && multiMid === multiAfter,
        staleApplied, staleUnchanged: staleBefore === staleAfter,
      }
    })
    expect(result.ownScaled).toBe(false)
    expect(result.ownRotated).toBe(false)
    expect(result.ownFlipped).toBe(false)
    expect(result.ownUnchanged).toBe(true)
    expect(result.innerScaled).toBe(false)
    expect(result.innerRotated).toBe(false)
    expect(result.innerUnchanged).toBe(true)
    expect(result.multiRotate).toBe(false)
    expect(result.multiFlip).toBe(false)
    expect(result.multiUnchanged).toBe(true)
    expect(result.staleApplied).toBe(false)
    expect(result.staleUnchanged).toBe(true)
  }, 30_000)
})
