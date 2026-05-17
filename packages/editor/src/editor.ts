import { mount } from 'svelte'
import './app.css'
import Editor from './Editor.svelte'
import { createEditorContext, type EditorContext, type EditorContextTab } from './lib/editor-context'

export { createEditorContext, Editor }
export type { EditorContext, EditorContextTab }

export function renderEditor(target: HTMLElement, context: EditorContext = createEditorContext()) {
  return mount(Editor, {
    target,
    props: {
      context,
    },
  })
}
