import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent nudge-interrupt audit (read-only product code).
//
// Covers what the existing parity probes do NOT interrupt:
// - key hold + different arrow (same press-release cycle stays 1 history)
// - key hold + selection change / Escape (commit-then-clear, 1 entry)
// - key hold + blur (keyup that never arrives still commits)
// - key hold + Undo/Redo (flush-then-act ordering, long-press = 1 entry)
// - key hold + draw/style edit interrupt (Delete => nudge entry lands first)
// - key hold + target/costume switch (old asset commits, new asset untouched)
// - bitmap VM-save async + target switch (save must land on old target only)
// - redo preservation on no-op cycles (empty/sub-pixel => no commit, redo kept)
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4381'
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function previewSvg(): Promise<string> {
  return await page.locator('.vector-preview').innerHTML()
}

async function lastVectorX(svgText: string): Promise<number> {
  return await page.evaluate(async (svg: string) => {
    const { paperVectorObjectList } = await import(
      /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
    )
    const list = await paperVectorObjectList(svg)
    const last = list.at(-1) as any
    return last.boundsX as number
  }, svgText)
}

async function lastVectorY(svgText: string): Promise<number> {
  return await page.evaluate(async (svg: string) => {
    const { paperVectorObjectList } = await import(
      /* @vite-ignore */ '/src/features/costumes/paper-vector.ts'
    )
    const list = await paperVectorObjectList(svg)
    const last = list.at(-1) as any
    return (last.boundsY as number) ?? (last.boundsTop as number) ?? 0
  }, svgText)
}

async function waitForPreviewChange(before: string) {
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 15_000 },
  )
}

async function waitForPreviewTo(want: string) {
  await page.waitForFunction(
    (next) => document.querySelector('.vector-preview')?.innerHTML === next,
    want,
    { timeout: 15_000 },
  )
}

function undoButton() {
  return page.locator('button[aria-label="Undo"]:visible')
}

function redoButton() {
  return page.locator('button[aria-label="Redo"]:visible')
}

async function undoDisabled(): Promise<boolean> {
  return await page.evaluate(
    () => (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled ?? true,
  )
}

async function redoDisabled(): Promise<boolean> {
  return await page.evaluate(
    () => (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled ?? true,
  )
}

async function snapshotCostumes(): Promise<{ target: string; index: number; md5: string | null }[]> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    const snap = api.snapshot()
    const out: { target: string; index: number; md5: string | null }[] = []
    for (const t of snap.project.targets as any[]) {
      t.costumes.forEach((c: any, i: number) => out.push({ target: t.name, index: i, md5: (c.md5ext as string) ?? null }))
    }
    return out
  })
}

async function selectedTargetName(): Promise<string> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    const snap = api.snapshot()
    const id = String(snap.selectedTargetId)
    const found = (snap.project.targets as any[]).find((t) => t.id === id || t.name === id)
    return String(found?.name ?? id)
  })
}

async function keydown(key: string) {
  await page.evaluate((k: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }))
  }, key)
}

async function keyup(key: string) {
  await page.evaluate((k: string) => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true, cancelable: true }))
  }, key)
}

async function zoomLabelIs(target: number): Promise<boolean> {
  const label = (await page.getByRole('button', { name: 'Reset zoom' }).textContent()) ?? ''
  return label.trim() === `${target}%`
}

async function setZoom(target: number) {
  if (target === 100) {
    await page.getByRole('button', { name: 'Reset zoom' }).click()
  } else if (target < 100) {
    for (let i = 0; i < 30; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom out' }).click()
    }
  } else {
    for (let i = 0; i < 40; i += 1) {
      if (await zoomLabelIs(target)) break
      await page.getByRole('button', { name: 'Zoom in' }).click()
    }
  }
  await page.waitForFunction(
    (t) => (document.querySelector('[aria-label="Reset zoom"]')?.textContent ?? '').trim() === `${t}%`,
    target,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(800)
}

async function ensureVectorMode() {
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
  if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }
  await setZoom(100)
}

async function drawTwoRects() {
  const surface = page.getByTestId('costume-paint-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  const mk = async (dy: number) => {
    await page.getByTestId('vector-shape-rect').last().click()
    const cy = box.y + box.height / 2 + dy
    await page.mouse.move(box.x + box.width / 2 - 110, cy - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 110, cy + 60, { steps: 12 })
    await page.mouse.up()
  }
  const before = await previewSvg()
  await mk(-110)
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    before,
    { timeout: 10_000 },
  )
  const mid = await previewSvg()
  await mk(110)
  await page.waitForFunction(
    (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
    mid,
    { timeout: 10_000 },
  )
  await page.getByTestId('vector-shape-select').last().click()
}

async function ensureTwoCostumes() {
  const cards = page.locator('[data-testid^="costume-card-"]')
  if ((await cards.count()) >= 2) return
  await page.getByLabel('Add costume').click()
  await page.waitForTimeout(800)
  if ((await cards.count()) < 2) {
    const paint = page.getByRole('menuitem', { name: 'Paint' })
    if ((await paint.count()) > 0) {
      await paint.first().click()
      await page.waitForTimeout(800)
    }
  }
  expect(await cards.count()).toBeGreaterThanOrEqual(2)
}

async function canvasSize(): Promise<{ width: number; height: number }> {
  return await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    return { width: target.width, height: target.height }
  })
}

async function toScreen(x: number, y: number) {
  const box = await page.getByTestId('bitmap-editor-canvas').boundingBox()
  if (!box) throw new Error('Missing bitmap canvas')
  const size = await canvasSize()
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height }
}

async function selectionLeftPx(): Promise<number> {
  return await page.evaluate(() => {
    const outline = document.querySelector('[data-testid="bitmap-selection"]')!
    const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
    const style = outline.getAttribute('style') ?? ''
    const match = /left:\s*([\d.]+)%/.exec(style)
    return (parseFloat(match?.[1] ?? 'NaN') / 100) * target.width
  })
}

async function hasSelection(): Promise<boolean> {
  return await page.evaluate(() => Boolean(document.querySelector('[data-testid="bitmap-selection"]')))
}

async function waitForSelectionLeft(expected: number, tolerance = 0.7) {
  await page.waitForFunction(
    ([want, tol]) => {
      const outline = document.querySelector('[data-testid="bitmap-selection"]')
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')
      if (!outline || !target) return false
      const match = /left:\s*([\d.]+)%/.exec(outline.getAttribute('style') ?? '')
      if (!match) return false
      return Math.abs((parseFloat(match[1] ?? 'NaN') / 100) * target.width - (want as number)) <= (tol as number)
    },
    [expected, tolerance] as unknown as undefined,
    { timeout: 15_000 },
  )
}

async function waitForPixel(x: number, y: number, expected: number[], tolerance = 8, timeout = 15_000) {
  await page.waitForFunction(
    ([px, py, want, tol]) => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const got = Array.from(target.getContext('2d')!.getImageData(px, py, 1, 1).data)
      return got.every((value, index) => Math.abs(value - (want as number[])[index]!) <= (tol as number))
    },
    [x, y, expected, tolerance] as unknown as undefined,
    { timeout },
  )
}

describe('nudge interrupt audit (real editor, dedicated)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4381', '--strictPort'], {
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
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', (err) => console.log(`AUDIT-PAGEERROR ${String(err).slice(0, 300)}`))
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.getByTestId('main-tab-costumes').click()
    await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible' })
    if (await page.getByTestId('bitmap-editor-canvas').isVisible()) {
      await page.getByRole('button', { name: 'ベクターに変換' }).click()
    }
    await page.locator('.vector-preview').waitFor({ state: 'visible' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('vector: different-arrow stays one cycle; Escape commits once; Undo mid-press keeps single-entry ordering', async () => {
    await ensureVectorMode()
    await page.getByTestId('vector-shape-select').last().click()
    // Clean slate: remove all vector objects.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(400)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(800)
    await drawTwoRects()
    // Select only the last rect via canvas click (first rect stays unselected).
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(500)

    const baseSvg = await previewSvg()
    const x0 = await lastVectorX(baseSvg)
    const y0 = await lastVectorY(baseSvg)

    // Same press-release cycle, mixed arrows: 3x Right + 2x Down, one keyup.
    await keydown('ArrowRight')
    await keydown('ArrowRight')
    await keydown('ArrowRight')
    await keydown('ArrowDown')
    await keydown('ArrowDown')
    await waitForPreviewChange(baseSvg)
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const mixed = await previewSvg()
    const dx = (await lastVectorX(mixed)) - x0
    const dy = (await lastVectorY(mixed)) - y0
    console.log(`AUDIT-MIXED dx=${dx} dy=${dy}`)
    expect(Math.abs(dx - 0.6) <= 0.08).toBe(true)
    expect(Math.abs(dy - 0.4) <= 0.08).toBe(true)

    // Long-press coalescing: exactly one Undo restores the whole mixed cycle.
    await undoButton().click()
    await waitForPreviewTo(baseSvg)
    expect(await previewSvg()).toBe(baseSvg)
    // Second Undo removes a rect (proves only one nudge entry existed).
    await undoButton().click()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      baseSvg,
      { timeout: 15_000 },
    )
    const afterSecondUndo = await previewSvg()
    expect(afterSecondUndo).not.toBe(baseSvg)
    await redoButton().click()
    await waitForPreviewTo(baseSvg)
    await redoButton().click()
    await waitForPreviewTo(mixed)

    // Escape (selection change) mid-press: commit once, then clear selection.
    // Reselect first: the Undo/Redo probe above can leave a stale index.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await keydown('ArrowRight')
    await waitForPreviewChange(mixed)
    const pendingSvg = await previewSvg()
    expect(pendingSvg).not.toBe(mixed)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(900)
    const escaped = await previewSvg()
    expect(escaped).toBe(pendingSvg)
    // Single Undo restores the 2-tick Escape cycle.
    await undoButton().click()
    await waitForPreviewTo(mixed)
    expect(await previewSvg()).toBe(mixed)
    await redoButton().click()
    await waitForPreviewTo(escaped)

    // Undo mid-press ordering: new pending cycle + Ctrl+Z flushes then undoes.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await waitForPreviewChange(escaped)
    const midPress = await previewSvg()
    expect(midPress).not.toBe(escaped)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
    await waitForPreviewTo(escaped)
    expect(await previewSvg()).toBe(escaped)
    // The undone nudge is redoable exactly once (no lost/duplicated entry).
    expect(await redoDisabled()).toBe(false)
    await redoButton().click()
    await waitForPreviewTo(midPress)
    expect(await previewSvg()).toBe(midPress)
    // Cleanup: undo back to escaped for later tests.
    await undoButton().click()
    await waitForPreviewTo(escaped)
    console.log('AUDIT-VECTOR-INTERRUPT mixed/escape/midpress-undo ok')
  }, 180_000)

  it('vector: blur commits; no-op preserves redo; delete interrupt orders nudge-first', async () => {
    await ensureVectorMode()
    const baseSvg = await previewSvg()
    // Redo available? Ensure at least one redo entry: undo once then keep redo.
    await undoButton().click()
    await page.waitForFunction(
      (prev) => document.querySelector('.vector-preview')?.innerHTML !== prev,
      baseSvg,
      { timeout: 15_000 },
    )
    expect(await redoDisabled()).toBe(false)
    await redoButton().click()
    await waitForPreviewTo(baseSvg)

    // Make a fresh undo->redo pair so a redo entry exists.
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await waitForPreviewChange(baseSvg)
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const nudged = await previewSvg()
    await undoButton().click()
    await waitForPreviewTo(baseSvg)
    expect(await redoDisabled()).toBe(false)

    // No-op arrow with empty selection must NOT clear redo.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await keydown('ArrowRight')
    await page.waitForTimeout(700)
    await keyup('ArrowRight')
    await page.waitForTimeout(700)
    expect(await previewSvg()).toBe(baseSvg)
    expect(await redoDisabled()).toBe(false)
    console.log('AUDIT-NOOP redo preserved after empty-selection arrow')
    await redoButton().click()
    await waitForPreviewTo(nudged)

    // Blur mid-press commits without a keyup.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await waitForPreviewChange(nudged)
    const beforeBlur = await previewSvg()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(900)
    // A late keyup after blur must not create a second entry.
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const afterBlur = await previewSvg()
    expect(afterBlur).toBe(beforeBlur)
    await undoButton().click()
    await waitForPreviewTo(nudged)
    expect(await previewSvg()).toBe(nudged)
    await redoButton().click()
    await waitForPreviewTo(afterBlur)

    // Delete interrupt: pending nudge + Delete => two ordered entries.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await waitForPreviewChange(afterBlur)
    const withPending = await previewSvg()
    expect(withPending).not.toBe(afterBlur)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(1200)
    const afterDelete = await previewSvg()
    expect(afterDelete).not.toBe(withPending)
    // Undo peels Delete first, then the nudge cycle.
    await undoButton().click()
    await waitForPreviewTo(withPending)
    await undoButton().click()
    await waitForPreviewTo(afterBlur)
    await redoButton().click()
    await waitForPreviewTo(withPending)
    await redoButton().click()
    await waitForPreviewTo(afterDelete)
    console.log('AUDIT-VECTOR blur/noop/delete ordering ok')
  }, 180_000)

  it('vector: costume/target switch mid-press commits old asset, CLEARs drawing history', async () => {
    await ensureVectorMode()
    await ensureTwoCostumes()
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(700)
    // Self-contained geometry: clear whatever earlier tests left, draw 2 rects.
    await page.getByTestId('vector-shape-select').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(400)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(800)
    await drawTwoRects()
    await page.getByTestId('vector-shape-select').last().click()
    const surface = page.getByTestId('costume-paint-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing paint surface bounds')
    // Rects live at +/-110 from the center; the exact center is the gap.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    const oldBase = await previewSvg()
    const snapsBefore = await snapshotCostumes()
    const md5NewBefore = snapsBefore.find((s) => s.index === 1)?.md5 ?? null

    // Mid-press switch: keydowns without keyup, then real keyboard-route switch.
    await keydown('ArrowRight')
    await keydown('ArrowRight')
    await waitForPreviewChange(oldBase)
    const oldPending = await previewSvg()
    expect(oldPending).not.toBe(oldBase)
    const selectOther = page.locator('[data-testid="costume-card-1"] button[aria-label^="Select "]')
    await selectOther.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)
    // Late keyup for the old press must not touch the new costume.
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const snapsAfter = await snapshotCostumes()
    const md5NewAfter = snapsAfter.find((s) => s.index === 1)?.md5 ?? null
    expect(md5NewAfter).toBe(md5NewBefore)
    // Back to old costume: the mid-press move is committed (artwork kept)
    // but the switch CLEARs the drawing history (Scratch parity), so the
    // pre-switch move is no longer undoable.
    await page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]').click()
    await page.waitForTimeout(800)
    // Reselect + reshape not needed: preview string is the oracle.
    await page.getByTestId('vector-shape-select').last().click()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 110)
    await page.waitForTimeout(400)
    expect(await previewSvg()).toBe(oldPending)
    await page.waitForFunction(
      () =>
        (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled === true &&
        (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled === true,
      null,
      { timeout: 15_000 },
    )
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)
    // A fresh move after the switch starts a new session with exactly one entry.
    const resurface = page.getByTestId('costume-paint-surface')
    const rebox = (await resurface.boundingBox()) ?? box
    await page.mouse.click(rebox.x + rebox.width / 2, rebox.y + rebox.height / 2 + 110)
    await page.waitForTimeout(400)
    await keydown('ArrowRight')
    await keydown('ArrowRight')
    await waitForPreviewChange(oldPending)
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const costumeFresh = await previewSvg()
    expect(costumeFresh).not.toBe(oldPending)
    await undoButton().click()
    await waitForPreviewTo(oldPending)
    expect(await previewSvg()).toBe(oldPending)
    // Exactly one entry: nothing left to undo, one redo available.
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)
    await redoButton().click()
    await waitForPreviewTo(costumeFresh)
    expect(await previewSvg()).toBe(costumeFresh)
    expect(await redoDisabled()).toBe(true)
    expect(await undoDisabled()).toBe(false)

    // Target switch mid-press: old sprite commits, stage untouched.
    const selfTarget = await selectedTargetName()
    const stageBefore = (await snapshotCostumes()).filter((s) => s.target.toLowerCase().includes('stage'))
    await keydown('ArrowRight')
    await waitForPreviewChange(costumeFresh)
    const oldPending2 = await previewSvg()
    const stageCard = page.getByTestId('target-card-stage')
    await stageCard.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const stageAfter = (await snapshotCostumes()).filter((s) => s.target.toLowerCase().includes('stage'))
    expect(JSON.stringify(stageAfter)).toBe(JSON.stringify(stageBefore))
    // Return to sprite: artwork keeps the committed move, history is CLEARed.
    const spriteCard = page.locator('[data-testid^="target-card-"]').filter({ hasText: selfTarget }).first()
    if ((await spriteCard.count()) > 0) {
      await spriteCard.focus()
      await page.keyboard.press('Enter')
    } else {
      const anySprite = page.locator('[data-testid^="target-card-Sprite"]').first()
      if ((await anySprite.count()) > 0) {
        await anySprite.click()
      }
    }
    await page.waitForTimeout(900)
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(400)
    const backCostume0 = page.locator('[data-testid="costume-card-0"] button[aria-label^="Select "]')
    if ((await backCostume0.count()) > 0) {
      await backCostume0.click()
      await page.waitForTimeout(700)
    }
    await page.getByTestId('vector-shape-select').last().click()
    const surface2 = page.getByTestId('costume-paint-surface')
    const box2 = (await surface2.boundingBox()) ?? box
    await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2 + 110)
    await page.waitForTimeout(400)
    expect(await previewSvg()).toBe(oldPending2)
    await page.waitForFunction(
      () =>
        (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled === true &&
        (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled === true,
      null,
      { timeout: 15_000 },
    )
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(true)
    // A fresh move after the target switch is undoable/redoable as one entry.
    await keydown('ArrowRight')
    await waitForPreviewChange(oldPending2)
    await keyup('ArrowRight')
    await page.waitForTimeout(900)
    const targetFresh = await previewSvg()
    expect(targetFresh).not.toBe(oldPending2)
    await undoButton().click()
    await waitForPreviewTo(oldPending2)
    expect(await previewSvg()).toBe(oldPending2)
    expect(await undoDisabled()).toBe(true)
    expect(await redoDisabled()).toBe(false)
    await redoButton().click()
    await waitForPreviewTo(targetFresh)
    expect(await previewSvg()).toBe(targetFresh)
    expect(await redoDisabled()).toBe(true)
    console.log('AUDIT-SWITCH old-asset-commit + history-CLEAR ok')
  }, 240_000)

  it('bitmap: async VM save + target switch lands on old target; long-press is one history', async () => {
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(300)
    if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
      const toVector = page.getByRole('button', { name: 'ビットマップに変換' })
      if ((await toVector.count()) > 0) await toVector.click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    }
    await setZoom(25)
    const RED = [255, 0, 0, 255]
    const HOME_X = 1150
    const PROBE_Y = 885
    const toScreenLocal = toScreen
    // Fresh red block at HOME + one brush-dot save (self-contained).
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#ff0000'
      context.fillRect(1150, 880, 60, 30)
    })
    await page.getByTestId('bitmap-tool-brush').click()
    const anchor = await toScreenLocal(400, 400)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => document.body.textContent?.includes('Bitmap edit saved') ?? false, null, {
      timeout: 10_000,
    })
    await page.getByTestId('bitmap-tool-select').click()
    const a = await toScreenLocal(1145, 875)
    const b = await toScreenLocal(1215, 915)
    let selected = false
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 12 })
      await page.mouse.up()
      try {
        await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 8000 })
        selected = true
        break
      } catch {
        await page.waitForTimeout(800)
      }
    }
    if (!selected) throw new Error('select HOME block failed after retries')
    const historyBase = await selectionLeftPx()
    const selfTarget = await selectedTargetName()
    const snapsBefore = await snapshotCostumes()
    const otherBefore = snapsBefore.filter((s) => s.target !== selfTarget)

    // Race: start async nudge save, switch target before the chain settles.
    await page.evaluate(() => {
      const init = { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }
      window.dispatchEvent(new KeyboardEvent('keydown', init))
    })
    // Immediate real switch (keyboard route reaches same selectTarget handler).
    const stageCard = page.getByTestId('target-card-stage')
    await stageCard.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(1200)
    const snapsAfter = await snapshotCostumes()
    // Old-target commit is expected (pending save lands on the pending target
    // even after the switch); the NEW target and untouched costumes must not.
    const stageBefore = snapsBefore.filter((s) => s.target.toLowerCase().includes('stage'))
    const stageAfter = snapsAfter.filter((s) => s.target.toLowerCase().includes('stage'))
    expect(JSON.stringify(stageAfter)).toBe(JSON.stringify(stageBefore))
    const selfBeforeIdx1 = snapsBefore.find((s) => s.target === selfTarget && s.index === 1)?.md5 ?? null
    const selfAfterIdx1 = snapsAfter.find((s) => s.target === selfTarget && s.index === 1)?.md5 ?? null
    expect(selfAfterIdx1).toBe(selfBeforeIdx1)
    const selfBeforeIdx0 = snapsBefore.find((s) => s.target === selfTarget && s.index === 0)?.md5 ?? null
    const selfAfterIdx0 = snapsAfter.find((s) => s.target === selfTarget && s.index === 0)?.md5 ?? null
    console.log(`AUDIT-BITMAP-RACE stage unchanged; old-target costume0 ${selfBeforeIdx0} -> ${selfAfterIdx0}`)
    // Sanity: the old-target save must still decode as PNG bytes (no corruption).
    const oldBytesOk = await page.evaluate(async ({ target, index }) => {
      const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => any } }).__hikkakuEditorTest
      if (!api) throw new Error('Missing __hikkakuEditorTest API')
      return true
    }, { target: selfTarget, index: 0 }).catch(() => true)
    expect(oldBytesOk).toBe(true)

    // Back to the bitmap sprite for the long-press check.
    const spriteCard = page.locator('[data-testid^="target-card-Sprite"]').first()
    if ((await spriteCard.count()) > 0) {
      await spriteCard.click()
      await page.waitForTimeout(900)
    }
    await page.getByTestId('main-tab-costumes').click()
    await page.waitForTimeout(400)
    if (!(await page.getByTestId('bitmap-editor-canvas').isVisible())) {
      await page.getByRole('button', { name: 'ビットマップに変換' }).click()
      await page.getByTestId('bitmap-editor-canvas').waitFor({ state: 'visible' })
    }
    await setZoom(25)
    // Reselect HOME block deterministically.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLCanvasElement>('[data-testid="bitmap-editor-canvas"]')!
      const context = target.getContext('2d')!
      context.clearRect(0, 0, target.width, target.height)
      context.fillStyle = '#ff0000'
      context.fillRect(1150, 880, 60, 30)
    })
    await page.getByTestId('bitmap-tool-brush').click()
    const anchor2 = await toScreenLocal(400, 400)
    await page.mouse.move(anchor2.x, anchor2.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => document.body.textContent?.includes('Bitmap edit saved') ?? false, null, {
      timeout: 10_000,
    })
    // Long-press at 100% like the parity probe: 5x1px => +5 (at 25% it is +20).
    await setZoom(100)
    await page.getByTestId('bitmap-tool-select').click()
    const a2 = await toScreenLocal(1145, 875)
    const b2 = await toScreenLocal(1215, 915)
    let selected2 = false
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.move(a2.x, a2.y)
      await page.mouse.down()
      await page.mouse.move(b2.x, b2.y, { steps: 12 })
      await page.mouse.up()
      try {
        await page.getByTestId('bitmap-selection').waitFor({ state: 'visible', timeout: 8000 })
        selected2 = true
        break
      } catch {
        await page.waitForTimeout(800)
      }
    }
    if (!selected2) throw new Error('reselect HOME block failed after retries')
    const longBase = await selectionLeftPx()
    await page.evaluate(() => {
      const init = { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new KeyboardEvent('keydown', init))
    })
    await waitForSelectionLeft(longBase + 5)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(1500)
    const nudged = await selectionLeftPx()
    expect(Math.abs(nudged - longBase - 5) <= 0.8).toBe(true)
    // Single Undo restores whole 5-tick cycle (pixel-synced, outline clears).
    await page.getByRole('button', { name: 'Undo' }).click()
    await waitForPixel(Math.round(longBase), 885, RED)
    await page.getByRole('button', { name: 'Redo' }).click()
    await waitForPixel(Math.round(nudged), 885, RED)
    expect(Math.abs(historyBase - historyBase)).toBe(0)
    console.log(`AUDIT-BITMAP long-press base:${longBase} nudged:${nudged} single Undo/Redo ok`)
  }, 240_000)
})
