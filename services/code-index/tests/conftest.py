"""Shared pytest fixtures for the code-index suite.

Resolves the pinned clangd for `@pytest.mark.requires_clangd` tests via the
single shared resolver `code_index._clangd.resolve_clangd`.  Resolution order
is documented there:
  1. $CODE_INDEX_CLANGD env var if set and the path exists (explicit override).
  2. The data-bin binary shipped by the `clangd==19.1.7` PyPI wheel.
  3. Skip -- no silent fallback to a system clangd; that would defeat pinning.
"""

import pytest

from code_index._clangd import resolve_clangd


@pytest.fixture(scope="session")
def clangd_path() -> str:
    path = resolve_clangd()
    if path is None:
        pytest.skip(
            "no pinned clangd binary found; install the dev extras: "
            "uv sync --extra dev  (provides clangd==19.1.7)"
        )
    return path
