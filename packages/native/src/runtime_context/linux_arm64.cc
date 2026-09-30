#include "helper.h"

namespace esplus::node::require_builtin {

Result<CurrentContextRead> ReadLinuxArm64CurrentV8Context(
    void* isolate,
    const CurrentContextSymbols& symbols) {
  // v8::Local<Context> uses the same direct return ABI on glibc and musl.
  return ReadDirectCurrentV8Context("linux-arm64", isolate, symbols);
}

}  // namespace esplus::node::require_builtin
