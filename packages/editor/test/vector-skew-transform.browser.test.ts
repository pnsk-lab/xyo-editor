// Skew-aware transform audit with browser-native oracles.
//
// Unit-level agreement (`vector-svg.ts` vs `vector-group-reshape.ts`,
// malformed fail-closed, non-invertible handling) is covered without a
// browser in `vector-skew-transform.test.ts`. This file proves the same code
// against oracles that only exist in a real browser:
//
// - SVG/DOMMatrix oracle: the browser's own `SVGTransformList.consolidate()`
//   parses each `transform` string independently of our code; our two parsers
//   must agree with the native matrix (skewX/skewY, composite order,
//   negative/decimal/exponent values, comma separators).
// - Paper.js oracle: Paper parses SVG transforms itself (including skew) and
//   bakes ancestor transforms into its imports. Our `worldTransformMatrix`
//   point lists must agree with Paper's document-space anchors, a
//   skew-shifted point must hit-test through Paper, and
//   reshape move/add round-trips through skewed ancestors.
// - Real editor: a skewed-ancestor `<g>` leaf is selected, one point is
//   dragged, undo/redo restores exactly, and the sibling leaf is unchanged.
//
// Behaviour notes only; no reference source is copied. `Editor.svelte` and
// `BitmapEditor.svelte` are not touched (upload + toolbar driven).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4355'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('skew transform browser oracles', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4355', '--strictPort'], {
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
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('DOMMatrix/native oracle: both parsers match SVG consolidate() on skew chains', async () => {
    const result = await page.evaluate(async () => {
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-reshape.ts')
      const corpus = [
        'skewX(45)',
        'skewY(45)',
        'skewX(-30)',
        'skewY(-15)',
        'skewX(12.5)',
        'skewY(0.5)',
        'translate(10 20) skewX(30)',
        'skewX(30) translate(10 20)',
        'translate(-4 2.5e1) skewX(-10)',
        'skewY(20) scale(1.5)',
        'translate(10,20) skewX(30),scale(2)',
        'rotate(30) skewX(20) skewY(-10)',
        'rotate(30 10 20) skewY(15)',
        'matrix(1 0.5 -0.25 1 10 -5) skewX(10)',
        'scale(-2 .5) skewY(1.5e1)',
        'skewX(20) skewY(10) translate(5 5) scale(2) rotate(-15)',
        'translate(1e2 -2E-1) skewX(3e1)',
      ]
      const svgNS = 'http://www.w3.org/2000/svg'
      const doc = document.implementation.createDocument(svgNS, 'svg', null)
      const rows = corpus.map((text) => {
        const g = doc.createElementNS(svgNS, 'g')
        g.setAttribute('transform', text)
        doc.documentElement.appendChild(g)
        const consolidated = g.transform.baseVal.consolidate()
        const native = consolidated
          ? [consolidated.matrix.a, consolidated.matrix.b, consolidated.matrix.c, consolidated.matrix.d, consolidated.matrix.e, consolidated.matrix.f]
          : null
        const ours = vector.transformMatrix(text)
        const grouped = helper.parseSvgTransformAttribute(text)
        return { text, native, ours, grouped }
      })
      // Malformed input: native parsing may drop/keep ops; ours must never
      // throw, never emit NaN, and must stay finite (fail-closed identity).
      const malformed = ['skewX()', 'skewX(bogus)', 'translate(10 abc)', 'matrix(1 2 3)', 'skewx(30)'].map((text) => {
        let ours: unknown = 'threw'
        let grouped: unknown = 'threw'
        try {
          ours = vector.transformMatrix(text) ?? 'undefined'
        } catch {}
        try {
          grouped = helper.parseSvgTransformAttribute(text)
        } catch {}
        return { text, ours, grouped }
      })
      return { rows, malformed }
    })
    for (const row of result.rows as Array<{ text: string; native: number[] | null; ours: number[] | null; grouped: number[] }>) {
      expect(row.native, `native consolidate missing for ${row.text}`).not.toBeNull()
      expect(row.ours, `vector parser dropped ${row.text}`).not.toBeNull()
      for (let i = 0; i < 6; i++) {
        expect(Math.abs(row.ours![i]! - row.native![i]!)).toBeLessThan(1e-6)
        expect(Math.abs(row.grouped[i]! - row.native![i]!)).toBeLessThan(1e-6)
      }
    }
    for (const row of result.malformed as Array<{ text: string; ours: unknown; grouped: unknown }>) {
      for (const matrix of [row.ours, row.grouped]) {
        if (matrix === 'undefined' || matrix === 'threw') continue
        expect(Array.isArray(matrix)).toBe(true)
        for (const entry of matrix as number[]) expect(Number.isFinite(entry)).toBe(true)
      }
      expect(row.ours).not.toBe('threw')
      expect(row.grouped).not.toBe('threw')
    }
  }, 60_000)

  it('Paper oracle: world anchors, skew-shifted hit, and move/add round-trip', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const pathPoints = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      // Rect (0,0,20,10) under skewX(45): corner (0,0)->(0,0), (20,0)->(20,0),
      // (20,10)->(30,10), (0,10)->(10,10). Doc point (24,5) maps to local
      // (19,5): inside the skewed rect but 4px outside the unskewed box, so
      // only a skew-aware hit test reports it (tolerance is 0.5px).
      const skewedSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="skewX(45)">' +
        '<rect x="0" y="0" width="20" height="10" fill="red"/></g></svg>'
      const skewedDoc = new DOMParser().parseFromString(skewedSvg, 'image/svg+xml')
      const skewedUnits = vector.editableVectorUnits(skewedDoc.documentElement)
      const skewedRect = skewedUnits[0] as Element
      const ours = vector.vectorEditablePoints(skewedRect)
      const paperList = await paper.paperVectorObjectList(skewedSvg)
      const paperPoints = (paperList[0] as unknown as { points: Array<{ x: number; y: number }> }).points
      const anchorDeltas = ours.map((point: { x: number; y: number }) => {
        let best = Infinity
        for (const other of paperPoints) best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y))
        return best
      })
      const hitSkewed = await paper.paperVectorHitIndex(skewedUnits as Element[], { x: 24, y: 5 })
      const hitOutside = await paper.paperVectorHitIndex(skewedUnits as Element[], { x: 24, y: 40 })
      // Reshape move/add through a skewed ancestor: two-rect group, skew on a
      // nested wrapper so the ancestor inverse is exercised.
      const groupSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="xyo-vector-explicit-group">' +
        '<g transform="skewX(30)"><rect x="0" y="0" width="20" height="10" fill="red"/>' +
        '<rect x="40" y="0" width="20" height="10" fill="blue"/></g></g></svg>'
      const groupDoc = new DOMParser().parseFromString(groupSvg, 'image/svg+xml')
      const groupUnits = vector.editableVectorUnits(groupDoc.documentElement)
      const groupElement = groupUnits[0] as Element
      const beforeList = await paper.paperVectorObjectList(groupSvg)
      const beforePoints = (beforeList[0] as unknown as { points: Array<{ x: number; y: number; kind?: string; index: number }> }).points
      const firstAnchor = beforePoints.find((p) => p.kind === 'anchor')!
      const moveResult = await pathPoints.moveVectorReshapePoints(groupElement, [
        { index: firstAnchor.index, x: firstAnchor.x + 6, y: firstAnchor.y + 4 },
      ])
      const afterSvg = new XMLSerializer().serializeToString(groupDoc.documentElement)
      const afterList = await paper.paperVectorObjectList(afterSvg)
      const afterPoints = (afterList[0] as unknown as { points: Array<{ x: number; y: number; kind?: string; index: number }> }).points
      const movedAnchor = afterPoints.find((p) => p.index === firstAnchor.index)
      // Sibling leaf (blue rect): every anchor except the moved one must be
      // byte-identical in document space.
      const siblingBefore = beforePoints.filter((p) => p.index !== firstAnchor.index)
      const siblingAfter = afterPoints.filter((p) => p.index !== firstAnchor.index)
      const siblingDrift = siblingBefore.map((p) => {
        const match = siblingAfter.find((q) => q.index === p.index)!
        return Math.hypot(p.x - match.x, p.y - match.y)
      })
      // Add a point on the skewed path: midpoint of the top edge in document
      // coordinates (skewX(30) shifts y=0 edge by tan30*y = 0, so the top edge
      // midpoint is (10,0); use a slanted edge instead: left edge midpoint
      // local (0,5) -> doc (tan30*5, 5)).
      const skewedPathSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="skewX(30)">' +
        '<path d="M0 0 L20 0 L20 10 L0 10 Z" fill="red"/></g></svg>'
      const skewedPathDoc = new DOMParser().parseFromString(skewedPathSvg, 'image/svg+xml')
      const skewedPathUnits = vector.editableVectorUnits(skewedPathDoc.documentElement)
      const skewedPathEl = skewedPathUnits[0] as Element
      const tan30 = Math.tan((30 * Math.PI) / 180)
      // Tolerance 2px: the probe point sits 5px from the nearest anchor, so
      // the default tolerance (6px) would snap to the existing anchor.
      const addResult = await pathPoints.addVectorPathPoint(skewedPathEl, tan30 * 5, 5, { tolerance: 2 })
      return {
        ourPointCount: ours.length,
        paperPointCount: paperPoints.length,
        anchorDeltas,
        hitSkewed,
        hitOutside,
        moved: moveResult.moved,
        movedAnchor,
        moveTarget: { x: firstAnchor.x + 6, y: firstAnchor.y + 4 },
        siblingDrift,
        siblingCount: siblingBefore.length,
        groupTransformKept: (groupElement.getAttribute('transform') ?? '').includes('skew') || groupElement.querySelector('g')?.getAttribute('transform')?.includes('skew') === true,
        addResult,
      }
    })
    // Our world anchors agree with Paper's baked import (sub-pixel).
    expect(result.ourPointCount).toBeGreaterThan(0)
    expect(result.paperPointCount).toBe(result.ourPointCount)
    for (const delta of result.anchorDeltas as number[]) expect(delta).toBeLessThan(0.5)
    // Skew-shifted point hits; far-away point misses.
    expect(result.hitSkewed).toBe(0)
    expect(result.hitOutside).toBe(-1)
    // Move lands on the document target; siblings do not drift.
    expect(result.moved).toBe(true)
    expect(Math.abs(result.movedAnchor!.x - result.moveTarget.x)).toBeLessThan(0.75)
    expect(Math.abs(result.movedAnchor!.y - result.moveTarget.y)).toBeLessThan(0.75)
    expect(result.siblingCount).toBeGreaterThan(0)
    for (const drift of result.siblingDrift as number[]) expect(drift).toBeLessThan(0.25)
    expect(result.groupTransformKept).toBe(true)
    // Add on the skewed edge succeeds and reports the new anchor.
    expect((result.addResult as { added: boolean }).added).toBe(true)
  }, 60_000)

  it('editor: skew-ancestor group leaf move, undo/redo, sibling unchanged', async () => {
    const skewedSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
      '<g class="xyo-vector-explicit-group" transform="skewX(20)">' +
      '<rect x="60" y="60" width="80" height="50" fill="#ff0000"/>' +
      '<rect x="200" y="60" width="80" height="50" fill="#0000ff"/>' +
      '</g></svg>'
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
    const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
    await page.getByTestId('costume-file-input').setInputFiles({
      name: 'skew-group.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(skewedSvg, 'utf8'),
    })
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      beforeCards,
      { timeout: 30_000 },
    )
    const cards = page.getByTestId(/costume-card-\d+/)
    await cards.last().getByRole('button', { name: /Select / }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
      await page.locator('.vector-preview').waitFor({ state: 'visible' })
    }
    const svgBefore = await page.locator('.vector-preview').innerHTML()
    expect(svgBefore).toContain('skewX')

    const leafGeometry = async (svgText: string, fill: string) => {
      return await page.evaluate(
        ({ svg, color }: { svg: string; color: string }) => {
          const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
          const all = Array.from(doc.documentElement.querySelectorAll('*'))
          const matches = all.filter(
            (element) => (element.getAttribute('fill') ?? '').toLowerCase() === color,
          )
          return matches.map((element) => ({
            tag: element.tagName.toLowerCase(),
            attrs: Array.from(element.attributes)
              .map((attr) => `${attr.name}=${attr.value}`)
              .sort()
              .join('|'),
          }))
        },
        { svg: svgText, color: fill },
      )
    }
    const blueBefore = await leafGeometry(svgBefore, '#0000ff')
    expect(blueBefore.length).toBe(1)

    // Select the group unit, enter reshape, drag one handle.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(700)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForTimeout(800)
    const handles = page.locator('[data-vector-path-point]')
    const count = await handles.count()
    expect(count).toBeGreaterThanOrEqual(8)
    // The 480x360 workspace renders at 5x inside a smaller surface, so an
    // uploaded costume starts cropped; zooming out keeps the workspace center
    // fixed and brings the skewed handles into view before dragging.
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    let handleVisible = false
    for (let i = 0; i < 14; i++) {
      const hb = await handles.first().boundingBox()
      const sb = await surface.boundingBox()
      if (
        hb && sb &&
        hb.x > sb.x + 5 && hb.y > sb.y + 5 &&
        hb.x + hb.width < sb.x + sb.width - 5 && hb.y + hb.height < sb.y + sb.height - 5
      ) {
        handleVisible = true
        break
      }
      await zoomOut.click()
      await page.waitForTimeout(250)
    }
    expect(handleVisible).toBe(true)
    const firstBox = await handles.first().boundingBox()
    if (!firstBox) throw new Error('missing handle')
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(firstBox.x + firstBox.width / 2 + 30, firstBox.y + firstBox.height / 2 + 20, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(900)

    const svgAfterMove = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterMove).not.toBe(svgBefore)
    expect(svgAfterMove).toContain('xyo-vector-explicit-group')
    expect(svgAfterMove).toContain('skewX')
    const blueAfterMove = await leafGeometry(svgAfterMove, '#0000ff')
    expect(blueAfterMove).toEqual(blueBefore)

    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, svgAfterMove, { timeout: 30_000 })
    const svgAfterUndo = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterUndo).toBe(svgBefore)

    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML !== prev, svgAfterUndo, { timeout: 30_000 })
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
    const svgAfterRedo = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterRedo).toBe(svgAfterMove)
    const blueAfterRedo = await leafGeometry(svgAfterRedo, '#0000ff')
    expect(blueAfterRedo).toEqual(blueBefore)
  }, 180_000)
})
