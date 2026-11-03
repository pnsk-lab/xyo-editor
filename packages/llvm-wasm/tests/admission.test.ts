import { describe, expect, test } from 'bun:test';
import { admitSb3Project } from '../src/admission';

// Routing-only: mirrors the metadata compiler gates over raw project JSON.
// The C++ compiler re-validates everything; 'llvm' here never executes code.
function script(opcode: string, valueInput: unknown, variable: [string, string] = ['v', 'v']) {
  return {
    hat: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, topLevel: true },
    set: { opcode, next: null, parent: 'hat', inputs: { VALUE: valueInput }, fields: { VARIABLE: variable }, topLevel: false },
  };
}
function project(blocks: Record<string, unknown>, extraTargets: unknown[] = []) {
  return {
    targets: [{
      isStage: true, name: 'Stage', variables: { v: ['v', 0] }, lists: {}, broadcasts: {},
      blocks, costumes: [], sounds: [], currentCostume: 0, volume: 100, layerOrder: 0,
    }, ...extraTargets],
    monitors: [], extensions: [], meta: { semver: '3.0.0' },
  };
}
const set42 = () => project(script('data_setvariableto', [1, [4, '42']]));
const change42 = () => project(script('data_changevariableby', [1, [4, '42']]));

describe('green-flag admission router (no execution)', () => {
  test('admits a single set and a single change with numeric shadows', () => {
    expect(admitSb3Project(set42())).toEqual({ route: 'llvm' });
    expect(admitSb3Project(change42())).toEqual({ route: 'llvm' });
  });
  test('falls back for waits, extra hats, non-hat tops and garbage', () => {
    const wait = project(script('control_wait', [1, [4, '1']]));
    expect(admitSb3Project(wait).route).toBe('fallback');
    const two = set42();
    (two.targets[0] as any).blocks.hat2 = { opcode: 'event_whenkeypressed', next: null, parent: null, inputs: {}, fields: {}, topLevel: true };
    expect(admitSb3Project(two).route).toBe('fallback');
    const other = set42();
    (other.targets[0] as any).blocks.hat.opcode = 'event_whenkeypressed';
    expect(admitSb3Project(other).route).toBe('fallback');
    for (const bad of [null, 42, 'sb3', [], {}, { targets: 'x' }]) {
      expect(admitSb3Project(bad).route).toBe('fallback');
    }
  });
  test('falls back for NUL identifiers like the compiler gate', () => {
    const nulId = set42();
    (nulId.targets[0] as any).blocks.set.fields.VARIABLE = ['v', 'v\0x'];
    expect(admitSb3Project(nulId).route).toBe('fallback');
    const nulName = set42();
    (nulName.targets[0] as any).blocks.set.fields.VARIABLE = ['v\0x', 'v'];
    expect(admitSb3Project(nulName).route).toBe('fallback');
  });
  test('falls back for non-math_number shadows and malformed inputs', () => {
    // Positive-number primitive synthesizes a math_positive_number block.
    expect(admitSb3Project(project(script('data_setvariableto', [1, [5, '42']]))).route).toBe('fallback');
    // No-shadow input position: primitive lands in a non-shadow block.
    expect(admitSb3Project(project(script('data_setvariableto', [2, [4, '42']]))).route).toBe('fallback');
    // Extra input beside VALUE.
    const extra = set42();
    (extra.targets[0] as any).blocks.set.inputs.DURATION = [1, [4, '1']];
    expect(admitSb3Project(extra).route).toBe('fallback');
    // Mutation on the body.
    const mutated = set42();
    (mutated.targets[0] as any).blocks.set.mutation = { tagName: 'mutation' };
    expect(admitSb3Project(mutated).route).toBe('fallback');
    // Dangling next (missing block).
    const dangling = set42();
    (dangling.targets[0] as any).blocks.set.next = 'missing';
    expect(admitSb3Project(dangling).route).toBe('fallback');
  });
  test('admits short straight-line chains and rejects long or cyclic ones', () => {
    const chain2 = set42();
    const b2 = (chain2.targets[0] as any).blocks;
    b2.set.next = 'tail';
    b2.tail = { opcode: 'data_changevariableby', next: null, parent: 'set', inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false };
    expect(admitSb3Project(chain2)).toEqual({ route: 'llvm' });
    const badTail = set42();
    const b3 = (badTail.targets[0] as any).blocks;
    b3.set.next = 'tail';
    b3.tail = { opcode: 'motion_movesteps', next: null, parent: 'set', inputs: { STEPS: [1, [4, '10']] }, fields: {}, topLevel: false };
    expect(admitSb3Project(badTail).route).toBe('fallback');
    // Eight blocks fit the cap; nine do not.
    const exact: any = set42();
    let prev = 'set';
    for (let i = 0; i < 7; i++) {
      const id = `e${i}`;
      exact.targets[0].blocks[prev].next = id;
      exact.targets[0].blocks[id] = { opcode: 'data_changevariableby', next: null, parent: prev, inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false };
      prev = id;
    }
    expect(admitSb3Project(exact)).toEqual({ route: 'llvm' });
    const long: any = set42();
    prev = 'set';
    for (let i = 0; i < 8; i++) {
      const id = `c${i}`;
      long.targets[0].blocks[prev].next = id;
      long.targets[0].blocks[id] = { opcode: 'data_changevariableby', next: null, parent: prev, inputs: { VALUE: [1, [4, '1']] }, fields: { VARIABLE: ['v', 'v'] }, topLevel: false };
      prev = id;
    }
    expect(admitSb3Project(long).route).toBe('fallback');
    // A cycle back to the head is bounded by the same cap.
    const cyclic = set42();
    (cyclic.targets[0] as any).blocks.set.next = 'set';
    expect(admitSb3Project(cyclic).route).toBe('fallback');
  });
  test('resolves explicit shadow-block references like the loader', () => {
    const ref = set42();
    const blocks = (ref.targets[0] as any).blocks;
    blocks.set.inputs.VALUE = [1, 'lit'];
    blocks.lit = { opcode: 'math_number', next: null, parent: 'set', inputs: {}, fields: { NUM: ['42'] }, shadow: true };
    expect(admitSb3Project(ref)).toEqual({ route: 'llvm' });
    const noNum = set42();
    const blocks2 = (noNum.targets[0] as any).blocks;
    blocks2.set.inputs.VALUE = [1, 'lit'];
    blocks2.lit = { opcode: 'math_number', next: null, parent: 'set', inputs: {}, fields: {}, shadow: true };
    expect(admitSb3Project(noNum).route).toBe('fallback');
    const notShadow = set42();
    const blocks3 = (notShadow.targets[0] as any).blocks;
    blocks3.set.inputs.VALUE = [1, 'lit'];
    blocks3.lit = { opcode: 'math_number', next: null, parent: 'set', inputs: {}, fields: { NUM: ['42'] }, shadow: false };
    expect(admitSb3Project(notShadow).route).toBe('fallback');
  });
  test('resolves info-3 block/shadow pairs with block priority', () => {
    const both = set42();
    const blocks = (both.targets[0] as any).blocks;
    blocks.set.inputs.VALUE = [3, 'lit', [4, '42']];
    blocks.lit = { opcode: 'math_number', next: null, parent: 'set', inputs: {}, fields: { NUM: ['7'] }, shadow: true };
    // Block id wins when non-empty, so the "7" literal governs, still admitted.
    expect(admitSb3Project(both)).toEqual({ route: 'llvm' });
    const fallbackShadow = set42();
    const blocks2 = (fallbackShadow.targets[0] as any).blocks;
    blocks2.set.inputs.VALUE = [3, '', [4, '42']];
    expect(admitSb3Project(fallbackShadow)).toEqual({ route: 'llvm' });
  });
});
