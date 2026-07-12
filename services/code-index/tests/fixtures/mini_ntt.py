"""Build the mini-ntt pin-boundary fixture with an absolute-path compile DB.

The committed sources live under fixtures/mini-ntt/. build_fixture copies them
into a caller-owned dest_dir and writes a compile_commands.json whose paths and
two -I roots are absolute (clangd requires absolute compile-DB paths).

The consumer exercises three cross-pin shapes against the same dep type:
  - a CONCRETE instantiation (type ref + concrete method call both resolve),
  - a same-named LOCAL DECOY `app::NTT` (identical spelling, different USR -- the
    false-edge hazard that justifies USR-unification over a bare-name join), and
  - a DEPENDENT-CONTEXT use `mini::ntt::NTT<W>` inside a template, whose method
    call is on a dependent EXPRESSION (only the type edge survives).
"""

import json
import os
import shutil
from dataclasses import dataclass

_SRC_ROOT = os.path.join(os.path.dirname(__file__), "mini-ntt")


@dataclass
class MiniNtt:
    root: str
    compile_db_dir: str          # dir holding compile_commands.json (also clangd's cache root)
    dep_include_root: str        # the pinned dep's -I root (the cross-pin marker)
    header_path: str             # dep/include/mini/ntt.hpp
    local_header_path: str       # app/impl/local_ntt.hpp (the same-named DECOY app::NTT)
    consumer_path: str           # app/consumer.cpp
    ntt_def_pos: dict            # 0-based position of `NTT` at the DEP class definition
    ntt_use_pos: dict            # 0-based position of the DEP `NTT` at the concrete use site
    local_ntt_def_pos: dict      # 0-based position of `NTT` at the LOCAL decoy class definition
    dep_method_def_pos: dict     # 0-based position of the DEP `degree` method definition
    dependent_type_line: int     # 0-based line of the DEPENDENT-CONTEXT dep type use in Wrapper
    dependent_call_line: int     # 0-based line of the DEPENDENT-EXPRESSION method call in Wrapper


def _find_pos(path: str, needle: str, occurrence: int = 1) -> dict:
    """0-based {line,character} of the `occurrence`-th `needle` on its line."""
    seen = 0
    with open(path) as fh:
        for lineno, line in enumerate(fh):
            col = line.find(needle)
            while col != -1:
                seen += 1
                if seen == occurrence:
                    return {"line": lineno, "character": col}
                col = line.find(needle, col + 1)
    raise AssertionError(f"{needle!r} (#{occurrence}) not found in {path}")


def _find_line(path: str, needle: str) -> int:
    """0-based line number of the first line containing `needle`."""
    with open(path) as fh:
        for lineno, line in enumerate(fh):
            if needle in line:
                return lineno
    raise AssertionError(f"{needle!r} not found in {path}")


def build_fixture(dest_dir: str) -> MiniNtt:
    root = os.path.abspath(dest_dir)
    shutil.copytree(_SRC_ROOT, root, dirs_exist_ok=True)

    dep_include_root = os.path.join(root, "dep", "include")
    app_root = os.path.join(root, "app")
    header_path = os.path.join(dep_include_root, "mini", "ntt.hpp")
    local_header_path = os.path.join(app_root, "impl", "local_ntt.hpp")
    consumer_path = os.path.join(app_root, "consumer.cpp")

    # TWO -I roots simulate the cross-pin boundary inside one repo. The app root
    # also resolves the LOCAL decoy header via `#include <impl/local_ntt.hpp>`.
    entry = {
        "directory": root,
        "file": consumer_path,
        "arguments": [
            "clang++", "-std=c++17",
            f"-I{dep_include_root}",
            f"-I{app_root}",
            "-c", consumer_path,
        ],
    }
    with open(os.path.join(root, "compile_commands.json"), "w") as fh:
        json.dump([entry], fh)

    # DEP `NTT` at its class definition: the def-site name on the `class NTT {` line.
    ntt_def_pos = _find_pos(header_path, "class NTT")
    ntt_def_pos["character"] += len("class ")
    # DEP `NTT` at the concrete consumer use site: `mini::ntt::NTT<std::uint64_t> n(1024);`
    ntt_use_pos = _find_pos(consumer_path, "mini::ntt::NTT")
    ntt_use_pos["character"] += len("mini::ntt::")
    # LOCAL decoy `NTT` at ITS class definition (app::NTT) -- same spelling, other USR.
    local_ntt_def_pos = _find_pos(local_header_path, "class NTT")
    local_ntt_def_pos["character"] += len("class ")
    # DEP `degree` method definition -- for querying references to the METHOD.
    dep_method_def_pos = _find_pos(header_path, "degree() const noexcept")
    # DEPENDENT-CONTEXT sites in Wrapper: the dep type as a template-dependent type,
    # and the method call on a dependent EXPRESSION (`make().degree()`).
    dependent_type_line = _find_line(consumer_path, "mini::ntt::NTT<W> make")
    dependent_call_line = _find_line(consumer_path, "make().degree()")

    return MiniNtt(
        root=root,
        compile_db_dir=root,
        dep_include_root=dep_include_root,
        header_path=header_path,
        local_header_path=local_header_path,
        consumer_path=consumer_path,
        ntt_def_pos=ntt_def_pos,
        ntt_use_pos=ntt_use_pos,
        local_ntt_def_pos=local_ntt_def_pos,
        dep_method_def_pos=dep_method_def_pos,
        dependent_type_line=dependent_type_line,
        dependent_call_line=dependent_call_line,
    )
