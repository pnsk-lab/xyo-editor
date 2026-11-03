/** Audio remains disabled unless the runtime supplies the optional adapter below. */
export type XyoAudioCommand =
  | { type: 'open'; generation: number }
  | { type: 'start'; generation: number; id: bigint; bytes: ArrayBuffer; format?: string; volume: number; pitch: number; pan: number }
  | { type: 'effects'; generation: number; id: bigint; pitch: number; pan: number }
  | { type: 'stop'; generation: number; id: bigint }
  | { type: 'volume'; generation: number; id: bigint; volume: number }
  | { type: 'cancel'; generation: number }

export type XyoAudioReply =
  | { type: 'complete'; generation: number; id: bigint; result: 'ended' | 'stopped' | 'failed' }
  | { type: 'stopAck'; generation: number; id: bigint; ok: boolean }
  | { type: 'cancelAck'; generation: number; ok: boolean }

/** Temporary poll-only adapter contract for the asynchronous browser ABI.
 * open() is called after flag and before step; drain() copies all transient ABI
 * data before another ABI call. reply/tick/close never synchronously call JS.
 * A failed ACK must fail the runtime generation without resolving waits. close
 * must queue cancellation and must not destroy the ABI before its cancel ACK.
 * The adapter owns ABI timeouts; tick is called even without runtime steps.
 * Module-local generations are scoped to the worker epoch by the client. */
export interface XyoWorkerAudio {
  open(): void | Promise<void>
  drain(): XyoAudioCommand[] | Promise<XyoAudioCommand[]>
  reply(reply: XyoAudioReply): void | Promise<void>
  tick(): void | Promise<void>
  close(): void | Promise<void>
}

export type XyoWorkerOperation =
  | { type: 'load'; bytes: Uint8Array }
  | { type: 'flag'; compiled: boolean; audioEnabled?: boolean }
  | { type: 'step' }
  | { type: 'stop' }
  | { type: 'key'; key: string; down: boolean; keyCode?: number }
  | { type: 'mouse'; x: number; y: number; width: number; height: number; down: boolean; button?: number; dragged?: boolean }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'answer'; text: string }
  | { type: 'answerIfQuestion'; questionId: string; text: string }
  | { type: 'snapshot' }
  | { type: 'stats' }
  | { type: 'dispose' }
  | { type: 'audioReply'; reply: XyoAudioReply }

export type XyoWorkerRequest = { id: number; generation: number; operation: XyoWorkerOperation }
export type XyoWorkerResponse = { id: number; generation: number } &
  ({ ok: true; value?: unknown } | { ok: false; error: string })

export interface XyoWorkerRuntime {
  readonly audio?: XyoWorkerAudio
  loadSb3(bytes: Uint8Array): void | Promise<void>
  greenFlagInterpreter(): void | Promise<void>
  greenFlagCompiled(): void | Promise<void>
  step(): void | Promise<void>
  stop(): void | Promise<void>
  key(key: string, down: boolean, keyCode?: number): void | Promise<void>
  mouse(x: number, y: number, width: number, height: number, down: boolean, button?: number, dragged?: boolean): void | Promise<void>
  wheel(dx: number, dy: number): void | Promise<void>
  answer(text: string): void | Promise<void>
  answerIfQuestion?(questionId: string, text: string): boolean | Promise<boolean>
  snapshot(): unknown | Promise<unknown>
  readonly compileStats: unknown
  readonly supportsCompiledExecution: boolean
  dispose(): void | Promise<void>
}
