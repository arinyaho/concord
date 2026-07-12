// Minimal DEFINITION header simulating a pinned dependency's public API.
// A consumer in a different -I root includes this and references it in three ways
// (see app/consumer.cpp): a CONCRETE instantiation, alongside a same-named LOCAL
// decoy type, and a DEPENDENT-CONTEXT template member.
#pragma once
#include <cstdint>

namespace mini {
namespace ntt {

// Template coefficient-word container. The cross-pin edge under test is the TYPE
// reference to this template from a consumer in a separate translation unit. Two
// consumer shapes exercise it: (1) a concrete instantiation whose method call also
// resolves, and (2) a dependent-context use (`NTT<W>` under a template) where the
// TYPE ref resolves but a method call on a dependent EXPRESSION does not -- so only
// the type edge survives, matching the real target's observed signal.
template <typename Word>
class NTT {
public:
    explicit NTT(std::uint64_t degree) : degree_(degree) {}

    // A concrete method so a concrete-instantiation call site also exists.
    std::uint64_t degree() const noexcept { return degree_; }

private:
    std::uint64_t degree_;
};

}  // namespace ntt
}  // namespace mini
