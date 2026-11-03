import type { AudioBridge, AudioBridgeCommand } from '../../../xyo-cpp-wasm/src/audio-bridge'
import type { XyoAudioCommand, XyoAudioReply, XyoWorkerAudio } from './xyo-worker-protocol'

/** Experimental worker adapter; its owner still needs an independent epoch and watchdog. */
export class XyoAudioAbiAdapter implements XyoWorkerAudio {
  private state: 'idle' | 'active' | 'closing' = 'idle'
  private generation = 0
  private announce = false
  private cancelDelivered = false
  private faulted = false
  // IDs are monotonic but can have gaps (e.g. missing assets). Keep only
  // outstanding voices, not an unbounded history of completed playback.
  private maxId = 0n
  private readonly voices = new Map<bigint, { terminal: boolean; stopping: boolean }>()

  constructor(private readonly bridge: Pick<AudioBridge, 'open' | 'getSessionGeneration' | 'close' | 'detach' | 'tick' | 'failed' | 'poll' | 'pop' | 'complete' | 'stopAck' | 'closeAck'>, private readonly timeoutTicks: number) {
    if (!Number.isInteger(timeoutTicks) || timeoutTicks <= 0 || timeoutTicks > 0xffffffff) throw new RangeError('Invalid audio timeout')
  }

  open(): void {
    if (this.state !== 'idle') throw new Error('Audio session already open')
    this.bridge.open(this.timeoutTicks)
    // If the getter fails, the open session must still be closed, never detached.
    this.state = 'active'
    try {
      const generation = this.bridge.getSessionGeneration()
      if (!Number.isInteger(generation) || generation <= 0 || generation > 0xffffffff) throw new Error('Invalid audio generation')
      this.generation = generation
      this.announce = true
    } catch (error) {
      try { this.close() } catch { /* outer supervisor must cancel this epoch */ }
      throw error
    }
  }

  close(): void {
    if (this.state === 'idle') throw new Error('Audio session not open')
    if (this.state === 'closing') return
    this.bridge.close()
    this.state = 'closing'
  }

  tick(): void {
    if (this.state === 'idle') return
    const stepping = this.bridge.tick()
    if (this.bridge.failed()) { this.faulted = true; throw new Error('Audio generation failed; supervisor cancellation required') }
    // Runtime stop can close the ABI independently; drain will observe cancel.
    if (!stepping) this.state = 'closing'
  }

  drain(): XyoAudioCommand[] {
    if (this.state === 'idle') return []
    if (!this.generation) throw new Error('Audio generation unavailable')
    const output: XyoAudioCommand[] = []
    if (this.announce) { output.push({ type: 'open', generation: this.generation }); this.announce = false }
    // The ABI caps its queue at 256. A higher count means a broken implementation.
    for (let count = 0; count <= 256; count++) {
      const command = this.bridge.poll()
      if (!command) return output
      if (count === 256) throw new Error('Audio command queue exceeds ABI limit')
      this.validate(command)
      let converted: XyoAudioCommand
      if (command.type === 'start') {
        if (this.faulted || this.state !== 'active' || command.id <= this.maxId || this.voices.size >= 256) throw new Error('Invalid audio start')
        // Transfer must not alias the ABI heap or an injected bridge's view.
        const bytes = new Uint8Array(command.bytes).buffer
        converted = { type: 'start', generation: command.generation, id: command.id, bytes, format: command.format, volume: Math.max(0, Math.min(1, command.volume / 100)), pitch: command.pitch, pan: command.pan }
      } else if (command.type === 'effects') {
        if (this.faulted || this.state !== 'active' || command.id > this.maxId) throw new Error('Invalid audio effects')
        converted = { type: 'effects', generation: command.generation, id: command.id, pitch: command.pitch, pan: command.pan }
      } else if (command.type === 'volume') {
        if (this.faulted || this.state !== 'active' || command.id > this.maxId || !Number.isFinite(command.volume)) throw new Error('Invalid audio volume')
        converted = { type: 'volume', generation: command.generation, id: command.id, volume: Math.max(0, Math.min(1, command.volume / 100)) }
      } else if (command.type === 'stop') {
        const voice = this.voices.get(command.id)
        // An ABI stop can have been enqueued before a completion arrived. In
        // that race its completed voice was already removed from our map.
        // Only the trusted ABI may produce stop commands; the high-water mark
        // cannot prove that an old ID (possibly a gap) actually had a start.
        if (this.state !== 'active' || command.id > this.maxId || voice?.stopping || (!voice && this.voices.size >= 256)) throw new Error('Invalid audio stop')
        converted = { type: 'stop', generation: command.generation, id: command.id }
      } else {
        if (this.cancelDelivered) throw new Error('Duplicate audio cancellation')
        converted = { type: 'cancel', generation: command.generation }
      }
      // Never report a command as delivered until pop succeeds.
      this.bridge.pop()
      if (command.type === 'start') { this.maxId = command.id; this.voices.set(command.id, { terminal: false, stopping: false }) }
      else if (command.type === 'stop') {
        const voice = this.voices.get(command.id)
        if (voice) voice.stopping = true
        else this.voices.set(command.id, { terminal: true, stopping: true })
      }
      else if (command.type === 'cancel') { this.state = 'closing'; this.cancelDelivered = true }
      output.push(converted)
    }
    throw new Error('Invalid audio queue')
  }

  reply(reply: XyoAudioReply): void {
    if (this.state === 'idle' || !reply || reply.generation !== this.generation || !this.generation) throw new Error('Stale audio reply')
    if (reply.type === 'cancelAck') {
      if (this.state !== 'closing' || !this.cancelDelivered || typeof reply.ok !== 'boolean') throw new Error('Unexpected cancellation ACK')
      const accepted = this.bridge.closeAck(this.generation, reply.ok)
      if (!reply.ok || !accepted) { this.faulted = true; throw new Error('Audio cancellation was not acknowledged') }
      // Only a successful host cancellation ACK permits destruction/detach.
      this.bridge.detach()
      this.state = 'idle'; this.generation = 0; this.announce = false; this.cancelDelivered = false; this.faulted = false; this.maxId = 0n; this.voices.clear()
      return
    }
    if (typeof reply.id !== 'bigint' || reply.id <= 0n || reply.id > 0xffffffffffffffffn) throw new Error('Invalid audio reply')
    if (this.state === 'closing') {
      // The ABI invalidates all voice waits on close. Already-sent terminal
      // reports and stop ACKs can arrive later; they neither resolve waits nor
      // acknowledge cancellation. Only cancelAck can detach the session.
      if (reply.type === 'complete' && ['ended', 'stopped', 'failed'].includes(reply.result)) return
      if (reply.type === 'stopAck' && typeof reply.ok === 'boolean') return
      throw new Error('Invalid audio reply')
    }
    if (this.faulted || this.state !== 'active') throw new Error('Invalid audio reply')
    const voice = this.voices.get(reply.id)
    if (!voice) throw new Error('Unknown audio voice')
    if (reply.type === 'complete') {
      if (voice.terminal || !['ended', 'stopped', 'failed'].includes(reply.result)) throw new Error('Duplicate or invalid completion')
      this.bridge.complete(this.generation, reply.id)
      if (voice.stopping) voice.terminal = true
      else this.voices.delete(reply.id)
    } else if (reply.type === 'stopAck') {
      if (!voice.stopping || typeof reply.ok !== 'boolean') throw new Error('Unexpected stop ACK')
      this.bridge.stopAck(this.generation, reply.id, reply.ok)
      this.voices.delete(reply.id)
      if (!reply.ok || this.bridge.failed()) { this.faulted = true; throw new Error('Audio stop failed; supervisor cancellation required') }
    } else throw new Error('Invalid audio reply type')
  }

  private validate(command: AudioBridgeCommand): void {
    if (command.generation !== this.generation) throw new Error('Stale audio command')
    if (command.type === 'start') {
      if (!(command.bytes instanceof Uint8Array) || typeof command.format !== 'string' || command.format.length > 256 || !Number.isFinite(command.volume)) throw new Error('Invalid audio start data')
    }
    if (command.type === 'start' || command.type === 'effects') {
      if (!Number.isFinite(command.pitch) || command.pitch < -360 || command.pitch > 360 || !Number.isFinite(command.pan) || command.pan < -100 || command.pan > 100) throw new Error('Invalid audio effects')
    }
    if (command.type !== 'cancel' && (typeof command.id !== 'bigint' || command.id <= 0n || command.id > 0xffffffffffffffffn)) throw new Error('Invalid audio voice ID')
    if (command.type !== 'start' && command.type !== 'stop' && command.type !== 'volume' && command.type !== 'effects' && command.type !== 'cancel') throw new Error('Invalid audio command')
  }
}
