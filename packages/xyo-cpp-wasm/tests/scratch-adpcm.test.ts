import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeScratchAdpcm } from '../src/scratch-adpcm';

function wav(blocks: number[] | Uint8Array, opts: { blockSize?: number; channels?: number; fact?: number } = {}): ArrayBuffer {
  const blockSize = opts.blockSize ?? 5;
  const fact = opts.fact === undefined ? 0 : 12;
  const dataPad = blocks.length & 1;
  const result = new ArrayBuffer(12 + 28 + fact + 8 + blocks.length + dataPad);
  const v = new DataView(result);
  const text = (p: number, s: string) => [...s].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, result.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 20, true); v.setUint16(20, 17, true);
  v.setUint16(22, opts.channels ?? 1, true); v.setUint32(24, 22050, true);
  v.setUint32(28, 11025, true); v.setUint16(32, blockSize, true); v.setUint16(34, 4, true);
  v.setUint16(36, 2, true); v.setUint16(38, (blockSize - 4) * 2 + 1, true);
  let p = 40;
  if (fact) { text(p, 'fact'); v.setUint32(p + 4, 4, true); v.setUint32(p + 8, opts.fact!, true); p += 12; }
  text(p, 'data'); v.setUint32(p + 4, blocks.length, true);
  new Uint8Array(result, p + 8, blocks.length).set(blocks);
  return result;
}
const pcm = (result: ReturnType<typeof decodeScratchAdpcm>) => Array.from(result!.samples, n => n * 32768);

describe('Scratch IMA ADPCM fallback', () => {
  test('low nibble first, predictor, saturation, and fact ignored', () => {
    expect(pcm(decodeScratchAdpcm(wav([0, 0, 0, 0, 0x71], { fact: 0xffffffff })))).toEqual([0, 1, 12]);
    expect(pcm(decodeScratchAdpcm(wav([0xff, 0x7f, 88, 0, 0x77])))).toEqual([32767, 32767, 32767]);
    expect(pcm(decodeScratchAdpcm(wav([0, 0x80, 88, 0, 0xff])))).toEqual([-32768, -32768, -32768]);
  });
  test('Scratch multiblock sample count and last block truncation', () => {
    expect(pcm(decodeScratchAdpcm(wav([0, 0, 0, 0, 0x71, 100, 0, 0, 0, 0x71])))).toEqual([0, 1, 12, 100, 101]);
  });
  test('partial block must not synthesize samples beyond compressed data', () => {
    expect(() => decodeScratchAdpcm(wav([0, 0, 0, 0, 0], { blockSize: 6 }))).toThrow();
    expect(pcm(decodeScratchAdpcm(wav([0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0], { blockSize: 6 })))).toEqual([0, 0, 0, 0, 0, 10, 10, 10]);
  });
  test('not WAV or PCM returns null', () => {
    expect(decodeScratchAdpcm(new ArrayBuffer(0))).toBeNull();
    const b = wav([0, 0, 0, 0, 0]); new DataView(b).setUint16(20, 1, true);
    expect(decodeScratchAdpcm(b)).toBeNull();
  });
  test('reject malformed headers, blocks, truncation and channels', () => {
    for (const b of [wav([0, 0, 89, 0, 0]), wav([0, 0, 0, 1, 0]), wav([0, 0, 0, 0, 0], { channels: 2 }), wav([0, 0, 0, 0, 0, 1, 2])]) {
      expect(() => decodeScratchAdpcm(b)).toThrow();
    }
    const b = wav([0, 0, 0, 0, 0]); new DataView(b).setUint32(44, 0xffffffff, true);
    expect(() => decodeScratchAdpcm(b)).toThrow();
    const broken = wav([0, 0, 0, 0, 0]); new DataView(broken).setUint16(38, 4, true);
    expect(() => decodeScratchAdpcm(broken)).toThrow();
  });
  test('reject oversized input before identifying format or scanning chunks', () => {
    const oversized = new ArrayBuffer(16 * 1024 * 1024 + 1);
    const bytes = new Uint8Array(oversized);
    bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
    expect(() => decodeScratchAdpcm(oversized)).toThrow('size limit');
    expect(() => decodeScratchAdpcm(new ArrayBuffer(16 * 1024 * 1024 + 1))).toThrow('size limit');
  });
  test('reject decoded output over four million samples without allocating', () => {
    const block = new Array(5).fill(0);
    const bytes = new Uint8Array(5 * 2_097_153);
    for (let i = 0; i < bytes.length; i += 5) bytes.set(block, i);
    expect(() => decodeScratchAdpcm(wav(bytes))).toThrow();
  });
  test('decodes all supported ADPCM assets in the bundled sound library', () => {
    const dir = new URL('../../editor/public/assets-scratch/sounds/', import.meta.url);
    let decoded = 0;
    for (const name of readdirSync(dir).filter(name => name.endsWith('.wav'))) {
      const buf = readFileSync(new URL(name, dir));
      const result = decodeScratchAdpcm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (result) {
        decoded++;
        expect(result.samples.length).toBeGreaterThan(0);
        expect(result.sampleRate).toBeGreaterThan(0);
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });
  test('real Scratch asset matches ffmpeg PCM through Scratch output length', () => {
    const path = '../../editor/public/assets-scratch/sounds/170e05c29d50918ae0b482c2955768c0.wav';
    const buf = readFileSync(new URL(path, import.meta.url));
    const decoded = decodeScratchAdpcm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))!;
    expect(decoded.samples.length).toBe(109729);
    const ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { input: buf, maxBuffer: 2_000_000 });
    if (ffmpeg.error && (ffmpeg.error as NodeJS.ErrnoException).code === 'ENOENT') return;
    expect(ffmpeg.status).toBe(0);
    const view = new DataView(ffmpeg.stdout.buffer, ffmpeg.stdout.byteOffset, ffmpeg.stdout.byteLength);
    expect(view.byteLength / 2).toBeGreaterThanOrEqual(decoded.samples.length);
    for (let i = 0; i < decoded.samples.length; i++) expect(decoded.samples[i] * 32768).toBe(view.getInt16(i * 2, true));
  });
});
