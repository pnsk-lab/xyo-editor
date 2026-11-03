// Scratch's legacy WAV fallback is mono IMA/DVI ADPCM, not Microsoft ADPCM.
// See https://github.com/scratchfoundation/scratch-audio/blob/develop/src/ADPCMSoundDecoder.js
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 4 * 1024 * 1024;

/** Decode Scratch's mono IMA ADPCM WAV; return null for other formats.
 * Recognized but malformed or unsupported ADPCM throws. The sample count intentionally
 * matches scratch-audio, which ignores the WAV fact count and truncates the tail of
 * multiblock sounds. Partial blocks are accepted only if their complete header exists
 * and Scratch's output count does not exceed the actual decodable samples. Inputs over
 * 16 MiB throw before format identification. This is not a general purpose WAV decoder.
 */
export function decodeScratchAdpcm(input: ArrayBuffer): { sampleRate: number; samples: Float32Array } | null {
  const v = new DataView(input);
  const length = v.byteLength;
  // Limit work before format identification and the chunk scan.
  if (length > MAX_INPUT_BYTES) throw new Error('Scratch ADPCM input exceeds size limit');
  const tag = (offset: number, text: string): boolean =>
    offset + text.length <= length && [...text].every((c, i) => v.getUint8(offset + i) === c.charCodeAt(0));
  if (length < 12 || !tag(0, 'RIFF') || !tag(8, 'WAVE')) return null;
  let fmt = -1, fmtSize = 0, data = -1, dataSize = 0;
  let recognized = false, invalid = false, facts = 0;
  // Scan only within the actual buffer, never an untrusted declared chunk length.
  for (let p = 12; p < length;) {
    if (length - p < 8) { invalid = true; break; }
    const size = v.getUint32(p + 4, true);
    const start = p + 8;
    if (tag(p, 'fmt ')) {
      if (fmt !== -1) invalid = true;
      else { fmt = start; fmtSize = size; }
      if (size >= 2 && start + 2 <= length && v.getUint16(start, true) === 0x11) recognized = true;
    } else if (tag(p, 'data')) {
      if (data !== -1) invalid = true;
      else { data = start; dataSize = size; }
    } else if (tag(p, 'fact')) {
      if (++facts > 1 || size < 4) invalid = true;
    }
    const end = start + size;
    const next = end + (size & 1);
    if (end > length || next > length) { invalid = true; break; }
    p = next;
  }
  if (!recognized) return null;
  const fail = (): never => { throw new Error('Invalid or unsupported Scratch ADPCM WAV'); };
  if (invalid || v.getUint32(4, true) + 8 !== length ||
      fmt < 0 || fmtSize < 20 || fmt + fmtSize > length || data < 0 || dataSize === 0) fail();
  const channels = v.getUint16(fmt + 2, true);
  const sampleRate = v.getUint32(fmt + 4, true);
  const blockSize = v.getUint16(fmt + 12, true);
  const bits = v.getUint16(fmt + 14, true);
  const extra = v.getUint16(fmt + 16, true);
  const samplesPerBlock = v.getUint16(fmt + 18, true);
  if (channels !== 1 || sampleRate === 0 || sampleRate > 192000 || bits !== 4 ||
      extra < 2 || extra + 18 > fmtSize || blockSize < 5 ||
      samplesPerBlock !== (blockSize - 4) * 2 + 1) fail();
  const fullBlocks = Math.floor(dataSize / blockSize);
  const remainder = dataSize % blockSize;
  if (remainder > 0 && remainder < 4) fail();
  const sampleCount = fullBlocks * (samplesPerBlock - 1) + 1 +
    (remainder ? (remainder - 4) * 2 + 1 : 0);
  const availableSamples = fullBlocks * samplesPerBlock + (remainder ? 1 + (remainder - 4) * 2 : 0);
  if (sampleCount > MAX_SAMPLES || sampleCount > availableSamples) fail();
  // Validate every block even if Scratch's historical count truncates the output.
  for (let p = data; p < data + dataSize; p += blockSize) {
    if (v.getUint8(p + 2) > 88 || v.getUint8(p + 3) !== 0) fail();
  }
  const samples = new Float32Array(sampleCount);
  let out = 0;
  for (let p = data; p < data + dataSize && out < sampleCount; p += blockSize) {
    let sample = v.getInt16(p, true);
    let index = v.getUint8(p + 2);
    samples[out++] = sample / 32768;
    const end = Math.min(p + blockSize, data + dataSize);
    for (let j = p + 4; j < end && out < sampleCount; j++) {
      const byte = v.getUint8(j);
      for (let shift = 0; shift <= 4 && out < sampleCount; shift += 4) {
        const code = (byte >> shift) & 15;
        const step = STEPS[index];
        let delta = (step >> 3) + ((code & 1) ? step >> 2 : 0) +
          ((code & 2) ? step >> 1 : 0) + ((code & 4) ? step : 0);
        if (code & 8) delta = -delta;
        sample = Math.max(-32768, Math.min(32767, sample + delta));
        index = Math.max(0, Math.min(88, index + INDEX[code]));
        samples[out++] = sample / 32768;
      }
    }
  }
  return { sampleRate, samples };
}
