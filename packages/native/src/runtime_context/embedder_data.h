#pragma once

#include "runtime_profile.h"

namespace esplus::node::require_builtin {

// The runtime profile owns the tag convention; this reader resolves the V8
// entry point that accepts that tag without depending on a Node major cutoff.
class NapiEmbedderDataReader final {
 public:
  explicit NapiEmbedderDataReader(NapiRuntimeProfile profile)
      : profile_(profile) {}

  Result<void*> ReadRealm(void* context) const;

 private:
  NapiRuntimeProfile profile_;
};

}  // namespace esplus::node::require_builtin
