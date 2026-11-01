import { describe, expect, it } from 'bun:test'
import { extractSoundSelection, selectionAfterTransform, transformWav, wavWithSamples } from '../src/features/sounds/wav'

function wav(samples: number) {
  const header = new Uint8Array(44)
  header.set([82, 73, 70, 70])
  return wavWithSamples(header, new Uint8Array(samples * 2))
}

describe('sound selection playback', () => {
  it('extracts only the selected samples and updates the WAV header', () => {
    const original = wav(10)
    const samples = new DataView(original.buffer)
    for (let i = 0; i < 10; i++) samples.setInt16(44 + i * 2, i + 1, true)
    const selected = extractSoundSelection(original, 0.2, 0.6)
    const view = new DataView(selected.buffer)
    expect(selected.length).toBe(52)
    expect(view.getUint32(40, true)).toBe(8)
    expect(Array.from({ length: 4 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([3, 4, 5, 6])
    expect(extractSoundSelection(original)).toEqual(original)
  })
})

describe('sound selection after effects', () => {
  it('preserves the selected samples for unchanged and shorter effects', () => {
    const original = wav(100)
    const louder = transformWav(original, 'louder', 0.2, 0.6)
    expect(selectionAfterTransform(original, louder, 0.2, 0.6)).toEqual({ start: 0.2, end: 0.6 })
    const faster = transformWav(original, 'faster', 0.2, 0.6)
    const selection = selectionAfterTransform(original, faster, 0.2, 0.6)
    expect(selection.start).toBeCloseTo(20 / 92)
    expect(selection.end).toBeCloseTo(52 / 92)
  })

  it('preserves the transformed selection when it becomes longer', () => {
    const original = wav(100)
    const slower = transformWav(original, 'slower', 0.2, 0.6)
    const selection = selectionAfterTransform(original, slower, 0.2, 0.6)
    expect(selection.start).toBeCloseTo(20 / 110)
    expect(selection.end).toBeCloseTo(70 / 110)
  })
})
