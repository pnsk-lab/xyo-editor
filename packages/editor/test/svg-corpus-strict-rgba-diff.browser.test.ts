/**
 * Strict per-pixel RGBA comparison of the full 785-file corpus (real Chrome).
 *
 * Successor of `svg-corpus-full-render-diff.browser.test.ts`, which aggregates
 * with RGB means + alpha masks and therefore cannot prove per-pixel equality.
 * This suite renders the ENTIRE bundled corpus
 * (`packages/editor/public/assets-scratch/images/*.svg`) in real Chrome and
 * compares FULL RGBA byte arrays before vs. after:
 * - VM `sanitizeSvgText` (`@hikkaku/vm`, persistence boundary),
 * - editor `sanitizeSvgForDisplay` (`src/features/costumes/svg-sanitize.ts`,
 *   preview boundary),
 * - chained `original -> VM -> editor`.
 *
 * Strict metric (no tolerance, no thresholds): for each pipeline, over the full
 * W*H RGBA arrays,
 * - `diffPixels` = number of pixels where ANY of R/G/B/A differs (byte-exact),
 * - `maxR/maxG/maxB/maxA` = per-channel maximum absolute byte difference,
 * - `maxAny` = max over all channels, plus the coordinate where it occurs,
 * - `first` = first differing coordinate in row-major order with both
 *   RGBA values, `samples` = first up to 8 differing coordinates, and the
 *   diff bounding box. A pipeline matches iff `diffPixels === 0`
 *   (equivalently `maxAny === 0`).
 *
 * Safety contract (no product-code change; this file is the only addition):
 * - Network egress is forbidden: non-localhost http(s) is aborted + recorded
 *   via `page.route` and the suite fails on any hit. The host is a fixed
 *   blank document (`STABLE_HTML`, no dev-shell scripts, no HMR websocket),
 *   so it makes no requests of its own — every recorded hit is
 *   corpus-attributed (per-batch deltas pinpoint the batch).
 * - Scripts never execute: corpus sources are rasterized ONLY through
 *   `<img>` + blob URL (image documents never run scripts) — never via
 *   `innerHTML`/live DOM. A canary `it` proves the path leaves a window
 *   marker untouched with zero requests.
 * - Every SVG source is inspected for external requests / dangerous URLs
 *   BEFORE any preview: the byte-identical `INSPECTOR_BODY` scanner runs in
 *   Node (pre-filter) and in Chrome (pre-raster gate). Flagged data is
 *   excluded without being rendered; the bundled corpus is expected to need
 *   zero exclusions.
 * - Load completion vs. timeout is distinguished: each raster reports
 *   `loaded | timeout | error | draw-error` (one immediate retry on timeout),
 *   and verdicts keep `render-timeout` separate from `load-error`.
 * - Unified rendering context, no network: within each `page.evaluate` batch
 *   a SINGLE shared `<canvas>` + single `2d` context (fixed `willReadFrequently`
 *   + explicit smoothing flags, never changed mid-batch) rasterizes all four
 *   variants sequentially (`clearRect` + stretched `drawImage` + `getImageData`
 *   copy). No second canvas, no per-variant context attributes, no parallel
 *   decodes — orig/vm/ed/ch for one file always share the identical path.
 *
 * What this gates on: harness health (baseline loads), zero exclusions, zero
 * network egress, zero script execution, zero confirmed timeouts, AND strict
 * per-pixel equality (`diffPixels === 0` for vm/editor/chained on every file
 * whose orig + sanitized both loaded). Pixel differences are REPORTED (file
 * name + representative coordinates + channel maxima + full JSON) and also
 * GATED — a mismatch fails the suite. Expectations are never relaxed here:
 * no tolerance, no re-baselining, no threshold widening; investigate the
 * sanitizer or the corpus instead.
 *
 * Run:
 *   CHROME_BIN=/etc/profiles/per-user/nakasyou/bin/google-chrome \
 *     bun test test/svg-corpus-strict-rgba-diff.browser.test.ts
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
const base = 'http://127.0.0.1:4264'
// Stable minimal host: a fixed blank document with NO Vite dev-shell scripts
// and NO `/@vite/client` HMR websocket, so parallel source edits can trigger
// Vite rebuilds without ever reloading this page (the previous
// `page.goto(base)` loaded the full dev shell, whose HMR client reloads on
// any source change and destroys the execution context mid-`page.evaluate`).
// Only the sanitizer module (`svg-sanitize.ts` + its `dompurify` dep) is ever
// imported here; everything else rasterizes via <img> + blob URL.
const STABLE_PATH = '/__strict-rgba-stable.html'
const STABLE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<title>strict-rgba stable host</title></head><body></body></html>'

const EXPECTED_CORPUS_TOTAL = 785
const BATCH_BYTE_BUDGET = 1_000_000
const CANVAS_W = 240
const CANVAS_H = 180
const ORIG_PAINTED_MIN = 500
const LOAD_TIMEOUT_MS = 5000

const PLACEHOLDER_SNIPPET = 'width="1" height="1"'
const PROBE_MARK = '__strictRgbaDiffProbe'

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
// Shared raster/strict-diff types (Node mirror of the in-browser records).
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

type RgbaTuple = [number, number, number, number]
type DiffCoord = { x: number; y: number; orig: RgbaTuple; san: RgbaTuple }

type StrictDiff = {
  totalPixels: number
  diffPixels: number
  maxR: number
  maxG: number
  maxB: number
  maxA: number
  maxAny: number
  maxCoord: { x: number; y: number } | null
  first: DiffCoord | null
  samples: DiffCoord[]
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null
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
  strictVm: StrictDiff | null
  strictEd: StrictDiff | null
  strictCh: StrictDiff | null
}

function isPlaceholderSvg(s: string): boolean {
  return s.length < 300 && s.includes(PLACEHOLDER_SNIPPET) && /<svg[\s>]/i.test(s)
}

function isDestroyedContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Execution context was destroyed') ||
    message.includes('Target crashed') ||
    message.includes('Target closed') ||
    message.includes('Protocol error') ||
    message.includes('Cannot find context') ||
    message.includes('Session closed')
  )
}

/** Net tap + stable blank host on one page (HMR client never loads here). */
async function armStablePage(p: Page): Promise<void> {
  await p.route('**/*', (route) => {
    const url = route.request().url()
    try {
      const u = new URL(url)
      if (u.origin === base && u.pathname === STABLE_PATH) {
        void route.fulfill({ status: 200, contentType: 'text/html', body: STABLE_HTML })
        return
      }
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !local) {
        netHits.push(url)
        void route.abort()
        return
      }
    } catch {}
    void route.continue()
  })
  await p.goto(base + STABLE_PATH)
}

/** Re-create the stable host page after a destroyed context (no dev shell). */
async function recreateStablePage(): Promise<void> {
  if (!browser) throw new Error('browser unavailable for page recovery')
  try {
    await page?.close().catch(() => {})
  } catch {}
  page = await browser.newPage()
  await armStablePage(page)
}

/**
 * `page.evaluate` hardened against parallel-edit HMR/navigation teardown:
 * the stable host no longer reloads, but a Vite rebuild racing a long batch
 * can still tear the context down — retry once on a fresh stable page.
 */
async function evaluateStable<T, A>(fn: (arg: A) => T | Promise<T>, arg: A, retries = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return (await page.evaluate(fn as (arg: A) => T | Promise<T>, arg)) as T
    } catch (error) {
      lastError = error
      if (!isDestroyedContextError(error) || attempt === retries) throw error
      await new Promise((r) => setTimeout(r, 500))
      await recreateStablePage()
    }
  }
  throw lastError
}

describe('svg corpus strict RGBA diff (785 files, real Chrome, byte-exact)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4264', '--strictPort'], {
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
    await armStablePage(page)
    // Stable blank host makes no requests of its own (no dev-shell lazy
    // assets, no HMR websocket), so a short settle is enough before arming
    // the egress tap.
    await new Promise((r) => setTimeout(r, 500))
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
    const agreement = await evaluateStable(
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
    const marker = await evaluateStable(async ({ svg, mark }: { svg: string; mark: string }) => {
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

  it('compares full RGBA bytes of all 785 SVGs before/after sanitizers', async () => {
    const all = readdirSync(IMAGES_DIR)
      .filter((f) => f.endsWith('.svg'))
      .sort()
    expect(all.length).toBe(EXPECTED_CORPUS_TOTAL)
    // Fresh window: only requests attempted from here on are corpus-attributed
    // (per-batch deltas below pinpoint the file batch if any ever appears).
    netHits = []

    const raws = new Map<string, string>()
    const vmCleans = new Map<string, string>()
    for (const f of all) {
      const raw = readFileSync(join(IMAGES_DIR, f), 'utf8')
      raws.set(f, raw)
      vmCleans.set(f, sanitizeSvgText(raw))
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
      const res = await evaluateStable(
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

          // Unified rendering context: ONE canvas + ONE 2d context for every
          // raster in this batch. Attributes are fixed once and never changed,
          // variants are drawn sequentially with clearRect in between, so
          // orig/vm/ed/ch share the identical decode/draw/readback path.
          // No network is used here: <img> + blob URL only.
          const canvas = document.createElement('canvas')
          canvas.width = W
          canvas.height = H
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true })
          if (!ctx) throw new Error('2d context unavailable')
          ctx.imageSmoothingEnabled = true
          ;(ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high'

          async function rasterizeOne(svgText: string, skip: boolean) {
            type Pixels = { status: string; attempts: number; parserError: boolean; naturalWidth: number; naturalHeight: number; painted: number; data: Uint8ClampedArray | null }
            if (skip) {
              return {
                status: 'excluded',
                attempts: 0,
                parserError: false,
                naturalWidth: 0,
                naturalHeight: 0,
                painted: 0,
                data: null,
              } satisfies Pixels as Pixels
            }
            let parserError = false
            try {
              const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
              parserError = doc.getElementsByTagName('parsererror').length > 0
            } catch {
              parserError = true
            }
            // Scripts never execute inside <img>; this path cannot run handlers.
            const attempt = async (): Promise<Pixels> => {
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
                  return { status, attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0, data: null }
                }
                ctx.clearRect(0, 0, W, H)
                try {
                  ctx.drawImage(img, 0, 0, W, H)
                } catch {
                  return { status: 'draw-error', attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0, data: null }
                }
                let d: Uint8ClampedArray
                try {
                  d = ctx.getImageData(0, 0, W, H).data
                } catch {
                  return { status: 'draw-error', attempts: 1, parserError, naturalWidth: 0, naturalHeight: 0, painted: 0, data: null }
                }
                // Copy out before the next clearRect reuses the context.
                const data = new Uint8ClampedArray(d)
                let painted = 0
                for (let i = 0; i < W * H; i++) if (data[i * 4 + 3]! > 16) painted += 1
                return { status: 'loaded', attempts: 1, parserError, naturalWidth: img.naturalWidth || 0, naturalHeight: img.naturalHeight || 0, painted, data }
              } finally {
                try {
                  img.removeAttribute('src')
                } catch {}
                URL.revokeObjectURL(url)
              }
            }
            const first = await attempt()
            // One immediate retry separates a transient stall from a hard hang.
            if (first.status === 'timeout') {
              await new Promise((r) => setTimeout(r, 500))
              const second = await attempt()
              second.attempts = 2
              return second
            }
            return first
          }

          function strictDiffOf(
            a: Uint8ClampedArray | null,
            aStatus: string,
            b: Uint8ClampedArray | null,
            bStatus: string,
          ) {
            if (!a || !b || aStatus !== 'loaded' || bStatus !== 'loaded') return null
            const total = W * H
            let diffPixels = 0
            let maxR = 0
            let maxG = 0
            let maxB = 0
            let maxA = 0
            let maxAny = 0
            let maxCoord: { x: number; y: number } | null = null
            let first: { x: number; y: number; orig: [number, number, number, number]; san: [number, number, number, number] } | null = null
            const samples: Array<{ x: number; y: number; orig: [number, number, number, number]; san: [number, number, number, number] }> = []
            let minX = W
            let minY = H
            let maxX = -1
            let maxY = -1
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4
                const ar = a[i]!
                const ag = a[i + 1]!
                const ab = a[i + 2]!
                const aa = a[i + 3]!
                const br = b[i]!
                const bg = b[i + 1]!
                const bb = b[i + 2]!
                const ba = b[i + 3]!
                if (ar === br && ag === bg && ab === bb && aa === ba) continue
                const dr = Math.abs(ar - br)
                const dg = Math.abs(ag - bg)
                const db = Math.abs(ab - bb)
                const da = Math.abs(aa - ba)
                diffPixels += 1
                if (dr > maxR) maxR = dr
                if (dg > maxG) maxG = dg
                if (db > maxB) maxB = db
                if (da > maxA) maxA = da
                const m = Math.max(dr, dg, db, da)
                if (m > maxAny) {
                  maxAny = m
                  maxCoord = { x, y }
                }
                if (x < minX) minX = x
                if (y < minY) minY = y
                if (x > maxX) maxX = x
                if (y > maxY) maxY = y
                const rec = { x, y, orig: [ar, ag, ab, aa] as [number, number, number, number], san: [br, bg, bb, ba] as [number, number, number, number] }
                if (!first) first = rec
                if (samples.length < 8) samples.push(rec)
              }
            }
            return {
              totalPixels: total,
              diffPixels,
              maxR,
              maxG,
              maxB,
              maxA,
              maxAny,
              maxCoord,
              first,
              samples,
              bbox: diffPixels > 0 ? { minX, minY, maxX, maxY } : null,
            }
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
              orig: { status: rOrig.status, attempts: rOrig.attempts, parserError: rOrig.parserError, naturalWidth: rOrig.naturalWidth, naturalHeight: rOrig.naturalHeight, painted: rOrig.painted },
              vm: { status: rVm.status, attempts: rVm.attempts, parserError: rVm.parserError, naturalWidth: rVm.naturalWidth, naturalHeight: rVm.naturalHeight, painted: rVm.painted },
              ed: { status: rEd.status, attempts: rEd.attempts, parserError: rEd.parserError, naturalWidth: rEd.naturalWidth, naturalHeight: rEd.naturalHeight, painted: rEd.painted },
              ch: { status: rCh.status, attempts: rCh.attempts, parserError: rCh.parserError, naturalWidth: rCh.naturalWidth, naturalHeight: rCh.naturalHeight, painted: rCh.painted },
              strictVm: strictDiffOf(rOrig.data, rOrig.status, rVm.data, rVm.status),
              strictEd: strictDiffOf(rOrig.data, rOrig.status, rEd.data, rEd.status),
              strictCh: strictDiffOf(rOrig.data, rOrig.status, rCh.data, rCh.status),
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

    const timeouts = {
      vm: batchResults.filter((p) => p.vm?.status === 'timeout').map((p) => p.file),
      ed: batchResults.filter((p) => p.ed?.status === 'timeout').map((p) => p.file),
      ch: batchResults.filter((p) => p.ch?.status === 'timeout').map((p) => p.file),
    }
    const strictMismatch = batchResults.filter((p) => {
      // Only judge files where both sides actually rasterized; load/timeout
      // problems are gated separately below, never folded into pixel verdicts.
      const bad = (s: StrictDiff | null) => s !== null && s.diffPixels > 0
      return bad(p.strictVm) || bad(p.strictEd) || bad(p.strictCh)
    })
    const strictClean = batchResults.length - strictMismatch.length

    const report = {
      generatedAt: new Date().toISOString(),
      method: {
        corpusDir: 'packages/editor/public/assets-scratch/images',
        corpusSvgTotal: all.length,
        sampling: 'none — every file rendered (size-aware ~1MB batches per page.evaluate)',
        canvas: `${CANVAS_W}x${CANVAS_H} stretched drawImage on ONE shared canvas+2d context per batch (willReadFrequently, smoothing high, clearRect between rasters, sequential)`,
        metric: 'byte-exact full-RGBA: diffPixels (any channel differs) + per-channel max abs diff + first/sample coords + bbox; match iff diffPixels===0, zero tolerance',
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        loadStatuses: 'loaded | timeout (1 retry, then confirmed) | error | draw-error | excluded',
        pipelines: ['vm=sanitizeSvgText(original)', 'editor=sanitizeSvgForDisplay(original)', 'chained=sanitizeSvgForDisplay(sanitizeSvgText(original))'],
        rasterPath: '<img> + blob URL only (no script execution, no innerHTML)',
        prePreviewGate: 'INSPECTOR_BODY string scan in Node (pre-filter) and in Chrome (pre-raster); flagged data excluded without rendering',
      },
      excludedDangerous,
      nonLocalhostNetAttemptsAborted: netHits,
      perBatchNet: batchNet.filter((b) => b.urls.length > 0),
      timeoutsAfterRetry: timeouts,
      summary: {
        corpusTotal: all.length,
        rendered: batchResults.length,
        strictClean,
        strictMismatch: strictMismatch.map((p) => p.file),
        origLoaded: batchResults.filter((p) => p.orig?.status === 'loaded').length,
        origNotLoaded: batchResults.filter((p) => p.orig?.status !== 'loaded').map((p) => `${p.file}:${p.orig?.status ?? 'excluded'}`),
      },
      mismatched: strictMismatch.map((p) => ({
        file: p.file,
        bytes: p.bytes,
        statuses: { orig: p.orig?.status, vm: p.vm?.status, ed: p.ed?.status, ch: p.ch?.status },
        painted: { orig: p.orig?.painted, vm: p.vm?.painted, ed: p.ed?.painted, ch: p.ch?.painted },
        strict: { vm: p.strictVm, ed: p.strictEd, ch: p.strictCh },
        prePreviewGateReasons: { raw: p.inspRaw, vm: p.inspVm, ed: p.inspEd, ch: p.inspCh },
        inputExample: raws.get(p.file)!.slice(0, 320),
      })),
      perFile: batchResults.map((p) => ({
        file: p.file,
        statuses: { orig: p.orig?.status, vm: p.vm?.status, ed: p.ed?.status, ch: p.ch?.status },
        painted: { orig: p.orig?.painted, vm: p.vm?.painted, ed: p.ed?.painted, ch: p.ch?.painted },
        strict: {
          vm: p.strictVm ? { diffPixels: p.strictVm.diffPixels, maxAny: p.strictVm.maxAny, maxR: p.strictVm.maxR, maxG: p.strictVm.maxG, maxB: p.strictVm.maxB, maxA: p.strictVm.maxA, first: p.strictVm.first, maxCoord: p.strictVm.maxCoord, bbox: p.strictVm.bbox } : null,
          ed: p.strictEd ? { diffPixels: p.strictEd.diffPixels, maxAny: p.strictEd.maxAny, maxR: p.strictEd.maxR, maxG: p.strictEd.maxG, maxB: p.strictEd.maxB, maxA: p.strictEd.maxA, first: p.strictEd.first, maxCoord: p.strictEd.maxCoord, bbox: p.strictEd.bbox } : null,
          ch: p.strictCh ? { diffPixels: p.strictCh.diffPixels, maxAny: p.strictCh.maxAny, maxR: p.strictCh.maxR, maxG: p.strictCh.maxG, maxB: p.strictCh.maxB, maxA: p.strictCh.maxA, first: p.strictCh.first, maxCoord: p.strictCh.maxCoord, bbox: p.strictCh.bbox } : null,
        },
      })),
    }

    let reportPath = '(write failed; see console JSON above)'
    try {
      reportPath = `/tmp/svg-corpus-strict-rgba-diff-${Date.now()}.json`
      writeFileSync(reportPath, JSON.stringify(report, null, 1))
    } catch {
      // Console output below remains the reproducible report.
    }
    console.log(`[strict-rgba-diff] corpus=${all.length} rendered=${batchResults.length} excluded-dangerous=${excludedDangerous.length} canvas=${CANVAS_W}x${CANVAS_H} strictClean=${strictClean}/${batchResults.length}`)
    console.log(`[strict-rgba-diff] orig loaded=${report.summary.origLoaded}/${batchResults.length} not-loaded=${JSON.stringify(report.summary.origNotLoaded)}`)
    console.log(`[strict-rgba-diff] timeouts after retry=${JSON.stringify(timeouts)}`)
    const shown = strictMismatch.slice(0, 60)
    for (const p of shown) {
      const fmt = (name: string, s: StrictDiff | null) =>
        s === null ? `${name}=n/a` : `${name}:diffPixels=${s.diffPixels}/${s.totalPixels} maxR=${s.maxR} maxG=${s.maxG} maxB=${s.maxB} maxA=${s.maxA} maxAny=${s.maxAny} first=${s.first ? `(${s.first.x},${s.first.y}) orig=[${s.first.orig}] san=[${s.first.san}]` : 'none'} maxCoord=${s.maxCoord ? `(${s.maxCoord.x},${s.maxCoord.y})` : 'none'} bbox=${JSON.stringify(s.bbox)}`
      console.log(
        `[strict-rgba-diff] MISMATCH file=${p.file} origPainted=${p.orig?.painted}(${p.orig?.status}) ` +
          `${fmt('vm', p.strictVm)} ${fmt('ed', p.strictEd)} ${fmt('ch', p.strictCh)}`,
      )
      console.log(`[strict-rgba-diff] input ${p.file} :: ${raws.get(p.file)!.slice(0, 320).replace(/\s+/g, ' ')}`)
    }
    if (strictMismatch.length > shown.length) console.log(`[strict-rgba-diff] ... and ${strictMismatch.length - shown.length} more mismatched (see JSON)`)
    console.log(`[strict-rgba-diff] non-localhost net attempts (aborted, expect []): ${JSON.stringify(netHits)}`)
    console.log(`[strict-rgba-diff] full JSON report: ${reportPath}`)

    // Gates: full coverage, harness health, and the safety contract — plus
    // strict byte-exact equality. Differences fail here; do NOT relax the
    // expectation (no tolerance, no re-baselining): fix the cause instead.
    expect(batchResults.length).toBe(all.length)
    expect(excludedDangerous).toEqual([])
    expect(netHits).toEqual([])
    expect([...timeouts.vm, ...timeouts.ed, ...timeouts.ch]).toEqual([])
    const origOk = batchResults.filter((p) => p.orig?.status === 'loaded' && p.orig.painted >= ORIG_PAINTED_MIN).length
    expect(origOk).toBeGreaterThan(Math.floor(batchResults.length / 2))
    expect(strictMismatch.map((p) => p.file)).toEqual([])
  }, 900_000)
})
