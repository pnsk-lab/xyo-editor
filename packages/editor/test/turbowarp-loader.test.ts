import { afterEach, describe, expect, it } from 'bun:test'
import { loadTurboWarpScaffolding, TURBOWARP_SCAFFOLDING_URL } from '../src/lib/turbowarp-loader'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function restore(name: 'window' | 'document', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

afterEach(() => {
  restore('window', originalWindow)
  restore('document', originalDocument)
})

function browser() {
  const scripts: Array<{
    src: string
    async: boolean
    onload: (() => void) | null
    onerror: (() => void) | null
    removed: boolean
    remove(): void
  }> = []
  const win: { Scaffolding?: unknown } = {}
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        src: '',
        async: false,
        onload: null,
        onerror: null,
        removed: false,
        remove() {
          this.removed = true
        },
      }),
      head: {
        appendChild: (script: (typeof scripts)[number]) => {
          scripts.push(script)
        },
      },
    },
  })
  return { win, scripts }
}

const validNamespace = { Scaffolding: class {}, VM: class {}, Renderer: class {} }

describe('TurboWarp Scaffolding loader', () => {
  it('rejects outside a browser', async () => {
    await expect(loadTurboWarpScaffolding()).rejects.toThrow('browser')
  })

  it('rejects malformed preexisting namespaces and accepts a valid one', async () => {
    const { win, scripts } = browser()
    for (const invalid of [null, {}, { Scaffolding: class {}, VM: class {}, Renderer: 1 }]) {
      win.Scaffolding = invalid
      await expect(loadTurboWarpScaffolding()).rejects.toThrow('invalid')
    }
    win.Scaffolding = validNamespace
    expect(await loadTurboWarpScaffolding()).toBe(validNamespace)
    expect(scripts).toHaveLength(0)
  })

  it('shares an in-flight request and retries network and validation failures', async () => {
    const { win, scripts } = browser()
    const first = loadTurboWarpScaffolding()
    expect(loadTurboWarpScaffolding()).toBe(first)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe(TURBOWARP_SCAFFOLDING_URL)
    expect(scripts[0].async).toBe(true)
    scripts[0].onerror?.()
    await expect(first).rejects.toThrow('Failed to load')
    expect(scripts[0].removed).toBe(true)

    const second = loadTurboWarpScaffolding()
    scripts[1].onload?.()
    await expect(second).rejects.toThrow('invalid')
    expect(scripts[1].removed).toBe(true)

    const third = loadTurboWarpScaffolding()
    win.Scaffolding = validNamespace
    scripts[2].onload?.()
    expect(await third).toBe(validNamespace)
    expect(await loadTurboWarpScaffolding()).toBe(validNamespace)
    expect(scripts).toHaveLength(3)
  })
})
