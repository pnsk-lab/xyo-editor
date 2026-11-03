import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Repository root (packages/editor/test -> ../../..). */
export const repoRoot = join(import.meta.dir, '..', '..', '..')

/** Locally built xyo-cpp Wasm artifacts. Never committed: see xyO-cpp-wasm/README.md. */
export const xyoWasmBuild = join(repoRoot, 'packages', 'xyo-cpp-wasm', '.work', 'build-wasm')
export const xyoPenBuild = join(
  repoRoot,
  'packages',
  'xyo-cpp-wasm',
  '.work',
  'pen-validation-latest',
)
export const llvmWasmWork = join(repoRoot, 'packages', 'llvm-wasm', '.work')
export const llvmUnifiedBuild = join(llvmWasmWork, 'unified-build')
export const llvmPublicArtifacts = join(repoRoot, 'packages', 'editor', 'public', 'llvm-artifacts')

export const hasXyoWasm = (): boolean =>
  existsSync(join(xyoWasmBuild, 'xyo-browser.js')) &&
  existsSync(join(xyoWasmBuild, 'xyo-browser.wasm'))

export const hasXyoEsm = (): boolean =>
  existsSync(join(xyoWasmBuild, 'xyo-browser-esm.mjs')) &&
  existsSync(join(xyoWasmBuild, 'xyo-browser-esm.wasm'))

export const hasXyoPen = (): boolean =>
  existsSync(join(xyoPenBuild, 'pen-browser.mjs')) &&
  existsSync(join(xyoPenBuild, 'pen-browser.wasm'))

export const hasUnifiedRuntime = (): boolean =>
  existsSync(join(llvmUnifiedBuild, 'unified_runtime.wasm'))

export const hasPackedLlvmArtifacts = (): boolean =>
  existsSync(join(llvmPublicArtifacts, 'xyo_browser_ir.wasm'))

/**
 * Opt-in gates stay explicit (`XYO_*_BROWSER=1`) but also fail closed when the
 * artifacts they need are absent, instead of failing with ENOENT.
 */
export function optIn(flag: string, artifactsAvailable: () => boolean): boolean {
  return process.env[flag] === '1' && artifactsAvailable()
}
