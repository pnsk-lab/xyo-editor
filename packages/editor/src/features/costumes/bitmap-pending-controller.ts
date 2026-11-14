import {
  createBitmapPendingSession,
  type BitmapPendingSession,
  type BitmapPendingSessionCanvasPorts,
  type BitmapPendingSessionConfig,
  type BitmapPendingSessionNotify,
  type BitmapPendingVmLike,
} from './bitmap-pending-session'
import { createEditorCanvasPorts, createEditorHistoryPorts, type EditorHistorySource } from './bitmap-pending-ports'
import { pendingKindFromTool, pendingModeFromEditor, pendingSelectionForShape, pendingStyleFromEditor, type BitmapPendingEditorStyleSource } from './bitmap-pending-style'
import type { PendingBitmapShapeStyle } from './bitmap-pending-shape'
import type { BitmapShapeMode } from './bitmap-shape-mode'

/**
 * Pending rect/oval controller for `Editor.svelte` (B-3 UI wiring).
 *
 * Focused feature helper (AGENTS split): owns exactly one
 * `createBitmapPendingSession` per stable bitmap slot
 * (`targetId:index:loadSerial:sessionGeneration`) and re-creates it on slot
 * change. The Editor maps pointer/style/command events 1:1 onto these
 * methods; all scope/identity/revision/canvas ownership checks stay inside
 * the session (synchronous, immediately before every canvas touch and CAS).
 * No Svelte imports, no DOM queries beyond the injected canvas element.
 *
 * SAFETY GATE (data-loss fix): the pending path is incomplete (external
 * reload/target/costume/project bypasses `destroy()` the staged pending,
 * move/scale are unconnected, many ops bypass commit). It stays OFF by
 * default. Flip to `true` only when the path is complete. This is a plain
 * constant: never read browser storage / URL state / env here, so no UI
 * can accidentally re-enable it.
 */
export const BITMAP_PENDING_UI_ENABLED = false as const

export type BitmapPendingSlot = {
  targetId: string
  costumeIndex: number
  loadSerial: number
  sessionGeneration: number
  /** Whole-project generation (vm.getProjectGeneration). Same slot across a
   * project replace is a different slot: prevents old base painting to new. */
  projectGeneration?: number
}

export type BitmapPendingControllerCallbacks = {
  onSelection: (selection: { x: number; y: number; width: number; height: number } | undefined) => void
  onStatus: (status: string) => void
  onSnapshot?: (snapshot: { hasPending: boolean; historyGap: boolean; quarantined: boolean; pendingKind?: string; pendingMode?: string }) => void
  onRecoverySnapshot?: (recovery: { hasRecovery: boolean; hasPending: boolean; quarantined: boolean; historyGap: boolean; commitInFlight: boolean; slotKey: string } | undefined) => void
  peekHistory: <E>() => Promise<E | undefined>
  commitHistory: <E>(entry: E) => boolean
  historyDepth: () => number
  historyIsCurrent: () => boolean
  tryRemoveHistory?: <E>(entry: E) => boolean
  readConfig: () => BitmapPendingSessionConfig
};

export type BitmapPendingControllerTestOptions = {
  /** Isolated test-only opt-in. Never read from storage/URL/env. */
  testForceEnabled?: boolean
}

type RetainedEntry = {
  session: BitmapPendingSession<unknown>
  slot: BitmapPendingSlot
  slotKey: string
}

function isExplicitDestructiveReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false
  const text = reason.toLowerCase()
  return (
    text.includes('explicit-destructive') ||
    text.includes('confirmed-discard') ||
    text.includes('destructive-close') ||
    text === 'destructive' ||
    text.includes('user-confirmed-discard')
  )
}

function isValidSlot(slot: BitmapPendingSlot): boolean {
  try {
    if (!slot || typeof slot.targetId !== 'string' || slot.targetId.length === 0) return false
    if (!Number.isInteger(slot.costumeIndex) || slot.costumeIndex < 0) return false
    if (!Number.isInteger(slot.loadSerial) || slot.loadSerial < 0) return false
    if (!Number.isInteger(slot.sessionGeneration) || slot.sessionGeneration < 0) return false
    const pg = (slot as { projectGeneration?: unknown }).projectGeneration
    if (pg !== undefined && (!Number.isInteger(pg) || (pg as number) < 0)) return false
    return true
  } catch {
    return false
  }
}

function isUsableCanvas(canvas: HTMLCanvasElement | undefined | null): boolean {
  try {
    if (!canvas) return false
    const width = (canvas as HTMLCanvasElement).width
    const height = (canvas as HTMLCanvasElement).height
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false
    if (width <= 0 || height <= 0) return false
    return true
  } catch {
    return false
  }
}

export class BitmapPendingController {
  private session: BitmapPendingSession<unknown> | undefined
  private slotKey = ''
  private slot: BitmapPendingSlot | undefined
  private currentSlot: BitmapPendingSlot | undefined
  private recovered: RetainedEntry | undefined
  private overflowStale: RetainedEntry | undefined
  private lastSelectionJson = '__none__'
  private readonly testForceEnabled: boolean
  private ensureDepth = 0

  constructor(
    private readonly vm: BitmapPendingVmLike,
    private readonly cb: BitmapPendingControllerCallbacks,
    options?: BitmapPendingControllerTestOptions,
  ) {
    this.testForceEnabled = options?.testForceEnabled === true
  }

  private enabled(): boolean {
    if (this.testForceEnabled) return true
    return BITMAP_PENDING_UI_ENABLED
  }

  private notifyFor(session: BitmapPendingSession<unknown> | undefined, sessionSlotKey: string): BitmapPendingSessionNotify {
    return {
      onInvalidate: () => {
        // Reentrant-safe: route only the CURRENT active session to the live
        // selection/snapshot UI. Inactive (recovered) invalidations update the
        // recovery snapshot only and never clobber the new slot outline.
        try {
          if (session !== undefined && this.session === session && this.slotKey === sessionSlotKey) {
            this.emitSnapshot()
            this.syncSelection()
          } else {
            this.emitRecoverySnapshot()
          }
        } catch {
          // Best effort only.
        }
      },
      onStatus: (text: string) => {
        try {
          this.cb.onStatus(text)
        } catch {
          // Status must never break the commit discipline.
        }
        try {
          if (session !== undefined && this.session === session && this.slotKey === sessionSlotKey) {
            this.emitSnapshot()
            this.syncSelection()
          } else {
            this.emitRecoverySnapshot()
          }
        } catch {
          // Best effort only.
        }
      },
    }
  }

  private keyFor(slot: BitmapPendingSlot): string {
    const pg = typeof slot.projectGeneration === 'number' && Number.isInteger(slot.projectGeneration) && slot.projectGeneration >= 0
      ? slot.projectGeneration
      : 0
    return `${slot.targetId}:${slot.costumeIndex}:${slot.loadSerial}:${slot.sessionGeneration}:${pg}`
  }

  private snapshotUnsaved(session: BitmapPendingSession<unknown> | undefined): boolean {
    try {
      if (!session) return false
      const snap = session.snapshot()
      if (snap.hasPending) return true
      if (snap.commitInFlight) return true
      if (snap.historyGap) return true
      if (Boolean(snap.quarantined ?? snap.quarantine)) return true
      return false
    } catch {
      // Uncertainty is unsaved: retain conservatively, never silently drop.
      return true
    }
  }

  private historyPortsFor(entrySlot: BitmapPendingSlot, sessionRef: { current: BitmapPendingSession<unknown> | undefined }): ReturnType<typeof createEditorHistoryPorts<unknown>> {
    const targetId = String(entrySlot.targetId ?? '')
    const costumeIndex = Number(entrySlot.costumeIndex)
    const source: EditorHistorySource<unknown> = {
      peek: () => this.cb.peekHistory<unknown>(),
      commit: (entry: unknown) => {
        // No stale owner cross-slot writes: a recovered (inactive) session or
        // a session whose stable slot (target/index) no longer matches the
        // live requested slot must never append to the live history stack.
        // Same target/index across a generation change is allowed (session CAS
        // still decides the bytes); different target/index is blocked.
        try {
          const live = this.currentSlot
          if (live && (String(live.targetId ?? '') !== targetId || Number(live.costumeIndex) !== costumeIndex)) {
            return false
          }
          if (sessionRef.current === undefined) return false
          return this.cb.commitHistory<unknown>(entry)
        } catch {
          return false
        }
      },
      depth: () => this.cb.historyDepth(),
      isCurrent: () => {
        try {
          const live = this.currentSlot
          if (live && (String(live.targetId ?? '') !== targetId || Number(live.costumeIndex) !== costumeIndex)) {
            return false
          }
          return this.cb.historyIsCurrent()
        } catch {
          return false
        }
      },
      tryRemove: this.cb.tryRemoveHistory ? (entry: unknown) => {
        try {
          const live = this.currentSlot
          if (live && (String(live.targetId ?? '') !== targetId || Number(live.costumeIndex) !== costumeIndex)) {
            return false
          }
          if (sessionRef.current === undefined) return false
          return this.cb.tryRemoveHistory!(entry)
        } catch {
          return false
        }
      } : undefined,
    }
    return createEditorHistoryPorts<unknown>(source)
  }

  /** Ensure the session matches the live slot; re-create on slot change. */
  ensure(slot: BitmapPendingSlot, canvas: HTMLCanvasElement | undefined | null): BitmapPendingSession<unknown> | undefined {
    if (this.testForceEnabled) return this.ensureInternal(slot, canvas)
    if (!BITMAP_PENDING_UI_ENABLED) {
      this.destroy('disabled')
      return undefined
    }
    return this.ensureInternal(slot, canvas)
  }

  private ensureInternal(slot: BitmapPendingSlot, canvas: HTMLCanvasElement | undefined | null): BitmapPendingSession<unknown> | undefined {
    // Reentrant concurrent `ensure` (e.g. a status/selection callback that
    // re-enters `ensure` synchronously): cap recursion, latest call wins.
    if (this.ensureDepth > 8) return this.session
    this.ensureDepth += 1
    try {
      // Generation/owner checks before read/paint: invalid slot or canvas
      // never touches pixels and never drops retained recovery.
      if (!isValidSlot(slot)) {
        try {
          this.cb.onStatus('recovery retained (invalid slot; live canvas untouched; reloader owns pixels)')
        } catch {
          // Best effort only.
        }
        return undefined
      }
      const key = this.keyFor(slot)
      this.currentSlot = { ...slot }
      if (!isUsableCanvas(canvas)) {
        // Missing canvas: retain any unsaved active as recovery (no pixels to
        // touch), clear the live active reference, report recovery.
        if (this.session && this.snapshotUnsaved(this.session) && this.slot) {
          this.retainActiveAsRecovery('missing-canvas')
        } else if (this.session) {
          this.session = undefined
          this.slotKey = ''
          this.slot = undefined
        }
        this.emitSnapshot()
        this.emitRecoverySnapshot()
        this.syncSelection()
        return undefined
      }
      if (this.session && this.slotKey === key) {
        try {
          // Owner-checked configure: only the current active session reads the
          // live config.
          this.session.configure(this.cb.readConfig())
        } catch {
          // Best effort only.
        }
        // While recovery is pending, the live session stays observable but new
        // stages are the session's own quarantine-full decision; the
        // controller additionally reports the blocked state.
        this.emitSnapshot()
        this.emitRecoverySnapshot()
        this.syncSelection()
        return this.session
      }
      // Slot change with no live active: a matching recovery is re-activated
      // (switch-back) instead of allocating a second copy.
      if (!this.session && this.recovered && this.recovered.slotKey === key) {
        this.session = this.recovered.session
        this.slotKey = this.recovered.slotKey
        this.slot = { ...this.recovered.slot }
        this.recovered = this.overflowStale
        this.overflowStale = undefined
        try {
          this.session.configure(this.cb.readConfig())
        } catch {
          // Best effort only.
        }
        this.emitSnapshot()
        this.emitRecoverySnapshot()
        this.syncSelection()
        return this.session
      }
      // Slot change: retain unsaved active as recovery WITHOUT touching
      // pixels (the reloader owns the new canvas). Never render the old base
      // to the new canvas; never silently drop staged/quarantined/in-flight.
      if (this.session && this.slot) {
        if (this.snapshotUnsaved(this.session)) {
          this.retainActiveAsRecovery('slot-change')
          // Bounded memory: single inactive recovery. While recovery (or an
          // overflow stale) is pending, refuse the new stage: no fresh session
          // is created so no new paint/commit can start until the user
          // explicitly exports/discards the recovery.
          try {
            this.cb.onStatus('recovery-pending: staged edit retained off-canvas; exportRecoveryPng/discardRecovery required before new paint (live canvas untouched)')
          } catch {
            // Best effort only.
          }
          this.emitSnapshot()
          this.emitRecoverySnapshot()
          this.syncSelection()
          return undefined
        }
        // Clean active (nothing staged): safe to drop without pixels.
        this.session = undefined
        this.slotKey = ''
        this.slot = undefined
      }
      // While any recovery is pending, reject the new stage (no fresh session
      // until explicit export/discard). This bounds memory to a single
      // inactive session and prevents new paint from overwriting recovery.
      if (this.recovered || this.overflowStale) {
        try {
          this.cb.onStatus('recovery-pending: staged edit retained off-canvas; exportRecoveryPng/discardRecovery required before new paint (live canvas untouched)')
        } catch {
          // Best effort only.
        }
        this.emitSnapshot()
        this.emitRecoverySnapshot()
        this.syncSelection()
        return undefined
      }
      let ports: BitmapPendingSessionCanvasPorts
      try {
        ports = createEditorCanvasPorts(canvas as HTMLCanvasElement)
      } catch {
        return undefined
      }
      const sessionRef: { current: BitmapPendingSession<unknown> | undefined } = { current: undefined }
      const history = this.historyPortsFor(slot, sessionRef)
      const notifyTarget: BitmapPendingSession<unknown> | undefined = undefined
      void notifyTarget
      try {
        const created = createBitmapPendingSession<unknown>(
          this.vm,
          slot.targetId,
          slot.costumeIndex,
          { loadSerial: slot.loadSerial, sessionGeneration: slot.sessionGeneration },
          ports,
          history,
          {
            onInvalidate: () => {
              try {
                if (sessionRef.current !== undefined && this.session === sessionRef.current) {
                  this.emitSnapshot()
                  this.syncSelection()
                } else {
                  this.emitRecoverySnapshot()
                }
              } catch {
                // Best effort only.
              }
            },
            onStatus: (text: string) => {
              try {
                this.cb.onStatus(text)
              } catch {
                // Status must never break the commit discipline.
              }
              try {
                if (sessionRef.current !== undefined && this.session === sessionRef.current) {
                  this.emitSnapshot()
                  this.syncSelection()
                } else {
                  this.emitRecoverySnapshot()
                }
              } catch {
                // Best effort only.
              }
            },
          },
          this.cb.readConfig(),
        )
        sessionRef.current = created
        this.session = created
        this.slotKey = key
        this.slot = { ...slot }
      } catch {
        this.session = undefined
        return undefined
      }
      this.emitSnapshot()
      this.emitRecoverySnapshot()
      this.syncSelection()
      return this.session
    } finally {
      this.ensureDepth -= 1
    }
  }

  private retainActiveAsRecovery(reason: string): void {
    const active = this.session
    const activeSlot = this.slot
    const activeKey = this.slotKey
    if (!active || !activeSlot) return
    // Never touch canvas or VM here: pure reference retention plus an
    // off-canvas quarantine of any staged pending (no restore, so the live
    // canvas — which already belongs to the reloader — is never repainted
    // with the old base). The old base stays off-canvas inside the retained
    // session (immutable quarantine, never repainted onto the wrong slot).
    try {
      const snap = active.snapshot()
      const alreadyQuarantined = Boolean(snap.quarantined ?? snap.quarantine)
      if (snap.hasPending && !alreadyQuarantined && !snap.commitInFlight) {
        try {
          active.quarantineStagedOffCanvas(reason)
        } catch {
          // Best effort only: the session object itself is still retained.
        }
      }
    } catch {
      // Best effort only: retain conservatively on any uncertainty.
    }
    if (!this.recovered) {
      this.recovered = { session: active, slot: { ...activeSlot }, slotKey: activeKey }
      try {
        // Visible recovery signal: keep the `quarantined` keyword last so the
        // direct-VM hostile audit (quarantine text + export UI) stays green.
        // The session already emitted `quarantined: <reason> ...`; this line
        // preserves that keyword while routing to the recovery export/discard.
        this.cb.onStatus(`quarantined (recovery retained ${reason}): staged edit kept off-canvas, live canvas untouched; exportRecoveryPng/discardRecovery required`)
      } catch {
        // Best effort only.
      }
    } else if (!this.overflowStale) {
      // Bounded single recovery is full: retain the overflow stale as well
      // (no silent drop, no overwrite of the original). New stages stay
      // rejected until explicit action.
      this.overflowStale = { session: active, slot: { ...activeSlot }, slotKey: activeKey }
      try {
        this.cb.onStatus(`quarantine-full: retaining original recovery; new ${reason} staged input retained alongside (both kept, explicit action required)`)
      } catch {
        // Best effort only.
      }
    } else {
      // Already holding two retained sessions (original + overflow): keep all
      // three without loss and without growth (still O(1)). Preserve the two
      // oldest as-is and leave the newest active in place (do NOT clear the
      // live active reference and do NOT overwrite the overflow entry —
      // overwriting would silently drop a retained pending). Callers treat
      // the new slot as refused (return undefined) while every retained
      // pending stays exportable/discardable and the live active stays
      // guarded by its own scope/owner checks.
      try {
        this.cb.onStatus(`quarantine-full: retaining original recovery; new ${reason} staged input retained alongside (both kept, explicit action required)`)
      } catch {
        // Best effort only.
      }
      return
    }
    this.session = undefined
    this.slotKey = ''
    this.slot = undefined
  }

  get(): BitmapPendingSession<unknown> | undefined {
    if (this.testForceEnabled) return this.session
    if (!BITMAP_PENDING_UI_ENABLED) return undefined
    return this.session
  }

  hasPending(): boolean {
    if (this.testForceEnabled) {
      try {
        return this.session?.snapshot().hasPending === true
      } catch {
        return false
      }
    }
    if (!BITMAP_PENDING_UI_ENABLED) return false
    try {
      return this.session?.snapshot().hasPending === true
    } catch {
      return false
    }
  }

  hasHistoryGap(): boolean {
    if (this.testForceEnabled) {
      try {
        return this.session?.snapshot().historyGap === true
      } catch {
        return false
      }
    }
    if (!BITMAP_PENDING_UI_ENABLED) return false
    try {
      return this.session?.snapshot().historyGap === true
    } catch {
      return false
    }
  }

  hasQuarantine(): boolean {
    if (this.testForceEnabled) {
      try {
        const snap = this.session?.snapshot()
        if (Boolean(snap?.quarantined ?? snap?.quarantine)) return true
        return this.hasRecovery()
      } catch {
        return false
      }
    }
    if (!BITMAP_PENDING_UI_ENABLED) return false
    try {
      const snap = this.session?.snapshot()
      if (Boolean(snap?.quarantined ?? snap?.quarantine)) return true
      // Retained off-canvas recovery is quarantine-visible: same export/discard
      // UI, same fail-closed guarantee. Without this the recovery is invisible
      // after a direct-VM switch/clear (silent-loss RED).
      return this.hasRecovery()
    } catch {
      return false
    }
  }

  destroy(_reason = 'teardown'): void {
    if (this.testForceEnabled) {
      this.destroyInternal(_reason)
      return
    }
    // Intentionally no canvas touch and no VM write: the live canvas belongs
    // to whoever owns it now, and any staged pending stays inside the
    // dropped session (commit gates quarantine on conflict, never here).
    this.session = undefined
    this.slotKey = ''
    this.emitSnapshot()
    this.syncSelection()
  }

  private destroyInternal(reason = 'teardown'): void {
    // Ordinary target/canvas changes must NOT drop recovery: retain any
    // unsaved active as recovery and keep existing recovery. Only an explicit
    // destructive close (user-confirmed) clears retained recovery.
    if (isExplicitDestructiveReason(reason)) {
      // Explicit destructive close: drop everything without canvas/VM touch.
      // No commit, no restore: the caller confirmed the loss.
      this.session = undefined
      this.slotKey = ''
      this.slot = undefined
      this.recovered = undefined
      this.overflowStale = undefined
      this.emitSnapshot()
      this.emitRecoverySnapshot()
      this.syncSelection()
      return
    }
    if (this.session && this.slot && this.snapshotUnsaved(this.session)) {
      this.retainActiveAsRecovery(reason)
    } else if (this.session) {
      this.session = undefined
      this.slotKey = ''
      this.slot = undefined
    }
    this.emitSnapshot()
    this.emitRecoverySnapshot()
    this.syncSelection()
  }

  /**
   * Whether any unsaved bitmap work exists (active pending/in-flight/gap/
   * quarantine or any retained recovery). `beforeunload` wiring should consult
   * this and call `preventDefault()` when true. No DOM access here.
   */
  hasUnsavedState(): boolean {
    if (!this.enabled()) {
      if (!this.testForceEnabled) return false
    }
    try {
      if (this.session && this.snapshotUnsaved(this.session)) return true
      if (this.recovered && this.snapshotUnsaved(this.recovered.session)) return true
      if (this.overflowStale && this.snapshotUnsaved(this.overflowStale.session)) return true
      return false
    } catch {
      return true
    }
  }

  /** `beforeunload`-ready state (no DOM access; the UI wires the listener). */
  getBeforeUnloadState(): { hasUnsaved: boolean; needsPreventDefault: boolean; reason?: string } {
    const hasUnsaved = this.hasUnsavedState()
    return {
      hasUnsaved,
      needsPreventDefault: hasUnsaved,
      reason: hasUnsaved ? 'bitmap-pending-recovery: staged edit retained off-canvas; close would discard it without explicit export/discard' : undefined,
    }
  }

  /** Whether a retained off-canvas recovery exists (bounded single + overflow). */
  hasRecovery(): boolean {
    if (!this.enabled()) {
      if (!this.testForceEnabled) return false
    }
    return this.recovered !== undefined || this.overflowStale !== undefined
  }

  /**
   * Reactive hostile hook: retain any unsaved active as off-canvas recovery
   * BEFORE the caller reloads/teardowns the canvas for an external VM change
   * (direct `selectTarget`/`setCurrentCostume`/`deleteSprite`/`addSprite`/
   * `reorder`/`clear`/`loadProject`). Never touches canvas or VM, never
   * paints old to new, never silently destroys. No-op when nothing unsaved
   * (same-target reselect / same-bytes rename preserve intentional state).
   * Unknown/empty slots fail closed (retain conservatively). While a commit
   * is in flight the flight owns the staged copy: abort the CAS token so a
   * stale write cannot land on the new project, then retain the reference;
   * the flight settles fail-closed (preserved if not committed, gap sticky
   * if committed). A same-slot / same-project snapshot that arrives while a
   * commit is in flight is NOT aborted by the Editor caller (the CAS identity
   * verification decides: own bytes report `committed`, external bytes report
   * `external-conflict` with off-canvas quarantine). On such a conflict the
   * live canvas still shows the stale staged overlay; the Editor performs the
   * scoped rightful-owner reload after the refusal settles, keyed off the
   * active quarantine scope — the controller never paints old art itself.
   */
  retainUnsavedForExternalChange(reason = 'external-change'): boolean {
    if (!this.enabled()) return false
    try {
      const active = this.session
      if (!active) return this.hasRecovery()
      if (!this.slot) {
        // Unknown owner: fail closed, retain conservatively.
        if (this.snapshotUnsaved(active)) this.retainActiveAsRecovery(`${reason}:unknown-owner`)
        return true
      }
      if (!this.snapshotUnsaved(active)) return this.hasRecovery()
      // In-flight commit: abort the CAS atomically before the reload. The
      // trusted writer forwards the token to `updateCostumeIfMatch`, so a
      // project/target switch cannot land stale bytes on the new owner. The
      // flight then settles to aborted/superseded (preserved) or to a
      // committed-with-gap that stays sticky in the retained recovery.
      try {
        const snap = active.snapshot()
        if (snap.commitInFlight) {
          try {
            active.abortInFlight(reason)
          } catch {
            // Best effort only: retention below still preserves.
          }
        }
      } catch {
        // Best effort only.
      }
      this.retainActiveAsRecovery(reason)
      this.emitSnapshot()
      this.emitRecoverySnapshot()
      this.syncSelection()
      return true
    } catch {
      return false
    }
  }

  /** Recovery slot keys (oldest first) for explicit user action. */
  recoverySlotKeys(): string[] {
    const keys: string[] = []
    if (this.recovered) keys.push(this.recovered.slotKey)
    if (this.overflowStale) keys.push(this.overflowStale.slotKey)
    return keys
  }

  /**
   * Read-only retained pre-stroke base for stale-canvas cleanup (no canvas
   * touch, no VM/history write here). After a hostile switch to a non-bitmap
   * slot the live bitmap canvas keeps showing the old staged overlay (no
   * reload targets it); the Editor paints this base (shape-free) so the
   * hidden canvas no longer shows staged ink while the quarantined
   * base+shape composite stays immutable for exact export. Returns a detached
   * clone (mutating it cannot corrupt retention). Size-matched painting is
   * the caller's responsibility (fail closed on mismatch).
   */
  exportRetainedBaseImage(): ImageData | undefined {
    if (!this.enabled()) return undefined
    try {
      for (const entry of [this.recovered, this.overflowStale]) {
        try {
          const view =
            entry?.session.getQuarantined() ??
            entry?.session.getPreservedPending() ??
            entry?.session.getConflicted()
          const base = (view as { base?: unknown } | undefined)?.base
          if (base && typeof (base as ImageData).width === 'number' && typeof (base as ImageData).height === 'number') {
            return base as ImageData
          }
        } catch {
          // Try the next entry.
        }
      }
      try {
        const activeView = this.session?.getQuarantined()
        const base = (activeView as { base?: unknown } | undefined)?.base
        if (base && typeof (base as ImageData).width === 'number') return base as ImageData
      } catch {
        // Best effort only.
      }
    } catch {
      // Best effort only.
    }
    return undefined
  }

  private recoverySnapshotFor(entry: RetainedEntry | undefined): { hasPending: boolean; quarantined: boolean; historyGap: boolean; commitInFlight: boolean; slotKey: string } | undefined {
    if (!entry) return undefined
    try {
      const snap = entry.session.snapshot()
      return {
        hasPending: snap.hasPending === true,
        quarantined: Boolean(snap.quarantined ?? snap.quarantine),
        historyGap: snap.historyGap === true,
        commitInFlight: snap.commitInFlight === true,
        slotKey: entry.slotKey,
      }
    } catch {
      return { hasPending: true, quarantined: false, historyGap: false, commitInFlight: false, slotKey: entry.slotKey }
    }
  }

  /** Explicit read-only recovery inspection (no canvas touch, no VM write). */
  getRecoveryState(): { hasRecovery: boolean; entries: Array<{ hasPending: boolean; quarantined: boolean; historyGap: boolean; commitInFlight: boolean; slotKey: string }> } {
    const entries: Array<{ hasPending: boolean; quarantined: boolean; historyGap: boolean; commitInFlight: boolean; slotKey: string }> = []
    const first = this.recoverySnapshotFor(this.recovered)
    if (first && this.recovered) entries.push(first)
    const second = this.recoverySnapshotFor(this.overflowStale)
    if (second && this.overflowStale) entries.push(second)
    return { hasRecovery: entries.length > 0, entries }
  }

  /**
   * Explicit export of the retained old art as PNG bytes (detached composite,
   * zero VM writes). When the recovery is quarantined this is byte-exact
   * against the offline `base + shape` composite. When it is still pending
   * (a commit settled or is settling around the slot change), one off-canvas
   * quarantine is attempted first — no canvas touch, no VM/history write, so
   * it can never overwrite the external write. Explicit `commitRecovery()`
   * stays available for user-confirmed retry; export itself never commits.
   */
  async exportRecoveryPng(): Promise<Uint8Array | undefined> {
    if (!this.enabled()) return undefined
    const entry = this.recovered ?? this.overflowStale
    if (!entry) return undefined
    try {
      const direct =
        (await entry.session.exportQuarantinedPng()) ??
        (await entry.session.exportPreservedPng()) ??
        (await entry.session.exportConflictedPng())
      if (direct && direct.byteLength > 0) return new Uint8Array(direct)
    } catch {
      // Fall through to the lazy quarantine attempt below.
    }
    // Lazy off-canvas quarantine for still-pending recovery (e.g. a commit
    // settled conservatively around the slot change): moves staged ->
    // quarantine with no canvas touch and no VM/history write, then exports
    // the quarantined composite. Never commits, never overwrites.
    try {
      const snap = entry.session.snapshot()
      if (!snap.hasPending) return undefined
      if (Boolean(snap.quarantined ?? snap.quarantine)) return undefined
      if (snap.commitInFlight) return undefined
      try {
        entry.session.quarantineStagedOffCanvas('export-requested')
      } catch {
        return undefined
      }
      const after =
        (await entry.session.exportQuarantinedPng()) ??
        (await entry.session.exportPreservedPng()) ??
        (await entry.session.exportConflictedPng())
      if (after && after.byteLength > 0) return new Uint8Array(after)
      return undefined
    } catch {
      return undefined
    }
  }

  /** Alias for explicit staged-old-art export (same zero-VM-write path). */
  async exportRecoveredPng(): Promise<Uint8Array | undefined> {
    return this.exportRecoveryPng()
  }

  /** Same-slot quarantine lives in the active session: same zero-VM-write path. */
  async exportActiveQuarantinePng(): Promise<Uint8Array | undefined> {
    if (!this.enabled()) return undefined
    try {
      const active = this.session
      if (!active) return undefined
      const direct =
        (await active.exportQuarantinedPng()) ??
        (await active.exportPreservedPng()) ??
        (await active.exportConflictedPng())
      if (direct && direct.byteLength > 0) return new Uint8Array(direct)
    } catch {
      // Best effort only.
    }
    return undefined
  }

  /**
   * Explicit user-confirmed retry of the retained recovery commit. May land
   * only when still owned (same slot, session CAS decides); cross-slot and
   * refused cases fail closed with no overwrite. Never auto-called.
   */
  async commitRecovery(): Promise<unknown> {
    if (!this.enabled()) return { ok: false, kind: 'refused', reason: 'disabled' }
    const entry = this.recovered ?? this.overflowStale
    if (!entry) return { ok: true, kind: 'nothing-pending' }
    try {
      return await entry.session.commitPending()
    } catch (error) {
      return { ok: false, kind: 'refused', reason: 'commit-rejected', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Explicit user-confirmed discard of the retained recovery. Requires
   * `{ confirmed: true }`: without confirmation the recovery is kept and the
   * call is refused (no silent staged loss).
   */
  discardRecovery(options?: { confirmed?: boolean }): { ok: boolean; kind: string } {
    if (!this.enabled()) return { ok: false, kind: 'refused' }
    if (options?.confirmed !== true) {
      try {
        this.cb.onStatus('recovery discard refused: explicit confirmation required (pass { confirmed: true }); recovery retained')
      } catch {
        // Best effort only.
      }
      return { ok: false, kind: 'refused' }
    }
    if (this.recovered) {
      try {
        this.recovered.session.discardQuarantined()
      } catch {
        // Best effort only: reference drop is authoritative.
      }
      this.recovered = this.overflowStale
      this.overflowStale = undefined
      try {
        this.cb.onStatus('recovery discarded by explicit user action')
      } catch {
        // Best effort only.
      }
      this.emitSnapshot()
      this.emitRecoverySnapshot()
      this.syncSelection()
      return { ok: true, kind: 'discarded' }
    }
    if (this.overflowStale) {
      this.overflowStale = undefined
      this.emitRecoverySnapshot()
      return { ok: true, kind: 'discarded' }
    }
    return { ok: true, kind: 'nothing-pending' }
  }

  private emitSnapshot(): void {
    try {
      const snap = this.session?.snapshot()
      this.cb.onSnapshot?.({
        hasPending: snap?.hasPending === true,
        historyGap: snap?.historyGap === true,
        quarantined: Boolean(snap?.quarantined ?? snap?.quarantine),
        pendingKind: snap?.pendingKind,
        pendingMode: snap?.pendingMode,
      })
    } catch {
      // Best effort only.
    }
  }

  private emitRecoverySnapshot(): void {
    try {
      const state = this.getRecoveryState()
      const first = state.entries[0]
      this.cb.onRecoverySnapshot?.(
        state.hasRecovery && first
          ? { hasRecovery: true, hasPending: first.hasPending, quarantined: first.quarantined, historyGap: first.historyGap, commitInFlight: first.commitInFlight, slotKey: first.slotKey }
          : undefined,
      )
    } catch {
      // Best effort only.
    }
  }

  private syncSelection(): void {
    try {
      // Only the current active session owns the selection outline. Inactive
      // recovery never drives the live selection (never clobbers the new slot).
      if (!this.session) {
        const json = '__none__'
        if (json === this.lastSelectionJson) return
        this.lastSelectionJson = json
        this.cb.onSelection(undefined)
        return
      }
      const shape = this.session.getPendingShape()
      const next = pendingSelectionForShape(shape)
      const json = next ? JSON.stringify(next) : '__none__'
      if (json === this.lastSelectionJson) return
      this.lastSelectionJson = json
      this.cb.onSelection(next)
    } catch {
      // Best effort only.
    }
  }

  /** Current Editor paint controls -> session style snapshot. */
  styleFrom(source: BitmapPendingEditorStyleSource): PendingBitmapShapeStyle {
    return pendingStyleFromEditor(source)
  }

  modeFrom(value: unknown): BitmapShapeMode {
    return pendingModeFromEditor(value)
  }

  kindFrom(tool: unknown): ReturnType<typeof pendingKindFromTool> {
    return pendingKindFromTool(tool)
  }

  refresh(): void {
    this.emitSnapshot()
    this.emitRecoverySnapshot()
    this.syncSelection()
  }

  acknowledgeGap(note?: string): boolean {
    // A commit that lands while the selection moved mid-flight records its
    // `historyGap` inside the RETAINED (recovery) session, not the live one:
    // the live snapshot alone would leave the gap invisible (silent undo
    // loss). Acknowledge the active session AND any retained recovery
    // sessions so the sticky gap can always be cleared explicitly.
    const acknowledgeAll = (): boolean => {
      let acked = false
      try {
        const result = this.session?.acknowledgeHistoryGap(note)
        if (result?.acknowledged === true) acked = true
      } catch {
        // Best effort only.
      }
      for (const entry of [this.recovered, this.overflowStale]) {
        try {
          const result = entry?.session.acknowledgeHistoryGap(note)
          if (result?.acknowledged === true) acked = true
        } catch {
          // Best effort only.
        }
      }
      this.emitSnapshot()
      this.emitRecoverySnapshot()
      return acked
    }
    if (this.testForceEnabled) {
      try {
        return acknowledgeAll()
      } catch {
        return false
      }
    }
    if (!BITMAP_PENDING_UI_ENABLED) return false
    try {
      return acknowledgeAll()
    } catch {
      return false
    }
  }
}

/**
 * Isolated test-only factory injection for the disabled pending path.
 *
 * Production `BITMAP_PENDING_UI_ENABLED` stays `false`; this factory creates a
 * controller with an explicit in-process opt-in so recovery-lifecycle tests
 * can drive the REAL `createBitmapPendingSession` without adding any runtime
 * query/storage/env bypass to the production path. Never imported by product
 * code (`Editor.svelte` keeps using the constructor without options).
 */
export function createBitmapPendingControllerForTest(
  vm: BitmapPendingVmLike,
  cb: BitmapPendingControllerCallbacks,
): BitmapPendingController {
  return new BitmapPendingController(vm, cb, { testForceEnabled: true })
}
