import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

/**
 * Inline text helpers with a real DOM: multiline markup round-trips through
 * DOMParser/XMLSerializer, escaping holds, and the commit-kind guard keeps
 * empty drafts from ever reaching history.
 */
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4198'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('inline text with a real DOM', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4198', '--strictPort'], {
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
    page = await browser.newPage()
    await page.goto(base)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('round-trips multiline vector text through markup and the DOM', async () => {
    const result = await page.evaluate(async () => {
      const text = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const markup = text.buildVectorTextMarkup({
        x: 120,
        y: 90,
        text: 'hello <you>\nsecond & line',
        paint: { defs: '', fill: '#ff0000' },
        strokeColor: '#000000',
        strokeWidth: 4,
        opacity: 100,
        fontSize: 24,
        fontFamily: 'Arial, sans-serif',
      })
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
        'image/svg+xml',
      )
      const element = doc.getElementsByTagName('text')[0]!
      const roundTripped = text.readVectorTextElementContent(element)
      const tspanCount = element.getElementsByTagName('tspan').length
      // Re-edit path: update the element in place and read it back.
      text.setVectorTextElementContent(element, 'edited\nthird', { fontSize: 32 })
      const edited = text.readVectorTextElementContent(element)
      const serialized = new XMLSerializer().serializeToString(doc)
      return {
        roundTripped,
        tspanCount,
        edited,
        fontSize: element.getAttribute('font-size'),
        leak: markup.includes('<you>') || markup.includes('& line') && !markup.includes('&amp;'),
        serializedHasTspan: serialized.includes('<tspan'),
      }
    })
    expect(result.roundTripped).toBe('hello <you>\nsecond & line')
    expect(result.tspanCount).toBe(2)
    expect(result.edited).toBe('edited\nthird')
    expect(result.fontSize).toBe('32')
    expect(result.leak).toBe(false)
    expect(result.serializedHasTspan).toBe(true)
  })

  it('lists vector text with tspan newlines restored (single-line and nested safe)', async () => {
    const result = await page.evaluate(async () => {
      const svg = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
      const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
      const multi = svg.vectorObjectList(
        wrap('<text x="10" y="20" font-size="24"><tspan x="10" dy="0">hello</tspan><tspan x="10" dy="28.8">world</tspan></text>'),
      )[0]
      const single = svg.vectorObjectList(wrap('<text x="10" y="20">hi</text>'))[0]
      const nested = svg.vectorObjectList(
        wrap('<text x="10" y="20" font-size="24"><tspan x="10" dy="0">outer<tspan>inner</tspan>!</tspan><tspan x="10" dy="28.8">second</tspan></text>'),
      )[0]
      return {
        multiText: multi?.text,
        multiLabel: multi?.label,
        singleText: single?.text,
        nestedText: nested?.text,
      }
    })
    // Re-edit drafts read this field: collapsing to "helloworld" loses the
    // newline on the second commit.
    expect(result.multiText).toBe('hello\nworld')
    expect(result.multiLabel).toContain('hello world')
    expect(result.singleText).toBe('hi')
    expect(result.nestedText).toBe('outerinner!\nsecond')
  })

  it('keeps empty drafts out of history decisions and sizes bitmap blocks', async () => {
    const result = await page.evaluate(async () => {
      const text = await import(/* @vite-ignore */ '/src/features/costumes/vector-text.ts')
      const bitmap = await import(/* @vite-ignore */ '/src/features/costumes/bitmap-text.ts')
      const bounds = bitmap.bitmapTextBlockBounds(100, 100, 'hi\nthere', 20)
      return {
        noopNew: text.resolveVectorTextCommit(undefined, '   \n '),
        insert: text.resolveVectorTextCommit(undefined, 'hi'),
        noopSame: text.resolveVectorTextCommit('hi', 'hi'),
        update: text.resolveVectorTextCommit('hi', 'bye'),
        remove: text.resolveVectorTextCommit('hi', ''),
        empty: bitmap.isBitmapTextEmpty('  '),
        font: bitmap.resolveBitmapTextFont(24, 'Arial, sans-serif'),
        boundsWidth: bounds.width,
        boundsHeight: bounds.height,
      }
    })
    expect(result.noopNew).toBe('noop')
    expect(result.insert).toBe('insert')
    expect(result.noopSame).toBe('noop')
    expect(result.update).toBe('update')
    expect(result.remove).toBe('delete')
    expect(result.empty).toBe(true)
    expect(result.font).toBe('24px Arial, sans-serif')
    expect(result.boundsWidth).toBeGreaterThan(0)
    expect(result.boundsHeight).toBeGreaterThan(20)
  })

  it('keeps Scratch keyboard parity: Enter newline, Escape commit, outside-click commit', async () => {
    // Trusted-key proof in a real engine: a focused textarea turns Enter into
    // a newline without any handler help. BitmapEditor must therefore not
    // preventDefault Enter (it falls through), while Escape commits.
    await page.evaluate(() => {
      const probe = document.createElement('textarea')
      probe.id = 'scratch-parity-probe'
      document.body.append(probe)
      probe.focus()
    })
    await page.keyboard.type('ab')
    await page.keyboard.press('Enter')
    await page.keyboard.type('cd')
    const typed = await page.evaluate(() => {
      const probe = document.getElementById('scratch-parity-probe') as HTMLTextAreaElement | null
      const value = probe?.value ?? ''
      probe?.remove()
      return value
    })
    expect(typed).toBe('ab\ncd')

    // Handler + click-routing mirror of BitmapEditor.svelte, executed against
    // the real DOM: stopPropagation always, IME keys defer (no commit), plain
    // Escape preventDefault + commit, Enter untouched, inside-overlay clicks
    // stay, outside clicks commit.
    const result = await page.evaluate(async () => {
      const { shouldDeferInlineTextKeyToIme } = await import(
        /* @vite-ignore */ '/src/features/costumes/inline-text-ime.ts'
      )
      let composing = false
      const calls = { commit: 0, cancel: 0, parentKeydown: 0 }
      // Mirror of handleInlineTextKeydown with the IME guard.
      function handleInlineTextKeydown(event: KeyboardEvent) {
        event.stopPropagation()
        if (shouldDeferInlineTextKeyToIme(event, composing)) return
        if (event.key === 'Escape') {
          event.preventDefault()
          calls.commit += 1
        }
      }
      const parent = document.createElement('div')
      parent.addEventListener('keydown', () => {
        calls.parentKeydown += 1
      })
      const overlay = document.createElement('div')
      overlay.setAttribute('data-inline-text-editor', '')
      const textarea = document.createElement('textarea')
      overlay.append(textarea)
      parent.append(overlay)
      const outside = document.createElement('button')
      outside.textContent = 'outside'
      parent.append(outside)
      document.body.append(parent)
      textarea.addEventListener('keydown', handleInlineTextKeydown as EventListener)
      // Multiline drafts must survive (rows grow with newlines).
      textarea.value = 'ab\ncd'
      const rows = Math.min(5, Math.max(1, textarea.value.split('\n').length))

      const dispatch = (
        target: HTMLElement,
        key: string,
        shift = false,
        extra: Record<string, unknown> = {},
      ) => {
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          shiftKey: shift,
          ...(extra as KeyboardEventInit),
        })
        if ((extra as { keyCode?: number }).keyCode !== undefined) {
          const code = (extra as { keyCode?: number }).keyCode as number
          Object.defineProperty(event, 'keyCode', { value: code })
          Object.defineProperty(event, 'which', { value: code })
        }
        target.dispatchEvent(event)
        return event.defaultPrevented
      }
      const enterPrevented = dispatch(textarea, 'Enter')
      const shiftEnterPrevented = dispatch(textarea, 'Enter', true)
      const escapePrevented = dispatch(textarea, 'Escape')
      const plainPrevented = dispatch(textarea, 'a')
      // IME-deferred keys: no commit, no preventDefault (pass to the IME).
      const commitsBeforeIme = calls.commit
      const composingEscapePrevented = dispatch(textarea, 'Escape', false, { isComposing: true })
      const composingEnterPrevented = dispatch(textarea, 'Enter', false, { isComposing: true })
      composing = true
      const windowEscapePrevented = dispatch(textarea, 'Escape')
      const ime229Prevented = dispatch(textarea, 'Escape', false, { keyCode: 229 })
      composing = false
      const imeCommits = calls.commit - commitsBeforeIme
      // Mirror of handleCanvasPointerDown routing: inside the overlay stays,
      // outside commits the pending draft.
      const shouldCommit = (target: HTMLElement) => !target.closest?.('[data-inline-text-editor]')
      const outcome = {
        enterPrevented,
        shiftEnterPrevented,
        escapePrevented,
        plainPrevented,
        composingEscapePrevented,
        composingEnterPrevented,
        windowEscapePrevented,
        ime229Prevented,
        imeCommits,
        commits: calls.commit,
        cancels: calls.cancel,
        parentKeydown: calls.parentKeydown,
        rows,
        insideCommits: shouldCommit(textarea),
        outsideCommits: shouldCommit(outside),
      }
      parent.remove()
      return outcome
    })
    expect(result.enterPrevented).toBe(false)
    expect(result.shiftEnterPrevented).toBe(false)
    expect(result.escapePrevented).toBe(true)
    expect(result.plainPrevented).toBe(false)
    // IME keys never commit and never preventDefault (pass through to the IME).
    expect(result.composingEscapePrevented).toBe(false)
    expect(result.composingEnterPrevented).toBe(false)
    expect(result.windowEscapePrevented).toBe(false)
    expect(result.ime229Prevented).toBe(false)
    expect(result.imeCommits).toBe(0)
    // Only plain Escape committed; Cancel stays on its button, never on keys.
    expect(result.commits).toBe(1)
    expect(result.cancels).toBe(0)
    // Keystrokes never bubble to global costume shortcuts.
    expect(result.parentKeydown).toBe(0)
    expect(result.rows).toBe(2)
    expect(result.insideCommits).toBe(false)
    expect(result.outsideCommits).toBe(true)
  }, 30_000)
})
