import { describe, expect, it } from 'bun:test'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import { createEditorContext } from '../src/lib/editor-context'

describe('editor backend context', () => {
  it('creates an independent default VM and renderer pair per editor', () => {
    const first = createEditorContext()
    const second = createEditorContext()
    expect(first.backend?.vm).toBe(first.vm)
    expect(first.backend?.renderer).toBeInstanceOf(ScratchCanvasRenderer)
    expect(first.backend?.worker).toBe('scratch')
    expect(first.vm).not.toBe(second.vm)
    expect(first.backend?.renderer).not.toBe(second.backend?.renderer)
  })

  it('preserves the injected VM and renderer as one pair', () => {
    const backend = { vm: new ScratchVM(), renderer: new ScratchCanvasRenderer() }
    const context = createEditorContext({ backend })
    expect(context.backend).toBe(backend)
    expect(context.vm).toBe(backend.vm)
    expect(context.backend?.worker).toBeUndefined()
  })
})
