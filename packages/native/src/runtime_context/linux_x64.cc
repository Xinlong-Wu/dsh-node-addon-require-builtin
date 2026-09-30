#include "helper.h"

namespace esplus::node::require_builtin {

Result<CurrentContextRead> ReadLinuxX64CurrentV8Context(
    void* isolate,
    const CurrentContextSymbols& symbols) {
  // v8::Local<Context> uses the same direct return ABI on glibc and musl.
  return ReadDirectCurrentV8Context("linux-x64", isolate, symbols);
}

}  // namespace esplus::node::require_builtin
