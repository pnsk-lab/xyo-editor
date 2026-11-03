import { describe, expect, test } from 'bun:test';
import { WebAudioHost, type AudioHostContext, type PlaybackResult } from './web-audio-host';

function fixture() {
  let resolve!: (value: AudioBuffer) => void;
  let reject!: (reason?: unknown) => void;
  const pending = new Promise<AudioBuffer>((yes, no) => { resolve = yes; reject = no; });
  const reports: Array<[number, bigint, PlaybackResult]> = [];
  const source = {
    playbackRate: { value: 1 }, buffer: null, onended: null as null | (() => void), started: 0, stopped: 0, disconnected: 0,
    connect() {}, disconnect() { this.disconnected++; }, start() { this.started++; },
    stop() { this.stopped++; this.onended?.(); },
  };
  const gain = { gain: { value: 0 }, disconnected: 0, connect() {}, disconnect() { this.disconnected++; } };
  const panner = { pan: { value: 0 }, disconnected: 0, connect() {}, disconnect() { this.disconnected++; } };
  let copied: ArrayBuffer | undefined;
  const context = {
    destination: {}, decodeAudioData(data: ArrayBuffer) { copied = data; return pending; },
    createBufferSource() { return source; }, createGain() { return gain; }, createStereoPanner() { return panner; },
  } as unknown as AudioHostContext;
  const host = new WebAudioHost(7, context, (...args) => reports.push(args));
  return { host, source, gain, panner, reports, resolve, reject, get copied() { return copied; } };
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const buffer = {} as AudioBuffer;

describe('WebAudioHost', () => {
  test('copies input and reports a genuine end once with cleanup', async () => {
    const f = fixture(); const bytes = new Uint8Array([1, 2]);
    expect(f.host.start(7, 1n, bytes.buffer, .5)).toBe(true);
    bytes[0] = 9; expect(new Uint8Array(f.copied!)[0]).toBe(1);
    f.resolve(buffer); await tick();
    expect(f.source.started).toBe(1); expect(f.gain.gain.value).toBe(.5);
    const ended = f.source.onended!; ended(); ended();
    expect(f.reports).toEqual([[7, 1n, 'ended']]);
    expect(f.source.disconnected).toBe(1); expect(f.gain.disconnected).toBe(1);
    expect(f.host.stop(7, 1n)).toBe(true);
    expect(f.host.start(7, 1n, bytes.buffer)).toBe(false);
  });
  test('volume updates survive decode and affect active playback without reviving voices', async () => {
    const f = fixture();
    expect(f.host.start(7, 1n, new ArrayBuffer(0), .5)).toBe(true);
    expect(f.host.setVolume(7, 1n, .2)).toBe(true);
    expect(f.host.setVolume(8, 1n, .9)).toBe(false);
    expect(f.host.setVolume(7, 2n, .9)).toBe(false);
    expect(f.host.setVolume(7, 1n, NaN)).toBe(false);
    f.resolve(buffer); await tick();
    expect(f.gain.gain.value).toBe(.2);
    expect(f.host.setVolume(7, 1n, .8)).toBe(true);
    expect(f.gain.gain.value).toBe(.8);
    expect(f.host.stop(7, 1n)).toBe(true);
    expect(f.host.setVolume(7, 1n, .1)).toBe(true);
    expect(f.reports).toEqual([[7, 1n, 'stopped']]);
    f.host.invalidate(); expect(f.host.setVolume(7, 1n, .1)).toBe(false);
  });
  test('effects follow decode, playback, stop, and generation boundaries', async () => {
    const f = fixture();
    expect(f.host.start(7, 1n, new ArrayBuffer(0), 1, 120, -100)).toBe(true);
    expect(f.host.setEffects(7, 1n, -120, 50)).toBe(true);
    expect(f.host.setEffects(7, 1n, NaN, 0)).toBe(false);
    expect(f.host.setEffects(7, 1n, 361, 0)).toBe(false);
    expect(f.host.setEffects(8, 1n, 0, 0)).toBe(false);
    f.resolve(buffer); await tick();
    expect(f.source.playbackRate.value).toBe(.5); expect(f.panner.pan.value).toBe(.5);
    expect(f.host.setEffects(7, 1n, 360, -100)).toBe(true);
    expect(f.source.playbackRate.value).toBe(8); expect(f.panner.pan.value).toBe(-1);
    expect(f.host.stop(7, 1n)).toBe(true); expect(f.panner.disconnected).toBe(1);
    expect(f.host.setEffects(7, 1n, 0, 0)).toBe(true);
    f.host.invalidate(); expect(f.host.setEffects(7, 1n, 0, 0)).toBe(false);
  });
  test('non-ADPCM WAV remains on the native decoder', async () => {
    const f = fixture();
    const pcm = new Uint8Array([82,73,70,70,38,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,68,172,0,0,136,88,1,0,2,0,16,0,100,97,116,97,2,0,0,0,0,0]);
    f.host.start(7, 1n, pcm.buffer, 1, 0, 0, 'wav');
    await tick();
    expect(f.copied).toBeDefined();
    f.resolve(buffer); await tick();
    expect(f.source.started).toBe(1);
  });
  test('ADPCM creates a mono AudioBuffer and applies pending effects', async () => {
    const bytes = new Uint8Array([82,73,70,70,46,0,0,0,87,65,86,69,102,109,116,32,20,0,0,0,17,0,1,0,34,86,0,0,142,143,0,0,5,0,4,0,2,0,3,0,100,97,116,97,5,0,0,0,0,128,0,0,0,0]);
    const f = fixture();
    let rate = 0, samples = new Float32Array();
    const source = f.source;
    const reports: PlaybackResult[] = [];
    const context = {
      destination: {}, decodeAudioData(data: ArrayBuffer) { structuredClone(data, { transfer: [data] }); throw Error('native rejected'); },
      createBuffer(channels: number, length: number, sampleRate: number) {
        expect(channels).toBe(1); rate = sampleRate; samples = new Float32Array(length);
        return { getChannelData: () => samples };
      },
      createBufferSource: () => source, createGain: () => f.gain, createStereoPanner: () => f.panner,
    } as unknown as AudioHostContext;
    const host = new WebAudioHost(1, context, (_g, _id, result) => reports.push(result));
    expect(host.start(1, 1n, bytes.buffer, 1, 0, 0, 'wav')).toBe(true);
    expect(host.setEffects(1, 1n, 120, 50)).toBe(true);
    await tick();
    expect(source.started).toBe(1); expect(rate).toBe(22050);
    expect(samples[0]).toBe(-1); expect(samples.length).toBe(3);
    expect(source.playbackRate.value).toBe(2); expect(f.panner.pan.value).toBe(.5);
    expect(host.stop(1, 1n)).toBe(true); expect(reports).toEqual(['stopped']);
  });
  test('invalid ADPCM fails closed after native decoding rejects', async () => {
    const f = fixture();
    expect(f.host.start(7, 1n, new ArrayBuffer(0), 1, 0, 0, 'adpcm')).toBe(true);
    await tick();
    expect(f.copied).toBeDefined();
    f.reject(Error('native rejected')); await tick();
    expect(f.source.started).toBe(0);
    expect(f.reports).toEqual([[7, 1n, 'failed']]);
  });
  test('stop or invalidation before ADPCM decode prevents late playback', async () => {
    const f = fixture();
    f.host.start(7, 1n, new ArrayBuffer(0), 1, 0, 0, 'adpcm');
    expect(f.host.stop(7, 1n)).toBe(true);
    await tick();
    expect(f.reports).toEqual([[7, 1n, 'stopped']]);
    expect(f.source.started).toBe(0);
    const g = fixture();
    g.host.start(7, 1n, new ArrayBuffer(0), 1, 0, 0, 'adpcm');
    expect(g.host.invalidate()).toBe(true);
    await tick();
    expect(g.reports).toEqual([]);
    expect(g.source.started).toBe(0);
  });
  test('late native success or rejection after ADPCM stop cannot play or fallback', async () => {
    const f = fixture(); f.host.start(7, 1n, new ArrayBuffer(0), 1, 0, 0, 'adpcm');
    await tick(); expect(f.copied).toBeDefined();
    expect(f.host.stop(7, 1n)).toBe(true); f.reject(Error('late')); await tick();
    expect(f.source.started).toBe(0); expect(f.reports).toEqual([[7, 1n, 'stopped']]);
    const g = fixture(); g.host.start(7, 1n, new ArrayBuffer(0), 1, 0, 0, 'wav');
    await tick(); expect(g.host.invalidate()).toBe(true); g.resolve(buffer); await tick();
    expect(g.source.started).toBe(0); expect(g.reports).toEqual([]);
  });
  test('stop during decode prevents playback and late rejection', async () => {
    const f = fixture(); f.host.start(7, 2n, new ArrayBuffer(0));
    expect(f.host.stop(7, 2n)).toBe(true); f.reject(Error('late')); await tick();
    expect(f.source.started).toBe(0); expect(f.reports).toEqual([[7, 2n, 'stopped']]);
  });
  test('stop is synchronous even with reentrant ended', async () => {
    const f = fixture(); f.host.start(7, 3n, new ArrayBuffer(0)); f.resolve(buffer); await tick();
    expect(f.host.stop(7, 3n)).toBe(true);
    expect(f.source.stopped).toBe(1); expect(f.source.disconnected).toBe(1);
    expect(f.reports).toEqual([[7, 3n, 'stopped']]);
  });
  test('missing stereo panner fails without launching playback', async () => {
    const reports: PlaybackResult[] = []
    const context = { decodeAudioData: async () => buffer, createBufferSource: () => ({ disconnect() {} }), createGain: () => ({ disconnect() {} }) } as unknown as AudioHostContext
    const host = new WebAudioHost(1, context, (_g, _id, result) => reports.push(result))
    expect(host.start(1, 1n, new ArrayBuffer(0))).toBe(true)
    await tick(); expect(reports).toEqual(['failed'])
  });
  test('decode failure is terminal', async () => {
    const f = fixture(); f.host.start(7, 4n, new ArrayBuffer(0)); f.reject(Error('bad')); await tick();
    expect(f.reports).toEqual([[7, 4n, 'failed']]);
  });
  test('invalidation cancels and suppresses stale promises and wrong generation', async () => {
    const f = fixture();
    expect(f.host.start(8, 1n, new ArrayBuffer(0))).toBe(false);
    f.host.start(7, 1n, new ArrayBuffer(0));
    expect(f.host.stop(8, 1n)).toBe(false);
    expect(f.host.invalidate()).toBe(true); f.resolve(buffer); await tick();
    expect(f.source.started).toBe(0); expect(f.reports).toEqual([]);
    expect(f.host.start(7, 2n, new ArrayBuffer(0))).toBe(false);
  });
  test('late decode success after stop and active invalidation cannot play', async () => {
    const f = fixture(); f.host.start(7, 8n, new ArrayBuffer(0));
    expect(f.host.stop(7, 8n)).toBe(true); f.resolve(buffer); await tick();
    expect(f.source.started).toBe(0);
    const g = fixture(); g.host.start(7, 9n, new ArrayBuffer(0)); g.resolve(buffer); await tick();
    expect(g.host.invalidate()).toBe(true); expect(g.source.stopped).toBe(1);
    expect(g.source.disconnected).toBe(1); expect(g.reports).toEqual([]);
  });
  test('monotonic starts preserve gaps and terminal stop races', async () => {
    const f = fixture();
    expect(f.host.start(7, 2n, new ArrayBuffer(0))).toBe(true);
    expect(f.host.stop(7, 1n)).toBe(false);
    expect(f.host.stop(7, 2n)).toBe(true);
    expect(f.host.stop(7, 2n)).toBe(true); // already terminal, racing stop
    expect(f.host.start(7, 1n, new ArrayBuffer(0))).toBe(false);
    expect(f.host.start(7, 2n, new ArrayBuffer(0))).toBe(false);
    expect(f.host.start(7, 4n, new ArrayBuffer(0))).toBe(true);
    expect(f.host.stop(7, 3n)).toBe(false);
    expect(f.host.stop(7, 4n)).toBe(true);
  });
  test('bounded ranges reject excess gaps before launching playback', () => {
    const f = fixture();
    for (let id = 1n; id <= 511n; id += 2n) {
      expect(f.host.start(7, id, new ArrayBuffer(0))).toBe(true);
      expect(f.host.stop(7, id)).toBe(true);
    }
    expect(f.host.start(7, 513n, new ArrayBuffer(0))).toBe(false);
    expect(f.host.stop(7, 512n)).toBe(false);
    expect(f.host.stop(7, 513n)).toBe(false);
    expect(f.host.stop(7, 1n)).toBe(true);
    // Extending the final range does not consume additional storage.
    expect(f.host.start(7, 512n, new ArrayBuffer(0))).toBe(true);
    expect(f.host.stop(7, 512n)).toBe(true);
  });
  test('stop failure is not acknowledged', async () => {

    const f = fixture(); f.host.start(7, 5n, new ArrayBuffer(0)); f.resolve(buffer); await tick();
    f.source.stop = () => { throw Error('stop failed'); };
    expect(f.host.stop(7, 5n)).toBe(false); expect(f.reports).toEqual([]);
    expect(f.host.invalidate()).toBe(false);
  });
});
