import { mount } from 'svelte'
import './app.css'
import Editor from './Editor.svelte'
import { createEditorContext, type EditorContext, type EditorContextTabElement } from './lib/editor-context'

export { createEditorContext, Editor }
export type { EditorContext, EditorContextTabElement }

export function renderEditor(target: HTMLElement, context: EditorContext = createEditorContext()) {
  return mount(Editor, {
    target,
    props: {
      context,
    },
  })
}
