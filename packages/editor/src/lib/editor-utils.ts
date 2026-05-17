export function blockLabel(opcode: string) {
  return opcode.replace(/_/g, ' ')
}

export function fileExtension(name: string) {
  return name.split('.').pop()?.toLowerCase()
}

export function mimeFromFilename(name: string) {
  const extension = fileExtension(name)
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'bmp') return 'image/bmp'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'sprite3' || extension === 'sb3') return 'application/zip'
  return ''
}

export function isImageFile(file: File) {
  return /^image\//.test(file.type) || ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(fileExtension(file.name) ?? '')
}

export function assetBytes(data: string | Uint8Array | undefined) {
  if (data instanceof Uint8Array) return new Uint8Array(data)
  return new TextEncoder().encode(data ?? '')
}

export function makeToneWav(frequency = 440) {
  const sampleRate = 44100
  const sampleCount = 4410
  const data = new Uint8Array(44 + sampleCount * 2)
  const view = new DataView(data.buffer)
  writeAscii(data, 0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeAscii(data, 8, 'WAVE')
  writeAscii(data, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(data, 36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.sin((i / sampleRate) * Math.PI * 2 * frequency) * 0x4fff
    view.setInt16(44 + i * 2, sample, true)
  }
  return data
}

export function mergeFloatSamples(chunks: Float32Array[]) {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export function floatSamplesToWav(samples: Float32Array, sampleRate: number) {
  const data = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(data.buffer)
  writeAscii(data, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(data, 8, 'WAVE')
  writeAscii(data, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(data, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return data
}

export function writeAscii(data: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) data[offset + i] = value.charCodeAt(i)
}

export function librarySvg(shape: string, color: string, width = 96, height = 96) {
  const body =
    shape === 'square'
      ? `<rect x="14" y="14" width="68" height="68" rx="8" fill="${color}" stroke="#0f172a" stroke-width="4"/>`
      : shape === 'star'
        ? `<path d="M48 8 L58 36 L88 36 L64 54 L74 84 L48 66 L22 84 L32 54 L8 36 L38 36 Z" fill="${color}" stroke="#0f172a" stroke-width="4" stroke-linejoin="round"/>`
        : shape === 'heart'
          ? `<path d="M48 84 C20 62 10 48 14 30 C18 12 40 12 48 28 C56 12 78 12 82 30 C86 48 76 62 48 84 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/>`
          : shape === 'robot'
            ? `<rect x="22" y="24" width="52" height="48" rx="8" fill="${color}" stroke="#0f172a" stroke-width="4"/><circle cx="38" cy="44" r="5" fill="#fff"/><circle cx="58" cy="44" r="5" fill="#fff"/><path d="M36 60 H60" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M48 24 V12" stroke="#0f172a" stroke-width="4"/><circle cx="48" cy="10" r="4" fill="#ff6680"/>`
            : shape === 'rocket'
              ? `<path d="M48 8 C66 24 70 48 58 82 H38 C26 48 30 24 48 8 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/><circle cx="48" cy="38" r="9" fill="#fff" stroke="#0f172a" stroke-width="3"/><path d="M38 78 L28 90 L42 84 M58 78 L68 90 L54 84" stroke="#0f172a" stroke-width="4" fill="none"/><path d="M42 84 L48 94 L54 84" fill="#ffab19"/>`
              : shape === 'dancer'
                ? `<circle cx="48" cy="18" r="10" fill="${color}" stroke="#0f172a" stroke-width="4"/><path d="M48 30 V58 M28 42 H68 M48 58 L28 82 M48 58 L70 78" stroke="${color}" stroke-width="10" stroke-linecap="round"/><path d="M48 30 V58 M28 42 H68 M48 58 L28 82 M48 58 L70 78" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>`
                : shape === 'fish'
                  ? `<path d="M14 48 C30 24 62 24 78 48 C62 72 30 72 14 48 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/><path d="M78 48 L92 32 V64 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/><circle cx="34" cy="42" r="4" fill="#0f172a"/>`
                  : shape === 'tree'
                    ? `<path d="M48 18 L18 58 H36 L24 78 H72 L60 58 H78 Z" fill="${color}" stroke="#0f172a" stroke-width="4" stroke-linejoin="round"/><rect x="42" y="72" width="12" height="18" fill="#8a4b10" stroke="#0f172a" stroke-width="3"/>`
                    : shape === 'cloud'
                      ? `<path d="M25 64 H74 A14 14 0 0 0 74 36 A20 20 0 0 0 36 32 A17 17 0 0 0 25 64 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/>`
                      : shape === 'bolt'
                        ? `<path d="M55 6 L20 54 H43 L35 90 L78 38 H52 Z" fill="${color}" stroke="#0f172a" stroke-width="4" stroke-linejoin="round"/>`
                        : shape === 'flower'
                          ? `<circle cx="48" cy="48" r="9" fill="#ffbf00" stroke="#0f172a" stroke-width="3"/><g fill="${color}" stroke="#0f172a" stroke-width="3"><ellipse cx="48" cy="22" rx="10" ry="18"/><ellipse cx="48" cy="74" rx="10" ry="18"/><ellipse cx="22" cy="48" rx="18" ry="10"/><ellipse cx="74" cy="48" rx="18" ry="10"/></g>`
                          : shape === 'moon'
                            ? `<path d="M66 12 C44 18 30 36 30 56 C30 74 44 88 66 92 C54 78 52 26 66 12 Z" fill="${color}" stroke="#0f172a" stroke-width="4"/>`
                            : shape === 'cat'
                              ? `<path d="M20 76 L26 24 L38 36 Q48 28 58 36 L70 24 L76 76 Z" fill="${color}" stroke="#8a4b10" stroke-width="4" stroke-linejoin="round"/><circle cx="38" cy="52" r="4" fill="#0f172a"/><circle cx="58" cy="52" r="4" fill="#0f172a"/><path d="M45 62 Q48 66 51 62" stroke="#0f172a" stroke-width="3" fill="none"/>`
                              : `<circle cx="48" cy="48" r="36" fill="${color}" stroke="#0f172a" stroke-width="4"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 96 96">${body}</svg>`
}

export function bytesToLocalBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function localBase64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char)
}

export function hexToRgb(value: string) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  return match ? { r: Number.parseInt(match[1]!, 16), g: Number.parseInt(match[2]!, 16), b: Number.parseInt(match[3]!, 16) } : undefined
}

export function shadeHex(value: string, delta: number) {
  const rgb = hexToRgb(value)
  if (!rgb) return value
  const clamp = (channel: number) => Math.max(0, Math.min(255, channel + delta))
  return `#${[clamp(rgb.r), clamp(rgb.g), clamp(rgb.b)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function colorDistance(a: number[], b: number[]) {
  return Math.abs((a[0] ?? 0) - (b[0] ?? 0)) + Math.abs((a[1] ?? 0) - (b[1] ?? 0)) + Math.abs((a[2] ?? 0) - (b[2] ?? 0)) + Math.abs((a[3] ?? 255) - (b[3] ?? 255))
}

