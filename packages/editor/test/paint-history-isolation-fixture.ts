// Test-only fixture: mounts the real Editor with a directly reachable VM so the
// browser test can read actual asset bytes (loadAsset/getSoundBuffer) without
// touching product code. The editor itself is unmodified (App/Editor carry the
// production history logic); only this fixture exposes its VM on window.
import { mount } from 'svelte'
import Editor from '../src/Editor.svelte'
import { createEditorContext } from '../src/lib/editor-context'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import '../src/app.css'

const vm = new ScratchVM()
const renderer = new ScratchCanvasRenderer()
const context = createEditorContext({ backend: { vm, renderer, worker: 'scratch' as const } })

;(window as unknown as Record<string, unknown>).__paintHistoryVm = vm
;(window as unknown as Record<string, unknown>).__paintHistoryContext = context

mount(Editor, { target: document.getElementById('app')!, props: { context } })
