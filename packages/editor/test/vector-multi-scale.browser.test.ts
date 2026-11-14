import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// DOM 適用経路の確認のみ。新ヘルパー自体は DOM/Paper 非依存の純粋計算で、
// ここでは実 DOM の祖先行列 (`ancestorWorldMatrix`) と幾何バウンズ
// (`vectorObjectBounds`) を使って「共役配布で共通 W 通りに拡縮されること」
// 「祖先・文書順序に触れないこと」を検証する。既存ファイルは変更しない。
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4261'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector multi-scale common-bounds application (DOM path)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4261', '--strictPort'], { cwd: root, stdio: 'pipe' })
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

  it('scales distinct-ancestor units through one shared world matrix', async () => {
    const result = await page.evaluate(async () => {
      const multi = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-scale.ts')
      const svgHelpers = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const { ancestorWorldMatrix, vectorObjectBounds } = svgHelpers as unknown as {
        ancestorWorldMatrix: (element: Element) => [number, number, number, number, number, number] | undefined
        vectorObjectBounds: (element: Element) => { x: number; y: number; width: number; height: number }
      }
      const {
        localScaleMatrixForAncestor,
        prependVectorMatrix6Attribute,
        resolveCommonVectorScale,
        transformVectorPoint6,
        unionVectorScaleBounds,
      } = multi as unknown as {
        localScaleMatrixForAncestor: (ancestor: [number, number, number, number, number, number] | undefined, world: [number, number, number, number, number, number]) => [number, number, number, number, number, number]
        prependVectorMatrix6Attribute: (existing: string, local: [number, number, number, number, number, number]) => string
        resolveCommonVectorScale: (
          handle: 'se',
          bounds: { x: number; y: number; width: number; height: number },
          dx: number,
          dy: number,
          modifiers?: Record<string, boolean>,
        ) => { pivot: { x: number; y: number }; scaleX: number; scaleY: number; world: [number, number, number, number, number, number] }
        transformVectorPoint6: (matrix: [number, number, number, number, number, number], point: { x: number; y: number }) => { x: number; y: number }
        unionVectorScaleBounds: (list: Array<{ x: number; y: number; width: number; height: number }>) => { x: number; y: number; width: number; height: number } | undefined
      }
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g id="outer" transform="translate(30 10)">' +
        '<rect id="a" x="10" y="20" width="40" height="20" fill="red"/>' +
        '<g id="inner" transform="translate(70 0)"><rect id="b" x="10" y="20" width="40" height="20" fill="blue"/></g>' +
        '</g>' +
        '<rect id="c" x="150" y="100" width="50" height="30" fill="green"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const elements = ['a', 'b', 'c'].map((id) => doc.getElementById(id)!) as Element[]
      const beforeBounds = elements.map((element) => vectorObjectBounds(element))
      const union = unionVectorScaleBounds(beforeBounds)
      if (!union) return { ok: false as const, reason: 'no-union' }
      const resolved = resolveCommonVectorScale('se', union, 20, 10, { shiftKey: true })
      const outerBefore = (doc.getElementById('outer') as Element).getAttribute('transform')
      const innerBefore = (doc.getElementById('inner') as Element).getAttribute('transform')
      const orderBefore = new XMLSerializer().serializeToString(doc.documentElement)
      for (const element of elements) {
        const local = localScaleMatrixForAncestor(ancestorWorldMatrix(element), resolved.world)
        element.setAttribute('transform', prependVectorMatrix6Attribute(element.getAttribute('transform') ?? '', local))
      }
      const afterBounds = elements.map((element) => vectorObjectBounds(element))
      const failures: string[] = []
      const check = (name: string, condition: boolean) => { if (!condition) failures.push(name) }
      // 各要素のワールドバウンズが共通 W 通りに移る (軸平行のため AABB が一致)。
      for (let i = 0; i < elements.length; i++) {
        const before = beforeBounds[i]!
        const after = afterBounds[i]!
        const corners = [
          { x: before.x, y: before.y },
          { x: before.x + before.width, y: before.y + before.height },
        ].map((point) => transformVectorPoint6(resolved.world, point))
        const expectedLeft = Math.min(corners[0]!.x, corners[1]!.x)
        const expectedTop = Math.min(corners[0]!.y, corners[1]!.y)
        check(`x-${i}`, Math.abs(after.x - expectedLeft) < 1)
        check(`y-${i}`, Math.abs(after.y - expectedTop) < 1)
        check(`w-${i}`, Math.abs(after.width - Math.abs(corners[1]!.x - corners[0]!.x)) < 1)
        check(`h-${i}`, Math.abs(after.height - Math.abs(corners[1]!.y - corners[0]!.y)) < 1)
      }
      // 祖先 transform と文書順序 (重なり順) は不変。
      check('outer-kept', (doc.getElementById('outer') as Element).getAttribute('transform') === outerBefore)
      check('inner-kept', (doc.getElementById('inner') as Element).getAttribute('transform') === innerBefore)
      const fills = ['a', 'b', 'c'].map((id) => (doc.getElementById(id) as Element).getAttribute('fill'))
      check('order-kept', JSON.stringify(fills) === JSON.stringify(['red', 'blue', 'green']))
      void orderBefore
      return { ok: true as const, failures }
    })
    if (!result.ok) throw new Error(`helper failed: ${result.reason}`)
    expect(result.failures).toEqual([])
  }, 30_000)

  it('mirrors positions on negative scale without touching ancestors', async () => {
    const result = await page.evaluate(async () => {
      const multi = await import(/* @vite-ignore */ '/src/features/costumes/vector-multi-scale.ts')
      const svgHelpers = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const { ancestorWorldMatrix, vectorObjectBounds } = svgHelpers as unknown as {
        ancestorWorldMatrix: (element: Element) => [number, number, number, number, number, number] | undefined
        vectorObjectBounds: (element: Element) => { x: number; y: number; width: number; height: number }
      }
      const { localScaleMatrixForAncestor, prependVectorMatrix6Attribute, resolveCommonVectorScale, unionVectorScaleBounds } = multi as unknown as {
        localScaleMatrixForAncestor: (ancestor: [number, number, number, number, number, number] | undefined, world: [number, number, number, number, number, number]) => [number, number, number, number, number, number]
        prependVectorMatrix6Attribute: (existing: string, local: [number, number, number, number, number, number]) => string
        resolveCommonVectorScale: (
          handle: 'se',
          bounds: { x: number; y: number; width: number; height: number },
          dx: number,
          dy: number,
          modifiers?: Record<string, boolean>,
        ) => { pivot: { x: number; y: number }; scaleX: number; scaleY: number; world: [number, number, number, number, number, number]; flippedX: boolean }
        unionVectorScaleBounds: (list: Array<{ x: number; y: number; width: number; height: number }>) => { x: number; y: number; width: number; height: number } | undefined
      }
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(30 10)">' +
        '<rect x="10" y="20" width="40" height="20" fill="red"/>' +
        '<rect x="80" y="20" width="40" height="20" fill="blue"/></g></svg>'
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const group = doc.documentElement.firstElementChild!
      const elements = Array.from(group.children) as Element[]
      const union = unionVectorScaleBounds(elements.map((element) => vectorObjectBounds(element)))
      if (!union) return { ok: false as const, reason: 'no-union' }
      // 固定点 (左端) を大きく超えるドラッグで X 反転させる。
      const resolved = resolveCommonVectorScale('se', union, -200, 0, { shiftKey: true })
      if (!resolved.flippedX) return { ok: false as const, reason: 'no-flip' }
      for (const element of elements) {
        element.setAttribute('transform', prependVectorMatrix6Attribute(element.getAttribute('transform') ?? '', localScaleMatrixForAncestor(ancestorWorldMatrix(element), resolved.world)))
      }
      const after = elements.map((element) => vectorObjectBounds(element))
      const ancestorKept = group.getAttribute('transform') === 'translate(30 10)'
      return { ok: true as const, ancestorKept, widths: after.map((b) => b.width), flipped: resolved.scaleX < 0 }
    })
    if (!result.ok) throw new Error(`helper failed: ${result.reason}`)
    expect(result.ancestorKept).toBe(true)
    expect(result.flipped).toBe(true)
    expect(result.widths.length).toBe(2)
  }, 30_000)

  it('applies one shared scale without touching ancestors, order, or history on no-op', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svgHelpers = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const { ancestorWorldMatrix, vectorObjectBounds } = svgHelpers as unknown as {
        ancestorWorldMatrix: (element: Element) => [number, number, number, number, number, number] | undefined
        vectorObjectBounds: (element: Element) => { x: number; y: number; width: number; height: number }
      }
      const { scaleVectorElementsByCommonBounds } = paper as unknown as {
        scaleVectorElementsByCommonBounds: (
          elements: Element[],
          handle: 'se' | 'e',
          dx: number,
          dy: number,
          modifiers?: Record<string, boolean>,
        ) => boolean
      }
      const failures: string[] = []
      const check = (name: string, condition: boolean) => { if (!condition) failures.push(name) }
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g id="outer" transform="translate(30 10)">' +
        '<rect id="a" x="10" y="20" width="40" height="20" fill="red"/>' +
        '<g id="inner" transform="translate(70 0)"><rect id="b" x="10" y="20" width="20" height="20" fill="blue"/></g>' +
        '</g>' +
        '<rect id="c" x="150" y="100" width="50" height="30" fill="green"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const elements = ['a', 'b', 'c'].map((id) => doc.getElementById(id)!) as Element[]
      const beforeBounds = elements.map((element) => vectorObjectBounds(element))
      // Union: x 40..200 (w 160), y 30..130 (h 100). Free-ratio +20/+10 on se.
      const applied = scaleVectorElementsByCommonBounds(elements, 'se', 20, 10, { shiftKey: true })
      check('applied', applied === true)
      const afterBounds = elements.map((element) => vectorObjectBounds(element))
      // Shared world: fixed pivot (40, 30), sx 1.125, sy 1.1 -> each corner maps.
      const corners: Array<[{ x: number; y: number }, { x: number; y: number }]> = beforeBounds.map((before) => [
        { x: before.x, y: before.y },
        { x: before.x + before.width, y: before.y + before.height },
      ])
      for (let i = 0; i < elements.length; i++) {
        const mapped = corners[i]!.map((point) => ({
          x: 40 + (point.x - 40) * 1.125,
          y: 30 + (point.y - 30) * 1.1,
        }))
        const expectedLeft = Math.min(mapped[0]!.x, mapped[1]!.x)
        const expectedTop = Math.min(mapped[0]!.y, mapped[1]!.y)
        const after = afterBounds[i]!
        check(`x-${i}`, Math.abs(after.x - expectedLeft) < 1)
        check(`y-${i}`, Math.abs(after.y - expectedTop) < 1)
        check(`w-${i}`, Math.abs(after.width - Math.abs(mapped[1]!.x - mapped[0]!.x)) < 1)
        check(`h-${i}`, Math.abs(after.height - Math.abs(mapped[1]!.y - mapped[0]!.y)) < 1)
      }
      check('outer-kept', (doc.getElementById('outer') as Element).getAttribute('transform') === 'translate(30 10)')
      check('inner-kept', (doc.getElementById('inner') as Element).getAttribute('transform') === 'translate(70 0)')
      const fills = ['a', 'b', 'c'].map((id) => (doc.getElementById(id) as Element).getAttribute('fill'))
      check('order-kept', JSON.stringify(fills) === JSON.stringify(['red', 'blue', 'green']))
      // Every scaled unit carries its own local matrix (stroke scales via CTM).
      for (const id of ['a', 'b', 'c']) {
        check(`matrix-${id}`, ((doc.getElementById(id) as Element).getAttribute('transform') ?? '').includes('matrix('))
      }
      // No-op leaves the DOM untouched (caller skips empty history).
      const noopDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const noopElements = ['a', 'b', 'c'].map((id) => noopDoc.getElementById(id)!) as Element[]
      const noopBefore = new XMLSerializer().serializeToString(noopDoc.documentElement)
      const noopApplied = scaleVectorElementsByCommonBounds(noopElements, 'se', 0, 0)
      const noopEdge = scaleVectorElementsByCommonBounds(noopElements, 'e', 0, 999)
      check('noop-false', noopApplied === false && noopEdge === false)
      check('noop-untouched', new XMLSerializer().serializeToString(noopDoc.documentElement) === noopBefore)
      // Flipped drag mirrors positions through the shared fixed point.
      const flipDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const flipElements = ['a', 'b', 'c'].map((id) => flipDoc.getElementById(id)!) as Element[]
      const flipApplied = scaleVectorElementsByCommonBounds(flipElements, 'se', -200, 0, { shiftKey: true })
      check('flip-applied', flipApplied === true)
      const flipAfter = flipElements.map((element) => vectorObjectBounds(element))
      check('flip-mirrored', flipAfter[2]!.x < beforeBounds[2]!.x)
      check('flip-ancestor', (flipDoc.getElementById('outer') as Element).getAttribute('transform') === 'translate(30 10)')
      void ancestorWorldMatrix
      return failures
    })
    expect(result).toEqual([])
  }, 30_000)
})
