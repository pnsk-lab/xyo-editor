# Isolated synthetic-host side-module experiment

This does **not** connect to the product or use the real xyo runtime. The memory layouts, pointer values, helper behavior, and variable are manually invented from this one emitted IR. There is no real xyo allocation, object ownership, garbage collector, runtime ABI compatibility, scheduler, or dynamic loader here. This is not evidence that arbitrary SB3, IR, or Wasm is safe to compile or execute. Run only a trusted, known fixture in an appropriately isolated environment. The older prototype README describes its own IR-only experiment; this separate experiment executes the IR only under this synthetic host.

From the repository root, with the existing LLVM 19 Wasm tools, Node, and the isolated xyo-to-LLVM prototype already built:

```sh
taskset -c 0-3,8-11 env CMAKE_BUILD_PARALLEL_LEVEL=4 bash packages/llvm-wasm/prototype/synthetic-side-module.sh
```

The script first runs the separate prototype smoke procedure to regenerate the real SB3 fixture and its LLVM IR, then runs Wasm LLVM llc in Node with PIC object output and Wasm LLVM lld with `--shared --allow-undefined`. Resource limits are inherited from the caller. It writes to `.work/smoke-fixtures` and `.work/synthetic-side`. LLD warns shared support is unstable. Node then instantiates the resulting Wasm with a synthetic JS host. This experiment does not independently establish provenance or runtime ABI compatibility.

The host requires exactly the expected import and export lists and rejects extra or altered `dylink.0` contents. Its checked metadata is one memory-info subsection: 12 bytes, alignment 2^2, zero table entries, table alignment 2^0, no additional subsections or libraries. It checks placement and 4-/8-byte alignment; it does not implement a general metadata parser or dynamic linker. The exported slot globals are relative offsets 4 and 8, so the mutable `GOT.mem` globals are initialized to base+offset, not the offsets themselves. `__wasm_apply_data_relocs` and `__wasm_call_ctors` are invoked before the explicit slot values are written. The synthetic helper asserts the context, index, variable-id pointer, UTF-16 name and flags; it does not initialize a real variable or emulate GC. The host constructs the IR's context+68 → slot array → slot and slot+40 value destination. Slot 0 contains made-up pointer `0x3450`; slot 1 contains `0x4560`.

Observed with this fixture: one helper call and final value bits `0x7ff9000000003450` (the IR constant OR the synthetic slot-0 pointer). These checks fail closed for the observed import/export and dylink contract; they are not a sandbox or proof of safety for altered code with the same interface. No browser execution was performed for this side-module experiment.
