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

const RECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50" fill="red"/></svg>'

describe('vector resize scale modifiers (paper-vector integration)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4191', '--strictPort'], { cwd: root, stdio: 'pipe' })
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

  it('keeps aspect on corner handles by default', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const applied = await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'se', 20, 5)
      const next = new XMLSerializer().serializeToString(doc.documentElement)
      const bounds = (await paperVectorObjectList(next))[0]
      return { applied, bounds, next }
    }, RECT_SVG)
    expect(result.applied).toBe(true)
    expect(result.bounds.boundsWidth).toBeCloseTo(120, 0)
    expect(result.bounds.boundsHeight).toBeCloseTo(60, 0)
    expect(result.bounds.boundsX).toBeCloseTo(10, 0)
    expect(result.bounds.boundsY).toBeCloseTo(20, 0)
    expect(result.next).not.toMatch(/transform=/)
  }, 30_000)

  it('allows free ratio on corner handles with Shift', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const applied = await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'se', 20, 5, { shiftKey: true })
      const bounds = (await paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement)))[0]
      return { applied, bounds }
    }, RECT_SVG)
    expect(result.applied).toBe(true)
    expect(result.bounds.boundsWidth).toBeCloseTo(120, 0)
    expect(result.bounds.boundsHeight).toBeCloseTo(55, 0)
  }, 30_000)

  it('keeps edge handles single-axis and Shift-independent', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      async function run(modifiers: Record<string, boolean>) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
        const applied = await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'e', 20, 999, modifiers)
        const bounds = (await paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement)))[0]
        return { applied, bounds }
      }
      return { plain: await run({}), shifted: await run({ shiftKey: true }) }
    }, RECT_SVG)
    expect(result.plain.applied).toBe(true)
    expect(result.plain.bounds.boundsWidth).toBeCloseTo(120, 0)
    expect(result.plain.bounds.boundsHeight).toBeCloseTo(50, 0)
    expect(result.shifted.bounds.boundsWidth).toBeCloseTo(120, 0)
    expect(result.shifted.bounds.boundsHeight).toBeCloseTo(50, 0)
  }, 30_000)

  it('scales from the center with Alt', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const applied = await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'e', 10, 0, { altKey: true })
      const bounds = (await paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement)))[0]
      return { applied, bounds }
    }, RECT_SVG)
    expect(result.applied).toBe(true)
    // 片側 +10 が両側 +20 相当になる
    expect(result.bounds.boundsWidth).toBeCloseTo(120, 0)
    expect(result.bounds.boundsX).toBeCloseTo(0, 0)
    expect(result.bounds.boundsY).toBeCloseTo(20, 0)
  }, 30_000)

  it('supports Alt together with aspect rules', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      async function run(modifiers: Record<string, boolean>) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
        await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'se', 20, 5, modifiers)
        return (await paperVectorObjectList(new XMLSerializer().serializeToString(doc.documentElement)))[0]
      }
      return { uniform: await run({ altKey: true }), free: await run({ altKey: true, shiftKey: true }) }
    }, RECT_SVG)
    expect(result.uniform.boundsWidth).toBeCloseTo(140, 0)
    expect(result.uniform.boundsHeight).toBeCloseTo(70, 0)
    expect(result.uniform.boundsX).toBeCloseTo(-10, 0)
    expect(result.uniform.boundsY).toBeCloseTo(10, 0)
    expect(result.free.boundsWidth).toBeCloseTo(140, 0)
    expect(result.free.boundsHeight).toBeCloseTo(60, 0)
  }, 30_000)

  it('flips when dragged past the fixed point', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy, paperVectorObjectList } = await import(/* @vite-ignore */ moduleUrl)
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const applied = await resizeVectorElementBy(doc.documentElement.firstElementChild!, 'se', -120, 0, { shiftKey: true })
      const next = new XMLSerializer().serializeToString(doc.documentElement)
      const bounds = (await paperVectorObjectList(next))[0]
      return { applied, bounds }
    }, RECT_SVG)
    expect(result.applied).toBe(true)
    expect(result.bounds.boundsWidth).toBeCloseTo(20, 0)
    expect(result.bounds.boundsX).toBeLessThan(10)
    expect(result.bounds.boundsHeight).toBeCloseTo(50, 0)
  }, 30_000)

  it('reports no-op without touching the DOM', async () => {
    const result = await page.evaluate(async (svgText: string) => {
      const moduleUrl = '/src/features/costumes/paper-vector.ts'
      const { resizeVectorElementBy } = await import(/* @vite-ignore */ moduleUrl)
      const zeroDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const zeroBefore = new XMLSerializer().serializeToString(zeroDoc.documentElement)
      const zeroApplied = await resizeVectorElementBy(zeroDoc.documentElement.firstElementChild!, 'se', 0, 0)
      const zeroAfter = new XMLSerializer().serializeToString(zeroDoc.documentElement)
      const edgeDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const edgeBefore = new XMLSerializer().serializeToString(edgeDoc.documentElement)
      const edgeApplied = await resizeVectorElementBy(edgeDoc.documentElement.firstElementChild!, 'e', 0, 999)
      const edgeAfter = new XMLSerializer().serializeToString(edgeDoc.documentElement)
      return { zeroApplied, zeroSame: zeroBefore === zeroAfter, edgeApplied, edgeSame: edgeBefore === edgeAfter }
    }, RECT_SVG)
    // 呼び出し側は false を見て履歴を積まない (空 Undo を作らない契約)。
    expect(result.zeroApplied).toBe(false)
    expect(result.zeroSame).toBe(true)
    expect(result.edgeApplied).toBe(false)
    expect(result.edgeSame).toBe(true)
  }, 30_000)
})
