/**
 * Stage PNG import reference audit (product fix verification, real Editor only).
 *
 * Regression: stage library PNG 960x720 res2 center 480,360 was forced to
 * res1 center 240,180, showing only the top-left quarter on stage.
 * Fix: respect Scratch library JSON item metadata (resolution/center);
 * file uploads follow honke file-uploader/load-costume (image actual size,
 * res2, center = w/2,h/2); SVG keeps existing behavior.
 *
 * Verifies in the real Editor (no synthetic canvas):
 * - Arctic library backdrop: meta res2 480,360, 960x720 edit canvas, opaque
 *   stage corners, Undo/mode-conversion smoke, SB3 save->reload persistence.
 * - Arbitrary 960x720 quadrant PNG file upload to stage: 4-corner stage
 *   pixels (red/green/blue/yellow), meta res2 w/2,h/2, edit canvas, Undo,
 *   bitmap<->vector round-trip, save->reload.
 * - 480x360 quadrant PNG file upload to stage: honke centered-quarter
 *   (white corners, quadrant colors inside), meta res2 w/2,h/2.
 * - Sprite PNG upload, SVG defaults, transparent PNG, JPEG (non-PNG),
 *   UTF8 filename, invalid-bytes non-destructive error reporting.
 *
 * Dedicated Vite port 4492.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4492
const base = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

// --- minimal PNG builder (opaque quadrants + transparent) -------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

function buildPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlibSync(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function quadrantPixel(w: number, h: number): (x: number, y: number) => [number, number, number, number] {
  return (x, y) => {
    const left = x < w / 2
    const top = y < h / 2
    if (left && top) return [255, 0, 0, 255]
    if (!left && top) return [0, 255, 0, 255]
    if (left && !top) return [0, 0, 255, 255]
    return [255, 255, 0, 255]
  }
}

// --- page helpers ------------------------------------------------------------

async function openCostumes(): Promise<void> {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('main-tab-costumes').click({ timeout: 120_000 })
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 120_000 })
}

async function snapshot(): Promise<any> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
    return w.__hikkakuEditorTest?.snapshot()
  })
}

async function editorStatus(): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
    return w.__hikkakuEditorTest?.status() ?? ''
  })
}

async function selectTargetByName(name: string): Promise<void> {
  const snap = await snapshot()
  const target = snap.project.targets.find((x: any) => x.name === name)
  if (!target) throw new Error(`target ${name} missing`)
  if (target.isStage) {
    await page.getByTestId('target-card-stage').click()
  } else {
    await page.getByTestId(`target-card-${name}`).click()
  }
  await page.waitForFunction(
    (want: string) => {
      const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
      const s = w.__hikkakuEditorTest?.snapshot()
      const t = s?.project?.targets?.find((x: any) => x.name === want)
      return (s?.selectedTargetId === (t?.id ?? want) || s?.selectedTargetId === want) ?? false
    },
    name as unknown as undefined,
    { timeout: 30_000 },
  )
}

async function currentCostumeInfo(): Promise<{ index: number; costume: any; isStage: boolean; targetName: string }> {
  const snap = await snapshot()
  const sel = snap.selectedTargetId
  const target = snap.project.targets.find((x: any) => (x.id ?? x.name) === sel || x.name === sel)
  const index = target.currentCostume ?? 0
  return { index, costume: target.costumes[index], isStage: Boolean(target.isStage), targetName: target.name }
}

async function costumeCount(): Promise<number> {
  return await page.getByTestId(/costume-card-\d+/).count()
}

async function uploadCostumeFile(name: string, mimeType: string, buffer: Buffer | Uint8Array): Promise<void> {
  const before = await costumeCount()
  await page.getByTestId('costume-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) })
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
    before as unknown as undefined,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(800)
}

async function selectCostumeCard(index: number): Promise<void> {
  await page.getByTestId(/costume-card-\d+/).nth(index).getByRole('button', { name: /Select / }).click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
}

async function bitmapCanvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const c = document.querySelector('[data-testid="bitmap-editor-canvas"]') as HTMLCanvasElement | null
    if (!c) throw new Error('no bitmap canvas')
    return { width: c.width, height: c.height }
  })
}

type StageSample = { r: number; g: number; b: number; a: number }

async function stageSamples(points: Array<{ rx: number; ry: number }>): Promise<StageSample[]> {
  const png = await page.getByTestId('stage-canvas').screenshot({ type: 'png', timeout: 15_000 })
  const b64 = (png as Buffer).toString('base64')
  return await page.evaluate(
    ({ data, pts }: { data: string; pts: Array<{ rx: number; ry: number }> }) => {
      return new Promise<Array<{ r: number; g: number; b: number; a: number }>>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d')
            if (!ctx) {
              reject(new Error('no ctx'))
              return
            }
            ctx.drawImage(img, 0, 0)
            const out = pts.map((p) => {
              const x = Math.max(0, Math.min(c.width - 1, Math.round(p.rx * (c.width - 1))))
              const y = Math.max(0, Math.min(c.height - 1, Math.round(p.ry * (c.height - 1))))
              const d = ctx.getImageData(x, y, 1, 1).data
              return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: d[3] ?? 0 }
            })
            resolve(out)
          } catch (e) {
            reject(e)
          }
        }
        img.onerror = () => reject(new Error('stage screenshot decode failed'))
        img.src = `data:image/png;base64,${data}`
      })
    },
    { data: b64, pts: points } as unknown as undefined,
  )
}

async function waitStageSettled(timeout = 25_000): Promise<void> {
  const start = Date.now()
  let prev: string | undefined
  let stable = 0
  for (;;) {
    const png = await page.getByTestId('stage-canvas').screenshot({ type: 'png', timeout: 15_000 })
    const hash = createHash('md5').update(png).digest('hex')
    if (prev === hash) {
      stable += 1
      if (stable >= 2) return
    } else {
      stable = 0
    }
    prev = hash
    if (Date.now() - start > timeout) throw new Error('stage never settled')
    await new Promise((r) => setTimeout(r, 700))
  }
}

const isRed = (s: StageSample) => s.a > 128 && s.r > 200 && s.g < 100 && s.b < 100
const isGreen = (s: StageSample) => s.a > 128 && s.g > 150 && s.r < 120 && s.b < 120
const isBlue = (s: StageSample) => s.a > 128 && s.b > 150 && s.r < 120 && s.g < 120
const isYellow = (s: StageSample) => s.a > 128 && s.r > 200 && s.g > 200 && s.b < 100
const isWhite = (s: StageSample) => s.a > 128 && s.r > 240 && s.g > 240 && s.b > 240

describe('stage PNG import reference audit (real Editor)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 120; i += 1) {
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
    const ctxPage = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    page = ctxPage
    await openCostumes()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('Arctic library backdrop keeps res2 480,360 with opaque full-stage cover', async () => {
    await selectTargetByName('Stage')
    const before = await costumeCount()
    await page.getByTestId('open-backdrop-library').click()
    await page.getByPlaceholder('Search names or tags').fill('Arctic')
    await page.getByTestId('library-item-Arctic').click()
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[data-testid^="costume-card-"]').length > count,
      before as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(800)
    const info = await currentCostumeInfo()
    // Library selection does not auto-switch current costume; select the new card.
    await selectCostumeCard((await costumeCount()) - 1)
    const added = await currentCostumeInfo()
    expect(added.isStage).toBe(true)
    expect(added.costume.dataFormat).toBe('png')
    expect(added.costume.bitmapResolution).toBe(2)
    expect(added.costume.rotationCenterX).toBe(480)
    expect(added.costume.rotationCenterY).toBe(360)
    expect(info.targetName).toBe('Stage')
    // Edit canvas is the res2 artboard (960x720), not the forced res1 480x360.
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await bitmapCanvasSize()).toEqual({ width: 960, height: 720 })
    // Full-stage cover: all four corners opaque (Arctic photo fills 480x360).
    await waitStageSettled()
    const [tl, tr, bl, br] = await stageSamples([
      { rx: 0.05, ry: 0.05 },
      { rx: 0.95, ry: 0.05 },
      { rx: 0.05, ry: 0.95 },
      { rx: 0.95, ry: 0.95 },
    ])
    for (const corner of [tl, tr, bl, br]) {
      expect(corner!.a).toBeGreaterThan(128)
      expect(corner!.r + corner!.g + corner!.b).toBeLessThan(720)
    }
  }, 180_000)

  it('arbitrary 960x720 PNG file upload to stage shows four quadrants', async () => {
    await selectTargetByName('Stage')
    const png = buildPng(960, 720, quadrantPixel(960, 720))
    await uploadCostumeFile('quad-960.png', 'image/png', Buffer.from(png))
    await selectCostumeCard((await costumeCount()) - 1)
    const info = await currentCostumeInfo()
    expect(info.isStage).toBe(true)
    expect(info.costume.dataFormat).toBe('png')
    expect(info.costume.bitmapResolution).toBe(2)
    expect(info.costume.rotationCenterX).toBe(480)
    expect(info.costume.rotationCenterY).toBe(360)
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    expect(await bitmapCanvasSize()).toEqual({ width: 960, height: 720 })
    await waitStageSettled()
    const [tl, tr, bl, br] = await stageSamples([
      { rx: 0.05, ry: 0.08 },
      { rx: 0.95, ry: 0.08 },
      { rx: 0.05, ry: 0.92 },
      { rx: 0.95, ry: 0.92 },
    ])
    expect(isRed(tl!)).toBe(true)
    expect(isGreen(tr!)).toBe(true)
    expect(isBlue(bl!)).toBe(true)
    expect(isYellow(br!)).toBe(true)
    // Bitmap<->vector round-trip preserves the res2 stage intake.
    const md5Before = info.costume.md5ext as string
    await page.getByRole('button', { name: /ベクターに変換/ }).click()
    await page.waitForFunction(
      (ban: string) => {
        const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
        const s = w.__hikkakuEditorTest?.snapshot()
        const t = s?.project?.targets?.find((x: any) => x.isStage)
        return t?.costumes[t.currentCostume ?? 0]?.dataFormat === 'svg' && t.costumes[t.currentCostume ?? 0]?.md5ext !== ban
      },
      md5Before as unknown as undefined,
      { timeout: 30_000 },
    )
    await page.getByRole('button', { name: /ビットマップに変換/ }).click()
    await page.waitForFunction(
      (ban: string) => {
        const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
        const s = w.__hikkakuEditorTest?.snapshot()
        const t = s?.project?.targets?.find((x: any) => x.isStage)
        return t?.costumes[t.currentCostume ?? 0]?.dataFormat === 'png' && t.costumes[t.currentCostume ?? 0]?.md5ext !== ban
      },
      md5Before as unknown as undefined,
      { timeout: 30_000 },
    )
    const after = await currentCostumeInfo()
    expect(after.costume.dataFormat).toBe('png')
    // Vector->bitmap on stage rasterizes at the stage target resolution (1):
    // the round-trip preserves full-stage appearance (quadrants) while the
    // stored resolution follows the existing conversion contract (res1).
    expect(after.costume.bitmapResolution).toBe(1)
    await waitStageSettled()
    {
      const [rtl, rtr, rbl, rbr] = await stageSamples([
        { rx: 0.05, ry: 0.08 },
        { rx: 0.95, ry: 0.08 },
        { rx: 0.05, ry: 0.92 },
        { rx: 0.95, ry: 0.92 },
      ])
      expect(isRed(rtl!)).toBe(true)
      expect(isGreen(rtr!)).toBe(true)
      expect(isBlue(rbl!)).toBe(true)
      expect(isYellow(rbr!)).toBe(true)
    }
    // Undo peels the last conversion (vector), redo restores it.
    await page.getByRole('button', { name: 'Undo' }).last().click()
    await page.waitForTimeout(800)
    const undone = await currentCostumeInfo()
    expect(undone.costume.dataFormat).toBe('svg')
    await page.getByRole('button', { name: 'Redo' }).last().click()
    await page.waitForTimeout(800)
    const redone = await currentCostumeInfo()
    expect(redone.costume.dataFormat).toBe('png')
    expect(redone.costume.bitmapResolution).toBe(1)
  }, 180_000)

  it('480x360 PNG file upload to stage renders a honke centered quarter', async () => {
    await selectTargetByName('Stage')
    const png = buildPng(480, 360, quadrantPixel(480, 360))
    await uploadCostumeFile('quad-480.png', 'image/png', Buffer.from(png))
    await selectCostumeCard((await costumeCount()) - 1)
    const info = await currentCostumeInfo()
    expect(info.costume.bitmapResolution).toBe(2)
    expect(info.costume.rotationCenterX).toBe(240)
    expect(info.costume.rotationCenterY).toBe(180)
    await waitStageSettled()
    const corners = await stageSamples([
      { rx: 0.05, ry: 0.05 },
      { rx: 0.95, ry: 0.05 },
      { rx: 0.05, ry: 0.95 },
      { rx: 0.95, ry: 0.95 },
    ])
    for (const corner of corners) expect(isWhite(corner!)).toBe(true)
    const [itl, itr, ibl, ibr] = await stageSamples([
      { rx: 0.375, ry: 0.375 },
      { rx: 0.625, ry: 0.375 },
      { rx: 0.375, ry: 0.625 },
      { rx: 0.625, ry: 0.625 },
    ])
    expect(isRed(itl!)).toBe(true)
    expect(isGreen(itr!)).toBe(true)
    expect(isBlue(ibl!)).toBe(true)
    expect(isYellow(ibr!)).toBe(true)
  }, 180_000)

  it('sprite PNG, SVG defaults, transparent/JPEG/UTF8, errors, save->reload', async () => {
    // Sprite file-upload PNG uses the same res2 middle intake.
    const sprites = (await snapshot()).project.targets.filter((t: any) => !t.isStage)
    expect(sprites.length).toBeGreaterThan(0)
    await selectTargetByName(sprites[0].name)
    const quad = buildPng(200, 100, quadrantPixel(200, 100))
    await uploadCostumeFile('sprite-quad.png', 'image/png', Buffer.from(quad))
    await selectCostumeCard((await costumeCount()) - 1)
    {
      const info = await currentCostumeInfo()
      expect(info.isStage).toBe(false)
      expect(info.costume.bitmapResolution).toBe(2)
      expect(info.costume.rotationCenterX).toBe(100)
      expect(info.costume.rotationCenterY).toBe(50)
    }
    // SVG file upload keeps existing defaults (stage 240,180 / sprite res1).
    await selectTargetByName('Stage')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect x="0" y="0" width="480" height="360" fill="#ffffff"/><rect x="20" y="30" width="100" height="60" fill="#ff0000"/></svg>`
    await uploadCostumeFile('default-check.svg', 'image/svg+xml', Buffer.from(svg, 'utf8'))
    await selectCostumeCard((await costumeCount()) - 1)
    {
      const info = await currentCostumeInfo()
      expect(info.costume.dataFormat).toBe('svg')
      expect(info.costume.bitmapResolution).toBe(1)
      expect(info.costume.rotationCenterX).toBe(240)
      expect(info.costume.rotationCenterY).toBe(180)
    }
    // Transparent PNG is non-destructive and still res2 middle.
    const transparent = buildPng(8, 8, () => [0, 0, 0, 0])
    const countBeforeTransparent = await costumeCount()
    await uploadCostumeFile('transparent-check.png', 'image/png', Buffer.from(transparent))
    await selectCostumeCard((await costumeCount()) - 1)
    {
      const info = await currentCostumeInfo()
      expect(info.costume.bitmapResolution).toBe(2)
      expect(info.costume.rotationCenterX).toBe(4)
      expect(info.costume.rotationCenterY).toBe(4)
      expect(await costumeCount()).toBe(countBeforeTransparent + 1)
    }
    // Non-PNG (JPEG) via real canvas encoding decodes to res2 middle.
    const jpegB64 = await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 120
      c.height = 80
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#00ffff'
      ctx.fillRect(0, 0, 120, 80)
      return c.toDataURL('image/jpeg', 0.92).split(',')[1] as string
    })
    await uploadCostumeFile('photo-check.jpg', 'image/jpeg', Buffer.from(jpegB64!, 'base64'))
    await selectCostumeCard((await costumeCount()) - 1)
    {
      const info = await currentCostumeInfo()
      expect(info.costume.bitmapResolution).toBe(2)
      expect(info.costume.rotationCenterX).toBe(60)
      expect(info.costume.rotationCenterY).toBe(40)
    }
    // UTF8 filename survives (extension stripped, stem preserved).
    const utf8Png = buildPng(32, 32, quadrantPixel(32, 32))
    await uploadCostumeFile('テスト画像_😀.png', 'image/png', Buffer.from(utf8Png))
    await selectCostumeCard((await costumeCount()) - 1)
    {
      const info = await currentCostumeInfo()
      expect(info.costume.name).toBe('テスト画像_😀')
      expect(info.costume.bitmapResolution).toBe(2)
    }
    // Invalid image bytes report without destroying the project.
    {
      const countBefore = await costumeCount()
      const statusBefore = await editorStatus()
      await page.getByTestId('costume-file-input').setInputFiles({
        name: 'broken.png',
        mimeType: 'image/png',
        buffer: Buffer.from('this is not an image', 'utf8'),
      })
      await page.waitForFunction(
        (prev: string) => {
          const w = window as unknown as { __hikkakuEditorTest?: { status: () => string } }
          return (w.__hikkakuEditorTest?.status() ?? '') !== prev
        },
        statusBefore as unknown as undefined,
        { timeout: 30_000 },
      )
      await page.waitForTimeout(800)
      expect(await editorStatus()).toMatch(/Could not|decode|upload/i)
      expect(await costumeCount()).toBe(countBefore)
    }
    // Asset save->reload preserves the stage PNG intake (SB3 round-trip).
    await page.getByText('ファイル', { exact: true }).first().click()
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'SB3' }).first().click()
    const download = await downloadPromise
    const p = await download.path()
    let bytes: Buffer
    if (p) {
      bytes = readFileSync(p)
    } else {
      const stream = await download.createReadStream()
      const chunks: Buffer[] = []
      for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
      bytes = Buffer.concat(chunks)
    }
    const archive = unzipSync(new Uint8Array(bytes))
    const project = JSON.parse(strFromU8(archive['project.json']!))
    const stage = project.targets.find((t: any) => t.isStage)
    expect(stage).toBeTruthy()
    const quad480 = stage.costumes.find((c: any) => c.name === 'quad-480')
    expect(quad480).toMatchObject({ dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 240, rotationCenterY: 180 })
    // Reload the exported SB3: stored assets and meta survive byte-exact.
    await page.getByTestId('project-file-input').setInputFiles({ name: 'audit-reload.sb3', mimeType: 'application/x.scratch.sb3', buffer: bytes })
    await page.waitForFunction(
      (want: string) => {
        const w = window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }
        return w.__hikkakuEditorTest?.snapshot()?.project.targets.some((t: any) => t.costumes.some((c: any) => c.name === want)) ?? false
      },
      'quad-480' as unknown as undefined,
      { timeout: 30_000 },
    )
    await selectTargetByName('Stage')
    // Select the reloaded quad-480 (export preserves all costumes; the
    // current slot is the last-uploaded UTF8 PNG, not quad-480).
    await page.getByRole('button', { name: 'Select quad-480' }).click()
    await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible', timeout: 30_000 })
    await waitStageSettled()
    const reloaded = await stageSamples([
      { rx: 0.05, ry: 0.05 },
      { rx: 0.375, ry: 0.375 },
    ])
    expect(isWhite(reloaded[0]!)).toBe(true)
    expect(isRed(reloaded[1]!)).toBe(true)
  }, 240_000)
})
