// 子選択レビューで疑われた2点の実UI再現テスト (製品変更なし).
//
// ① group内2 leaf Shift選択後、選択中の単一anchorクリックで選択縮約し、
//    その後に Shift+別leaf選択/移動して古いleafが誤操作されないか.
//    疑い: anchor press-release無移動の縮約 (`endVectorPathPointDrag` の
//    `collapseTo` 経路) が point選択だけ畳んで leaf同期
//    (`syncReshapeLeavesToPoints`) を呼ばないため、内部leaf集合が stale
//    ([0,1] のまま) になり、直後の Shift+別leafトグル/移動が古いleafを
//    巻き込む. 検出は各leafの外形(dまたはx/y/width/heightを含むouterHTML)・
//    兄弟順・point indices・Undo/Redoで行う.
//
// ② `syncReshapeLeavesToPoints` の Paper async await中に選択を高速連続変更
//    しても、最新point/leaf選択が古い応答に上書きされないか. 対象切替
//    (reshape->select正規化) と Undo/Redoも検証する. 疑い: 同関数は
//    target/costume/objectしかガードせず point選択版を見ないため、
//    先発の遅い解決が後発の選択を上書きし得る. 検出は同上+選択版数の安定待ち.
//
// 方針: いずれも正しい振る舞いをassertする. 現時点でバグが再現しない場合は
// テストがそのまま通り、回帰ガードになる. 再現した場合は対応するexpectが
// 落ち、失敗メッセージとleafスナップショット差分で差分箇所が分かる.
// (例: ①なら Shift+B後の選択数が4のまま/移動でAが変化、②なら最終選択と
//  artworkの不一致や切替後の選択復活).
//
// HMR注意: 実行中に無関係UIファイルが保存されるとVite HMRでページが
// リロードし、選択・previewが揮発して flaky になる. 本ファイルは無関係
// ファイルを変更せず、操作ごとに `waitForFunction` で安定待ちし、
// rapid連打後は意図的に静定(600ms+)を置いて古いasync解決の着地を待つ.
// HMRリロードが疑われる場合は `:4367` のViteログと `page.reload()` 後の
// 再試行で切り分けること.
//
// Chrome: /etc/profiles/per-user/nakasyou/bin/google-chrome を既定とし、
// CHROME_BIN/BROWSER があればそちらを優先する.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4367'
const CHROME_PATH = '/etc/profiles/per-user/nakasyou/bin/google-chrome'
let server: ChildProcess | undefined
let browser: Browser | undefined
let page: Page

process.env.CHROME_BIN ??= CHROME_PATH

async function selectedPointIndices(): Promise<number[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]')]
      .map((el) => Number((el as HTMLElement).dataset.pointIndex))
      .sort((a, b) => a - b),
  )
}

async function selectedAnchorCount() {
  return await page.locator('[data-vector-path-point][aria-pressed="true"]').count()
}

async function waitForSelectedCount(expected: number) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-vector-path-point][aria-pressed="true"]').length === count,
    expected,
  )
}

async function waitForAnchorTotal(expected: number) {
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('[data-vector-path-point]')].filter((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Move path point'),
      ).length === count,
    expected,
  )
}

async function previewSvg() {
  return await page.locator('.vector-preview').innerHTML()
}

async function waitForPreviewSvg(expected: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML === svg, expected)
}

async function waitForPreviewSvgChange(previous: string) {
  await page.waitForFunction((svg) => document.querySelector('.vector-preview')?.innerHTML !== svg, previous)
}

// previewがしばらく変化しない(安定)のを待つ. HMRリロードや遅いasync解決の
// 着地を待つための静定ゲート.
async function waitForPreviewStable(quietMs = 600) {
  await page.waitForFunction(
    (ms) =>
      new Promise<boolean>((resolve) => {
        const el = document.querySelector('.vector-preview')
        if (!el) {
          resolve(false)
          return
        }
        let last = el.innerHTML
        let lastChange = Date.now()
        const timer = setInterval(() => {
          const now = el.innerHTML
          if (now !== last) {
            last = now
            lastChange = Date.now()
          } else if (Date.now() - lastChange > (ms as number)) {
            clearInterval(timer)
            resolve(true)
          }
        }, 60)
        setTimeout(() => {
          clearInterval(timer)
          resolve(true)
        }, (ms as number) + 8000)
      }),
    quietMs,
  )
}

type LeafSnapshot = {
  kids: string[]
  transform: string
  count: number
  hasMarker: boolean
}

async function leafSnapshot(): Promise<LeafSnapshot> {
  return await page.evaluate(() => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const group = doc.querySelector('g.xyo-vector-explicit-group')
    const kids = group ? Array.from(group.children).map((el) => (el as Element).outerHTML) : []
    return {
      kids,
      transform: group?.getAttribute('transform') ?? '',
      count: kids.length,
      hasMarker: html.includes('xyo-vector-explicit-group'),
    }
  })
}

// 各leafの識別しやすい要約 (d / x,y,w,h / 兄弟順の差分検出用).
function leafSummary(outer: string): string {
  const d = outer.match(/\bd="([^"]*)"/)?.[1]
  if (d !== undefined) return `d(len=${d.length}):${d.slice(0, 120)}`
  const attrs = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'points']
    .map((k) => `${k}=${outer.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? '?'}`)
    .join(' ')
  return `${outer.slice(0, 60)}|${attrs}`
}

async function leafIndexOfFlat(flat: number): Promise<number | undefined> {
  return await page.evaluate(async (index) => {
    const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    const units = editableVectorUnits(doc.documentElement)
    const group = units[0]
    if (!group) return undefined
    try {
      const leaf = await paper.paperLeafIndexForFlatAnchor(group, index as number)
      return leaf ?? undefined
    } catch {
      return undefined
    }
  }, flat)
}

async function flatAnchorsOfLeaves(leaves: number[]): Promise<number[]> {
  return await page.evaluate(async (want) => {
    const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    const units = editableVectorUnits(doc.documentElement)
    const group = units[0]
    if (!group) return []
    try {
      return ((await paper.paperFlatAnchorIndicesForGroupLeaves(group, want as number[])) ?? []).slice().sort((a: number, b: number) => a - b)
    } catch {
      return []
    }
  }, leaves)
}

async function blankCanvas() {
  await page.getByTestId('main-tab-costumes').click()
  const surface = page.getByTestId('costume-paint-surface')
  await surface.waitFor({ state: 'visible' })
  const bitmapCanvas = page.getByTestId('bitmap-editor-canvas')
  if (await bitmapCanvas.isVisible()) {
    await page.getByRole('button', { name: 'ベクターに変換' }).click()
  }
  await page.getByTestId('vector-shape-select').last().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.waitForTimeout(700)
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
  return surface
}

// 2 rect重なりグループ (A:90,110,130x120 / B:170,110,130x120) を作り、
// reshape入場まで行う. 各leafのd・兄弟・point indicesの観測起点.
// HMRリロードでUIが揮発している可能性に備え、最初にページを再取得する.
//
// Fixture注記 (2026-11-12 実測切り分け):
// 外枠 `costume-paint-surface` への 480x360 直結マッピングは viewport
// (pan/scale) 依存で描画点が画面外へ飛び、rect が0〜1個しか残らず Group
// が disabled のまま落ちた. 製品 marquee (`paperVectorIndicesInRect` の
// tight-polygon 判定) は独立 probe で enclosing 時に正しく [0(,1)] を返し
// ており回帰ではない. そこで本テストは他スイートと同様に Reset zoom +
// Zoom out x5 で art 全体を可視化し、描画・marquee・click の全操作を
// `[data-vector-stage-surface]` 基準の同一 document 座標
// (`artClient`) に統一する. 1枚目描画後は select+blank で選択解除して
// から2枚目を描く (重なり辺 170,110 での rect-tool move-drag 化を避け、
// 2 leaf を確定させる). Group ボタンは toolbar-icon との曖昧さを避ける
// ため、同一ゲート (`selectedVectorObjectIndices.length >= 2`) の
// sidebar 側 (`title="Group the selected objects"`) を明示指定する.
// 厳格さは維持: 2 rect の座標・marquee 範囲・8 anchors・Group 必須は不変.
async function setupTwoLeafGroup() {
  await page.goto(base, { waitUntil: 'networkidle' })
  await blankCanvas()
  // Viewport を確定させて art 全体を外枠内に収める (fill-curves 他と同形).
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(1200)
  const artClient = (svgX: number, svgY: number) =>
    page.evaluate(
      ({ x, y }) => {
        const stage = document.querySelector('[data-vector-stage-surface="true"]') as HTMLElement | null
        if (!stage) throw new Error('vector stage surface missing')
        const rect = stage.getBoundingClientRect()
        return { x: rect.left + (x / 480) * rect.width, y: rect.top + (y / 360) * rect.height }
      },
      { x: svgX, y: svgY },
    )
  const rectTool = page.getByTestId('vector-shape-rect').last()
  await rectTool.click()
  {
    const from = await artClient(90, 110)
    const to = await artClient(220, 230)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
  }
  await page.waitForTimeout(900)
  // 1枚目が選択されたまま2枚目の press (170,110 は A 上辺) が
  // move-drag 化しないよう、select+blank で明示解除する.
  await page.getByTestId('vector-shape-select').last().click()
  {
    const blank = await artClient(30, 30)
    await page.mouse.click(blank.x, blank.y)
    await page.waitForTimeout(500)
  }
  await rectTool.click()
  {
    const from = await artClient(170, 110)
    const to = await artClient(300, 230)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
  }
  await page.waitForTimeout(900)
  // Fixture 健全性: marquee 前に2 rect が意図座標で存在すること.
  // (viewport ずれの再発はここで fail-fast し、Group 段と切り分ける).
  const drawnCount = await page.evaluate(async () => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    return editableVectorUnits(doc.documentElement).length
  })
  expect(drawnCount).toBe(2)
  await page.getByTestId('vector-shape-select').last().click()
  // 実UIでの複数選択: Ctrl+Aがフォーカス次第で不発のため、marqueeドラッグを
  // 第一経路にし、Group有効化を待ってから押す (両方とも実UI操作).
  const marquee = async () => {
    const from = await artClient(70, 90)
    const to = await artClient(320, 250)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
  }
  await marquee()
  await page.waitForTimeout(600)
  // 製品 oracle: enclosing marquee は両 rect に一致する (回帰なしの証拠).
  const marqueeProbe = await page.evaluate(async () => {
    const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
    const units = editableVectorUnits(doc.documentElement)
    try {
      return await paper.paperVectorIndicesInRect(units, { x: 70, y: 90, width: 250, height: 160 })
    } catch {
      return undefined
    }
  })
  expect(marqueeProbe).toEqual([0, 1])
  // Group は toolbar 側 (aria-label="Group", 常時可視) を押す. sidebar 側
  // (`title="Group the selected objects"`) とゲートは同一
  // (`selectedVectorObjectIndices.length >= 2`) だが、viewport 幅次第で
  // 非可視のため実UI操作としては toolbar が安定. 厳格さは不変.
  const groupBtn = page.getByRole('button', { name: 'Group' }).first()
  if (!(await groupBtn.isEnabled().catch(() => false))) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.waitForTimeout(600)
  }
  if (!(await groupBtn.isEnabled().catch(() => false))) {
    await marquee()
    await page.waitForTimeout(600)
  }
  await groupBtn.click()
  await page.waitForTimeout(700)
  expect(await previewSvg()).toContain('xyo-vector-explicit-group')

  const reshapeTool = page.getByTestId('vector-shape-reshape').last()
  await reshapeTool.click()
  await page.waitForSelector('[data-vector-path-point]')
  await waitForAnchorTotal(8)
  expect(await selectedAnchorCount()).toBe(0)

  const targets = await page.evaluate(() => {
    const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const group = doc.querySelector('g.xyo-vector-explicit-group') as Element | null
    if (!group) throw new Error('group missing')
    const kids = Array.from(group.children) as Element[]
    if (kids.length !== 2) throw new Error(`expected 2 leaves, saw ${kids.length}`)
    const boundsOf = (el: Element) => ({
      x: Number(el.getAttribute('x') ?? '0'),
      y: Number(el.getAttribute('y') ?? '0'),
      width: Number(el.getAttribute('width') ?? '0'),
      height: Number(el.getAttribute('height') ?? '0'),
    })
    const a = boundsOf(kids[0]!)
    const b = boundsOf(kids[1]!)
    return {
      aX: a.x + Math.min(a.width, b.x - a.x) / 2,
      aY: a.y + a.height / 2,
      bX: a.x + a.width + (b.x + b.width - (a.x + a.width)) / 2,
      bY: b.y + b.height / 2,
    }
  })
  expect(targets.aX).toBeLessThan(targets.bX)
  return { artClient, targets, reshapeTool }
}

describe('子選択レビュー疑い2点の実UI再現', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4367', '--strictPort'], {
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
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'networkidle' })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('① 2leaf Shift選択→単一anchorクリック縮約→Shift+別leaf選択/移動で古いleafを誤操作しない', async () => {
    // 2026-11-11実測: REPRODUCED。縮約(flat=0 leaf=0)後のShift+別leaf(1)で
    // expected 8点に対し actual 4点([0,1,2,3])。collapseTo縮約がleaf同期を
    // 欠いたstale疑いと一致。移動隔離・Undo/Redo自体は別leaf単体選択から検証.
    const { artClient, targets } = await setupTwoLeafGroup()
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')

    // A単体→Shift+Bで両leaf選択(8anchors). 各leafの兄弟・point indices起点.
    {
      const target = await artClient(targets.aX, targets.aY)
      await page.mouse.click(target.x, target.y)
      await waitForSelectedCount(4)
    }
    const afterA = await leafSnapshot()
    expect(afterA.count).toBe(2)
    const flatsA = await selectedPointIndices()
    expect(flatsA).toHaveLength(4)
    {
      const target = await artClient(targets.bX, targets.bY)
      await page.keyboard.down('Shift')
      await page.mouse.click(target.x, target.y)
      await page.keyboard.up('Shift')
      await waitForSelectedCount(8)
    }
    const bothFlats = await selectedPointIndices()
    expect(bothFlats).toHaveLength(8)
    await waitForPreviewStable()

    // 選択中の単一anchorをプレーンclick(=press+release無移動)して1点に縮約.
    // 疑いのcollapseTo経路を通すためハンドル要素を直接clickする.
    const handles = page.locator('[data-vector-path-point]')
    await handles.first().click()
    await waitForSelectedCount(1)
    const collapsed = await selectedPointIndices()
    expect(collapsed).toHaveLength(1)
    const collapsedLeaf = await leafIndexOfFlat(collapsed[0]!)
    expect(collapsedLeaf === 0 || collapsedLeaf === 1).toBe(true)
    // 縮約後のvoid leaf同期の着地を待つ(速すぎると stale 窓を見逃すため静定).
    await page.waitForTimeout(900)
    await waitForPreviewStable()
    const otherLeaf = collapsedLeaf === 0 ? 1 : 0
    const otherTarget = otherLeaf === 0 ? targets.aX : targets.bX
    const otherTargetY = otherLeaf === 0 ? targets.aY : targets.bY

    // Shift+別leaf選択: 縮約leaf + 別leaf の8点に戻るのが正しい.
    // stale leaf([0,1]のまま)だと Bトグルで逆に4点へ外れるため検出できる.
    {
      const target = await artClient(otherTarget, otherTargetY)
      // 診断: この文書座標が実際にどちらのleafに当たるかをPaper実ヒットで確認.
      const probe = await page.evaluate(async ({ x, y }) => {
        const paper = await import(/* @vite-ignore */ '/src/features/costumes/paper-vector.ts')
        const html = document.querySelector('.vector-preview')?.innerHTML ?? ''
        const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
        const { editableVectorUnits } = await import(/* @vite-ignore */ '/src/features/costumes/vector-svg.ts')
        const group = editableVectorUnits(doc.documentElement)[0]
        if (!group) return { error: 'no group' }
        try {
          return await paper.paperGroupLeafHitAtPoint(group, { x: x as number, y: y as number })
        } catch (error) {
          return { error: String(error) }
        }
      }, { x: otherTarget, y: otherTargetY })
      console.log(`review-① shift-click probe doc=(${otherTarget},${otherTargetY}) collapsedLeaf=${collapsedLeaf} otherLeaf=${otherLeaf} probe=${JSON.stringify(probe)}`)
      await page.keyboard.down('Shift')
      await page.mouse.click(target.x, target.y)
      await page.keyboard.up('Shift')
      await page.waitForTimeout(900)
      await waitForPreviewStable()
    }
    const afterShift = await selectedPointIndices()
    const expectedFlats = await flatAnchorsOfLeaves([collapsedLeaf!, otherLeaf])
    console.log(`review-① afterShift=[${afterShift}] expectedFlats=[${expectedFlats}] collapsed=${collapsed} leaf=${collapsedLeaf} other=${otherLeaf}`)
    expect(expectedFlats).toHaveLength(8)
    // 正: 縮約leafと別leafの和集合8点. 誤(再現中): stale leaf集合([0,1]のまま)
    // からのトグルで別leafが外れ、縮約leafの4点に留まる. 断定は最後にまとめ、
    // ここでは記録して移動隔離の検証へ進む(実測: afterShift=[0,1,2,3]).
    const toggleOk = JSON.stringify(afterShift) === JSON.stringify(expectedFlats)
    console.log(`review-① toggle ${toggleOk ? 'OK (not reproduced)' : `BUG REPRODUCED: expected 8 got ${afterShift.length}`}`)

    // 移動隔離の検証は決定論的状態から行う: 別leafをプレーンclickで単体選択
    // (4点)し、そのleafだけをドラッグ移動する. 各leafのd・兄弟・point
    // indices・Undoで古いleafの誤操作を検出する.
    {
      const target = await artClient(otherTarget, otherTargetY)
      await page.mouse.click(target.x, target.y)
      await waitForSelectedCount(4)
    }
    const isolated = await selectedPointIndices()
    const isolatedLeaf = await leafIndexOfFlat(isolated[0]!)
    expect(isolatedLeaf).toBe(otherLeaf)
    expect(isolated).toEqual(await flatAnchorsOfLeaves([otherLeaf]))

    // 別leaf側anchorをドラッグ移動し、古い(縮約)leafが不変か各leafのd・兄弟で検証.
    const beforeMoveSvg = await previewSvg()
    const beforeMove = await leafSnapshot()
    expect(beforeMove.count).toBe(2)
    // 別leafに属する選択中ハンドルを1つ掴む (data-point-indexで特定).
    const otherFlats = await flatAnchorsOfLeaves([otherLeaf])
    const otherSelected = isolated.filter((i) => otherFlats.includes(i))
    expect(otherSelected.length).toBe(4)
    const dragIndex = otherSelected[0]!
    const dragHandle = page.locator(`[data-vector-path-point][data-point-index="${dragIndex}"]`)
    const dragBox = await dragHandle.boundingBox()
    if (!dragBox) throw new Error('missing drag handle')
    const fromX = dragBox.x + dragBox.width / 2
    const fromY = dragBox.y + dragBox.height / 2
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move(fromX + 30, fromY + 14, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(beforeMoveSvg)
    await waitForPreviewStable()
    const afterMoveSvg = await previewSvg()
    const afterMove = await leafSnapshot()
    expect(afterMove.hasMarker).toBe(true)
    expect(afterMove.count).toBe(2)
    expect(afterMove.transform).toBe(beforeMove.transform)
    // 古いleaf Mishandling検出: 縮約leaf側はバイト同一、別leaf側のみ変化、順序維持.
    // kids[0]=leaf0, kids[1]=leaf1 の対応はsetup直後の順序で固定.
    const staleSide = collapsedLeaf!
    const movedSide = otherLeaf
    expect(
      afterMove.kids[staleSide],
      `stale leaf ${staleSide} must stay byte-identical.\nbefore: ${leafSummary(beforeMove.kids[staleSide]!)}\nafter:  ${leafSummary(afterMove.kids[staleSide]!)}`,
    ).toBe(beforeMove.kids[staleSide])
    expect(afterMove.kids[movedSide]).not.toBe(beforeMove.kids[movedSide])
    // 選択は移動後も別leaf単体(4点)のまま.
    expect(await selectedPointIndices()).toEqual(isolated)

    // Undo/Redo: 移動1件のみで、Undoで縮約直後、Redoで移動後に戻る.
    // 各leafのd・point indices・undoの観測で差分検出.
    await undoButton.click()
    await waitForPreviewSvg(beforeMoveSvg)
    expect((await leafSnapshot()).kids).toEqual(beforeMove.kids)
    await redoButton.click()
    await waitForPreviewSvg(afterMoveSvg)
    expect((await leafSnapshot()).kids).toEqual(afterMove.kids)

    // 最終断定: 縮約直後の Shift+別leaf が正しく加算されなければバグ再現.
    // 移動隔離自体は上記で検証済みのため、ここが落ちても原因はトグル側にある.
    expect(
      toggleOk,
      `REPRODUCED ①: 縮約(flat=${collapsed} leaf=${collapsedLeaf})後のShift+別leaf(${otherLeaf})で expected 8点[${expectedFlats}] に対し actual ${afterShift.length}点[${afterShift}]. collapseTo縮約がleaf同期を欠いたstale疑い.`,
    ).toBe(true)

    console.log(
      `review-① result: collapsedFlat=${collapsed[0]} leaf=${collapsedLeaf}, shiftAfter=[${afterShift}], staleLeaf${staleSide} unchanged OK (not reproduced = healthy)`,
    )
  }, 240_000)

  it('② syncReshapeLeavesToPointsのasync競合: 高速連続選択でも最新が勝ち、切替/Undoで上書きされない', async () => {
    // 2026-11-11実測: 本条件(leaf連打・anchor Shift連打・select切替・Undo前後連打)
    // では再現せず(healthy pass)。古い応答の上書きは観測されなかったため、
    // 本legは回帰ガードとして維持する。再現できた場合は対応するexpectが落ちる.
    const { artClient, targets } = await setupTwoLeafGroup()
    const undoButton = page.locator('button[aria-label="Undo"]:visible')
    const redoButton = page.locator('button[aria-label="Redo"]:visible')

    // 高速連続のleaf選択トグル: A→B→A を待ちなしで連打し、async解決を重ねる.
    // 各clickはPaper import(初回は特に遅い)を伴うため、先発の遅い解決が
    // 後発を上書きする実装なら最終選択が崩れる.
    const clickLeaf = async (x: number, y: number, shift: boolean) => {
      const target = await artClient(x, y)
      if (shift) await page.keyboard.down('Shift')
      await page.mouse.click(target.x, target.y)
      if (shift) await page.keyboard.up('Shift')
    }
    await clickLeaf(targets.aX, targets.aY, false)
    await waitForSelectedCount(4)
    // 待ちなし3連打 (B→A→B): 最後はB単体4点が正しい.
    await clickLeaf(targets.bX, targets.bY, false)
    await clickLeaf(targets.aX, targets.aY, false)
    await clickLeaf(targets.bX, targets.bY, false)
    // 古いasyncの着地猶予 + 静定.
    await page.waitForTimeout(1200)
    await waitForPreviewStable()
    const raced = await selectedPointIndices()
    const expectedB = await flatAnchorsOfLeaves([1])
    expect(expectedB).toHaveLength(4)
    expect(raced).toEqual(expectedB)

    // anchor単位の高速Shiftトグル連打でも最新版が勝つ.
    // B単体(4点)から別anchor2点をShift連打で足し、最終2点追加が正しい.
    // (Paper per-anchor importのループ中に選択が変わる経路を叩く)
    const anchorHandles = page.locator('[data-vector-path-point]')
    const totalAnchors = await anchorHandles.count()
    expect(totalAnchors).toBe(8)
    // 未選択のA側anchorを2つShift+click連打 (待ちなし).
    const centers: Array<{ x: number; y: number; index: number; pressed: boolean }> = []
    for (let i = 0; i < totalAnchors; i++) {
      const handleBox = await anchorHandles.nth(i).boundingBox()
      if (!handleBox) continue
      centers.push({
        x: handleBox.x + handleBox.width / 2,
        y: handleBox.y + handleBox.height / 2,
        index: Number(await anchorHandles.nth(i).getAttribute('data-point-index')),
        pressed: ((await anchorHandles.nth(i).getAttribute('aria-pressed')) ?? '') === 'true',
      })
    }
    const unselected = centers.filter((c) => !c.pressed).slice(0, 2)
    expect(unselected.length).toBe(2)
    for (const c of unselected) {
      await page.keyboard.down('Shift')
      await page.mouse.click(c.x, c.y)
      await page.keyboard.up('Shift')
    }
    await page.waitForTimeout(1200)
    await waitForPreviewStable()
    const afterRapidToggle = await selectedPointIndices()
    // B4点 + A側2点 = 6点が正しい. 古い解決の上書きなら4/8等に外れる.
    expect(afterRapidToggle).toHaveLength(6)
    expect(afterRapidToggle).toContain(expectedB[0]!)
    for (const c of unselected) expect(afterRapidToggle).toContain(c.index)

    // 対象切替: 選択asyncの飛行中に selectへ戻す(正規化で選択消去).
    // 古いleaf解決が新選択を復活させる実装ならハンドルが戻ってしまう.
    await clickLeaf(targets.aX, targets.aY, false)
    await page.waitForTimeout(150)
    await page.getByTestId('vector-shape-select').last().click()
    await page.waitForFunction(() => document.querySelectorAll('[data-vector-path-point]').length === 0)
    await page.waitForTimeout(1200)
    await waitForPreviewStable()
    expect(await page.locator('[data-vector-path-point]').count()).toBe(0)
    const clearedSvg = await previewSvg()
    expect(clearedSvg).toContain('xyo-vector-explicit-group')

    // Undo検証: reshapeに戻ってB移動1件→Undo/Redoが古い応答に壊されない.
    await page.getByTestId('vector-shape-reshape').last().click()
    await page.waitForSelector('[data-vector-path-point]')
    await waitForAnchorTotal(8)
    await clickLeaf(targets.bX, targets.bY, false)
    await waitForSelectedCount(4)
    const preMoveSvg = await previewSvg()
    const preMove = await leafSnapshot()
    const selB = await selectedPointIndices()
    const dragIdx = selB[0]!
    const dragBox2 = await page.locator(`[data-vector-path-point][data-point-index="${dragIdx}"]`).boundingBox()
    if (!dragBox2) throw new Error('missing drag handle for undo leg')
    const fx = dragBox2.x + dragBox2.width / 2
    const fy = dragBox2.y + dragBox2.height / 2
    await page.mouse.move(fx, fy)
    await page.mouse.down()
    await page.mouse.move(fx + 26, fy + 12, { steps: 10 })
    await page.mouse.up()
    await waitForPreviewSvgChange(preMoveSvg)
    await waitForPreviewStable()
    const movedSvg = await previewSvg()
    const moved = await leafSnapshot()
    // 各leafのd・兄弟: leaf0不変・leaf1のみ変化・順序維持.
    expect(moved.count).toBe(2)
    expect(moved.kids[0]).toBe(preMove.kids[0])
    expect(moved.kids[1]).not.toBe(preMove.kids[1])
    // Undo直後に選択を連打してもartworkはUndo状態に留まる.
    await undoButton.click()
    await waitForPreviewSvg(preMoveSvg)
    await clickLeaf(targets.aX, targets.aY, false)
    await clickLeaf(targets.bX, targets.bY, false)
    await page.waitForTimeout(1200)
    await waitForPreviewStable()
    // artwork自体はUndo状態のまま(選択連打は履歴を書かない).
    expect(await previewSvg()).toBe(preMoveSvg)
    await redoButton.click()
    await waitForPreviewSvg(movedSvg)
    expect((await leafSnapshot()).kids).toEqual(moved.kids)

    console.log(
      `review-② result: rapid leaf race final=[${raced}], toggle6=[${afterRapidToggle}], switch-cleared OK, undo/redo OK (not reproduced = healthy)`,
    )
  }, 240_000)
})
