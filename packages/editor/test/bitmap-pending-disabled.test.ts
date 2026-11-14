import { describe, expect, it } from 'bun:test'
import { BITMAP_PENDING_UI_ENABLED } from '../src/features/costumes/bitmap-pending-controller'

/**
 * Bitmap pending path kill switch (data-loss fix).
 *
 * The pending rect/oval session is incomplete: external VM target/costume
 * reloads bypass it via `destroy()`, move/scale are unconnected, and many
 * ops bypass commit. The new path must stay OFF by default behind the
 * explicit `BITMAP_PENDING_UI_ENABLED = false` constant, checked in
 * `ensureBitmapPendingController` before any session creation. The legacy
 * immediate-raster path stays untouched. No localStorage / query-string /
 * env switch may re-enable it from the UI.
 */

const controllerSource = await Bun.file(
  new URL('../src/features/costumes/bitmap-pending-controller.ts', import.meta.url),
).text()
const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()

function bodyOf(source: string, fn: string, length = 6000): string {
  const start = source.indexOf(fn)
  if (start < 0) throw new Error(`Missing ${fn}`)
  return source.slice(start, start + length)
}

describe('bitmap pending disabled gate (static)', () => {
  it('exports the kill switch as a literal false constant', () => {
    expect(BITMAP_PENDING_UI_ENABLED).toBe(false)
    expect(controllerSource).toContain('export const BITMAP_PENDING_UI_ENABLED = false')
  })

  it('never consults browser storage / URL state / env to enable the path', () => {
    for (const token of [
      'localStorage.',
      'sessionStorage.',
      'URLSearchParams',
      'location.search',
      'location.hash',
      'import.meta.env',
      'process.env',
    ]) {
      expect(controllerSource).not.toContain(token)
    }
    const ensureBody = bodyOf(editorSource, 'function ensureBitmapPendingController', 1500)
    for (const token of ['localStorage.', 'sessionStorage.', 'URLSearchParams', 'location.search']) {
      expect(ensureBody).not.toContain(token)
    }
  })

  it('checks the flag in ensureBitmapPendingController before any session creation', () => {
    expect(editorSource).toContain('BITMAP_PENDING_UI_ENABLED')
    const ensureBody = bodyOf(editorSource, 'function ensureBitmapPendingController', 1500)
    expect(ensureBody).toContain('if (!BITMAP_PENDING_UI_ENABLED)')
    // The guard runs before the controller is constructed or a slot ensured.
    const guardAt = ensureBody.indexOf('if (!BITMAP_PENDING_UI_ENABLED)')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(ensureBody.indexOf('new BitmapPendingController', guardAt)).toBeGreaterThan(guardAt)
    expect(ensureBody.indexOf('return undefined', guardAt)).toBeGreaterThan(guardAt)
  })

  it('guards the controller itself so direct ensure/get calls cannot create or observe a session', () => {
    const ensureBody = bodyOf(controllerSource, 'ensure(slot: BitmapPendingSlot', 1200)
    expect(ensureBody).toContain('if (!BITMAP_PENDING_UI_ENABLED)')
    expect(bodyOf(controllerSource, 'get(): BitmapPendingSession', 600)).toContain(
      'if (!BITMAP_PENDING_UI_ENABLED) return undefined',
    )
    expect(bodyOf(controllerSource, 'hasPending(): boolean', 600)).toContain(
      'if (!BITMAP_PENDING_UI_ENABLED) return false',
    )
  })

  it('leaves the legacy immediate-raster commit path intact', () => {
    // The legacy gate + save path must not be conditioned on the flag.
    expect(editorSource).toContain('function bitmapRectOvalShouldCommit')
    expect(editorSource).toContain('await saveBitmapCostume(')
    const endBody = bodyOf(editorSource, 'async function endBitmapPaint', 30_000)
    expect(endBody).toContain('cancelBitmapStroke')
    expect(endBody).toContain('saveBitmapCostume')
    expect(endBody).not.toContain('if (!BITMAP_PENDING_UI_ENABLED)')
  })
})
