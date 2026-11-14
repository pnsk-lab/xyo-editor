import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4198'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('selection shortcuts with a real DOM', () => {
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

  it('blocks real typing hosts and allows canvas targets', async () => {
    const result = await page.evaluate(async () => {
      const { isShortcutTypingTarget } = await import(
        /* @vite-ignore */ '/src/features/costumes/selection-shortcuts.ts'
      )
      const input = document.createElement('input')
      document.body.append(input)
      // plaintext-only is editable in a real engine (isContentEditable true).
      const plain = document.createElement('div')
      plain.setAttribute('contenteditable', 'plaintext-only')
      document.body.append(plain)
      const child = document.createElement('span')
      child.textContent = 'caret here'
      plain.append(child)
      const locked = document.createElement('div')
      locked.setAttribute('contenteditable', 'false')
      document.body.append(locked)
      const canvas = document.createElement('canvas')
      document.body.append(canvas)
      const outcome = {
        input: isShortcutTypingTarget(input),
        plainHost: isShortcutTypingTarget(plain),
        plainChild: isShortcutTypingTarget(child),
        plainEditableFlag: plain.isContentEditable,
        locked: isShortcutTypingTarget(locked),
        canvas: isShortcutTypingTarget(canvas),
        detachedText: isShortcutTypingTarget(document.createTextNode('x')),
      }
      for (const node of [input, plain, child, locked, canvas]) node.remove()
      return outcome
    })
    expect(result.input).toBe(true)
    expect(result.plainEditableFlag).toBe(true)
    expect(result.plainHost).toBe(true)
    // Focus inside the editable host resolves via closest()/isContentEditable.
    expect(result.plainChild).toBe(true)
    expect(result.locked).toBe(false)
    expect(result.canvas).toBe(false)
    expect(result.detachedText).toBe(false)
  }, 30_000)

  it('resolves Ctrl+Y redo and swallows shifted clipboard keys', async () => {
    const result = await page.evaluate(async () => {
      const { isShortcutWithCtrlOrMeta, resolveCostumeShortcut } = await import(
        /* @vite-ignore */ '/src/features/costumes/selection-shortcuts.ts'
      )
      return {
        ctrlY: resolveCostumeShortcut({ key: 'y', ctrlOrMeta: true, shift: false }),
        ctrlShiftY: resolveCostumeShortcut({ key: 'Y', ctrlOrMeta: true, shift: true }),
        ctrlShiftC: resolveCostumeShortcut({ key: 'c', ctrlOrMeta: true, shift: true }),
        ctrlDelete: resolveCostumeShortcut({ key: 'Delete', ctrlOrMeta: true, shift: false }),
        plainDelete: resolveCostumeShortcut({ key: 'Delete', ctrlOrMeta: false, shift: false }),
        swallowZ: isShortcutWithCtrlOrMeta('z'),
        swallowA: isShortcutWithCtrlOrMeta('a'),
        leakEnter: isShortcutWithCtrlOrMeta('Enter'),
      }
    })
    expect(result.ctrlY).toBe('redo')
    expect(result.ctrlShiftY).toBe('redo')
    expect(result.ctrlShiftC).toBeUndefined()
    expect(result.ctrlDelete).toBeUndefined()
    expect(result.plainDelete).toBe('delete')
    expect(result.swallowZ).toBe(true)
    expect(result.swallowA).toBe(true)
    expect(result.leakEnter).toBe(false)
  }, 30_000)

  it('clamps pasted rects inside the canvas, including oversized clipboards', async () => {
    const result = await page.evaluate(async () => {
      const { resolveBitmapPasteRect } = await import(
        /* @vite-ignore */ '/src/features/costumes/selection-shortcuts.ts'
      )
      return {
        staggered: resolveBitmapPasteRect(
          { width: 100, height: 80 },
          { width: 10, height: 10 },
          { x: 5, y: 5, width: 10, height: 10 },
          1,
        ),
        oversized: resolveBitmapPasteRect({ width: 100, height: 80 }, { width: 200, height: 200 }, undefined, 1),
      }
    })
    expect(result.staggered).toEqual({ x: 15, y: 15, width: 10, height: 10 })
    expect(result.oversized).toEqual({ x: 0, y: 0, width: 200, height: 200 })
  }, 30_000)
})
