import type { SoundEffect } from '../../lib/editor-types'

const IMA_ADPCM_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8]
const IMA_ADPCM_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]

export function transformWav(bytes: Uint8Array, effect: SoundEffect, trimStart = 0, trimEnd = 1, onStatus?: (message: string) => void) {
  if (bytes.length < 46 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') return bytes
  const range = soundSelectionByteRange(bytes, trimStart, trimEnd)
  const before = bytes.slice(44, range.start)
  const selected = bytes.slice(range.start, range.end)
  const after = bytes.slice(range.end)
  const editedSelection = transformWholeWav(wavWithSamples(bytes, selected), effect, onStatus).slice(44)
  return wavWithSamples(bytes, concatBytes(before, editedSelection, after))
}

export function transformWholeWav(bytes: Uint8Array, effect: SoundEffect, onStatus?: (message: string) => void) {
  if (effect === 'trim-start') return trimWav(bytes, 'start')
  if (effect === 'trim-end') return trimWav(bytes, 'end')
  if (effect === 'insert-silence') return appendSilence(bytes, 0.25)
  if (effect === 'faster') return resampleWav(bytes, 1.25)
  if (effect === 'slower') return resampleWav(bytes, 0.8)
  if (effect === 'echo') return echoWav(bytes)
  const output = new Uint8Array(bytes)
  const view = new DataView(output.buffer)
  const samples = Math.floor((output.length - 44) / 2)
  const values = Array.from({ length: samples }, (_, index) => view.getInt16(44 + index * 2, true))
  if (effect === 'reverse') values.reverse()
  const louderGain = effect === 'louder' ? safeLouderGain(values, onStatus) : 1
  for (let i = 0; i < values.length; i += 1) {
    let sample = values[i] ?? 0
    if (effect === 'mute') sample = 0
    if (effect === 'louder') sample *= louderGain
    if (effect === 'softer') sample *= 0.75
    if (effect === 'fade-in') sample *= i / Math.max(1, values.length - 1)
    if (effect === 'fade-out') sample *= 1 - i / Math.max(1, values.length - 1)
    if (effect === 'robot') sample = (i % 64 < 32 ? 1 : -1) * Math.abs(sample)
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample))), true)
  }
  return output
}

export function wavWithSamples(template: Uint8Array, samples: Uint8Array) {
  const output = new Uint8Array(44 + samples.length)
  output.set(template.slice(0, 44), 0)
  output.set(samples, 44)
  const view = new DataView(output.buffer)
  view.setUint32(4, 36 + samples.length, true)
  view.setUint32(40, samples.length, true)
  return output
}

export function soundSelectionByteRange(bytes: Uint8Array, trimStart = 0, trimEnd = 1) {
  const samples = Math.max(0, Math.floor((bytes.length - 44) / 2))
  const startPercent = Math.min(trimStart, trimEnd)
  const endPercent = Math.max(trimStart, trimEnd)
  const startSample = Math.max(0, Math.min(samples, Math.floor(samples * startPercent)))
  const endSample = Math.max(startSample, Math.min(samples, Math.ceil(samples * endPercent)))
  return {
    start: 44 + startSample * 2,
    end: 44 + Math.max(startSample + (endSample === startSample && samples > 0 ? 1 : 0), endSample) * 2,
  }
}

export function replaceSoundSelection(bytes: Uint8Array, insertSamples: Uint8Array, trimStart = 0, trimEnd = 1) {
  const range = soundSelectionByteRange(bytes, trimStart, trimEnd)
  return wavWithSamples(bytes, concatBytes(bytes.slice(44, range.start), insertSamples, bytes.slice(range.end)))
}

export function concatBytes(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

export function decodeImaAdpcmWav(bytes: Uint8Array): Uint8Array | undefined {
  const wav = parseWav(bytes)
  if (!wav || !wav.fmt || !wav.data) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const format = view.getUint16(wav.fmt.offset, true)
  const channels = view.getUint16(wav.fmt.offset + 2, true)
  const sampleRate = view.getUint32(wav.fmt.offset + 4, true)
  const blockAlign = view.getUint16(wav.fmt.offset + 12, true)
  if (format !== 17 || channels !== 1 || sampleRate <= 0 || blockAlign < 5) return undefined

  const factSamples = wav.fact && wav.fact.length >= 4 ? view.getUint32(wav.fact.offset, true) : undefined
  const samples: number[] = []
  const dataEnd = wav.data.offset + wav.data.length
  for (let blockOffset = wav.data.offset; blockOffset + 4 <= dataEnd; blockOffset += blockAlign) {
    let predictor = view.getInt16(blockOffset, true)
    let stepIndex = clampNumber(bytes[blockOffset + 2] ?? 0, 0, IMA_ADPCM_STEP_TABLE.length - 1)
    samples.push(predictor)
    const blockEnd = Math.min(dataEnd, blockOffset + blockAlign)
    for (let offset = blockOffset + 4; offset < blockEnd; offset += 1) {
      const packed = bytes[offset] ?? 0
      predictor = decodeImaNibble(packed & 0x0f, predictor, stepIndex)
      stepIndex = nextImaStepIndex(packed & 0x0f, stepIndex)
      samples.push(predictor)
      predictor = decodeImaNibble((packed >> 4) & 0x0f, predictor, stepIndex)
      stepIndex = nextImaStepIndex((packed >> 4) & 0x0f, stepIndex)
      samples.push(predictor)
      if (factSamples !== undefined && samples.length >= factSamples) return pcm16SamplesToWav(samples.slice(0, factSamples), sampleRate)
    }
  }
  return pcm16SamplesToWav(factSamples === undefined ? samples : samples.slice(0, factSamples), sampleRate)
}

export function wavPeaks(bytes: Uint8Array, count: number) {
  if (bytes.length < 46 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = Math.floor((bytes.length - 44) / 2)
  const bucket = Math.max(1, Math.floor(samples / count))
  return Array.from({ length: count }, (_, index) => {
    let peak = 0
    for (let i = index * bucket; i < Math.min(samples, (index + 1) * bucket); i += 1) {
      peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)) / 32768)
    }
    return peak
  })
}

function parseWav(bytes: Uint8Array) {
  if (bytes.length < 12 || fourCc(bytes, 0) !== 'RIFF' || fourCc(bytes, 8) !== 'WAVE') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Record<string, { offset: number; length: number } | undefined> = {}
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = fourCc(bytes, offset)
    const length = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    if (dataOffset + length > bytes.length) break
    chunks[id] ??= { offset: dataOffset, length }
    offset = dataOffset + length + (length % 2)
  }
  return { fmt: chunks['fmt '], fact: chunks.fact, data: chunks.data }
}

function fourCc(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0)
}

function decodeImaNibble(nibble: number, predictor: number, stepIndex: number) {
  const step = IMA_ADPCM_STEP_TABLE[stepIndex] ?? 7
  let delta = step >> 3
  if (nibble & 1) delta += step >> 2
  if (nibble & 2) delta += step >> 1
  if (nibble & 4) delta += step
  return clampNumber(predictor + (nibble & 8 ? -delta : delta), -32768, 32767)
}

function nextImaStepIndex(nibble: number, stepIndex: number) {
  return clampNumber(stepIndex + (IMA_ADPCM_INDEX_TABLE[nibble & 7] ?? -1), 0, IMA_ADPCM_STEP_TABLE.length - 1)
}

function pcm16SamplesToWav(samples: number[], sampleRate: number) {
  const output = new Uint8Array(44 + samples.length * 2)
  output.set([82, 73, 70, 70], 0)
  output.set([87, 65, 86, 69], 8)
  output.set([102, 109, 116, 32], 12)
  output.set([100, 97, 116, 97], 36)
  const view = new DataView(output.buffer)
  view.setUint32(4, output.length - 8, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index] ?? 0, true)
  return output
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function safeLouderGain(values: number[], onStatus?: (message: string) => void) {
  const peak = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  if (peak <= 0) return 1.25
  const desired = 1.25
  const safe = 32767 / peak
  if (safe < desired) onStatus?.('Sound louder limited to avoid clipping')
  return Math.max(1, Math.min(desired, safe))
}

function trimWav(bytes: Uint8Array, side: 'start' | 'end') {
  const sampleBytes = bytes.slice(44)
  const remove = Math.min(sampleBytes.length, 4410 * 2)
  const kept = side === 'start' ? sampleBytes.slice(remove) : sampleBytes.slice(0, sampleBytes.length - remove)
  return wavWithSamples(bytes, kept)
}

function appendSilence(bytes: Uint8Array, seconds: number) {
  const sampleRate = new DataView(bytes.buffer).getUint32(24, true) || 44100
  const silence = new Uint8Array(Math.floor(sampleRate * seconds) * 2)
  const merged = new Uint8Array(bytes.length - 44 + silence.length)
  merged.set(bytes.slice(44), 0)
  merged.set(silence, bytes.length - 44)
  return wavWithSamples(bytes, merged)
}

function resampleWav(bytes: Uint8Array, speed: number) {
  const sampleBytes = bytes.slice(44)
  const samples = Math.floor(sampleBytes.length / 2)
  const input = new DataView(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength)
  const outputSamples = Math.max(1, Math.floor(samples / speed))
  const output = new Uint8Array(outputSamples * 2)
  const view = new DataView(output.buffer)
  for (let i = 0; i < outputSamples; i += 1) {
    const source = Math.min(samples - 1, Math.floor(i * speed))
    view.setInt16(i * 2, input.getInt16(source * 2, true), true)
  }
  return wavWithSamples(bytes, output)
}

function echoWav(bytes: Uint8Array) {
  const sampleRate = new DataView(bytes.buffer).getUint32(24, true) || 44100
  const delay = Math.max(1, Math.floor(sampleRate * 0.18))
  const sampleBytes = bytes.slice(44)
  const samples = Math.floor(sampleBytes.length / 2)
  const input = new DataView(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength)
  const output = new Uint8Array((samples + delay) * 2)
  const view = new DataView(output.buffer)
  for (let i = 0; i < samples + delay; i += 1) {
    const dry = i < samples ? input.getInt16(i * 2, true) : 0
    const wet = i >= delay && i - delay < samples ? input.getInt16((i - delay) * 2, true) * 0.45 : 0
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(dry + wet))), true)
  }
  return wavWithSamples(bytes, output)
}
