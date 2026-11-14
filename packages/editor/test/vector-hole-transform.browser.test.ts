import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Permanent regression coverage for the paper-vector.ts hole fix:
// HTML-embedded SVG root misidentification (closest('svg') anchoring) +
// nonuniform-scale hole detection / double-transform regression.
//
// Real-editor hole click -> overlay under transforms, verified on real
// canvas pixels + Paper.js `contains`:
// - own nonuniform scale, own rotate, ancestor nonuniform scale,
//   ancestor rotate, and composite (ancestor scale x own rotate)
// - only the hole interior turns green; body stays red, outside stays
//   transparent, blue sibling stays blue
// - overlay transform is exactly the source own transform (no baked
//   document-space double application), ancestors/siblings untouched
// - undo removes the overlay, redo restores it (pixel-exact via preview HTML)
//
// Product code is untouched; this file only drives the real editor UI and
// inspects its real SVG + real raster output. Uses an independent port.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4451'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
const BASE_D = 'M150 90H330V270H150Z M210 150H270V210H210Z'
const SIBLING = '<rect x="40" y="250" width="60" height="60" fill="#0000ff" stroke="none"/>'
const OWN_SCALE_TX = 'scale(1.2 0.9)'
const OWN_ROTATE_TX = 'rotate(30 240 180)'
const ANCESTOR_SCALE_TX = 'scale(1.2 0.9)'
const ANCESTOR_ROTATE_TX = 'rotate(30 240 180)'

const SVG_OWN_SCALE =
  `${HEAD}<path d="${BASE_D}" fill="#ff0000" fill-rule="evenodd" stroke="none" transform="${OWN_SCALE_TX}"/>${SIBLING}</svg>`
const SVG_OWN_ROTATE =
  `${HEAD}<path d="${BASE_D}" fill="#ff0000" fill-rule="evenodd" stroke="none" transform="${OWN_ROTATE_TX}"/>${SIBLING}</svg>`
// Ancestor cases keep a single top-level <g> so `editableVectorUnits`
// unwraps to [path, rect] with the wrapper as the shared ancestor (the
// same shape as the existing nested-donut fixture). A sibling placed
// outside the <g> would make the <g> itself the selectable unit, which the
// hole probe deliberately declines as nested.
const SVG_ANCESTOR_SCALE =
  `${HEAD}<g transform="${ANCESTOR_SCALE_TX}"><path d="${BASE_D}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>${SIBLING}</g></svg>`
const SVG_ANCESTOR_ROTATE =
  `${HEAD}<g transform="${ANCESTOR_ROTATE_TX}"><path d="${BASE_D}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>${SIBLING}</g></svg>`
const SVG_COMPOSITE =
  `${HEAD}<g transform="${ANCESTOR_SCALE_TX}"><path d="${BASE_D}" fill="#ff0000" fill-rule="evenodd" stroke="none" transform="${OWN_ROTATE_TX}"/>${SIBLING}</g></svg>`

type DocPoint = { x: number; y: number }

const HOLE_OWN_SCALE: DocPoint = { x: 288, y: 162 }
const HOLE_OWN_ROTATE: DocPoint = { x: 240, y: 180 }
const HOLE_ANCESTOR_SCALE: DocPoint = { x: 288, y: 162 }
const HOLE_ANCESTOR_ROTATE: DocPoint = { x: 240, y: 180 }
const HOLE_COMPOSITE: DocPoint = { x: 288, y: 162 }
const BODY_OWN_SCALE: DocPoint = { x: 216, y: 216 }
const BODY_OWN_ROTATE: DocPoint = { x: 158, y: 202 }
const BODY_ANCESTOR_SCALE: DocPoint = { x: 216, y: 216 }
const BODY_ANCESTOR_ROTATE: DocPoint = { x: 158, y: 202 }
const BODY_COMPOSITE: DocPoint = { x: 190, y: 182 }
const OUTSIDE: DocPoint = { x: 100, y: 300 }
const SIBLING_OWN: DocPoint = { x: 70, y: 280 }
const SIBLING_ANCESTOR_SCALE: DocPoint = { x: 84, y: 252 }
const SIBLING_ANCESTOR_ROTATE: DocPoint = { x: 43, y: 182 }
const SIBLING_COMPOSITE: DocPoint = { x: 84, y: 252 }

function previewHtml() {
  return page.locator('.vector-preview').innerHTML()
}

async function openVectorCostumes() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.locator('.vector-preview').waitFor({ state: 'visible' })
}

async function uploadVectorCostume(name: string, svg: string) {
  const beforeCards = await page.getByTestId(/costume-card-\d+/).count()
  await page.getByTestId('costume-file-input').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg, 'utf8'),
  })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    beforeCards,
    { timeout: 30_000 },
  )
  await page.getByTestId(/costume-card-\d+/).last().getByRole('button', { name: /Select / }).click()
  await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible', timeout: 30_000 })
  }
}

async function fitViewport() {
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
}

async function clickDocumentPoint(x: number, y: number) {
  const box = await page.locator('[data-vector-stage-surface="true"]').boundingBox()
  if (!box) throw new Error('Missing vector stage surface')
  const clientX = box.x + (x / 480) * box.width
  const clientY = box.y + (y / 360) * box.height
  const hit = await page.evaluate(
    ({ px, py }: { px: number; py: number }) => {
      const element = document.elementFromPoint(px, py)
      if (!element) return 'none'
      return element.closest('[data-vector-stage-surface]') ? 'canvas' : element.tagName
    },
    { px: clientX, py: clientY },
  )
  if (hit !== 'canvas') throw new Error(`Document point (${x}, ${y}) is off-canvas (hits ${hit})`)
  await page.mouse.click(clientX, clientY)
}

async function selectFillTool() {
  await page.getByTestId('vector-shape-fill').last().click()
}

type HoleCase = {
  key: string
  file: string
  svg: string
  hole: DocPoint
  body: DocPoint
  sibling: DocPoint
  expectedOverlayKind: 'scale' | 'rotate' | 'none' | 'own-rotate'
  expectedAncestorKind: 'scale' | 'rotate' | null
}

const CASES: HoleCase[] = [
  {
    key: 'own nonuniform scale',
    file: 'hole-own-scale.svg',
    svg: SVG_OWN_SCALE,
    hole: HOLE_OWN_SCALE,
    body: BODY_OWN_SCALE,
    sibling: SIBLING_OWN,
    expectedOverlayKind: 'scale',
    expectedAncestorKind: null,
  },
  {
    key: 'own rotate',
    file: 'hole-own-rotate.svg',
    svg: SVG_OWN_ROTATE,
    hole: HOLE_OWN_ROTATE,
    body: BODY_OWN_ROTATE,
    sibling: SIBLING_OWN,
    expectedOverlayKind: 'rotate',
    expectedAncestorKind: null,
  },
  {
    key: 'ancestor nonuniform scale',
    file: 'hole-ancestor-scale.svg',
    svg: SVG_ANCESTOR_SCALE,
    hole: HOLE_ANCESTOR_SCALE,
    body: BODY_ANCESTOR_SCALE,
    sibling: SIBLING_ANCESTOR_SCALE,
    expectedOverlayKind: 'none',
    expectedAncestorKind: 'scale',
  },
  {
    key: 'ancestor rotate',
    file: 'hole-ancestor-rotate.svg',
    svg: SVG_ANCESTOR_ROTATE,
    hole: HOLE_ANCESTOR_ROTATE,
    body: BODY_ANCESTOR_ROTATE,
    sibling: SIBLING_ANCESTOR_ROTATE,
    expectedOverlayKind: 'none',
    expectedAncestorKind: 'rotate',
  },
  {
    key: 'composite ancestor-scale x own-rotate',
    file: 'hole-composite.svg',
    svg: SVG_COMPOSITE,
    hole: HOLE_COMPOSITE,
    body: BODY_COMPOSITE,
    sibling: SIBLING_COMPOSITE,
    expectedOverlayKind: 'own-rotate',
    expectedAncestorKind: 'scale',
  },
]

async function verifyHoleCase(caseDef: HoleCase) {
  await openVectorCostumes()
  await uploadVectorCostume(caseDef.file, caseDef.svg)
  const uploaded = await previewHtml()
  expect(uploaded).toContain('#ff0000')
  expect(uploaded).toContain('#0000ff')
  expect(uploaded).not.toContain('#00ff00')
  await fitViewport()
  await selectFillTool()
  await page.getByLabel('Paint color', { exact: true }).fill('#00ff00')
  await clickDocumentPoint(caseDef.hole.x, caseDef.hole.y)
  await page.waitForFunction(() => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    return html.includes('#00ff00') && html.includes('#ff0000')
  }, null, { timeout: 30_000 })
  const holed = await previewHtml()
  expect(holed).toContain('#00ff00')
  expect(holed).toContain('#ff0000')
  expect(holed).toContain('#0000ff')
  expect(holed).toContain('stroke="none"')

  const probe = await page.evaluate(
    ({ hole, body, outside, sibling, expectedOverlayKind, expectedAncestorKind }: {
      hole: DocPoint
      body: DocPoint
      outside: DocPoint
      sibling: DocPoint
      expectedOverlayKind: 'scale' | 'rotate' | 'none' | 'own-rotate'
      expectedAncestorKind: 'scale' | 'rotate' | null
    }) => {
      const loadImage = (svgText: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('svg-image-load-failed'))
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText)
        })
      const run = async () => {
        const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const inner = document.querySelector('.vector-preview')?.innerHTML ?? ''
        if (!inner) throw new Error('missing preview svg')
        const svgDoc = new DOMParser().parseFromString(inner, 'image/svg+xml')
        const svg = svgDoc.documentElement as unknown as Element
        if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('preview root is not svg (HTML-embedded root regression)')
        const units = (vectorSvg.editableVectorUnits as (svg: Element) => Element[])(svg)
        const green = units.filter((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#00ff00')
        if (green.length !== 1) throw new Error(`expected exactly one green overlay, got ${green.length}`)
        const overlay = green[0]!
        if (overlay.tagName.toLowerCase() !== 'path') throw new Error(`overlay must be a path sibling, got ${overlay.tagName}`)
        const reds = units.filter((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#ff0000')
        if (reds.length < 1) throw new Error('red parent missing after overlay')
        const parent = reds[0]!
        const overlayTransform = overlay.getAttribute('transform') ?? ''
        const parentOwnTransform = parent.getAttribute('transform') ?? ''
        // No double transform: the sibling overlay must reuse the source own
        // transform verbatim (baked document coords + own transform would
        // misplace it under nonuniform scale). Compare to the live parent,
        // not a hardcoded string, so sanitizer normalization cannot flake.
        if (overlayTransform !== parentOwnTransform) {
          throw new Error(`double-transform: overlay ${JSON.stringify(overlayTransform)} !== parent own ${JSON.stringify(parentOwnTransform)}`)
        }
        if (overlay.parentElement !== parent.parentElement) throw new Error('overlay must be a sibling of its parent (ancestors/siblings untouched)')
        if (expectedOverlayKind === 'scale' && !/scale\s*\(\s*1\.2\s+0\.9/.test(overlayTransform)) {
          throw new Error(`expected own scale on overlay, got ${JSON.stringify(overlayTransform)}`)
        }
        if ((expectedOverlayKind === 'rotate' || expectedOverlayKind === 'own-rotate') && !/rotate\s*\(\s*30/.test(overlayTransform)) {
          throw new Error(`expected own rotate on overlay, got ${JSON.stringify(overlayTransform)}`)
        }
        if (expectedOverlayKind === 'none' && overlayTransform !== '') {
          throw new Error(`ancestor-only overlay must carry no own transform, got ${JSON.stringify(overlayTransform)}`)
        }
        const d = overlay.getAttribute('d') ?? ''
        if (!(paperModule.isHolePathDataSafe as (s: string) => boolean)(d)) throw new Error('overlay d failed safe-subset validation')
        if ((d.match(/M/gi) ?? []).length !== 1) throw new Error('overlay must be a single hole contour')
        if (overlay.getAttribute('stroke') !== 'none') throw new Error('overlay must be fill-only (stroke none)')
        if ((overlay.getAttribute('fill') ?? '').toLowerCase() !== '#00ff00') throw new Error('overlay must carry the toolbar green')
        const blues = units.filter((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#0000ff')
        if (blues.length < 1) throw new Error('blue sibling missing after overlay')
        const siblingRect = blues[0]!
        if (
          siblingRect.getAttribute('x') !== '40' ||
          siblingRect.getAttribute('y') !== '250' ||
          siblingRect.getAttribute('width') !== '60' ||
          siblingRect.getAttribute('height') !== '60'
        ) {
          throw new Error('sibling geometry moved')
        }
        // Ancestor wrapper transform must survive verbatim (no baking/moving).
        if (expectedAncestorKind !== null) {
          const wrappers = Array.from(svg.querySelectorAll('g')) as Element[]
          if (wrappers.length < 1) throw new Error('ancestor wrapper missing after overlay')
          const ancestorTx = (parent.parentElement?.tagName.toLowerCase() === 'g' ? parent.parentElement.getAttribute('transform') ?? '' : '')
          if (expectedAncestorKind === 'scale' && !/scale\s*\(\s*1\.2\s+0\.9/.test(ancestorTx)) {
            throw new Error(`ancestor scale was moved or rebaked: ${JSON.stringify(ancestorTx)}`)
          }
          if (expectedAncestorKind === 'rotate' && !/rotate\s*\(\s*30/.test(ancestorTx)) {
            throw new Error(`ancestor rotate was moved or rebaked: ${JSON.stringify(ancestorTx)}`)
          }
        }
        // Use document-space bounds (ancestor-aware) for placement checks.
        const overlayBounds = (vectorSvg.vectorObjectBounds as (e: Element) => { x: number; y: number; width: number; height: number })(overlay)
        const parentBoundsOf = (vectorSvg.vectorObjectBounds as (e: Element) => { x: number; y: number; width: number; height: number })(parent)
        // Real raster pixels from the editor's own SVG string.
        const W = 480
        const H = 360
        const img = await loadImage(inner)
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.clearRect(0, 0, W, H)
        // The preview svg is 480x360 viewBox so document coords map 1:1.
        ctx.drawImage(img, 0, 0, W, H)
        const at = (p: DocPoint) => {
          const x = Math.max(0, Math.min(W - 1, Math.round(p.x)))
          const y = Math.max(0, Math.min(H - 1, Math.round(p.y)))
          return Array.from(ctx.getImageData(x, y, 1, 1).data)
        }
        return {
          overlayTransform,
          overlayDLength: d.length,
          overlayBounds,
          parentBounds: parentBoundsOf,
          holePx: at(hole),
          bodyPx: at(body),
          outsidePx: at(outside),
          siblingPx: at(sibling),
          unitCount: units.length,
        }
      }
      return run()
    },
    {
      hole: caseDef.hole,
      body: caseDef.body,
      outside: OUTSIDE,
      sibling: caseDef.sibling,
      expectedOverlayKind: caseDef.expectedOverlayKind,
      expectedAncestorKind: caseDef.expectedAncestorKind,
    },
  )

  // No double transform: overlay document bounds must sit on the hole point
  // and must not swallow the body point.
  expect(probe.overlayBounds.x).toBeLessThanOrEqual(caseDef.hole.x)
  expect(probe.overlayBounds.x + probe.overlayBounds.width).toBeGreaterThanOrEqual(caseDef.hole.x)
  expect(probe.overlayBounds.y).toBeLessThanOrEqual(caseDef.hole.y)
  expect(probe.overlayBounds.y + probe.overlayBounds.height).toBeGreaterThanOrEqual(caseDef.hole.y)
  const holeInsideOverlay =
    caseDef.hole.x >= probe.overlayBounds.x &&
    caseDef.hole.x <= probe.overlayBounds.x + probe.overlayBounds.width &&
    caseDef.hole.y >= probe.overlayBounds.y &&
    caseDef.hole.y <= probe.overlayBounds.y + probe.overlayBounds.height
  expect(holeInsideOverlay).toBe(true)
  const bodyInsideOverlay =
    caseDef.body.x >= probe.overlayBounds.x &&
    caseDef.body.x <= probe.overlayBounds.x + probe.overlayBounds.width &&
    caseDef.body.y >= probe.overlayBounds.y &&
    caseDef.body.y <= probe.overlayBounds.y + probe.overlayBounds.height
  expect(bodyInsideOverlay).toBe(false)

  // Real canvas pixels: hole green, body red, outside transparent, sibling blue.
  const isGreen = (px: number[]) => px[0]! < 100 && px[1]! > 200 && px[2]! < 100 && px[3]! > 200
  const isRed = (px: number[]) => px[0]! > 200 && px[1]! < 100 && px[2]! < 100 && px[3]! > 200
  const isBlue = (px: number[]) => px[0]! < 100 && px[1]! < 100 && px[2]! > 200 && px[3]! > 200
  expect(isGreen(probe.holePx)).toBe(true)
  expect(isRed(probe.bodyPx)).toBe(true)
  expect(probe.outsidePx[3]).toBeLessThan(20)
  expect(isBlue(probe.siblingPx)).toBe(true)

  // Paper.js contains on the real overlay geometry (baked, no double apply).
  const contains = await page.evaluate(
    ({ hole, body, outside }: { hole: DocPoint; body: DocPoint; outside: DocPoint }) => {
      const run = async () => {
        const w = window as unknown as { __holeContainsCache?: unknown }
        void w
        const svgEl = document.querySelector('.vector-preview svg')
        if (!svgEl) throw new Error('missing live svg')
        // Reuse the editor's own Paper scope through the vector module.
        const paperModule = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const vectorSvg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const sanitize = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
        const units = (vectorSvg.editableVectorUnits as (svg: Element) => Element[])(svgEl as unknown as Element)
        const overlay = units.find((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#00ff00')!
        const parent = units.find((u) => (u.getAttribute('fill') ?? '').toLowerCase() === '#ff0000')!
        if (!overlay || !parent) throw new Error('overlay/parent missing for contains')
        const scope = await (paperModule.ensureVectorPaperScope as () => Promise<paper.PaperScope>)()
        const toItem = (unit: Element) => {
          const root = unit.closest('svg')!
          const baked = (vectorSvg.bakedUnitClone as (svg: Element, unit: Element) => Element | undefined)(root, unit)
          const source = baked ?? unit
          const serialized = new XMLSerializer().serializeToString(source)
          const fragment = (sanitize.sanitizeSvgFragmentForPaperImport as (s: string) => string)(serialized)
          const item = (scope.project as unknown as { importSVG: (s: string, o?: { insert?: boolean }) => paper.Item }).importSVG(fragment, {
            insert: false,
          }) as unknown as { contains?: (p: unknown) => boolean; remove: () => void }
          return item
        }
        const overlayItem = toItem(overlay)
        const parentItem = toItem(parent)
        try {
          const pt = (p: DocPoint) => new scope.Point(p.x, p.y)
          const overlayContainsHole =
            typeof overlayItem.contains === 'function' ? Boolean(overlayItem.contains(pt(hole))) : false
          const overlayContainsBody =
            typeof overlayItem.contains === 'function' ? Boolean(overlayItem.contains(pt(body))) : true
          const overlayContainsOutside =
            typeof overlayItem.contains === 'function' ? Boolean(overlayItem.contains(pt(outside))) : true
          const parentContainsBody =
            typeof parentItem.contains === 'function' ? Boolean(parentItem.contains(pt(body))) : false
          const parentContainsHole =
            typeof parentItem.contains === 'function' ? Boolean(parentItem.contains(pt(hole))) : true
          return { overlayContainsHole, overlayContainsBody, overlayContainsOutside, parentContainsBody, parentContainsHole }
        } finally {
          try {
            overlayItem.remove()
          } catch {}
          try {
            parentItem.remove()
          } catch {}
        }
      }
      return run()
    },
    { hole: caseDef.hole, body: caseDef.body, outside: OUTSIDE },
  )
  expect(contains.overlayContainsHole).toBe(true)
  expect(contains.overlayContainsBody).toBe(false)
  expect(contains.overlayContainsOutside).toBe(false)
  expect(contains.parentContainsBody).toBe(true)
  expect(contains.parentContainsHole).toBe(false)

  // Undo removes the overlay; redo restores the exact holed pixels.
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML === prev, uploaded, {
    timeout: 30_000,
  })
  expect(await previewHtml()).toBe(uploaded)
  await page.getByRole('button', { name: 'Redo' }).click()
  await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML === prev, holed, {
    timeout: 30_000,
  })
  expect(await previewHtml()).toBe(holed)
  // Pixel-exact after redo: hole still green.
  const afterRedoHole = await page.evaluate(({ hole }: { hole: DocPoint }) => {
    const run = async () => {
      const inner = document.querySelector('.vector-preview')?.innerHTML ?? ''
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('svg-image-load-failed'))
        el.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(inner)
      })
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 360
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.clearRect(0, 0, 480, 360)
      ctx.drawImage(img, 0, 0, 480, 360)
      return Array.from(ctx.getImageData(Math.round(hole.x), Math.round(hole.y), 1, 1).data)
    }
    return run()
  }, { hole: caseDef.hole })
  expect(afterRedoHole[1]).toBeGreaterThan(200)
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction((prev: string) => document.querySelector('.vector-preview')?.innerHTML === prev, uploaded, {
    timeout: 30_000,
  })
  expect(await previewHtml()).toBe(uploaded)
}

describe('vector hole overlay under transforms in the real editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4451', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
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
    browser = await launchBrowser({
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  for (const caseDef of CASES) {
    it(`fills only the hole with ${caseDef.key} (pixels/contains, no double transform, undo/redo)`, async () => {
      await verifyHoleCase(caseDef)
    }, 180_000)
  }
})
