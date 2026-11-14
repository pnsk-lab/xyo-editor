import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { hasScratchReference, readScratchReference } from './scratch-reference'

import {
  PAINT_HISTORY_MAX_BYTES,
  PAINT_HISTORY_MAX_ENTRIES,
  SOUND_HISTORY_MAX_BYTES,
  SOUND_HISTORY_MAX_ENTRIES,
  isGuardCurrent,
  trimHistoryStacks,
} from '../src/lib/paint-history'

/**
 * Scratch Paint undo と Editor 描画/音声分離履歴のスコープ・上限・変換/
 * 切替・redo無効化の仕様を固定するテスト。
 *
 * 方針: コード編集はしない。新規テストのみで、既存ソースの静的表明と
 * 履歴スタックの振る舞いシミュレーションに留める (他エージェントの編集中
 * ファイルに干渉しないよう Editor.svelte 等への書込は一切行わない)。
 *
 * 新仕様 (本テストが固定する内容):
 * - 描画 (costume) と音声 (sound) は分離スタック。コスチューム Undo が音声
 *   や別 costume を巻き戻さないし、逆もない。
 * - 描画履歴はアクティブ costume/対象の切替で CLEAR され、新規選択は独立
 *   する。音声履歴は GLOBAL で、音声選択や対象の切替では温存される
 *   (従来の跨 sound/target アンドゥを維持; costume 切替でも消えない)。
 *   音声側の削除/復元/reorder/duplicate は全履歴を無条件 CLEAR し、ずれた
 *   index への誤復元を防ぐ。
 * - スコープ鍵は content-hash (`assetId`/`md5ext`, 保存ごとに変わる) を
 *   使わない。`stableTargetId:index` と削除/復元/reorder ハンドラの明示
 *   CLEAR で rename/reorder/delete への安全性と bitmap/vector 変換の同一
 *   costume 扱いを守る。nudge/drag の async pending は scope guard で整合
 *   する。worker 同期のような VM オブジェクト置換に依存しない。
 * - 上限100 + encoded-bytes 予算 (paint 24MB / sound 32MB) で最古から
 *   追い出す。no-op は peek 破棄のみで redo に触れない。
 *
 * 参照 (読取のみ、任意チェックアウト。clean clone には存在しないため
 * 参照依存の表明は明示スキップし、製品側の独立表明は常に実行する。
 * 詳細は `test/scratch-reference.ts`):
 * - .tmp/scratch-editor/packages/scratch-paint/src/reducers/undo.js (MAX 100)
 * - .tmp/scratch-editor/packages/scratch-paint/src/helper/undo.js
 * - .tmp/scratch-editor/packages/scratch-paint/src/hocs/undo-hoc.jsx
 * - .tmp/scratch-editor/packages/scratch-paint/src/containers/paper-canvas.jsx
 * - packages/editor/src/Editor.svelte (分離スタック, 上限100+予算)
 * - packages/editor/src/lib/paint-history.ts (純粋 helper)
 */

// Optional upstream oracle (see `test/scratch-reference.ts`): lazy
// conditional reads so this file loads on clean clones without the
// git-ignored `.tmp/scratch-editor` checkout (no ENOENT at module top).
// Reference-dependent assertions below skip via `it.skipIf` when absent.
const HAS_SCRATCH_REFERENCE = hasScratchReference()

function scratchPath(rel: string): string {
  return fileURLToPath(new URL(`../../../.tmp/scratch-editor/packages/scratch-paint/${rel}`, import.meta.url))
}

const scratchUndo = (await readScratchReference(scratchPath('src/reducers/undo.js'))) ?? ''
const scratchHelper = (await readScratchReference(scratchPath('src/helper/undo.js'))) ?? ''
const scratchPaperCanvas = (await readScratchReference(scratchPath('src/containers/paper-canvas.jsx'))) ?? ''
const scratchBitmapHelper = (await readScratchReference(scratchPath('src/helper/bitmap.js'))) ?? ''
const scratchFormatReducer = (await readScratchReference(scratchPath('src/reducers/format.js'))) ?? ''
const editorSource = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
const paintHistorySource = await Bun.file(new URL('../src/lib/paint-history.ts', import.meta.url)).text()

function bodyOf(source: string, fn: string, length = 2500): string {
  let start = source.indexOf(fn)
  if (start < 0) {
    // Async-aware fallback: tolerate callers pinning with/without `async`.
    const alt = fn.startsWith('async ') ? fn.replace(/^async\s+/, '') : `async ${fn}`
    start = source.indexOf(alt)
  }
  if (start < 0) throw new Error(`Missing ${fn}`)
  // Reactive `$: if (...)` pins are intentionally narrow fixed windows: they
  // assert block-local isolation (no opposite sync), so they must NOT expand
  // to the next function (which would swallow later reactive blocks).
  if (!fn.includes('function')) return source.slice(start, start + length)
  const rest = source.slice(start)
  // Next-function bounded slice for function pins: survive prepended pending
  // discard/cancel blocks that push the tab-split `undoHistorySide('costume')`
  // ~23 chars beyond the stale 2500 window. Length hint kept for compatibility
  // but never truncates the own function body.
  const next = rest.slice(100).search(/\n\s*(?:async\s+)?function\s/)
  if (next < 0) return rest
  return rest.slice(0, 100 + next)
}

// ---- 参照 reducer の純粋再実装 (比較用。参照コードのコピーではなく同形の検証器) ----
type ScratchState = { stack: string[]; pointer: number }
const SCRATCH_MAX = 100
function scratchSnapshot(state: ScratchState, snapshot: string): ScratchState {
  if (state.pointer >= SCRATCH_MAX - 1) {
    return {
      stack: state.stack.slice(state.pointer - SCRATCH_MAX + 2, state.pointer + 1).concat(snapshot),
      pointer: SCRATCH_MAX - 1,
    }
  }
  return { stack: state.stack.slice(0, state.pointer + 1).concat(snapshot), pointer: state.pointer + 1 }
}

// ---- 新仕様 Editor の paint/sound 分離 commit と同形の検証器 ----
type Entry = { kind: 'costume' | 'sound'; id: string; bytes: Uint8Array }
function newTrim(undo: Entry[], redo: Entry[], maxEntries: number, maxBytes: number) {
  return trimHistoryStacks(undo, redo, maxEntries, maxBytes)
}

describe('scratch-paint undo (参照, 100件) の要点', () => {
  it.skipIf(!HAS_SCRATCH_REFERENCE)('上限100・pointer方式・redo切捨て・CLEARを持つ', () => {
    expect(scratchUndo).toContain('const MAX_STACK_SIZE = 100')
    expect(scratchUndo).toContain('pointer: -1')
    // 新規 SNAPSHOT は pointer 以降 (redo 側) を切り捨てる
    expect(scratchUndo).toContain('state.stack.slice(0, state.pointer + 1).concat(action.snapshot)')
    expect(scratchUndo).toContain('pointer: state.pointer + 1')
    // オーバーフロー時は最古を捨てて100件維持
    expect(scratchUndo).toContain('pointer: MAX_STACK_SIZE - 1')
    expect(scratchUndo).toContain(`case CLEAR:`)
    // UNDO/REDO は pointer 移動のみ (実復元は helper が Paper に importJSON)
    expect(scratchUndo).toContain('pointer: state.pointer - 1')
    expect(scratchUndo).toContain('pointer: state.pointer + 1')
  })

  it('101件目で最古が落ち、100件に収まる (reducer 同形検証)', () => {
    let state: ScratchState = { stack: [], pointer: -1 }
    for (let i = 0; i < 101; i += 1) state = scratchSnapshot(state, `s${i}`)
    expect(state.stack.length).toBe(100)
    expect(state.pointer).toBe(99)
    expect(state.stack[0]).toBe('s1')
    expect(state.stack.at(-1)).toBe('s100')
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)('undo 復元は skipSnapshot で履歴を増やさず、形式は SKIP_CONVERT で戻す', () => {
    // helper: _restore → onUpdateImage(true /* skipSnapshot */)
    expect(scratchHelper).toContain('onUpdateImage(true /* skipSnapshot */)')
    // undo/redo 後の format は VECTOR_SKIP_CONVERT / BITMAP_SKIP_CONVERT (変換なし)
    expect(scratchHelper).toContain('VECTOR_SKIP_CONVERT')
    expect(scratchHelper).toContain('BITMAP_SKIP_CONVERT')
    // format reducer: UNDO/REDO も CHANGE_FORMAT と同じ扱いで format だけ載せ替える
    expect(scratchFormatReducer).toContain('case UNDO:')
    expect(scratchFormatReducer).toContain('case REDO:')
    expect(scratchFormatReducer).toContain('case CHANGE_FORMAT:')
    expect(scratchHelper).toContain('paintEditorFormat')
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)('コスチューム選択・対象切替ではスタックを CLEAR する', () => {
    // paper-canvas switchCostume: レイヤ掃除 → clearUndo (CLEAR dispatch)
    expect(scratchPaperCanvas).toContain('switchCostume (format, image, rotationCenterX')
    expect(scratchPaperCanvas).toContain('this.props.clearUndo()')
    // 初回 import 直後にも snapshot を1件積む (pointer 0 起点)
    expect(scratchPaperCanvas).toContain('performSnapshot(this.props.undoSnapshot, Formats.VECTOR_SKIP_CONVERT)')
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)('bitmap/vector 転換は変換後に snapshot を1件積む (redo は捨てる)', () => {
    // bitmap.js: convertToBitmap/convertToVector は onUpdateImage(false=履歴あり, 形式override)
    expect(scratchBitmapHelper).toContain('onUpdateImage(false /* skipSnapshot */, Formats.BITMAP')
    expect(scratchBitmapHelper).toContain('onUpdateImage(false /* skipSnapshot */, Formats.VECTOR')
  })
})

describe('Editor 描画/音声の分離履歴 (上限100+予算, 新仕様)', () => {
  it('共有 assetUndoStack を持たず paint/sound の分離スタックを持つ', () => {
    // 旧共有スタックの状態宣言は存在しない (SoundEditor への prop 渡し
    // `assetUndoStack={soundUndoStack}` の参照のみ残る)。
    expect(editorSource).not.toContain('let assetUndoStack')
    expect(editorSource).not.toContain('let assetRedoStack')
    expect(editorSource).toContain('let paintUndoStack')
    expect(editorSource).toContain('let paintRedoStack')
    expect(editorSource).toContain('let soundUndoStack')
    expect(editorSource).toContain('let soundRedoStack')
  })

  it('上限100・自側 redo のみ無効化・旧30件スライスなし', () => {
    expect(editorSource).not.toContain('.slice(-30)')
    expect(editorSource).toContain('PAINT_HISTORY_MAX_ENTRIES')
    expect(editorSource).toContain('SOUND_HISTORY_MAX_ENTRIES')
    expect(PAINT_HISTORY_MAX_ENTRIES).toBe(100)
    expect(SOUND_HISTORY_MAX_ENTRIES).toBe(100)
    const paintCommit = bodyOf(editorSource, 'function commitPaintHistory', 700)
    expect(paintCommit).toContain('trimHistoryStacks')
    // commit は自側 redo だけを空にして積む (他側に触れない)。
    expect(paintCommit).toContain('paintRedoStack = trimmed.redo')
    expect(paintCommit).not.toContain('soundRedoStack')
    const soundCommit = bodyOf(editorSource, 'function commitSoundHistory', 700)
    expect(soundCommit).toContain('trimHistoryStacks')
    expect(soundCommit).toContain('soundRedoStack = trimmed.redo')
    expect(soundCommit).not.toContain('paintRedoStack')
  })

  it('アクティブ costume 切替で描画履歴を CLEAR し、音声は温存する', () => {
    // 選択署名の reactive で描画スコープを同期 (音声には触れない)。
    const selection = bodyOf(editorSource, 'if (currentCostumeSelectionSignature !== costumeSelectionSignature)', 700)
    expect(selection).toContain('syncPaintScope()')
    expect(selection).not.toContain('syncSoundScope()')
    expect(selection).not.toContain('clearSoundHistory')
    // asset 変化の reactive でも両スコープを同期 (同スロット構造変化の検出)。
    const asset = bodyOf(editorSource, 'if (assetSignature !== assetEditorSignature)', 700)
    expect(asset).toContain('syncPaintScope()')
    expect(asset).toContain('syncSoundScope()')
    // sync は鍵 (target:index) または live artwork 参照の変化で CLEAR する。
    const sync = bodyOf(editorSource, 'function syncPaintScope', 1200)
    expect(sync).toContain('clearPaintHistory()')
    const clear = bodyOf(editorSource, 'function clearPaintHistory', 200)
    expect(clear).toContain('paintUndoStack = []')
    expect(clear).toContain('paintRedoStack = []')
    expect(clear).not.toContain('soundUndoStack')
  })

  it('音声選択の切替では音声履歴を温存し (GLOBAL)、描画は温存する', () => {
    const selection = bodyOf(editorSource, 'if (soundSelectionSignature !== previousSoundSelectionSignature)', 700)
    expect(selection).toContain('syncSoundScope()')
    expect(selection).not.toContain('syncPaintScope()')
    expect(selection).not.toContain('clearPaintHistory')
    expect(selection).not.toContain('clearSoundHistory')
    // 追跡のみで CLEAR しない: 切替で履歴を捨てると従来の跨 sound undo を失う。
    const sync = bodyOf(editorSource, 'function syncSoundScope', 1200)
    expect(sync).not.toContain('clearSoundHistory()')
  })

  it('削除/復元/reorder ハンドラは同スロット別 asset への誤復元を防ぐ', () => {
    // 描画: 削除は active 以前 (影響範囲) のスロットのみ CLEAR し、無関係な
    // 一覧整理では履歴を温存する。reorder/復元は無条件 CLEAR。
    // 構造変異は withTargetVectorStructure 内で drain→revert→shift する
    // (遅延 preview がずれた slot へ誤書きしない)。
    const del = bodyOf(editorSource, 'async function deleteCostume', 2000)
    expect(del).toContain('clearPaintOnCostumeSlotChange(index)')
    expect(del).toContain('captureVectorDragsForCostumeStructure(targetId)')
    expect(del).toContain('withTargetVectorStructure(targetId,')
    expect(del).toContain('revertCapturedVectorDragsForStructure(doomed)')
    const move = bodyOf(editorSource, 'function moveCostume', 1200)
    expect(move).toContain('clearPaintHistory()')
    expect(move).toContain('captureVectorDragsForCostumeStructure(targetId)')
    expect(move).toContain('withTargetVectorStructure(targetId,')
    expect(move).toContain('revertCapturedVectorDragsForStructure(doomed)')
    const drop = bodyOf(editorSource, 'function dropCostumeOn', 1500)
    expect(drop).toContain('clearPaintHistory()')
    expect(drop).toContain('captureVectorDragsForCostumeStructure(targetId)')
    expect(drop).toContain('withTargetVectorStructure(targetId,')
    expect(drop).toContain('revertCapturedVectorDragsForStructure(doomed)')
    const restoreDel = bodyOf(editorSource, 'async function restoreDeletedCostume', 1500)
    expect(restoreDel).toContain('clearPaintHistory()')
    expect(restoreDel).toContain('captureVectorDragsForCostumeStructure(targetId)')
    expect(restoreDel).toContain('withTargetVectorStructure(targetId,')
    expect(restoreDel).toContain('revertCapturedVectorDragsForStructure(doomed)')
    // 音声は GLOBAL のため、どの index の削除でも全履歴を捨てる (後続 slot が
    // ずれて別 sound を指すため)。reorder/復元/duplicate も無条件 CLEAR。
    const delS = bodyOf(editorSource, 'function clearSoundOnSoundSlotChange', 600)
    expect(delS).toContain('clearSoundHistory()')
    const moveS = bodyOf(editorSource, 'function moveSound', 600)
    expect(moveS).toContain('clearSoundHistory()')
    const dropS = bodyOf(editorSource, 'function dropSoundOn', 700)
    expect(dropS).toContain('clearSoundHistory()')
    const restoreDelS = bodyOf(editorSource, 'async function restoreDeletedSound', 1200)
    expect(restoreDelS).toContain('clearSoundHistory()')
    const dupS = bodyOf(editorSource, 'function duplicateSound', 500)
    expect(dupS).toContain('clearSoundHistory()')
  })

  it('Undo/Redo はタブで振り分け、相手側に触れない', () => {
    const undo = bodyOf(editorSource, 'async function undoAssetEdit', 2500)
    expect(undo).toContain(`selectedTab === 'sounds'`)
    expect(undo).toContain(`undoHistorySide('sound')`)
    expect(undo).toContain(`undoHistorySide('costume')`)
    const redo = bodyOf(editorSource, 'async function redoAssetEdit', 2500)
    expect(redo).toContain(`redoHistorySide('sound')`)
    expect(redo).toContain(`redoHistorySide('costume')`)
    // 復元は stale (別 asset・削除済み) を書かず理由を返す。描画は active
    // scope 不一致で拒否し、音声 (GLOBAL) は generation 不一致でのみ拒否する。
    const restore = bodyOf(editorSource, 'async function restoreHistoryEntry', 1500)
    expect(restore).toContain(`return 'scope changed'`)
    expect(restore).toContain(`return 'history cleared'`)
    expect(restore).toContain(`return 'target gone'`)
    expect(restore).toContain(`return 'costume gone'`)
  })

  it('bitmap/vector 変換は同一 costume 扱いで履歴を温存する', () => {
    const toBitmap = bodyOf(editorSource, 'async function convertCurrentCostumeToBitmap', 8000)
    expect(toBitmap).toContain('await captureCostumeHistory(selectedTarget, index)')
    expect(toBitmap).not.toContain('clearPaintHistory')
    expect(toBitmap).not.toContain('syncPaintScope')
    // 非同期ラスタライズ後の切替ガード (新選択への誤書き防止)。
    expect(toBitmap).toContain('paintScopeGeneration')
    // SVG からの変換は bitmap workspace ではなく、エンコード後の選択スコープを再検証する。
    expect(toBitmap).toContain('liveTargetAfterHistory')
    expect(toBitmap).toContain('paintScopeKey !== scopeKey')
    const toVector = bodyOf(editorSource, 'async function convertCurrentCostumeToVector', 8000)
    expect(toVector).toContain('await captureCostumeHistory(selectedTarget, index)')
    expect(toVector).not.toContain('clearPaintHistory')
    // stale canvas 読取防止: 変換前の workspace  settled 検証。
    expect(toVector).toContain('isBitmapWorkspaceSettledFor')
  })

  it('スコープ鍵は content-hash を使わない (保存ごとに変わるため)', () => {
    // helper の鍵は stableTargetId:index のみ。鍵の構成式自体に
    // assetId/md5ext は現れない (本文書コメントでの言及は除く)。
    expect(paintHistorySource).toContain('paint:${targetId}:${costumeIndex}')
    expect(paintHistorySource).toContain('sound:${targetId}:${soundIndex}')
    const paintKey = bodyOf(paintHistorySource, 'export function paintScopeId', 200)
    expect(paintKey).not.toContain('md5ext')
    expect(paintKey).not.toContain('assetId')
    const soundKey = bodyOf(paintHistorySource, 'export function soundScopeId', 200)
    expect(soundKey).not.toContain('md5ext')
    expect(soundKey).not.toContain('assetId')
    // Editor の選択署名も md5 を含まない (保存で CLEAR されない)。
    expect(editorSource).toContain('`${selectedTarget.id ?? selectedTarget.name}:${selectedTarget.currentCostume}`')
    expect(editorSource).toContain('stableTargetId')
  })

  it('nudge/drag の async pending は guard で整合し、no-op は redo 温存', () => {
    // commit は guard 不一致を破棄 (redo に触れない)。
    const paintCommit = bodyOf(editorSource, 'function commitPaintHistory', 700)
    expect(paintCommit).toContain('isGuardCurrent')
    // 点追加/削除は即時確定のため関数内で遅延 peek→成功CAS時のみ commit し、
    // pop/redo退避もスタック直書きもしない。commit は CAS applied 後のみで
    // no-op (added/deleted false) と conflict は履歴を汚さず redo を温存する。
    // 関数は約3k字超のため 8k window で CAS commit まで到達させる。
    for (const name of [
      'async function addVectorPathPointAt',
      'async function deleteVectorReshapePoints',
    ] as const) {
      const body = bodyOf(editorSource, name, 8000)
      expect(body).not.toContain('slice(0, -1)')
      expect(body).not.toContain('redoBackup')
      expect(body).not.toContain('paintUndoStack =')
      expect(body).not.toContain('paintRedoStack =')
      expect(body).not.toContain('captureCostumeHistory')
      expect(body).toContain('peekCostumeHistory')
      expect(body).toContain('await updateVectorCostumeFromEditor')
      expect(body).toContain('commitPaintHistory')
      // peek -> CAS applied -> commit の順序: no-op は CAS 前に return し、
      // conflict は applied 分岐前に return するので履歴を汚さない。
      expect(body.indexOf('peekCostumeHistory')).toBeLessThan(body.indexOf('updateVectorCostumeFromEditor'))
      expect(body.indexOf('commitPaintHistory')).toBeGreaterThan(body.indexOf('updateVectorCostumeFromEditor'))
      expect(body).toContain("kind !== 'applied'")
    }
    // リサイズは gesture 先頭で peek (begin)、終端 quiescence 後に end が
    // 1 件だけ commit。apply は preview 専用で履歴に触れない。
    for (const name of [
      'function beginVectorObjectResize',
      'function beginVectorMultiResize',
    ] as const) {
      const body = bodyOf(editorSource, name, 2500)
      expect(body).not.toContain('slice(0, -1)')
      expect(body).not.toContain('redoBackup')
      expect(body).not.toContain('paintUndoStack =')
      expect(body).not.toContain('paintRedoStack =')
      expect(body).not.toContain('commitPaintHistory')
      expect(body).toContain('peekCostumeHistory')
      expect(body).toContain('historyReady')
    }
    const applyBody = bodyOf(editorSource, 'async function applyLiveVectorResize', 2600)
    expect(applyBody).not.toContain('slice(0, -1)')
    expect(applyBody).not.toContain('redoBackup')
    expect(applyBody).not.toContain('paintUndoStack =')
    expect(applyBody).not.toContain('paintRedoStack =')
    expect(applyBody).not.toContain('peekCostumeHistory')
    expect(applyBody).not.toContain('commitPaintHistory')
    const endBody = bodyOf(editorSource, 'async function endVectorObjectResize', 4500)
    expect(endBody).not.toContain('slice(0, -1)')
    expect(endBody).not.toContain('redoBackup')
    expect(endBody).not.toContain('paintUndoStack =')
    expect(endBody).not.toContain('paintRedoStack =')
    expect(endBody).not.toContain('peekCostumeHistory')
    expect(endBody).toContain('historyReady')
    expect(endBody).toContain('commitPaintHistory')
    // nudge セッションは安定 id で再検証する (rename で切れない)。
    expect(editorSource).toContain('nudgePending.targetId !== targetId')
    expect(editorSource).toContain('stableTargetId(selectedTarget) !== targetId')
  })

  it('分離後は別 asset の編集を巻き戻さない (旧共有欠陥の解消検証)', () => {
    // paint 側と sound 側を独立に commit/undo する同形検証。
    let paintUndo: Entry[] = []
    let paintRedo: Entry[] = []
    let soundUndo: Entry[] = []
    let soundRedo: Entry[] = []
    const paintEntry: Entry = { kind: 'costume', id: 'costume-A0', bytes: new Uint8Array([1]) }
    const soundEntry: Entry = { kind: 'sound', id: 'sound-S0', bytes: new Uint8Array([2]) }
    ;({ undo: paintUndo, redo: paintRedo } = newTrim([...paintUndo, paintEntry], [], 100, PAINT_HISTORY_MAX_BYTES))
    ;({ undo: soundUndo, redo: soundRedo } = newTrim([...soundUndo, soundEntry], [], 100, SOUND_HISTORY_MAX_BYTES))
    // paint Undo は paint 側だけを見る。
    expect(paintUndo.at(-1)?.id).toBe('costume-A0')
    expect(soundUndo.at(-1)?.id).toBe('sound-S0')
    paintUndo = paintUndo.slice(0, -1)
    // paint 側を戻しても sound 側は無傷。
    expect(paintUndo.length).toBe(0)
    expect(soundUndo.length).toBe(1)
    expect(paintRedo.length).toBe(0)
    expect(soundRedo.length).toBe(0)
  })

  it('切替後の遅延 commit は guard 不一致で破棄される (redo 温存)', () => {
    // peek 時の guard (scope+generation 3) に対し、切替後は generation 4。
    const guard = { scopeKey: 'paint:t1:0', scopeGeneration: 3 }
    expect(isGuardCurrent('paint:t1:0', 3, guard)).toBe(true)
    expect(isGuardCurrent('paint:t1:1', 4, guard)).toBe(false)
    expect(isGuardCurrent('paint:t1:0', 4, guard)).toBe(false)
  })

  it('上限100で101件目に最古が落ちる (helper 同形検証)', () => {
    let undo: Entry[] = []
    let redo: Entry[] = []
    for (let i = 0; i < 101; i += 1) {
      ;({ undo, redo } = newTrim([...undo, { kind: 'costume', id: `e${i}`, bytes: new Uint8Array([i % 251]) }], redo, 100, PAINT_HISTORY_MAX_BYTES))
    }
    expect(undo.length).toBe(100)
    expect(undo[0]?.id).toBe('e1')
    expect(undo.at(-1)?.id).toBe('e100')
  })

  it('redo は自側の新規編集でのみ無効化される (両実装共通の不変条件、製品側)', () => {
    let undo: Entry[] = [{ kind: 'costume', id: 'a', bytes: new Uint8Array([1]) }]
    let redo: Entry[] = []
    // undo: 現行を redo へ (他側なし)。
    const entry = undo.at(-1)!
    const current: Entry = { kind: 'costume', id: 'a-cur', bytes: new Uint8Array([2]) }
    undo = undo.slice(0, -1)
    ;({ undo, redo } = newTrim(undo, [...redo, current], 100, PAINT_HISTORY_MAX_BYTES))
    expect(redo.length).toBe(1)
    // 自側の新規編集: redo 切捨て。
    ;({ undo, redo } = newTrim([...undo, { kind: 'costume', id: 'b', bytes: new Uint8Array([3]) }], [], 100, PAINT_HISTORY_MAX_BYTES))
    expect(redo).toEqual([])
  })

  it.skipIf(!HAS_SCRATCH_REFERENCE)('参照 reducer も SNAPSHOT で redo 側を切り捨てる (reference source oracle)', () => {
    expect(scratchUndo).toContain('state.stack.slice(0, state.pointer + 1).concat(action.snapshot)')
  })

  it('メモリ見積り: encoded bytes 上限100 + 予算で有界 (予算明記)', () => {
    // 480x360 RGBA デコード = 691,200B。保存単位は encoded (PNG/SVG) のため
    // 100件でも予算内に収まる設計。WAV (88KB/s) は件数上限だけでは発散する
    // ため sound 側の予算が binding になる。
    const bytesPerFrame = 480 * 360 * 4
    expect(bytesPerFrame).toBe(691200)
    expect(PAINT_HISTORY_MAX_ENTRIES).toBe(100)
    expect(SOUND_HISTORY_MAX_ENTRIES).toBe(100)
    expect(PAINT_HISTORY_MAX_BYTES).toBe(24 * 1024 * 1024)
    expect(SOUND_HISTORY_MAX_BYTES).toBe(32 * 1024 * 1024)
    // 典型 PNG 200KB x 100件 ~= 20MB は paint 予算内。
    expect(100 * 200 * 1024).toBeLessThanOrEqual(PAINT_HISTORY_MAX_BYTES)
    expect(editorSource).toContain('new Uint8Array(bytes)')
    expect(editorSource).toContain('structuredClone(')
  })
})
