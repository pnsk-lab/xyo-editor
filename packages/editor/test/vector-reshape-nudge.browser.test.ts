// Reshape-anchor nudge DOM wrapper tests (real Paper.js + real SVG DOM).
//
// Exercises `moveVectorReshapePoints` — the existing bulk anchor-translation
// helper the keyboard-nudge integration reuses — with no mocks: geometry is
// compared through the `paperVectorObjectList` oracle before/after, and DOM
// purity is compared byte-for-byte on untouched leaves. This pins the exact
// translation contract (multi selected anchors move by a document delta,
// handles ride rigidly, everything else is untouched) that ArrowRight must
// produce once wired, without depending on Editor wiring.
//
// Reference behavior restated in our own words (clean-room, no AGPL copy):
// reshape keydown moves selected anchors by one zoom unit (no Shift
// multiplier, no bounds clamp, no clone, selection untouched) and keyup
// commits one history entry. History coalescing itself lives in Editor and is
// covered by the integration strategy, not here: this helper performs exactly
// one synchronous DOM write per call and owns no history.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
// Neighbor suites use 4293/4294/4295/4297/4299; 4296 is free.
const base = 'http://127.0.0.1:4296'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

type ProbePoint = { index: number; x: number; y: number; kind: string }

async function listPoints(svgText: string): Promise<ProbePoint[][]> {
  return await page.evaluate(async (svg: string) => {
    const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const list = await paperMod.paperVectorObjectList(svg)
    return (list as Array<{ points?: ProbePoint[] }>).map((unit) => unit.points ?? [])
  }, svgText)
}

describe('reshape-anchor nudge wrapper (moveVectorReshapePoints)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4296', '--strictPort'], { cwd: root, stdio: 'pipe' })
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

  it('nudges one selected anchor by an ArrowRight-scale document delta with handle purity', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const nudgeMod = await import(/* @vite-ignore */ '/src/features/costumes/nudge-parity.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '<rect id="sibling" x="300" y="200" width="40" height="30" fill="blue"/>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const curve = doc.querySelector('#curve')!
      const siblingBefore = doc.querySelector('#sibling')!.getAttribute('d') ?? doc.querySelector('#sibling')!.outerHTML
      const before = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0]!.points as ProbePoint[]
      const anchor = before.find((p) => p.kind === 'anchor')!
      // One plain ArrowRight at viewport scale 1: exactly 1 screen px.
      const step = nudgeMod.referenceVectorNudgeStep(1, false)
      const outHandle = before.find((p) => p.kind === 'control')!
      const outVector = { x: outHandle.x - anchor.x, y: outHandle.y - anchor.y }
      const res = await mod.moveVectorReshapePoints(curve, [{ index: anchor.index, x: anchor.x + step, y: anchor.y }])
      const after = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0]!.points as ProbePoint[]
      const afterSibling = doc.querySelector('#sibling')!.outerHTML
      return { res, before, after, step, outVector, siblingBefore, siblingAfter: afterSibling, curveTag: curve.tagName.toLowerCase() }
    })
    expect(result.res.moved).toBe(true)
    expect(result.res.movedIndices).toEqual([result.before.find((p) => p.kind === 'anchor')!.index])
    expect(result.step * 5 * 1).toBeCloseTo(1, 9)
    const anchorBefore = result.before.find((p) => p.kind === 'anchor')!
    const anchorAfter = result.after[anchorBefore.index]!
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x + result.step, 6)
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6)
    // Handle tip travels with the anchor: the handle vector is unchanged.
    const outAfter = result.after.find((p) => p.kind === 'control')!
    expect(outAfter.x - anchorAfter.x).toBeCloseTo(result.outVector.x, 6)
    expect(outAfter.y - anchorAfter.y).toBeCloseTo(result.outVector.y, 6)
    // Purity: every other slot is byte-identical in position.
    for (const p of result.before) {
      if (p.index === anchorBefore.index) continue
      if (p.kind === 'control') continue // tips move rigidly with anchor 0 by construction
      const q = result.after[p.index]!
      expect(q.x).toBeCloseTo(p.x, 9)
      expect(q.y).toBeCloseTo(p.y, 9)
    }
    // The sibling unit is untouched and the edited node keeps its identity.
    expect(result.siblingAfter).toBe(result.siblingBefore)
    expect(result.curveTag).toBe('path')
  }, 30_000)

  it('nudges several selected anchors together under a nested group transform', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const paperMod = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<g id="outer" transform="translate(50 40)">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30 C50 30 60 30 70 30" fill="none" stroke="black"/>' +
        '</g></svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const outer = doc.querySelector('#outer')!
      const before = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0]!.points as ProbePoint[]
      const anchors = before.filter((p) => p.kind === 'anchor')
      const dx = 0.2
      const targets = [anchors[0]!, anchors[2]!].map((a) => ({ index: a.index, x: a.x + dx, y: a.y }))
      const res = await mod.moveVectorReshapePoints(outer, targets)
      const after = (await paperMod.paperVectorObjectList(new XMLSerializer().serializeToString(doc)))[0]!.points as ProbePoint[]
      return {
        res,
        before,
        after,
        outerTransform: outer.getAttribute('transform'),
        outerChildCount: outer.children.length,
        exported: new XMLSerializer().serializeToString(doc.documentElement),
      }
    })
    expect(result.res.moved).toBe(true)
    expect(result.res.movedIndices).toEqual([result.before.filter((p) => p.kind === 'anchor')[0]!.index, result.before.filter((p) => p.kind === 'anchor')[2]!.index].sort((a, b) => a - b))
    // Both selected anchors land on their document targets; the unselected
    // middle anchor never moves.
    const anchorsBefore = result.before.filter((p) => p.kind === 'anchor')
    const anchorsAfter = result.after.filter((p) => p.kind === 'anchor')
    expect(anchorsAfter[0]!.x).toBeCloseTo(anchorsBefore[0]!.x + 0.2, 6)
    expect(anchorsAfter[2]!.x).toBeCloseTo(anchorsBefore[2]!.x + 0.2, 6)
    expect(anchorsAfter[1]!.x).toBeCloseTo(anchorsBefore[1]!.x, 9)
    expect(anchorsAfter[1]!.y).toBeCloseTo(anchorsBefore[1]!.y, 9)
    // Wrapper transform survives literally; no rebasing or normalization.
    expect(result.outerTransform).toBe('translate(50 40)')
    expect(result.outerChildCount).toBe(1)
  }, 30_000)

  it('refuses control slots, text units and singular ancestors with the DOM untouched', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
        '<path id="curve" d="M10 30 C20 30 30 30 40 30" fill="none" stroke="black"/>' +
        '<text id="label" x="10" y="10">hi</text>' +
        '<g id="collapsed" transform="scale(0)"><path id="inner" d="M0 0 L10 10" stroke="black"/></g>' +
        '</svg>'
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const pristine = new XMLSerializer().serializeToString(doc.documentElement)
      const curve = doc.querySelector('#curve')!
      // Flattened index 1 on this curve is the out-handle control slot.
      const control = await mod.moveVectorReshapePoints(curve, [{ index: 1, x: 999, y: 999 }])
      const label = doc.querySelector('#label')!
      const text = await mod.moveVectorReshapePoints(label, [{ index: 0, x: 50, y: 50 }])
      const collapsed = doc.querySelector('#collapsed')!
      const singular = await mod.moveVectorReshapePoints(collapsed, [{ index: 0, x: 5, y: 5 }])
      return {
        control,
        text,
        singular,
        unchanged: new XMLSerializer().serializeToString(doc.documentElement) === pristine,
      }
    })
    expect(result.control.moved).toBe(false)
    expect(result.control.skipped).toEqual([{ index: 1, reason: 'control-point' }])
    expect(result.text.moved).toBe(false)
    expect(result.text.reason).toBe('not-editable')
    expect(result.singular.moved).toBe(false)
    expect(result.singular.reason).toBe('not-editable')
    expect(result.unchanged).toBe(true)
  }, 30_000)
})
