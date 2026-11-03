target triple = "wasm32-unknown-emscripten"
declare i32 @intentionally_missing_host_symbol(i32)
define i32 @broken_entry(i32 %x) {
  %r = call i32 @intentionally_missing_host_symbol(i32 %x)
  ret i32 %r
}
