// Paper-truth viewport diagnostics (PURE unit side, READ-ONLY, no product change).
//
// Paper実体 (.tmp/scratch-editor/packages/scratch-paint) を正として、
// viewport-reset-band-diagnostics の未解決点 (bitmap res1/res2 / vector
// cameraスケール / 初期reset / fit・workspace clamp) を純粋計算で固定する。
// 製品コード (packages/editor/src) の編集は一切しない。新規diagnosticsのみ。
// AGPLコードのコピーはしない: 参照値は Bun.file による read-only 読取で
// ピンし、数式は自前の clean-room 実装 (paper-viewport-parity /
// costume-viewport の既存公開helper) で再計算する。
//
// LEGEND: [確定] = 参照ソースの行から直接読める値 / [仮定] = 対応付けに
// 導入した解釈 (崩れても数値範囲のみに影響し、故障証明にはならない)。
//
// 参照ソース (行番号は調査時点):
// - view.js: ART_BOARD 960x720 / SVG_ART_BOARD 480x360 / CENTER 480,360 /
//   OUTERMOST 0.333 / BUFFER 50 / PADDING 25% / MIN_RATIO 0.125 /
//   resetZoom zoom=0.5 / zoomOnFixedPoint floor / pan scrollBy /
//   zoomToFit expand+pad+ratio / setWorkspaceBounds+clampViewBounds /
//   getActionBounds
//
// 任意参照の運用: `.tmp/scratch-editor` は git-ignored の任意チェックアウトで
// あり、clean clone には存在しない。参照ソース読取に依存する表明は
// `it.skipIf(!HAS_SCRATCH_REFERENCE)` で明示スキップし、製品側の独立表明は
// 常に実行する (詳細は `test/scratch-reference.ts`)。
const HAS_SCRATCH_REFERENCE = hasScratchReference()
// - layer.js: createCanvas 960x720 / raster position CENTER / guide masks
// - containers/paper-canvas.jsx: importImage bitmap (480-cx,360-cy) 二重
//   drawImage + 既定中心 w/2,h/2 / importSvg scaleWithStrokes 2x +
//   CENTER-rotationPoint*2 (+viewBox減算) / componentDidMount setup→
//   resetZoom→importImage→maybeZoomToFit / recalibrateSize setTimeout(0)
// - containers/paint-editor.jsx: ZOOM_INCREMENT 0.5 + floor-exit 0.167 /
//   handleZoomIn/Out/Reset (zoomOnSelection / resetZoom)
// - containers/scrollable-canvas.jsx: wheel -deltaY/1000 / pan dx/zoom /
//   shift横パン / scrollbar tx += dx*zoom*2
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { hasScratchReference } from './scratch-reference'
import {
  BITMAP_SPRITE_ARTBOARD_HEIGHT as CURRENT_BITMAP_DEFAULT_H,
  BITMAP_SPRITE_ARTBOARD_WIDTH as CURRENT_BITMAP_DEFAULT_W,
} from '../src/features/costumes/bitmap-artboard'
import {
  VECTOR_PAPER_TO_CSS_DENSITY,
  buttonZoomStepForPaperDensity,
  clampViewportScale,
  clampViewportScaleForDensity,
  cssScaleStepForPaperStep,
  paperStepForCssScaleStep,
  wheelZoomForPaperDensity,
} from '../src/features/costumes/costume-viewport'
import {
  PAPER_ART_BOARD,
  PAPER_ART_CENTER,
  PAPER_FIT_BASE_ZOOM,
  PAPER_FIT_BITMAP_BUFFER,
  PAPER_FIT_EXTENT_FACTOR,
  PAPER_FIT_MAX_ZOOM,
  PAPER_FIT_MIN_RATIO,
  PAPER_OUTERMOST_ZOOM_LEVEL,
  PAPER_RESET_ZOOM,
  PAPER_ZOOM_INCREMENT,
  clampPaperCenterToWorkspace,
  clampPaperZoom,
  cssScaleForPaperZoom,
  paperWheelZoomAdditive,
  paperZoomForCssScale,
  paperZoomStepAdditive,
  resolvePaperFitZoom,
} from '../src/features/costumes/paper-viewport-parity'

const REF_VIEW = join(import.meta.dir, '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/view.js')
const REF_LAYER = join(import.meta.dir, '../../../.tmp/scratch-editor/packages/scratch-paint/src/helper/layer.js')
const REF_PAPER_CANVAS = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/containers/paper-canvas.jsx',
)
const REF_PAINT_EDITOR = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/containers/paint-editor.jsx',
)
const REF_SCROLLABLE = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint/src/containers/scrollable-canvas.jsx',
)

async function readRef(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe('paper-truth: board/camera constants (read-only pins)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pins ART_BOARD 960x720 / SVG 480x360 / CENTER 480,360 [確定 view.js:12-16] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('SVG_ART_BOARD_WIDTH = 480')
      expect(src).toContain('SVG_ART_BOARD_HEIGHT = 360')
      expect(src).toContain('ART_BOARD_WIDTH = SVG_ART_BOARD_WIDTH * 2')
      expect(src).toContain('ART_BOARD_HEIGHT = SVG_ART_BOARD_HEIGHT * 2')
      expect(src).toContain('ART_BOARD_WIDTH / 2, ART_BOARD_HEIGHT / 2')
    },
  )

  it('product board/center wiring matches the pinned oracle (independent)', () => {
    // 自前対応値の一致 (clean-room 再計算、コピーではない).
    expect(PAPER_ART_BOARD).toEqual({ width: 960, height: 720 })
    expect(PAPER_ART_CENTER).toEqual({ x: 480, y: 360 })
    // 現行既定 bitmap canvas も同寸 (製品ソース既存値の読取).
    expect(CURRENT_BITMAP_DEFAULT_W).toBe(960)
    expect(CURRENT_BITMAP_DEFAULT_H).toBe(720)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pins zoom floor/reset/step + fit/pan定数 [確定 view.js:17-21, paint-editor.jsx:72-73, scrollable-canvas.jsx:16-17] (reference source oracle)',
    async () => {
      const [view, paint, scroll] = await Promise.all([
        readRef(REF_VIEW),
        readRef(REF_PAINT_EDITOR),
        readRef(REF_SCROLLABLE),
      ])
      expect(view).toContain('OUTERMOST_ZOOM_LEVEL = 0.333')
      expect(view).toContain('BUFFER = 50')
      expect(view).toContain('PADDING_PERCENT = 25')
      expect(view).toContain('MIN_RATIO = .125')
      expect(view).toContain('view.zoom = .5')
      expect(paint).toContain('ZOOM_INCREMENT')
      expect(paint).toContain('return 0.5')
      expect(scroll).toContain('ZOOM_INCREMENT')
      expect(scroll).toContain('-deltaY / 1000')
    },
  )

  it('product zoom/fit/pan constants match the pinned oracle (independent)', () => {
    expect(PAPER_OUTERMOST_ZOOM_LEVEL).toBe(0.333)
    expect(PAPER_RESET_ZOOM).toBe(0.5)
    expect(PAPER_ZOOM_INCREMENT).toBe(0.5)
    expect(PAPER_FIT_BITMAP_BUFFER).toBe(50)
    expect(PAPER_FIT_EXTENT_FACTOR).toBe(1.5)
    expect(PAPER_FIT_MIN_RATIO).toBe(0.125)
    expect(PAPER_FIT_BASE_ZOOM).toBe(0.5)
    expect(PAPER_FIT_MAX_ZOOM).toBe(4)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pins workspace bounds式 [確定 view.js:23-27] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('-ART_BOARD_WIDTH / 4')
      expect(src).toContain('-ART_BOARD_HEIGHT / 4')
      expect(src).toContain('ART_BOARD_WIDTH * 1.5')
    },
  )

  it('workspace bounds numeric examples (independent)', () => {
    // 数値例 (wiring用): (-240,-180,1440,1080).
    expect(-960 / 4).toBe(-240)
    expect(-720 / 4).toBe(-180)
    expect(960 * 1.5).toBe(1440)
    expect(720 * 1.5).toBe(1080)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pins bitmap/vector import transform [確定 paper-canvas.jsx:163-177,271-317] (reference source oracle)',
    async () => {
      const src = await readRef(REF_PAPER_CANVAS)
      // bitmap: 既定中心 w/2,h/2, 配置 (480-cx,360-cy) の二重drawImage.
      expect(src).toContain('imgElement.width / 2')
      expect(src).toContain('(ART_BOARD_WIDTH / 2) - rotationCenterX')
      expect(src).toContain('(ART_BOARD_HEIGHT / 2) - rotationCenterY')
      // vector: 2x import + CENTER-rotationPoint*2 (+viewBox減算).
      expect(src).toContain('scaleWithStrokes(item, 2')
      expect(src).toContain('rotationPoint.multiply(2)')
      expect(src).toContain('rotationPoint.subtract(viewBox[0], viewBox[1])')
    },
  )

  it('import transform numeric examples (independent)', () => {
    // 数値例: 96x96 res1 (cx48,cy48) -> 原点 (432,312).
    expect(480 - 48).toBe(432)
    expect(360 - 48).toBe(312)
    // 数値例: SVG回転中心 (20,400) viewBoxなし -> translate (440,-440).
    expect(480 - 20 * 2).toBe(440)
    expect(360 - 400 * 2).toBe(-440)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pins layer raster既定 [確定 layer.js:29-48] (reference source oracle)',
    async () => {
      const src = await readRef(REF_LAYER)
      expect(src).toContain('canvas.width = width ? width : ART_BOARD_WIDTH')
      expect(src).toContain('raster.position = CENTER')
      expect(src).toContain('imageSmoothingEnabled = false')
    },
  )
})

describe('paper-truth: 480 stage-units -> screen CSS px (camera表)', () => {
  // [確定] Paper zoom z は screen px per Paper unit. 480 stage-units の
  // Paper換算は形式で分岐する (paint-editor.jsx:45-48 の quirky import由来):
  // - bitmap: 1px = 1 Paper unit なので 480 units = 480 Paper units.
  // - vector(SVG): 1 unit が 2x import で 2 Paper units なので
  //   480 units = 960 Paper units (= ART_BOARD幅).
  // [仮定 A-CAMERA]: 上の「形式別Paper換算」がそのまま画面対応になること.
  // 崩れても本表の行内比率のみが変わり、Paper実測 (browser側) は不変.
  const cases: Array<{ label: string; paperUnits: number; zoom: number; expectedCssPx: number }> = [
    { label: 'bitmap 480u @reset0.5', paperUnits: 480, zoom: 0.5, expectedCssPx: 240 },
    { label: 'bitmap 480u @1.0', paperUnits: 480, zoom: 1.0, expectedCssPx: 480 },
    { label: 'vector 480u(=960P) @reset0.5', paperUnits: 960, zoom: 0.5, expectedCssPx: 480 },
    { label: 'vector 480u(=960P) @1.0', paperUnits: 960, zoom: 1.0, expectedCssPx: 960 },
    { label: 'vector 480u(=960P) @floor0.333', paperUnits: 960, zoom: 0.333, expectedCssPx: 319.68 },
    { label: 'bitmap 480u @floor0.333', paperUnits: 480, zoom: 0.333, expectedCssPx: 159.84 },
  ]
  for (const c of cases) {
    it(`${c.label} = ${c.expectedCssPx} CSS px`, () => {
      expect(c.paperUnits * c.zoom).toBeCloseTo(c.expectedCssPx, 10)
    })
  }

  it('wiring用: 現行CSS scale との対応 (vector密度2.5 [仮定A3] / bitmap分岐 [未解決])', () => {
    // z = s*W/Pw, s = z*Pw/W (paper-viewport-parity の actual-size式).
    // vector W2400/Pw960=2.5 [仮定A3]: reset z0.5 -> s0.2 (per-board帯域でlive).
    const v = cssScaleForPaperZoom(0.5, 2400, 960)
    expect(v.theoretical).toBeCloseTo(0.2, 12)
    expect(v.clamped).toBeCloseTo(0.2, 12)
    // bitmap res2 W960/Pw960=1.0 [確定に近い読取 R-own]: reset -> s0.5.
    const b2 = cssScaleForPaperZoom(0.5, 960, 960)
    expect(b2.theoretical).toBeCloseTo(0.5, 12)
    expect(b2.clamped).toBeCloseTo(0.5, 12)
    // bitmap res1 は未解決のまま両読取を併記 (どちらも勝たせない):
    // R-board Pw960: 480/960=0.5密度 -> s1.0 / R-own Pw480: 480/480=1.0 -> s0.5.
    const r1board = cssScaleForPaperZoom(0.5, 480, 960)
    const r1own = cssScaleForPaperZoom(0.5, 480, 480)
    expect(r1board.theoretical).toBeCloseTo(1.0, 12)
    expect(r1own.theoretical).toBeCloseTo(0.5, 12)
    // 逆変換の往復: per-board帯域で理論値 0.2 はそのまま live なので
    // 0.2*2400/960=0.5 (Paper reset parity、表現限界なし).
    expect(paperZoomForCssScale(v.theoretical, 2400, 960)).toBeCloseTo(0.5, 12)
    expect((v.theoretical * 2400) / 960).toBeCloseTo(0.5, 12)
  })
})

describe('paper-truth: anchor world座標 (selection固定点)', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'zoomOnSelection の固定点則 [確定 view.js:125-142] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('zoomOnSelection')
      expect(src).toContain('rect.center')
      expect(src).toContain('paper.project.view.center')
      expect(src).toContain('zoomOnFixedPoint(deltaZoom, fixedPoint)')
    },
  )

  it('zoomOnFixedPoint の数値例 (view.zoom0.5, 中心480,360, 固定点580,410, +0.5)', () => {
    // view.js:108-117 の式を自前再計算 (コピーではなく同値式):
    // newZoom=1.0, scaling=0.5, preOffset=(100,50),
    // postOffset = fixed - preOffset*scaling - preCenter = (50,25).
    // translate(-50,-25) が view.center を動かす (最終中心の実測は
    // browser側で Paper実体に確認させる; ここでは offset のみ固定).
    const preCenter = { x: 480, y: 360 }
    const fixed = { x: 580, y: 410 }
    const newZoom = 0.5 + 0.5
    const scaling = 0.5 / newZoom
    const postOffset = {
      x: fixed.x - (fixed.x - preCenter.x) * scaling - preCenter.x,
      y: fixed.y - (fixed.y - preCenter.y) * scaling - preCenter.y,
    }
    expect(newZoom).toBe(1)
    expect(postOffset.x).toBeCloseTo(50, 12)
    expect(postOffset.y).toBeCloseTo(25, 12)
  })

  it('無選択時は view.center が固定点 (=画面中央が動かない) [確定]', () => {
    // 現行CSS側の同値則は zoomViewportAtSurfacePoint の固定点pin
    // (既存helper、<1px保持は viewport-reset-band 側で測定済み).
    // ここでは Paper側の対応式が floor で止まることを固定する.
    expect(clampPaperZoom(0.5 - 0.5)).toBe(PAPER_OUTERMOST_ZOOM_LEVEL)
    expect(paperZoomStepAdditive(0.5, -1)).toBe(PAPER_OUTERMOST_ZOOM_LEVEL)
  })
})

describe('paper-truth: 初期reset / 同期・非同期', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    '初期系列は setup→resetZoom(同期)→importImage→maybeZoomToFit [確定 paper-canvas.jsx:45-71,194-205] (reference source oracle)',
    async () => {
      const src = await readRef(REF_PAPER_CANVAS)
      expect(src).toContain('paper.setup(this.canvas)')
      expect(src).toContain("paper.view.on('resize'")
      expect(src).toContain('resetZoom()')
      expect(src).toContain('this.importImage(')
      expect(src).toContain('maybeZoomToFit')
      expect(src).toContain('zoomToFit(isBitmapMode)')
      expect(src).toContain('paper.view.matrix = this.shouldZoomToFit')
    },
  )

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    '非同期点は recalibrateSize setTimeout(0) / bitmap onload / svg sandbox-promise [確定] (reference source oracle)',
    async () => {
      const src = await readRef(REF_PAPER_CANVAS)
      expect(src).toContain('window.setTimeout(')
      expect(src).toContain('imgElement.onload')
      expect(src).toContain('getPaperSandbox().then')
      expect(src).toContain('this._importGeneration')
    },
  )

  it('初回は shouldZoomToFit=true のため表示zoomはreset0.5ではない [確定 49-57,194-204]', () => {
    // zoomLevelId なし: updateViewBounds(matrix) のみ (reset直後の0.5行列).
    // zoomLevelId あり・未保存: shouldZoomToFit=true -> zoomToFit() が上書き.
    // zoomToFit は base0.5 から ratio で 0.5..4 に拡大のみ (縮小なし).
    expect(resolvePaperFitZoom({ width: 10, height: 10 }, { width: 2000, height: 2000 }, false)).toBe(
      PAPER_FIT_MAX_ZOOM,
    )
    expect(resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, true)).toBeGreaterThanOrEqual(
      0.5,
    )
  })
})

describe('paper-truth: reset・wheel・button・pan limits', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'reset は zoom=0.5 + workspace再設定 + clamp [確定 view.js:144-149] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('paper.project.view.zoom = .5')
      expect(src).toContain('setWorkspaceBounds(true')
      expect(src).toContain('clampViewBounds()')
    },
  )

  it('product reset zoom matches the pinned oracle (independent)', () => {
    expect(PAPER_RESET_ZOOM).toBe(0.5)
  })

  it('button は +/-0.5、floor発は 0.5-0.333=0.167 [確定 paint-editor.jsx:211-226]', () => {
    expect(paperZoomStepAdditive(1, 1)).toBeCloseTo(1.5, 12)
    expect(paperZoomStepAdditive(1, -1)).toBeCloseTo(0.5, 12)
    expect(paperZoomStepAdditive(PAPER_OUTERMOST_ZOOM_LEVEL, 1)).toBeCloseTo(PAPER_RESET_ZOOM, 12)
    expect(0.5 - PAPER_OUTERMOST_ZOOM_LEVEL).toBeCloseTo(0.167, 12)
    // 現行 vector CSS 換算の wiring例 (+0.5 Paper /2.5 = +0.2 CSS).
    expect(buttonZoomStepForPaperDensity(1, 1, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(1.2, 12)
    expect(cssScaleStepForPaperStep(0.5, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(0.2, 12)
    expect(paperStepForCssScaleStep(0.2, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(0.5, 12)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'wheel は ctrl/meta のみzoom (-dy/1000)、他はpan (dx/zoom) [確定 scrollable-canvas.jsx:94-127] (reference source oracle)',
    async () => {
      const src = await readRef(REF_SCROLLABLE)
      expect(src).toContain('event.metaKey || event.ctrlKey')
      expect(src).toContain('zoomOnFixedPoint(-deltaY / 1000, fixedPoint)')
      expect(src).toContain('deltaY / paper.view.zoom')
      expect(src).toContain('deltaX / paper.view.zoom')
      expect(src).toContain("deltaMode === 0x1 ? 15 : 1")
    },
  )

  it('wheel/pan numeric examples match the pinned oracle (independent)', () => {
    // 数値例: -100 tick @0.5 -> 0.6; +120 @0.5 -> 0.38 (floor上).
    expect(paperWheelZoomAdditive(0.5, -100)).toBeCloseTo(0.6, 12)
    expect(paperWheelZoomAdditive(0.5, 120)).toBeCloseTo(0.38, 12)
    // 現行 vector CSS 換算: +0.1 Paper /2.5 = +0.04 CSS.
    expect(wheelZoomForPaperDensity(1, -100, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(1.04, 12)
    // pan数値例: dy=120 @zoom0.5 -> 240 world (CSS UIは /zoom しない点が差分).
    expect(120 / 0.5).toBe(240)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'pan limits は workspace clamp (Paperはclamp、現行CSSは無制限) [確定 view.js:78-93] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('scrollBy(new paper.Point(_workspaceBounds.left - left, 0))')
      expect(src).toContain('setWorkspaceBounds()')
    },
  )

  it('workspace-center clamp numeric examples (independent)', () => {
    // 数値例: 可視 1600x1200 @0.5 (=3200x2400 world) は workspace より
    // 大きいため中心にsnapする.
    const tiny = clampPaperCenterToWorkspace(
      { x: 0, y: 0 },
      PAPER_OUTERMOST_ZOOM_LEVEL,
      { width: 5000, height: 5000 },
    )
    expect(tiny).toEqual(PAPER_ART_CENTER)
    const atReset = clampPaperCenterToWorkspace(
      { x: 480, y: 360 },
      PAPER_RESET_ZOOM,
      { width: 800, height: 600 },
    )
    expect(atReset).toEqual({ x: 480, y: 360 })
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'scrollbar は tx += dx*zoom*2 (panの /zoom と逆向きのgain) [確定 scrollable-canvas.jsx:55,80] (reference source oracle)',
    async () => {
      const src = await readRef(REF_SCROLLABLE)
      expect(src).toContain('dx * paper.view.zoom * 2')
      expect(src).toContain('dy * paper.view.zoom * 2')
    },
  )

  it('scrollbar gain numeric example (independent)', () => {
    // 数値例: dx=10 @0.5 -> matrix tx +10 (matrix単位は zoom*2 倍).
    expect(10 * 0.5 * 2).toBe(10)
  })

  it('UI帯域の表現限界: legacy unknown帯域 [0.25,5] と per-mode帯域の対応', () => {
    // legacy unknown帯域では 0.2/0.1332 は 0.25 に丸まる (unknown reset 1 のまま)。
    expect(clampViewportScale(0.2)).toBe(0.25)
    expect(clampViewportScale(0.333 / VECTOR_PAPER_TO_CSS_DENSITY)).toBe(0.25)
    // per-mode帯域では live (vector 0.2/0.1332、res2 0.5/0.333): 表現限界なし。
    expect(clampViewportScaleForDensity(0.2, VECTOR_PAPER_TO_CSS_DENSITY)).toBeCloseTo(0.2, 12)
    expect(clampViewportScaleForDensity(0.5, 1)).toBeCloseTo(0.5, 12)
  })
})

describe('paper-truth: fit / workspace clamp と現行差', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'fit式は (bounds(+50 bitmapのみ))*1.5 / client / base0.5 / ratio[0.125,1] [確定 view.js:168-201] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('.expand(BUFFER)')
      expect(src).toContain('PADDING_PERCENT / 100')
      expect(src).toContain('canvas.clientWidth')
      expect(src).toContain('paper.view.zoom / ratio')
    },
  )

  it('fit zoom numeric examples match the pinned oracle (independent)', () => {
    // 400x300 bitmap in 800x600: padded (450,350)*1.5=(675,525),
    // ratio=0.5*max(675/800,525/600)=0.4375 -> fit=0.5/0.4375=1.142857.
    const fit = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, true)
    expect(fit).toBeCloseTo(1.142857, 5)
    // 同一内容の vector (expandなし): padded (600,450),
    // ratio=0.5*max(0.75,0.75)=0.375 -> fit=1.3333 (bitmapより緩い).
    const vfit = resolvePaperFitZoom({ width: 400, height: 300 }, { width: 800, height: 600 }, false)
    expect(vfit).toBeCloseTo(1.333333, 5)
    expect(fit).toBeLessThan(vfit)
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)(
    'mouse作用域は bitmap=ART_BOARD、vector=view∩workspace [確定 view.js:161-166] (reference source oracle)',
    async () => {
      const src = await readRef(REF_VIEW)
      expect(src).toContain('if (isBitmap)')
      expect(src).toContain('return ART_BOARD_BOUNDS')
      expect(src).toContain('paper.view.bounds.unite(ART_BOARD_BOUNDS).intersect(MAX_WORKSPACE_BOUNDS)')
    },
  )
})
