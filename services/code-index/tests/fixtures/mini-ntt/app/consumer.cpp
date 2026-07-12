// Consumer TU in a SEPARATE -I root. Three distinct cross-pin scenarios:
//
//   probe()   -- CONCRETE instantiation of the dep type (constructs it + calls a
//                method on a concrete object). The easy case; both the type ref
//                and the concrete method call resolve.
//
//   probe()   -- also references the LOCAL DECOY app::NTT (same unqualified
//                spelling, different USR). The cross-pin edge must bind to the DEP
//                type only; the decoy must produce NO cross-pin edge.
//
//   Wrapper<W> -- DEPENDENT-CONTEXT use: the dep type appears as a template-
//                parameter-dependent type, and the method call is on a DEPENDENT
//                EXPRESSION (the result of make()). clangd resolves the TYPE ref
//                but NOT the dependent-expression member call -- reproducing the
//                real target's "type edge survives, method ref absent" signal.
#include <cstdint>
#include <mini/ntt.hpp>
#include <impl/local_ntt.hpp>

std::uint64_t probe() {
    mini::ntt::NTT<std::uint64_t> n(1024);
    app::NTT<int> local;
    return n.degree() + static_cast<std::uint64_t>(local.rank());
}

template <typename W>
struct Wrapper {
    mini::ntt::NTT<W> make() { return mini::ntt::NTT<W>(0); }
    std::uint64_t use() { return make().degree(); }
};
