import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Group-reshape parity: a `<g>` of two rects must expose reshape anchors
// (Scratch reaches Shape/Path points inside groups), and point move/add/
// delete must patch only the edited leaf — wrapper transforms, inherited
// paint, siblings, Z-order and user data survive. Compound children stay
// flattened (no per-child subselection); empty groups stay ghosts.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4261'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('vector group reshape parity', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4261', '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) { ready = true; break }
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

  it('exposes group leaf points and moves one surgically', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const pathPoints = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="xyo-vector-explicit-group" transform="translate(10 0)" data-keep="yes">' +
        '<rect x="0" y="0" width="20" height="10" fill="red" data-leaf="a"/>' +
        '<rect x="30" y="0" width="20" height="10" fill="blue" data-leaf="b"/>' +
        '</g><rect x="0" y="50" width="10" height="10" fill="green"/></svg>'
      const list = await paper.paperVectorObjectList(svg)
      const group = list.find((o: any) => o.tag === 'g') as any
      const points = group?.points ?? []
      // Move the first anchor of the group (+5,+5 document units).
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const units = vector.editableVectorUnits(doc.documentElement)
      const element = units[list.indexOf(group)] as Element
      const first = points.find((p: any) => p.kind === 'anchor')
      const moveResult = await pathPoints.moveVectorReshapePoints(element, [{ index: first.index, x: first.x + 5, y: first.y + 5 }])
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      const afterDoc = new DOMParser().parseFromString(after, 'image/svg+xml')
      const afterUnits = vector.editableVectorUnits(afterDoc.documentElement)
      const afterGroup = afterUnits[0] as Element
      const kids = Array.from(afterGroup.children).map((e) => (e as Element).tagName.toLowerCase())
      const afterList = await paper.paperVectorObjectList(after)
      const afterGroupPoints = (afterList.find((o: any) => o.tag === 'g') as any)?.points ?? []
      return {
        groupPointCount: points.length,
        anchorCount: points.filter((p: any) => p.kind === 'anchor').length,
        moved: moveResult.moved,
        groupTagAfter: afterGroup.tagName.toLowerCase(),
        markerAfter: afterGroup.getAttribute('class') ?? '',
        userDataAfter: afterGroup.getAttribute('data-keep'),
        transformAfter: afterGroup.getAttribute('transform'),
        childTagsAfter: kids,
        siblingFillAfter: (afterUnits[1] as Element)?.getAttribute('fill'),
        leafAData: afterGroup.querySelector('[data-leaf="a"]') !== null || after.includes('data-leaf="a"'),
        secondLeafFill: after.includes('fill="blue"'),
        pointsAfterMove: afterGroupPoints.length,
      }
    })
    expect(result.groupPointCount).toBeGreaterThanOrEqual(8)
    expect(result.anchorCount).toBeGreaterThanOrEqual(8)
    expect(result.moved).toBe(true)
    expect(result.groupTagAfter).toBe('g')
    expect(result.markerAfter).toContain('xyo-vector-explicit-group')
    expect(result.userDataAfter).toBe('yes')
    expect(result.transformAfter).toContain('translate')
    // Surgical write-back: exactly two leaf children, sibling order kept.
    expect(result.childTagsAfter.length).toBe(2)
    expect(result.siblingFillAfter).toBe('green')
    expect(result.leafAData).toBe(true)
    expect(result.secondLeafFill).toBe(true)
    expect(result.pointsAfterMove).toBeGreaterThanOrEqual(8)
  }, 30_000)

  it('control drag on a grouped path stays surgical; empty group stays ghost', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const vector = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="xyo-vector-explicit-group">' +
        '<path d="M0 0 C10 0 20 0 30 0 C40 0 50 0 60 0" fill="none" stroke="black"/>' +
        '<rect x="70" y="0" width="10" height="10" fill="red"/>' +
        '</g></svg>'
      const list = await paper.paperVectorObjectList(svg)
      const group = list[0] as any
      const control = (group.points as any[]).find((p) => p.kind === 'control')
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const element = vector.editableVectorUnits(doc.documentElement)[0] as Element
      const beforeKids = element.children.length
      if (control) {
        await paper.moveVectorEditablePoint(element, control.index, control.x + 4, control.y + 6)
      }
      const after = new XMLSerializer().serializeToString(doc.documentElement)
      const afterDoc = new DOMParser().parseFromString(after, 'image/svg+xml')
      const afterGroup = vector.editableVectorUnits(afterDoc.documentElement)[0] as Element
      // Empty explicit group ghost guard (DOM untouched, filtered from units).
      const emptyDoc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="xyo-vector-explicit-group"></g><rect x="1" y="1" width="2" height="2"/></svg>',
        'image/svg+xml',
      )
      const emptyUnits = vector.editableVectorUnits(emptyDoc.documentElement)
      return {
        hadControl: Boolean(control),
        groupStayed: afterGroup?.tagName.toLowerCase() === 'g',
        markerKept: (afterGroup?.getAttribute('class') ?? '').includes('xyo-vector-explicit-group'),
        childCount: afterGroup?.children.length ?? -1,
        beforeKids,
        emptyCount: emptyUnits.length,
        emptyGhostPreserved: emptyDoc.documentElement.querySelector('g.xyo-vector-explicit-group') !== null,
      }
    })
    expect(result.hadControl).toBe(true)
    expect(result.groupStayed).toBe(true)
    expect(result.markerKept).toBe(true)
    expect(result.childCount).toBe(result.beforeKids)
    expect(result.emptyCount).toBe(1)
    expect(result.emptyGhostPreserved).toBe(true)
  }, 30_000)

  it('editor: reshape a grouped pair, drag one point, undo/redo, ungroup', async () => {
    await page.getByTestId('main-tab-costumes').click()
    const surface = page.getByTestId('costume-paint-surface')
    await surface.waitFor({ state: 'visible' })
    const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
    if (await bitmapCanvas.isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    const box = await surface.boundingBox()
    if (!box) throw new Error('missing surface')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const rectTool = page.getByTestId('vector-shape-rect').last()
    await rectTool.click()
    await page.mouse.move(cx - 150, cy - 60)
    await page.mouse.down()
    await page.mouse.move(cx - 80, cy + 40, { steps: 8 })
    await page.mouse.up()
    await rectTool.click()
    await page.mouse.move(cx + 20, cy - 60)
    await page.mouse.down()
    await page.mouse.move(cx + 90, cy + 40, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(700)
    const groupBtn = page.getByRole('button', { name: 'Group' }).first()
    await groupBtn.click()
    await page.waitForTimeout(800)
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForTimeout(800)
    const handles = page.locator('[data-vector-path-point]')
    const count = await handles.count()
    expect(count).toBeGreaterThanOrEqual(8)
    const firstBox = await handles.first().boundingBox()
    if (!firstBox) throw new Error('missing handle')
    const svgBefore = await page.locator('.vector-preview').innerHTML()
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(firstBox.x + firstBox.width / 2 + 30, firstBox.y + firstBox.height / 2 + 20, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(900)
    const svgAfterMove = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterMove).not.toBe(svgBefore)
    expect(svgAfterMove.includes('xyo-vector-explicit-group')).toBe(true)
    await page.locator('button[aria-label="Undo"]:visible').click()
    await page.waitForTimeout(900)
    const svgAfterUndo = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterUndo).toBe(svgBefore)
    await page.locator('button[aria-label="Redo"]:visible').click()
    await page.waitForTimeout(900)
    const svgAfterRedo = await page.locator('.vector-preview').innerHTML()
    expect(svgAfterRedo).toBe(svgAfterMove)
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(cx + 55, cy - 10)
    await page.waitForTimeout(600)
    const ungroupBtn = page.getByRole('button', { name: 'Ungroup' }).first()
    if (await ungroupBtn.isEnabled().catch(() => false)) await ungroupBtn.click()
    await page.waitForTimeout(800)
    const svgUngrouped = await page.locator('.vector-preview').innerHTML()
    expect(svgUngrouped.includes('xyo-vector-explicit-group')).toBe(false)
  }, 180_000)
})
