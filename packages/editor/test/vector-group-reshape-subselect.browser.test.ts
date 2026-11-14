// Group-leaf reshape subselect on the real page (Scratch parity).
//
// A `<g>` of two overlapping rects must resolve reshape clicks to one child
// shape via a real Paper.js hitTest (topmost wins for overlaps, never a bbox
// guess). Clicking a leaf's fill narrows the anchor selection to exactly that
// leaf; Shift toggles leaves in/out; dragging a selected anchor moves only
// that leaf (siblings, Z-order, wrapper transforms and the explicit-group
// marker survive); curve styling, moves, Escape cancels and tool switches
// keep the single-history / no-op-history rules; returning to select
// normalizes back to the compound root. Text/raster/clip/compound units stay
// fail-closed with an explicit status and no history or selection change.
//
// Coverage: overlap (2 rects, topmost-wins), a curved leaf (handles in the
// flattened mapping), a transformed group ancestor (unit translate from a
// select-mode move), child-only select/move, Shift multi toggle, Undo/Redo
// single entries, mid-drag Escape, tool-switch root normalization, ungroup.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4341'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function selectedAnchorCount() {
  // Anchor-only pressed count (excludes control handles). Since the
  // per-anchor handle-bitmask layer, explicit anchor selections carry mask 7
  // so their existing handles also render pressed; counting every pressed
  // point would report 12 (4 anchors + 8 handles) for one curved leaf. The
  // strict intent here is leaf isolation (which leaf's anchors are selected),
  // so filter to `Move path point` anchors like the reshape-review suite.
  return await page
    .locator('[data-vector-path-point][aria-pressed="true"]')
    .evaluateAll((els) => els.filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Move path point')).length)
}

async function waitForSelectedAnchorCount(expected: number) {
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length === count,
    expected,
  )
}

async function waitForSelectedCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvg(expected: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected)
}

async function waitForPreviewSvgChange(previous: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML !== svg, previous)
}

describe('group-leaf reshape subselect on the real page', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4341', '--strictPort'], {
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
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('fail-closed classifier and real-hit overlap order (no editor state)', async () => {
    const result = await page.evaluate(async () => {
      const helper = await import(/* @vite-ignore */ '/src/features/costumes/vector-group-reshape.ts')
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const parse = (markup: string) =>
        new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
      const textGroup = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="10" height="10"/><text x="0" y="0">hi</text></g></svg>',
      ).querySelector('g') as Element
      const rasterGroup = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="10" height="10"/><image href="data:,x" x="0" y="0" width="2" height="2"/></g></svg>',
      ).querySelector('g') as Element
      const clipGroup = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#c)"><rect x="0" y="0" width="10" height="10"/></g></svg>',
      ).querySelector('g') as Element
      const plainGroup = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="10" height="10"/></g></svg>',
      ).querySelector('g') as Element
      const overlap = parse(
        '<svg xmlns="http://www.w3.org/2000/svg"><g>' +
          '<rect x="0" y="0" width="60" height="40" fill="red"/>' +
          '<rect x="40" y="0" width="60" height="40" fill="blue"/>' +
          '</g></svg>',
      ).querySelector('g') as Element
      // Overlap: (10,20) sits in the red-only zone, (50,20) in the overlap
      // where the later (blue) leaf must win topmost.
      const redOnly = await paper.paperGroupLeafHitAtPoint(overlap, { x: 10, y: 20 })
      const overlapped = await paper.paperGroupLeafHitAtPoint(overlap, { x: 50, y: 20 })
      const blueOnly = await paper.paperGroupLeafHitAtPoint(overlap, { x: 90, y: 20 })
      const miss = await paper.paperGroupLeafHitAtPoint(overlap, { x: 200, y: 200 })
      const textHit = await paper.paperGroupLeafHitAtPoint(textGroup, { x: 5, y: 5 })
      return {
        textEligible: helper.classifyGroupUnitForLeafReshape(textGroup),
        rasterEligible: helper.classifyGroupUnitForLeafReshape(rasterGroup),
        clipEligible: helper.classifyGroupUnitForLeafReshape(clipGroup),
        plainEligible: helper.classifyGroupUnitForLeafReshape(plainGroup),
        redOnly,
        overlapped,
        blueOnly,
        miss,
        textHit,
      }
    })
    expect(result.textEligible).toEqual({ ok: false, reason: expect.stringContaining('fail-closed') })
    expect(result.rasterEligible).toEqual({ ok: false, reason: expect.stringContaining('fail-closed') })
    expect(result.clipEligible).toEqual({ ok: false, reason: expect.stringContaining('fail-closed') })
    expect(result.plainEligible).toEqual({ ok: true })
    expect(result.redOnly).toMatchObject({ kind: 'hit', leafIndex: 0 })
    // Real hitTest topmost-wins: the overlap names the blue (later) leaf.
    expect(result.overlapped).toMatchObject({ kind: 'hit', leafIndex: 1 })
    expect(result.blueOnly).toMatchObject({ kind: 'hit', leafIndex: 1 })
    expect(result.miss).toMatchObject({ kind: 'miss' })
    expect(result.textHit.kind).toBe('unsupported')
  }, 60_000)

  it('leaf click selects one child, Shift multis, anchor drag moves only that child', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    // Blank canvas so Ctrl+A groups exactly the two rects below.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(700)
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)

    const box = await surface.boundingBox()
    if (!box) throw new Error('missing surface')
    // Fixture注記 (2026-11-12): 外枠直結マッピングは viewport 依存で画面外へ
    // 飛び rect が欠けるため、Reset zoom + Zoom out x5 で art 全体を可視化し、
    // 描画は stage-surface 基準の同一 document 座標に統一する (製品 marquee
    // 自体は健全: 別途 enclosing probe で [0,1] を確認). 1枚目後は select+
    // blank で解除し、重なり辺での move-drag 化を避けて2 leaf を確定させる.
    await page.getByRole('button', { name: 'Reset zoom' }).click()
    for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
    await page.waitForTimeout(1200)
    // Drawing uses the exact stage-surface mapping (viewport-exact); leaf
    // clicks below use the same mapping.
    const drawClient = (svgX: number, svgY: number) =>
      page.evaluate(
        ({ x, y }) => {
          const stage = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
          if (!stage) throw new Error('vector stage surface missing')
          const rect = stage.getBoundingClientRect()
          return {
            x: rect.left + (x / 480) * rect.width,
            y: rect.top + (y / 360) * rect.height,
          }
        },
        { x: svgX, y: svgY },
      )
    // Exact svg -> client mapping through the vector stage surface (the
    // centered, viewport-scaled art node the editor maps through), resolved
    // in-page so pans/zooms stay exact.
    const artClient = (svgX: number, svgY: number) =>
      page.evaluate(
        ({ x, y }) => {
          const stage = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
          if (!stage) throw new Error('vector stage surface missing')
          const rect = stage.getBoundingClientRect()
          return {
            x: rect.left + (x / 480) * rect.width,
            y: rect.top + (y / 360) * rect.height,
          }
        },
        { x: svgX, y: svgY },
      )
    // Two overlapping rects: A (90,110,130x120), B (170,110,130x120).
    // Overlap x in [170,220]; A-exclusive x in [90,170).
    const rectTool = page.getByTestId('vector-shape-rect').last()
    await rectTool.click()
    {
      const from = await drawClient(90, 110)
      const to = await drawClient(220, 230)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
    }
    await page.waitForTimeout(900)
    await page.getByTestId('vector-shape-select').last().click()
    {
      const blank = await drawClient(30, 30)
      await page.mouse.click(blank.x, blank.y)
      await page.waitForTimeout(500)
    }
    await rectTool.click()
    {
      const from = await drawClient(170, 110)
      const to = await drawClient(300, 230)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
    }
    await page.waitForTimeout(900)
    const drawnCount = await page.evaluate(async () => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
      const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      return editableVectorUnits(doc.documentElement).length
    })
    expect(drawnCount).toBe(2)
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: 'Group' }).first().click()
    await page.waitForTimeout(700)
    let grouped = await previewSvg()
    expect(grouped.includes('xyo-vector-explicit-group')).toBe(true)

    // Transformed ancestor: move the whole group in select mode so the unit
    // carries its own translate; every leaf op below runs under it. The grab
    // point is the live group bounds center, mapped exactly.
    {
      const centerSvg = await page.evaluate(async () => {
        const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        const list = await paper.paperVectorObjectList(html)
        const group = list.find((o: { tag: string }) => o.tag === 'g')
        if (!group) throw new Error('group object missing')
        return {
          x: (group.boundsX ?? 0) + (group.boundsWidth ?? 0) / 2,
          y: (group.boundsY ?? 0) + (group.boundsHeight ?? 0) / 2,
        }
      })
      const center = await artClient(centerSvg.x, centerSvg.y)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.mouse.move(center.x + 40, center.y + 25, { steps: 8 })
      await page.mouse.up()
      await waitForPreviewSvgChange(grouped)
      grouped = await previewSvg()
      expect(grouped.includes('xyo-vector-explicit-group')).toBe(true)
    }

    const reshapeTool = page.getByTestId('vector-shape-reshape').last()
    await reshapeTool.click()
    await page.waitForSelector('[data-vector-path-point]')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
          (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
        ).length >= 8,
    )
    expect(await selectedAnchorCount()).toBe(0)

    // Leaf click targets from the live geometry (the select-mode move above
    // translated the unit, so derive A-exclusive / B-only interiors in
    // document coords instead of reusing the drawn coords).
    const targets = await page.evaluate(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
      const group = doc.querySelector('g.xyo-vector-explicit-group') as Element | null
      if (!group) throw new Error('group missing')
      // The select-mode move applies one translate per mousemove frame, so
      // sum every chained translate() op for the total document offset.
      const transform = group.getAttribute('transform') ?? ''
      let dx = 0
      let dy = 0
      for (const m of transform.matchAll(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/g)) {
        dx += Number(m[1])
        dy += Number(m[2])
      }
      const kids = Array.from(group.children) as Element[]
      if (kids.length !== 2) throw new Error(`expected 2 leaves, saw ${kids.length}`)
      const boundsOf = (el: Element) => ({
        x: Number(el.getAttribute('x') ?? '0'),
        y: Number(el.getAttribute('y') ?? '0'),
        width: Number(el.getAttribute('width') ?? '0'),
        height: Number(el.getAttribute('height') ?? '0'),
      })
      const a = boundsOf(kids[0]!)
      const b = boundsOf(kids[1]!)
      return {
        // A-exclusive: left of B's left edge, vertically centered.
        aX: dx + a.x + Math.min(a.width, b.x - a.x) / 2,
        aY: dy + a.y + a.height / 2,
        // B-only: right of A's right edge, vertically centered.
        bX: dx + (a.x + a.width) + (b.x + b.width - (a.x + a.width)) / 2,
        bY: dy + b.y + b.height / 2,
      }
    })
    // Sanity: A target must sit left of B's left edge (overlap names B).
    expect(targets.aX).toBeLessThan(targets.bX)

    // Leaf click: A interior narrows the selection to exactly A's 4 anchors.
    {
      const target = await artClient(targets.aX, targets.aY)
      await page.mouse.click(target.x, target.y)
      await waitForSelectedCount(4)
    }
    // Shift+click B interior: both leaves selected (8 anchors).
    {
      const target = await artClient(targets.bX, targets.bY)
      await page.keyboard.down('Shift')
      await page.mouse.click(target.x, target.y)
      await page.keyboard.up('Shift')
      await waitForSelectedCount(8)
    }
    // Plain click on A again replaces back to A's 4 anchors.
    {
      const target = await artClient(targets.aX, targets.aY)
      await page.mouse.click(target.x, target.y)
      await waitForSelectedCount(4)
    }

    // Curve A's anchors: the flattened mapping now carries handles, and the
    // style commits exactly one history entry.
    const svgPointed = await previewSvg()
    await page.getByTestId('reshape-curve-point').click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-vector-path-point]').length > 8,
    )
    expect(await selectedAnchorCount()).toBe(4)
    const svgCurved = await previewSvg()
    expect(svgCurved).not.toBe(svgPointed)

    // Anchor drag on the curved leaf: only A moves. B's markup, the child
    // order, the group transform and the marker must survive.
    const before = await page.evaluate(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
      const group = doc.querySelector('g.xyo-vector-explicit-group')
      const kids = group ? Array.from(group.children).map((el) => (el as Element).outerHTML) : []
      return { kids, transform: group?.getAttribute('transform') ?? '', count: kids.length, html }
    })
    expect(before.count).toBe(2)
    const handles = page.locator('[data-vector-path-point]')
    const firstBox = await handles.first().boundingBox()
    if (!firstBox) throw new Error('missing handle')
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(firstBox.x + firstBox.width / 2 + 30, firstBox.y + firstBox.height / 2 + 14, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(svgCurved)
    const svgMoved = await previewSvg()
    const after = await page.evaluate(() => {
      const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
      const group = doc.querySelector('g.xyo-vector-explicit-group')
      const kids = group ? Array.from(group.children).map((el) => (el as Element).outerHTML) : []
      return { kids, transform: group?.getAttribute('transform') ?? '', count: kids.length }
    })
    // Child-only move: B (second child) is byte-identical, order kept.
    expect(after.count).toBe(2)
    expect(after.kids[1]).toBe(before.kids[1])
    expect(after.kids[0]).not.toBe(before.kids[0])
    expect(after.transform).toBe(before.transform)
    expect(svgMoved.includes('xyo-vector-explicit-group')).toBe(true)
    expect(await selectedAnchorCount()).toBe(4)

    // Single history entry: one Undo restores the curved state, one Redo
    // re-applies the move.
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')
    await undoButton.click()
    await waitForPreviewSvg(svgCurved)
    await redoButton.click()
    await waitForPreviewSvg(svgMoved)

    // Mid-drag Escape restores the pre-drag SVG, keeps the leaf selection,
    // and writes no history entry.
    {
      const all = page.locator('[data-vector-path-point]')
      const target = await all.first().boundingBox()
      if (!target) throw new Error('missing handle for escape')
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x + target.width / 2 + 46, target.y + target.height / 2, { steps: 8 })
      await waitForPreviewSvgChange(svgMoved)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await waitForPreviewSvg(svgMoved)
      expect(await selectedAnchorCount()).toBe(4)
      // No entry was recorded: Undo still jumps to the curved state.
      await undoButton.click()
      await waitForPreviewSvg(svgCurved)
      await redoButton.click()
      await waitForPreviewSvg(svgMoved)
    }

    // Curve click on the already-selected leaf splits the curve (point-add)
    // instead of re-selecting: the new anchor becomes the selection, one
    // history entry, Undo/Redo round-trip.
    {
      const midpoint = await page.evaluate(async () => {
        const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        const list = await paper.paperVectorObjectList(html)
        const group = list.find((o: { tag: string }) => o.tag === 'g')
        if (!group?.points) throw new Error('group points missing')
        const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
        const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const units = editableVectorUnits(doc.documentElement)
        const flats = await paper.paperFlatAnchorIndicesForGroupLeaves(units[0]!, [0])
        if (!flats || flats.length < 2) throw new Error('leaf anchors missing')
        type Point = { index: number; x: number; y: number; kind?: string; controlRole?: string; relatedAnchorIndex?: number }
        const byIndex = new Map((group.points as Point[]).map((p) => [p.index, p]))
        const p0 = byIndex.get(flats[0]!)
        const p3 = byIndex.get(flats[1]!)
        if (!p0 || !p3) throw new Error('anchor coords missing')
        // Exact curve point: cubic Bezier at t=0.5 through the Paper control
        // handles (document coords), so the click lands on the outline.
        const out = (group.points as Point[]).find((p) => p.kind === 'control' && p.controlRole === 'out' && p.relatedAnchorIndex === p0.index)
        const inn = (group.points as Point[]).find((p) => p.kind === 'control' && p.controlRole === 'in' && p.relatedAnchorIndex === p3.index)
        if (!out || !inn) throw new Error('curve handles missing')
        const at = (t: number) => {
          const mt = 1 - t
          return {
            x: mt * mt * mt * p0.x + 3 * mt * mt * t * out.x + 3 * mt * t * t * inn.x + t * t * t * p3.x,
            y: mt * mt * mt * p0.y + 3 * mt * mt * t * out.y + 3 * mt * t * t * inn.y + t * t * t * p3.y,
          }
        }
        return at(0.5)
      })
      const target = await artClient(midpoint.x, midpoint.y)
      await page.mouse.click(target.x, target.y)
      await waitForSelectedAnchorCount(1)
      const svgAdded = await previewSvg()
      expect(svgAdded).not.toBe(svgMoved)
      await undoButton.click()
      await waitForPreviewSvg(svgMoved)
      await redoButton.click()
      await waitForPreviewSvg(svgAdded)
      await undoButton.click()
      await waitForPreviewSvg(svgMoved)
      // Re-select leaf A so the switch-cancel leg below starts selected.
      const reselect = await artClient(targets.aX, targets.aY)
      await page.mouse.click(reselect.x, reselect.y)
      await waitForSelectedAnchorCount(4)
    }

    // Select tool normalizes back to the compound root: handles clear, the
    // group stays selected, and reshape re-entry starts with no stale leaf.
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    expect(await previewSvg()).toBe(svgMoved)
    await reshapeTool.click()
    await page.waitForSelector('[data-vector-path-point]')
    expect(await selectedAnchorCount()).toBe(0)
    expect(await previewSvg()).toBe(svgMoved)

    // Existing group op survives: ungroup drops the marker and keeps order.
    await page.getByTestId('vector-shape-select').last().click()
    // Re-select the group root (the only unit) via select-all, then ungroup.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(500)
    const ungroupBtn = page.getByRole('button', { name: 'Ungroup' }).first()
    if (await ungroupBtn.isEnabled().catch(() => false)) await ungroupBtn.click()
    await page.waitForTimeout(700)
    expect(await previewSvg()).not.toContain('xyo-vector-explicit-group')
  }, 240_000)
})
