// Transport-independent worker-side audio bookkeeping. This is not wired into
// the WASM runtime: a SoundBank adapter must map tokens to live Thread waits.
export interface AudioToken {
  readonly generation: number
  readonly id: number
}

export type AudioCommand =
  | { readonly type: 'play'; readonly token: AudioToken; readonly target: string; readonly soundId: number; readonly wait: boolean }
  | { readonly type: 'stop'; readonly target: string; readonly soundId: number }
  | { readonly type: 'stop-all' }

// The browser must report these only after the corresponding outcome is known.
// Failure and explicit interruption are not natural playback completion.
export type AudioOutcome = 'ended' | 'stopped' | 'failed'
export interface AudioEvent {
  readonly token: AudioToken
  readonly outcome: AudioOutcome
}

/** Single-threaded queue: message arrival and draining must run on the worker. */
export class AudioEventQueue {
  private generation = 0
  private nextId = 0
  private commands: AudioCommand[] = []
  private events: AudioEvent[] = []
  private active = new Set<number>()

  play(target: string, soundId: number, wait: boolean): AudioToken {
    if (!Number.isSafeInteger(this.nextId)) throw new Error('Audio token space exhausted')
    const token = Object.freeze({ generation: this.generation, id: this.nextId++ })
    this.active.add(token.id)
    this.commands.push({ type: 'play', token, target, soundId, wait })
    return token
  }

  stop(target: string, soundId: number): void {
    this.commands.push({ type: 'stop', target, soundId })
  }

  stopAll(): void {
    this.commands.push({ type: 'stop-all' })
  }

  /** Reset a project: cancel stale waits locally and request browser silence. */
  reset(): void {
    if (!Number.isSafeInteger(this.generation + 1)) throw new Error('Audio generation space exhausted')
    this.generation++
    this.nextId = 0
    this.active.clear()
    this.events = []
    // Preserve ordered commands, including pending plays, so stop-all follows them.
    this.commands.push({ type: 'stop-all' })
  }

  /** Reject duplicate, unknown and previous-project events. Never invent one. */
  receive(event: AudioEvent): boolean {
    if (event.outcome !== 'ended' && event.outcome !== 'stopped' && event.outcome !== 'failed') return false
    if (event.token.generation !== this.generation || !this.active.delete(event.token.id)) return false
    this.events.push({ token: Object.freeze({ ...event.token }), outcome: event.outcome })
    return true
  }

  drainCommands(): AudioCommand[] {
    return this.commands.splice(0)
  }

  drainEvents(): AudioEvent[] {
    return this.events.splice(0)
  }
}
