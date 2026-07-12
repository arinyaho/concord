// Local DECOY type: a first-party template spelled `NTT`, in the APP's own
// namespace (app::), living in a DIFFERENT translation-unit/namespace than the
// pinned dep's mini::ntt::NTT. Its unqualified spelling is IDENTICAL ("NTT") but
// its USR is DIFFERENT (clangd: c:@N@app@ST>1#T@NTT vs the dep's
// c:@N@mini@N@ntt@ST>1#T@NTT). This is the false-edge hazard that justifies the
// spec's "NO bare-name join, USR-unification REQUIRED": a name-only join on "NTT"
// could bind the cross-pin edge to THIS local type instead of the dep. The
// consumer references BOTH, and the cross-pin edge must bind ONLY to the dep USR.
#pragma once

namespace app {

template <typename W>
class NTT {
public:
    // A distinct method name so a call site on the LOCAL type is unambiguous.
    int rank() const noexcept { return 0; }
};

}  // namespace app
