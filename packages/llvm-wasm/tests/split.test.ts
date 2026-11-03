import { describe, expect, test } from 'bun:test';
import { admitSb3Project } from '../src/admission';
import { splitProjectForLlvm } from '../src/split';

// Decision layer only: every synthesized single-script project must itself
// route llvm through the whole-project gate; the real compiler stays the
// authority (see the admission fuzzer). No execution here.
function setBlock(next: unknown, literal = '42'): Record<string, unknown> {
  return { opcode: 'data_setvariableto', next, parent: 'hat', inputs: { VALUE: [1, [4, literal]] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false };
}
function hat(next: unknown, opcode = 'event_whenflagclicked') {
  return { opcode, next, parent: null, inputs: {}, fields: {}, topLevel: true, x: 0, y: 0 };
}
function stage(blocks: Record<string, unknown>, variables: Record<string, [string, number]> = { v: ['v', 0] }) {
  return { isStage: true, name: 'Stage', variables, lists: {}, broadcasts: {}, blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0 };
}
function project(targets: unknown[]) {
  return { targets, monitors: [], extensions: [], meta: { semver: '3.0.0' } };
}
function topBlocks(targets: unknown[]): string[] {
  return (targets as Array<{ blocks: Record<string, { topLevel?: unknown }> }>).flatMap(t =>
    Object.entries(t.blocks).filter(([, b]) => b.topLevel === true).map(([id]) => id));
}

describe('split general projects into LLVM scripts and the remainder', () => {
  test('single admitted script extracts cleanly and rest is silent', () => {
    const r = splitProjectForLlvm(project([stage({ hat: hat('set'), set: setBlock(null) })]));
    if (!r.ok) throw new Error(r.error);
    expect(r.admitted).toHaveLength(1);
    expect(r.admitted[0]!.hat).toBe('hat');
    expect(r.skipped).toEqual([]);
    // The hat stays as an inert, body-less script for the unified runtime.
    expect(topBlocks((r.rest as ReturnType<typeof project>).targets)).toEqual(['hat']);
    const restBlocks = (r.rest as { targets: Array<{ blocks: Record<string, { next?: unknown }> }> }).targets[0]!.blocks;
    expect(restBlocks['hat']?.next).toBeNull();
    expect(restBlocks['set']).toBeUndefined();
    // The synthesized project is itself whole-project admissible.
    expect(admitSb3Project(r.admitted[0]!.project).route).toBe('llvm');
  });
  test('unadmitted scripts stay whole in the remainder', () => {
    const wait = { opcode: 'control_wait', next: null, parent: 'hat', inputs: { DURATION: [1, [4, '1']] }, fields: {}, topLevel: false };
    const r = splitProjectForLlvm(project([stage({ hat: hat('wait'), wait })]));
    if (!r.ok) throw new Error(r.error);
    expect(r.admitted).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain('unsupported body opcode');
    expect(topBlocks((r.rest as ReturnType<typeof project>).targets)).toEqual(['hat']);
  });
  test('mixed project splits per script across targets', () => {
    const sprite = { isStage: false, name: 'S', x: 0, y: 0, direction: 90, size: 100, visible: true, variables: {}, lists: {}, broadcasts: {}, blocks: { hat: hat('set'), set: setBlock(null) }, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 1 };
    const wait = { opcode: 'control_wait', next: null, parent: 'h2', inputs: { DURATION: [1, [4, '1']] }, fields: {}, topLevel: false };
    const p = project([
      stage({ hat: hat('set'), set: setBlock(null), h2: hat('wait'), wait }),
      sprite,
    ]);
    const r = splitProjectForLlvm(p);
    if (!r.ok) throw new Error(r.error);
    expect(r.admitted.map(a => a.hat).sort()).toEqual(['hat', 'hat']);
    expect(r.admitted.map(a => a.target).sort()).toEqual([0, 1]);
    for (const a of r.admitted) expect(admitSb3Project(a.project).route).toBe('llvm');
    const rest = (r.rest as ReturnType<typeof project>).targets;
    // Admitted hats remain inert (no body) on both targets; the wait script
    // survives intact for the interpreter.
    expect(topBlocks(rest).sort()).toEqual(['h2', 'hat', 'hat']);
    for (const target of rest as Array<typeof sprite & { blocks: Record<string, { next?: unknown }> }>) {
      expect(target.blocks['hat']?.next).toBeNull();
      expect(target.blocks['set']).toBeUndefined();
    }
    expect(r.skipped.map(s => s.hat)).toEqual(['h2']);
  });
  test('overlong chains are skipped and kept for the fallback', () => {
    const blocks: Record<string, unknown> = { hat: hat('c0') };
    let prev = 'hat';
    for (let i = 0; i < 9; i++) {
      blocks[`c${i}`] = { opcode: 'data_changevariableby', next: null, parent: prev, inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false };
      (blocks[prev] as { next: unknown }).next = `c${i}`;
      prev = `c${i}`;
    }
    const r = splitProjectForLlvm(project([stage(blocks)]));
    if (!r.ok) throw new Error(r.error);
    expect(r.admitted).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain('script chain too long');
    expect(topBlocks((r.rest as ReturnType<typeof project>).targets)).toEqual(['hat']);
  });
  test('shared explicit-shadow blocks survive in the remainder', () => {
    const lit = { opcode: 'math_number', next: null, parent: 'set', inputs: {}, fields: { NUM: ['7'] }, shadow: true };
    const wait = { opcode: 'control_wait', next: null, parent: 'h2', inputs: { VALUE: [1, 'lit'] }, fields: {}, topLevel: false };
    const blocks = { hat: hat('set'), set: { ...setBlock(null), inputs: { VALUE: [1, 'lit'] } }, h2: hat('wait'), wait, lit };
    const r = splitProjectForLlvm(project([stage(blocks)]));
    if (!r.ok) throw new Error(r.error);
    expect(r.admitted).toHaveLength(1);
    const rest = (r.rest as ReturnType<typeof project>).targets[0] as { blocks: Record<string, unknown> };
    // The admitted chain is gone but the shared literal stays for the waiter.
    expect(rest.blocks['set']).toBeUndefined();
    expect(rest.blocks['lit']).toEqual(lit);
    expect(rest.blocks['wait']).toEqual(wait);
  });
  test('malformed input fails closed, empty projects pass through', () => {
    expect(splitProjectForLlvm(null).ok).toBe(false);
    expect(splitProjectForLlvm({ targets: 'nope' }).ok).toBe(false);
    const empty = splitProjectForLlvm(project([{ isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, costumes: [], sounds: [], currentCostume: 0 }]));
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.admitted).toEqual([]);
    expect(empty.skipped).toEqual([]);
  });
});
