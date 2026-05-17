import { mount } from 'svelte'
import './app.css'
import Editor from './Editor.svelte'
import { createEditorContext, type EditorContext, type EditorContextTab, type EditorHeaderButton, type EditorHeaderConfig, type EditorHeaderLogo } from './lib/editor-context'

export { createEditorContext, Editor }
export type { EditorContext, EditorContextTab, EditorHeaderButton, EditorHeaderConfig, EditorHeaderLogo }

export function renderEditor(target: HTMLElement, context: EditorContext = createEditorContext()) {
  return mount(Editor, {
    target,
    props: {
      context,
    },
  })
}
