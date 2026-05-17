import { ScratchVM, type VirtualMachine } from '@hikkaku/vm'

export type EditorContextTabElement =
  | Element
  | {
      element: Element
      order?: number
    }

export interface EditorContext {
  vm: VirtualMachine
  tabElements?: EditorContextTabElement[]
  addTabElement?: (entry: EditorContextTabElement) => () => void
  subscribeTabElements?: (listener: (entries: EditorContextTabElement[]) => void) => () => void
}

export function createEditorContext(): EditorContext {
  const tabElements: EditorContextTabElement[] = []
  const tabElementListeners = new Set<(entries: EditorContextTabElement[]) => void>()
  const notifyTabElementListeners = () => {
    const entries = [...tabElements]
    for (const listener of tabElementListeners) listener(entries)
  }

  return {
    vm: new ScratchVM(),
    tabElements,
    addTabElement(entry) {
      tabElements.push(entry)
      notifyTabElementListeners()
      return () => {
        const index = tabElements.indexOf(entry)
        if (index >= 0) {
          tabElements.splice(index, 1)
          notifyTabElementListeners()
        }
      }
    },
    subscribeTabElements(listener) {
      tabElementListeners.add(listener)
      listener([...tabElements])
      return () => tabElementListeners.delete(listener)
    },
  }
}
