# Bitmap pending-shape transaction design (Scratch paint parity, fail-closed)

Status: **superseded draft; do not implement as written.** No product code changed.

Safety review found that rows 13–14 and their supporting text are unsafe: export
reads stored assets and would omit a pending shape; `saveBitmapCostume` reads
canvas and could persist it while leaving a stale pending slot; silently
proceeding with a target or project switch after a failed commit can lose the
visible edit. Save, export and destructive transitions must instead await one
shared commit, refuse the transition with an actionable status on failure, and
retain the pending state for retry. The commit implementation must call a
separate lower-level save function to avoid recursive save/commit calls. All
transition and failure paths require tests before implementation.

Scope: bitmap `rect` / `oval` tools in `packages/editor`.
Goal: mouseUp must NOT rasterize. The new shape stays parametric under the
armed shape tool and commits to the raster exactly once on deselect.

Reference model (own-words summary, no source text copied):
`packages/scratch-paint` bit-tools keep a live vector object after mouseUp
(`rect-tool.js` / `oval-tool.js` `handleMouseUp` selects the new object and
calls `onUpdateImage`, no raster write). Later `setColor` / `setFilled` /
`setThickness` restyle that object in place. Only a deselect path rasterizes
it (`commitRectToBitmap` / `commitOvalToBitmap` via blank-press
`clearSelection`, Escape `clearSelection`, tool/mode/target/costume/project
switch `deactivateTool`, and the bounding-box tool moves/scales/rotates the
vector object first). Delete drops the vector object with no raster write.

Product gap today: `Editor.svelte` `endBitmapPaint` rasterizes at mouseUp and
calls `saveBitmapCostume('Bitmap edit saved')` immediately, so the two
fail-first browser tests fail:

- `packages/editor/test/bitmap-pending-restyle.browser.test.ts`
  `restyles the uncommitted shape after mouseUp without a new history entry`
- same file `restyles filled<->outlined after mouseUp and commits once on deselect`

Parametric helper already exists and is unit-tested, but has no product
wiring (previous agent correctly left it unwired rather than risk silent data
loss):

- `packages/editor/src/features/costumes/bitmap-pending-shape.ts`
  (`create/move/retarget/restyle/take/resolvePendingBitmapShapeAction`)
- `packages/editor/test/bitmap-pending-shape.test.ts` (all passing unit tests)

This document is the exact safe transaction to wire it.

## 1. Invariants (never violate)

1. I1 — Stored asset is untouched until commit. All pending-phase pixels are
   overlay renders from an immutable base. No `vm.updateCostume`, no history,
   no thumbnail/center write while pending.
2. I2 — Overlay is always `base + shape`. Never `live + shape`. Preview,
   restyle, and transform re-render from the frozen base, so re-renders can
   never double-compose, darken semi-transparent pixels, or leak damage into
   non-selected raster.
3. I3 — Single-shot commit. The slot is taken synchronously (cleared) BEFORE
   any async save/history. A second commit attempt (re-entrant trigger, racing
   Escape + tool-switch, double blank-press) sees an empty slot and is a
   no-op: no second rasterization, no second history entry.
4. I4 — Per-slot owner. Every pending slot and every async continuation
   carries `(targetId, costumeIndex, assetKey, loadSerial, generation,
   revision)`. Any mismatch against the live slot aborts fail-closed: restore
   the taken base to the canvas only when the owner still matches, else touch
   nothing and report `refuseStaleBitmapWorkspace`.
5. I5 — No silent data loss. Every abort path either keeps the pending shape
   (save/export/page-hide that must not destroy intent) or restores the base
   (discard paths) or commits first (destructive structural paths). A path
   that cannot prove which is safe must refuse with status and keep both
   stacks intact.
6. I6 — Bounded memory. At most one pending shape + one base `ImageData`
   (already canvas-bounded by the refused-workspace caps). No preview queue,
   no retained overlay history, no per-tick allocation beyond one render.
7. I7 — Synchronous UI, asynchronous save. Selection/tool/status/overlay
   transitions are synchronous in the event handler. Only PNG encode, store
   read, history peek, and `vm.updateCostume` are async, always after the
   synchronous take, always re-validated after every `await`.

## 2. State model

```text
Slot: PendingBitmapShapeSlot = { shape | undefined, base: ImageData | undefined }
Owner: { targetId, index, assetKey, loadSerial, generation, revision }
UI:    bitmapTool (rect|oval armed), bitmapSelection (committed-box outline),
       bitmapShapeMode, paint colors, brushSize
Live:  bitmapCanvas raster, bitmapWorkspaceOwner/Pending, assetPreviewRevision
```

Three macro-states:

- `idle` — slot empty. Today's behavior for all non-shape tools.
- `pending(shape, base, owner)` — slot full. Canvas shows `base + shape`
  (renders synchronously after each mutation). Tool stays armed. No history
  entry exists yet for this shape.
- `committing(taken)` — transient. Slot already empty (taken). Canvas shows
  the committed raster. One history `peek` + one `saveBitmapCostume`-style
  write in flight, both owner-checked.

`takePendingBitmapShape(slot)` is the ONLY commit/discard exit: it clears
`shape` and `base` synchronously and returns them. Callers then either
rasterize `base + shape` once (commit) or `putImageData(base)` once
(discard-restore), subject to the owner check below.

Owner check (`ownerCheck`, evaluated synchronously before touching pixels and
again after every `await` before touching VM/history):

```text
settled  = isBitmapWorkspaceSettledFor(owner.targetId, owner.index)
sameLive = selectedTarget && stableTargetId(selectedTarget) == owner.targetId
           && (selectedTarget.currentCostume ?? 0) == owner.index
sameRev  = owner.loadSerial == bitmapCanvasReloadSerial
           && owner.revision == assetPreviewRevision
           && !bitmapWorkspacePending
sameScope= paintScopeKey/generation still equal entry scope
```

Commit proceeds only if all four hold; otherwise fail closed per §5.

## 3. State transition table (commands × owner)

`resolvePendingBitmapShapeAction` in
`packages/editor/src/features/costumes/bitmap-pending-shape.ts` is the
trigger→intent map. The table below adds the required owner behavior.

| # | Command / event | Trigger | Intent | Owner check | Transition (pending →) |
|---|---|---|---|---|---|
| 1 | Blank-press on canvas with shape tool armed | `blank-press` | commit | check; if pass: take → rasterize `base+shape` → single history+save; if fail: drop drag state, touch nothing | `idle` (selection := committed padding box, tool stays armed) |
| 2 | Tool switch (incl. select/brush/eraser/fill/text/line) | `tool-switch` | commit | same as 1, synchronously before the new tool's `begin` | `idle` |
| 3 | Mode switch filled↔outlined toolbar (no deselect) | — (restyle, NOT a trigger) | restyle in place | requires pending owner == live; else ignore | stays `pending` (re-render `base+shape`, no history) |
| 4 | Paint color / secondary / gradient / transparent toggle / brushSize change | — (restyle) | restyle in place | same as 3 | stays `pending` (same-object no-op skip when `changed == false`) |
| 5 | Bounding-box move (drag, nudge arrow) on pending selection | — (transform) | retarget in place | same as 3; stale drag cancels without pixels | stays `pending` (`movePendingBitmapShape`, clamp, re-render) |
| 6 | Bounding-box scale (8 handles, Alt/Shift modifiers) | — (transform) | retarget in place | same as 3 | stays `pending` (`retargetPendingBitmapShape`, frozen-box math, re-render) |
| 7 | Bounding-box rotate (handle, Shift snap) | — (transform) | retarget in place | same as 3 | stays `pending` (pure box math today; see §7 limitation) |
| 8 | New shape drag started while pending (blank press) | `blank-press` | commit old, then draft new | commit old per row 1; new drag starts from the committed canvas with a fresh base | `idle` → draft → `pending(new)` |
| 9 | Escape | `escape` | commit | check; stale owner: clear state, touch nothing | `idle` (selection cleared, tool stays armed) |
| 10 | Delete / Backspace on pending selection | `delete` | discard | check; restore `base` only if owner still matches; else touch nothing | `idle` (selection cleared, no raster change, no history) |
| 11 | Undo while pending | `undo` | discard pending first, then normal undo | discard-restore `base` if owner matches (no history for the pending shape itself), then `undoHistorySide('costume')` on the pre-drag entry | `idle` → undo restore |
| 12 | Redo while pending | (no matrix entry: treat as commit-first) | commit, then redo | commit per row 1, then `redoHistorySide` only if scope/owner still match | `idle` → redo restore |
| 13 | Target switch / costume switch / project switch / newProject / loadProject | `target/costume/project-switch` | commit | attempt commit ONLY if owner still matches AND workspace settled; any pending load / mismatch / refused → discard-restore-if-same-owner else touch nothing, then proceed with switch | `idle` before the switch's reload |
| 14 | Explicit Save bitmap button / `saveBitmapCostume` while pending | `save` | ignore (keep pending) | no take, no history; save reads the committed store path only, not the overlay | stays `pending` |
| 15 | Project export / costume export / sprite export | — (read-only) | keep pending | export reads stored bytes (`vm.loadAsset` / `vm.saveProjectSb3`), never the overlay canvas | stays `pending` |
| 16 | Page unmount / tab hide / window blur | — (keep pending if possible) | keep pending; never auto-commit on blur | cancel only the in-progress draft stroke (`cancelBitmapStroke`), keep the settled pending slot; `onDestroy` releases nothing to the store | stays `pending` (in-memory); process exit discards it, stored asset untouched |
| 17 | `convertCurrentCostumeToBitmap/ToVector` while pending | (structural: commit-first) | commit, then convert | commit per row 1; abort conversion if commit refused/stale | `idle` → conversion |
| 18 | Delete costume / duplicate / reorder / delete sprite while pending | (structural: commit-first) | commit, then structure op | commit per row 1; abort structure op if commit refused/stale; structure ops keep existing `clearPaintOnCostumeSlotChange` / `drainAllVectorWrites` ordering | `idle` → structure op |
| 19 | Cut/copy/paste/crop/flip/rotate/clear while pending | (raster ops: commit-first) | commit, then op | commit per row 1; the op's own settled-gate re-validates | `idle` → op |
| 20 | Rejected store (over-cap / unreadable / refused workspace) at any commit | — | refuse | never allocate/read overlay; keep slot OR drop without pixels per §8; stored bytes untouched | `idle` only after safe restore; else stays `pending` with refusal status |
| 21 | External `vm.updateCostume` same-slot write while pending | — (CAS conflict) | fail closed | live slot identity (`readLiveSlotIdentity` vs `paintKnownBySlot`) diverged → drop pending without writing (restore base only if owner still matches), surface `vectorExternalConflictStatus`-style status, keep history stacks | `idle` |
| 22 | `pointercancel` / `lostpointercapture` mid-draft (no settled pending yet) | `pointercancel` | ignore pending; cancel draft | `cancelBitmapStroke` restores `bitmapPreviewBase`; settled pending slot untouched | stays `pending` (or `idle` if there was none) |
| 23 | Race: second commit trigger while `committing` in flight | — | no-op | slot already empty → `take` returns `undefined` | stays `committing` until save settles |
| 24 | Race: switch/undo during commit `await` | — | abort write | post-await `bitmapSaveEntryValid` fails → refuse, no history, no pixels | `idle` (slot already taken; canvas already shows committed raster) |

Notes:

- Rows 3–7 are explicitly NOT `resolvePendingBitmapShapeAction` triggers:
  restyle/transform keep the slot. Only deselect-class events commit.
- `mode-switch` in the matrix means leaving the shape tool family or leaving
  bitmap mode (e.g. bitmap→vector), not the filled↔outlined toggle, which is
  a restyle (reference `setFilled`).
- Row 12: the helper has no `redo` trigger; the safe choice is commit-first
  (redo must never resurrect pixels under an uncommitted overlay).

## 4. Synchronous UI / asynchronous save split

Commit path (all deselect-class triggers share it):

```text
onTrigger (sync):
  taken = takePendingBitmapShape(slot)   // clears shape+base NOW
  if (!taken) return                      // racing second trigger: no-op
  if (!ownerCheck(taken.owner)) {         // stale: fail closed
    // restore base ONLY when it still belongs to the live canvas
    refuseStaleBitmapWorkspace(...)
    return
  }
  render base+shape onto bitmapCanvas     // sync putImageData/draw, one pass
  bitmapSelection = paddedBox(taken.shape) // sync; Escape clears it after
  entrySerial = bitmapCanvasReloadSerial; entryRevision = assetPreviewRevision
  status = committed display (sync)

commitAsync (after sync pixels):
  if (!bitmapSaveEntryValid(...)) refuse + keep stacks
  entry = await peekCostumeHistory(target, index)
  re-validate owner/scope/revision; if stale → refuse (canvas keeps committed
    pixels, stored asset untouched, no history)
  commitPaintHistory(entry) with guard check
  wrote = await writeCroppedBitmapSave(target, index, pending)
  re-validate once more; on failure refuse with no success status
```

Why this order: the UI (tool armed, selection outline, overlay pixels) is
already correct before the first `await`, so a switch/Undo/encode stall can
never leave the user on a stale frame. The async half can only append one
history entry and one store write, both guarded.

Restyle / transform path (sync only, never async):

```text
onRestyle/patch (sync):
  if (!pending || !ownerCheckLive()) return/ignore
  { pending, changed } = restyle/move/retarget(...)
  if (!changed) return                    // same object: skip render + history
  slot.shape = pending                    // replace parametric only
  render base + pending                   // putImageData(base) + draw shape
  // no history, no save, no owner change, no serial bump
```

Discard path (Delete, Undo-while-pending):

```text
onDiscard (sync):
  taken = takePendingBitmapShape(slot)   // clears NOW, single-shot
  if (!taken) return
  if (ownerCheck(taken.owner)) putImageData(taken.base)
  // else: canvas already belongs elsewhere — touch nothing
  bitmapSelection = undefined
  // no history entry for the pending shape itself
  status = 'Selection cleared' / 'Bitmap edit cancelled'
  // Undo then continues into the normal undo path (pre-drag entry)
```

## 5. Case coverage

- Undo while pending: discard the pending shape first (restore base, no
  history for the shape), then run the existing `undoAssetEdit` →
  `undoHistorySide('costume')` path so one Undo returns to the pre-drag
  raster. Never push the restyle/transform ticks: they were history-free by
  construction. Redo while pending commits first (row 12) so redo cannot
  interleave under an overlay.
- Delete: `deleteEditorSelection` → pending-aware branch: take + restore base
  when the owner matches, clear `bitmapSelection`. No `saveBitmapCostume`, no
  `commitPaintHistory`. Stale owner: clear state only.
- Restyle (color/fill/secondary/gradient/transparent/brushSize,
  filled↔outlined): parametric-only `restylePendingBitmapShape`. Same-value
  returns the same object → skip render, skip history. Outlined uses the fill
  style + shared `brushSize` contour per `resolveBitmapShapePaint`; the stroke
  color/width inputs stay ignored (reference parity, already encoded in
  `bitmap-shape-mode.ts`).
- Selection move / scale / rotate: pure box math (`movePendingBitmapShape` /
  `retargetPendingBitmapShape`) + re-render `base+shape`. Move clamps inside
  the canvas; scale clamps + normalizes; rotate reuses the existing true-center
  snap anchor for moves and keeps the rotation handle anchor unchanged (same
  rule as `bitmapTrueCenterForDrag`). No history until commit. Nudge arrows
  while pending retarget the box; the nudge pending-entry cycle must be
  bypassed for pending shapes (no `flushNudgePending` history for a
  history-free overlay).
- New shape while pending: blank-press commits the old shape first (row 1/8),
  then the new drag starts a fresh draft from the committed canvas. The old
  outline is cleared at `beginBitmapPaint` before the new draft (today's
  `bitmapSelection = undefined` stays, but AFTER the commit, not before).
- Target / costume / project switch: commit-first when settled (rows 13).
  Implementation order: `take` + rasterize + `await saveBitmapCostume`-equivalent
  BEFORE `vm.setCurrentCostume` / `vm.selectTarget` / `vm.loadProject` /
  `resetProjectUiState`. Any unsettled workspace (`bitmapWorkspacePending`,
  owner mismatch, refused) skips the commit, restores base only if
  same-owner, and lets the switch proceed without writing. The switch's reload
  (`loadCostumeIntoBitmapCanvas`) then clears the slot (already empty) and
  bumps the serial so late decodes abort.
- Page unmount / Save / Export: Save button and auto-save paths are
  `save`-trigger = ignore (row 14/15): they must read the stored/settled path,
  never the overlay. `exportProject` / `exportSb3` / `exportCostume` read the
  VM store. `onDestroy` / blur must NOT commit (a blur-commit would write on
  every Alt-Tab); cancel only the in-progress draft via `cancelBitmapStroke`.
  Process exit discards the in-memory pending shape; the stored asset is by
  definition unchanged (I1), so no data loss.
- Rejected store: over-cap (`isBitmapSourceSizeRefused` /
  `isConversionRasterSizeRefused` / `refused` artboard), unreadable raster
  (`getImageData` throw), null/empty encode. Commit refuses BEFORE any
  read/allocate/history: keep the pending slot and surface
  `BITMAP_REFUSAL_STATUS`, OR drop-without-pixels when the canvas cannot hold
  the overlay. Never write transparent bytes over stored ink.
- External API modifications: direct `vm.updateCostume` / plugin VM-API
  bypass on the same slot while pending is a CAS conflict. Compare
  `readLiveSlotIdentity` vs `paintKnownBySlot` (same mechanism as the vector
  `vector-slot-cas.ts` guard) at commit entry and after each `await`. On
  divergence: drop pending (restore base only if same-owner), keep both
  history stacks, surface the external-conflict status. No silent overwrite.
- Race timers & retries: no retry loop for commits (a retry would risk double
  rasterization). Single attempt + fail-closed status. Debounce restyle
  renders with a single `requestAnimationFrame` coalesce at most; drop stale
  frames by shape identity (newer parametric replaces older). Async save uses
  the existing serial+revision+scope re-validation after EVERY `await`
  (`bitmapSaveEntryValid` pattern); late completions after a clear/switch are
  dropped with redo preserved. `hsvLive` / nudge timers must flush or be
  bypassed before a pending commit so a pending HSV tick cannot land a second
  history entry on top of the shape commit.

## 6. Bounded memory

- One `PendingBitmapShape` object (few dozen bytes) + one base `ImageData`
  (canvas-bounded; the refused-workspace caps already bound the canvas).
- `take` transfers ownership: the commit/discard path nulls the slot before
  rendering, so even an exception cannot retain two bases.
- Restyle no-op fast path (`changed == false` returns the same object) avoids
  allocation and render entirely.
- No per-move history, no preview queue, no retained overlay stack. The
  floating-selection sessions (`bitmapMoveDrag` etc.) are disallowed while
  pending: a pending shape must commit or discard before a floating session
  starts (commit-first, row 19), so the two snapshot systems never hold two
  full-canvas copies at once.

## 7. Known limitation to state explicitly

Rotation of a pending rect/oval is box-math only in the current helper (move /
retarget exist, rotate does not). Reference rotates the vector object
arbitrarily. The safe subset: support translate + scale + 90°-step rotate via
box swap now; arbitrary-angle pending rotate stays out of scope until a
`rotatePendingBitmapShape` helper with center-pinned math lands. Do NOT fake
it by rasterizing early.

Reference/Scratch differences to keep documented in code comments:

- Product canvas-2d has no Paper vector layer: `base + shape` re-render
  replaces Paper's retained object. Semi-transparent double-composition and
  gradient re-resolution are the failure modes this guards against.
- Resolution: res2 1 canvas px = 1 Paper unit, res1 1 canvas px = 2 Paper units
  (non-destructive). Commit gate stays `shouldCommitBitmapShapeDrag`.
- Rotation-center / stage anchoring never shift the pending box; Editor reuses
  the existing true-center snap anchor.
- Scratch keeps the object selected under the armed tool with no mode change;
  product mirrors with tool-stays-armed + `bitmapSelection` outline.
  Reference `deactivateTool` maps to rows 2/3/13; `clearSelection` maps to
  rows 1/9.

## 8. Necessary hooks (by file + exact function)

`packages/editor/src/Editor.svelte` (all changes here + helpers; no other
product file needs logic):

- `beginBitmapPaint` — blank-press with pending: commit old shape first
  (take → rasterize → async save), then start the new draft from the committed
  canvas. Press-inside-selection move stays a floating session only when no
  pending shape exists; otherwise commit-first.
- `paintBitmap` / `drawBitmapDraft` / `drawBitmapShape` — draft previews stay
  as-is for the no-pending case; add a pending branch that re-renders
  `base + shape` (shared `putImageData(base)` + `paintBitmapShape` /
  `paintBitmapRectOvalExclusive` with `resolveBitmapShapePaint`).
- `endBitmapPaint` — THE fix: on `rect`/`oval` shape commit gate pass, create
  the pending slot (`createPendingBitmapShape` + `getImageData` base + owner
  capture) and render the overlay INSTEAD of `saveBitmapCostume`. Keep the
  tool armed, set `bitmapSelection` to the padded box. Tiny-shape /
  transparent-noop discards stay history-free with no slot.
- `cancelBitmapStroke` — draft-only cancel (pointercancel/lostpointercapture);
  must NOT clear a settled pending slot.
- `clearCostumeSelection` (Escape/deselect) — pending commit (row 9) before
  the existing floating-drag cancels and `bitmapSelection = undefined`.
- `deleteEditorSelection` / `deleteBitmapSelection` — pending discard branch
  (row 10). Guard the inline-text check first (existing).
- `undoAssetEdit` / `redoAssetEdit` / `undoHistorySide` / `restoreHistoryEntry`
  — pending discard-then-undo (row 11), commit-then-redo (row 12); keep the
  external-identity pre-check (`readLiveSlotIdentity` vs `paintKnownBySlot`).
- `selectCostume`, target-select path, `resetProjectUiState`, `newProject`,
  `loadProject` — commit-first-or-safe-discard (row 13) before the switch;
  never write after the scope/serial bumped.
- `saveBitmapCostume` / `buildCroppedBitmapSave` / `writeCroppedBitmapSave` /
  `bitmapSaveEntryValid` — add explicit pending guard: the Save button while
  pending is ignore (row 14). Commit path reuses the entry-valid + settled
  pattern, not a bare canvas read.
- `convertCurrentCostumeToBitmap` / `convertCurrentCostumeToVector`,
  `copy/cut/pasteCostumeSelection`, `pasteBitmapSelection`,
  `beginBitmapFloatingScale/Move/Rotate` family, `deleteBitmapSelection`,
  crop/flip/rotate/clear — commit-first (rows 17/19).
- `handleKeyDown` (deselect/delete/select-all/copy/cut/paste/Escape) —
  route through the pending commit/discard first; keep the eyedropper,
  inline-text, nudge-flush ordering intact.
- `loadCostumeIntoBitmapCanvas` / `refreshCostumePreview` /
  `resetCostumeEditorSelection` — slot invalidation on committed loads
  (take-abandoned slots never render after a serial/revision bump).
- `onDestroy` (+ blur/popstate where applicable) — cancel drafts only; never
  auto-commit pending.
- `exportProject` / `exportSb3` / `exportCostume` — no change except the
  guarantee they read the store, never the overlay (test-locked).

`packages/editor/src/features/CostumeEditor/BitmapEditor.svelte` (props only):

- Thread pending-aware callbacks already present (`beginBitmapPaint`,
  `endBitmapPaint`, `deleteEditorSelection`, `saveBitmapCostume`) — no new
  canvas logic. Add `bitmapSelection` outline display for the pending shape
  (already rendered via `bitmapSelection`) and keep
  `beginBitmapFloatingScale/Rotate` + nudge/arrow handlers disabled-or-
  commit-first while pending. Keep `cancelPendingVectorShapeHitForEscape`
  ordering (vector path untouched).

Helpers (pure, already exist — reuse, add only rotate if needed):

- `packages/editor/src/features/costumes/bitmap-pending-shape.ts` —
  `createPendingBitmapShape`, `restylePendingBitmapShape`,
  `movePendingBitmapShape`, `retargetPendingBitmapShape`,
  `takePendingBitmapShape`, `resolvePendingBitmapShapeAction`.
- `packages/editor/src/features/costumes/shape-drag.ts` —
  `shouldCommitBitmapShapeDrag`, `resolveShapeRect`, `readShapeModifiers`.
- `packages/editor/src/features/costumes/bitmap-shape-mode.ts` —
  `resolveBitmapShapePaint`, `paintBitmapRectOvalExclusive`,
  `resolveBitmapShapeSelectionPadding`, `normalizeBitmapShapeMode`.
- `packages/editor/src/features/costumes/bitmap-shapes.ts` — rasterize
  `base + shape` at commit (replace current immediate `drawBitmapShape` + save
  with overlay render + deferred single save).
- Existing guards to reuse verbatim: `isBitmapWorkspaceSettledFor`,
  `refuseStaleBitmapWorkspace`, `bitmapSaveEntryValid`, `revisionGuardChanged`,
  `paintScopeKey/Generation`, `readLiveSlotIdentity` / `paintKnownBySlot` /
  `rememberPaintKnown`, `isBitmapEditRefused` / `refuseBitmapOversize`,
  `isBitmapSourceSizeRefused` / `isConversionRasterSizeRefused`.

## 9. Minimal piecemeal fail-first test order

Each step is one failing test → minimal implementation → green. Do not batch.

1. Unit (already green, lock): `packages/editor/test/bitmap-pending-shape.test.ts`
   — restyle same-object no-op, color/mode/width/transparent changed,
   move/retarget clamp, trigger matrix, single-shot take.
2. Browser restyle-color (known failure 1):
   `bitmap-pending-restyle.browser.test.ts`
   `restyles the uncommitted shape after mouseUp without a new history entry`
   — mouseUp shows selection + tool armed; fill change re-renders overlay to
   blue; one Undo returns to pre-drag (not red).
3. Browser filled↔outlined + Escape commit (known failure 2): same file,
   second test — mode toggle restores interior, contour survives; Escape
   commits once, selection clears, tool stays armed.
4. Unit: double-trigger commit is a no-op (second `take` undefined, one
   history entry). Then browser: Escape + tool-switch race commits exactly
   once (pixel + history-count assertion).
5. Unit+browser: Delete while pending restores base, no history; Undo after
   Delete is a no-op for the shape (pre-drag entry still on top).
6. Browser: Undo while pending drops to pre-drag in one step (no red
   intermediate). Redo after commit restores the shape once.
7. Browser: move/scale pending via selection handles re-render without
   history; commit on blank-press writes exactly one entry.
8. Browser: new shape while pending commits the old one first (two shapes,
   two entries, no duplication/ghost).
9. Browser: target/costume switch while pending commits when settled, never
   writes when unsettled/refused (stored bytes of the new asset unchanged).
10. Browser: Save button while pending keeps the shape pending (no entry);
    Export (project/costume) reads stored bytes unchanged.
11. Browser/unit: refused workspace (over-cap fixture) never writes; external
    same-slot `vm.updateCostume` while pending fails closed with conflict
    status and intact stacks.
12. Browser: reload-race (rapid Undo ×8 / switch-mid-encode) ends on the
    correct bytes with exactly the expected history depth (last-starter-wins
    + post-await re-validation).

Ship order: 2 → 3 unblock parity; 4 → 6 close the data-loss surface; 7 → 12
harden. No step may add a retry loop or an auto-commit on blur/unmount.
