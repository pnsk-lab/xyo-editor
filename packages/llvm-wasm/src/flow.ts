/** Green-flag orchestration for the in-browser LLVM backend (test-only).
 *
 * One function runs the whole admitted-project flow: admit the decoded
 * project, then compile the SB3 bytes to IR, link a side module, execute it
 * in the real xyo runtime, and read the variable back. Unadmitted projects
 * short-circuit to a no-execution fallback verdict. All runtime interaction
 * goes through injected stages so the orchestration itself is unit-testable
 * with fakes; the browser suite covers the real-artifact wiring.
 */
import { admitSb3Project } from './admission';

export interface GreenFlagSlot { kind: number; global: string; keyHex: string }
export interface GreenFlagMetadata { abiDescriptor: string; slots: GreenFlagSlot[] }
export interface GreenFlagFixture {
  name: string;
  /** Decoded project.json for admission (raw SB3 bytes still go to the compiler). */
  project: unknown;
  /** SB3 bytes consumed by the real compiler. */
  compileInput: Uint8Array;
  exports: string[];
}
export interface GreenFlagVariable { id: string; valueHex: string; units: number[] | null }
export type GreenFlagResult =
  | { ok: true; route: 'llvm'; metadata: GreenFlagMetadata; variables: GreenFlagVariable[] }
  | { ok: true; route: 'fallback'; reason: string }
  | { ok: false; error: string };

export interface GreenFlagStages {
  compile(input: Uint8Array): Promise<{ ir: string; metadata: GreenFlagMetadata }>;
  link(ir: string, exports: string[]): Promise<Uint8Array>;
  execute(input: { sb3: Uint8Array; side: Uint8Array; abiDescriptor: string; slots: GreenFlagSlot[] }): Promise<{ variables: GreenFlagVariable[] }>;
}

export async function runGreenFlagFlow(fixture: GreenFlagFixture, stages: GreenFlagStages): Promise<GreenFlagResult> {
  const admission = admitSb3Project(fixture.project);
  if (admission.route !== 'llvm') return { ok: true, route: 'fallback', reason: admission.reason };
  try {
    const { ir, metadata } = await stages.compile(fixture.compileInput);
    const side = await stages.link(ir, fixture.exports);
    const { variables } = await stages.execute({
      sb3: fixture.compileInput, side, abiDescriptor: metadata.abiDescriptor, slots: metadata.slots,
    });
    return { ok: true, route: 'llvm', metadata, variables };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack ?? String(error) : String(error) };
  }
}
