"""Shared clangd resolver: enforces the pinned-wheel constraint.

This module is the SINGLE authoritative resolver for the clangd binary path.
All code paths (CLI, test fixtures) must use `resolve_clangd()` from here -- do
NOT add `shutil.which("clangd")` or hardcoded system paths anywhere in this
package.  The Global Constraint is: clangd is pinned to the `clangd==19.1.7`
PyPI wheel; no silent fallback to a system clangd (version skew breaks
cross-edge USR stability).

Resolution order
----------------
(a) $CODE_INDEX_CLANGD env var, if set and the path exists.
(b) The data-bin binary shipped by the `clangd==19.1.7` PyPI wheel
    (importable as `clangd._get_executable("clangd")`).
(c) None -- the caller decides whether to fail hard (CLI) or skip (tests).
"""

import os


def resolve_clangd() -> str | None:
    """Return the clangd binary path, or None if neither pinned source is found.

    Enforces the pinned-wheel constraint: NO shutil.which fallback, NO hardcoded
    system paths.  Callers must raise/skip on None; do not add a system fallback.
    """
    # (a) explicit override -- useful in CI or local dev with a custom build
    env = os.environ.get("CODE_INDEX_CLANGD")
    if env and os.path.exists(env):
        return env

    # (b) pinned wheel binary (clangd==19.1.7)
    try:
        import clangd as _clangd_pkg  # noqa: PLC0415

        candidate = str(_clangd_pkg._get_executable("clangd"))
        if os.path.exists(candidate):
            return candidate
    except Exception:  # noqa: BLE001
        pass

    # (c) neither source available
    return None
