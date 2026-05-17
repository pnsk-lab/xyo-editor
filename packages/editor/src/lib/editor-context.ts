import { ScratchVM, type VirtualMachine } from '@hikkaku/vm'

export type EditorContextTab = {
  id?: string
  icon: Element
  label: string
  content: Element
  order?: number
}

export interface EditorContext {
  vm: VirtualMachine
  tabs?: EditorContextTab[]
  addTab?: (tab: EditorContextTab) => () => void
  subscribeTabs?: (listener: (tabs: EditorContextTab[]) => void) => () => void
}

export function createEditorContext(): EditorContext {
  const tabs: EditorContextTab[] = []
  const tabListeners = new Set<(tabs: EditorContextTab[]) => void>()
  const notifyTabListeners = () => {
    const entries = [...tabs]
    for (const listener of tabListeners) listener(entries)
  }

  return {
    vm: new ScratchVM(),
    tabs,
    addTab(tab) {
      tabs.push(tab)
      notifyTabListeners()
      return () => {
        const index = tabs.indexOf(tab)
        if (index >= 0) {
          tabs.splice(index, 1)
          notifyTabListeners()
        }
      }
    },
    subscribeTabs(listener) {
      tabListeners.add(listener)
      listener([...tabs])
      return () => tabListeners.delete(listener)
    },
  }
}
