import { describe, expect, test } from 'bun:test';
import { runGreenFlagFlow, type GreenFlagFixture, type GreenFlagStages } from '../src/flow';

// Orchestration only: every runtime stage is a fake. The real-artifact wiring
// is covered by the editor-owned browser suite.
function admittedFixture(): GreenFlagFixture {
  return {
    name: 'valid',
    project: {
      targets: [{
        isStage: true, name: 'Stage', variables: { v: ['v', 0] }, lists: {}, broadcasts: {},
        blocks: {
          hat: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true },
          set: { opcode: 'data_setvariableto', next: null, parent: 'hat', inputs: { VALUE: [1, [4, '42']] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false },
        }, costumes: [], sounds: [], currentCostume: 0,
      }],
      monitors: [], extensions: [], meta: { semver: '3.0.0' },
    },
    compileInput: new Uint8Array([80, 75, 3, 4]),
    exports: ['xyo_browser_script'],
  };
}
function trackingStages(): GreenFlagStages & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    compile: async input => {
      calls.push(`compile:${input.length}`);
      return { ir: 'ir', metadata: { abiDescriptor: 'abi', slots: [{ kind: 0, global: 'g', keyHex: '76' }] } };
    },
    link: async (ir, exports) => {
      calls.push(`link:${ir}:${exports.length}`);
      return new Uint8Array([0, 97, 115, 109]);
    },
    execute: async input => {
      calls.push(`execute:${input.sb3.length}:${input.side.length}:${input.abiDescriptor}`);
      return { variables: [{ id: 'v', valueHex: '0x4045000000000000', units: null }] };
    },
  };
}

describe('green-flag flow orchestration (fakes, no runtime)', () => {
  test('admitted projects thread compile, link and execute in order', async () => {
    const stages = trackingStages();
    const result = await runGreenFlagFlow(admittedFixture(), stages);
    expect(stages.calls).toEqual(['compile:4', 'link:ir:1', 'execute:4:4:abi']);
    expect(result).toEqual({
      ok: true, route: 'llvm',
      metadata: { abiDescriptor: 'abi', slots: [{ kind: 0, global: 'g', keyHex: '76' }] },
      variables: [{ id: 'v', valueHex: '0x4045000000000000', units: null }],
    });
  });
  test('unadmitted projects short-circuit before any runtime stage', async () => {
    const stages = trackingStages();
    const fixture = admittedFixture();
    (fixture.project as { targets: Array<{ blocks: Record<string, { opcode: string }> }> }).targets[0]!.blocks['set']!.opcode = 'motion_movesteps';
    const result = await runGreenFlagFlow(fixture, stages);
    expect(stages.calls).toEqual([]);
    expect(result).toEqual({ ok: true, route: 'fallback', reason: 'unsupported body opcode motion_movesteps' });
  });
  test('stage failures become error results, never throws', async () => {
    for (const stage of ['compile', 'link', 'execute'] as const) {
      const stages = trackingStages();
      (stages as unknown as Record<string, unknown>)[stage] = async () => { throw new Error(`${stage} boom`); };
      const result = await runGreenFlagFlow(admittedFixture(), stages);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`${stage} boom`);
    }
  });
});
