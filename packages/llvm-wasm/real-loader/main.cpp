#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <emscripten/emscripten.h>
extern "C" EMSCRIPTEN_KEEPALIVE int host_add(int x) { return x + 100; }
using Unary = int (*)(int);
using GetCallback = Unary (*)();
static void check(bool ok, const char* what) { if (!ok) { std::fprintf(stderr,"FAIL: %s: %s\n", what, dlerror()); std::exit(1); } std::printf("PASS: %s\n",what); }
int main(int argc, char**) {
  if (argc > 1) {
    void* bad = dlopen("/unresolved.wasm", RTLD_NOW | RTLD_LOCAL);
    if (!bad) { std::puts("PASS: unresolved module rejected at dlopen"); return 0; }
    auto entry = reinterpret_cast<Unary>(dlsym(bad, "broken_entry"));
    check(entry, "unresolved module entry exists");
    std::puts("INFO: unresolved import deferred until call");
    std::fflush(stdout);
    entry(1);
    std::fputs("FAIL: unresolved call unexpectedly succeeded\n", stderr);
    return 2;
  }
  check(!dlopen("/missing.wasm", RTLD_NOW), "missing module rejected");
  void* h = dlopen("/side.wasm", RTLD_NOW | RTLD_LOCAL);
  check(h, "dlopen real side module");
  auto run = reinterpret_cast<Unary>(dlsym(h,"side_run"));
  auto get = reinterpret_cast<GetCallback>(dlsym(h,"side_get_callback"));
  check(run && get, "dlsym functions");
  check(!dlsym(h,"missing_symbol"), "missing symbol rejected");
  Unary cb = get();
  check(cb && cb(2)==12, "relocated function pointer and table dispatch");
  if (EM_ASM_INT({ if (typeof globalThis.gc !== 'function') return 0; for (let i=0;i<5;i++) globalThis.gc(); return 1; })) {
    std::puts("PASS: forced JS garbage collection");
    check(cb(2)==12, "callback survives JS garbage collection while loaded");
  } else std::puts("SKIP: no explicit GC API");
  check(run(5)==115, "shared memory and host GOT call");
  check(cb(1)==116, "callback observes updated side memory");
  void* h2 = dlopen("/side.wasm", RTLD_NOW | RTLD_LOCAL);
  check(h2, "second dlopen");
  check(dlclose(h)==0, "close one reference");
  check(cb(2)==117, "callback alive while second handle held");
  check(dlclose(h2)==0, "close final reference");
  // Never call cb after final close: pointer lifetime is no longer guaranteed.
  return 0;
}
