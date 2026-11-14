import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Optional upstream paint reference oracle (local-only, never vendored).
//
// `.tmp/scratch-editor` is a LOCAL-ONLY checkout of the upstream AGPL paint
// reference used as a read-only source oracle by some `*.test.ts` suites.
// It lives under `.tmp/` (git-ignored), so clean clones — including Draft-PR
// checkouts and CI — do NOT have it, and unit tests must stay green there.
//
// Rules for reference-oracle tests (AGPL hygiene):
// - NEVER copy reference source into this repo. Read-only `toContain` pins
//   on source text only, and only when the checkout exists.
// - NEVER silently hardcode reference truth as a substitute. When the
//   checkout is absent, skip the source-dependent assertions with
//   `it.skipIf` / `describe.skipIf` (visible `(skip)` entries) instead of
//   baking values in.
// - Independent product checks in the same file MUST keep running: split
//   mixed tests so the product half always runs and only the reference half
//   skips. Reference pins are preserved verbatim and re-activate
//   automatically whenever the checkout is present.
//
// To enable the oracle locally: clone the upstream paint repo to
// `<repo-root>/.tmp/scratch-editor` (untracked, git-ignored) and re-run
// `pnpm --filter xyo-editor test:unit` — skipped oracle tests run again
// with no code changes.
export const SCRATCH_REFERENCE_DIR = join(
  import.meta.dir,
  '../../../.tmp/scratch-editor/packages/scratch-paint',
)

export const SCRATCH_REFERENCE_SKIP_REASON =
  'optional AGPL reference checkout `.tmp/scratch-editor` is absent: ' +
  'source-oracle assertions skip, independent product checks still run'

/** Sync collection-time probe (safe to call at module top for skipIf). */
export function hasScratchReference(): boolean {
  return existsSync(join(SCRATCH_REFERENCE_DIR, 'src/helper/view.js'))
}

/**
 * Lazy conditional read: returns the file text when the reference checkout
 * exists, otherwise `undefined` (never throws ENOENT). Use for module-top
 * reads so the file loads on clean clones; pair with skipIf for the
 * assertions that consume the text.
 */
export async function readScratchReference(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  return await file.text()
}
