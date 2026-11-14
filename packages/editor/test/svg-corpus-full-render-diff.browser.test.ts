/**
 * Full-corpus (785 files) real-Chrome pixel comparison: sanitizer before/after.
 *
 * Successor of `svg-corpus-render-diff-tmp.browser.test.ts` (stride-sampled 120
 * of 785). This suite renders the ENTIRE bundled corpus
 * (`packages/editor/public/assets-scratch/images/*.svg`) in real Chrome and
 * compares Canvas pixels before vs. after:
 * - VM `sanitizeSvgText` (`@hikkaku/vm`, persistence boundary),
 * - editor `sanitizeSvgForDisplay` (`src/features/costumes/svg-sanitize.ts`,
 *   preview boundary),
 * - chained `original -> VM -> editor`.
 *
 * Safety contract (no product-code change; this file is the only addition):
 * - Network egress is forbidden: non-localhost http(s) is aborted + recorded
 *   via `page.route` and the suite fails on any hit. The dev-shell page itself
 *   lazy-loads its own assets (e.g. Blockly sprites) after `goto`, so every
 *   gate waits for network idle, resets the tap, and attributes requests to
 *   its own window (per-batch deltas are kept in the JSON report) — host-page
 *   noise can never be mistaken for a corpus fetch.
 * - Scripts never execute: corpus sources are rasterized ONLY through
 *   `<img>` + blob URL (image documents never run scripts) — never via
 *   `innerHTML`/live DOM. A canary `it` proves the path leaves a window
 *   marker untouched with zero requests.
 * - Every SVG source is inspected for external requests / dangerous URLs
 *   BEFORE any preview: the byte-identical `INSPECTOR_BODY` scanner runs in
 *   Node (pre-filter) and in Chrome (pre-raster gate). Flagged data is
 *   excluded without being rendered; the bundled corpus is expected to need
 *   zero exclusions (verified: only xmlns/DTD/generator-comment URLs exist).
 * - Load completion vs. timeout is distinguished: each raster reports
 *   `loaded | timeout | error | draw-error` (one immediate retry on timeout),
 *   and verdicts keep `render-timeout` separate from `load-error`.
 *
 * What this gates on: harness health (baseline loads), zero exclusions, zero
 * network egress, zero script execution, zero confirmed timeouts. Pixel
 * differences themselves are REPORTED (per-file verdicts + input snippets +
 * string-level causes + full JSON), not gated — the deliverable is the
 * changed/broken-material inventory.
 *
 * Run:
 *   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome \
 *     bun test test/svg-corpus-full-render-diff.browser.test.ts
 * from `packages/editor`. No `git stash/checkout/reset/restore/clean` is used.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { sanitizeSvgText } from '@hikkaku/vm'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const IMAGES_DIR = join(root, 'public', 'assets-scratch', 'images')
const base = 'http://127.0.0.1:4263'

const EXPECTED_CORPUS_TOTAL = 785
const BATCH_BYTE_BUDGET = 1_000_000
const CANVAS_W = 240
const CANVAS_H = 180
const ORIG_PAINTED_MIN = 500
const BLANK_PX = 10
const MAJOR_RATIO = 0.5
const MAJOR_ALPHA_DIFF = 0.3
const LOAD_TIMEOUT_MS = 5000

const PLACEHOLDER_SNIPPET = 'width="1" height="1"'
const PROBE_MARK = '__fullDiffProbe'

let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page
/** Non-localhost http(s) URLs the render attempted (aborted; expect none). */
let netHits: string[] = []

// ---------------------------------------------------------------------------
// Pre-preview inspector — byte-identical logic in Node and in Chrome.
//
// Pure-string scan (no DOM, no fetch, no execution). The body is plain JS
// (no type annotations) so `new Function` runs it unchanged on both sides.
// A source is SAFE only when it carries no external-request or
// dangerous-URL signal: comments/PIs/doctype are stripped first (generator
// URLs in comments never fetch), namespace declarations are stripped
// (never fetched), entities are unfolded once (encoded-scheme smuggling).
// ---------------------------------------------------------------------------
const INSPECTOR_BODY = `
  var reasons = [];
  var s = String(text == null ? '' : text);
  if (s.length === 0) return { safe: false, reasons: ['empty-input'] };
  var stripped = String(s)
    .replace(/<!--[\\s\\S]*?-->/g, '')
    .replace(/<\\?[\\s\\S]*?\\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/xmlns(?::[\\w-]+)?\\s*=\\s*"[^"]*"/g, '')
    .replace(/xmlns(?::[\\w-]+)?\\s*=\\s*'[^']*'/g, '');
  var decoded = String(stripped)
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, function (m, h) {
      try { var c = parseInt(h, 16); if (c > 0 && c <= 1114111) return String.fromCodePoint(c); } catch (e) {}
      return m;
    })
    .replace(/&#(\\d{1,7});?/g, function (m, d) {
      try { var c = parseInt(d, 10); if (c > 0 && c <= 1114111) return String.fromCodePoint(c); } catch (e2) {}
      return m;
    })
    .replace(/&(lt|gt|amp|quot|apos);?/gi, function (m, n) {
      var t = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[String(n).toLowerCase()];
      return t == null ? m : t;
    });
  var lower = decoded.toLowerCase();
  var tagRe = /<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|audio|video|source|track|canvas|applet|frame|frameset|foreignobject|mpath|handler|listener|animate|animatecolor|animatemotion|animatetransform|set|discard|cursor|font|a)(?=[\\s/>])/gi;
  var seenTags = {};
  var tm;
  while ((tm = tagRe.exec(decoded)) !== null) {
    var tn = String(tm[1]).toLowerCase();
    if (!seenTags[tn]) { seenTags[tn] = true; reasons.push('forbidden-tag:<' + tn + '>'); }
  }
  if (/(^|[\\s"'\\u0060/<>=])on[a-z][a-z0-9-]*\\s*=/i.test(decoded)) reasons.push('event-handler-attribute');
  if (lower.indexOf('javascript:') !== -1) reasons.push('scheme:javascript:');
  if (lower.indexOf('vbscript:') !== -1) reasons.push('scheme:vbscript:');
  if (lower.indexOf('data:text/html') !== -1) reasons.push('payload:data-text-html');
  if (lower.indexOf('data:image/svg') !== -1) reasons.push('payload:data-image-svg');
  if (lower.indexOf('data:text/javascript') !== -1) reasons.push('payload:data-text-javascript');
  if (lower.indexOf('data:application/xhtml') !== -1) reasons.push('payload:data-xhtml');
  var attrRe = /(^|[\\s"'\\u0060/])(src|srcset|formaction|action|poster|background|data|cite|longdesc|usemap|profile|codebase|archive|classid|imagesrcset|ping|content|lowsrc|dynsrc)\\s*=/i;
  var am = attrRe.exec(decoded);
  if (am) reasons.push('fetch-bearing-attribute:' + String(am[2]).toLowerCase());
  var urlRe = /url\\s*\\(\\s*("[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi;
  var um; var badUrl = false;
  while ((um = urlRe.exec(decoded)) !== null) {
    var target = String(um[1]).trim().replace(/^["']|[\"']$/g, '').trim();
    var tl = target.toLowerCase();
    if (target.charAt(0) === '#') continue;
    if (tl.indexOf('data:image/png;base64,') === 0) continue;
    if (tl.indexOf('data:image/jpeg;base64,') === 0) continue;
    if (tl.indexOf('data:image/jpg;base64,') === 0) continue;
    if (tl.indexOf('data:image/gif;base64,') === 0) continue;
    if (tl.indexOf('data:image/webp;base64,') === 0) continue;
    badUrl = true; break;
  }
  if (badUrl) reasons.push('external-url()');
  if (/url\\s*\\([^)]*$/i.test(decoded)) reasons.push('unbalanced-url(');
  var pl = lower.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ');
  if (/(^|[^a-z0-9_-])(-webkit-)?image-set\\s*\\(/.test(pl)) reasons.push('css-fetch:image-set()');
  if (/(^|[^a-z0-9_-])(-webkit-)?image\\s*\\(/.test(pl)) reasons.push('css-fetch:image()');
  if (/(^|[^a-z0-9_-])(-webkit-)?cross-fade\\s*\\(/.test(pl)) reasons.push('css-fetch:cross-fade()');
  if (/(^|[^a-z0-9_-])var\\s*\\(/.test(pl)) reasons.push('css-indirection:var()');
  if (pl.indexOf('@import') !== -1) reasons.push('css:@import');
  if (pl.indexOf('expression(') !== -1) reasons.push('css:expression()');
  if (pl.indexOf('-moz-binding') !== -1) reasons.push('css:-moz-binding');
  if (/\\bbehavior\\s*:/.test(pl)) reasons.push('css:behavior');
  if (/https?:\\/\\//i.test(stripped)) reasons.push('external-http-url');
  if (/[\\s"'=]\\/\\/[a-z0-9]/i.test(stripped)) reasons.push('protocol-relative-url');
  var hrefRe = /(?:^|[\\s"'\\u0060])(?:xlink:)?href\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi;
  var hm; var badHref = null;
  while ((hm = hrefRe.exec(decoded)) !== null) {
    var hv = String(hm[1]).replace(/^["']|[\"']$/g, '').trim();
    var hl = hv.toLowerCase();
    if (hv === '' || hv.charAt(0) === '#') continue;
    if (hl.indexOf('data:image/png;base64,') === 0) continue;
    if (hl.indexOf('data:image/jpeg;base64,') === 0) continue;
    if (hl.indexOf('data:image/jpg;base64,') === 0) continue;
    if (hl.indexOf('data:image/gif;base64,') === 0) continue;
    if (hl.indexOf('data:image/webp;base64,') === 0) continue;
    badHref = hv.slice(0, 80); break;
  }
  if (badHref !== null) reasons.push('external-href:' + badHref);
  return { safe: reasons.length === 0, reasons: reasons };
`

type InspectResult = { safe: boolean; reasons: string[] }
// biome-ignore lint/security/noGlobalEval: test-only pure-string inspector, no DOM/sink.
const inspectForPreview = new Function('text', INSPECTOR_BODY) as (text: string) => InspectResult

// ---------------------------------------------------------------------------
// Shared raster/diff types (Node mirror of the in-browser records).
// ---------------------------------------------------------------------------
type RasterStatus = 'loaded' | 'timeout' | 'error' | 'draw-error' | 'excluded'

type RasterStats = {
  status: RasterStatus
  attempts: number
  parserError: boolean
  naturalWidth: number
  naturalHeight: number
  painted: number
}

type DiffStats = {
  ratio: number | null
  alphaDiff: number | null
  rgbDist: number | null
}

type BatchItemResult = {
  file: string
  bytes: number
  vmLen: number
  vmPlaceholder: boolean
  editorLen: number | null
  chainedLen: number | null
  editorPlaceholder: boolean | null
  chainedPlaceholder: boolean | null
  inspRaw: string[]
  inspVm: string[]
  inspEd: string[]
  inspCh: string[]
  orig: RasterStats | null
  vm: RasterStats | null
  ed: RasterStats | null
  ch: RasterStats | null
  diffVm: DiffStats | null
  diffEd: DiffStats | null
  diffCh: DiffStats | null
}

type FileProbe = BatchItemResult & {
  raw: string
  vmClean: string
  verdictVm: string[]
  verdictEd: string[]
  verdictCh: string[]
  causeVm: string[]
  causeEd: string[]
  causeCh: string[]
}

function isPlaceholderSvg(s: string): boolean {
  return s.length < 300 && s.includes(PLACEHOLDER_SNIPPET) && /<svg[\s>]/i.test(s)
}

function countMatches(haystack: string, re: RegExp): number {
  const m = haystack.match(re)
  return m ? m.length : 0
}

/**
 * String-level cause analysis: why does `san` render differently from `raw`?
 * Render-neutral drops (namespaces, comments) are ignored; only content that
 * can change pixels is reported.
 */
function analyzeCauses(raw: string, san: string): string[] {
  const causes: string[] = []
  if (isPlaceholderSvg(san)) {
    causes.push(`sanitizer-placeholder(blank 1x1; raw ${raw.length}B -> san ${san.length}B)`)
    return causes
  }
  if (raw.includes('data-paper-data') && !san.includes('data-paper-data')) {
    causes.push('drops:data-paper-data (Paper JSON attr; render-neutral by design)')
  }
  if (raw.includes('enable-background') && !san.includes('enable-background')) {
    causes.push('drops:enable-background (filter compositing input; may shift filtered pixels)')
  }
  const rawStyle = countMatches(raw, /style\s*=/gi)
  const sanStyle = countMatches(san, /style\s*=/gi)
  if (sanStyle < rawStyle) causes.push(`drops:style-attr ${rawStyle}->${sanStyle}`)
  const rawUrl = countMatches(raw, /url\s*\(/gi)
  const sanUrl = countMatches(san, /url\s*\(/gi)
  if (sanUrl < rawUrl) causes.push(`drops:url() ${rawUrl}->${sanUrl} (paint/filter/clip ref lost)`)
  const rawHref = countMatches(raw, /(?:^|[\s"'`])(?:xlink:)?href\s*=/gi)
  const sanHref = countMatches(san, /(?:^|[\s"'`])(?:xlink:)?href\s*=/gi)
  if (sanHref < rawHref) causes.push(`drops:href ${rawHref}->${sanHref}`)
  for (const tag of [
    'linearGradient',
    'radialGradient',
    'filter',
    'clipPath',
    'mask',
    'pattern',
    'image',
    'text',
    'tspan',
    'textPath',
    'use',
  ]) {
    const r = countMatches(raw, new RegExp(`<${tag}(?=[\\s/>])`, 'g'))
    const s = countMatches(san, new RegExp(`<${tag}(?=[\\s/>])`, 'g'))
    if (s < r) causes.push(`drops:<${tag}> ${r}->${s}`)
  }
  causes.push(`size:raw ${raw.length}B -> san ${san.length}B`)
  return causes
}

function verdicts(orig: RasterStats | null, san: RasterStats | null, diff: DiffStats | null, placeholder: boolean | null): string[] {
  if (san && san.status === 'excluded') return ['excluded-dangerous']
  if (!orig || orig.status !== 'loaded') return [`orig-not-loaded:${orig ? orig.status : 'excluded'}`]
  if (!san || !diff) return ['probe-error']
  if (san.status === 'timeout') return ['render-timeout']
  if (san.status === 'error') return ['load-error']
  if (san.status === 'draw-error') return ['draw-error']
  if (placeholder) return ['sanitizer-placeholder']
  if (san.parserError) return ['dom-parse-error']
  if (san.painted <= Math.max(BLANK_PX, orig.painted * 0.02)) return ['disappeared']
  if (orig.painted >= ORIG_PAINTED_MIN) {
    if ((diff.ratio !== null && diff.ratio < MAJOR_RATIO) || (diff.alphaDiff !== null && diff.alphaDiff > MAJOR_ALPHA_DIFF)) {
      return ['major-loss']
    }
  } else {
    return ['orig-blank-or-unparseable']
  }
  return []
}

describe('svg corpus full render-diff (785 files, real Chrome)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4263', '--strictPort'], {
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
    await page.route('**/*', (route) => {
      const url = route.request().url()
      try {
        const u = new URL(url)
        const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        if ((u.protocol === 'http:' || u.protocol === 'https:') && !local) {
          netHits.push(url)
          void route.abort()
          return
        }
      } catch {}
      void route.continue()
    })
    await page.goto(base)
    // Let the dev shell finish its own lazy asset loads (Blockly sprites etc.)
    // before arming the tap, so host-page noise is never blamed on the corpus.
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 })
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
    netHits = []
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('probe path runs no script and makes no external request', async () => {
    const attack =
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<script>window.${PROBE_MARK}='img-script'</script>` +
      `<image href="https://attack.invalid/x.png" width="10" height="10"/>` +
      `<rect width="10" height="10" onload="window.${PROBE_MARK}='img-onload'"/></svg>`
    const benign =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
      `<rect x="2" y="2" width="20" height="20" fill="red"/></svg>`
    // Node-side gate flags the attack and passes the benign input.
    expect(inspectForPreview(attack).safe).toBe(false)
    expect(inspectForPreview(benign).safe).toBe(true)
    // Chrome runs the byte-identical gate and agrees.
    const agreement = await page.evaluate(
      ({ body, a, b }: { body: string; a: string; b: string }) => {
        // biome-ignore lint/security/noGlobalEval: test-only string scanner, no sink.
        const inspect = new Function('text', body) as (t: string) => { safe: boolean; reasons: string[] }
        return { a: inspect(a), b: inspect(b) }
      },
      { body: INSPECTOR_BODY, a: attack, b: benign },
    )
    expect(agreement.a.safe).toBe(false)
    expect(agreement.b.safe).toBe(true)
    // The raster path itself (<img> + blob URL) leaves the marker untouched.
    const netBeforeCanary = netHits.length
    const marker = await page.evaluate(async ({ svg, mark }: { svg: string; mark: string }) => {
      const w = window as unknown as Record<string, unknown>
      w[mark] = null
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      const img = new Image()
      await new Promise<void>((resolve) => {
        const t = window.setTimeout(() => resolve(), 1500)
        img.onload = () => {
          window.clearTimeout(t)
          resolve()
        }
        img.onerror = () => {
          window.clearTimeout(t)
          resolve()
        }
        img.src = url
      })
      img.onload = null
      img.onerror = null
      URL.revokeObjectURL(url)
      const out = w[mark]
      w[mark] = null
      return out
    }, { svg: benign, mark: PROBE_MARK })
    expect(marker).toBeNull()
    await new Promise((r) => setTimeout(r, 200))
    expect(netHits.slice(netBeforeCanary)).toEqual([])
  }, 60_000)

  it('compares all 785 bundled SVGs before/after sanitizers in real Chrome', async () => {
    const all = readdirSync(IMAGES_DIR)
      .filter((f) => f.endsWith('.svg'))
      .sort()
    expect(all.length).toBe(EXPECTED_CORPUS_TOTAL)
    // Fresh window: only requests attempted from here on are corpus-attributed
    // (per-batch deltas below pinpoint the file batch if any ever appears).
    netHits = []

    // Full-corpus VM string-level scan (Node, no browser): placeholder rate +
    // known allowlist-gap attributes vs. benign paint that must survive.
    let vmPlaceholderAll = 0
    let paperHas = 0
    let paperDropped = 0
    let enableHas = 0
    let enableDropped = 0
    const raws = new Map<string, string>()
    const vmCleans = new Map<string, string>()
    for (const f of all) {
      const raw = readFileSync(join(IMAGES_DIR, f), 'utf8')
      raws.set(f, raw)
      const clean = sanitizeSvgText(raw)
      vmCleans.set(f, clean)
      if (isPlaceholderSvg(clean)) vmPlaceholderAll += 1
      if (raw.includes('data-paper-data')) {
        paperHas += 1
        if (!clean.includes('data-paper-data')) paperDropped += 1
      }
      if (raw.includes('enable-background')) {
        enableHas += 1
        if (!clean.includes('enable-background')) enableDropped += 1
      }
    }

    // Node-side pre-preview gate: inspect every raw source BEFORE it may go
    // near the browser. Flagged data is excluded without being rendered.
    const excludedDangerous: Array<{ file: string; reasons: string[]; snippet: string }> = []
    const renderable: Array<{ file: string; raw: string; vmText: string }> = []
    for (const f of all) {
      const raw = raws.get(f)!
      const gate = inspectForPreview(raw)
      if (!gate.safe) {
        excludedDangerous.push({ file: f, reasons: gate.reasons, snippet: raw.slice(0, 320) })
        continue
      }
      renderable.push({ file: f, raw, vmText: vmCleans.get(f)! })
    }

    const batchResults: BatchItemResult[] = []
    const batchNet: Array<{ batch: number; files: string[]; urls: string[] }> = []
    // Size-aware batches: keep each page.evaluate payload near ~1MB (the
    // largest bundled SVG is ~350KB) instead of a fixed file count.
    const batches: Array<typeof renderable> = []
    {
      let cur: typeof renderable = []
      let curBytes = 0
      for (const item of renderable) {
        const size = item.raw.length + item.vmText.length
        if (cur.length > 0 && curBytes + size > BATCH_BYTE_BUDGET) {
          batches.push(cur)
          cur = []
          curBytes = 0
        }
        cur.push(item)
        curBytes += size
      }
      if (cur.length > 0) batches.push(cur)
    }
    for (let b = 0; b < batches.length; b += 1) {
      const items = batches[b]!
      const netBefore = netHits.length
      const res = await page.evaluate(
        async ({
          items: batchItems,
          W,
          H,
          timeoutMs,
          inspectorBody,
        }: {
          items: Array<{ file: string; raw: string; vmText: string }>
          W: number
          H: number
          timeoutMs: number
          inspectorBody: string
        }) => {
          const { sanitizeSvgForDisplay } = await import(/* @vite-ignore */ '/src/features/costumes/svg-sanitize.ts')
          // biome-ignore lint/security/noGlobalEval: test-only string scanner, no sink.
          const inspect = new Function('text', inspectorBody) as (t: string) => { safe: boolean; reasons: string[] }
          const isPh = (s: string) =>
            s.length < 300 && s.includes('width="1" height="1"') && /<svg[\s>]/i.test(s)
          async function rasterizeOne(svgText: string, skip: boolean) {
            type AlphaMean = { alpha: Uint8Array | null; mean: { r: number; g: number; b: number } | null }
            const empty: AlphaMean = { alpha: null, mean: null }
            if (skip) {
              return {
                raster: { status: 'excluded', attempts: 0, parserError: false, naturalWidth: 0, naturalHeight: 0, painted: 0 },
                ...empty,
              }
            }
            let parserError = false
            try {
              const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
              parserError = doc.getElementsByTagName('parsererror').length > 0
            } catch {
              parserError = true
            }
            // Scripts never execute inside <img>; this path cannot run handlers.
            const attempt = async () => {
              const blob = new Blob([svgText], { type: 'image/svg+xml' })
              const url = URL.createObjectURL(blob)
              const img = new Image()
              try {
                const status: string = await new Promise((resolve) => {
                  let done = false
                  const t = window.setTimeout(() => {
                    if (!done) {
                      done = true
                      resolve('timeout')
                    }
                  }, timeoutMs)
                  img.onload = () => {
                    if (!done) {
                      done = true
                      window.clearTimeout(t)
                      resolve('loaded')
                    }
                  }
                  img.onerror = () => {
                    if (!done) {
                      done = true
                      window.clearTimeout(t)
                      resolve('error')
                    }
                  }
                  img.src = url
                })
                img.onload = null
                img.onerror = null
                if (status !== 'loaded') {
                  return {
                    raster: { status, attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0 },
                    ...empty,
                  }
                }
                const canvas = document.createElement('canvas')
                canvas.width = W
                canvas.height = H
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                if (!ctx) {
                  return {
                    raster: { status: 'draw-error', attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0 },
                    ...empty,
                  }
                }
                ctx.clearRect(0, 0, W, H)
                try {
                  ctx.drawImage(img, 0, 0, W, H)
                } catch {
                  return {
                    raster: { status: 'draw-error', attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0 },
                    ...empty,
                  }
                }
                let d: Uint8ClampedArray
                try {
                  d = ctx.getImageData(0, 0, W, H).data
                } catch {
                  return {
                    raster: { status: 'draw-error', attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0 },
                    ...empty,
                  }
                }
                const alpha = new Uint8Array(W * H)
                let painted = 0
                let sr = 0
                let sg = 0
                let sb = 0
                for (let i = 0; i < W * H; i++) {
                  const hit = d[i * 4 + 3]! > 16 ? 1 : 0
                  alpha[i] = hit
                  if (hit === 1) {
                    painted += 1
                    sr += d[i * 4]!
                    sg += d[i * 4 + 1]!
                    sb += d[i * 4 + 2]!
                  }
                }
                return {
                  raster: {
                    status: 'loaded',
                    attempts: 1,
                    parserError,
                    naturalWidth: img.naturalWidth || 0,
                    naturalHeight: img.naturalHeight || 0,
                    painted,
                  },
                  alpha,
                  mean: painted > 0 ? { r: sr / painted, g: sg / painted, b: sb / painted } : { r: 0, g: 0, b: 0 },
                }
              } finally {
                try {
                  img.removeAttribute('src')
                } catch {}
                URL.revokeObjectURL(url)
              }
            }
            const first = await attempt()
            // One immediate retry separates a transient stall from a hard hang.
            if (first.raster.status === 'timeout') {
              await new Promise((r) => setTimeout(r, 500))
              const second = await attempt()
              second.raster.attempts = 2
              return second
            }
            return first
          }
          function diffOf(
            a: { alpha: Uint8Array | null; mean: { r: number; g: number; b: number } | null },
            b: { alpha: Uint8Array | null; mean: { r: number; g: number; b: number } | null },
            paintedA: number,
            paintedB: number,
          ) {
            if (!a.alpha || !b.alpha || !a.mean || !b.mean) return { ratio: null, alphaDiff: null, rgbDist: null }
            let mis = 0
            for (let i = 0; i < a.alpha.length; i++) if (a.alpha[i] !== b.alpha[i]) mis += 1
            const alphaDiff = mis / a.alpha.length
            const ratio = paintedA > 0 ? paintedB / paintedA : null
            const rgbDist = Math.sqrt((a.mean.r - b.mean.r) ** 2 + (a.mean.g - b.mean.g) ** 2 + (a.mean.b - b.mean.b) ** 2)
            return { ratio, alphaDiff, rgbDist }
          }
          const out = []
          for (const item of batchItems) {
            const inspRaw = inspect(item.raw)
            const inspVm = inspect(item.vmText)
            const editorClean = sanitizeSvgForDisplay(item.raw) as string
            const chainedClean = sanitizeSvgForDisplay(item.vmText) as string
            const inspEd = inspect(editorClean)
            const inspCh = inspect(chainedClean)
            const rOrig = await rasterizeOne(item.raw, !inspRaw.safe)
            const rVm = await rasterizeOne(item.vmText, !inspVm.safe)
            const rEd = await rasterizeOne(editorClean, !inspEd.safe)
            const rCh = await rasterizeOne(chainedClean, !inspCh.safe)
            out.push({
              file: item.file,
              bytes: item.raw.length,
              vmLen: item.vmText.length,
              vmPlaceholder: isPh(item.vmText),
              editorLen: editorClean.length,
              chainedLen: chainedClean.length,
              editorPlaceholder: isPh(editorClean),
              chainedPlaceholder: isPh(chainedClean),
              inspRaw: inspRaw.reasons,
              inspVm: inspVm.reasons,
              inspEd: inspEd.reasons,
              inspCh: inspCh.reasons,
              orig: rOrig.raster,
              vm: rVm.raster,
              ed: rEd.raster,
              ch: rCh.raster,
              diffVm: diffOf(rOrig, rVm, rOrig.raster.painted, rVm.raster.painted),
              diffEd: diffOf(rOrig, rEd, rOrig.raster.painted, rEd.raster.painted),
              diffCh: diffOf(rOrig, rCh, rOrig.raster.painted, rCh.raster.painted),
            })
          }
          return out
        },
        { items, W: CANVAS_W, H: CANVAS_H, timeoutMs: LOAD_TIMEOUT_MS, inspectorBody: INSPECTOR_BODY },
      )
      const delta = netHits.slice(netBefore)
      batchNet.push({ batch: b, files: items.map((i) => i.file), urls: delta })
      batchResults.push(...(res as BatchItemResult[]))
    }

    // Assemble probes with Node-side verdicts + string-level causes.
    const probes: FileProbe[] = batchResults.map((r) => {
      const raw = raws.get(r.file)!
      const vmClean = vmCleans.get(r.file)!
      return {
        ...r,
        raw,
        vmClean,
        verdictVm: verdicts(r.orig, r.vm, r.diffVm, r.vmPlaceholder),
        verdictEd: verdicts(r.orig, r.ed, r.diffEd, r.editorPlaceholder),
        verdictCh: verdicts(r.orig, r.ch, r.diffCh, r.chainedPlaceholder),
        causeVm: [],
        causeEd: [],
        causeCh: [],
      }
    })
    // VM causes are exact (both strings are in Node). Editor/chained strings
    // live only in the browser; their causes carry the browser-measured
    // lengths/placeholder flags, with raw input snippets attached per flagged
    // file in the JSON report below.
    for (const p of probes) {
      p.causeVm = analyzeCauses(p.raw, p.vmClean)
      p.causeEd = p.editorPlaceholder ? ['sanitizer-placeholder(blank 1x1)'] : [`size:san ${p.editorLen}B`]
      p.causeCh = p.chainedPlaceholder ? ['sanitizer-placeholder(blank 1x1)'] : [`size:san ${p.chainedLen}B`]
    }

    const count = (pick: (p: FileProbe) => string[], tag: string) => probes.filter((pp) => pick(pp).includes(tag)).map((pp) => pp.file)
    const countPrefix = (pick: (p: FileProbe) => string[], prefix: string) =>
      probes.filter((pp) => pick(pp).some((v) => v.startsWith(prefix))).map((pp) => pp.file)
    const timeouts = {
      vm: probes.filter((p) => p.vm?.status === 'timeout').map((p) => p.file),
      ed: probes.filter((p) => p.ed?.status === 'timeout').map((p) => p.file),
      ch: probes.filter((p) => p.ch?.status === 'timeout').map((p) => p.file),
    }
    const summary = {
      corpusTotal: all.length,
      rendered: probes.length,
      excludedDangerous: excludedDangerous.map((e) => e.file),
      origLoaded: probes.filter((p) => p.orig?.status === 'loaded').length,
      origNotLoaded: probes.filter((p) => p.orig?.status !== 'loaded').map((p) => `${p.file}:${p.orig?.status ?? 'excluded'}`),
      timeoutsAfterRetry: timeouts,
      vm: {
        placeholder: count((p) => p.verdictVm, 'sanitizer-placeholder'),
        loadError: count((p) => p.verdictVm, 'load-error'),
        renderTimeout: count((p) => p.verdictVm, 'render-timeout'),
        disappeared: count((p) => p.verdictVm, 'disappeared'),
        majorLoss: count((p) => p.verdictVm, 'major-loss'),
        origBlank: countPrefix((p) => p.verdictVm, 'orig-'),
      },
      editor: {
        placeholder: count((p) => p.verdictEd, 'sanitizer-placeholder'),
        loadError: count((p) => p.verdictEd, 'load-error'),
        renderTimeout: count((p) => p.verdictEd, 'render-timeout'),
        disappeared: count((p) => p.verdictEd, 'disappeared'),
        majorLoss: count((p) => p.verdictEd, 'major-loss'),
        origBlank: countPrefix((p) => p.verdictEd, 'orig-'),
      },
      chained: {
        placeholder: count((p) => p.verdictCh, 'sanitizer-placeholder'),
        loadError: count((p) => p.verdictCh, 'load-error'),
        renderTimeout: count((p) => p.verdictCh, 'render-timeout'),
        disappeared: count((p) => p.verdictCh, 'disappeared'),
        majorLoss: count((p) => p.verdictCh, 'major-loss'),
        origBlank: countPrefix((p) => p.verdictCh, 'orig-'),
      },
    }

    const flagged = probes.filter((p) => p.verdictVm.length > 0 || p.verdictEd.length > 0 || p.verdictCh.length > 0)
    const report = {
      generatedAt: new Date().toISOString(),
      method: {
        corpusDir: 'packages/editor/public/assets-scratch/images',
        corpusSvgTotal: all.length,
        sampling: 'none — every file rendered (size-aware ~1MB batches per page.evaluate)',
        canvas: `${CANVAS_W}x${CANVAS_H} stretched drawImage, alpha>16 counts as painted`,
        thresholds: { ORIG_PAINTED_MIN, BLANK_PX, MAJOR_RATIO, MAJOR_ALPHA_DIFF },
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        loadStatuses: 'loaded | timeout (1 retry, then confirmed) | error | draw-error | excluded',
        pipelines: ['vm=sanitizeSvgText(original)', 'editor=sanitizeSvgForDisplay(original)', 'chained=sanitizeSvgForDisplay(sanitizeSvgText(original))'],
        rasterPath: '<img> + blob URL only (no script execution, no innerHTML)',
        prePreviewGate: 'INSPECTOR_BODY string scan in Node (pre-filter) and in Chrome (pre-raster); flagged data excluded without rendering',
      },
      fullCorpusVmStringScan: {
        total: all.length,
        vmPlaceholder: vmPlaceholderAll,
        dataPaperData: { withAttr: paperHas, droppedByVm: paperDropped },
        enableBackground: { withAttr: enableHas, droppedByVm: enableDropped },
      },
      excludedDangerous,
      nonLocalhostNetAttemptsAborted: netHits,
      perBatchNet: batchNet.filter((b) => b.urls.length > 0),
      summary: {
        ...summary,
        vm: Object.fromEntries(Object.entries(summary.vm).map(([k, v]) => [k, { count: (v as string[]).length, files: v }])),
        editor: Object.fromEntries(Object.entries(summary.editor).map(([k, v]) => [k, { count: (v as string[]).length, files: v }])),
        chained: Object.fromEntries(Object.entries(summary.chained).map(([k, v]) => [k, { count: (v as string[]).length, files: v }])),
      },
      perFile: probes.map((p) => ({
        file: p.file,
        bytes: p.bytes,
        vmLen: p.vmLen,
        editorLen: p.editorLen,
        chainedLen: p.chainedLen,
        statuses: { orig: p.orig?.status, vm: p.vm?.status, ed: p.ed?.status, ch: p.ch?.status },
        attempts: { orig: p.orig?.attempts, vm: p.vm?.attempts, ed: p.ed?.attempts, ch: p.ch?.attempts },
        painted: { orig: p.orig?.painted, vm: p.vm?.painted, ed: p.ed?.painted, ch: p.ch?.painted },
        ratio: { vm: p.diffVm?.ratio, ed: p.diffEd?.ratio, ch: p.diffCh?.ratio },
        alphaDiff: { vm: p.diffVm?.alphaDiff, ed: p.diffEd?.alphaDiff, ch: p.diffCh?.alphaDiff },
        rgbDist: { vm: p.diffVm?.rgbDist, ed: p.diffEd?.rgbDist, ch: p.diffCh?.rgbDist },
        prePreviewGateReasons: { raw: p.inspRaw, vm: p.inspVm, ed: p.inspEd, ch: p.inspCh },
        verdicts: { vm: p.verdictVm, ed: p.verdictEd, ch: p.verdictCh },
        causes: { vm: p.causeVm, ed: p.causeEd, ch: p.causeCh },
        inputExample: p.verdictVm.length + p.verdictEd.length + p.verdictCh.length > 0 ? p.raw.slice(0, 320) : undefined,
      })),
    }

    let reportPath = '(write failed; see console JSON above)'
    try {
      reportPath = `/tmp/svg-corpus-full-render-diff-${Date.now()}.json`
      writeFileSync(reportPath, JSON.stringify(report, null, 1))
    } catch {
      // Console output below remains the reproducible report.
    }
    console.log(`[full-corpus-diff] corpus=${all.length} rendered=${probes.length} excluded-dangerous=${excludedDangerous.length} canvas=${CANVAS_W}x${CANVAS_H}`)
    console.log(`[full-corpus-diff] full-corpus VM strings: placeholder=${vmPlaceholderAll}/${all.length} data-paper-data dropped ${paperDropped}/${paperHas} enable-background dropped ${enableDropped}/${enableHas}`)
    console.log(`[full-corpus-diff] orig loaded=${summary.origLoaded}/${probes.length} not-loaded=${JSON.stringify(summary.origNotLoaded)}`)
    console.log(`[full-corpus-diff] timeouts after retry=${JSON.stringify(timeouts)}`)
    console.log(`[full-corpus-diff] summary=${JSON.stringify({ vm: summary.vm, editor: summary.editor, chained: summary.chained })}`)
    const shown = flagged.slice(0, 60)
    for (const p of shown) {
      console.log(
        `[full-corpus-diff] flag file=${p.file} origPainted=${p.orig?.painted}(${p.orig?.status}) ` +
          `vm=${p.vm?.painted}(${p.vm?.status}) ed=${p.ed?.painted}(${p.ed?.status}) ch=${p.ch?.painted}(${p.ch?.status}) ` +
          `ratio=${JSON.stringify({ vm: p.diffVm?.ratio, ed: p.diffEd?.ratio, ch: p.diffCh?.ratio })} ` +
          `verdicts=${JSON.stringify({ vm: p.verdictVm, ed: p.verdictEd, ch: p.verdictCh })} ` +
          `causes=${JSON.stringify({ vm: p.causeVm, ed: p.causeEd, ch: p.causeCh })}`,
      )
      console.log(`[full-corpus-diff] input ${p.file} :: ${p.raw.slice(0, 320).replace(/\s+/g, ' ')}`)
    }
    if (flagged.length > shown.length) console.log(`[full-corpus-diff] ... and ${flagged.length - shown.length} more flagged (see JSON)`)
    console.log(`[full-corpus-diff] non-localhost net attempts (aborted, expect []): ${JSON.stringify(netHits)}`)
    console.log(`[full-corpus-diff] full JSON report: ${reportPath}`)

    // Gates: full coverage, harness health, and the safety contract. Pixel
    // differences are reported above, not gated.
    expect(probes.length).toBe(all.length)
    expect(excludedDangerous).toEqual([])
    expect(netHits).toEqual([])
    expect([...timeouts.vm, ...timeouts.ed, ...timeouts.ch]).toEqual([])
    const origOk = probes.filter((p) => p.orig?.status === 'loaded' && p.orig.painted >= ORIG_PAINTED_MIN).length
    expect(origOk).toBeGreaterThan(Math.floor(probes.length / 2))
  }, 900_000)
})
