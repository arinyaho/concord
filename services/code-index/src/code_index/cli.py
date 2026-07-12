"""code-index CLI: index a compile DB into the store; query cross-edges.

    code-index index      --compile-db <dir> --db <path> --dep-marker <path>
    code-index query cross-edge --db <path> <usr>

`index` wires materialize -> engine -> extract -> store for the Stage-1 crux slice.
"""

import argparse
import os
import sys

from code_index import store
from code_index._clangd import resolve_clangd
from code_index.engine import ClangdSession
from code_index.extract import DefSymbol, index_boundary


def _resolve_clangd() -> str:
    path = resolve_clangd()
    if path is None:
        raise SystemExit(
            "no clangd binary found; expected either:\n"
            "  - $CODE_INDEX_CLANGD set to a valid path, or\n"
            "  - the pinned wheel installed: uv sync --extra dev  (provides clangd==19.1.7)"
        )
    return path


def _find_pos(path: str, needle: str) -> dict:
    with open(path) as fh:
        for lineno, line in enumerate(fh):
            col = line.find(needle)
            if col != -1:
                return {"line": lineno, "character": col}
    raise SystemExit(f"{needle!r} not found in {path}")


def discover_def_symbols(
    clangd_path: str, compile_db_dir: str, dep_include_root: str
) -> list[DefSymbol]:
    """Stage-1 scope: discover the single crux symbol from the mini-ntt fixture.

    This function is hardcoded to the mini-ntt fixture layout
    (dep_include_root/mini/ntt.hpp, class NTT). It is NOT general compile-DB
    symbol discovery -- that is deferred to plan #2. The single-crux-symbol
    cut is a deliberate Stage-1 scope choice.
    """
    header = os.path.join(dep_include_root, "mini", "ntt.hpp")
    if not os.path.exists(header):
        raise SystemExit(f"dep header not found: {header}")
    pos = _find_pos(header, "class NTT")
    pos["character"] += len("class ")
    return [DefSymbol(def_path=header, def_pos=pos, kind="class", display_name="mini::ntt::NTT")]


def _cmd_index(args) -> int:
    cdb_path = os.path.join(args.compile_db, "compile_commands.json")
    if not os.path.exists(cdb_path):
        raise SystemExit(f"compile DB not found: {cdb_path}")

    # --dep-marker is REQUIRED: it names the pinned dependency's -I include root,
    # the boundary that separates cross-pin refs from in-dep self-refs. There is no
    # safe default -- a real multi-dep compile DB has dozens of `-I .../_deps/*/include`
    # roots, so a generic marker like "include" would match the FIRST one (the WRONG
    # dep) and silently index against it. Fail loudly instead of guessing.
    if not args.dep_marker:
        raise SystemExit(
            "index requires --dep-marker <path>: the pinned dependency's include "
            "root (the cross-pin boundary). A real compile DB has many -I roots, so "
            "there is no safe default; pass the dep's -I root explicitly."
        )
    dep_root = args.dep_marker
    if not os.path.isdir(dep_root):
        raise SystemExit(f"--dep-marker is not a directory: {dep_root}")

    clangd_path = _resolve_clangd()
    conn = store.init_db(args.db)
    with ClangdSession(clangd_path, args.compile_db) as session:
        def_symbols = discover_def_symbols(clangd_path, args.compile_db, dep_root)
        n = index_boundary(
            conn, session, def_symbols=def_symbols, dep_marker=dep_root,
            repo="mini", via="mini::ntt",
        )
    print(f"indexed: {n} cross-edge(s)")
    return 0


def _cmd_query_cross_edge(args) -> int:
    conn = store.init_db(args.db)
    rows = store.cross_edge(conn, args.usr)
    for r in rows:
        print(
            f"{r['from_symbol']} --{r['kind']}[{r['via']}]--> {r['to_symbol']} "
            f"@ {r['evidence_doc']}"
        )
    if not rows:
        print(f"(no cross-edges for {args.usr})")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="code-index")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_index = sub.add_parser("index", help="index a compile DB into the store")
    p_index.add_argument("--compile-db", required=True, help="dir holding compile_commands.json")
    p_index.add_argument("--db", required=True, help="SQLite store path")
    p_index.add_argument(
        "--dep-marker",
        default=None,
        help="REQUIRED: the pinned dep's -I include root (the cross-pin boundary). "
        "No default -- a real multi-dep compile DB has many -I roots.",
    )
    p_index.set_defaults(func=_cmd_index)

    p_query = sub.add_parser("query", help="query the store")
    q_sub = p_query.add_subparsers(dest="qcmd", required=True)
    p_cross = q_sub.add_parser("cross-edge", help="print cross-edges touching a USR")
    p_cross.add_argument("--db", required=True, help="SQLite store path")
    p_cross.add_argument("usr", help="the symbol USR to query")
    p_cross.set_defaults(func=_cmd_query_cross_edge)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
