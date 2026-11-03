import type { TurboWarpScaffoldingNamespace } from './turbowarp-adapter'

/** The Scaffolding API is unstable, so never use an unversioned URL. */
export const TURBOWARP_SCAFFOLDING_URL = 'https://cdn.jsdelivr.net/npm/@turbowarp/packager@3.14.0/dist/scaffolding/scaffolding-full.js'

let pending: Promise<TurboWarpScaffoldingNamespace> | undefined

function validateNamespace(value: unknown): TurboWarpScaffoldingNamespace {
  if (typeof value !== 'object' || value === null ||
      !('Scaffolding' in value) || typeof value.Scaffolding !== 'function' ||
      !('VM' in value) || typeof value.VM !== 'function' ||
      !('Renderer' in value) || typeof value.Renderer !== 'function') {
    throw new Error('TurboWarp Scaffolding namespace is missing or invalid')
  }
  return value as TurboWarpScaffoldingNamespace
}

/** Load the official browser-only distribution once, sharing concurrent requests.
 * An existing window.Scaffolding is reused after validation; its version cannot
 * be determined here, so hosts that supply it must pin it themselves.
 */
export function loadTurboWarpScaffolding(): Promise<TurboWarpScaffoldingNamespace> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('TurboWarp Scaffolding can only be loaded in a browser'))
  }
  if (pending) return pending

  const browserWindow = window as Window & { Scaffolding?: unknown }
  if (browserWindow.Scaffolding !== undefined) {
    try {
      return Promise.resolve(validateNamespace(browserWindow.Scaffolding))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const script = document.createElement('script')
  script.src = TURBOWARP_SCAFFOLDING_URL
  script.async = true
  const attempt = new Promise<TurboWarpScaffoldingNamespace>((resolve, reject) => {
    const cleanup = () => {
      script.onload = null
      script.onerror = null
    }
    script.onload = () => {
      cleanup()
      try {
        resolve(validateNamespace(browserWindow.Scaffolding))
      } catch (error) {
        script.remove()
        reject(error)
      }
    }
    script.onerror = () => {
      cleanup()
      script.remove()
      reject(new Error('Failed to load TurboWarp Scaffolding script'))
    }
    try {
      document.head.appendChild(script)
    } catch (error) {
      cleanup()
      script.remove()
      reject(error)
    }
  })
  pending = attempt.catch((error: unknown) => {
    pending = undefined
    throw error
  })
  return pending
}
