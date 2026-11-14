// diag-A root-cause reproduction (unit, no browser, no product-code edit).
//
// Faithfully replays the Editor.svelte resize data flow against the REAL pure
// primitives (`paint-history.ts` trimming/guards + `vector-costume-write-gate.ts`
// per-slot FIFO) with a fake gated VM:
//
//   shape draw : capture (peek+commit BEFORE write) -> gated vm.updateCostume
//   resize move: peek -> gated vm.updateCostume -> commit AFTER write
//   pointerup  : `await applyLive(final)` once, read historyCaptured, clear drag
//
// Strict checks: exact SVG bytes, costume metadata (rotationCenter/dataFormat),
// redo stacks, and TWO full Undo/Redo cycles. The buggy replay proves one Undo
// erases both shape+resize (resize entry never lands); the fixed replay (deferred
// peek at begin + committing claim + quiescence, mirroring rotate/point/leaf)
// proves Undo returns to pre-resize, second Undo to blank, and Redo x2 replays.

import { describe, expect, it } from 'bun:test';
import {
  createScopeGuard,
  isGuardCurrent,
  paintScopeId,
  trimHistoryStacks,
  PAINT_HISTORY_MAX_BYTES,
  PAINT_HISTORY_MAX_ENTRIES,
  type HistoryScopeGuard,
} from '../src/lib/paint-history';
import {
  beginVectorWriteGesture,
  enqueueVectorCostumeWrite,
  resetVectorWriteGateForTests,
  vectorWriteSlotKey,
} from '../src/features/costumes/vector-costume-write-gate';
import {
  createVectorResizeCommitState,
  resizeCommitOnBegin,
  resizeCommitOnPointerUp,
  resizeCommitOnPreviewApplied,
  shouldCommitVectorResizeHistory,
} from '../src/features/costumes/vector-resize-commit-gate';

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">';
const BLANK = `${HEAD}</svg>`;
const BASELINE = `${HEAD}<rect x="150" y="120" width="140" height="110" fill="#e74c3c" stroke="#111111" stroke-width="2"/></svg>`;
const RESIZED = `${HEAD}<rect x="150" y="120" width="180" height="134" fill="#e74c3c" stroke="#111111" stroke-width="2"/></svg>`;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const fnv = (b: Uint8Array) => {
  let h = 0x811c9dc5;
  for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};

type Meta = { dataFormat: string; rotationCenterX: number; rotationCenterY: number };
type CostumeEntry = { kind: 'costume'; targetName: string; index: number; meta: Meta; bytes: Uint8Array };

function makeMeta(): Meta {
  return { dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 };
}

// Fake gated VM: loadAsset is instant, updateCostume delayed by gateMs when
// the gate is on (mirrors diag-A `__dragRaceGate` wrapping vm.updateCostume).
function makeVm(gate: { mode: 'off' | 'all'; ms: number }) {
  const store = new Map<string, { meta: Meta; bytes: Uint8Array }>();
  store.set('VecA:0', { meta: makeMeta(), bytes: enc(BLANK) });
  return {
    async loadAsset(key: string): Promise<Uint8Array> {
      const hit = store.get(key);
      if (!hit) throw new Error(`missing ${key}`);
      return new Uint8Array(hit.bytes);
    },
    async updateCostume(targetName: string, index: number, meta: Meta, bytes: Uint8Array): Promise<void> {
      if (gate.mode === 'all') await new Promise((r) => setTimeout(r, gate.ms));
      store.set(`${targetName}:${index}`, { meta: { ...meta }, bytes: new Uint8Array(bytes) });
    },
    readLive(): { meta: Meta; bytes: Uint8Array } {
      return store.get('VecA:0')!;
    },
  };
}

// Minimal Editor history-side replica (paint side only): peek attaches a guard
// bound to paintScopeId(targetId,index)+generation; commit is guard-checked and
// clears redo via trimHistoryStacks([...undo, entry], []).
function makePaintSide() {
  let undo: CostumeEntry[] = [];
  let redo: CostumeEntry[] = [];
  const scopeKey = paintScopeId('VecA-target-id', 0);
  const generation = 7;
  const guards = new Map<CostumeEntry, HistoryScopeGuard>();
  return {
    peek(live: { meta: Meta; bytes: Uint8Array }): CostumeEntry {
      const e: CostumeEntry = {
        kind: 'costume', targetName: 'VecA', index: 0,
        meta: { ...live.meta }, bytes: new Uint8Array(live.bytes),
      };
      guards.set(e, createScopeGuard(scopeKey, generation));
      return e;
    },
    commit(e: CostumeEntry) {
      const g = guards.get(e);
      if (g && !isGuardCurrent(scopeKey, generation, g)) return;
      const t = trimHistoryStacks(undo, [], PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES);
      undo = [...t.undo, e] as CostumeEntry[];
      redo = [];
    },
    undoOnce(live: { meta: Meta; bytes: Uint8Array }): CostumeEntry | undefined {
      const top = undo.at(-1);
      if (!top) return undefined;
      undo = undo.slice(0, -1);
      const cur: CostumeEntry = {
        kind: 'costume', targetName: 'VecA', index: 0,
        meta: { ...live.meta }, bytes: new Uint8Array(live.bytes),
      };
      const t = trimHistoryStacks(undo, [...redo, cur], PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES);
      undo = t.undo as CostumeEntry[];
      redo = t.redo as CostumeEntry[];
      return top;
    },
    redoOnce(live: { meta: Meta; bytes: Uint8Array }): CostumeEntry | undefined {
      const top = redo.at(-1);
      if (!top) return undefined;
      redo = redo.slice(0, -1);
      const cur: CostumeEntry = {
        kind: 'costume', targetName: 'VecA', index: 0,
        meta: { ...live.meta }, bytes: new Uint8Array(live.bytes),
      };
      const t = trimHistoryStacks([...undo, cur], redo, PAINT_HISTORY_MAX_ENTRIES, PAINT_HISTORY_MAX_BYTES);
      undo = t.undo as CostumeEntry[];
      redo = t.redo as CostumeEntry[];
      return top;
    },
    get undo() { return undo; },
    get redo() { return redo; },
  };
}

describe('diag-A resize history race (buggy Editor order vs fixed gate)', () => {
  it('buggy: gated resize write resolves after pointerup teardown, commit is dropped; one Undo erases shape+resize', async () => {
    resetVectorWriteGateForTests();
    const gate = { mode: 'all' as const, ms: 300 };
    const vm = makeVm(gate);
    const hist = makePaintSide();
    const slot = vectorWriteSlotKey('VecA-target-id', 0);

    // --- baseline shape draw (capture BEFORE write, Editor.svelte saveVectorShapeInRect) ---
    const preShape = vm.readLive();
    expect(dec(preShape.bytes)).toBe(BLANK);
    const shapeEntry = hist.peek(preShape);
    hist.commit(shapeEntry);
    // Shape write itself goes through the same FIFO as `edit`.
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, makeMeta(), enc(BASELINE)),
    );
    gate.mode = 'off';
    // Settle: FIFO drained.
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BASELINE);
    expect(hist.undo.length).toBe(1);
    expect(hist.redo.length).toBe(0);
    expect(dec(hist.undo[0]!.bytes)).toBe(BLANK);
    expect(hist.undo[0]!.meta).toEqual(makeMeta());

    // --- resize drag with VM gate ON (diag-A `setGate('all', 300)`) ---
    gate.mode = 'all';
    const resizeBefore = dec(vm.readLive().bytes);
    expect(resizeBefore).toBe(BASELINE);
    const undoLenBeforeResize = hist.undo.length;

    // Editor begin: sourceReady snapshot starts (instant here), no historyReady.
    const sourceReady = Promise.resolve({ targetName: 'VecA', costumeIndex: 0, svgText: BASELINE });

    // Editor applyLiveVectorResize frame 1: peek THEN gated write THEN commit.
    // We interleave pointerup while the gated write is still in flight.
    let dragAlive: { pointerId: number; applying: boolean; historyCaptured: boolean } | undefined = {
      pointerId: 9, applying: false, historyCaptured: false,
    };
    let pendingEntry: CostumeEntry | undefined;
    let droppedCommit = false;

    const frame1 = (async () => {
      if (!dragAlive) return false;
      dragAlive.applying = true;
      pendingEntry = hist.peek(vm.readLive()); // pre-resize bytes = BASELINE
      expect(dec(pendingEntry.bytes)).toBe(BASELINE);
      const source = await sourceReady;
      void source;
      // resizeVectorElementBy applied (pure DOM) -> gated VM write:
      await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
        vm.updateCostume('VecA', 0, makeMeta(), enc(RESIZED)),
      );
      // Editor post-write guard (Editor.svelte ~L8334):
      if (!dragAlive) { droppedCommit = true; return false; } // <-- BUG: drag already cleared
      hist.commit(pendingEntry!);
      dragAlive.historyCaptured = true;
      dragAlive.applying = false;
      return true;
    })();

    // pointerup arrives 50ms later while frame1 is still gated (300ms):
    await new Promise((r) => setTimeout(r, 50));
    // Editor endVectorObjectResize: `await applyLive(final)` while applying=true
    // only stores pending and returns; then reads historyCaptured===false and
    // clears the drag. Model exactly that teardown:
    const changedAtPointerUp = dragAlive?.historyCaptured ?? false;
    expect(changedAtPointerUp).toBe(false); // no commit yet: gate still pending
    dragAlive = undefined; // vectorResizeDrag = undefined
    gate.mode = 'off';
    await frame1;
    // FIFO fully drained (also flushes any coalesced pending, which the buggy
    // path already discarded by clearing the drag).
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});

    const resizedLive = dec(vm.readLive().bytes);
    expect(resizedLive).toBe(RESIZED); // artwork DID advance ...
    expect(droppedCommit).toBe(true); // ... but the commit was dropped
    expect(hist.undo.length).toBe(undoLenBeforeResize); // resize history unrecorded
    expect(hist.redo.length).toBe(0);

    // --- strict Undo/Redo: one Undo erases BOTH steps (shape + resize) ---
    const h0 = fnv(enc(resizedLive));
    const wantPreResize = BASELINE;
    const cur0 = vm.readLive();
    const popped = hist.undoOnce(cur0);
    expect(popped).toBeDefined();
    expect(dec(popped!.bytes)).toBe(BLANK); // only shape entry survived
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...popped!.meta }, new Uint8Array(popped!.bytes)),
    );
    gate.mode = 'off';
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    const afterUndo = dec(vm.readLive().bytes);
    expect(afterUndo).toBe(BLANK); // NOT wantPreResize: 2 steps erased
    expect(afterUndo).not.toBe(wantPreResize);
    expect(vm.readLive().meta).toEqual(makeMeta());
    // Redo re-applies the resized bytes (single redo entry = pre-undo live).
    expect(hist.redo.length).toBe(1);
    expect(dec(hist.redo[0]!.bytes)).toBe(RESIZED);
    expect(hist.redo[0]!.meta).toEqual(makeMeta());
    void h0;

    const cur1 = vm.readLive();
    const redone = hist.redoOnce(cur1);
    expect(dec(redone!.bytes)).toBe(RESIZED);
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...redone!.meta }, new Uint8Array(redone!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(RESIZED);

    // Second cycle: still collapses to blank, never visits BASELINE.
    const cur2 = vm.readLive();
    const popped2 = hist.undoOnce(cur2);
    expect(dec(popped2!.bytes)).toBe(BLANK);
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...popped2!.meta }, new Uint8Array(popped2!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BLANK);
    const cur3 = vm.readLive();
    const redone2 = hist.redoOnce(cur3);
    expect(dec(redone2!.bytes)).toBe(RESIZED);
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...redone2!.meta }, new Uint8Array(redone2!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(RESIZED);
  });

  it('fixed: deferred peek + committing claim + quiescence records exactly one resize entry; 2x Undo/Redo walks BASELINE', async () => {
    resetVectorWriteGateForTests();
    const gate = { mode: 'all' as const, ms: 300 };
    const vm = makeVm(gate);
    const hist = makePaintSide();
    const slot = vectorWriteSlotKey('VecA-target-id', 0);

    // Baseline shape (same as above).
    const shapeEntry = hist.peek(vm.readLive());
    hist.commit(shapeEntry);
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, makeMeta(), enc(BASELINE)),
    );
    gate.mode = 'off';
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BASELINE);

    // Fixed resize session (pure helper, unwired): peek at begin.
    let st = createVectorResizeCommitState();
    const gestureId = beginVectorWriteGesture();
    const preResizeLive = vm.readLive();
    const deferred = hist.peek(preResizeLive); // historyReady resolves pre-resize
    st = resizeCommitOnBegin(st, true);
    expect(st.phase).toBe('dragging');

    // Gated preview write as kind:'preview' on the same FIFO (rotate parity).
    gate.mode = 'all';
    await enqueueVectorCostumeWrite(slot, gestureId, 'preview', () =>
      vm.updateCostume('VecA', 0, makeMeta(), enc(RESIZED)),
    );
    st = resizeCommitOnPreviewApplied(st);
    gate.mode = 'off';
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(RESIZED);

    // Pointerup: sync committing claim BEFORE any await, wait quiescence
    // (applying===false here), re-apply final absolute delta (idempotent),
    // commit exactly once.
    st = resizeCommitOnPointerUp(st);
    expect(shouldCommitVectorResizeHistory(st)).toBe(true);
    hist.commit(deferred);
    expect(hist.undo.length).toBe(2);
    expect(dec(hist.undo[0]!.bytes)).toBe(BLANK);
    expect(dec(hist.undo[1]!.bytes)).toBe(BASELINE);
    expect(hist.undo[1]!.meta).toEqual(makeMeta());
    expect(hist.redo.length).toBe(0);

    // Undo 1 -> pre-resize preview (BASELINE), byte- and meta-identical.
    const u1 = hist.undoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...u1!.meta }, new Uint8Array(u1!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BASELINE);
    expect(vm.readLive().meta).toEqual(makeMeta());
    expect(hist.redo.length).toBe(1);
    expect(dec(hist.redo[0]!.bytes)).toBe(RESIZED);

    // Redo 1 -> resized.
    const r1 = hist.redoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...r1!.meta }, new Uint8Array(r1!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(RESIZED);

    // Undo 2 -> blank; Redo 2 -> BASELINE; Redo 3 -> RESIZED (full walk).
    const u2 = hist.undoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...u2!.meta }, new Uint8Array(u2!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BASELINE);
    const u3 = hist.undoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...u3!.meta }, new Uint8Array(u3!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BLANK);
    expect(hist.redo.length).toBe(2);
    const rr1 = hist.redoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...rr1!.meta }, new Uint8Array(rr1!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(BASELINE);
    const rr2 = hist.redoOnce(vm.readLive());
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', () =>
      vm.updateCostume('VecA', 0, { ...rr2!.meta }, new Uint8Array(rr2!.bytes)),
    );
    await enqueueVectorCostumeWrite(slot, undefined, 'edit', async () => {});
    expect(dec(vm.readLive().bytes)).toBe(RESIZED);
    expect(vm.readLive().meta).toEqual(makeMeta());
  });
});
