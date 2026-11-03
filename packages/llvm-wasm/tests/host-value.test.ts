import { describe, expect, test } from 'bun:test';
import { decodeHostValue } from '../src/host-value';

const f64 = (x: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0);
};
const noStrings = (): null => null;

describe('host value decoding (pure, no runtime)', () => {
  test('decodes doubles including signed zero and infinities', () => {
    expect(decodeHostValue(f64(42), noStrings)).toBe(42);
    // Exact bits observed from the real xyo runtime (change-by-42 fixture).
    expect(decodeHostValue(0x4045000000000000n, noStrings)).toBe(42);
    expect(decodeHostValue(0n, noStrings)).toBe(0);
    expect(Object.is(decodeHostValue(f64(-0), noStrings), -0)).toBe(true);
    expect(decodeHostValue(f64(Infinity), noStrings)).toBe(Infinity);
    expect(decodeHostValue(f64(-Infinity), noStrings)).toBe(-Infinity);
    expect(Number.isNaN(decodeHostValue(0x7ff8000000000000n, noStrings))).toBe(true);
  });
  test('decodes tag-space singletons', () => {
    expect(decodeHostValue(0x7ff8000000000001n, noStrings)).toBe(false);
    expect(decodeHostValue(0x7ff8000000000002n, noStrings)).toBe(true);
    expect(decodeHostValue(0x7ff8000000000003n, noStrings)).toBe('');
    expect(decodeHostValue(0x7ff8000000000004n, noStrings)).toBeNull();
  });
  test('resolves heap strings through the reader, null when unreadable', () => {
    expect(decodeHostValue(0x7ff9000000003450n, p => (p === 0x3450 ? '42' : null))).toBe('42');
    expect(decodeHostValue(0x7ff9000000003450n, () => null)).toBeNull();
  });
  test('decodes color payloads as numbers and rejects unknown tags', () => {
    expect(decodeHostValue(0x7ffa000000123456n, noStrings)).toBe(0x123456);
    expect(decodeHostValue(0x7ffb000000000000n, noStrings)).toBeNull();
    expect(decodeHostValue(0x7ffc000000000000n, noStrings)).toBeNull();
  });
});
