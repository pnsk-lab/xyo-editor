/** Decode one xyo NaN-boxed value into an editor-facing scalar.
 *
 * Tag layout mirrors `src/core/value.hpp` (single source of truth stays in
 * C++; the ABI descriptor pins the same constants at runtime):
 * values with top bits outside 0x7FF8..0x7FFF (masked with 0xFFF8) — plus the
 * canonical NaN itself — are IEEE-754 doubles; 0x7FF8 payloads 1/2/3/4 are
 * false/true/""/undefined; 0x7FF9 carries a 48-bit string pointer resolved
 * through `readString`; 0x7FFA carries a 24-bit RGB payload as a number.
 * Anything else (non-canonical NaNs, unreadable strings) yields null so
 * callers must handle unrepresentable values explicitly. Pure and total:
 * never throws, never touches a host.
 */
export type HostScalar = string | number | boolean | null;

const K_NAN = 0x7ff8000000000000n;
const K_FALSE = 0x7ff8000000000001n;
const K_TRUE = 0x7ff8000000000002n;
const K_EMPTY_STR = 0x7ff8000000000003n;
const K_UNDEFINED = 0x7ff8000000000004n;
const K_TAG_STR = 0x7ff9n;
const K_TAG_COLOR = 0x7ffan;

function f64BitsToNumber(u: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, u & 0xffffffffffffffffn);
  return view.getFloat64(0);
}

export function decodeHostValue(bits: bigint, readString: (byteOffset: number) => string | null): HostScalar {
  const u = bits & 0xffffffffffffffffn;
  if (((u >> 48n) & 0xfff8n) !== 0x7ff8n || u === K_NAN) return f64BitsToNumber(u);
  if (u === K_FALSE) return false;
  if (u === K_TRUE) return true;
  if (u === K_EMPTY_STR) return '';
  if (u === K_UNDEFINED) return null;
  const tag = u >> 48n;
  if (tag === K_TAG_STR) {
    const s = readString(Number(u & 0xfffffffffffFn));
    return typeof s === 'string' ? s : null;
  }
  if (tag === K_TAG_COLOR) return Number(u & 0xffffffn);
  return null;
}
