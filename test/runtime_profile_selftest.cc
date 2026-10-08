#include "runtime_context/embedder_data.h"
#include "runtime_context/runtime_profile.h"
#include "runtime_symbol.h"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace narb = esplus::node::require_builtin;

namespace {

[[noreturn]] void Fail(std::string_view label, std::string_view message) {
  std::cerr << "not ok " << label << ": " << message << '\n';
  std::exit(1);
}

constexpr std::string_view kPublicTagged =
    "_ZN2v87Context33GetAlignedPointerFromEmbedderDataEit";
constexpr std::string_view kSlowTagged =
    "_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEit";
constexpr std::string_view kUntagged =
    "_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEi";
constexpr std::string_view kCppHeapTagged =
    "_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEiNS_17CppHeapPointerTagE";

std::vector<std::string_view> available_symbols;
std::vector<std::string_view> requested_symbols;
uintptr_t fake_context = 0;
uintptr_t fake_realm = 0;
void* getter_result = &fake_realm;
uint16_t expected_tag = 0;
size_t getter_calls = 0;

void* NARB_MEMBER_ABI TaggedGetter(void* context, int slot, uint16_t tag) {
  if (context != &fake_context || slot != narb::kRealmSlot ||
      tag != expected_tag) {
    Fail("embedder-data getter", "incorrect context, slot or tag");
  }
  ++getter_calls;
  return getter_result;
}

void* NARB_MEMBER_ABI UntaggedGetter(void* context, int slot) {
  return TaggedGetter(context, slot, expected_tag);
}

void ExpectRead(std::string_view label,
                const narb::NativeRuntimeFingerprint& fingerprint,
                std::vector<std::string_view> symbols,
                std::vector<std::string_view> expected_lookups,
                bool supported,
                bool null_result = false) {
  auto profile = narb::NapiRuntimeProfile::FromFingerprint(fingerprint);
  if (!profile.ok()) Fail(label, profile.status().message());
  expected_tag = profile.value().embedder_data_tag();
  available_symbols = std::move(symbols);
  requested_symbols.clear();
  getter_calls = 0;
  getter_result = null_result ? nullptr : &fake_realm;

  const narb::NapiEmbedderDataReader reader(profile.value());
  auto result = reader.ReadRealm(&fake_context);
  if (requested_symbols != expected_lookups) {
    Fail(label, "unexpected symbol lookup order or ABI fallback");
  }
  if (result.ok() != supported) Fail(label, "unexpected support status");
  if (supported) {
    if (result.value() != getter_result || getter_calls != 1) {
      Fail(label, "getter result was not preserved or getter called twice");
    }
  } else if (getter_calls != 0 ||
             result.status().code() != narb::ProbeStatus::kUnsupportedNoRealm ||
             result.status().message().find("symbol") == std::string::npos) {
    Fail(label, "missing symbol must fail closed without calling a getter");
  }
  std::cout << "ok   " << label << '\n';
}

void ExpectProfile(std::string_view label,
                   const narb::NativeRuntimeFingerprint& fingerprint,
                   narb::EmbedderDataAbi expected_abi,
                   uint16_t expected_tag,
                   std::string_view expected_diagnostic) {
  auto result = narb::NapiRuntimeProfile::FromFingerprint(fingerprint);
  if (!result.ok()) Fail(label, result.status().message());
  const auto& profile = result.value();
  if (profile.embedder_data_abi() != expected_abi) {
    Fail(label, "unexpected embedder-data ABI");
  }
  if (profile.embedder_data_tag() != expected_tag) {
    Fail(label, "unexpected embedder-data tag");
  }
  if (std::string_view(profile.diagnostic_name()) != expected_diagnostic) {
    Fail(label, "unexpected diagnostic name");
  }
  std::cout << "ok   " << label << '\n';
}

void ExpectUnsupported(std::string_view label,
                       const narb::NativeRuntimeFingerprint& fingerprint) {
  auto result = narb::NapiRuntimeProfile::FromFingerprint(fingerprint);
  if (result.ok()) Fail(label, "fingerprint was accepted");
  if (result.status().code() != narb::ProbeStatus::kUnsupportedNoContext) {
    Fail(label, "unexpected failure status");
  }
  if (result.status().message().find("unsupported Electron runtime fingerprint") ==
      std::string::npos) {
    Fail(label, "unexpected failure diagnostic");
  }
  std::cout << "ok   " << label << " rejected as expected\n";
}

}  // namespace

namespace esplus::node::require_builtin {

// Link-time seam: exercise the real reader without dereferencing V8 state.
void* LookupProcessSymbol(std::string_view name) {
  requested_symbols.push_back(name);
  if (std::find(available_symbols.begin(), available_symbols.end(), name) ==
      available_symbols.end()) {
    return nullptr;
  }
  if (name == kPublicTagged || name == kSlowTagged) {
    return reinterpret_cast<void*>(&TaggedGetter);
  }
  if (name == kUntagged) return reinterpret_cast<void*>(&UntaggedGetter);
  Fail("embedder-data lookup", "must not use the CppHeapPointerTag overload");
}

}  // namespace esplus::node::require_builtin

int main() {
  ExpectProfile(
      "Node 20 ignores ordinary V8 build metadata",
      {20, 20, 2, "11.3.244.8-node.33"},
      narb::EmbedderDataAbi::kUntagged,
      0,
      "untagged Node 20/22/24 family");
  ExpectProfile(
      "Node 24 remains on the untagged path",
      {24, 18, 0, "13.6.233.17-node.37"},
      narb::EmbedderDataAbi::kUntagged,
      0,
      "untagged Node 20/22/24 family");
  ExpectProfile(
      "Node 26 remains on tag 2",
      {26, 4, 0, "14.3.127.17-node.10"},
      narb::EmbedderDataAbi::kTagged,
      narb::kPerContextDataTag,
      "tagged kPerContextData=2");
  ExpectProfile(
      "Node 27 with older V8 remains on tag 2",
      {27, 0, 0, "14.6.202.34-node.34"},
      narb::EmbedderDataAbi::kTagged,
      narb::kPerContextDataTag,
      "tagged kPerContextData=2");
  ExpectProfile(
      "Node 27 with V8 15.5 remains on tag 2",
      {27, 0, 0, "15.5.35.20-node.14"},
      narb::EmbedderDataAbi::kTagged,
      narb::kPerContextDataTag,
      "tagged kPerContextData=2");

  ExpectProfile(
      "Electron 43 native fingerprint",
      {24, 17, 0, "15.0.245.13-electron.0"},
      narb::EmbedderDataAbi::kTagged,
      0,
      "electron-43 tagged default=0");
  ExpectProfile(
      "Electron 44 native fingerprint",
      {24, 18, 1, "15.2.124.13-electron.0"},
      narb::EmbedderDataAbi::kTagged,
      0,
      "electron-44 tagged default=0");
  ExpectProfile(
      "Electron 44.7 native fingerprint",
      {24, 21, 0, "15.2.124.28-electron.0"},
      narb::EmbedderDataAbi::kTagged,
      0,
      "electron-44.7 tagged default=0");
  ExpectProfile(
      "Electron 45 native fingerprint",
      {24, 21, 0, "15.4.80-electron.0"},
      narb::EmbedderDataAbi::kTagged,
      0,
      "electron-45-alpha tagged default=0");

  ExpectUnsupported(
      "unknown Electron V8 version",
      {24, 21, 0, "15.4.81-electron.0"});
  ExpectUnsupported(
      "known Electron V8 with wrong native Node version",
      {24, 21, 1, "15.4.80-electron.0"});

  ExpectUnsupported(
      "Electron 44.7 V8 with wrong native Node version",
      {24, 21, 1, "15.2.124.28-electron.0"});
  ExpectUnsupported(
      "Electron 44.7 Node with unknown V8 version",
      {24, 21, 0, "15.2.124.29-electron.0"});

  const narb::NativeRuntimeFingerprint node27 =
      {27, 0, 0, "15.5.35.20-node.14"};
  ExpectRead("V8 15.5 public tagged getter", node27,
             {kPublicTagged, kCppHeapTagged}, {kPublicTagged}, true);
  ExpectRead("public getter takes precedence", node27,
             {kPublicTagged, kSlowTagged}, {kPublicTagged}, true);
  // A null read is passed to the enclosing runtime-context pointer validator;
  // it must never trigger a second call with another ABI.
  ExpectRead("null public result does not fall back", node27,
             {kPublicTagged, kSlowTagged}, {kPublicTagged}, true, true);
  ExpectRead("older Node 27 slow tagged getter",
             {27, 0, 0, "14.6.202.34-node.34"},
             {kSlowTagged}, {kPublicTagged, kSlowTagged}, true);
  ExpectRead("Node 26 slow tagged getter",
             {26, 4, 0, "14.3.127.17-node.10"},
             {kSlowTagged}, {kPublicTagged, kSlowTagged}, true);
  ExpectRead("Electron slow getter receives tag zero",
             {24, 17, 0, "15.0.245.13-electron.0"},
             {kSlowTagged}, {kPublicTagged, kSlowTagged}, true);
  ExpectRead("Node 24 remains untagged",
             {24, 18, 0, "13.6.233.17-node.37"},
             {kUntagged, kPublicTagged}, {kUntagged}, true);
  ExpectRead("tagged profile rejects untagged-only exports", node27,
             {kUntagged}, {kPublicTagged, kSlowTagged}, false);
  ExpectRead("CppHeapPointerTag is not an EmbedderDataTypeTag", node27,
             {kCppHeapTagged}, {kPublicTagged, kSlowTagged}, false);
  ExpectRead("missing tagged exports fail closed", node27,
             {}, {kPublicTagged, kSlowTagged}, false);
  ExpectRead("untagged profile rejects tagged-only exports",
             {24, 18, 0, "13.6.233.17-node.37"},
             {kPublicTagged, kSlowTagged}, {kUntagged}, false);

  std::cout << "\nAll runtime-profile cases passed.\n";
  return 0;
}
