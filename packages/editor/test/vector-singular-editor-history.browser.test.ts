import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Real-Editor history guard for singular transforms.
//
// Drives the REAL editor bundle in Chromium (Vite + real DOMParser/XMLSerializer
// + Paper.js) through the same peek→commit rule Editor.svelte now uses for
// move/resize/rotate/flip/reshape/group/keyboard:
//   const pending = await peekCostumeHistory(...); // no stack touch
//   const applied = await helper(...);             // false = DOM untouched
//   if (applied) commitPaintHistory(pending);      // exactly one entry
// A refused (singular) write must leave undo/redo byte-identical (redo
// preserved); a normal write must push exactly one entry and clear redo.
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4261'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

describe('singular editor history guard (real Editor bundle)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4261', '--strictPort'], {
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

  it('singular ops stay history-free with redo preserved; normal ops push exactly one entry', async () => {
    const result = await page.evaluate(async () => {
      const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
      const pathPoints = await import(/* @vite-ignore */ '/src/features/costumes/vector-path-points.ts')
      const svgMod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')

      const singularSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(0)"><rect x="10" y="10" width="20" height="20" fill="red"/><path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" fill="blue"/></g></svg>'
      const normalSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="20" fill="red"/><path d="M 60 10 L 100 10 L 100 50 L 60 50 Z" fill="blue"/></svg>'

      const parseUnits = (text: string) => {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
        return { doc, units: svgMod.editableVectorUnits(doc.documentElement) }
      }

      // Minimal Editor-like stacks: peek is side-effect free, commit pushes one
      // entry and clears redo. The async scope guard is trivially current here.
      const runSuite = async (svgText: string) => {
        let undo = ['base']
        let redo = ['stale-redo']
        const peek = () => 'pending'
        const commit = (entry: string) => {
          undo.push(entry)
          redo = []
        }
        const outcomes: Record<string, boolean> = {}
        // move (keyboard/nudge + drag share moveVectorElementBy)
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          let appliedAny = false
          for (const el of units) {
            if (await paper.moveVectorElementBy(el, 12, -7)) appliedAny = true
          }
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (appliedAny) commit(pending)
          outcomes.move = appliedAny
          outcomes.moveChanged = changed
        }
        // resize single (se handle)
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          const applied = await paper.resizeVectorElementBy(units[0]!, 'se', 15, 11)
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (applied) commit(pending)
          outcomes.resize = applied
          outcomes.resizeChanged = changed
        }
        // rotate arrangement around shared center
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          const bounds = await paper.vectorSelectionBounds(units)
          const center = bounds ? { x: bounds.centerX, y: bounds.centerY } : { x: 0, y: 0 }
          const applied = bounds ? paper.rotateVectorElementsAroundCenter(units, 30, center) : false
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (applied) commit(pending)
          outcomes.rotate = applied
          outcomes.rotateChanged = changed
        }
        // flip arrangement
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          const bounds = await paper.vectorSelectionBounds(units)
          const center = bounds ? { x: bounds.centerX, y: bounds.centerY } : { x: 0, y: 0 }
          const applied = bounds ? paper.flipVectorElementsAroundCenter(units, true, center) : false
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (applied) commit(pending)
          outcomes.flip = applied
          outcomes.flipChanged = changed
        }
        // multi common-bounds scale (shared resize handle path)
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          const applied = paper.scaleVectorElementsByCommonBounds(units, 'se', 15, 11)
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (applied) commit(pending)
          outcomes.multiScale = applied
          outcomes.multiScaleChanged = changed
        }
        // single flip helper (addVectorFlip leaf-local conjugation)
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          const applied = svgMod.addVectorFlip(units[0]!, true)
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (applied) commit(pending)
          outcomes.singleFlip = applied
          outcomes.singleFlipChanged = changed
        }
        // reshape single anchor (control/drag path)
        {
          const { doc, units } = parseUnits(svgText)
          const pathEl = units.find((el: Element) => el.tagName.toLowerCase() === 'path')
          let applied = false
          let changed = false
          if (pathEl) {
            const before = new XMLSerializer().serializeToString(doc.documentElement)
            const pending = peek()
            applied = await paper.moveVectorEditablePoint(pathEl, 0, 77, 71)
            changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
            if (applied) commit(pending)
          }
          outcomes.reshape = applied
          outcomes.reshapeChanged = changed
        }
        // reshape bulk anchors (multi-point drag path)
        {
          const { doc, units } = parseUnits(svgText)
          const pathEl = units.find((el: Element) => el.tagName.toLowerCase() === 'path')
          let applied = false
          let changed = false
          if (pathEl) {
            const before = new XMLSerializer().serializeToString(doc.documentElement)
            const pending = peek()
            const res = await pathPoints.moveVectorReshapePoints(pathEl, [{ index: 0, x: 71, y: 73 }])
            applied = res.moved
            changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
            if (applied) commit(pending)
          }
          outcomes.bulkReshape = applied
          outcomes.bulkReshapeChanged = changed
        }
        // keyboard nudge equivalent (4px arrow step through the multi path)
        {
          const { doc, units } = parseUnits(svgText)
          const before = new XMLSerializer().serializeToString(doc.documentElement)
          const pending = peek()
          let appliedAny = false
          for (const el of units) {
            if (await paper.moveVectorElementBy(el, 4, 0)) appliedAny = true
          }
          const changed = new XMLSerializer().serializeToString(doc.documentElement) !== before
          if (appliedAny) commit(pending)
          outcomes.keyboard = appliedAny
          outcomes.keyboardChanged = changed
        }
        return { outcomes, undoLength: undo.length, redoLength: redo.length, redoKept: redo.length > 0 ? redo[0] : null }
      }

      const singular = await runSuite(singularSvg)
      const normal = await runSuite(normalSvg)
      return { singular, normal }
    })
    // Singular: every fail-closed op refuses with DOM untouched, so the
    // Editor peek is discarded — undo stays at base, redo is preserved.
    expect(result.singular.undoLength).toBe(1)
    expect(result.singular.redoLength).toBe(1)
    expect(result.singular.redoKept).toBe('stale-redo')
    for (const key of ['move', 'resize', 'rotate', 'flip', 'multiScale', 'singleFlip', 'reshape', 'bulkReshape', 'keyboard'] as const) {
      expect(result.singular.outcomes[key]).toBe(false)
      expect(result.singular.outcomes[`${key}Changed` as keyof typeof result.singular.outcomes]).toBe(false)
    }
    // Normal artwork: each of the 9 ops applies and commits exactly one entry
    // (base + 9), clearing the stale redo.
    expect(result.normal.undoLength).toBe(1 + 9)
    expect(result.normal.redoLength).toBe(0)
    for (const key of ['move', 'resize', 'rotate', 'flip', 'multiScale', 'singleFlip', 'reshape', 'bulkReshape', 'keyboard'] as const) {
      expect(result.normal.outcomes[key]).toBe(true)
      expect(result.normal.outcomes[`${key}Changed` as keyof typeof result.normal.outcomes]).toBe(true)
    }
  }, 60_000)
})
