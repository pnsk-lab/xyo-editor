import { describe, expect, test } from 'bun:test';
import { commitFlowValues } from '../src/commit';

// Commit-back only: values arrive already read from the real runtime (see the
// editor-owned browser suite for the exact bits); no execution here.
function project(extra: Record<string, unknown> = {}) {
  return {
    targets: [{ isStage: true, name: 'Stage', variables: { v: ['v', 0], w: ['w', 0] }, lists: {}, broadcasts: {}, blocks: {}, costumes: [], sounds: [], currentCostume: 0, ...extra }],
    monitors: [], extensions: [], meta: { semver: '3.0.0' },
  };
}

describe('commit-back of executed values (pure, no runtime)', () => {
  test('patches string and numeric results into variable records', () => {
    const before = project();
    const result = commitFlowValues(before, [
      { id: 'v', valueHex: '0x7ff900000005f61c', units: [0x34, 0x32] },
      { id: 'w', valueHex: '0x4045000000000000', units: null },
    ]);
    if (!result.ok) throw new Error(result.error);
    const vars = ((result.project as typeof before).targets[0]!.variables as unknown) as Record<string, [string, unknown]>;
    expect(vars.v).toEqual(['v', '42']);
    expect(vars.w).toEqual(['w', 42]);
    // Caller input untouched.
    expect((before.targets[0]!.variables as Record<string, unknown[]>).v).toEqual(['v', 0]);
  });
  test('preserves names and extra record elements', () => {
    const p = project();
    (p.targets[0]!.variables as Record<string, unknown[]>).v = ['renamed', 0, true];
    const result = commitFlowValues(p, [{ id: 'v', valueHex: '0x4036000000000000', units: null }]);
    if (!result.ok) throw new Error(result.error);
    expect(((result.project as typeof p).targets[0]!.variables as Record<string, unknown[]>).v).toEqual(['renamed', 22, true]);
  });
  test('fails closed on unknown, ambiguous, duplicate or unrepresentable ids', () => {
    expect(commitFlowValues(project(), [{ id: 'x', valueHex: '0x0', units: null }]).ok).toBe(false);
    const two = project();
    (two.targets as unknown[]).push({ isStage: false, name: 'S', variables: { v: ['v', 0] } });
    expect(commitFlowValues(two, [{ id: 'v', valueHex: '0x0', units: null }]).ok).toBe(false);
    expect(commitFlowValues(project(), [
      { id: 'v', valueHex: '0x0', units: null }, { id: 'v', valueHex: '0x0', units: null },
    ]).ok).toBe(false);
    // Empty-string tag with units is consistent (units []), but bare
    // empty-string bits without units contradict the flow contract.
    expect(commitFlowValues(project(), [{ id: 'v', valueHex: '0x7ff8000000000003', units: null }]).ok).toBe(false);
    expect(commitFlowValues(project(), [{ id: 'v', valueHex: '0x7ffb000000000000', units: null }]).ok).toBe(false);
    expect(commitFlowValues(project(), []).ok).toBe(false);
    expect(commitFlowValues(project(), [{ id: 'v', valueHex: '0x7ff900000005f61c', units: [0x34, -1] }]).ok).toBe(false);
    expect(commitFlowValues(project(), [{ id: 'v', valueHex: '0x4045000000000000', units: [] }]).ok).toBe(false);
    expect(commitFlowValues(null, [{ id: 'v', valueHex: '0x0', units: null }]).ok).toBe(false);
    expect(commitFlowValues({ targets: 'nope' }, [{ id: 'v', valueHex: '0x0', units: null }]).ok).toBe(false);
  });
});
