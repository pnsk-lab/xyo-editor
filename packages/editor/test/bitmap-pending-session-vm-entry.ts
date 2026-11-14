// Test-only browser entry for the pending-session fixture.
//
// `page.evaluate` dynamic `import('@hikkaku/vm')` fails in the browser (bare
// specifiers have no runtime resolver); static imports inside a Vite-served
// file ARE resolved at transform time (the app itself imports the VM in
// `src/lib/*`). This entry re-exports the live VM constructors so the
// fixture can `import('/test/bitmap-pending-session-vm-entry.ts')` and drive
// the REAL `ScratchVM` against a REAL canvas. No product code depends on it.
export { ScratchVM, createDefaultProject } from '@hikkaku/vm'
