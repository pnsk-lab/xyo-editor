import { turboWarpRegistration } from '../register-turbowarp'
import type { XyoPlugin } from './types'

/**
 * Registers the TurboWarp scaffolding backend. The distribution itself is only
 * fetched when the backend is selected, so this stays inexpensive at startup.
 */
export const turboWarpPlugin: XyoPlugin = {
  manifest: {
    id: 'turbowarp',
    name: 'TurboWarp',
    version: '1.0.0',
    author: 'xyo-editor',
    description:
      'TurboWarp ランタイムを「設定 → ランタイム」に追加します。公式 Packager Scaffolding を必要時に読み込みます。',
  },
  activate({ runtimes }) {
    runtimes.register(turboWarpRegistration)
  },
}
