#!/usr/bin/env python3
"""Deterministic malformed-ZIP battery for the compiler ZIP preflight.

Reads the valid simple.sb3 fixture and writes small mutated variants into
out/fuzz/. Every variant must be rejected by xyo_browser_ir_compile before any
large allocation or codegen (ok == false with a "zip preflight rejected"
error), except stored-valid.sb3 which is a legitimate stored-method archive
and must compile to the same metadata as simple.sb3.
"""
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1]) / 'fuzz'
out.mkdir(parents=True, exist_ok=True)
base = (Path(sys.argv[1]) / 'simple.sb3').read_bytes()

EOCD = b'\x50\x4b\x05\x06'
CENTRAL = b'\x50\x4b\x01\x02'


def eocd(data: bytes) -> int:
    pos = data.rfind(EOCD)
    assert pos >= 0, 'base fixture has no EOCD'
    return pos


def central_range(data: bytes):
    e = eocd(data)
    count = int.from_bytes(data[e + 10:e + 12], 'little')
    off = int.from_bytes(data[e + 16:e + 20], 'little')
    return e, count, off


def patch(data: bytes, pos: int, blob: bytes) -> bytes:
    return data[:pos] + blob + data[pos + len(blob):]


def write(name: str, data: bytes):
    (out / name).write_bytes(data)


# 1. Truncations at structural boundaries.
e, count, off = central_range(base)
cuts = {'trunc-10.sb3': 10, 'trunc-21.sb3': 21, 'trunc-22.sb3': 22,
        'trunc-100.sb3': 100, 'trunc-eocd-minus-1.sb3': len(base) - 23,
        'trunc-central-plus-10.sb3': off + 10}
for name, n in cuts.items():
    write(name, base[:n])

# 2. Corrupt EOCD magic (same length, no valid EOCD anywhere).
write('bad-eocd-magic.sb3', patch(base, e, b'\x00\x00\x00\x00'))

# 3. Zero central-directory entries.
write('zero-entries.sb3', patch(base, e + 10, (0).to_bytes(2, 'little')))

# 4. Absurd entry count for a tiny file.
write('huge-count.sb3', patch(base, e + 10, (60000).to_bytes(2, 'little')))

# 5. Unsupported compression method on the project.json entry.
p = base.find(CENTRAL)
assert p >= 0
write('bad-method.sb3', patch(base, p + 10, (12).to_bytes(2, 'little')))

# 6. Legitimate stored-method archive: must compile like simple.sb3.
with zipfile.ZipFile(Path(sys.argv[1]) / 'simple.sb3') as z:
    proj = z.read('project.json')
with zipfile.ZipFile(out / 'stored-valid.sb3', 'w',
                     compression=zipfile.ZIP_STORED) as z:
    z.writestr('project.json', proj)

# 7. Stored method with mismatched sizes.
sp = (out / 'stored-valid.sb3').read_bytes()
spp = sp.find(CENTRAL)
assert spp >= 0
# compSize != uncompSize while method == stored
write('stored-mismatch.sb3',
      patch(sp, spp + 20, (len(proj) + 1).to_bytes(4, 'little')))

# 8. Duplicate project.json central entry (count + 1, offset unchanged).
# EOCD fields: +8 entries-this-disk u16, +10 total entries u16.
ce = base[off:e]
q = off
first_end = (46 + int.from_bytes(base[q + 28:q + 30], 'little') +
             int.from_bytes(base[q + 30:q + 32], 'little') +
             int.from_bytes(base[q + 32:q + 34], 'little'))
dup_entry = base[off:off + first_end]
new_central = ce + dup_entry
new_e = off + len(new_central)
new_data = base[:off] + new_central + base[e:]
new_data = (new_data[:new_e + 8] + (count + 1).to_bytes(2, 'little') +
            (count + 1).to_bytes(2, 'little') + new_data[new_e + 12:])
write('duplicate-entry.sb3', new_data)

# 9. Uncompressed sizes over the 16 MiB cap (tiny actual data).
write('over-cap-plus-1.sb3', patch(base, p + 24,
                                  (16 * 1024 * 1024 + 1).to_bytes(4, 'little')))
write('over-cap-max.sb3', patch(base, p + 24,
                                (0xFFFFFFFF).to_bytes(4, 'little')))

# 10. Local header offset outside the file.
write('bad-local-offset.sb3', patch(base, p + 42,
                                    (0xFFFFFF00).to_bytes(4, 'little')))

# 11. Empty entry name.
write('empty-name.sb3', patch(base, p + 28, (0).to_bytes(2, 'little')))

# 12. Entry header running past the end of input.
write('entry-overrun.sb3', patch(base, p + 28, (5000).to_bytes(2, 'little')))

# 13. Empty input and just-under-EOCD input.
write('empty.sb3', b'')
write('tiny-21.sb3', base[:21])

print(f'wrote {len(list(out.glob("*.sb3")))} fuzz fixtures to {out}')
