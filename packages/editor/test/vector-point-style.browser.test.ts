import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
// 既存ブラウザーテスト群と重ならないポートを使う (4231/4241 系は使用中)。
const base = 'http://127.0.0.1:4295'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector point style DOM wrappers with transforms', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4295', '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('curves a rect corner under a translated parent without moving anchors', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-point-style.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<rect id="box" x="10" y="10" width="80" height="60" fill="yellow" stroke="black"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const box = doc.querySelector('#box')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const beforeExport = new XMLSerializer().serializeToString(doc.documentElement)
      // rect は Shape として取り込まれるため flattened anchor は 0-3。
      const curve = await mod.curveVectorPointStyle(box, [0])
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const outer = doc.querySelector('#outer')!
      return {
        curve,
        beforeAnchors: ((before[0] as any).points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterAnchors: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterControls: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'control'),
        outerTransform: outer.getAttribute('transform'),
        outerChildCount: outer.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
        beforeExport,
      }
    })
    expect(result.curve.changed).toBe(true)
    // アンカーは 4 点のまま、文書座標 ((60,50),(140,50),(140,110),(60,110)) に留まる。
    expect(result.afterAnchors.length).toBe(4)
    for (const anchor of result.beforeAnchors as Array<{ x: number; y: number }>) {
      expect(
        (result.afterAnchors as Array<{ x: number; y: number }>).some(
          (p) => Math.abs(p.x - anchor.x) < 1.5 && Math.abs(p.y - anchor.y) < 1.5,
        ),
      ).toBe(true)
    }
    // 対象角にハンドルが付く。ラッパー transform と子要素数は不変。
    expect((result.afterControls as Array<unknown>).length).toBeGreaterThan(0)
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.outerChildCount).toBe(1)
  }, 30_000)

  it('points a smooth anchor under a scaled group and keeps document geometry', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-point-style.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="target" transform="scale(2)">' +
        '<path id="curve" d="M0 0 C30 -40 70 -40 100 0 C130 40 170 40 200 0" fill="none" stroke="black"/>' +
        '<path id="other" d="M0 100 L100 100 L100 130" fill="none" stroke="red"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const target = doc.querySelector('#target')!
      const before = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      // flattened: 中間 anchor は index 2 (0 anchor, 1 out, 2 anchor)。
      const point = await mod.pointVectorPointStyle(target, [2])
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const targetAfter = doc.querySelector('#target')!
      return {
        point,
        beforeAnchors: ((before[0] as any).points as Array<any>).filter((p) => p.kind === 'anchor'),
        beforeControls: ((before[0] as any).points as Array<any>).filter((p) => p.kind === 'control'),
        afterAnchors: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'anchor'),
        afterControls: ((after[0] as any)?.points as Array<any>).filter((p) => p.kind === 'control'),
        targetTransform: targetAfter?.getAttribute('transform'),
        childCount: targetAfter?.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.point.changed).toBe(true)
    // 中間アンカーの文書座標 (200,0) は保たれ、制御点は対象分だけ減る。
    const at = (x: number, y: number) =>
      (result.afterAnchors as Array<{ x: number; y: number }>).some((p) => Math.abs(p.x - x) < 1.5 && Math.abs(p.y - y) < 1.5)
    expect(at(0, 0)).toBe(true)
    expect(at(200, 0)).toBe(true)
    expect(at(400, 0)).toBe(true)
    expect((result.afterControls as Array<unknown>).length).toBeLessThan(
      (result.beforeControls as Array<unknown>).length,
    )
    expect(result.targetTransform ?? '').toContain('scale(2)')
    expect(result.childCount).toBe(2)
  }, 30_000)

  it('leaves the DOM untouched when already in the requested style', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-point-style.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="line" d="M0 0 L60 0 L60 50" fill="none" stroke="black"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const line = doc.querySelector('#line')!
      const before = new XMLSerializer().serializeToString(doc.documentElement)
      // 直線アンカーへの直線化は no-op。
      const point = await mod.pointVectorPointStyle(line, [1])
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      return { point, unchanged: before === after }
    })
    expect(result.point.changed).toBe(false)
    expect(result.point.reason).toBe('already-styled')
    expect(result.unchanged).toBe(true)
  }, 30_000)
})
