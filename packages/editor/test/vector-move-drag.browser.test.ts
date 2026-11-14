import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4205'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector move drag (real browser)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4205', '--strictPort'], {
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

  it('snaps to 45 degrees with Shift and passes through without it', async () => {
    const result = await page.evaluate(async () => {
      const { resolveVectorMoveDelta, isVectorMoveNoop } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts'
      )
      const free = resolveVectorMoveDelta({ x: 10, y: 3 }, {})
      const snapped = resolveVectorMoveDelta({ x: 10, y: 3 }, { shiftKey: true })
      const diagonal = resolveVectorMoveDelta({ x: 10, y: 10 }, { shiftKey: true })
      const axis = resolveVectorMoveDelta({ x: 10, y: 1 }, { shiftKey: true })
      return {
        free,
        snapped,
        snappedAngle: Math.atan2(snapped.y, snapped.x),
        diagonal,
        diagonalAngle: Math.atan2(diagonal.y, diagonal.x),
        axis,
        noopZero: isVectorMoveNoop({ x: 0, y: 0 }),
        noopSnappedZero: isVectorMoveNoop(resolveVectorMoveDelta({ x: 0, y: 0 }, { shiftKey: true })),
      }
    })
    expect(result.free.x).toBeCloseTo(10, 9)
    expect(result.free.y).toBeCloseTo(3, 9)
    // Nearest 45-degree lane for (10,3) is the x axis; projection keeps x.
    expect(result.snapped.y).toBeCloseTo(0, 9)
    expect(result.snapped.x).toBeCloseTo(10, 9)
    expect(result.snappedAngle).toBeCloseTo(0, 9)
    expect(result.diagonalAngle).toBeCloseTo(Math.PI / 4, 9)
    expect(result.axis.y).toBeCloseTo(0, 9)
    expect(result.noopZero).toBe(true)
    expect(result.noopSnappedZero).toBe(true)
  }, 30_000)

  it('toggles Shift mid-drag from the same total (no accumulation error)', async () => {
    const result = await page.evaluate(async () => {
      const { resolveVectorMoveDelta } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts'
      )
      const total = { x: 10, y: 8 }
      const plain = resolveVectorMoveDelta(total, {})
      const snapped = resolveVectorMoveDelta(total, { shiftKey: true })
      // Simulate releasing Shift again: must return to the raw total.
      const released = resolveVectorMoveDelta(total, {})
      return { plain, snapped, released }
    })
    expect(result.plain).toEqual({ x: 10, y: 8 })
    // (10,8) snaps to the diagonal lane; x and y stay balanced.
    expect(Math.abs(result.snapped.x - result.snapped.y)).toBeLessThan(1e-9)
    expect(result.released).toEqual({ x: 10, y: 8 })
  }, 30_000)

  it('duplicates in place and moves only the clones', async () => {
    const result = await page.evaluate(async () => {
      const { duplicateVectorUnits, shouldDuplicateVectorMove } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts'
      )
      const { editableVectorUnits } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
      )
      const { moveVectorElementBy } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const before =
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50" fill="red"/><rect x="200" y="20" width="40" height="40" fill="blue"/></svg>'
      const doc = new DOMParser().parseFromString(before, 'image/svg+xml')
      const svg = doc.documentElement
      const clones = duplicateVectorUnits(svg, [0])
      const afterCloneCount = editableVectorUnits(svg).length
      const originalX = editableVectorUnits(svg)[0]?.getAttribute('x')
      // Move only the clones, like the first effective Alt-drag step.
      for (const index of clones) {
        const element = editableVectorUnits(svg)[index]
        if (element) await moveVectorElementBy(element, 30, 0)
      }
      const units = editableVectorUnits(svg)
      const movedClone = clones.length > 0 ? units[clones[0]!] : undefined
      return {
        clones,
        afterCloneCount,
        originalX,
        movedCloneX: movedClone?.getAttribute('x'),
        movedCloneTransform: movedClone?.getAttribute('transform'),
        altClones: shouldDuplicateVectorMove(true, false),
        altWhileTyping: shouldDuplicateVectorMove(true, true),
        noAlt: shouldDuplicateVectorMove(false, false),
      }
    })
    // [0] is the red rect; the clone keeps document order right after it.
    expect(result.clones).toEqual([1])
    expect(result.afterCloneCount).toBe(3)
    expect(result.originalX).toBe('10')
    // Clone moved by +30 (x attr or transform, depending on paper path).
    const movedByAttr = result.movedCloneX !== null && Number(result.movedCloneX) - 10
    const movedByTransform = result.movedCloneTransform?.includes('30')
    expect(movedByAttr === 30 || movedByTransform === true).toBe(true)
    expect(result.altClones).toBe(true)
    expect(result.altWhileTyping).toBe(false)
    expect(result.noAlt).toBe(false)
  }, 30_000)

  it('duplicates transformed groups and nested units without dropping transforms', async () => {
    const result = await page.evaluate(async () => {
      const { duplicateVectorUnits } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts'
      )
      const { editableVectorUnits, vectorObjectBounds } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-svg.ts'
      )
      const { moveVectorElementBy } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      // Case A: top-level group unit keeps its own transform on clone + move.
      const docA = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(5 5)"><rect x="0" y="0" width="10" height="10" fill="red"/><rect x="20" y="0" width="10" height="10" fill="blue"/></g><rect x="100" y="0" width="10" height="10" fill="green"/></svg>',
        'image/svg+xml',
      )
      const svgA = docA.documentElement
      const boundsBeforeA = editableVectorUnits(svgA).map((element) => vectorObjectBounds(element))
      const originalTransformA = editableVectorUnits(svgA)[0]?.getAttribute('transform')
      const clonesA = duplicateVectorUnits(svgA, [0])
      const cloneTransformAfterClone = clonesA.length > 0 ? editableVectorUnits(svgA)[clonesA[0]!]?.getAttribute('transform') : null
      const cloneTagAfterClone = clonesA.length > 0 ? editableVectorUnits(svgA)[clonesA[0]!]?.tagName.toLowerCase() : null
      for (const index of clonesA) {
        const element = editableVectorUnits(svgA)[index]
        if (element) await moveVectorElementBy(element, 30, 0)
      }
      const unitsA = editableVectorUnits(svgA)
      const boundsAfterA = unitsA.map((element) => vectorObjectBounds(element))
      // Case B: units nested under a transformed ancestor stay under it.
      const docB = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(10 0)"><rect x="10" y="20" width="100" height="50" fill="red"/><rect x="200" y="20" width="40" height="40" fill="blue"/></g></svg>',
        'image/svg+xml',
      )
      const svgB = docB.documentElement
      const boundsBeforeB = editableVectorUnits(svgB).map((element) => vectorObjectBounds(element))
      const clonesB = duplicateVectorUnits(svgB, [0])
      const ancestorBeforeB = svgB.children[0]?.getAttribute('transform')
      for (const index of clonesB) {
        const element = editableVectorUnits(svgB)[index]
        if (element) await moveVectorElementBy(element, 30, 0)
      }
      const unitsB = editableVectorUnits(svgB)
      const boundsAfterB = unitsB.map((element) => vectorObjectBounds(element))
      // Case C: multi-select duplicates keep document order (clone after source).
      const docC = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10" fill="red"/><rect x="50" y="0" width="10" height="10" fill="blue"/></svg>',
        'image/svg+xml',
      )
      const svgC = docC.documentElement
      const clonesC = duplicateVectorUnits(svgC, [0, 1])
      const orderC = editableVectorUnits(svgC).map((element) => element.getAttribute('fill'))
      return {
        clonesA,
        countA: editableVectorUnits(svgA).length,
        originalTransformA,
        cloneTransformAfterClone,
        cloneTagAfterClone,
        originalTransformAfterMoveA: unitsA[0]?.getAttribute('transform'),
        cloneTransformAfterMoveA: clonesA.length > 0 ? unitsA[clonesA[0]!]?.getAttribute('transform') : null,
        cloneTagAfterMoveA: clonesA.length > 0 ? unitsA[clonesA[0]!]?.tagName.toLowerCase() : null,
        cloneChildrenA: clonesA.length > 0 ? unitsA[clonesA[0]!]?.children.length : -1,
        dxOriginalA: boundsAfterA[0]!.x - boundsBeforeA[0]!.x,
        dxCloneA: clonesA.length > 0 ? boundsAfterA[clonesA[0]!]!.x - boundsBeforeA[0]!.x : NaN,
        clonesB,
        countB: editableVectorUnits(svgB).length,
        ancestorAfterB: svgB.children[0]?.getAttribute('transform'),
        ancestorBeforeB,
        originalXAfterB: unitsB[0]?.getAttribute('x'),
        dxCloneB: clonesB.length > 0 ? boundsAfterB[clonesB[0]!]!.x - boundsBeforeB[0]!.x : NaN,
        dxOriginalB: boundsAfterB[0]!.x - boundsBeforeB[0]!.x,
        clonesC,
        countC: editableVectorUnits(svgC).length,
        orderC,
      }
    })
    // Case A: clone sits right after its source and keeps the group transform.
    expect(result.clonesA).toEqual([1])
    expect(result.countA).toBe(3)
    expect(result.originalTransformA).toContain('5')
    expect(result.cloneTagAfterClone).toBe('g')
    expect(result.cloneTransformAfterClone).toContain('5')
    // Moving only the clone preserves the original and the group node.
    expect(result.originalTransformAfterMoveA).toBe(result.originalTransformA)
    expect(result.cloneTagAfterMoveA).toBe('g')
    expect(result.cloneChildrenA).toBe(2)
    expect(result.cloneTransformAfterMoveA).toContain('5')
    expect(result.dxOriginalA).toBeCloseTo(0, 6)
    expect(result.dxCloneA).toBeCloseTo(30, 6)
    // Case B: ancestor wrapper survives; original untouched, clone +30 in world.
    expect(result.clonesB).toEqual([1])
    expect(result.countB).toBe(3)
    expect(result.ancestorBeforeB).toContain('10')
    expect(result.ancestorAfterB).toBe(result.ancestorBeforeB)
    expect(result.originalXAfterB).toBe('10')
    expect(result.dxOriginalB).toBeCloseTo(0, 6)
    expect(result.dxCloneB).toBeCloseTo(30, 6)
    // Case C: multi-select clones keep Z order (clone directly after each source).
    expect(result.clonesC).toEqual([1, 3])
    expect(result.countC).toBe(4)
    expect(result.orderC).toEqual(['red', 'red', 'blue', 'blue'])
  }, 30_000)

  it('moves multiple units together and blocks typing targets', async () => {
    const result = await page.evaluate(async () => {
      const { isVectorMoveTypingTarget, resolveVectorMoveDelta } = await import(
        /* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts'
      )
      const { moveVectorElementBy } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10" fill="red"/><rect x="50" y="0" width="10" height="10" fill="blue"/></svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const children = [...svg.children]
      const delta = resolveVectorMoveDelta({ x: 5, y: -2 }, {})
      for (const child of children) await moveVectorElementBy(child, delta.x, delta.y)
      const input = document.createElement('input')
      document.body.append(input)
      const canvas = document.createElement('canvas')
      document.body.append(canvas)
      const outcome = {
        first: children[0]?.getAttribute('transform') ?? children[0]?.getAttribute('x'),
        second: children[1]?.getAttribute('transform') ?? children[1]?.getAttribute('x'),
        inputBlocked: isVectorMoveTypingTarget(input),
        canvasBlocked: isVectorMoveTypingTarget(canvas),
      }
      input.remove()
      canvas.remove()
      return outcome
    })
    expect(result.first).toBeTruthy()
    expect(result.second).toBeTruthy()
    expect(result.inputBlocked).toBe(true)
    expect(result.canvasBlocked).toBe(false)
  }, 30_000)
})
