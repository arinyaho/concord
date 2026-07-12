import pytest

from code_index import cli
from tests.fixtures import mini_ntt


def test_cli_index_without_dep_marker_fails_loudly(tmp_path):
    """FIX 3: `index` WITHOUT --dep-marker must ERROR clearly, not silently index a
    wrong root.

    Previously the CLI defaulted the marker to "include", which on a real multi-dep
    compile DB matches the FIRST `-I .../_deps/*/include` root (the WRONG dep). Now
    the flag is required: absent it, the command exits with a message naming the flag
    -- and crucially fails BEFORE starting clangd or writing any index. No clangd
    needed (the guard precedes clangd resolution).
    """
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    db = str(tmp_path / "index.db")

    import os

    with pytest.raises(SystemExit) as ei:
        cli.main(["index", "--compile-db", fx.compile_db_dir, "--db", db])

    msg = str(ei.value)
    assert "--dep-marker" in msg, f"error must name the missing flag, got: {msg!r}"
    # fail-honest: no index DB was written by the aborted run
    assert not os.path.exists(db), "aborted index must not have written a store"


def test_cli_index_with_nonexistent_dep_marker_fails_loudly(tmp_path):
    """FIX 3: a --dep-marker that is not a real directory must ERROR, not proceed."""
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    db = str(tmp_path / "index.db")
    bogus = str(tmp_path / "no" / "such" / "include")

    with pytest.raises(SystemExit) as ei:
        cli.main([
            "index",
            "--compile-db", fx.compile_db_dir,
            "--db", db,
            "--dep-marker", bogus,
        ])
    assert "--dep-marker" in str(ei.value)


@pytest.mark.requires_clangd
def test_cli_index_then_query_cross_edge_prints_row(clangd_path, tmp_path, capsys, monkeypatch):
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    db = str(tmp_path / "index.db")
    monkeypatch.setenv("CODE_INDEX_CLANGD", clangd_path)

    rc = cli.main([
        "index",
        "--compile-db", fx.compile_db_dir,
        "--db", db,
        "--dep-marker", fx.dep_include_root,
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "indexed:" in out
    assert "cross-edge" in out

    # discover the NTT USR to query it back
    import sqlite3
    conn = sqlite3.connect(db)
    ntt_usr = conn.execute(
        "SELECT symbol_id FROM symbols WHERE display_name = 'mini::ntt::NTT'"
    ).fetchone()[0]

    rc2 = cli.main(["query", "cross-edge", "--db", db, ntt_usr])
    assert rc2 == 0
    out2 = capsys.readouterr().out
    assert ntt_usr in out2
    assert "consumer.cpp" in out2
    assert "mini::ntt" in out2  # the via alias is printed
