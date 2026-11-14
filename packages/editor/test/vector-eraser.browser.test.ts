import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4197'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector eraser with real Paper.js and DOM', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4197', '--strictPort'], {
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

  it('cuts a hole in the middle of a filled rect while the surround remains', async () => {
    const result = await page.evaluate(async () => {
      const [{ ensureVectorPaperScope }, { eraseVectorStrokeFromSvg }, { editableSvgChildren }] =
        await Promise.all([
          import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-eraser.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts'),
        ])
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
          '<rect x="100" y="80" width="200" height="120" fill="red" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const children = editableSvgChildren(svg)
      const outcome = eraseVectorStrokeFromSvg(scope, svg, children, [{ x: 200, y: 140 }], 40, [])
      const outSvg = new XMLSerializer().serializeToString(svg)
      // Re-import the result into a clean project and hit-test real geometry.
      scope.project.clear()
      const check = scope.project.importSVG(outSvg) as unknown as {
        hitTest: (point: unknown) => unknown
      }
      const centerHit = Boolean(check.hitTest(new scope.Point(200, 140)))
      const edgeHit = Boolean(check.hitTest(new scope.Point(110, 90)))
      const childCount = svg.children.length
      check.remove()
      scope.project.clear()
      return { erased: outcome.erased, outSvg, centerHit, edgeHit, childCount }
    })
    expect(result.erased).toBe(true)
    // The brushed center becomes a hole, so it must miss...
    expect(result.centerHit).toBe(false)
    // ...while the untouched surround still hits.
    expect(result.edgeHit).toBe(true)
    expect(result.childCount).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('erases an editable child under transformed wrapper groups', async () => {
    const result = await page.evaluate(async () => {
      const [{ ensureVectorPaperScope }, { eraseVectorStrokeFromSvg }, { editableVectorUnits }] = await Promise.all([
        import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts'),
        import(/* @vite-ignore */ '/src/features/costumes/vector-eraser.ts'),
        import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts'),
      ])
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(100 50)"><g transform="scale(2)"><rect x="0" y="0" width="100" height="100" fill="red"/><rect x="150" y="0" width="20" height="20" fill="blue"/></g></g></svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const before = new XMLSerializer().serializeToString(editableVectorUnits(svg)[1]!)
      const outcome = eraseVectorStrokeFromSvg(scope, svg, editableVectorUnits(svg), [{ x: 200, y: 150 }], 40, [])
      const after = new XMLSerializer().serializeToString(editableVectorUnits(svg)[1]!)
      const output = new XMLSerializer().serializeToString(svg)
      scope.project.clear()
      const check = scope.project.importSVG(output)
      const center = !!check.hitTest(new scope.Point(200, 150), { fill: true })
      const edge = !!check.hitTest(new scope.Point(120, 70), { fill: true })
      check.remove()
      scope.project.clear()
      return { outcome, center, edge, before, after }
    })
    expect(result.outcome.erased).toBe(true)
    expect(result.center).toBe(false)
    expect(result.edge).toBe(true)
    expect(result.after).toBe(result.before)
  }, 30_000)

  it('leaves other items untouched when erasing one of several', async () => {
    const result = await page.evaluate(async () => {
      const [{ ensureVectorPaperScope }, { eraseVectorStrokeFromSvg }, { editableSvgChildren }] =
        await Promise.all([
          import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-eraser.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts'),
        ])
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
          '<rect x="20" y="20" width="80" height="80" fill="red" stroke="none"/>' +
          '<rect x="300" y="200" width="80" height="80" fill="blue" stroke="none"/>' +
          '</svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const children = editableSvgChildren(svg)
      const blueBefore = new XMLSerializer().serializeToString(children[1]!)
      const outcome = eraseVectorStrokeFromSvg(scope, svg, children, [{ x: 60, y: 60 }], 40, [])
      const outSvg = new XMLSerializer().serializeToString(svg)
      const afterChildren = Array.from(svg.children)
      const blueAfter =
        afterChildren.length === 2 ? new XMLSerializer().serializeToString(afterChildren[1]!) : ''
      // Geometry check on the merged output: erased center misses, far item hits.
      scope.project.clear()
      const check = scope.project.importSVG(outSvg) as unknown as {
        hitTest: (point: unknown) => unknown
      }
      const erasedCenterHit = Boolean(check.hitTest(new scope.Point(60, 60)))
      const erasedSurroundHit = Boolean(check.hitTest(new scope.Point(25, 25)))
      const protectedHit = Boolean(check.hitTest(new scope.Point(340, 240)))
      check.remove()
      scope.project.clear()
      return {
        erased: outcome.erased,
        outSvg,
        childCount: afterChildren.length,
        blueBefore,
        blueAfter,
        erasedCenterHit,
        erasedSurroundHit,
        protectedHit,
      }
    })
    expect(result.erased).toBe(true)
    // Both items must still exist: the carved ring plus the untouched rect.
    expect(result.childCount).toBe(2)
    // The untouched item keeps its exact DOM markup.
    expect(result.blueAfter).toBe(result.blueBefore)
    // ...and stays hittable, while the erased center is gone but its surround remains.
    expect(result.erasedCenterHit).toBe(false)
    expect(result.erasedSurroundHit).toBe(true)
    expect(result.protectedHit).toBe(true)
  }, 30_000)
})
