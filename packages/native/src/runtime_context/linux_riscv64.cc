#include "helper.h"

namespace esplus::node::require_builtin {

Result<CurrentContextRead> ReadLinuxRiscv64CurrentV8Context(
    void* isolate,
    const CurrentContextSymbols& symbols) {
  // v8::Local<Context> uses the same direct return ABI on glibc and musl:
  // the rv64 lp64d psABI returns a one-pointer class in a0.
  return ReadDirectCurrentV8Context("linux-riscv64", isolate, symbols);
}

}  // namespace esplus::node::require_builtin
