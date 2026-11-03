import {
  WebAudioHost,
  type AudioHostContext,
  type PlaybackResult,
} from '../../xyo-cpp-wasm/src/web-audio-host'

// Mono PCM16: 80 ms of a quiet sine wave, generated without external assets.
function wav(): ArrayBuffer {
  const rate = 8000,
    samples = 640
  const data = new ArrayBuffer(44 + samples * 2),
    view = new DataView(data)
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, data.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.sin((i * 2 * Math.PI * 440) / rate) * 500, true)
  return data
}

export async function exerciseEffects() {
  const context = new AudioContext()
  let source!: AudioBufferSourceNode, panner!: StereoPannerNode
  const proxy: AudioHostContext = {
    destination: context.destination,
    decodeAudioData: (bytes) => context.decodeAudioData(bytes),
    createBufferSource: () => (source = context.createBufferSource()),
    createGain: () => context.createGain(),
    createStereoPanner: () => (panner = context.createStereoPanner()),
  }
  const reports: PlaybackResult[] = []
  const host = new WebAudioHost(1, proxy, (_g, _id, result) => reports.push(result))
  try {
    await context.resume()
    const started = host.start(1, 1n, wav(), 0.5, 120, -100)
    host.setEffects(1, 1n, -120, 50)
    const deadline = performance.now() + 5000
    while (!source && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1))
    const decoded = [source.playbackRate.value, panner.pan.value]
    const updated = host.setEffects(1, 1n, 360, 100)
    const active = [source.playbackRate.value, panner.pan.value]
    const stopped = host.stop(1, 1n)
    return { started, decoded, updated, active, stopped, reports }
  } finally {
    host.invalidate()
    await context.close()
  }
}

export async function exercise() {
  const context = new AudioContext()
  const reports: Array<[number, string, PlaybackResult]> = []
  const report = (generation: number, id: bigint, result: PlaybackResult) =>
    reports.push([generation, String(id), result])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let decoded!: () => void
  const decodeFinished = new Promise<void>((resolve) => {
    decoded = resolve
  })
  let sourceCount = 0
  const delayed: AudioHostContext = {
    destination: context.destination,
    async decodeAudioData(bytes) {
      const buffer = await context.decodeAudioData(bytes)
      decoded()
      await gate
      return buffer
    },
    createBufferSource() {
      sourceCount++
      return context.createBufferSource()
    },
    createGain() {
      return context.createGain()
    },
    createStereoPanner() {
      return context.createStereoPanner()
    },
  }
  try {
    await context.resume()
    const probe = await context.decodeAudioData(wav())
    const old = new WebAudioHost(1, delayed, report)
    const started = old.start(1, 1n, wav())
    await decodeFinished // actual Chrome decode has completed, delivery to host is held
    const stopped = old.stop(1, 1n)
    const duplicate = old.start(1, 1n, wav())
    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sourcesAfterStop = sourceCount
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let oldDecoded!: () => void
    const oldDecodeFinished = new Promise<void>((resolve) => {
      oldDecoded = resolve
    })
    const oldContext: AudioHostContext = {
      ...delayed,
      async decodeAudioData(bytes) {
        const buffer = await context.decodeAudioData(bytes)
        oldDecoded()
        await oldGate
        return buffer
      },
    }
    // A distinct old generation has a decode in flight when routing is invalidated.
    const obsolete = new WebAudioHost(3, oldContext, report)
    const obsoleteStarted = obsolete.start(3, 3n, wav())
    await oldDecodeFinished
    const invalidated = obsolete.invalidate()
    const oldStart = obsolete.start(3, 4n, wav())
    const oldStop = obsolete.stop(3, 3n)
    releaseOld()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sourcesAfterInvalidation = sourceCount
    old.invalidate()
    const current = new WebAudioHost(2, context, report)
    const wrongGeneration = current.start(1, 2n, wav())
    const currentStarted = current.start(2, 2n, wav())
    const deadline = performance.now() + 5000
    while (!reports.some((r) => r[0] === 2 && r[1] === '2') && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 100))
    current.invalidate()
    return {
      state: context.state,
      duration: probe.duration,
      started,
      stopped,
      duplicate,
      sourcesAfterStop,
      obsoleteStarted,
      invalidated,
      oldStart,
      oldStop,
      sourcesAfterInvalidation,
      wrongGeneration,
      currentStarted,
      reports,
    }
  } finally {
    await context.close()
  }
}
