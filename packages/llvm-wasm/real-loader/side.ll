target triple = "wasm32-unknown-emscripten"

@state = internal global i32 10, align 4
@callback_slot = internal global ptr @callback, align 4

declare i32 @host_add(i32)

define internal i32 @callback(i32 %x) {
  %v = load i32, ptr @state
  %s = add i32 %v, %x
  ret i32 %s
}

define i32 @side_run(i32 %x) {
  %p = load ptr, ptr @callback_slot
  %n = call i32 %p(i32 %x)
  %r = call i32 @host_add(i32 %n)
  store i32 %r, ptr @state
  ret i32 %r
}

define ptr @side_get_callback() {
  ret ptr @callback
}
