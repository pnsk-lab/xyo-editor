/**
 * Import-path sanitizer boundary: `vector-path-points.ts` / `vector-eraser.ts`
 * must not feed raw live Elements to Paper.js `importSVG`, and malformed
 * `data-paper-data` must not abort the import via Paper's `JSON.parse`.
 *
 * Safety: every payload can only assign a plain string to
 * `window.__xyoImportSanitizeProbe`. No network, navigation, or exfiltration.
 *
 * Covers:
 * - `data-paper-data`: invalid JSON stripped; valid safe JSON retained;
 *   prototype-pollution keys (`__proto__`/`constructor`/`prototype`, nested
 *   included) stripped; other `data-*` attributes untouched.
 * - Attack marker through the point add/delete path stays silent and the
 *   surviving geometry is preserved (nested transforms intact).
 * - Attack marker through the eraser path stays silent and the cut still lands.
 * - Legitimate nested-transform path add/delete + eraser keep coordinates and
 *   wrapper transforms, and snapshot-restore (Undo model) brings geometry back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const MARK = '__xyoImportSanitizeProbe'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4263'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function firesViaInnerHTML(payload: string, waitMs = 400): Promise<unknown> {
  return page.evaluate(
    async ({ svg, mark, wait }: { svg: string; mark: string; wait: number }) => {
      const w = window as unknown as Record<string, unknown>
      w[mark] = null
      const host = document.createElement('div')
      document.body.appendChild(host)
      host.innerHTML = svg
      await new Promise((resolve) => setTimeout(resolve, wait))
      const fired = w[mark]
      host.remove()
      w[mark] = null
      return fired
    },
    { svg: payload, mark: MARK, wait: waitMs },
  )
}

describe('vector import sanitizer boundary (path-points + eraser + paper-data)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4263', '--strictPort'], {
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

  it('data-paper-data is fully removed (invalid, valid and pollution payloads)', async () => {
    const result = await page.evaluate(async () => {
      const { sanitizeSvgForDisplay, sanitizeSvgFragmentForPaperImport, cleanSvgElementAttributes } = await import(
        /* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts'
      )
      const docOf = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')
      const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
      const cases: Array<[string, string]> = [
        ['invalid', wrap(`<rect width="10" height="10" data-paper-data="{not-json"/>`)],
        ['truncated', wrap(`<rect width="10" height="10" data-paper-data='{"a":1'/>`)],
        ['proto-top', wrap(`<rect width="10" height="10" data-paper-data='{"__proto__":{"polluted":1}}'/>`)],
        ['proto-nested', wrap(`<rect width="10" height="10" data-paper-data='{"a":{"constructor":{"prototype":{"x":1}}}}'/>`)],
        ['valid-object', wrap(`<rect width="10" height="10" data-paper-data='{"scratch":"kept","n":3}'/>`)],
        ['valid-array', wrap(`<rect width="10" height="10" data-paper-data='[1,2,3]'/>`)],
      ]
      const rows = cases.map(([name, raw]) => {
        const cleanDoc = sanitizeSvgForDisplay(raw) as string
        // Fragment path: serialize the bare element (the form the point/eraser
        // import paths feed in) and run it through the fragment wrapper.
        const bare = docOf(raw).documentElement.firstElementChild?.outerHTML ?? ''
        const cleanFrag = sanitizeSvgFragmentForPaperImport(bare) as string
        const rect = docOf(cleanDoc).documentElement.firstElementChild
        const fragRect = docOf(cleanFrag).documentElement.firstElementChild
        return {
          name,
          paperData: rect?.getAttribute('data-paper-data'),
          fragPaperData: fragRect?.getAttribute('data-paper-data'),
          fragTag: fragRect?.tagName.toLowerCase() ?? null,
        }
      })
      // Single-element cleaner (the post-edit write-back path) drops the
      // attribute from a live leaf while leaving other data-* attributes alone.
      const live = docOf(wrap(`<rect width="10" height="10" data-paper-data='{"a":1}' data-foo="keep-me"/>`))
      const liveRect = live.documentElement.firstElementChild!
      cleanSvgElementAttributes(liveRect as unknown as Element)
      return {
        rows,
        livePaperData: liveRect.getAttribute('data-paper-data'),
        liveOtherData: liveRect.getAttribute('data-foo'),
      }
    })
    const byName = Object.fromEntries(result.rows.map((entry) => [entry.name, entry]))
    for (const name of ['invalid', 'truncated', 'proto-top', 'proto-nested', 'valid-object', 'valid-array']) {
      // Full removal: no variant may reach Paper's JSON.parse. Retention is
      // unnecessary (the editor never reads item._data; the VM boundary drops
      // it too), so fail-closed removal covers both the crash and any
      // prototype-pollution payload.
      expect(byName[name]?.paperData).toBeNull()
      expect(byName[name]?.fragPaperData).toBeNull()
    }
    // Geometry itself survives the fragment wrapper (no dropped shapes).
    expect(byName['valid-object']?.fragTag).toBe('rect')
    expect(result.livePaperData).toBeNull()
    expect(result.liveOtherData).toBe('keep-me')
  }, 30_000)

  it('sanitized invalid data-paper-data imports without throwing (raw would abort)', async () => {
    const result = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const { sanitizeSvgForPaperImport } = await import(
        /* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts'
      )
      const { ensureVectorPaperScope } = await import(
        /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
      )
      const raw =
        `<svg xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="20" height="20" fill="red" ` +
        `data-paper-data="{broken-json" onerror="window.${mark}='paper-data-raw'"/></svg>`
      const scope = await ensureVectorPaperScope()
      // Containment for the raw control below: Paper's importer mutates its
      // global settings before `JSON.parse` throws and never restores them, and
      // it can leak its temporary container into document.body. Snapshot both
      // so this control cannot poison later tests in the same page.
      const settings = scope.settings as unknown as { insertItems: boolean; applyMatrix: boolean }
      const savedInsertItems = settings.insertItems
      const savedApplyMatrix = settings.applyMatrix
      const bodyBefore = Array.from(document.body.children)
      scope.project.clear()
      let rawThrew = false
      try {
        const item = scope.project.importSVG(raw) as unknown as { remove: () => void } | null
        item?.remove()
      } catch {
        rawThrew = true
      } finally {
        settings.insertItems = savedInsertItems
        settings.applyMatrix = savedApplyMatrix
        for (const child of Array.from(document.body.children)) {
          if (!bodyBefore.includes(child)) child.remove()
        }
        scope.project.clear()
      }
      w[mark] = null
      const clean = sanitizeSvgForPaperImport(raw) as string
      let cleanThrew = false
      let bounds: string | null = null
      try {
        const item = scope.project.importSVG(clean) as unknown as {
          bounds: { x: number; y: number; width: number; height: number }
          remove: () => void
        } | null
        if (item) {
          bounds = `${item.bounds.x},${item.bounds.y},${item.bounds.width},${item.bounds.height}`
          item.remove()
        }
      } catch {
        cleanThrew = true
      }
      scope.project.clear()
      const atImport = w[mark]
      w[mark] = null
      return { rawThrew, cleanThrew, bounds, clean, atImport }
    }, { mark: MARK })
    // Paper's raw `JSON.parse` path aborts the import on malformed values.
    expect(result.rawThrew).toBe(true)
    // Through the sanitizer the same markup imports cleanly and stays silent.
    expect(result.cleanThrew).toBe(false)
    expect(result.atImport).toBeNull()
    expect(result.bounds).not.toBeNull()
    expect(result.clean.toLowerCase()).not.toContain('onerror')
    expect(result.clean.toLowerCase()).not.toContain('data-paper-data')
    expect(await firesViaInnerHTML(result.clean)).toBeNull()
  }, 30_000)

  it('attack marker through addVectorPathPoint stays silent and geometry survives', async () => {
    const result = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      w[mark] = null
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        `<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black" stroke-width="2" onerror="window.${mark}='pp-onerror'" data-paper-data="{bad-json"/>` +
        `<image href="invalid-probe" onerror="window.${mark}='pp-image'"/>` +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const curve = doc.querySelector('#curve')!
      // Local midpoint of the first cubic is near (25, 30); document frame adds (50, 40).
      const add = await mod.addVectorPathPoint(curve, 75, 70)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const exported = new XMLSerializer().serializeToString(doc.documentElement)
      const outer = doc.querySelector('#outer')!
      const editedCurve = doc.querySelector('#curve')!
      // The edited leaf alone, re-serialized as a document, for the firing check.
      const leafDoc =
        `<svg xmlns="http://www.w3.org/2000/svg">${editedCurve.outerHTML}</svg>`
      return {
        add,
        anchors: ((after[0] as unknown as { points: Array<{ x: number; y: number; kind: string }> }).points ?? []).filter(
          (p) => p.kind === 'anchor',
        ),
        outerTransform: outer.getAttribute('transform'),
        editedLeafOnerror: editedCurve.getAttribute('onerror'),
        editedLeafPaperData: editedCurve.getAttribute('data-paper-data'),
        leafDoc,
        exported,
        atEdit: w[mark],
      }
    }, { mark: MARK })
    expect(result.atEdit).toBeNull()
    expect(result.add.added).toBe(true)
    // New anchor lands at the clicked document position despite the attack attributes.
    expect(result.anchors.some((p) => Math.abs(p.x - 75) < 1.5 && Math.abs(p.y - 70) < 1.5)).toBe(true)
    expect(result.outerTransform).toBe('translate(50 40)')
    // The edited leaf is cleaned by the write-back path (geometry kept, attack
    // attributes gone). The untouched `<image>` sibling keeps its stored
    // attributes: neutralizing pre-existing stored state in nodes we did not
    // write is the ingress/render sanitizers' job (reported as residual).
    expect(result.editedLeafOnerror).toBeNull()
    expect(result.editedLeafPaperData).toBeNull()
    expect(result.exported).not.toContain('{bad-json')
    expect(await firesViaInnerHTML(result.leafDoc)).toBeNull()
  }, 30_000)

  it('attack marker through deleteVectorPathPoint stays silent and survivors keep position', async () => {
    const result = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      w[mark] = null
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        `<path id="quad" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green" stroke="black" onload="window.${mark}='pp-del'" data-paper-data="carved-not-json{{"/>` +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const quad = doc.querySelector('#quad')!
      const del = await mod.deleteVectorPathPoint(quad, 1)
      const after = await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc))
      const exported = new XMLSerializer().serializeToString(doc.documentElement)
      return {
        del,
        anchors: (
          (after[0] as unknown as { points: Array<{ x: number; y: number; kind: string }> }).points ?? []
        ).filter((p) => p.kind === 'anchor'),
        outerTransform: doc.querySelector('#outer')!.getAttribute('transform'),
        exported,
        atEdit: w[mark],
      }
    }, { mark: MARK })
    expect(result.atEdit).toBeNull()
    expect(result.del.deleted).toBe(true)
    expect(result.anchors.length).toBe(3)
    const at = (x: number, y: number) =>
      result.anchors.some((p) => Math.abs(p.x - x) < 1.5 && Math.abs(p.y - y) < 1.5)
    expect(at(50, 40)).toBe(true)
    expect(at(110, 90)).toBe(true)
    expect(at(50, 90)).toBe(true)
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.exported.toLowerCase()).not.toContain('onload')
    expect(await firesViaInnerHTML(result.exported)).toBeNull()
  }, 30_000)

  it('attack marker through the eraser stays silent and the cut still lands', async () => {
    const result = await page.evaluate(async ({ mark }: { mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      const [{ ensureVectorPaperScope }, { eraseVectorStrokeFromSvg }, { editableSvgChildren }] =
        await Promise.all([
          import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-eraser.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts'),
        ])
      w[mark] = null
      const scope = await ensureVectorPaperScope()
      scope.project.clear()
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
          `<rect x="100" y="80" width="200" height="120" fill="red" stroke="none" onerror="window.${mark}='er-onerror'" data-paper-data="[[[not-json"/>` +
          '</svg>',
        'image/svg+xml',
      )
      const svg = doc.documentElement
      const children = editableSvgChildren(svg)
      const outcome = eraseVectorStrokeFromSvg(scope, svg, children, [{ x: 200, y: 140 }], 40, [])
      const outSvg = new XMLSerializer().serializeToString(svg)
      scope.project.clear()
      const check = scope.project.importSVG(outSvg) as unknown as {
        hitTest: (point: unknown) => unknown
        remove: () => void
      }
      const centerHit = Boolean(check.hitTest(new scope.Point(200, 140)))
      const edgeHit = Boolean(check.hitTest(new scope.Point(110, 90)))
      check.remove()
      scope.project.clear()
      return { outcome, outSvg, centerHit, edgeHit, atEdit: w[mark] }
    }, { mark: MARK })
    expect(result.atEdit).toBeNull()
    expect(result.outcome.erased).toBe(true)
    expect(result.centerHit).toBe(false)
    expect(result.edgeHit).toBe(true)
    expect(result.outSvg.toLowerCase()).not.toContain('onerror')
    expect(result.outSvg).not.toContain('not-json')
    expect(await firesViaInnerHTML(result.outSvg)).toBeNull()
  }, 30_000)

  it('legit nested-transform point add/delete round-trips with Undo snapshot restore', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const anchorsOf = async (text: string) => {
        const list = (await paperMod.paperVectorObjectList(text)) as Array<{
          points: Array<{ x: number; y: number; kind: string }>
        }>
        return (list[0]?.points ?? []).filter((p) => p.kind === 'anchor')
      }
      // Add path: open curve under a translated wrapper; local midpoint of the
      // first cubic is near (25, 30), i.e. document (75, 70).
      const curveSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black" stroke-width="2"/>' +
        '</g></svg>'
      const docA = new DOMParser().parseFromString(curveSvg, 'image/svg+xml')
      const add = await mod.addVectorPathPoint(docA.querySelector('#curve')!, 75, 70)
      const addedText = new XMLSerializer().serializeToString(docA)
      const addedAnchors = await anchorsOf(addedText)
      const undoneAddAnchors = await anchorsOf(curveSvg)

      // Delete path: closed quad under the same wrapper; index 1 is local
      // (60, 0).
      const quadSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="quad" d="M0 0 L60 0 L60 50 L0 50 Z" fill="green" stroke="black"/>' +
        '</g></svg>'
      const docD = new DOMParser().parseFromString(quadSvg, 'image/svg+xml')
      const del = await mod.deleteVectorPathPoint(docD.querySelector('#quad')!, 1)
      const deletedText = new XMLSerializer().serializeToString(docD)
      const deletedAnchors = await anchorsOf(deletedText)
      const undoneDelAnchors = await anchorsOf(quadSvg)
      return {
        add,
        del,
        addedCount: addedAnchors.length,
        undoneAddCount: undoneAddAnchors.length,
        deletedCount: deletedAnchors.length,
        undoneDelCount: undoneDelAnchors.length,
        outerAfterAdd: docA.querySelector('#outer')!.getAttribute('transform'),
        outerAfterDel: docD.querySelector('#outer')!.getAttribute('transform'),
      }
    })
    expect(result.add.added).toBe(true)
    expect(result.addedCount).toBe(4)
    expect(result.undoneAddCount).toBe(3)
    expect(result.del.deleted).toBe(true)
    expect(result.deletedCount).toBe(3)
    expect(result.undoneDelCount).toBe(4)
    expect(result.outerAfterAdd).toBe('translate(50 40)')
    expect(result.outerAfterDel).toBe('translate(50 40)')
  }, 30_000)

  it('legit nested-transform eraser cut round-trips with Undo snapshot restore', async () => {
    const result = await page.evaluate(async () => {
      const [{ ensureVectorPaperScope }, { eraseVectorStrokeFromSvg }, { editableVectorUnits }] =
        await Promise.all([
          import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-eraser.ts'),
          import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts'),
        ])
      const scope = await ensureVectorPaperScope()
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(100 50)"><g transform="scale(2)">' +
        '<rect x="0" y="0" width="100" height="100" fill="red"/>' +
        '<rect x="150" y="0" width="20" height="20" fill="blue"/>' +
        '</g></g></svg>'
      const hits = async (text: string) => {
        scope.project.clear()
        const check = scope.project.importSVG(text)
        const center = !!check.hitTest(new scope.Point(200, 150), { fill: true })
        const edge = !!check.hitTest(new scope.Point(120, 70), { fill: true })
        check.remove()
        scope.project.clear()
        return { center, edge }
      }
      const before = await hits(svgText)
      // Undo model: snapshot text, erase, then restore the snapshot.
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      const svg = doc.documentElement
      const outcome = eraseVectorStrokeFromSvg(scope, svg, editableVectorUnits(svg), [{ x: 200, y: 150 }], 40, [])
      const erasedText = new XMLSerializer().serializeToString(svg)
      const during = await hits(erasedText)
      const undone = await hits(svgText)
      const siblingAfter = new XMLSerializer().serializeToString(editableVectorUnits(svg)[1]!)
      const siblingBefore = new XMLSerializer().serializeToString(
        editableVectorUnits(new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement)[1]!,
      )
      return { before, outcome, during, undone, siblingAfter, siblingBefore }
    })
    // Sanity: the target area starts solid.
    expect(result.before.center).toBe(true)
    expect(result.outcome.erased).toBe(true)
    // The brushed center becomes a hole while the surround stays.
    expect(result.during.center).toBe(false)
    expect(result.during.edge).toBe(true)
    // Undo restores the solid target; the untouched sibling never changed.
    expect(result.undone.center).toBe(true)
    expect(result.siblingAfter).toBe(result.siblingBefore)
  }, 30_000)
})
