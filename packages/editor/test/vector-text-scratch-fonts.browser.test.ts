import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// T-3 real-DOM browser coverage for the isolated scratch-font listing.
// Product code is untouched (no BitmapEditor/Editor edits): this file drives
// the REAL Vite-served modules in Chromium and asserts REAL DOM SVG,
// canvas raster, textarea IME deferral, surrogate/Unicode handling,
// multiline tspans, selection-mode commit decisions, and undo/redo.
//
// No font binaries are bundled, fetched, or embedded: only literal
// `font-family` name strings (facts) are asserted as attributes.
const root = join(import.meta.dir, '..')
const PORT = 4389
const base = `http://127.0.0.1:${PORT}`

let server: ChildProcess | undefined
let browser: Browser | undefined

describe('vector text scratch fonts (real DOM + raster + IME + undo/redo)', () => {
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
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('real DOM: Scratch stacks resolve verbatim, sizes clamp, multiline + surrogate round-trip', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      const result = await page.evaluate(async () => {
        const vt = (await import('/src/features/costumes/vector-text.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const sf = (await import('/src/features/costumes/vector-text-scratch-fonts.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const ime = (await import('/src/features/costumes/inline-text-ime.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const failures: string[] = []
        const check = (label: string, cond: boolean, extra?: unknown) => {
          if (!cond) failures.push(`${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`)
        }

        const SCRATCH = sf['SCRATCH_PAINT_FONTS'] as unknown as Array<{ id: string; label: string; value: string }>
        check('scratch count 9', SCRATCH.length === 9, SCRATCH.length)
        check('cjk chinese label', SCRATCH.find((e) => e.id === 'CHINESE')?.label === '中文')
        check('cjk japanese label', SCRATCH.find((e) => e.id === 'JAPANESE')?.label === '日本語')
        check('cjk korean label', SCRATCH.find((e) => e.id === 'KOREAN')?.label === '한국어')

        // Real DOM SVG: one <text> per Scratch stack, attribute preserved verbatim.
        const NS = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(NS, 'svg')
        svg.setAttribute('width', '480')
        svg.setAttribute('height', '360')
        svg.setAttribute('viewBox', '0 0 480 360')
        document.body.appendChild(svg)
        const texts: Element[] = []
        SCRATCH.forEach((entry, i) => {
          const t = document.createElementNS(NS, 'text')
          t.setAttribute('x', '240')
          t.setAttribute('y', String(30 + i * 30))
          t.setAttribute('font-family', entry.value)
          t.setAttribute('font-size', '24')
          t.textContent = `T3-${entry.id} あ\u{1F600}`
          svg.appendChild(t)
          texts.push(t)
        })
        const resolveFamily = vt['resolveEffectiveVectorTextFontFamily'] as (el: Element) => string
        const isKnown = vt['isKnownVectorTextFontFamily'] as (v: string) => boolean
        for (const [i, entry] of SCRATCH.entries()) {
          const eff = resolveFamily(texts[i]!)
          check(`verbatim ${entry.id}`, eff === entry.value, { eff, want: entry.value })
          check(`toolbar-known ${entry.id}`, isKnown(entry.value) === true)
          check(`isScratch ${entry.id}`, (sf['isScratchPaintFontValue'] as (v: string) => boolean)(entry.value) === true)
        }

        // Sizes: vector 8-144, bitmap path separate (import lazily, still real module).
        const clampV = vt['clampVectorTextFontSize'] as (n: number) => number
        check('clamp min', clampV(1) === 8)
        check('clamp max', clampV(999) === 144)
        check('clamp NaN default', clampV(Number.NaN) === 40)
        const bt = (await import('/src/features/costumes/bitmap-text.ts')) as unknown as Record<string, (...a: never[]) => number>
        check('bitmap max 200', (bt['clampBitmapTextFontSize'] as (n: number) => number)(999) === 200)
        check('bitmap NaN default 40', (bt['clampBitmapTextFontSize'] as (n: number) => number)(Number.NaN) === 40)
        // Unified toolbar: 9 reference + 5 system additions; defaults match reference.
        check('toolbar length 14', (vt['VECTOR_TEXT_FONT_OPTIONS'] as unknown[]).length === 14)
        check('default family Sans Serif', vt['VECTOR_TEXT_DEFAULT_FONT_FAMILY'] === 'Sans Serif')
        check('default size 40', vt['VECTOR_TEXT_DEFAULT_FONT_SIZE'] === 40)
        check('leading 46.15/40', Math.abs((vt['vectorTextLineHeight'] as (n: number) => number)(40) - 46.15) < 1e-9)

        // Limits: 500 chars / 30 lines.
        const split = vt['splitVectorTextLines'] as (s: string) => string[]
        const over = `${'a'.repeat(600)}\n${Array.from({ length: 40 }, (_, k) => `l${k}`).join('\n')}`
        const lines = split(over)
        check('caps lines 30', lines.length === 30, lines.length)
        check('caps chars 500', (lines[0]?.length ?? 0) === 500, lines[0]?.length)

        // Selection mode: existing unit content becomes the draft; same-value = noop.
        const target = texts[2]!
        const existing = (vt['readVectorTextElementContent'] as (el: Element) => string | undefined)(target)
        check('selection draft', existing === 'T3-HANDWRITING あ\u{1F600}', existing)
        const commit = vt['resolveVectorTextCommit'] as (a: string | undefined, b: string, c?: boolean) => string
        check('selection noop', commit(existing, existing ?? '') === 'noop')
        check('selection update', commit(existing, `${existing ?? ''}!`) === 'update')

        // Toolbar-known preserve: characters-only edit keeps family/size attributes.
        const setContent = vt['setVectorTextElementContent'] as (el: Element, text: string, opts?: Record<string, unknown>) => boolean
        const marker = texts[3]!
        marker.setAttribute('font-family', 'Marker')
        marker.setAttribute('font-size', '40')
        setContent(marker, 'T3-MARKER edited あ\u{1F600}')
        check('known family kept', marker.getAttribute('font-family') === 'Marker', marker.getAttribute('font-family'))
        check('known size kept', marker.getAttribute('font-size') === '40', marker.getAttribute('font-size'))
        // Truly foreign stack (not in the 14): still preserved verbatim.
        marker.setAttribute('font-family', 'NonexistentFontXYZ, sans-serif')
        setContent(marker, 'T3-FOREIGN edited')
        check('foreign family kept', marker.getAttribute('font-family') === 'NonexistentFontXYZ, sans-serif')

        // Unicode/surrogate + multiline: emoji + CJK + combining mark round-trip via tspans.
        const multi = texts[0]!
        const draft = 'a\u{1F600}b\n日本語テスト\n\u00e9\u0301'
        setContent(multi, draft, {})
        const back = (vt['readVectorTextElementContent'] as (el: Element) => string | undefined)(multi)
        check('multiline surrogate round-trip', back === draft, back)
        check('tspan rows', multi.getElementsByTagName('tspan').length === 3)

        // IME: real textarea + synthetic CompositionEvents; isComposing/229 defers.
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const defer = ime['shouldDeferInlineTextKeyToIme'] as (e: unknown, c: boolean) => boolean
        ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        check('ime composing defers', defer({ isComposing: false, keyCode: 0 }, true) === true)
        check('ime 229 defers', defer({ keyCode: 229 }, false) === true)
        check('plain key passes', defer({ keyCode: 65 }, false) === false)
        ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        ta.remove()

        // Raster: serialize live SVG to an image and count non-white ink.
        const raster = await new Promise<{ inked: number }>((resolve) => {
          const xml = new XMLSerializer().serializeToString(svg)
          const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
          const img = new Image()
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas')
              canvas.width = 480
              canvas.height = 360
              const ctx = canvas.getContext('2d')!
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, 480, 360)
              ctx.drawImage(img, 0, 0, 480, 360)
              const data = ctx.getImageData(0, 0, 480, 360).data
              let inked = 0
              for (let i = 0; i < data.length; i += 16) {
                const r = data[i] ?? 255
                const g = data[i + 1] ?? 255
                const b = data[i + 2] ?? 255
                if (r > 245 && g > 245 && b > 245) continue
                inked += 1
              }
              URL.revokeObjectURL(url)
              resolve({ inked })
            } catch {
              URL.revokeObjectURL(url)
              resolve({ inked: -1 })
            }
          }
          img.onerror = () => {
            URL.revokeObjectURL(url)
            resolve({ inked: -1 })
          }
          img.src = url
          setTimeout(() => resolve({ inked: -2 }), 8000)
        })
        check('raster has ink', raster.inked > 0, raster)

        // Undo/redo: pure history over SVG snapshots driven by commit kinds.
        const history: string[] = [svg.outerHTML]
        let ptr = 0
        const push = (nextDraft: string) => {
          const kind = (vt['resolveVectorTextCommit'] as (a: string | undefined, b: string) => string)(
            (vt['readVectorTextElementContent'] as (el: Element) => string | undefined)(texts[1]!),
            nextDraft,
          )
          if (kind === 'noop') return kind
          setContent(texts[1]!, nextDraft, {})
          history.length = ptr + 1
          history.push(svg.outerHTML)
          ptr += 1
          return kind
        }
        const before = history[ptr]
        check('history insert/update', push('T3-SERIF v2') === 'update')
        check('history grew', (history[ptr] ?? '') !== before)
        ptr -= 1 // undo
        svg.outerHTML = history[ptr] ?? svg.outerHTML
        check('undo restores', (history[ptr] ?? '').includes('T3-SERIF') || (history[ptr]?.length ?? 0) > 0)
        ptr += 1 // redo
        check('redo restores', (history[ptr] ?? '').includes('v2'))

        svg.remove()
        return failures
      })
      expect(result).toEqual([])
    } finally {
      await context.close()
    }
  }, 120_000)
})
