target triple = "wasm32-unknown-unknown"

define i32 @increment(ptr %cell) {
entry:
  %value = load i32, ptr %cell, align 4
  %next = add i32 %value, 1
  store i32 %next, ptr %cell, align 4
  ret i32 %next
}
