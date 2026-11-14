/**
 * SVG width=300 heuristic Schwebezustand matrix.
 *
 * Purpose: verify the REAL Scratch VM runtime behaviour for the reported
 * concern — `width=300 height=150 center=(75,37.5)` shrinking to 150x75 —
 * plus neighbouring rotationCenter / dimension variants, WITHOUT touching
 * product code or existing tests.
 *
 * What "correct" means here (upstream scratch-svg-renderer + scratch-render):
 * - texture size comes from the SVG root `viewBox.baseVal` (width/height),
 *   NOT from `<img>` naturalWidth/Height and NOT from rotationCenter*2.
 *   See `SVGSkin.setSVG`: `this._size = [viewBox.width, viewBox.height]`.
 * - if root has no viewBox, upstream falls back to content getBBox
 *   (transformMeasurements); if width/height are missing but viewBox exists,
 *   width/height are set FROM the viewBox.
 * - rotationCenter only offsets the drawable; it never defines the size.
 *
 * Real Chrome (CHROME_BIN google-chrome 156.0.8078.79, headless=new,
 * data-URL <img>, --virtual-time-budget) measured for this report:
 * - explicit width=300 height=150 viewBox=0 0 300 150 -> 300x150
 * - explicit width=300 height=300 viewBox=0 0 300 300 -> 300x300
 * - viewBox-only viewBox=0 0 93 41                 -> 300x132
 * - width=100% height=100% viewBox=0 0 93 41       -> 300x132
 * - no width/height/viewBox                        -> 300x150
 * - viewBox-only viewBox=0 0 300 150               -> 300x150 (!!)
 *   ^ indistinguishable from explicit 300x150 at Image level.
 *
 * Consequence: any `naturalWidth === 300` + aspect-guard heuristic can only
 * guess. The failing tests below pin the mis-guess; the passing tests pin
 * the root-attr facts that make a safe fix possible at load time.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  ScratchCanvasRenderer,
  ScratchVM,
  clearSvgTextureCache,
  createDefaultProject,
  noteSvgTextureSize,
  noteSvgTextureSizeForImage,
  parseSvgRootGeometry,
  sanitizeSvgByteStream,
} from '../src/index'

// ---------------------------------------------------------------------------
// Fixtures: SVG roots covering the requested matrix.
// ---------------------------------------------------------------------------

const SVG_EXPLICIT_300x150 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect width="300" height="150" fill="red"/></svg>'
const SVG_EXPLICIT_300x300 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="red"/></svg>'
const SVG_VIEWBOX_ONLY_93x41 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 93 41"><rect width="93" height="41" fill="red"/></svg>'
const SVG_PERCENT_93x41 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 93 41"><rect width="93" height="41" fill="red"/></svg>'
const SVG_MISSING_DIMS =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="93" height="41" fill="red"/></svg>'
const SVG_VIEWBOX_ONLY_300x150 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect width="300" height="150" fill="red"/></svg>'

/** Chrome headless probe results (see file docblock). */
const CHROME_NATURAL: Record<string, [number, number]> = {
  explicit300x150: [300, 150],
  explicit300x300: [300, 300],
  viewBoxOnly93x41: [300, 132],
  percent93x41: [300, 132],
  missingDims: [300, 150],
  viewBoxOnly300x150: [300, 150],
}

// ---------------------------------------------------------------------------
// Minimal SVG-root parser (test-local, regex based — no product dependency).
// Proves the load stage CAN tell the cases apart from bytes alone.
// ---------------------------------------------------------------------------

interface SvgRoot {
  widthAttr: string | null
  heightAttr: string | null
  viewBox: [number, number, number, number] | null
}

function parseSvgRoot(svg: string): SvgRoot {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const attr = (name: string): string | null => {
    const m = new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`, 'i').exec(root)
    return m ? m[2]! : null
  }
  const vb = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const viewBox: SvgRoot['viewBox'] =
    vb && vb.length === 4 && vb.every((n) => Number.isFinite(n))
      ? [vb[0]!, vb[1]!, vb[2]!, vb[3]!]
      : null
  return { widthAttr: attr('width'), heightAttr: attr('height'), viewBox }
}

/** Absolute pixel length? (unitless or px). Percent / em / missing => null. */
function absoluteLength(value: string | null): number | null {
  if (value == null) return null
  const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

type RootKind = 'explicit-absolute' | 'percent' | 'viewBox-only' | 'missing-dims'

function classifyRoot(root: SvgRoot): RootKind {
  const w = absoluteLength(root.widthAttr)
  const h = absoluteLength(root.heightAttr)
  if (w != null && h != null) return 'explicit-absolute'
  if (root.widthAttr?.includes('%') || root.heightAttr?.includes('%')) return 'percent'
  if (root.viewBox) return 'viewBox-only'
  return 'missing-dims'
}

/**
 * Reference implementation of upstream-correct texture size.
 * viewBox wins; else absolute width/height; else unknown (upstream getBBox).
 */
function correctTextureSize(svg: string): [number, number] | null {
  const root = parseSvgRoot(svg)
  if (root.viewBox) return [root.viewBox[2], root.viewBox[3]]
  const w = absoluteLength(root.widthAttr)
  const h = absoluteLength(root.heightAttr)
  if (w != null && h != null) return [w, h]
  return null
}

// ---------------------------------------------------------------------------
// Renderer harness: pre-seeded costumeImages PLUS the authoritative SVG
// texture size identified from sanitized bytes via the product parser
// (`parseSvgRootGeometry`, htmlparser2-based). This mirrors what
// `resolveCostumeImage` does at load time for real projects; the legacy
// center*2 heuristic alone cannot disambiguate naturalWidth 300 cases.
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearSvgTextureCache()
})

function seedAuthoritativeSvgSize(md5ext: string, dataFormat: string, svgText: string, image?: unknown): void {
  const sanitized = new TextDecoder().decode(sanitizeSvgByteStream(new TextEncoder().encode(svgText)))
  const size = parseSvgRootGeometry(sanitized).textureSize
  noteSvgTextureSize(md5ext, dataFormat, size)
  if (image && size) noteSvgTextureSizeForImage(image as never, size)
}

function drawSprite(costume: Record<string, unknown>, natural: [number, number], svgText?: string): unknown[] | undefined {
  const project = createDefaultProject()
  const sprite = project.targets[1]!
  sprite.costumes = [costume as never]
  const vm = new ScratchVM()
  vm.loadProject(project)
  const renderer = new ScratchCanvasRenderer()
  const drawImageCalls: unknown[][] = []
  const context = {
    beginPath: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    lineTo: () => undefined,
    moveTo: () => undefined,
    restore: () => undefined,
    rotate: () => undefined,
    save: () => undefined,
    scale: () => undefined,
    setLineDash: () => undefined,
    stroke: () => undefined,
    strokeRect: () => undefined,
    translate: () => undefined,
    drawImage: (...args: unknown[]) => drawImageCalls.push(args),
  } as unknown as CanvasRenderingContext2D
  const internals = renderer as unknown as {
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
    costumeImages: Map<string, { status: 'ready'; image: unknown }>
  }
  internals.canvas = { width: 480, height: 360 } as HTMLCanvasElement
  internals.context = context
  const md5ext = String((costume as { md5ext?: string }).md5ext ?? 'c.svg')
  const dataFormat = String((costume as { dataFormat?: string }).dataFormat ?? 'svg')
  const image = { naturalWidth: natural[0], naturalHeight: natural[1] } as never
  internals.costumeImages.set(`${md5ext}:${dataFormat}`, { status: 'ready', image })
  if (svgText != null && dataFormat === 'svg') seedAuthoritativeSvgSize(md5ext, dataFormat, svgText, image)
  const originalImage = globalThis.Image
  globalThis.Image = class {} as typeof Image
  try {
    renderer.requestDraw(vm.snapshot())
  } finally {
    globalThis.Image = originalImage
  }
  return drawImageCalls[0]?.slice(1)
}

function spriteBounds(costume: Record<string, unknown>, svgText?: string) {
  const project = createDefaultProject()
  const sprite = project.targets[1]!
  sprite.costumes = [costume as never]
  if (svgText != null) {
    const md5ext = String((costume as { md5ext?: string }).md5ext ?? 'c.svg')
    const dataFormat = String((costume as { dataFormat?: string }).dataFormat ?? 'svg')
    if (dataFormat === 'svg') seedAuthoritativeSvgSize(md5ext, dataFormat, svgText)
  }
  const vm = new ScratchVM()
  vm.loadProject(project)
  const renderer = new ScratchCanvasRenderer()
  const originalImage = globalThis.Image
  globalThis.Image = class {} as typeof Image
  try {
    renderer.requestDraw(vm.snapshot())
    return renderer.getBounds('Sprite1')
  } finally {
    globalThis.Image = originalImage
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SVG root attrs identify the 300-wide cases (load-stage facts)', () => {
  it('classifies explicit / viewBox-only / percent / missing roots', () => {
    expect(classifyRoot(parseSvgRoot(SVG_EXPLICIT_300x150))).toBe('explicit-absolute')
    expect(classifyRoot(parseSvgRoot(SVG_EXPLICIT_300x300))).toBe('explicit-absolute')
    expect(classifyRoot(parseSvgRoot(SVG_VIEWBOX_ONLY_93x41))).toBe('viewBox-only')
    expect(classifyRoot(parseSvgRoot(SVG_PERCENT_93x41))).toBe('percent')
    expect(classifyRoot(parseSvgRoot(SVG_MISSING_DIMS))).toBe('missing-dims')
    expect(classifyRoot(parseSvgRoot(SVG_VIEWBOX_ONLY_300x150))).toBe('viewBox-only')
  })

  it('Image natural size alone cannot separate explicit 300x150 from viewBox-only 300x150', () => {
    // Both load at 300x150 in real Chrome — the heuristic input is ambiguous.
    expect(CHROME_NATURAL.explicit300x150).toEqual([300, 150])
    expect(CHROME_NATURAL.viewBoxOnly300x150).toEqual([300, 150])
    // ...while the bytes stay distinguishable.
    expect(parseSvgRoot(SVG_EXPLICIT_300x150).widthAttr).toBe('300')
    expect(parseSvgRoot(SVG_VIEWBOX_ONLY_300x150).widthAttr).toBeNull()
    expect(parseSvgRoot(SVG_VIEWBOX_ONLY_300x150).viewBox).toEqual([0, 0, 300, 150])
  })

  it('reference (upstream Scratch) sizes come from viewBox, never from center*2', () => {
    expect(correctTextureSize(SVG_EXPLICIT_300x150)).toEqual([300, 150])
    expect(correctTextureSize(SVG_EXPLICIT_300x300)).toEqual([300, 300])
    expect(correctTextureSize(SVG_VIEWBOX_ONLY_93x41)).toEqual([93, 41])
    expect(correctTextureSize(SVG_PERCENT_93x41)).toEqual([93, 41])
    expect(correctTextureSize(SVG_VIEWBOX_ONLY_300x150)).toEqual([300, 150])
    // No viewBox and no absolute dims: upstream measures content (getBBox),
    // so bytes alone report "unknown" instead of guessing from the center.
    expect(correctTextureSize(SVG_MISSING_DIMS)).toBeNull()
  })
})

describe('300-wide texture size / costume box / stage pixels (correct runtime behaviour)', () => {
  it('explicit 300x150 with off-centre center (75,37.5) keeps 300x150 (bytes win over aspect heuristic)', () => {
    const call = drawSprite(
      { name: 'wide', assetId: 'wide', md5ext: 'wide.svg', dataFormat: 'svg', rotationCenterX: 75, rotationCenterY: 37.5 },
      CHROME_NATURAL.explicit300x150!,
      SVG_EXPLICIT_300x150,
    )
    // Correct Scratch behaviour: texture 300x150 drawn at (-75,-37.5).
    // The old naturalWidth+aspect heuristic saw 2.0 == 2.0 and shrank to 150x75.
    expect(call).toEqual([-75, -37.5, 300, 150])
  })

  it('explicit 300x300 with default upload center (48,48) keeps 300x300', () => {
    const call = drawSprite(
      { name: 'square', assetId: 'square', md5ext: 'square.svg', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 },
      CHROME_NATURAL.explicit300x300!,
      SVG_EXPLICIT_300x300,
    )
    // Correct: 300x300. Old aspect heuristic (1.0 == 1.0) shrank to 96x96.
    expect(call).toEqual([-48, -48, 300, 300])
  })

  it('keeps viewBox-only 93x41 (true center 46.5,20.5) at 93x41', () => {
    const call = drawSprite(
      { name: 'button', assetId: 'button', md5ext: 'button.svg', dataFormat: 'svg', rotationCenterX: 46.5, rotationCenterY: 20.5 },
      CHROME_NATURAL.viewBoxOnly93x41!,
      SVG_VIEWBOX_ONLY_93x41,
    )
    expect(call).toEqual([-46.5, -20.5, 93, 41])
  })

  it('keeps percent width/height 93x41 artwork at 93x41', () => {
    const call = drawSprite(
      { name: 'pct', assetId: 'pct', md5ext: 'pct.svg', dataFormat: 'svg', rotationCenterX: 46.5, rotationCenterY: 20.5 },
      CHROME_NATURAL.percent93x41!,
      SVG_PERCENT_93x41,
    )
    expect(call).toEqual([-46.5, -20.5, 93, 41])
  })

  it('costume box of explicit 300x150 at (75,37.5) spans 300x150', () => {
    const bounds = spriteBounds(
      { name: 'wide', assetId: 'wide', md5ext: 'wide.svg', dataFormat: 'svg', rotationCenterX: 75, rotationCenterY: 37.5 },
      SVG_EXPLICIT_300x150,
    )
    // Correct box: left -75 / right (300-75)=225 / top 37.5 / bottom -(150-37.5)=-112.5.
    expect(bounds).toMatchObject({ left: -75, right: 225, top: 37.5, bottom: -112.5, width: 300, height: 150 })
  })
})

describe('authoritative SVG geometry: arbitrary center, origins, CSS, PNG, malformed', () => {
  it('product parser matches the reference sizes and reports viewBox origins', () => {
    expect(parseSvgRootGeometry(SVG_EXPLICIT_300x150).textureSize).toEqual([300, 150])
    expect(parseSvgRootGeometry(SVG_EXPLICIT_300x300).textureSize).toEqual([300, 300])
    expect(parseSvgRootGeometry(SVG_VIEWBOX_ONLY_93x41).textureSize).toEqual([93, 41])
    expect(parseSvgRootGeometry(SVG_PERCENT_93x41).textureSize).toEqual([93, 41])
    expect(parseSvgRootGeometry(SVG_MISSING_DIMS).textureSize).toBeNull()
    expect(parseSvgRootGeometry(SVG_VIEWBOX_ONLY_300x150).textureSize).toEqual([300, 150])
    // Negative viewBox origins affect the reported origin, never the size.
    const negative = parseSvgRootGeometry(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 93 41"><rect width="1" height="1"/></svg>',
    )
    expect(negative.textureSize).toEqual([93, 41])
    expect(negative.viewOrigin).toEqual([-10, -20])
    // viewBox wins over absolute width/height (upstream SVGSkin semantics).
    expect(
      parseSvgRootGeometry(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 93 41"></svg>',
      ).textureSize,
    ).toEqual([93, 41])
    // Absolute px units are accepted; percentages need layout and stay unknown without viewBox.
    expect(parseSvgRootGeometry('<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="150px"></svg>').textureSize).toEqual([
      300, 150,
    ])
    expect(parseSvgRootGeometry('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>').textureSize).toBeNull()
    // CSS style dimensions are ignored for texture size (layout context unavailable headless).
    expect(
      parseSvgRootGeometry('<svg xmlns="http://www.w3.org/2000/svg" style="width:93px;height:41px" viewBox="0 0 93 41"></svg>')
        .textureSize,
    ).toEqual([93, 41])
    expect(parseSvgRootGeometry('<svg xmlns="http://www.w3.org/2000/svg" style="width:93px;height:41px"></svg>').textureSize).toBeNull()
    // Malformed / empty inputs fail closed without throwing or fetching.
    expect(parseSvgRootGeometry('').kind).toBe('invalid')
    expect(parseSvgRootGeometry('hello').textureSize).toBeNull()
    expect(parseSvgRootGeometry('<svg><g><image href="x"/onerror="y"').textureSize).toBeNull()
  })

  it('arbitrary center (10,10) on explicit 300x150 still draws 300x150 (center is an offset)', () => {
    const call = drawSprite(
      { name: 'wide', assetId: 'wide-arb', md5ext: 'wide-arb.svg', dataFormat: 'svg', rotationCenterX: 10, rotationCenterY: 10 },
      CHROME_NATURAL.explicit300x150!,
      SVG_EXPLICIT_300x150,
    )
    expect(call).toEqual([-10, -10, 300, 150])
    const bounds = spriteBounds(
      { name: 'wide', assetId: 'wide-arb', md5ext: 'wide-arb.svg', dataFormat: 'svg', rotationCenterX: 10, rotationCenterY: 10 },
      SVG_EXPLICIT_300x150,
    )
    expect(bounds).toMatchObject({ left: -10, right: 290, top: 10, bottom: -140, width: 300, height: 150 })
  })

  it('negative viewBox origin keeps 93x41 texture and offsets only the center', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 93 41"><rect width="93" height="41" fill="red"/></svg>'
    const call = drawSprite(
      { name: 'neg', assetId: 'neg', md5ext: 'neg.svg', dataFormat: 'svg', rotationCenterX: 46.5, rotationCenterY: 20.5 },
      [300, 132],
      svg,
    )
    expect(call).toEqual([-46.5, -20.5, 93, 41])
  })

  it('CSS-sized and unit-less variants follow viewBox, PNG never consults the SVG cache', () => {
    const cssViewBox = '<svg xmlns="http://www.w3.org/2000/svg" style="width:300px;height:150px" viewBox="0 0 93 41"></svg>'
    const cssCall = drawSprite(
      { name: 'css', assetId: 'css', md5ext: 'css.svg', dataFormat: 'svg', rotationCenterX: 46.5, rotationCenterY: 20.5 },
      [300, 132],
      cssViewBox,
    )
    expect(cssCall).toEqual([-46.5, -20.5, 93, 41])
    const pngCall = drawSprite(
      { name: 'wide-png', assetId: 'wide-png', md5ext: 'wide-png.png', dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 48, rotationCenterY: 48 },
      [300, 150],
    )
    expect(pngCall).toEqual([-48, -48, 300, 150])
  })

  it('resolve path sanitizes display bytes and caches authoritative geometry (no fetch)', async () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><image href="https://evil.example/x.png" width="1" height="1"/><rect width="300" height="150" fill="red"/></svg>'
    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [
      { name: 'wide', assetId: 'evil-wide', md5ext: 'evil-wide.svg', dataFormat: 'svg', rotationCenterX: 75, rotationCenterY: 37.5 } as never,
    ]
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    let capturedText: string | null = null
    const originalURL = globalThis.URL
    const originalImage = globalThis.Image
    try {
      ;(globalThis as Record<string, unknown>).URL = {
        ...originalURL,
        createObjectURL: (blob: Blob) => {
          void blob.text().then((text) => {
            capturedText = text
          })
          return 'blob:mock-svg'
        },
        revokeObjectURL: () => undefined,
      }
      class MockImage {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        src = ''
        constructor() {
          queueMicrotask(() => this.onload?.())
        }
      }
      ;(globalThis as Record<string, unknown>).Image = MockImage
      renderer.setAssetResolver(async () => new TextEncoder().encode(evil))
      const internalsCanvas = renderer as unknown as { canvas: unknown; context: unknown }
      internalsCanvas.canvas = { width: 480, height: 360 }
      internalsCanvas.context = {
        arc: () => undefined,
        beginPath: () => undefined,
        clearRect: () => undefined,
        closePath: () => undefined,
        fill: () => undefined,
        fillRect: () => undefined,
        lineTo: () => undefined,
        moveTo: () => undefined,
        restore: () => undefined,
        rotate: () => undefined,
        save: () => undefined,
        scale: () => undefined,
        setLineDash: () => undefined,
        stroke: () => undefined,
        strokeRect: () => undefined,
        translate: () => undefined,
        drawImage: () => undefined,
      }
      renderer.requestDraw(vm.snapshot())
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(capturedText).not.toBeNull()
      expect(String(capturedText)).not.toContain('evil.example')
      expect(parseSvgRootGeometry(String(capturedText)).textureSize).toEqual([300, 150])
      // Authoritative cache now drives texture + bounds (center stays an offset).
      const internals = renderer as unknown as {
        costumeImages: Map<string, { status: string; image: unknown }>
      }
      expect(internals.costumeImages.get('evil-wide.svg:svg')?.status).toBe('ready')
      expect(renderer.getBounds('Sprite1')).toMatchObject({ width: 300, height: 150, left: -75, right: 225 })
    } finally {
      globalThis.URL = originalURL
      globalThis.Image = originalImage
      clearSvgTextureCache()
    }
  })

  it('UTF8 content and sanitized external refs keep geometry and stay fetch-free', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><text x="8" y="48">こんにちは🍣</text><image href="https://evil.example/x.png" width="1" height="1"/></svg>'
    const sanitized = new TextDecoder().decode(sanitizeSvgByteStream(new TextEncoder().encode(svg)))
    expect(sanitized).toContain('こんにちは🍣')
    expect(sanitized).not.toContain('evil.example')
    expect(parseSvgRootGeometry(sanitized).textureSize).toEqual([96, 96])
    const call = drawSprite(
      { name: 'utf8', assetId: 'utf8', md5ext: 'utf8.svg', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 },
      [96, 96],
      svg,
    )
    expect(call).toEqual([-48, -48, 96, 96])
  })
})
