// Test-only fixture: mounts the real production Editor with a directly
// reachable VM so the browser test can read actual asset bytes
// (loadAsset/getCostumeIdentity) and drive renames through the real VM API.
// Product code is untouched; only this fixture exposes its VM on window.
// All "external" writes in tests go through vm.updateCostume /
// vm.updateCostumeIfMatch / vm.renameCostume (public API) — never by mutating
// plain project objects.
import { mount } from 'svelte'
import Editor from '../src/Editor.svelte'
import { createEditorContext } from '../src/lib/editor-context'
import { ScratchCanvasRenderer, ScratchVM } from '@hikkaku/vm'
import '../src/app.css'

const vm = new ScratchVM()
const renderer = new ScratchCanvasRenderer()
const context = createEditorContext({ backend: { vm, renderer, worker: 'scratch' as const } })

;(window as unknown as Record<string, unknown>).__paintHistoryVm = vm
;(window as unknown as Record<string, unknown>).__paintHistoryRenameVm = vm
;(window as unknown as Record<string, unknown>).__paintHistoryContext = context

mount(Editor, { target: document.getElementById('app')!, props: { context } })
