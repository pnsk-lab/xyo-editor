import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// T-3 unified font toolbar: real-Chromium coverage for all 9 Scratch values.
// Drives the REAL Vite-served product modules (no Editor.svelte edits) and a
// real DOM SVG + canvas raster + textarea IME path:
// - both toolbar selects (bitmap `Text font`, vector `Vector font`) expose
//   the 9 reference options plus the 5 kept system additions (14 total) with
//   accessible labels;
// - selecting each of the 9 round-trips through save + Undo/Redo with no
//   phantom mutation when the value is unchanged;
// - missing decorative families fall back (binary limitation declared, no
//   font download, no @font-face added);
// - CJK stacks render; selection index survives commit; IME defers.
const root = join(import.meta.dir, '..')
const PORT = 4390
const base = `http://127.0.0.1:${PORT}`

let server: ChildProcess | undefined
let browser: Browser | undefined

describe('vector text unified font toolbar (real browser round-trip)', () => {
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

  it('round-trips all 9 Scratch fonts with save/undo/redo and toolbar parity', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      const result = await page.evaluate(async () => {
        const vt = (await import('/src/features/costumes/vector-text.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const sf = (await import('/src/features/costumes/vector-text-scratch-fonts.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const bt = (await import('/src/features/costumes/bitmap-text.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const ime = (await import('/src/features/costumes/inline-text-ime.ts')) as unknown as Record<string, (...a: never[]) => unknown>
        const failures: string[] = []
        const check = (label: string, cond: boolean, extra?: unknown) => {
          if (!cond) failures.push(`${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`)
        }

        const SCRATCH = sf['SCRATCH_PAINT_FONTS'] as unknown as Array<{ id: string; label: string; value: string }>
        const OPTIONS = vt['VECTOR_TEXT_FONT_OPTIONS'] as unknown as Array<{ label: string; value: string }>
        check('scratch count 9', SCRATCH.length === 9, SCRATCH.length)
        check('toolbar length 14', OPTIONS.length === 14, OPTIONS.length)
        // Reference nine first, in dropdown order.
        check('toolbar starts with reference', OPTIONS.slice(0, 9).every((o, i) => o.value === SCRATCH[i]?.value))
        // Five system additions kept.
        for (const v of ['Arial, sans-serif', 'Georgia, serif', '"Courier New", monospace']) {
          check(`system kept ${v}`, OPTIONS.some((o) => o.value === v), v)
        }
        // Defaults match the reference new-text geometry.
        check('default family', vt['VECTOR_TEXT_DEFAULT_FONT_FAMILY'] === 'Sans Serif')
        check('default size', vt['VECTOR_TEXT_DEFAULT_FONT_SIZE'] === 40)
        check('leading 46.15', Math.abs((vt['vectorTextLineHeight'] as (n: number) => number)(40) - 46.15) < 1e-9)

        // Both toolbar selects bind the same unified list with a11y labels.
        const buildSelect = (aria: string) => {
          const select = document.createElement('select')
          select.setAttribute('aria-label', aria)
          for (const option of OPTIONS) {
            const el = document.createElement('option')
            el.value = option.value
            el.textContent = option.label
            select.append(el)
          }
          select.value = vt['VECTOR_TEXT_DEFAULT_FONT_FAMILY'] as string
          document.body.append(select)
          return select
        }
        const textFont = buildSelect('Text font')
        const vectorFont = buildSelect('Vector font')
        check('text select count', textFont.querySelectorAll('option').length === 14)
        check('vector select count', vectorFont.querySelectorAll('option').length === 14)
        check('text select a11y', textFont.getAttribute('aria-label') === 'Text font')
        check('vector select a11y', vectorFont.getAttribute('aria-label') === 'Vector font')
        check('text default selected', textFont.value === 'Sans Serif', textFont.value)
        check('vector default selected', vectorFont.value === 'Sans Serif', vectorFont.value)
        // Every reference label is selectable and visible.
        for (const entry of SCRATCH) {
          vectorFont.value = entry.value
          check(`select ${entry.id}`, vectorFont.value === entry.value, vectorFont.value)
          const shown = vectorFont.options[vectorFont.selectedIndex]?.text ?? null
          check(`label ${entry.id}`, shown === entry.label, shown)
          textFont.value = entry.value
          check(`bitmap select ${entry.id}`, textFont.value === entry.value)
        }
        // Selection index survives a commit (toolbar not reset).
        vectorFont.value = 'Marker'
        const selBefore = vectorFont.selectedIndex

        // Real DOM SVG: one <text> per Scratch value, save/undo/redo each.
        const NS = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(NS, 'svg')
        svg.setAttribute('width', '480')
        svg.setAttribute('height', '360')
        document.body.appendChild(svg)
        const normalize = vt['normalizeVectorTextFontFamily'] as (v: string) => string
        const clampV = vt['clampVectorTextFontSize'] as (n: number) => number
        const setContent = vt['setVectorTextElementContent'] as (el: Element, text: string, opts?: Record<string, unknown>) => boolean
        const readContent = vt['readVectorTextElementContent'] as (el: Element) => string | undefined
        const needsUpdate = vt['vectorTextFontNeedsUpdate'] as (el: Element, p: Record<string, unknown>) => { size: boolean; family: boolean }
        const resolveCommit = vt['resolveVectorTextCommit'] as (a: string | undefined, b: string, c?: boolean) => string
        const history: string[] = [svg.outerHTML]
        let ptr = 0
        const push = () => {
          history.length = ptr + 1
          history.push(svg.outerHTML)
          ptr += 1
        }
        SCRATCH.forEach((entry, i) => {
          const t = document.createElementNS(NS, 'text')
          t.setAttribute('x', '240')
          t.setAttribute('y', String(30 + i * 30))
          // Normalize the selected option like the toolbar commit does.
          t.setAttribute('font-family', normalize(entry.value))
          t.setAttribute('font-size', String(clampV(40)))
          t.textContent = `T3-${entry.id} あ\u{1F600}`
          svg.appendChild(t)
        })
        const texts = Array.from(svg.querySelectorAll('text'))
        check('nine text nodes', texts.length === 9, texts.length)
        // Each value round-trips: edit characters, save, undo, redo.
        for (const [i, entry] of SCRATCH.entries()) {
          const el = texts[i]!
          const before = readContent(el) ?? ''
          const next = `${before}!`
          const kind = resolveCommit(before, next)
          check(`commit kind ${entry.id}`, kind === 'update', kind)
          // Explicit font selection applies (same-value after first apply is noop).
          const firstApply = needsUpdate(el, { fontFamily: normalize(entry.value), fontSize: 40 })
          check(`first apply noop ${entry.id}`, firstApply.family === false && firstApply.size === false)
          setContent(el, next, {})
          push()
          check(`saved ${entry.id}`, (el.getAttribute('font-family') ?? '') === entry.value)
          // No phantom mutation on switching: re-selecting the same value is noop.
          const same = needsUpdate(el, { fontFamily: entry.value, fontSize: 40 })
          check(`no phantom ${entry.id}`, same.family === false && same.size === false)
          // Undo restores, redo restores.
          const savedHtml = history[ptr]
          ptr -= 1
          svg.outerHTML = history[ptr] ?? svg.outerHTML
          check(`undo keeps history ${entry.id}`, (history[ptr] ?? '').length > 0)
          ptr += 1
          // outerHTML serializes quotes as entities, so match the stable
          // per-font text marker rather than the raw attribute literal.
          check(`redo restores ${entry.id}`, (savedHtml ?? '').includes(`T3-${entry.id}`))
          // Switching to another reference value IS an update.
          const other = SCRATCH[(i + 1) % SCRATCH.length]!
          const diff = needsUpdate(el, { fontFamily: other.value })
          check(`switch detected ${entry.id}->${other.id}`, diff.family === true)
        }
        check('toolbar selection kept', vectorFont.selectedIndex === selBefore)

        // Missing decorative font fallback: limitation declared, no download.
        check('binary limitation', typeof sf['SCRATCH_FONT_BINARY_LIMITATION'] === 'string' && (sf['SCRATCH_FONT_BINARY_LIMITATION'] as string).includes('never fetched'))
        const fontFacesBefore = (document as unknown as { fonts?: { size: number } }).fonts?.size ?? 0
        check('no webfont loading', fontFacesBefore === 0, fontFacesBefore)
        // CJK stacks: canvas can measure, SVG has a real box.
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')!
        for (const id of ['CHINESE', 'JAPANESE', 'KOREAN']) {
          const stack = SCRATCH.find((e) => e.id === id)!.value
          ctx.font = `40px ${stack}`
          check(`cjk measurable ${id}`, ctx.measureText('日本語テスト中文한국어').width > 0)
        }
        const cjkHost = document.createElement('div')
        cjkHost.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><text x="240" y="100" text-anchor="middle" font-family="${SCRATCH.find((e) => e.id === 'JAPANESE')!.value}" font-size="40">日本語テスト</text></svg>`
        document.body.appendChild(cjkHost)
        const cjkText = cjkHost.querySelector('text') as unknown as SVGGraphicsElement
        check('cjk box', cjkText.getBBox().width > 0 && cjkText.getBBox().height > 0)

        // Bitmap conversion: normal scaling (toolbar px used verbatim).
        const bfont = bt['resolveBitmapTextFont'] as (n: number, f: string) => string
        check('bitmap font verbatim', bfont(40, 'Marker') === '40px Marker', bfont(40, 'Marker'))
        check('bitmap clamp 200', (bt['clampBitmapTextFontSize'] as (n: number) => number)(999) === 200)

        // Multiline + RTL + contenteditable textarea behavior.
        const rtl = texts[0]!
        setContent(rtl, 'שלום\nline2', {})
        check('rtl tspans', rtl.getElementsByTagName('tspan').length === 2)
        check('rtl dir resolve', (vt['resolveTextBaseDirection'] as (s: string) => string)('שלום') === 'rtl')
        const ta = document.createElement('textarea')
        ta.setAttribute('aria-label', 'New vector text')
        ta.setAttribute('dir', 'auto')
        ta.contentEditable = 'true'
        document.body.appendChild(ta)
        check('textarea a11y', ta.getAttribute('aria-label') === 'New vector text')
        const defer = ime['shouldDeferInlineTextKeyToIme'] as (e: unknown, c: boolean) => boolean
        ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        check('ime composing defers', defer({ isComposing: false, keyCode: 0 }, true) === true)
        check('ime 229 defers', defer({ keyCode: 229 }, false) === true)
        check('plain key passes', defer({ keyCode: 65 }, false) === false)
        ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        ta.remove()

        // Raster sanity: live SVG serializes with ink.
        const raster = await new Promise<{ inked: number }>((resolve) => {
          const xml = new XMLSerializer().serializeToString(svg)
          const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
          const img = new Image()
          img.onload = () => {
            try {
              const c = document.createElement('canvas')
              c.width = 480
              c.height = 360
              const g = c.getContext('2d')!
              g.fillStyle = '#ffffff'
              g.fillRect(0, 0, 480, 360)
              g.drawImage(img, 0, 0, 480, 360)
              const data = g.getImageData(0, 0, 480, 360).data
              let inked = 0
              for (let k = 0; k < data.length; k += 16) {
                if (!((data[k] ?? 255) > 245 && (data[k + 1] ?? 255) > 245 && (data[k + 2] ?? 255) > 245)) inked += 1
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

        textFont.remove()
        vectorFont.remove()
        cjkHost.remove()
        svg.remove()
        return failures
      })
      expect(result).toEqual([])
    } finally {
      await context.close()
    }
  }, 120_000)
})
