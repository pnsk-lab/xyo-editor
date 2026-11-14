import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4189'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector reshape geometry', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4189', '--strictPort'], { cwd: root, stdio: 'pipe' })
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

  it('keeps the outline width when resizing a vector ellipse', async () => {
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy } = await import(/* @vite-ignore */ moduleUrl)
      const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><ellipse cx="30" cy="30" rx="20" ry="10" fill="red" stroke="black" stroke-width="4"/></svg>', 'image/svg+xml')
      await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'se', 40, 10)
      return new XMLSerializer().serializeToString(doc.documentElement)
    })
    expect(result).toContain('stroke-width="4"')
    expect(result).not.toMatch(/transform="(?:matrix|scale)\(/)
  }, 30_000)

  it('moves anchors with their handles and mirrors or splits control handles', async () => {
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { paperVectorObjectList, moveVectorEditablePoint } = await import(/* @vite-ignore */ moduleUrl)
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 10 30 C 20 30 30 30 40 30 C 50 30 60 30 70 30" fill="none" stroke="black"/></svg>'
      async function move(kind: 'anchor' | 'control', split = false) {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
        const before = (await paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0].points!
        const anchor = before.find((p: any) => p.kind === 'anchor' && Math.abs(p.x - 40) < 0.01)!
        const target = kind === 'anchor' ? anchor : before.find((p: any) => p.kind === 'control' && p.relatedAnchorIndex === anchor.index && p.controlRole === 'out')!
        await moveVectorEditablePoint(doc.documentElement.firstElementChild!, target.index, kind === 'anchor' ? 45 : 40, kind === 'anchor' ? 35 : 40, split)
        return (await paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0].points!
      }
      return { anchor: await move('anchor'), mirrored: await move('control'), split: await move('control', true) }
    })
    const point = (points: any[], kind: string, x: number, y: number, role?: string) =>
      points.some((p) => p.kind === kind && (!role || p.controlRole === role) && Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01)
    expect(point(result.anchor, 'anchor', 45, 35)).toBe(true)
    expect(point(result.anchor, 'control', 35, 35, 'in')).toBe(true)
    expect(point(result.anchor, 'control', 55, 35, 'out')).toBe(true)
    expect(point(result.mirrored, 'control', 40, 40, 'out')).toBe(true)
    expect(point(result.mirrored, 'control', 40, 20, 'in')).toBe(true)
    expect(point(result.split, 'control', 40, 40, 'out')).toBe(true)
    expect(point(result.split, 'control', 30, 30, 'in')).toBe(true)
  }, 30_000)

  it('hit-tests vector shapes instead of bounding boxes', async () => {
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { paperVectorHitIndex } = await import(/* @vite-ignore */ moduleUrl)
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="300" y="200" width="100" height="80" fill="red"/><line x1="10" y1="10" x2="110" y2="110" stroke="black" stroke-width="2"/></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const elements = Array.from(doc.documentElement.children)
      return {
        onLine: await paperVectorHitIndex(elements, { x: 60, y: 60 }),
        bboxCorner: await paperVectorHitIndex(elements, { x: 10, y: 110 }),
        empty: await paperVectorHitIndex(elements, { x: 400, y: 300 }),
      }
    })
    // (10, 110) sits inside the line's bounding box but far from the stroke,
    // so scratch-paint's select tool reports a miss there.
    expect(result.onLine).toBe(1)
    expect(result.bboxCorner).toBe(-1)
    expect(result.empty).toBe(-1)
  }, 30_000)

  it('matches marquee selection to drawn shapes instead of bounding boxes', async () => {
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { paperVectorIndicesInRect } = await import(/* @vite-ignore */ moduleUrl)
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="300" y="200" width="100" height="80" fill="red"/><rect x="10" y="10" width="20" height="20" fill="blue"/></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const elements = Array.from(doc.documentElement.children)
      return {
        aroundBlue: await paperVectorIndicesInRect(elements, { x: 0, y: 0, width: 40, height: 40 }),
        insideRed: await paperVectorIndicesInRect(elements, { x: 320, y: 220, width: 20, height: 20 }),
      }
    })
    // A marquee fully inside a filled shape without touching its outline or
    // points selects nothing in scratch-paint.
    expect(result.aroundBlue).toEqual([1])
    expect(result.insideRed).toEqual([])
  }, 30_000)

  it('selects nested group parts like scratch-paint instead of the whole wrapper', async () => {
    const result = await page.evaluate(async () => {
      const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const { paperVectorHitIndex } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g><title>costume</title><g id="page"><g id="cat"><g id="head"><path d="M300 200h100v80H300Z" fill="red"/><circle cx="330" cy="230" r="10" fill="white"/></g><path id="body" d="M300 300h100v50H300Z" fill="orange"/></g></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = editableVectorUnits(doc.documentElement)
      return {
        unitIds: units.map((element) => element.getAttribute('id')),
        faceHit: await paperVectorHitIndex(units, { x: 330, y: 230 }),
        bodyHit: await paperVectorHitIndex(units, { x: 350, y: 320 }),
        emptyHit: await paperVectorHitIndex(units, { x: 200, y: 200 }),
      }
    })
    // Clicking the face selects the head part, matching scratch-paint's
    // import normalization (single-child wrappers are transparent).
    expect(result.unitIds).toEqual(['head', 'body'])
    expect(result.faceHit).toBe(0)
    expect(result.bodyHit).toBe(1)
    expect(result.emptyHit).toBe(-1)
  }, 30_000)

  it('hit-tests translated nested units in document coordinates', async () => {
    const result = await page.evaluate(async () => {
      const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      // The whole artwork sits in a translated wrapper, like costumes that
      // the editor centers with a translate on the top-level group.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g transform="translate(192 130)"><g id="page"><g id="cat"><g id="head"><path d="M14 0h81v62H14Z" fill="red"/></g><path id="body" d="M20 60h60v40H20Z" fill="orange"/></g></g></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = editableVectorUnits(doc.documentElement)
      const list = await paper.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      return {
        unitIds: units.map((element) => element.getAttribute('id')),
        faceHit: await paper.paperVectorHitIndex(units, { x: 192 + 50, y: 130 + 25 }),
        bodyHit: await paper.paperVectorHitIndex(units, { x: 192 + 50, y: 130 + 80 }),
        marqueeHead: await paper.paperVectorIndicesInRect(units, { x: 200, y: 135, width: 100, height: 50 }),
        marqueeBoth: await paper.paperVectorIndicesInRect(units, { x: 200, y: 135, width: 100, height: 70 }),
        headBounds: { x: list[0]!.boundsX, y: list[0]!.boundsY, width: list[0]!.boundsWidth, height: list[0]!.boundsHeight },
      }
    })
    // Click/marquee coordinates arrive in document coordinates, while nested
    // units live in their local coordinates: the translated head must still hit.
    expect(result.unitIds).toEqual(['head', 'body'])
    expect(result.faceHit).toBe(0)
    expect(result.bodyHit).toBe(1)
    expect(result.marqueeHead).toEqual([0])
    expect(result.marqueeBoth).toEqual([0, 1])
    expect(result.headBounds.x).toBeCloseTo(206, 0)
    expect(result.headBounds.y).toBeCloseTo(130, 0)
    expect(result.headBounds.width).toBeCloseTo(81, 0)
    expect(result.headBounds.height).toBeCloseTo(62, 0)
  }, 30_000)

  it('hit-tests fills inherited from wrapper groups', async () => {
    const result = await page.evaluate(async () => {
      const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const { paperVectorHitIndex } = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><g transform="translate(10 10)" fill="green"><path id="p" d="M0 0h20v20H0Z"/></g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = editableVectorUnits(doc.documentElement)
      return {
        fillHit: await paperVectorHitIndex(units, { x: 20, y: 20 }),
        emptyHit: await paperVectorHitIndex(units, { x: 100, y: 100 }),
      }
    })
    // The path has no fill of its own: the wrapper's fill still paints (and
    // hit-tests) its interior in scratch-paint.
    expect(result.fillHit).toBe(0)
    expect(result.emptyHit).toBe(-1)
  }, 30_000)
})
