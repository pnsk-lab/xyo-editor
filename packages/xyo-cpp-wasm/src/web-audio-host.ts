import { decodeScratchAdpcm } from './scratch-adpcm';

/** Experimental main-thread playback only; no worker transport or autoplay policy. */
export type VoiceId = bigint;
export type PlaybackResult = 'ended' | 'stopped' | 'failed';

export interface AudioHostContext {
  readonly destination: AudioNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBuffer?(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  createStereoPanner(): StereoPannerNode;
}

type Voice = { source?: AudioBufferSourceNode; gain?: GainNode; panner?: StereoPannerNode; volume: number; pitch: number; pan: number; settled: boolean; stopping?: boolean };
const validEffects = (pitch: number, pan: number) => Number.isFinite(pitch) && pitch >= -360 && pitch <= 360 && Number.isFinite(pan) && pan >= -100 && pan <= 100;

/**
 * One instance owns one nonzero, never-reused transport generation. Bytes are
 * copied immediately. Reports are terminal and at most once per accepted ID.
 * A caller handling a stop request must send its ACK from stop()'s return
 * value, not from the terminal report: completion and stop can race in transit.
 * Accepted starts must be in strictly increasing ID order (gaps are allowed). Accepted
 * IDs are retained as at most 256 compressed ranges; once full, a start that
 * would require another range is rejected without launching playback.
 */
export class WebAudioHost {
  private readonly voices = new Map<VoiceId, Voice>();
  private highWater = 0n;
  private readonly accepted: Array<[VoiceId, VoiceId]> = [];
  private static readonly maxRanges = 256;
  private active = true;

  constructor(
    readonly generation: number,
    private readonly context: AudioHostContext,
    private readonly report: (generation: number, id: VoiceId, result: PlaybackResult) => void,
  ) {
    if (!Number.isInteger(generation) || generation <= 0 || generation > 0xffffffff)
      throw new RangeError('generation must be a nonzero uint32');
  }

  /** False means no playback was launched; an ID cannot be reused. */
  start(generation: number, id: VoiceId, bytes: ArrayBuffer, volume = 1, pitch = 0, pan = 0, format?: string): boolean {
    if (!this.active || generation !== this.generation || typeof id !== 'bigint' || id <= this.highWater || id > 0xffffffffffffffffn || !Number.isFinite(volume) || !validEffects(pitch, pan)) return false;
    if (format !== undefined && typeof format !== 'string') return false;
    const normalizedFormat = format?.toLowerCase();
    const last = this.accepted[this.accepted.length - 1];
    if ((!last || id !== last[1] + 1n) && this.accepted.length >= WebAudioHost.maxRanges) return false;
    let copy: ArrayBuffer;
    try {
      if ((normalizedFormat === 'wav' || normalizedFormat === 'adpcm') && bytes.byteLength > 8 * 1024 * 1024) return false;
      copy = bytes.slice(0);
    } catch { return false; }
    this.highWater = id;
    if (last && id === last[1] + 1n) last[1] = id;
    else this.accepted.push([id, id]);
    const voice: Voice = { settled: false, volume, pitch, pan };
    this.voices.set(id, voice);
    try {
      const decoding = normalizedFormat === 'adpcm' || normalizedFormat === 'wav'
        ? Promise.resolve().then(() => {
          if (!this.active || voice.settled || this.voices.get(id) !== voice) return null;
          // decodeAudioData may detach its argument, so preserve a separate copy.
          return this.context.decodeAudioData(copy.slice(0));
        }).catch(() => {
          if (!this.active || voice.settled || this.voices.get(id) !== voice) return null;
          const decoded = decodeScratchAdpcm(copy);
          if (!decoded || !this.context.createBuffer) throw new Error('Invalid or unsupported Scratch ADPCM');
          const buffer = this.context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
          buffer.getChannelData(0).set(decoded.samples);
          return buffer;
        })
        : Promise.resolve(this.context.decodeAudioData(copy));
      decoding.then(buffer => {
        if (!buffer) return;
        if (!this.active || voice.settled || this.voices.get(id) !== voice) return;
        try {
          const source = this.context.createBufferSource();
          voice.source = source;
          const gain = this.context.createGain();
          voice.gain = gain;
          const panner = this.context.createStereoPanner();
          voice.panner = panner;
          source.buffer = buffer;
          source.playbackRate.value = Math.pow(2, voice.pitch / 120);
          panner.pan.value = voice.pan / 100;
          gain.gain.value = voice.volume;
          source.connect(gain);
          gain.connect(panner);
          panner.connect(this.context.destination);
          source.onended = () => { if (!voice.stopping) this.finish(id, voice, 'ended'); };
          source.start();
        } catch {
          this.finish(id, voice, 'failed');
        }
      }, () => this.finish(id, voice, 'failed'));
    } catch {
      this.finish(id, voice, 'failed');
    }
    return true;
  }

  /** Update one accepted voice, including while its audio is decoding. */
  setVolume(generation: number, id: VoiceId, volume: number): boolean {
    if (!this.active || generation !== this.generation || typeof id !== 'bigint' ||
        !Number.isFinite(volume) || !this.wasAccepted(id)) return false;
    const voice = this.voices.get(id);
    if (!voice) return true; // terminal completion can race an already queued update
    try {
      if (voice.gain) voice.gain.gain.value = volume;
      voice.volume = volume;
      return true;
    } catch { return false; }
  }

  /** Update both effects during decoding or playback; errors require caller cancellation. */
  setEffects(generation: number, id: VoiceId, pitch: number, pan: number): boolean {
    if (!this.active || generation !== this.generation || typeof id !== 'bigint' ||
        !validEffects(pitch, pan) || !this.wasAccepted(id)) return false;
    const voice = this.voices.get(id);
    if (!voice) return true;
    try {
      if (voice.source) voice.source.playbackRate.value = Math.pow(2, pitch / 120);
      if (voice.panner) voice.panner.pan.value = pan / 100;
      voice.pitch = pitch;
      voice.pan = pan;
      return true;
    } catch { return false; }
  }

  /** Synchronous cancellation; false means cancellation could not be confirmed. */
  stop(generation: number, id: VoiceId): boolean {
    if (!this.active || generation !== this.generation || typeof id !== 'bigint' || !this.wasAccepted(id)) return false;
    const voice = this.voices.get(id);
    if (!voice) return true; // already terminal; a racing stop still needs an ACK
    if (voice.source) {
      voice.stopping = true;
      try { voice.source.stop(); } catch { voice.stopping = false; return false; }
    }
    this.finish(id, voice, 'stopped');
    return true;
  }

  /** Invalidate routing first and synchronously cancel all outstanding voices. */
  invalidate(): boolean {
    if (!this.active) return true;
    this.active = false;
    let ok = true;
    for (const [id, voice] of this.voices) {
      if (voice.source) {
        try { voice.source.stop(); } catch { ok = false; }
      }
      this.finish(id, voice, undefined);
    }
    return ok;
  }

  private wasAccepted(id: VoiceId): boolean {
    let lo = 0, hi = this.accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const [start, end] = this.accepted[mid];
      if (id < start) hi = mid;
      else if (id > end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  private finish(id: VoiceId, voice: Voice, result: PlaybackResult | undefined): void {
    if (voice.settled || this.voices.get(id) !== voice) return;
    voice.settled = true;
    this.voices.delete(id);
    if (voice.source) {
      voice.source.onended = null;
      try { voice.source.disconnect(); } catch { /* best effort */ }
    }
    if (voice.gain) {
      try { voice.gain.disconnect(); } catch { /* best effort */ }
    }
    if (voice.panner) {
      try { voice.panner.disconnect(); } catch { /* best effort */ }
    }
    if (result && this.active) this.report(this.generation, id, result);
  }
}
