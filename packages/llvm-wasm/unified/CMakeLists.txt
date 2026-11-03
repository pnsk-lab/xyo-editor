cmake_minimum_required(VERSION 3.24)
project(xyo_unified_runtime LANGUAGES C CXX ASM)
set(XYO_UNIFIED_EXPORTS "-sEXPORTED_FUNCTIONS=['_malloc','_free','_xyo_browser_create','_xyo_browser_destroy','_xyo_browser_load_sb3','_xyo_browser_green_flag','_xyo_browser_stop','_xyo_browser_step','_xyo_browser_key','_xyo_browser_mouse','_xyo_browser_wheel','_xyo_browser_answer','_xyo_browser_answer_if_question','_xyo_browser_snapshot','_xyo_browser_error','_xyo_browser_capabilities','_xyo_browser_renderer_attach','_xyo_browser_renderer_detach','_xyo_browser_internal_enter','_xyo_browser_internal_leave','_xyo_browser_audio_open','_xyo_browser_audio_session_generation','_xyo_browser_audio_close','_xyo_browser_audio_detach','_xyo_browser_audio_tick','_xyo_browser_audio_failed','_xyo_browser_audio_kind','_xyo_browser_audio_generation','_xyo_browser_audio_id_lo','_xyo_browser_audio_id_hi','_xyo_browser_audio_bytes','_xyo_browser_audio_bytes_size','_xyo_browser_audio_format','_xyo_browser_audio_target','_xyo_browser_audio_volume','_xyo_browser_audio_pitch','_xyo_browser_audio_pan','_xyo_browser_audio_pop','_xyo_browser_audio_complete','_xyo_browser_audio_stop_ack','_xyo_browser_audio_close_ack','_xyo_browser_internal_snapshot','_xyo_browser_register_segment','_xyo_browser_clear_segments','_xyo_browser_segment_hits','_xyo_browser_target_count','_xyo_browser_target_at','_xyo_browser_set_target_drawable','_xyo_llvm_segment_open','_xyo_llvm_segment_expect','_xyo_llvm_segment_bind','_xyo_llvm_segment_sealed','_xyo_llvm_segment_dlopen','_xyo_llvm_segment_dlsym','_xyo_llvm_prepare','_xyo_llvm_expect_slots','_xyo_llvm_bind_slot','_xyo_llvm_is_sealed','_xyo_llvm_dlopen','_xyo_llvm_dlsym','_xyo_llvm_dlclose','_xyo_llvm_invoke','_xyo_llvm_release','_xyo_llvm_variable','_xyo_llvm_variable_bits','_xyo_varslot_init','_xyo_to_num']")
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Emscripten required")
endif()
set(CMAKE_CXX_STANDARD 20)
set(XYO_SOURCE "" CACHE PATH "Pinned xyo checkout")
set(XYO_BROWSER_SRC "" CACHE PATH "xyo-cpp-wasm package directory (browser.cpp + src/)")
set(XYO_ALLOW_PATCHES OFF CACHE BOOL "Allow the reviewed xyo-cpp browser patches")
if(NOT EXISTS "${XYO_SOURCE}/src/jit/rt.cpp")
  message(FATAL_ERROR "XYO_SOURCE must point at the pinned xyo source")
endif()
if(NOT EXISTS "${XYO_BROWSER_SRC}/browser.cpp")
  message(FATAL_ERROR "XYO_BROWSER_SRC must point at packages/xyo-cpp-wasm")
endif()
execute_process(COMMAND git -C "${XYO_SOURCE}" rev-parse HEAD OUTPUT_VARIABLE xyo_commit OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE git_status)
if(NOT git_status EQUAL 0 OR NOT xyo_commit STREQUAL "93c80a4bcc007284cdede0b927ec310145eaa0b5")
  message(FATAL_ERROR "xyo source is not the required pinned commit")
endif()
execute_process(COMMAND git -C "${XYO_SOURCE}" status --porcelain --untracked-files=no OUTPUT_VARIABLE xyo_changes OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE git_status)
if(NOT git_status EQUAL 0)
  message(FATAL_ERROR "cannot inspect the xyo source tree")
endif()
# browser.cpp depends on the reviewed xyo-cpp browser patches (question ids,
# wait generations, safe wasm runtime, wait-bubble lifetime), so the unified
# build uses a disposable patched copy. An unpatched tree would not compile.
if(NOT XYO_ALLOW_PATCHES AND NOT xyo_changes STREQUAL "")
  message(FATAL_ERROR "tracked xyo source modifications are not permitted (set XYO_ALLOW_PATCHES=ON for the patched disposable copy)")
endif()

# The interpreter runtime keeps every upstream engine (motion, sound, pen) so
# the unified module covers xyo-cpp's full feature set, while the LLVM path
# replaces upstream's own WASM JIT.
set(XYO_JIT OFF CACHE BOOL "" FORCE)
set(XYO_BUILD_SHELL OFF CACHE BOOL "" FORCE)
set(XYO_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(XYO_SDL2 OFF CACHE BOOL "" FORCE)
set(XYO_WASM_JIT OFF CACHE BOOL "" FORCE)
set(XYO_SAFE_WASM_DIR "${XYO_BROWSER_SRC}/src" CACHE PATH "" FORCE)
add_subdirectory("${XYO_SOURCE}" "${CMAKE_CURRENT_BINARY_DIR}/xyo")
get_target_property(sources xyo SOURCES)
list(FILTER sources EXCLUDE REGEX "(^|/)src/jit/nojit_stub.cpp$")
set_property(TARGET xyo PROPERTY SOURCES "${sources}")
# Keep upstream's no-JIT engine implementation but drop its dummy helper
# bodies: LLVM-compiled code needs the real rt.cpp implementations.
file(READ "${XYO_SOURCE}/src/jit/nojit_stub.cpp" stub)
string(FIND "${stub}" "// 生成コードからのみ呼ばれる" end)
if(end LESS 0)
  message(FATAL_ERROR "unexpected upstream nojit_stub.cpp")
endif()
string(SUBSTRING "${stub}" 0 ${end} engine_stub)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/nojit_engine.cpp" "${engine_stub}")
target_include_directories(xyo PRIVATE "${XYO_SOURCE}/src/jit")
target_sources(xyo PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/nojit_engine.cpp" "${XYO_SOURCE}/src/jit/rt.cpp")

add_executable(unified_runtime
  "${XYO_BROWSER_SRC}/browser.cpp"
  "${XYO_BROWSER_SRC}/src/renderer_bridge.cpp"
  "${XYO_BROWSER_SRC}/src/async_sound_bank.cpp"
  "${XYO_BROWSER_SRC}/src/browser_async_sound.cpp"
  "${XYO_BROWSER_SRC}/src/safe_runtime.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/llvm_host_abi.cpp")
target_include_directories(unified_runtime PRIVATE
  "${XYO_SOURCE}/src" "${XYO_BROWSER_SRC}" "${XYO_BROWSER_SRC}/src")
target_compile_definitions(unified_runtime PRIVATE
  XYO_SAFE_WASM_RUNTIME=1 XYO_WAIT_GENERATIONS=1 XYO_LLVM_HOST=1)
target_link_libraries(unified_runtime PRIVATE xyo)
target_link_options(unified_runtime PRIVATE
  --no-entry -sMAIN_MODULE=2 -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1
  "-sEXPORT_NAME=createXyoUnified"
  -sUSE_ZLIB=1 -sSTACK_SIZE=5242880
  -sENVIRONMENT=web,worker,node
  "-sINCOMING_MODULE_JS_API=['wasmBinary','instantiateWasm','locateFile']"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','FS','UTF8ToString','addFunction','removeFunction']"
  ${XYO_UNIFIED_EXPORTS})
set_target_properties(unified_runtime PROPERTIES SUFFIX ".js")

# Browser distribution: the editor imports an ES module factory and a separate
# Wasm asset (the CommonJS glue above stays for Node smoke tests).
add_executable(unified_runtime_esm
  "${XYO_BROWSER_SRC}/browser.cpp"
  "${XYO_BROWSER_SRC}/src/renderer_bridge.cpp"
  "${XYO_BROWSER_SRC}/src/async_sound_bank.cpp"
  "${XYO_BROWSER_SRC}/src/browser_async_sound.cpp"
  "${XYO_BROWSER_SRC}/src/safe_runtime.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/llvm_host_abi.cpp")
target_include_directories(unified_runtime_esm PRIVATE
  "${XYO_SOURCE}/src" "${XYO_BROWSER_SRC}" "${XYO_BROWSER_SRC}/src")
target_compile_definitions(unified_runtime_esm PRIVATE
  XYO_SAFE_WASM_RUNTIME=1 XYO_WAIT_GENERATIONS=1 XYO_LLVM_HOST=1)
target_link_libraries(unified_runtime_esm PRIVATE xyo)
target_link_options(unified_runtime_esm PRIVATE
  --no-entry -sMAIN_MODULE=2 -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1
  -sALLOW_TABLE_GROWTH=1
  "-sEXPORT_NAME=createXyoUnified"
  -sUSE_ZLIB=1 -sSTACK_SIZE=5242880
  -sENVIRONMENT=web,worker
  "-sINCOMING_MODULE_JS_API=['wasmBinary','instantiateWasm','locateFile']"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','FS','UTF8ToString','addFunction','removeFunction']"
  ${XYO_UNIFIED_EXPORTS})
set_target_properties(unified_runtime_esm PROPERTIES SUFFIX ".mjs")
