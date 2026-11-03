#!/usr/bin/env python3
"""Check the real relocatable object with native LLVM readobj (not an executor)."""
import re
import subprocess
import sys

text = subprocess.run([sys.argv[1], '--file-headers', '--sections', '--symbols',
                       '--relocations', sys.argv[2]], check=True, text=True,
                      stdout=subprocess.PIPE).stdout
for pattern in (r'Format: WASM', r'Arch: wasm32', r'AddressSize: 32bit',
                r'Name: linking', r'Name: reloc\.CODE',
                r'R_WASM_FUNCTION_INDEX_LEB xyo_varslot_init',
                r'R_WASM_GLOBAL_INDEX_LEB xyo_aot_slot_0',
                r'R_WASM_GLOBAL_INDEX_LEB xyo_aot_slot_1',
                r'Name: xyo_browser_script',
                r'Name: xyo_varslot_init\s+Type: FUNCTION[^}]*UNDEFINED',
                r'Name: xyo_aot_slot_0\s+Type: DATA',
                r'Name: xyo_aot_slot_1\s+Type: DATA'):
    if not re.search(pattern, text):
        raise SystemExit(f'missing object invariant: {pattern}\n{text}')
print('PASS: relocatable wasm32 object, slots and undefined helper')
