// Vector move fastpath audit: shifted-cache exactness + commit-guard isolation.
//
// Real Editor + real VM + real Paper.js in Chromium (CHROME_BIN), no reference
// source copied, Editor UI only (no bitmap).
//
// Axis 1 (metadata/selection exactness): a hostile display-space SVG (nested
// translate>scale>rotate ancestry, path curves, rects with stroke, ellipse,
// line, polygon, text, multi-path `<g>` unit, userSpaceOnUse gradient, filter,
// clipPath, inherited paint) is moved through the REAL commit geometry
// (`moveVectorElementBy`) and compared against the fastpath cache
// (`buildVectorMovePreviewSvg` + `shiftVectorMoveBounds`) and an independent
// fresh `paperVectorObjectList` for the same bytes — exact, including
// selected mask/path points, plus Alt-duplicate selection indexes and
// artboard rotationCenter/resolution invariance.
//
// Axis 2 (concurrency): a direct-VM same-slot external mutation landing
// between the move CAS and the reactive `assetSignature` effect while the
// commit guard is armed must not be swallowed — barrier isolation on target
// plus asset identity/generation/writeSeq. Covers a forced different-green
// write injected immediately after the own CAS (before settle: external must
// win, UI must refresh, exact undo must not corrupt) and a forced
// metadata-only rename (same bytes, bumped writeSeq).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const CHROME_PATH = process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let base = ''

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

const fnv1a32 = (bytes: Uint8Array) => {
  let h = 0x811c9dc5
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Hostile display-space SVG (480x360 viewBox, as served by currentSvgDocument).
const TRICKY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">` +
  `<defs>` +
  `<linearGradient id="audGrad" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="140" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#ff0000"/><stop offset="0.51" stop-color="#0000ff"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
  `<clipPath id="audClip"><rect x="20" y="40" width="60" height="100"/></clipPath>` +
  `<filter id="audBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter>` +
  `</defs>` +
  `<g transform="translate(40 20)"><g transform="scale(1.2)"><g transform="rotate(10 80 80)">` +
  `<rect x="20" y="40" width="120" height="100" fill="url(#audGrad)" clip-path="url(#audClip)" stroke="#111111" stroke-width="2"/>` +
  `<rect x="200" y="60" width="80" height="60" fill="#2ecc71" stroke="#111111" stroke-width="6" filter="url(#audBlur)"/>` +
  `</g></g></g>` +
  `<path d="M10 200 C 60 180, 90 230, 140 205 S 200 190, 230 210" fill="none" stroke="#e74c3c" stroke-width="6"/>` +
  `<rect x="-30" y="250" width="70" height="50" fill="#3498db" stroke="#000000" stroke-width="3"/>` +
  `<ellipse cx="330" cy="80" rx="45" ry="25" fill="#f1c40f" stroke="#111111" stroke-width="2"/>` +
  `<line x1="300" y1="250" x2="380" y2="300" stroke="#8e44ad" stroke-width="4"/>` +
  `<polygon points="250,260 290,260 270,300" fill="#1abc9c"/>` +
  `<g fill="#e67e22"><path d="M360 240 l40 0 l0 30 l-40 0 Z"/><path d="M365 280 l30 0 l-15 25 Z"/></g>` +
  `<text x="120" y="320" font-size="28" fill="#2c3e50">audit</text>` +
  `</svg>`

function simpleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect x="120" y="110" width="140" height="100" fill="#e74c3c" stroke="#111111" stroke-width="2"/><rect x="300" y="150" width="90" height="70" fill="#2980b9" stroke="#111111" stroke-width="2"/></svg>`
}

function buildSb3(svg: string, targetName: string): Buffer {
  const bytes = new TextEncoder().encode(svg)
  const hash = fnv1a32(bytes)
  return Buffer.from(zipSync({
    'project.json': strToU8(JSON.stringify({
      targets: [{
        isStage: false, name: targetName, variables: {}, lists: {}, broadcasts: {}, blocks: {},
        currentCostume: 0,
        costumes: [{ name: 'art', assetId: hash, md5ext: `${hash}.svg`, dataFormat: 'svg', bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
      }],
      monitors: [], extensions: [],
      meta: { semver: '3.0.0', vm: 'move-fastpath-audit', agent: 'move-fastpath-audit' },
    })),
    [`${hash}.svg`]: bytes,
  }))
}

async function openCostumes(page: Page, svg: string, targetName: string) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('project-file-input').setInputFiles({ name: 'audit.sb3', mimeType: 'application/x.scratch.sb3', buffer: buildSb3(svg, targetName) })
  await page.waitForFunction((want: string) => {
    const api = (window as unknown as { __hikkakuEditorTest?: { status?: () => string; snapshot?: () => { project?: { targets?: { name?: string }[] } } } }).__hikkakuEditorTest
    if (!api || api.status?.() !== 'Project loaded') return false
    return api.snapshot()?.project?.targets?.some((t) => t.name === want) ?? false
  }, targetName, { timeout: 30_000 })
  await page.getByTestId('main-tab-costumes').click()
  await page.getByTestId('costume-paint-surface').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
}

async function selectAll(page: Page) {
  await page.getByTestId('vector-shape-select').last().click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByTestId('costume-paint-surface').click({ position: { x: 10, y: 10 } }).catch(() => {})
  await page.waitForTimeout(200)
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
  await page.waitForTimeout(600)
}

async function outlineCenter(page: Page) {
  const target = page.locator('[data-vector-selection-outline]').last()
  await target.waitFor({ state: 'visible', timeout: 20_000 })
  const box = await target.boundingBox()
  if (!box) throw new Error('missing outline box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function log(label: string, value: unknown) {
  console.log(`[fastpath-audit] ${label} ${JSON.stringify(value).slice(0, 4000)}`)
}

describe('vector move fastpath audit (new tests only)', () => {
  beforeAll(async () => {
    const port = await getFreePort()
    base = `http://127.0.0.1:${port}/test/paint-history-isolation-fixture.html`
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' })
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`Vite failed to start on ${port}`)
    browser = await launchBrowser({ executablePath: CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 120_000)
  afterAll(async () => { await browser?.close(); server?.kill() })

  it('shifted cache equals the independent Paper list for hostile artwork (exact)', async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page: Page = await context.newPage()
    try {
      await openCostumes(page, TRICKY_SVG, 'Audit')
      const report = await page.evaluate(async ({ source, total }: { source: string; total: { x: number; y: number } }) => {
        const preview = await import(/* @vite-ignore */ '/src/features/costumes/vector-move-preview.ts')
        const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const svgmod = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const drag = await import(/* @vite-ignore */ '/src/features/costumes/vector-move-drag.ts')
        const norm = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
        const cmpObjects = (fast: unknown[], oracle: unknown[]) => {
          const issues: string[] = []
          let maxBoundsDiff = 0
          let maxPointDiff = 0
          if (fast.length !== oracle.length) issues.push(`length fast=${fast.length} oracle=${oracle.length}`)
          const n = Math.min(fast.length, oracle.length)
          for (let i = 0; i < n; i++) {
            const f = fast[i] as Record<string, unknown>
            const o = oracle[i] as Record<string, unknown>
            if (f.index !== o.index) issues.push(`[${i}] index fast=${f.index} oracle=${o.index}`)
            if ((f.tag as string) !== (o.tag as string)) issues.push(`[${i}] tag fast=${f.tag} oracle=${o.tag}`)
            for (const k of ['boundsX', 'boundsY', 'boundsWidth', 'boundsHeight']) {
              const d = Math.abs(Number(f[k]) - Number(o[k]))
              if (Number.isFinite(d)) maxBoundsDiff = Math.max(maxBoundsDiff, d)
              if (!(d <= 1e-6)) issues.push(`[${i}] ${k} fast=${f[k]} oracle=${o[k]}`)
            }
            for (const k of ['x', 'y', 'width', 'height', 'rotation', 'strokeWidth', 'opacity']) {
              const a = norm(f[k])
              const b = norm(o[k])
              if (a === undefined || b === undefined) {
                if (a !== b) issues.push(`[${i}] ${k} fast=${String(f[k])} oracle=${String(o[k])}`)
              } else if (Math.abs(a - b) > 1e-6) issues.push(`[${i}] ${k} fast=${a} oracle=${b}`)
            }
            for (const k of ['fill', 'stroke', 'text', 'label']) {
              if ((f[k] ?? undefined) !== (o[k] ?? undefined)) issues.push(`[${i}] ${k} fast=${String(f[k])} oracle=${String(o[k])}`)
            }
            const fp = (f.points ?? []) as { x: number; y: number; kind?: string; controlRole?: string; relatedAnchorIndex?: number; index?: number }[]
            const op = (o.points ?? []) as { x: number; y: number; kind?: string; controlRole?: string; relatedAnchorIndex?: number; index?: number }[]
            if (fp.length !== op.length) {
              issues.push(`[${i}] points length fast=${fp.length} oracle=${op.length}`)
            } else {
              for (let j = 0; j < op.length; j++) {
                const d = Math.max(Math.abs(fp[j]!.x - op[j]!.x), Math.abs(fp[j]!.y - op[j]!.y))
                maxPointDiff = Math.max(maxPointDiff, d)
                if (d > 1e-6) { issues.push(`[${i}] point ${j} fast=(${fp[j]!.x},${fp[j]!.y}) oracle=(${op[j]!.x},${op[j]!.y})`); break }
                if (fp[j]!.kind !== op[j]!.kind || (fp[j]!.controlRole ?? null) !== (op[j]!.controlRole ?? null) ||
                  (fp[j]!.relatedAnchorIndex ?? null) !== (op[j]!.relatedAnchorIndex ?? null) || fp[j]!.index !== op[j]!.index) {
                  issues.push(`[${i}] point ${j} mask fast=${fp[j]!.kind}/${fp[j]!.controlRole}/${fp[j]!.relatedAnchorIndex}/${fp[j]!.index} oracle=${op[j]!.kind}/${op[j]!.controlRole}/${op[j]!.relatedAnchorIndex}/${op[j]!.index}`)
                  break
                }
              }
            }
          }
          return { issues: issues.slice(0, 25), maxBoundsDiff, maxPointDiff }
        }
        // Base oracle state (independent Paper list, as after a full reload).
        const base = (await (paper as unknown as { paperVectorObjectList: (s: string) => Promise<unknown[]> }).paperVectorObjectList(source)) as unknown as { index: number; tag: string }[]
        const unitCount = base.length
        const unitTags = base.map((o) => `${o.index}:${o.tag}`)
        // Selection mixing nested-ancestry rects, path, rect, ellipse, line,
        // polygon, the multi-path g unit and text (indexes resolved live so
        // the hostile sample stays valid if unitization changes).
        const wantTags = ['rect', 'path', 'rect', 'ellipse', 'line', 'polygon', 'g', 'text']
        const selection: number[] = []
        const used = new Set<number>()
        for (const tag of wantTags) {
          const hit = base.find((o) => o.tag === tag && !used.has(o.index))
          if (hit) { selection.push(hit.index); used.add(hit.index) }
        }
        if (selection.length < 5) return { invalid: `only ${selection.length} units (${unitTags.join(',')})` }
        // --- Plain move leg ---
        const built = (preview as unknown as { buildVectorMovePreviewSvg: (s: string, sel: number[], t: { x: number; y: number }, o?: unknown) => { svgText: string; selection: number[] } | undefined }).buildVectorMovePreviewSvg(source, selection, total)
        if (!built) return { invalid: 'preview refused the hostile move' }
        const commitDoc = new DOMParser().parseFromString(source, 'image/svg+xml')
        const commitSvg = commitDoc.documentElement
        const commitUnits = (svgmod as unknown as { editableVectorUnits: (s: Element) => Element[] }).editableVectorUnits(commitSvg)
        for (const index of built.selection) {
          const el = commitUnits[index]
          if (!el) return { invalid: `commit unit ${index} missing` }
          await (paper as unknown as { moveVectorElementBy: (e: Element, x: number, y: number) => Promise<boolean> }).moveVectorElementBy(el, total.x, total.y)
        }
        const editedText = new XMLSerializer().serializeToString(commitDoc.documentElement)
        const oracle = await (paper as unknown as { paperVectorObjectList: (s: string) => Promise<unknown[]> }).paperVectorObjectList(editedText)
        const fast = (preview as unknown as { shiftVectorMoveBounds: (o: unknown[], s: number[], t: { x: number; y: number }) => unknown[] }).shiftVectorMoveBounds(
          base as unknown[], built.selection, total,
        )
        const plain = cmpObjects(fast, oracle)
        // --- Alt-duplicate leg ---
        const builtDup = (preview as unknown as { buildVectorMovePreviewSvg: (s: string, sel: number[], t: { x: number; y: number }, o?: unknown) => { svgText: string; selection: number[] } | undefined }).buildVectorMovePreviewSvg(source, selection, total, { duplicate: true })
        let dup: { issues: string[]; maxBoundsDiff: number; maxPointDiff: number } | { skipped: string } = { skipped: 'no-dup' }
        let dupSelection: number[] = []
        if (builtDup) {
          const dupDoc = new DOMParser().parseFromString(source, 'image/svg+xml')
          const dupSvg = dupDoc.documentElement
          let dupUnits = (svgmod as unknown as { editableVectorUnits: (s: Element) => Element[] }).editableVectorUnits(dupSvg)
          const pressSel = [...selection].sort((a, b) => a - b)
          const clones = (drag as unknown as { duplicateVectorUnits: (s: Element, sel: number[]) => number[] }).duplicateVectorUnits(dupSvg, pressSel)
          dupUnits = (svgmod as unknown as { editableVectorUnits: (s: Element) => Element[] }).editableVectorUnits(dupSvg)
          for (const index of clones) {
            const el = dupUnits[index]
            if (el) await (paper as unknown as { moveVectorElementBy: (e: Element, x: number, y: number) => Promise<boolean> }).moveVectorElementBy(el, total.x, total.y)
          }
          const dupEdited = new XMLSerializer().serializeToString(dupDoc.documentElement)
          const dupOracle = await (paper as unknown as { paperVectorObjectList: (s: string) => Promise<unknown[]> }).paperVectorObjectList(dupEdited)
          const dupFast = (preview as unknown as { shiftVectorMoveBounds: (o: unknown[], s: number[], t: { x: number; y: number }, o2?: unknown) => unknown[] }).shiftVectorMoveBounds(
            base as unknown[], clones, total, { duplicated: true, sources: pressSel },
          )
          dup = cmpObjects(dupFast, dupOracle)
          dupSelection = [...builtDup.selection].sort((a, b) => a - b)
          const wantSel = [...clones].sort((a, b) => a - b)
          if (JSON.stringify(dupSelection) !== JSON.stringify(wantSel)) {
            dup = { issues: [`dup selection preview=${JSON.stringify(dupSelection)} commit=${JSON.stringify(wantSel)}`, ...(dup as { issues: string[] }).issues ?? []], maxBoundsDiff: (dup as { maxBoundsDiff: number }).maxBoundsDiff ?? 0, maxPointDiff: (dup as { maxPointDiff: number }).maxPointDiff ?? 0 }
          }
          if (dupOracle.length !== base.length + pressSel.length) {
            const d = dup as { issues: string[]; maxBoundsDiff: number; maxPointDiff: number }
            d.issues.unshift(`dup length oracle=${dupOracle.length} base=${base.length} sources=${pressSel.length}`)
          }
        }
        // --- Runtime/artboard axis: the shifted cache must imply the SAME
        // tight viewBox / rotationCenter as the independent Paper list (a
        // subset move legitimately changes the union extremes, so compare
        // fast-vs-oracle with the identical floor/ceil formula instead of
        // asserting size preservation). Resolution stays vector (1).
        const runtimeOfBoxes = (boxes: { x: number; y: number; width: number; height: number }[]) => {
          const live = boxes.filter((b) => b.width > 0 || b.height > 0)
          const left = Math.floor(Math.min(...live.map((b) => b.x)) - 2)
          const top = Math.floor(Math.min(...live.map((b) => b.y)) - 2)
          const right = Math.ceil(Math.max(...live.map((b) => b.x + b.width)) + 2)
          const bottom = Math.ceil(Math.max(...live.map((b) => b.y + b.height)) + 2)
          return { left, top, width: right - left, height: bottom - top, rcx: 240 - left, rcy: 180 - top }
        }
        const boxOf = (o: unknown) => {
          const v = o as { boundsX: number; boundsY: number; boundsWidth: number; boundsHeight: number }
          return { x: v.boundsX, y: v.boundsY, width: v.boundsWidth, height: v.boundsHeight }
        }
        return {
          unitCount, unitTags, selection: [...selection].sort((a, b) => a - b), active: [...built.selection].sort((a, b) => a - b),
          previewEqualsCommitBytes: built.svgText === editedText,
          plain, dup, dupSelection,
          runtimeFast: runtimeOfBoxes((fast as unknown[]).map(boxOf)),
          runtimeOracle: runtimeOfBoxes((oracle as unknown[]).map(boxOf)),
        }
      }, { source: TRICKY_SVG, total: { x: 37.5, y: -22.25 } })
      log('exactness', report)
      if ((report as { invalid?: string }).invalid) throw new Error(`INVALID: ${(report as { invalid?: string }).invalid}`)
      const r = report as {
        unitCount: number; unitTags: string[]; selection: number[]; active: number[]
        previewEqualsCommitBytes: boolean
        plain: { issues: string[]; maxBoundsDiff: number; maxPointDiff: number }
        dup: { issues?: string[]; skipped?: string; maxBoundsDiff?: number; maxPointDiff?: number }
        dupSelection: number[]
        runtimeFast: { left: number; top: number; width: number; height: number; rcx: number; rcy: number }
        runtimeOracle: { left: number; top: number; width: number; height: number; rcx: number; rcy: number }
      }
      expect(r.unitCount).toBeGreaterThanOrEqual(8)
      expect(r.previewEqualsCommitBytes).toBe(true)
      expect(r.plain.issues).toEqual([])
      const dup = r.dup as { issues: string[]; skipped?: string }
      expect(dup.skipped).toBeUndefined()
      expect(dup.issues).toEqual([])
      // The cache implies the same artboard metadata as a full reload.
      expect(r.runtimeFast).toEqual(r.runtimeOracle)
    } finally { await context.close() }
  }, 240_000)

  it('post-CAS external green wins: UI refreshes, exact undo, no corruption', async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page: Page = await context.newPage()
    try {
      await openCostumes(page, simpleSvg(), 'Mover')
      await selectAll(page)
      const outlinesBefore = await page.locator('[data-vector-selection-outline]').count()
      expect(outlinesBefore).toBeGreaterThanOrEqual(2)
      const baseSvg = await page.locator('.vector-preview').innerHTML()
      // Wrapper: let the own move CAS apply, then land a direct-VM same-slot
      // external green via the OFFICIAL `vm.updateCostume` API (different
      // bytes + automatic seq bump + emit) BEFORE the CAS returns — i.e.
      // strictly between the own mutation and the reactive assetSignature
      // effect while the commit guard is armed. Captures target/writeSeq and
      // order so the audit proves the external is the later write.
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown> & { __paintHistoryVm?: { updateCostumeIfMatch?: (...a: unknown[]) => Promise<{ applied: boolean; current?: unknown }> } }
        const vm = w.__paintHistoryVm
        if (!vm || typeof vm.updateCostumeIfMatch !== 'function') throw new Error('missing VM CAS')
        if ((vm.updateCostumeIfMatch as unknown as { __auditArmed?: boolean }).__auditArmed) return
        const orig = vm.updateCostumeIfMatch.bind(vm)
        const fn = async (...a: unknown[]) => {
          const result = await (orig as (...a: unknown[]) => Promise<{ applied: boolean; current?: unknown }>)(...a)
          if (!(fn as unknown as { __fired?: boolean }).__fired) {
            (fn as unknown as { __fired?: boolean }).__fired = true
            const v = w.__paintHistoryVm as unknown as {
              getTarget: (n: string) => { id?: string; name: string; costumes: { assetId?: string; md5ext?: string; dataFormat?: string }[] }
              loadAsset: (k: string, f: string) => Promise<Uint8Array>
              updateCostume: (t: string, i: number, p: unknown, d: Uint8Array) => Promise<void>
              getCostumeIdentity?: (t: string, i: number) => { assetId?: string; md5ext?: string; writeSeq?: number } | undefined
            }
            const tgt = v.getTarget('Mover')
            const stableId = tgt.id ?? 'Mover'
            const ownCurrent = (result as { current?: { md5ext?: string; assetId?: string; writeSeq?: number } }).current
            const preExternal = v.getCostumeIdentity?.(stableId, 0)
            const before = tgt.costumes[0]!
            const liveBytes = await v.loadAsset(before.md5ext ?? before.assetId ?? '', before.dataFormat ?? 'svg')
            const liveText = new TextDecoder().decode(liveBytes)
            const externalText = liveText.replace(/#e74c3c/g, '#00e676')
            await v.updateCostume('Mover', 0, { dataFormat: 'svg' }, new TextEncoder().encode(externalText))
            const postExternal = v.getCostumeIdentity?.(stableId, 0)
            ;(window as unknown as Record<string, unknown>).__auditExternal = externalText
            ;(window as unknown as Record<string, unknown>).__auditOrder = {
              targetId: stableId,
              index: 0,
              own: ownCurrent ? { md5ext: ownCurrent.md5ext ?? null, assetId: ownCurrent.assetId ?? null, writeSeq: ownCurrent.writeSeq ?? null } : null,
              pre: preExternal ? { md5ext: preExternal.md5ext ?? null, assetId: preExternal.assetId ?? null, writeSeq: preExternal.writeSeq ?? null } : null,
              post: postExternal ? { md5ext: postExternal.md5ext ?? null, assetId: postExternal.assetId ?? null, writeSeq: postExternal.writeSeq ?? null } : null,
            }
          }
          return result
        }
        ;(fn as unknown as { __auditArmed?: boolean }).__auditArmed = true
        vm.updateCostumeIfMatch = fn as never
      })
      const pairBefore = await page.evaluate(() => {
        const vis = (el: Element | null) => {
          if (!(el instanceof HTMLElement)) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        let undo = false
        let redo = false
        for (const b of Array.from(document.querySelectorAll('button[aria-label="Undo"]'))) {
          if (vis(b) && !(b as HTMLButtonElement).disabled) undo = true
        }
        for (const b of Array.from(document.querySelectorAll('button[aria-label="Redo"]'))) {
          if (vis(b) && !(b as HTMLButtonElement).disabled) redo = true
        }
        return { undo, redo }
      })
      const from = await outlineCenter(page)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 60, from.y + 12, { steps: 8 })
      await page.waitForTimeout(400)
      await page.mouse.up()
      await page.waitForTimeout(2200)
      const status: string = await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status?: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
      const afterSvg: string = await page.locator('.vector-preview').innerHTML()
      const liveText: string = await page.evaluate(async () => {
        const vm = (window as unknown as { __paintHistoryVm?: { getTarget: (n: string) => { costumes: { md5ext?: string; assetId?: string; dataFormat?: string }[] }; loadAsset: (k: string, f: string) => Promise<Uint8Array> } }).__paintHistoryVm
        const tgt = vm!.getTarget('Mover')
        const c = tgt.costumes[0]!
        const bytes = await vm!.loadAsset(c.md5ext ?? c.assetId ?? '', c.dataFormat ?? 'svg')
        return new TextDecoder().decode(bytes)
      })
      const externalText = await page.evaluate(() => (window as unknown as { __auditExternal?: string }).__auditExternal ?? '')
      const auditOrder = await page.evaluate(() => (window as unknown as { __auditOrder?: unknown }).__auditOrder ?? null)
      log('post-CAS green', { status, liveHasGreen: liveText.includes('#00e676'), previewHasGreen: afterSvg.includes('#00e676'), externalLen: externalText.length, liveLen: liveText.length, pairBefore, auditOrder })
      // Order proof: the official-API external is strictly later than the own CAS.
      if (auditOrder && typeof auditOrder === 'object') {
        const order = auditOrder as { own?: { writeSeq?: number | null }; post?: { writeSeq?: number | null }; targetId?: string }
        expect(order.targetId).toBeTruthy()
        if (typeof order.own?.writeSeq === 'number' && typeof order.post?.writeSeq === 'number') {
          expect(order.post.writeSeq).toBeGreaterThan(order.own.writeSeq)
        }
      }
      // Fail-safe: the external (later write) must win in VM and on screen.
      expect(externalText.length).toBeGreaterThan(0)
      expect(liveText).toBe(externalText)
      expect(afterSvg).toContain('#00e676')
      expect(status).toContain('External costume change kept')
      // Exact undo: the dropped own move committed no history; Undo must not
      // touch the external bytes (fail-closed, stack unchanged).
      const pairAfter = await page.evaluate(() => {
        const vis = (el: Element | null) => {
          if (!(el instanceof HTMLElement)) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        let undo = false
        let redo = false
        for (const b of Array.from(document.querySelectorAll('button[aria-label="Undo"]'))) {
          if (vis(b) && !(b as HTMLButtonElement).disabled) undo = true
        }
        for (const b of Array.from(document.querySelectorAll('button[aria-label="Redo"]'))) {
          if (vis(b) && !(b as HTMLButtonElement).disabled) redo = true
        }
        return { undo, redo }
      })
      expect(pairAfter).toEqual(pairBefore)
      if (pairAfter.undo) {
        await page.getByRole('button', { name: 'Undo' }).last().click()
        await page.waitForTimeout(900)
        const liveAfterUndo: string = await page.evaluate(async () => {
          const vm = (window as unknown as { __paintHistoryVm?: { getTarget: (n: string) => { costumes: { md5ext?: string; assetId?: string; dataFormat?: string }[] }; loadAsset: (k: string, f: string) => Promise<Uint8Array> } }).__paintHistoryVm
          const tgt = vm!.getTarget('Mover')
          const c = tgt.costumes[0]!
          const bytes = await vm!.loadAsset(c.md5ext ?? c.assetId ?? '', c.dataFormat ?? 'svg')
          return new TextDecoder().decode(bytes)
        })
        expect(liveAfterUndo).toBe(externalText)
      }
      expect(afterSvg).not.toBe(baseSvg)
    } finally { await context.close() }
  }, 240_000)

  it('metadata-only rename right after the own CAS stays fail-safe for undo', async () => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page: Page = await context.newPage()
    try {
      await openCostumes(page, simpleSvg(), 'Mover')
      await selectAll(page)
      const from = await outlineCenter(page)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 40, from.y - 8, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(1800)
      const movedSvg: string = await page.locator('.vector-preview').innerHTML()
      // Forced metadata-only rename: same bytes, new display name, bumped
      // writeSeq (direct VM, bypassing the rename layer on purpose).
      const rename = await page.evaluate(async () => {
        const vm = (window as unknown as { __paintHistoryVm?: {
          getTarget: (n: string) => { id?: string; name: string; costumes: { name?: string; assetId?: string; md5ext?: string; dataFormat?: string }[] }
          updateCostume: (t: string, i: number, p: unknown, d?: Uint8Array) => Promise<unknown>
          getCostumeIdentity?: (t: string, i: number) => { writeSeq?: number } | undefined
        } }).__paintHistoryVm
        const tgt = vm!.getTarget('Mover')
        const id = tgt.id ?? 'Mover'
        const before = vm!.getCostumeIdentity?.(id, 0)?.writeSeq
        await vm!.updateCostume('Mover', 0, { name: 'ExtRenamed' })
        const after = vm!.getCostumeIdentity?.(id, 0)?.writeSeq
        return { name: tgt.costumes[0]!.name, before, after }
      })
      log('rename', rename)
      expect(rename.name).toBe('ExtRenamed')
      await page.getByRole('button', { name: 'Undo' }).last().click()
      await page.waitForTimeout(900)
      const status: string = await page.evaluate(() => (window as unknown as { __hikkakuEditorTest?: { status?: () => string } }).__hikkakuEditorTest?.status?.() ?? '')
      const liveName: string = await page.evaluate(() => {
        const vm = (window as unknown as { __paintHistoryVm?: { getTarget: (n: string) => { costumes: { name?: string }[] } } }).__paintHistoryVm
        return vm?.getTarget('Mover')?.costumes[0]?.name ?? ''
      })
      const liveSvg: string = await page.evaluate(async () => {
        const vm = (window as unknown as { __paintHistoryVm?: { getTarget: (n: string) => { costumes: { md5ext?: string; assetId?: string; dataFormat?: string }[] }; loadAsset: (k: string, f: string) => Promise<Uint8Array> } }).__paintHistoryVm
        const tgt = vm!.getTarget('Mover')
        const c = tgt.costumes[0]!
        const bytes = await vm!.loadAsset(c.md5ext ?? c.assetId ?? '', c.dataFormat ?? 'svg')
        return new TextDecoder().decode(bytes)
      })
      log('rename undo', { status, liveName })
      // The rename (later version, same bytes) must survive: Undo fails
      // closed instead of deleting the external rename.
      expect(liveName).toBe('ExtRenamed')
      expect(status).toContain('External costume change kept')
      expect(liveSvg).not.toBe('')
      void movedSvg
    } finally { await context.close() }
  }, 240_000)
})
