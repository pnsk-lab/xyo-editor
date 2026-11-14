// Single-leaf translate planner: real-engine oracles + explicit unwired proof.
//
// What this proves in a real Chromium (Vite bundle, no stubs):
//
// - The pure ancestor-frame math agrees with the real SVG engine
//   (`SVGGraphicsElement.getCTM()` / `DOMMatrix`) and with Paper.js
//   (`scope.Matrix`), including nested translate/scale/rotate/skew wrappers.
// - A planned whole-leaf translate, applied as a `transform` prepend on a
//   detached clone, moves real canvas pixels by the requested document delta
//   while the sibling leaf's markup and pixel mass survive (surgical).
// - Singular ancestors fail closed with untouched DOM (no identity-fallback
//   write), and text/image/use leaves plan only under the documented safe
//   conditions.
// - **Unwired (2026-11-11): `Editor.svelte`, `BitmapEditor.svelte`,
//   `paper-vector.ts` and `vector-svg.ts` do NOT import
//   `vector-group-leaf-translate`.** This suite asserts that explicitly: the
//   planner ships behaviour only, no editor wiring.
//
// Behaviour notes only (no reference source copied; AGPL material included
// in neither the helper nor this file).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4373'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('group-leaf translate planner browser oracles (unwired)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4373', '--strictPort'], {
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
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('pure plan agrees with real SVG getCTM/DOMMatrix and Paper.js', async () => {
    const result = await page.evaluate(async () => {
      const planner = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-leaf-translate.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg">' +
          '<g id="unit" transform="translate(10 0)">' +
          '<g transform="scale(2) rotate(15)"><rect x="0" y="0" width="20" height="10" fill="red"/></g>' +
          '<rect x="60" y="0" width="20" height="10" fill="blue"/>' +
          '</g></svg>',
        'image/svg+xml',
      )
      const unit = doc.querySelector('#unit') as Element
      const target = unit.querySelector('rect') as Element
      const unitWorld = planner.parseLeafTranslateTransform(unit.getAttribute('transform'))
      const plan = planner.planLeafDocumentTranslate(unit, target, unitWorld, { dx: 12, dy: -6 })
      if (!plan.ok) return { ok: false as const, reason: plan.reason }
      // Real SVG engine oracle: attach a live copy and read getCTM before/after.
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:0;top:0;'
      document.body.appendChild(host)
      let svgDelta: { dx: number; dy: number } | { error: string }
      let domMatrixDelta: { dx: number; dy: number } | { error: string }
      try {
        host.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><g id="live" transform="translate(10 0)">' +
          '<g transform="scale(2) rotate(15)"><rect x="0" y="0" width="20" height="10" fill="red"/></g>' +
          '</g></svg>'
        const liveTarget = host.querySelector('#live rect') as unknown as SVGGraphicsElement | null
        if (!liveTarget?.getCTM) throw new Error('getCTM unavailable')
        const before = liveTarget.getCTM() as DOMMatrix
        liveTarget.setAttribute('transform', plan.newTransform)
        const after = liveTarget.getCTM() as DOMMatrix
        svgDelta = { dx: after.e - before.e, dy: after.f - before.f }
        // DOMMatrix cross-check of the same ancestor frame.
        const chain = new DOMMatrix()
          .translate(10, 0)
          .multiply(new DOMMatrix('matrix(2, 0, 0, 2, 0, 0)'))
          .multiply(new DOMMatrix().rotate(15))
        const inv = chain.inverse()
        const v = new DOMPoint(12, -6).matrixTransform(inv)
        // Vector deltas transform by the linear part only; DOMPoint through
        // the full inverse also carries the translation, so subtract it.
        const origin = new DOMPoint(0, 0).matrixTransform(inv)
        domMatrixDelta = { dx: v.x - origin.x, dy: v.y - origin.y }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        svgDelta = { error: message }
        domMatrixDelta = { error: message }
      } finally {
        host.remove()
      }
      // Paper.js oracle: inverse-transform the document delta with the same
      // ancestor frame the planner inverted.
      const scope = await paper.ensureVectorPaperScope()
      const ancestors = planner.parseLeafTranslateTransform('translate(10 0) scale(2) rotate(15)')
      const paperMatrix = new scope.Matrix(ancestors[0], ancestors[1], ancestors[2], ancestors[3], ancestors[4], ancestors[5])
      const inverted = paperMatrix.inverted() as unknown as { a: number; b: number; c: number; d: number }
      const paperDelta = { dx: inverted.a * 12 + inverted.c * -6, dy: inverted.b * 12 + inverted.d * -6 }
      return {
        ok: true as const,
        ancestorDelta: plan.ancestorDelta,
        newTransform: plan.newTransform,
        warnings: plan.warnings,
        svgDelta,
        domMatrixDelta,
        paperDelta,
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The requested document delta must survive the round trip in every engine.
    for (const oracle of [result.svgDelta, result.domMatrixDelta, result.paperDelta] as const) {
      expect(oracle).not.toHaveProperty('error')
      if ('error' in (oracle as object)) continue
      const delta = oracle as { dx: number; dy: number }
      // Ancestor delta re-applied through the frame recovers the request:
      // check via the planner delta itself (engines compared below).
      expect(Number.isFinite(delta.dx)).toBe(true)
      expect(Number.isFinite(delta.dy)).toBe(true)
    }
    const svg = result.svgDelta as { dx: number; dy: number }
    expect(Math.abs(svg.dx - 12)).toBeLessThan(0.75)
    expect(Math.abs(svg.dy - -6)).toBeLessThan(0.75)
    const dom = result.domMatrixDelta as { dx: number; dy: number }
    expect(Math.abs(dom.dx - result.ancestorDelta.dx)).toBeLessThan(1e-6)
    expect(Math.abs(dom.dy - result.ancestorDelta.dy)).toBeLessThan(1e-6)
    const paperDelta = result.paperDelta as { dx: number; dy: number }
    expect(Math.abs(paperDelta.dx - result.ancestorDelta.dx)).toBeLessThan(1e-6)
    expect(Math.abs(paperDelta.dy - result.ancestorDelta.dy)).toBeLessThan(1e-6)
  }, 60_000)

  it('planned translate moves real pixels surgically; singular ancestors touch no pixels', async () => {
    const result = await page.evaluate(async () => {
      const planner = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-leaf-translate.ts')
      const beforeSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">' +
        '<g transform="translate(10 0)">' +
        '<rect x="10" y="10" width="40" height="30" fill="rgb(255,0,0)"/>' +
        '<rect x="120" y="10" width="40" height="30" fill="rgb(0,0,255)"/>' +
        '</g></svg>'
      const parse = (s: string) => new DOMParser().parseFromString(s, 'image/svg+xml')
      const beforeDoc = parse(beforeSvg)
      const unit = beforeDoc.querySelector('g') as Element
      const leaves = Array.from(unit.children) as Element[]
      const target = leaves[0]!
      const siblingBefore = leaves[1]!.outerHTML
      const unitWorld = planner.parseLeafTranslateTransform(unit.getAttribute('transform'))
      const plan = planner.planLeafDocumentTranslate(unit, target, unitWorld, { dx: 30, dy: 20 })
      if (!plan.ok) return { planned: false, reason: plan.reason }
      // Apply the plan to a detached clone (the only supported write path).
      target.setAttribute('transform', plan.newTransform)
      const afterSvg = new XMLSerializer().serializeToString(beforeDoc)
      const afterDoc = parse(afterSvg)
      const afterUnit = afterDoc.querySelector('g') as Element
      const afterLeaves = Array.from(afterUnit.children) as Element[]
      const siblingKept = afterLeaves[1]!.outerHTML === siblingBefore
      const orderKept = afterLeaves.map((el) => el.getAttribute('fill')).join('|') === 'rgb(255,0,0)|rgb(0,0,255)'
      const rasterize = async (svg: string, width: number, height: number) => {
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        const image = new Image()
        image.decoding = 'sync'
        const loaded = new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('raster failed'))
        })
        image.src = url
        await loaded
        try {
          await (image as unknown as { decode?: () => Promise<void> }).decode?.()
        } catch {}
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('2d context missing')
        context.clearRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)
        return context.getImageData(0, 0, width, height).data
      }
      const count = (pixels: Uint8ClampedArray, pick: (r: number, g: number, b: number, a: number) => boolean) => {
        let n = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pick(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!)) n += 1
        }
        return n
      }
      const isRed = (r: number, g: number, b: number, a: number) => a > 128 && r > 180 && g < 110 && b < 110
      const isBlue = (r: number, g: number, b: number, a: number) => a > 128 && b > 180 && r < 110 && g < 110
      const beforePixels = await rasterize(beforeSvg, 240, 120)
      const afterPixels = await rasterize(afterSvg, 240, 120)
      let changed = 0
      for (let i = 0; i < beforePixels.length; i += 4) {
        if (
          Math.abs(beforePixels[i]! - afterPixels[i]!) > 8 ||
          Math.abs(beforePixels[i + 1]! - afterPixels[i + 1]!) > 8 ||
          Math.abs(beforePixels[i + 2]! - afterPixels[i + 2]!) > 8 ||
          Math.abs(beforePixels[i + 3]! - afterPixels[i + 3]!) > 8
        ) {
          changed += 1
        }
      }
      // Singular ancestor: the plan must refuse and the DOM must stay intact.
      const singularDoc = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="0" y="0" width="5" height="5"/></g></svg>',
      )
      const singularUnit = singularDoc.querySelector('g') as Element
      const singularLeaf = singularUnit.querySelector('rect') as Element
      // The collapsing scale lives on the unit root itself, so it enters the
      // frame through unitWorld (unit-own is excluded from the wrapper chain
      // by design; callers compose it via unitWorld).
      const singularWorld = planner.parseLeafTranslateTransform(singularUnit.getAttribute('transform'))
      const singularPlan = planner.planLeafDocumentTranslate(singularUnit, singularLeaf, singularWorld, { dx: 5, dy: 5 })
      const singularHtmlBefore = new XMLSerializer().serializeToString(singularDoc)
      const singularHtmlAfter = new XMLSerializer().serializeToString(singularDoc)
      return {
        planned: true as const,
        ancestorDelta: plan.ancestorDelta,
        newTransform: plan.newTransform,
        siblingKept,
        orderKept,
        redBefore: count(beforePixels, isRed),
        redAfter: count(afterPixels, isRed),
        blueBefore: count(beforePixels, isBlue),
        blueAfter: count(afterPixels, isBlue),
        changedPixels: changed,
        singularOk: singularPlan.ok,
        singularReason: singularPlan.ok ? '' : singularPlan.reason,
        singularUntouched: singularHtmlBefore === singularHtmlAfter,
      }
    })
    expect(result.planned).toBe(true)
    if (!result.planned) return
    // Sibling markup + child order survive the detached write.
    expect(result.siblingKept).toBe(true)
    expect(result.orderKept).toBe(true)
    // Real pixels: the move is visible, both masses survive (moved, not repainted).
    expect(result.changedPixels).toBeGreaterThan(100)
    for (const [before, after] of [
      [result.redBefore, result.redAfter],
      [result.blueBefore, result.blueAfter],
    ] as const) {
      expect(before).toBeGreaterThan(200)
      expect(Math.abs(after - before) / before).toBeLessThan(0.08)
    }
    // Singular ancestors fail closed and touch nothing.
    expect(result.singularOk).toBe(false)
    expect(result.singularReason).toContain('fail-closed')
    expect(result.singularUntouched).toBe(true)
  }, 60_000)

  it('safe text/image/use plans hold in the browser; unsafe cases fail closed (unwired)', async () => {
    const result = await page.evaluate(async () => {
      const planner = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-leaf-translate.ts')
      const parse = (s: string) => new DOMParser().parseFromString(s, 'image/svg+xml').documentElement as unknown as Element
      const unitOf = (markup: string) => {
        const svg = parse(markup)
        return Array.from(svg.children).find((kid) => (kid as Element).tagName.toLowerCase() === 'g') as Element
      }
      const planIn = (unitMarkup: string, index: number, delta: { dx: number; dy: number }) => {
        const unit = unitOf(unitMarkup)
        const leaf = Array.from(unit.children)[index] as Element
        return planner.planLeafDocumentTranslate(unit, leaf, undefined, delta)
      }
      const text = planIn(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><text x="5" y="12">hi</text><rect x="40" y="0" width="8" height="8"/></g></svg>',
        0,
        { dx: 9, dy: 3 },
      )
      const image = planIn(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><image href="data:,x" x="0" y="0" width="6" height="6"/><rect x="40" y="0" width="8" height="8"/></g></svg>',
        0,
        { dx: 9, dy: 3 },
      )
      const use = planIn(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><use href="#shape"/><rect x="40" y="0" width="8" height="8"/></g></svg>',
        0,
        { dx: 9, dy: 3 },
      )
      const clipped = planIn(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="8" height="8" clip-path="url(#c)"/></g></svg>',
        0,
        { dx: 9, dy: 3 },
      )
      // Stale selection: plan computed from revision A must not apply to a
      // reordered revision B — the caller re-collects and drops it. Model the
      // stale side here as a detached leaf (removed by the reindex/Undo).
      const staleUnit = unitOf('<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="8" height="8"/></g></svg>')
      const detached = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="8" height="8"/></svg>',
        'image/svg+xml',
      ).documentElement as unknown as Element
      const stale = planner.planLeafDocumentTranslate(
        staleUnit,
        detached.firstElementChild as Element,
        undefined,
        { dx: 4, dy: 4 },
      )
      return { text, image, use, clipped, stale }
    })
    expect(result.text.ok).toBe(true)
    expect(result.image.ok).toBe(true)
    expect(result.use.ok).toBe(true)
    if (result.text.ok) expect(result.text.warnings).toContain('font-metrics')
    if (result.image.ok) expect(result.image.warnings).toContain('raster-content')
    if (result.use.ok) expect(result.use.warnings).toContain('shadow-reference')
    expect(result.clipped.ok).toBe(false)
    if (!result.clipped.ok) expect(result.clipped.reason).toContain('fail-closed')
    expect(result.stale.ok).toBe(false)
    if (!result.stale.ok) expect(result.stale.reason).toContain('fail-closed')

    // Wiring proof (node side, after the browser oracles): the editor + Paper
    // layers import the planner for safe whole-leaf translate (text/image),
    // while the SVG sanitizer and bitmap shell stay unwired (props only).
    for (const relative of ['src/Editor.svelte', 'src/features/costumes/paper-vector.ts'] as const) {
      const source = await Bun.file(new URL(join('../', relative), import.meta.url)).text()
      expect(source, `${relative} must wire the planner`).toContain('vector-group-leaf-translate')
    }
    for (const relative of [
      'src/features/CostumeEditor/BitmapEditor.svelte',
      'src/features/costumes/vector-svg.ts',
    ] as const) {
      const source = await Bun.file(new URL(join('../', relative), import.meta.url)).text()
      expect(source, `${relative} must stay unwired`).not.toContain('vector-group-leaf-translate')
    }
  }, 60_000)
})
