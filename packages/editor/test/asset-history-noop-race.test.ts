import { describe, expect, it } from 'bun:test'

/**
 * reshape 点追加/削除・リサイズの no-op 巻き戻しが、非同期で並走する別編集の
 * 履歴/redo を壊さないことの回帰テスト。
 *
 * 旧実装: capture 後に `assetUndoStack.slice(0, -1)` で pop + redo 復元。
 * - A が capture → B が capture → A が pop の順だと、pop が B を捨てて A が残る。
 * - B が成功して redo を正しく空にした後でも、A の redo 復元が古い redo を蘇らせる。
 *
 * 新実装 (Editor.svelte): `peekCostumeHistory` (無副作用の読取) →
 * 成功時のみ `commitPaintHistory`。no-op はスタック不変・redo 温存。
 */

type Entry = { id: string }
function ids(entries: Entry[]): string[] {
  return entries.map((entry) => entry.id)
}

// ---- 旧パターンの再現 (テスト内のシミュレーション) ----
async function oldCapture(
  stacks: { undo: Entry[]; redo: Entry[] },
  id: string,
  gate?: Promise<void>,
) {
  if (gate) await gate
  // captureCostumeHistory 相当: push + redo クリア (await loadAsset の後)。
  stacks.undo = [...stacks.undo, { id }].slice(-30)
  stacks.redo = []
}

function oldNoopRollback(stacks: { undo: Entry[]; redo: Entry[] }, redoBackup: Entry[]) {
  stacks.undo = stacks.undo.slice(0, -1)
  stacks.redo = redoBackup
}

// ---- 新パターンの再現 (Editor.svelte の peek/commit と同形) ----
function peekEntry(id: string): Entry {
  return { id }
}
function commitEntry(stacks: { undo: Entry[]; redo: Entry[] }, entry: Entry) {
  stacks.undo = [...stacks.undo, entry].slice(-30)
  stacks.redo = []
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('asset history no-op race', () => {
  it('旧 pop 巻き戻しは並走した別履歴を捨てる (欠陥の再現)', async () => {
    const stacks = { undo: [{ id: 'base' }], redo: [] as Entry[] }
    const redoBackupA = [...stacks.redo]

    // A(no-op 予定) が先に capture して積む。
    await oldCapture(stacks, 'A')
    // 並走する B(成功) が後から capture して積む。
    await oldCapture(stacks, 'B')
    expect(ids(stacks.undo)).toEqual(['base', 'A', 'B'])

    // A が no-op と判断して末尾を pop → B を誤って捨て、A が残る。
    oldNoopRollback(stacks, redoBackupA)
    expect(ids(stacks.undo)).toEqual(['base', 'A'])
    expect(ids(stacks.undo)).not.toContain('B')
  })

  it('旧 redo 復元は成功した別編集の redo クリアを無効化する (欠陥の再現)', async () => {
    const stacks = { undo: [{ id: 'U0' }], redo: [{ id: 'R-old' }] }
    const redoBackupA = [...stacks.redo]

    await oldCapture(stacks, 'A') // A capture: redo は空になる
    expect(stacks.redo).toEqual([])
    await oldCapture(stacks, 'B') // B 成功: redo 空のままが正しい
    expect(ids(stacks.undo)).toEqual(['U0', 'A', 'B'])

    oldNoopRollback(stacks, redoBackupA) // A の no-op 復元
    // B が正しく空にした redo に古い 'R-old' が蘇る + B が消える二重の破壊。
    expect(ids(stacks.redo)).toEqual(['R-old'])
    expect(ids(stacks.undo)).toEqual(['U0', 'A'])
  })

  it('新 peek/commit は no-op が別履歴・redo を温存する', async () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] }

    // A は peek のみ (スタック無副作用) → 非同期ゲート中に B が成功 commit。
    const gateA = deferred()
    const peekA = peekEntry('A')
    const runA = (async () => {
      await gateA.promise // loadAsset/mutation 相当の待機
      const added = false // no-op 判定
      if (added) commitEntry(stacks, peekA)
      // no-op: 何もしない (redo にも触れない)
    })()
    commitEntry(stacks, peekEntry('B')) // 並走する成功編集
    gateA.resolve()
    await runA

    expect(ids(stacks.undo)).toEqual(['base', 'B'])
    expect(ids(stacks.redo)).toEqual([]) // B の成功によるクリアが保たれる
  })

  it('新 peek/commit は成功だけを履歴に積み、順序不定でも他者を消さない', async () => {
    const stacks = { undo: [{ id: 'base' }], redo: [{ id: 'R' }] }
    const gateA = deferred()
    const gateB = deferred()
    const peekA = peekEntry('A')
    const peekB = peekEntry('B')
    const runA = (async () => {
      await gateA.promise
      commitEntry(stacks, peekA) // A 成功
    })()
    const runB = (async () => {
      await gateB.promise
      // B は no-op → 破棄
      void peekB
    })()
    // 完了順を逆転させても、成功した A だけが残る。
    gateB.resolve()
    await runB
    gateA.resolve()
    await runA
    expect(ids(stacks.undo)).toEqual(['base', 'A'])
    expect(ids(stacks.redo)).toEqual([])
  })

  it('Editor.svelte の peek/commit は begin/end 分離で pop/redo 退避を使わない', async () => {
    const source = await Bun.file(new URL('../src/Editor.svelte', import.meta.url)).text()
    expect(source).toContain('async function peekCostumeHistory')
    expect(source).toContain('function commitPaintHistory')
    // commit 本体は guard 不一致を破棄し redo 温存 (no-op 復活なし)。
    const commitStart = source.indexOf('function commitPaintHistory')
    expect(commitStart).toBeGreaterThan(-1)
    const commitBody = source.slice(commitStart, commitStart + 700)
    expect(commitBody).toContain('isGuardCurrent')
    expect(commitBody).not.toContain('slice(0, -1)')

    const bodyOfFn = (name: string) => {
      const start = source.indexOf(name)
      expect(start).toBeGreaterThan(-1)
      // 次のトップレベル `async function` / `function` までを関数本体とみなす。
      const rest = source.slice(start)
      const nextFn = rest.slice(100).search(/\n\s*(?:async )?function\s/)
      return nextFn < 0 ? rest : rest.slice(0, 100 + nextFn)
    }

    // 点追加/削除は即時確定のため関数内で peek→成功時のみ commit。
    for (const name of ['async function addVectorPathPointAt', 'async function deleteVectorReshapePoints'] as const) {
      const body = bodyOfFn(name)
      expect(body).not.toContain('slice(0, -1)')
      expect(body).not.toContain('redoBackup')
      expect(body).not.toContain('assetRedoStack =')
      expect(body).not.toContain('assetUndoStack =')
      expect(body).not.toContain('paintUndoStack =')
      expect(body).not.toContain('paintRedoStack =')
      expect(body).toContain('peekCostumeHistory')
      expect(body).toContain('commitPaintHistory')
    }

    // リサイズは gesture 先頭で peek (begin)、終端 quiescence 後に end が
    // 1 件だけ commit する。apply 自体は preview 専用で履歴に触れない。
    for (const name of ['function beginVectorObjectResize', 'function beginVectorMultiResize'] as const) {
      const body = bodyOfFn(name)
      expect(body).toContain('peekCostumeHistory')
      expect(body).toContain('historyReady')
      expect(body).toContain('beginVectorWriteGesture()')
      expect(body).toContain('structureEpoch')
      expect(body).not.toContain('commitPaintHistory')
      expect(body).not.toContain('slice(0, -1)')
      expect(body).not.toContain('redoBackup')
    }
    const applyBody = bodyOfFn('async function applyLiveVectorResize')
    expect(applyBody).not.toContain('peekCostumeHistory')
    expect(applyBody).not.toContain('commitPaintHistory')
    expect(applyBody).not.toContain('slice(0, -1)')
    expect(applyBody).not.toContain('redoBackup')
    expect(applyBody).not.toContain('paintUndoStack =')
    expect(applyBody).not.toContain('paintRedoStack =')
    // no-op フレームは moved を立てず、履歴に触れない。
    expect(applyBody).toContain('moved')
    const endBody = bodyOfFn('async function endVectorObjectResize')
    expect(endBody).not.toContain('peekCostumeHistory')
    expect(endBody).not.toContain('slice(0, -1)')
    expect(endBody).not.toContain('redoBackup')
    expect(endBody).not.toContain('paintUndoStack =')
    expect(endBody).not.toContain('paintRedoStack =')
    // 終端は deferred peek (historyReady/pendingEntry) を moved 時のみ
    // 1 件 commit し、quiescence 待ちで成功だけを積む。
    expect(endBody).toContain('historyReady')
    expect(endBody).toContain('pendingEntry')
    expect(endBody).toContain('commitPaintHistory')

    // capture 本体も peek/commit 経由で二重実装になっていないこと。
    const captureStart = source.indexOf('async function captureCostumeHistory')
    expect(captureStart).toBeGreaterThan(-1)
    const captureBody = source.slice(captureStart, captureStart + 600)
    expect(captureBody).toContain('peekCostumeHistory')
    expect(captureBody).toContain('commitPaintHistory')
  })
})
