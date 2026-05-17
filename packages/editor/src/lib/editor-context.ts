import { ScratchVM, type VirtualMachine } from '@hikkaku/vm'

export type EditorHeaderButton = {
  label?: string
  ariaLabel?: string
  href?: string
  target?: string
  rel?: string
  hidden?: boolean
  element?: Element
  onClick?: (event: MouseEvent) => void
}

export type EditorHeaderLogo = {
  label?: string
  title?: string
  href?: string
  target?: string
  rel?: string
  element?: Element
  onClick?: (event: MouseEvent) => void
}

export type EditorHeaderConfig = {
  logo?: EditorHeaderLogo
  signUp?: EditorHeaderButton
  signIn?: EditorHeaderButton
  authSlot?: Element
}

export type EditorContextTab = {
  id?: string
  icon: Element
  label: string
  content: Element
  order?: number
}

export interface EditorContext {
  vm: VirtualMachine
  header?: EditorHeaderConfig
  tabs?: EditorContextTab[]
  addTab?: (tab: EditorContextTab) => () => void
  subscribeTabs?: (listener: (tabs: EditorContextTab[]) => void) => () => void
  setHeader?: (header: EditorHeaderConfig) => void
  updateHeader?: (patch: EditorHeaderConfig) => void
  subscribeHeader?: (listener: (header: EditorHeaderConfig) => void) => () => void
}

export function createEditorContext(options: { header?: EditorHeaderConfig } = {}): EditorContext {
  const tabs: EditorContextTab[] = []
  const tabListeners = new Set<(tabs: EditorContextTab[]) => void>()
  const headerListeners = new Set<(header: EditorHeaderConfig) => void>()
  let header = options.header ?? {}
  const notifyTabListeners = () => {
    const entries = [...tabs]
    for (const listener of tabListeners) listener(entries)
  }
  const notifyHeaderListeners = () => {
    const nextHeader = { ...header }
    for (const listener of headerListeners) listener(nextHeader)
  }

  return {
    vm: new ScratchVM(),
    get header() {
      return header
    },
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
    setHeader(nextHeader) {
      header = nextHeader
      notifyHeaderListeners()
    },
    updateHeader(patch) {
      header = { ...header, ...patch }
      notifyHeaderListeners()
    },
    subscribeHeader(listener) {
      headerListeners.add(listener)
      listener({ ...header })
      return () => headerListeners.delete(listener)
    },
  }
}
