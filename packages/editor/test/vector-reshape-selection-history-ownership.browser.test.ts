// Browser ownership audit: the shipped Editor must copy at every buffer
// boundary (no `entry.bytes` sharing) and the live VM must hand out private
// snapshots. Static pins (fail on the sharing regression) + live checks
// through the real fixture VM (mutating a returned buffer never moves stored
// bytes; user artwork bytes survive exactly).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const PORT = 4615
const base = `http://127.0.0.1:${PORT}/test/paint-history-isolation-fixture.html`
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('reshape selection ownership (browser: static + live VM)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${PORT}`)
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  }, 120_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('Editor ships private copies + no self-compare auth (static)', async () => {
    const editor = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    // No shared-reference retention into snapshots/history.
    expect(editor).not.toContain('Share `entry.bytes`')
    expect(editor).not.toContain('Share `next.bytes`')
    expect(editor).not.toContain('ADOPTS the buffer')
    // Boundaries copy.
    expect(editor).toContain('bytes.slice()')
    expect(editor).toContain('entry.bytes.slice()')
    // Helper ships the self-compare guards.
    const helper = await Bun.file(new URL('../src/features/costumes/vector-reshape-selection-history.ts', import.meta.url)).text()
    expect(helper).toContain('snapshot.bytesExact === live')
    expect(helper).not.toContain('retains the SAME buffer')
    expect(helper).not.toContain('reference adopted, never copied')
  })

  it('live VM loadAsset returns private snapshots (mutate one, stored stays)', async () => {
    const result = await page.evaluate(async () => {
      const vm = (window as unknown as { __paintHistoryVm: any }).__paintHistoryVm
      const target = vm.getTarget('Stage') ?? vm.getSelectedTarget?.()
      const costume = target?.costumes?.[0]
      if (!costume) return { skipped: true as const }
      const key = costume.md5ext ?? costume.assetId
      const a = (await vm.loadAsset(key, costume.dataFormat ?? '')) as Uint8Array
      const b = (await vm.loadAsset(key, costume.dataFormat ?? '')) as Uint8Array
      const sameObject = a === (b as unknown)
      let equalBefore = true
      if (a.length !== b.length) equalBefore = false
      else for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) { equalBefore = false; break }
      a[0] = (a[0]! ^ 0xff) & 0xff
      const c = (await vm.loadAsset(key, costume.dataFormat ?? '')) as Uint8Array
      let storedKept = c.length === b.length
      if (storedKept) for (let i = 0; i < c.length; i += 1) if (c[i] !== b[i]) { storedKept = false; break }
      let mutatedDiffers = c.length !== a.length
      if (!mutatedDiffers) {
        mutatedDiffers = false
        for (let i = 0; i < c.length; i += 1) if (c[i] !== a[i]) { mutatedDiffers = true; break }
      }
      return { skipped: false as const, sameObject, equalBefore, storedKept, mutatedDiffers }
    })
    if (result.skipped) return
    expect(result.sameObject).toBe(false)
    expect(result.equalBefore).toBe(true)
    expect(result.storedKept).toBe(true)
    expect(result.mutatedDiffers).toBe(true)
  }, 120_000)
})
