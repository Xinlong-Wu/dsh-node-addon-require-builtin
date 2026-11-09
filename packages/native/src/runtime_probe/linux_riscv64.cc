#include "parser.h"

#include "getter_decoder.h"
#include "helper.h"

namespace esplus::node::require_builtin {

Result<GetterPattern> ParseLinuxRiscv64BuiltinModuleRequireGetterOffset(
    void* getter) {
  // glibc and musl use the same rv64 lp64d C++ member calling convention. The
  // runtime's actual instructions, not its libc or version, select the offset.
  // The same matcher runs in both stages, so what differs between them is only
  // the window.
  //
  // Walking instead of matching fixed positions is what gives this port the
  // tolerance the x86-64 and AArch64 matchers have, and it is why hardened
  // x86-64 builds were never broken by distribution hardening while AArch64
  // was: RISC-V distributions have the same freedom to wrap the one-instruction
  // field load in Zicfilp landing pads or a frame record. Because stage one
  // walks, every hardened shape that fits inside the standard window resolves
  // there and never reaches the retry; the wider window is left to bodies whose
  // `ret` falls past it. See getter_decoder.h for the per-shape byte budgets.
  return DecodeGetterWithWideWindowRetry(getter, "linux-riscv64",
                                         MatchRiscv64FieldGetter);
}

}  // namespace esplus::node::require_builtin
