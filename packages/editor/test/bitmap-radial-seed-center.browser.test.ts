import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-editor pixel coverage for the bitmap fill radial seed-center wiring
// (`bitmapPaintStyle` + `resolveBitmapFillRadialGeometry` + `applyBitmapFill`).
//
// Setup per test (fresh page state): two disconnected white chambers
// (A: 360,320,70,80 / B: 440,320,70,80) split by a black wall
// (430,320,10,80), a green guard rect outside (580,360,6,6), transparent
// background elsewhere, plus a committed brush dot at (200,500) so Undo/Redo
// has a settled baseline that includes the artwork (evaluate painting alone
// never touches the VM asset store).
//
// Same radial setting (red #ff0000 -> blue #0000ff) paints both chambers, so
// pixel differences come only from the seed position / mask bounds:
//  1. different seeds in chamber A move the highlight (distance-from-seed
//     ramp + cross-seed comparison at identical probes),
//  2. Shift-click paints the disconnected global mask with a wider radius,
//  3. a transparent secondary end fades only opacity (no black/blue swing).
// Every scenario also checks Undo/Redo round-trips and outside-region
// protection (black wall, green guard, far transparent pixel, brush anchor,
// and the untouched chamber for plain clicks) on the live
// `bitmap-editor-canvas`. Failures throw with the concrete pixel arrays and
// the reason instead of being swallowed.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4395'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

const CH_A = { x: 360, y: 320, w: 70, h: 80 }
const WALL = { x: 430, y: 320, w: 10, h: 80 }
const CH_B = { x: 440, y: 320, w: 70, h: 80 }
const SEED_LEFT = { x: 365, y: 360 }
const SEED_RIGHT = { x: 425, y: 360 }
const PROBE_LEFT = { x: 370, y: 360 }
const PROBE_RIGHT = { x: 420, y: 360 }
const PROBE_MID = { x: 385, y: 360 }
const PROBE_B = { x: 475, y: 360 }
const GUARD_GREEN = { x: 582, y: 362 }
const ANCHOR = { x: 200, y: 500 }

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas bounding box')
  const size = await canvasSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function pixel(x: number, y: number): Promise<number[]> {
  return await page.evaluate(([px, py]) => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])
}

async function waitForStatus(text: string) {
  await page.waitForFunction(
    (want) => document.body.textContent?.includes(want as string) ?? false,
    text as unknown as undefined,
    { timeout: 15_000 },
  )
}

async function waitForPixelMatch(
  x: number,
  y: number,
  predicate: (p: number[]) => boolean,
  description: string,
  timeout = 15_000,
): Promise<number[]> {
  const start = Date.now()
  let last: number[] = []
  while (Date.now() - start < timeout) {
    last = await pixel(x, y)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timeout waiting for ${description} at (${x},${y}): last pixel ${fmt(last)}`)
}

async function clickCanvas(x: number, y: number, shift = false) {
  const point = await toScreen(x, y)
  if (shift) await page.keyboard.down('Shift')
  try {
    await page.mouse.click(point.x, point.y)
  } finally {
    if (shift) await page.keyboard.up('Shift')
  }
}

function fmt(p: number[]): string {
  return `[${p.join(',')}]`
}

async function openBitmapEditor() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'ビットマップに変換' }).click()
  await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
  for (let i = 0; i < 10; i += 1) await zoomOut.click()
  await page.waitForFunction(() => {
    const label = document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? ''
    return label.includes('25%')
  }, null, { timeout: 10_000 })
}

async function paintSetupArtwork(): Promise<{ anchorRgb: number[] }> {
  await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const context = target.getContext('2d')!
    context.clearRect(0, 0, target.width, target.height)
    context.fillStyle = '#ffffff'
    context.fillRect(360, 320, 70, 80)
    context.fillRect(440, 320, 70, 80)
    context.fillStyle = '#000000'
    context.fillRect(430, 320, 10, 80)
    context.fillStyle = '#00ff00'
    context.fillRect(580, 360, 6, 6)
  })
  // Commit the evaluate-painted artwork into the VM asset + history with a
  // real brush dot far away from the chambers (solid mode so the dot is the
  // plain fill color, independent of later radial settings).
  await page.getByTestId('bitmap-tool-brush').click()
  await page.getByLabel('Bitmap paint style').selectOption('solid')
  const fillTransparent = page.getByRole('button', { name: 'Transparent fill' })
  if ((await fillTransparent.getAttribute('aria-pressed')) === 'true') await fillTransparent.click()
  const anchorHex = await page.getByLabel('Paint color', { exact: true }).inputValue()
  const anchorRgb = [0, 1, 2].map((i) => parseInt(anchorHex.slice(1 + i * 2, 3 + i * 2), 16))
  const anchor = await toScreen(ANCHOR.x, ANCHOR.y)
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.down()
  await page.mouse.up()
  await waitForStatus('Bitmap edit saved')
  const gotAnchor = await pixel(ANCHOR.x, ANCHOR.y)
  if (gotAnchor[3] !== 255) {
    throw new Error(`setup brush dot at ${fmt([ANCHOR.x, ANCHOR.y])} is not opaque: got ${fmt(gotAnchor)} (want alpha 255, rgb ~${anchorRgb.join(',')})`)
  }
  // Precondition: chambers are white, wall black, guard green, far pixel clear.
  const pre = {
    a: await pixel(395, 360),
    b: await pixel(PROBE_B.x, PROBE_B.y),
    wall: await pixel(435, 360),
    guard: await pixel(GUARD_GREEN.x, GUARD_GREEN.y),
    far: await pixel(0, 0),
  }
  const isWhite = (p: number[]) => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255
  if (!isWhite(pre.a)) throw new Error(`setup chamber A not white at (395,360): got ${fmt(pre.a)}`)
  if (!isWhite(pre.b)) throw new Error(`setup chamber B not white at (475,360): got ${fmt(pre.b)}`)
  if (pre.wall.join(',') !== '0,0,0,255') throw new Error(`setup wall not black at (435,360): got ${fmt(pre.wall)}`)
  if (pre.guard.join(',') !== '0,255,0,255') throw new Error(`setup green guard damaged at (582,362): got ${fmt(pre.guard)}`)
  if (pre.far.join(',') !== '0,0,0,0') throw new Error(`setup far background not transparent at (0,0): got ${fmt(pre.far)}`)
  return { anchorRgb }
}

async function setRadialRedBlue() {
  await page.getByTestId('bitmap-tool-fill').click()
  await page.getByLabel('Bitmap paint style').selectOption('radial')
  await page.getByLabel('Paint color', { exact: true }).fill('#ff0000')
  await page.getByLabel('Secondary paint color').fill('#0000ff')
  const fillT = page.getByRole('button', { name: 'Transparent fill' })
  if ((await fillT.getAttribute('aria-pressed')) === 'true') await fillT.click()
  const secondaryT = page.getByRole('button', { name: 'Transparent secondary' })
  await secondaryT.waitFor({ state: 'visible' })
  if ((await secondaryT.getAttribute('aria-pressed')) === 'true') await secondaryT.click()
}

async function undoAndExpectWhite(probePoints: Array<{ x: number; y: number; name: string }>) {
  await page.getByRole('button', { name: 'Undo' }).click()
  await waitForStatus('Asset undo')
  for (const probe of probePoints) {
    const got = await waitForPixelMatch(
      probe.x,
      probe.y,
      (g) => g[0] === 255 && g[1] === 255 && g[2] === 255 && g[3] === 255,
      `white restore (${probe.name})`,
    )
    if (!(got[0] === 255 && got[1] === 255 && got[2] === 255 && got[3] === 255)) {
      throw new Error(`Undo did not restore white at ${probe.name} (${probe.x},${probe.y}): got ${fmt(got)}`)
    }
  }
}

function isOpaque(p: number[]): boolean {
  return (p[3] ?? 0) >= 240
}

describe('bitmap radial fill seed center on the real editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4395', '--strictPort'], {
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
    if (!ready) throw new Error('Vite failed to start on :4395')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('moves the highlight with the seed: same radial colors, different seeds paint different distance ramps', async () => {
    await openBitmapEditor()
    const { anchorRgb } = await paintSetupArtwork()
    await setRadialRedBlue()

    // Fill A from the left seed.
    await clickCanvas(SEED_LEFT.x, SEED_LEFT.y)
    await waitForStatus('Bitmap fill saved')
    const leftSeedLeft = await pixel(PROBE_LEFT.x, PROBE_LEFT.y)
    const leftSeedRight = await pixel(PROBE_RIGHT.x, PROBE_RIGHT.y)
    const leftSeedWall = await pixel(435, 360)
    const leftSeedB = await pixel(PROBE_B.x, PROBE_B.y)
    const leftSeedGuard = await pixel(GUARD_GREEN.x, GUARD_GREEN.y)
    const leftSeedFar = await pixel(0, 0)
    const leftSeedAnchor = await pixel(ANCHOR.x, ANCHOR.y)

    // Distance ramp: the seed-side probe must be red-dominant, the far-side
    // probe blue-dominant (radius = max(70,80)/2 = 40, far probe is ~55px away
    // so it lands on the blue end). Gradient compositing can leave alpha at
    // 250 (not exactly 255), so opaque means >= 240.
    if (!(leftSeedLeft[0]! > leftSeedLeft[2]! && leftSeedLeft[0]! > 120 && isOpaque(leftSeedLeft))) {
      throw new Error(`left-seed fill: near-seed probe (370,360) is not red-dominant: got ${fmt(leftSeedLeft)} (seed 365,360, radius 40)`)
    }
    if (!(leftSeedRight[2]! > leftSeedRight[0]! && isOpaque(leftSeedRight))) {
      throw new Error(`left-seed fill: far probe (420,360) is not blue-dominant: got ${fmt(leftSeedRight)} (seed 365,360, distance ~55 > radius 40); near probe was ${fmt(leftSeedLeft)}`)
    }
    // Untouched chamber + outside protection for the plain click.
    if (leftSeedB.join(',') !== '255,255,255,255') throw new Error(`plain left-seed fill leaked into chamber B: got ${fmt(leftSeedB)} at (475,360), want white`)
    if (leftSeedWall.join(',') !== '0,0,0,255') throw new Error(`plain left-seed fill damaged the black wall: got ${fmt(leftSeedWall)} at (435,360)`)
    if (leftSeedGuard.join(',') !== '0,255,0,255') throw new Error(`plain left-seed fill damaged the green guard: got ${fmt(leftSeedGuard)}`)
    if (leftSeedFar.join(',') !== '0,0,0,0') throw new Error(`plain left-seed fill leaked outside the region: got ${fmt(leftSeedFar)} at (0,0)`)
    if (leftSeedAnchor[3] !== 255 || Math.abs(leftSeedAnchor[0]! - anchorRgb[0]!) > 8) {
      throw new Error(`plain left-seed fill moved the anchor dot: got ${fmt(leftSeedAnchor)}, setup rgb ${anchorRgb.join(',')}`)
    }

    // Undo restores chamber A to white, redo repaints the identical ramp.
    await undoAndExpectWhite([{ x: 395, y: 360, name: 'chamber A' }])
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    const redoLeft = await waitForPixelMatch(
      PROBE_LEFT.x,
      PROBE_LEFT.y,
      (g) => g[0]! > g[2]! && g[0]! > 120 && isOpaque(g),
      'red-dominant redo ramp',
    )
    for (let i = 0; i < 4; i += 1) {
      if (Math.abs(redoLeft[i]! - leftSeedLeft[i]!) > 8) {
        throw new Error(`Redo mismatch at (370,360): first ${fmt(leftSeedLeft)} vs redo ${fmt(redoLeft)}`)
      }
    }
    // Back to the white baseline for the second seed.
    await undoAndExpectWhite([{ x: 395, y: 360, name: 'chamber A' }])

    // Same colors, other seed: highlight follows the click.
    await clickCanvas(SEED_RIGHT.x, SEED_RIGHT.y)
    await waitForStatus('Bitmap fill saved')
    const rightSeedLeft = await pixel(PROBE_LEFT.x, PROBE_LEFT.y)
    const rightSeedRight = await pixel(PROBE_RIGHT.x, PROBE_RIGHT.y)
    if (!(rightSeedRight[0]! > rightSeedRight[2]! && rightSeedRight[0]! > 120 && isOpaque(rightSeedRight))) {
      throw new Error(`right-seed fill: near-seed probe (420,360) is not red-dominant: got ${fmt(rightSeedRight)} (seed 425,360)`)
    }
    if (!(rightSeedLeft[2]! > rightSeedLeft[0]! && isOpaque(rightSeedLeft))) {
      throw new Error(`right-seed fill: far probe (370,360) is not blue-dominant: got ${fmt(rightSeedLeft)} (seed 425,360); near probe was ${fmt(rightSeedRight)}`)
    }
    // Click movement must be visible at identical pixels: the same probe is
    // red under its own seed and blue under the opposite seed.
    const dLeftR = Math.abs(leftSeedLeft[0]! - rightSeedLeft[0]!)
    const dLeftB = Math.abs(leftSeedLeft[2]! - rightSeedLeft[2]!)
    const dRightR = Math.abs(leftSeedRight[0]! - rightSeedRight[0]!)
    if (Math.max(dLeftR, dLeftB) < 60) {
      throw new Error(`seed move invisible at (370,360): left-seed ${fmt(leftSeedLeft)} vs right-seed ${fmt(rightSeedLeft)} (need >=60 channel swing)`)
    }
    if (Math.max(dRightR, Math.abs(leftSeedRight[2]! - rightSeedRight[2]!)) < 60) {
      throw new Error(`seed move invisible at (420,360): left-seed ${fmt(leftSeedRight)} vs right-seed ${fmt(rightSeedRight)} (need >=60 channel swing)`)
    }
    expect(dLeftR).toBeGreaterThanOrEqual(40)
  }, 180_000)

  it('shift-click paints the disconnected global mask with a wider radius and keeps guards', async () => {
    await openBitmapEditor()
    await paintSetupArtwork()
    await setRadialRedBlue()

    // Plain click first: only chamber A paints.
    await clickCanvas(SEED_LEFT.x, SEED_LEFT.y)
    await waitForStatus('Bitmap fill saved')
    const plainA = await pixel(PROBE_RIGHT.x, PROBE_RIGHT.y)
    const plainB = await pixel(PROBE_B.x, PROBE_B.y)
    if (plainB.join(',') !== '255,255,255,255') {
      throw new Error(`plain fill should leave chamber B white: got ${fmt(plainB)} at (475,360); chamber A right probe ${fmt(plainA)}`)
    }
    await undoAndExpectWhite([
      { x: 395, y: 360, name: 'chamber A' },
      { x: PROBE_B.x, y: PROBE_B.y, name: 'chamber B' },
    ])

    // Shift-click the same seed: both disconnected white chambers paint.
    await clickCanvas(SEED_LEFT.x, SEED_LEFT.y, true)
    await waitForStatus('Bitmap fill saved')
    const shiftA = await pixel(PROBE_RIGHT.x, PROBE_RIGHT.y)
    const shiftB = await pixel(PROBE_B.x, PROBE_B.y)
    const shiftWall = await pixel(435, 360)
    const shiftGuard = await pixel(GUARD_GREEN.x, GUARD_GREEN.y)
    const shiftFar = await pixel(0, 0)
    // Chamber B changed from white to a blue-leaning gradient pixel.
    if (shiftB.join(',') === '255,255,255,255') {
      throw new Error(`shift fill did not reach disconnected chamber B: still white at (475,360); chamber A probe ${fmt(shiftA)}`)
    }
    if (!(isOpaque(shiftB) && shiftB[2]! > shiftB[0]!)) {
      throw new Error(`shift fill chamber B pixel is not the blue end of the red->blue ramp: got ${fmt(shiftB)} at (475,360, distance ~110 from seed, global radius 75)`)
    }
    // Same seed, wider global radius (150x80 -> 75 vs 40): chamber A paints
    // a different mix at the identical probe.
    const shiftDelta = Math.max(Math.abs(shiftA[0]! - plainA[0]!), Math.abs(shiftA[2]! - plainA[2]!))
    if (shiftDelta < 20) {
      throw new Error(`shift global radius invisible in chamber A at (420,360): plain ${fmt(plainA)} vs shift ${fmt(shiftA)} (need >=20; plain radius 40, global radius 75)`)
    }
    // Outside-region protection.
    if (shiftWall.join(',') !== '0,0,0,255') throw new Error(`shift fill damaged the black wall: got ${fmt(shiftWall)}`)
    if (shiftGuard.join(',') !== '0,255,0,255') throw new Error(`shift fill damaged the green guard: got ${fmt(shiftGuard)}`)
    if (shiftFar.join(',') !== '0,0,0,0') throw new Error(`shift fill leaked outside: got ${fmt(shiftFar)} at (0,0)`)
    expect(shiftDelta).toBeGreaterThanOrEqual(20)

    // Undo restores both chambers to white; redo repaints both.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    const undoA = await waitForPixelMatch(
      395,
      360,
      (g) => g[0] === 255 && g[1] === 255 && g[2] === 255 && g[3] === 255,
      'white restore chamber A',
    )
    const undoB = await pixel(PROBE_B.x, PROBE_B.y)
    if (undoA.join(',') !== '255,255,255,255') throw new Error(`shift Undo did not restore chamber A: got ${fmt(undoA)}`)
    if (undoB.join(',') !== '255,255,255,255') throw new Error(`shift Undo did not restore chamber B: got ${fmt(undoB)}`)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    const redoB = await waitForPixelMatch(
      PROBE_B.x,
      PROBE_B.y,
      (g) => !(g[0] === 255 && g[1] === 255 && g[2] === 255 && g[3] === 255),
      'repainted chamber B',
    )
    if (redoB.join(',') === '255,255,255,255') throw new Error(`shift Redo did not repaint chamber B (still white); chamber A shift was ${fmt(shiftA)}`)
  }, 180_000)

  it('transparent secondary end fades only opacity on the real radial fill, with undo/redo and guard protection', async () => {
    await openBitmapEditor()
    await paintSetupArtwork()
    await setRadialRedBlue()
    const secondaryT = page.getByRole('button', { name: 'Transparent secondary' })
    await secondaryT.click()
    expect(await secondaryT.getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByLabel('Secondary paint color').inputValue()).toBe('#0000ff')

    await clickCanvas(SEED_LEFT.x, SEED_LEFT.y)
    await waitForStatus('Bitmap fill saved')
    const seedPx = await pixel(SEED_LEFT.x, SEED_LEFT.y)
    const midPx = await pixel(PROBE_MID.x, PROBE_MID.y)
    const wall = await pixel(435, 360)
    const guard = await pixel(GUARD_GREEN.x, GUARD_GREEN.y)
    const far = await pixel(0, 0)
    const otherChamber = await pixel(PROBE_B.x, PROBE_B.y)
    // Seed stays opaque red (alpha >= 240: compositing can leave 250).
    if (!(seedPx[0]! > 150 && seedPx[1]! < 120 && seedPx[2]! < 120 && isOpaque(seedPx))) {
      throw new Error(`transparent-end fill: seed pixel not opaque red at (365,360): got ${fmt(seedPx)}`)
    }
    // Mid ramp keeps red RGB while alpha fades (surviving-RGB stop, never
    // through black/blue): alpha strictly partial, red high, blue low.
    if (!(midPx[3]! > 30 && midPx[3]! < 225)) {
      throw new Error(`transparent-end fill: mid pixel alpha did not fade at (385,360, distance ~20/40): got ${fmt(midPx)}; seed was ${fmt(seedPx)}`)
    }
    if (!(midPx[0]! > 150 && midPx[2]! < 120)) {
      throw new Error(`transparent-end fill: mid pixel swung through black/blue at (385,360): got ${fmt(midPx)} (want red RGB preserved, blue < 120); seed was ${fmt(seedPx)}`)
    }
    // Plain click: other chamber stays white; guards untouched.
    if (otherChamber.join(',') !== '255,255,255,255') throw new Error(`transparent fill leaked into chamber B: got ${fmt(otherChamber)}`)
    if (wall.join(',') !== '0,0,0,255') throw new Error(`transparent fill damaged the black wall: got ${fmt(wall)}`)
    if (guard.join(',') !== '0,255,0,255') throw new Error(`transparent fill damaged the green guard: got ${fmt(guard)}`)
    if (far.join(',') !== '0,0,0,0') throw new Error(`transparent fill leaked outside: got ${fmt(far)} at (0,0)`)

    // Undo erases the translucent ramp back to white; redo restores it.
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForStatus('Asset undo')
    const undoMid = await waitForPixelMatch(
      PROBE_MID.x,
      PROBE_MID.y,
      (g) => g[0] === 255 && g[1] === 255 && g[2] === 255 && g[3] === 255,
      'white restore mid',
    )
    if (undoMid.join(',') !== '255,255,255,255') throw new Error(`transparent Undo did not restore white at (385,360): got ${fmt(undoMid)}`)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForStatus('Asset redo')
    const redoMid = await waitForPixelMatch(
      PROBE_MID.x,
      PROBE_MID.y,
      (g) => g[3]! > 30 && g[3]! < 225,
      'faded ramp redo',
    )
    if (!(redoMid[3]! > 30 && redoMid[3]! < 225 && redoMid[0]! > 150)) {
      throw new Error(`transparent Redo did not restore the faded ramp at (385,360): got ${fmt(redoMid)} (first paint mid ${fmt(midPx)})`)
    }
    // Untoggling keeps the stored blue hex (no reset to a default).
    await secondaryT.click()
    expect(await secondaryT.getAttribute('aria-pressed')).toBe('false')
    expect(await page.getByLabel('Secondary paint color').inputValue()).toBe('#0000ff')
  }, 180_000)
})
