"""Family-A dependency-source materialization (build-linkage, same-language).

The CPM-pinned ref under build/_deps/<name>-src is the source of truth (what the
consumer actually compiles). A sibling checkout is used ONLY when its HEAD equals
the pinned SHA (a SHA-equality guard). Dedupe by the canonical CMake alias, not by
directory/slug -- the same package materializes under multiple _deps trees.

Stage-1 wiring note: only `resolve_pinned_include_root` is used by the Stage-1
pipeline (called from cli.py's index command). `dedupe_by_alias` and
`sibling_override` are Family-A scaffolding for the multi-dep real corpus
(plan #2) and are NOT yet wired into the Stage-1 pipeline.
"""

from typing import Callable


def _iter_include_roots(arguments: list[str]):
    """Yield each -I root from a compile-DB argument list (both -I<p> and -I <p>)."""
    i = 0
    while i < len(arguments):
        arg = arguments[i]
        if arg == "-I" and i + 1 < len(arguments):
            yield arguments[i + 1]
            i += 2
            continue
        if arg.startswith("-I") and len(arg) > 2:
            yield arg[2:]
        i += 1


def resolve_pinned_include_root(cdb_entries: list[dict], package_marker: str) -> str | None:
    """Return the -I root whose path contains /<package_marker>/ (or ends with it)."""
    needle_mid = f"/{package_marker}/"
    needle_end = f"/{package_marker}"
    for entry in cdb_entries:
        for root in _iter_include_roots(entry.get("arguments", [])):
            if needle_mid in root or root.endswith(needle_end):
                return root
    return None


def dedupe_by_alias(roots_by_alias: dict[str, list[str]]) -> dict[str, str]:
    """Collapse each alias's roots to one canonical root (lexicographically first)."""
    return {alias: sorted(roots)[0] for alias, roots in roots_by_alias.items() if roots}


def sibling_override(
    pin_sha: str,
    sibling_path: str,
    head_reader: Callable[[str], str],
) -> str | None:
    """Return the sibling path ONLY if its HEAD equals the pinned SHA, else None."""
    return sibling_path if head_reader(sibling_path) == pin_sha else None
