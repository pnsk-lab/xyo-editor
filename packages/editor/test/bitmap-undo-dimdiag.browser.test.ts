import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { unzipSync, strFromU8 } from 'fflate'
import { launchBrowser } from './browser-launcher'

// Diagnostic-only NEW test (product code untouched, existing tests untouched).
// Replicates the bitmap half of inline-text-ime-editor.browser.test.ts on an
// independent Vite port (4473) and records real data at every stage:
// - bitmapCanvas width/height before/after vector->bitmap conversion
// - asset bytes (SB3 export PNG IHDR dims + md5ext) + rotationCenter + resolution
// - canvas rgba comparison (exact toDataURL + opaque-pixel trim + diff count)
// - Undo/Redo canvas state, plus extra bitmap edit/save/reload/target-switch
// Purpose: decide whether the post-commit Undo mismatch comes from the recent
// SVG->bitmap + font-preservation changes (geometry) or from timing/fixture.
const root = join(import.meta.dir, '..')
const PORT = 4473
const base = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined

function pngDims(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

async function canvasShot(page: Page): Promise<string> {
  return await page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!.toDataURL(),
  )
}

async function canvasDiag(page: Page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const ctx = canvas.getContext('2d')!
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0
    let left = canvas.width
    let top = canvas.height
    let right = -1
    let bottom = -1
    let diffSeed = 0
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const o = (y * canvas.width + x) * 4
        const a = image.data[o + 3] ?? 0
        if (a !== 0) {
          opaque += 1
          if (x < left) left = x
          if (y < top) top = y
          if (x > right) right = x
          if (y > bottom) bottom = y
        }
        diffSeed = (diffSeed + (image.data[o] ?? 0) + (image.data[o + 1] ?? 0) * 2 + (image.data[o + 2] ?? 0) * 3 + a * 5) % 1000000007
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      opaque,
      trim: right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
      seed: diffSeed,
    }
  })
}

async function canvasRgbaDiff(page: Page, aShot: string): Promise<{ equal: boolean; currentLen: number }> {
  const cur = await canvasShot(page)
  return { equal: cur === aShot, currentLen: cur.length }
}

async function selectedMeta(page: Page) {
  return await page.evaluate(() => {
    const snap = (window as any).__hikkakuEditorTest.snapshot()
    const target = snap.project.targets.find((t: any) => (t.id ?? t.name) === snap.selectedTargetId)
      ?? snap.project.targets.find((t: any) => !t.isStage)
      ?? snap.project.targets[0]!
    const index = target.currentCostume ?? 0
    const c = target.costumes[index]!
    return { targetName: target.name, index, name: c.name, dataFormat: c.dataFormat ?? '', bitmapResolution: c.bitmapResolution, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, md5ext: c.md5ext }
  })
}

async function exportSb3(page: Page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  const fileTrigger = page.getByText('ファイル', { exact: true }).first()
  if (await fileTrigger.isVisible()) await fileTrigger.click()
  await page.getByRole('button', { name: 'SB3' }).first().click()
  const download = await downloadPromise
  const path = await download.path()
  let bytes: Buffer
  if (path) bytes = readFileSync(path)
  else {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
    bytes = Buffer.concat(chunks)
  }
  const archive = unzipSync(new Uint8Array(bytes))
  const project = JSON.parse(strFromU8(archive['project.json']!))
  const assets: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(archive)) if (k !== 'project.json') assets[k] = v as Uint8Array
  return { project, assets }
}

function log(label: string, value: unknown) {
  console.log(`[bitmap-undo-diag] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

describe('bitmap Undo diag (new test, no product change)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('records conversion geometry, text commit, Undo/Redo rgba, edit/save/reload/switch', async () => {
    const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'networkidle' })
      await page.getByTestId('main-tab-costumes').click()
      const surface = page.getByTestId('costume-paint-surface')
      await surface.waitFor({ state: 'visible' })

      // Fixture baseline: default Sprite1 costume before any conversion.
      const metaInitial = await selectedMeta(page)
      log('initial-meta', metaInitial)
      const canvasVisibleBefore = await page.getByTestId('bitmap-editor-canvas').isVisible()
      log('initial-bitmap-visible', { canvasVisibleBefore })

      // Convert to bitmap (production button) and record geometry.
      if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
        await page.getByRole('button', { name: 'ビットマップに変換' }).click()
      }
      const canvas = page.getByTestId('bitmap-editor-canvas')
      await canvas.waitFor({ state: 'visible' })
      await page.waitForTimeout(800)
      const diagConverted = await canvasDiag(page)
      const metaConverted = await selectedMeta(page)
      log('after-conversion-canvas', diagConverted)
      log('after-conversion-meta', metaConverted)
      let sb3Converted: { project: any; assets: Record<string, Uint8Array> } | undefined
      try {
        sb3Converted = await exportSb3(page)
        const c = sb3Converted.project.targets
          .find((t: any) => t.name === (metaConverted as any).targetName)
          .costumes[(metaConverted as any).index]
        const bytes = sb3Converted.assets[c.md5ext]!
        log('after-conversion-bytes', { md5ext: c.md5ext, len: bytes.length, dims: pngDims(bytes), meta: { dataFormat: c.dataFormat, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY } })
      } catch (e) {
        log('after-conversion-export-failed', String(e))
      }
      const preCommit = await canvasShot(page)
      const preDiag = await canvasDiag(page)
      log('preCommit', { len: preCommit.length, head: preCommit.slice(0, 80), diag: preDiag })

      // Bitmap text commit (same overlay flow as the failing test, minus IME guard).
      const textTool = page.getByTestId('bitmap-tool-text')
      await textTool.waitFor({ state: 'visible' })
      await textTool.click()
      const box = await canvas.boundingBox()
      if (!box) throw new Error('Missing bitmap canvas bounds')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      const overlay = page.locator('[data-inline-text-editor]')
      await overlay.waitFor({ state: 'visible' })
      const textarea = overlay.locator('textarea')
      await textarea.waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: 10_000 })
      await page.keyboard.type('ime-bitmap')
      await page.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => document.body.textContent?.includes('Bitmap text saved') ?? false, undefined, { timeout: 10_000 })
      await page.waitForTimeout(800)
      const postCommit = await canvasShot(page)
      const postDiag = await canvasDiag(page)
      const metaPost = await selectedMeta(page)
      log('postCommit', { len: postCommit.length, head: postCommit.slice(0, 80), diag: postDiag, meta: metaPost, changed: postCommit !== preCommit })
      expect(postCommit).not.toBe(preCommit)

      // Undo with settling poll (distinguishes timing flake from geometry mismatch).
      const undoButton = page.locator('button[aria-label="Undo"]:visible')
      const redoButton = page.locator('button[aria-label="Redo"]:visible')
      await undoButton.click()
      let undoShot = ''
      let undoDiag: any = undefined
      let settled = false
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(400)
        undoShot = await canvasShot(page)
        undoDiag = await canvasDiag(page)
        const metaNow = await selectedMeta(page)
        log(`undo-poll-${i}`, { len: undoShot.length, diag: undoDiag, meta: metaNow, exact: undoShot === preCommit })
        if (undoShot === preCommit) {
          settled = true
          break
        }
      }
      const metaUndo = await selectedMeta(page)
      log('undo-final', { exact: undoShot === preCommit, len: undoShot.length, preLen: preCommit.length, diag: undoDiag, meta: metaUndo })
      try {
        const sb3Undo = await exportSb3(page)
        const c = sb3Undo.project.targets
          .find((t: any) => t.name === (metaUndo as any).targetName)
          .costumes[(metaUndo as any).index]
        const bytes = sb3Undo.assets[c.md5ext]!
        log('undo-bytes', { md5ext: c.md5ext, len: bytes.length, dims: pngDims(bytes), meta: { dataFormat: c.dataFormat, res: c.bitmapResolution, rcx: c.rotationCenterX, rcy: c.rotationCenterY } })
      } catch (e) {
        log('undo-export-failed', String(e))
      }

      // Redo should return to postCommit (with the same settling poll).
      await redoButton.click()
      let redoShot = ''
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(400)
        redoShot = await canvasShot(page)
        const d = await canvasDiag(page)
        log(`redo-poll-${i}`, { len: redoShot.length, diag: d, exact: redoShot === postCommit })
        if (redoShot === postCommit) break
      }
      log('redo-final', { exact: redoShot === postCommit, len: redoShot.length, postLen: postCommit.length })

      // Extra bitmap edit + Save + export(save) + re-import(reload) + target switch.
      const reopenBox = await canvas.boundingBox()
      if (!reopenBox) throw new Error('Missing bitmap canvas bounds for edit')
      await page.getByTestId('bitmap-tool-brush').click()
      const cx = reopenBox.x + reopenBox.width / 2
      const cy = reopenBox.y + reopenBox.height / 2
      await page.mouse.move(cx - 30, cy - 30)
      await page.mouse.down()
      await page.mouse.move(cx + 30, cy + 30, { steps: 8 })
      await page.mouse.up()
      await page.getByTestId('save-bitmap-costume').click()
      await page.waitForTimeout(800)
      const editedShot = await canvasShot(page)
      const editedDiag = await canvasDiag(page)
      const metaEdited = await selectedMeta(page)
      log('edited', { len: editedShot.length, diag: editedDiag, meta: metaEdited })
      const savedEdited = await exportSb3(page)
      const editedCostume = savedEdited.project.targets
        .find((t: any) => t.name === (metaEdited as any).targetName)
        .costumes[(metaEdited as any).index]
      const editedBytes = savedEdited.assets[editedCostume.md5ext!]!
      log('edited-bytes', { md5ext: editedCostume.md5ext, len: editedBytes.length, dims: pngDims(editedBytes) })

      // Target switch: Stage -> back, canvas must keep the edited bitmap.
      await page.getByTestId('target-card-stage').click()
      await page.waitForTimeout(800)
      const stageMeta = await selectedMeta(page)
      log('switch-stage', stageMeta)
      await page.getByTestId(`target-card-${(metaEdited as any).targetName}`).click()
      await page.waitForTimeout(800)
      const backShot = await canvasShot(page)
      const backDiag = await canvasDiag(page)
      const backMeta = await selectedMeta(page)
      log('switch-back', { exactVsEdited: backShot === editedShot, len: backShot.length, diag: backDiag, meta: backMeta })

      // Report the core regression (do not hide it): Undo must be exact.
      // This expect documents the failure with all the data above.
      expect(undoShot).toBe(preCommit)
      expect(settled).toBe(true)
    } finally {
      await context.close()
    }
  }, 180_000)
})
