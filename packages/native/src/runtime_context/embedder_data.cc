#include "embedder_data.h"

#include "../runtime_symbol.h"

namespace esplus::node::require_builtin {
namespace {

constexpr std::string_view kSymContextGetAlignedPointerTagged =
    "_ZN2v87Context33GetAlignedPointerFromEmbedderDataEit";
constexpr std::string_view kSymContextSlowGetAlignedPointerTagged =
    "_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEit";
constexpr std::string_view kSymContextSlowGetAlignedPointerUntagged =
    "_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEi";

using GetAlignedPointerTaggedFn =
    void* (NARB_MEMBER_ABI*)(void*, int, uint16_t);
using GetAlignedPointerUntaggedFn =
    void* (NARB_MEMBER_ABI*)(void*, int);

}  // namespace

Result<void*> NapiEmbedderDataReader::ReadRealm(void* context) const {
  if (profile_.embedder_data_abi() == EmbedderDataAbi::kTagged) {
    // V8 15.5 moved the EmbedderDataTypeTag entry point out of line. Its slow
    // helper now takes CppHeapPointerTag instead, which is not interchangeable
    // with Node's tag. Let V8's public entry point perform that conversion.
    // Older V8 builds only export the slow helper accepting uint16_t.
    for (const auto symbol : {kSymContextGetAlignedPointerTagged,
                              kSymContextSlowGetAlignedPointerTagged}) {
      auto getter = LookupProcessFunction<GetAlignedPointerTaggedFn>(symbol);
      if (getter == nullptr) continue;
      DebugTrace("calling tagged embedder-data getter: %.*s",
                 static_cast<int>(symbol.size()), symbol.data());
      return Result<void*>::Ok(
          getter(context, kRealmSlot, profile_.embedder_data_tag()));
    }
    return Result<void*>::Failure(Status::Failure(
        ProbeStatus::kUnsupportedNoRealm,
        "tagged GetAlignedPointerFromEmbedderData symbol not found"));
  }

  auto getter = LookupProcessFunction<GetAlignedPointerUntaggedFn>(
      kSymContextSlowGetAlignedPointerUntagged);
  if (getter == nullptr) {
    return Result<void*>::Failure(Status::Failure(
        ProbeStatus::kUnsupportedNoRealm,
        "no compatible GetAlignedPointerFromEmbedderData symbol found"));
  }
  DebugTrace("calling SlowGetAlignedPointerFromEmbedderData(untagged)");
  return Result<void*>::Ok(getter(context, kRealmSlot));
}

}  // namespace esplus::node::require_builtin
