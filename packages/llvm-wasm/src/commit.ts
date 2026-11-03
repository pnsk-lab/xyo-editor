/** Commit executed host values back into a project (test-only).
 *
 * After the real xyo runtime finishes an admitted script, the future backend
 * needs the resulting variable values in editor-loadable form. This pure
 * function patches an SB3 project JSON's variable records (`{ [id]: [name,
 * value, ...] }`) with the decoded scalars, preserving names and any extra
 * record elements. It never executes anything: values arrive as already-read
 * hex bits plus optional UTF-16 units from the flow stage, and are decoded
 * with the same tag layout as the host. Anything unrepresentable or
 * unlocatable fails closed so the caller falls back to the built-in VM.
 */
import { decodeHostValue, type HostScalar } from './host-value';
import type { GreenFlagVariable } from './flow';

export type CommitResult = { ok: true; project: unknown } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function commitFlowValues(project: unknown, variables: GreenFlagVariable[]): CommitResult {
  const fail = (error: string): CommitResult => ({ ok: false, error });
  if (!isObject(project)) return fail('not a project object');
  if (!Array.isArray(project.targets)) return fail('no targets');
  if (!Array.isArray(variables) || variables.length === 0) return fail('no variables to commit');
  for (const v of variables) {
    if (!isObject(v) || typeof v.id !== 'string' || v.id === '' || typeof v.valueHex !== 'string') {
      return fail('malformed variable result');
    }
  }
  const ids = variables.map(v => (v as { id: string }).id);
  if (new Set(ids).size !== ids.length) return fail('duplicate variable id');
  // Deep-clone through JSON so the caller's project is never mutated; SB3
  // project JSON is always JSON-serializable.
  let patched: unknown;
  try {
    patched = JSON.parse(JSON.stringify(project));
  } catch {
    return fail('project is not JSON-serializable');
  }
  const targets = (patched as { targets: unknown[] }).targets;
  for (const v of variables as Array<{ id: string; valueHex: string; units: number[] | null }>) {
    let scalar: HostScalar;
    if (v.units !== null && v.units !== undefined) {
      if (!Array.isArray(v.units) || v.units.some(u => !Number.isInteger(u) || u < 0 || u > 0xffff)) {
        return fail(`bad units for ${v.id}`);
      }
      let tag: bigint;
      try {
        tag = (BigInt(v.valueHex) >> 48n) & 0xffffn;
      } catch {
        return fail(`bad valueHex for ${v.id}`);
      }
      if (tag !== 0x7ff9n) return fail(`non-string tag with units for ${v.id}`);
      scalar = String.fromCharCode(...v.units);
    } else {
      let bits: bigint;
      try {
        bits = BigInt(v.valueHex);
      } catch {
        return fail(`bad valueHex for ${v.id}`);
      }
      scalar = decodeHostValue(bits, () => null);
      if (scalar === null || typeof scalar === 'string') return fail(`unrepresentable value for ${v.id}`);
    }
    const homes: Array<{ map: Record<string, unknown[]>; key: string }> = [];
    for (const t of targets) {
      if (!isObject(t) || !isObject((t as { variables?: unknown }).variables)) continue;
      const map = (t as { variables: Record<string, unknown> }).variables;
      for (const key of Object.keys(map)) {
        if (key === v.id) homes.push({ map: map as unknown as Record<string, unknown[]>, key });
      }
    }
    if (homes.length === 0) return fail(`unknown variable id ${v.id}`);
    if (homes.length > 1) return fail(`ambiguous variable id ${v.id}`);
    const [home] = homes;
    const record = home!.map[home!.key];
    if (!Array.isArray(record) || record.length < 2 || typeof record[0] !== 'string') {
      return fail(`malformed variable record ${v.id}`);
    }
    record[1] = scalar;
  }
  return { ok: true, project: patched };
}
