import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Independent verification for the vector-brush touch pointerdown guard.
//
// Regression: `handleCanvasPointerDown` rejected every `event.button !== 0`,
// which drops touch contact (`button === -1`) so a touch brush stroke could
// never start. The fix accepts `pointerType === 'touch'` while still
// rejecting mouse secondary buttons and non-primary pen buttons.
//
// This test never touches `editor-conformance.test.ts`; it drives the real
// costume screen on its own dev server + browser instance and verifies:
// - a CDP touch drag starts a brush preview, holds pointer capture, and
//   commits exactly one history entry (Undo/Redo round-trip),
// - synthetic mouse-secondary / pen-barrel pointerdowns never start a stroke,
// - synthetic touch `button: -1` does start one,
// - `pointercancel` discards the draft without history and releases capture,
// - the existing mouse brush path still paints and records history after all
//   of the above (no stuck gesture).
// No reference-paint code is copied here; all assertions go through the UI.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4377'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

async function surfaceCenter() {
  const box = await page.getByTestId('costume-paint-surface').boundingBox()
  if (!box) throw new Error('Missing paint surface bounds')
  return { box, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function objectCount(): Promise<number> {
  return await page.locator('[data-vector-selection-outline]').count()
}

async function waitForCount(expected: number, timeout = 15_000) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-selection-outline]').length === count,
    expected,
    { timeout },
  )
}

async function setPaint(hex: string) {
  await page.getByLabel('Paint color', { exact: true }).first().fill(hex)
}

async function setStrokeWidth(value: string) {
  await page.getByLabel('Stroke width', { exact: true }).first().fill(value)
}

async function ensureTransparentFill(off: boolean) {
  const button = page.getByRole('button', { name: 'Transparent fill' })
  const pressed = await button.getAttribute('aria-pressed')
  const isOn = pressed === 'true'
  if (off && isOn) await button.click()
  if (!off && !isOn) await button.click()
}

async function blankVectorCanvas() {
  await page.getByTestId('vector-shape-select').click()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { box } = await surfaceCenter()
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const del = page.getByTestId('delete-editor-selection')
    if (await del.isEnabled().catch(() => false)) {
      await del.click()
      await page.waitForTimeout(600)
    }
    if ((await objectCount()) === 0) break
  }
  expect(await objectCount()).toBe(0)
}

async function installCaptureSpies() {
  await page.evaluate(() => {
    const store = (window as unknown as { __captureCalls?: { set: number[]; release: number[] } })
    store.__captureCalls = { set: [], release: [] }
    const proto = Element.prototype as unknown as {
      setPointerCapture: (id: number) => void
      releasePointerCapture: (id: number) => void
      hasPointerCapture: (id: number) => boolean
    }
    if ((proto.setPointerCapture as unknown as { __brushTouchSpy?: boolean }).__brushTouchSpy) return
    const nativeSet = proto.setPointerCapture.bind(proto)
    const nativeRelease = proto.releasePointerCapture.bind(proto)
    const setSpy = function (this: Element, id: number) {
      store.__captureCalls?.set.push(id)
      return nativeSet.call(this, id)
    }
    const releaseSpy = function (this: Element, id: number) {
      store.__captureCalls?.release.push(id)
      return nativeRelease.call(this, id)
    }
    ;(setSpy as unknown as { __brushTouchSpy?: boolean }).__brushTouchSpy = true
    proto.setPointerCapture = setSpy as typeof proto.setPointerCapture
    proto.releasePointerCapture = releaseSpy as typeof proto.releasePointerCapture
  })
}

async function captureCalls(): Promise<{ set: number[]; release: number[] }> {
  return await page.evaluate(() => {
    const store = (window as unknown as { __captureCalls?: { set: number[]; release: number[] } })
    return { set: [...(store.__captureCalls?.set ?? [])], release: [...(store.__captureCalls?.release ?? [])] }
  })
}

describe('vector brush touch pointer handling', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4377', '--strictPort'], {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
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

  it('starts a touch brush stroke, holds capture, and commits one history entry', async () => {
    await blankVectorCanvas()
    await setPaint('#ff0000')
    await ensureTransparentFill(true)
    await setStrokeWidth('20')
    await page.getByTestId('vector-shape-brush').click()
    await installCaptureSpies()
    const beforeSet = (await captureCalls()).set.length

    const surface = page.getByTestId('costume-paint-surface')
    expect(await surface.evaluate((element) => getComputedStyle(element).touchAction)).toBe('none')
    const box = await surface.boundingBox()
    if (!box) throw new Error('Missing costume paint surface')
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    try {
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 35, y: y + 25 }],
      })
      const preview = surface.getByTestId('vector-brush-preview')
      await preview.waitFor({ state: 'attached' })
      const markup = await preview.innerHTML()
      // Closed-fill preview parity: a drag renders a filled path (dot: circle).
      expect(markup.includes('<path') || markup.includes('<circle')).toBe(true)
      // Capture was attempted for the touch pointer and not yet released.
      const during = await captureCalls()
      expect(during.set.length).toBeGreaterThan(beforeSet)
      expect(during.release.length).toBeLessThan(during.set.length)
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 70, y: y + 50 }],
      })
      await page.waitForTimeout(300)
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await session.detach()
    }

    // The touch stroke commits (an empty wrapper group left by blanking can
    // become counted alongside the new path, so assert a baseline-relative
    // increase rather than an absolute count).
    await page.waitForFunction(
      (base) => document.querySelectorAll('[data-vector-selection-outline]').length > base,
      0,
      { timeout: 15_000 },
    )
    const committed = await objectCount()
    expect(committed).toBeGreaterThan(0)
    const after = await captureCalls()
    expect(after.set.length).toBeGreaterThan(beforeSet)
    // Capture is best-effort (touch keeps implicit capture on some
    // platforms, so an explicit release may be a no-op); what matters is
    // that no capture leaks past the gesture.
    const lastSetId = after.set[after.set.length - 1]!
    const captureLeaked = await surface.evaluate((element, id) => {
      try {
        return element.hasPointerCapture(id)
      } catch {
        return false
      }
    }, lastSetId)
    expect(captureLeaked).toBe(false)

    // One stroke == one history entry: a single Undo returns to the blank
    // baseline and Redo restores the committed stroke.
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForCount(0)
    await page.locator('button[aria-label="Redo"]').first().click()
    await waitForCount(committed)
  }, 120_000)

  it('rejects mouse secondary and pen barrel, accepts touch button -1, and cancel leaves mouse painting intact', async () => {
    // Stage the stroke width while Select is active (the previous test leaves
    // Brush armed): the stroke side is disabled under Brush (reference
    // parity), so it cannot be typed after switching tools.
    await page.getByTestId('vector-shape-select').click()
    await setStrokeWidth('20')
    await page.getByTestId('vector-shape-brush').click()
    await setPaint('#0000ff')
    await ensureTransparentFill(true)
    const baseline = await objectCount()
    const undoEnabled = () => page.locator('button[aria-label="Undo"]').first().isEnabled()

    // Synthetic secondary-button pointerdowns must never open a stroke, even
    // with real client coordinates on the vector stage surface. Svelte
    // renders asynchronously, so each attempt waits a beat before asserting.
    for (const init of [
      { pointerType: 'mouse', button: 2, buttons: 2, pointerId: 1001 },
      { pointerType: 'mouse', button: 1, buttons: 4, pointerId: 1002 },
      { pointerType: 'pen', button: 2, buttons: 2, pointerId: 1003 },
    ]) {
      await page.evaluate((pointer: { pointerType: string; button: number; buttons: number; pointerId: number }) => {
        const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
        const rect = surface.getBoundingClientRect()
        surface.dispatchEvent(
          new PointerEvent('pointerdown', {
            ...pointer,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            composed: true,
            isPrimary: true,
          }),
        )
      }, init)
      await page.waitForTimeout(300)
      expect(await page.locator('[data-testid="vector-brush-preview"]').count()).toBe(0)
      await page.evaluate((pointer: { pointerType: string; button: number; buttons: number; pointerId: number }) => {
        const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
        const rect = surface.getBoundingClientRect()
        surface.dispatchEvent(
          new PointerEvent('pointerup', {
            ...pointer,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            composed: true,
            isPrimary: true,
          }),
        )
      }, init)
    }
    expect(await objectCount()).toBe(baseline)

    // A primary pen tip (button 0) is an intended stroke and must still work;
    // it is cancelled right away so it leaves no history behind.
    await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
      const rect = surface.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'pen',
          pointerId: 1004,
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
          bubbles: true,
          composed: true,
          isPrimary: true,
        }),
      )
    })
    await page.locator('[data-testid="vector-brush-preview"]').waitFor({ state: 'attached' })
    await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
      const rect = surface.getBoundingClientRect()
      surface.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerType: 'pen',
          pointerId: 1004,
          button: 0,
          buttons: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          composed: true,
          isPrimary: true,
        }),
      )
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="vector-brush-preview"]'),
      undefined,
      { timeout: 5_000 },
    )
    expect(await objectCount()).toBe(baseline)

    // Synthetic touch contact with button -1 (the value touch pointerdowns
    // carry on some platforms) must open a stroke.
    await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
      const rect = surface.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          pointerId: 2001,
          button: -1,
          buttons: 1,
          clientX: x,
          clientY: y,
          bubbles: true,
          composed: true,
          isPrimary: true,
        }),
      )
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'touch',
          pointerId: 2001,
          button: -1,
          buttons: 1,
          clientX: x + 24,
          clientY: y + 18,
          bubbles: true,
          composed: true,
          isPrimary: true,
        }),
      )
    })
    await page.locator('[data-testid="vector-brush-preview"]').waitFor({ state: 'attached' })

    // Cancelling the touch draft discards it: no preview, no new object, no
    // history entry, and the next mouse stroke still works.
    await page.evaluate(() => {
      const surface = document.querySelector('[data-vector-stage-surface]') as HTMLElement
      const rect = surface.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      surface.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerType: 'touch',
          pointerId: 2001,
          button: -1,
          buttons: 0,
          clientX: x + 24,
          clientY: y + 18,
          bubbles: true,
          composed: true,
          isPrimary: true,
        }),
      )
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="vector-brush-preview"]'),
      undefined,
      { timeout: 5_000 },
    )
    expect(await objectCount()).toBe(baseline)
    const undoAfterCancel = await undoEnabled().catch(() => false)
    expect(undoAfterCancel).toBe(baseline > 0)

    // Existing mouse painting still works after the touch + cancel sequence.
    const { x, y } = await surfaceCenter()
    await page.mouse.move(x - 60, y)
    await page.mouse.down()
    await page.mouse.move(x + 60, y, { steps: 12 })
    const live = await page.locator('[data-testid="vector-brush-preview"]').innerHTML()
    expect(live).toContain('<path')
    await page.mouse.up()
    await page.waitForFunction(
      (base) => document.querySelectorAll('[data-vector-selection-outline]').length > base,
      baseline,
      { timeout: 15_000 },
    )
    const afterMouse = await objectCount()
    expect(afterMouse).toBeGreaterThan(baseline)
    await page.locator('button[aria-label="Undo"]').first().click()
    await waitForCount(baseline)
    await page.locator('button[aria-label="Redo"]').first().click()
    await waitForCount(afterMouse)
  }, 120_000)
})
