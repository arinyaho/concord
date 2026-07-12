import pytest

from code_index import store
from code_index.engine import ClangdSession
from code_index.extract import DefSymbol, _inside_dep, index_boundary
from tests.fixtures import mini_ntt


def test_inside_dep_rejects_sibling_with_longer_name():
    """Decoy: dep root .../dep/include must NOT match a ref under .../dep/include-extra/."""
    dep_marker = "/some/project/dep/include"
    # this ref is under the SIBLING directory include-extra, not under include
    ref_path = "/some/project/dep/include-extra/foo/bar.h"
    # must be False -- a substring check would wrongly return True here
    assert _inside_dep(ref_path, dep_marker) is False


def test_inside_dep_accepts_path_under_dep():
    """Path genuinely inside the dep include root must return True."""
    dep_marker = "/some/project/dep/include"
    ref_path = "/some/project/dep/include/mini/ntt.hpp"
    assert _inside_dep(ref_path, dep_marker) is True


@pytest.mark.requires_clangd
def test_index_boundary_emits_cross_edge_for_mini_ntt(clangd_path, tmp_path):
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    conn = store.init_db(str(tmp_path / "index.db"))

    with ClangdSession(clangd_path, fx.compile_db_dir) as session:
        ntt_def = DefSymbol(
            def_path=fx.header_path,
            def_pos=fx.ntt_def_pos,
            kind="class",
            display_name="mini::ntt::NTT",
        )
        n_cross = index_boundary(
            conn,
            session,
            def_symbols=[ntt_def],
            dep_marker=fx.dep_include_root,  # anything under this path is "inside the dep"
            repo="mini",
            via="mini::ntt",
        )

    assert n_cross >= 1, "no cross-pin edge extracted for NTT"

    # the NTT def symbol now exists and its USR is queryable
    ntt_usr = conn.execute(
        "SELECT symbol_id FROM symbols WHERE display_name = 'mini::ntt::NTT'"
    ).fetchone()["symbol_id"]
    assert ntt_usr.startswith("c:")

    # cross_edge(NTT_usr) returns the consumer edge, cited in consumer.cpp
    edges = store.cross_edge(conn, ntt_usr)
    assert len(edges) >= 1
    e = edges[0]
    assert e["to_symbol"] == ntt_usr
    # the FROM endpoint is the enclosing consumer function (probe), not the type
    assert e["from_symbol"] == "c:@F@probe#"
    assert e["from_symbol"] != ntt_usr
    assert e["via"] == "mini::ntt"
    assert e["evidence_doc"].endswith("consumer.cpp")
    # provenance is recorded at index time (FIX 2 / I-3): the TO endpoint is the
    # pinned dep alias, the FROM endpoint is first-party -- read straight off the
    # row, not re-derived from paths.
    assert e["to_package"] == "mini::ntt"
    assert e["from_package"] == "<first-party>"


@pytest.mark.requires_clangd
def test_index_boundary_enclosing_def_hits_body_position(clangd_path, tmp_path):
    """FIX 1: the REAL pipeline must produce a consumer def span the store query can
    stab at a BODY line -- not just at the function name.

    Drives index_boundary over mini-ntt, then asserts enclosing_def(consumer_doc,
    <line of `return n.degree();`>) returns the enclosing consumer function's USR.
    That line is strictly INSIDE probe's body (not its name line), so a name-width
    span would return None here -- proving the stored span is the real body range.
    """
    import os

    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    conn = store.init_db(str(tmp_path / "index.db"))

    with ClangdSession(clangd_path, fx.compile_db_dir) as session:
        ntt_def = DefSymbol(
            def_path=fx.header_path,
            def_pos=fx.ntt_def_pos,
            kind="class",
            display_name="mini::ntt::NTT",
        )
        n_cross = index_boundary(
            conn,
            session,
            def_symbols=[ntt_def],
            dep_marker=fx.dep_include_root,
            repo="mini",
            via="mini::ntt",
        )
    assert n_cross >= 1, "no cross-pin edge extracted for NTT"

    # the consumer def USR (probe) recorded by the pipeline
    consumer_usr = "c:@F@probe#"
    consumer_doc = os.path.realpath(fx.consumer_path)

    # 0-based line of the `return n.degree() ...` statement -- strictly inside the body
    # (probe's return line; distinct from Wrapper's `return make().degree();`).
    body_line = _find_line(fx.consumer_path, "return n.degree()")

    # sanity: this line is NOT the function's name/signature line
    name_line = _find_line(fx.consumer_path, "probe()")
    assert body_line > name_line, "test setup: return line must be below the signature"

    hit = store.enclosing_def(conn, consumer_doc, body_line)
    assert hit is not None, (
        "enclosing_def returned None for a position INSIDE the function body -- "
        "the pipeline stored only a name-width span (FIX 1 regression)"
    )
    assert hit["symbol_id"] == consumer_usr, (
        f"expected body position to resolve to the consumer def {consumer_usr}, "
        f"got {hit['symbol_id']}"
    )


@pytest.mark.requires_clangd
def test_decoy_same_name_local_type_does_not_mis_bind_cross_edge(clangd_path, tmp_path):
    """FIX 1: a same-named LOCAL type (`app::NTT`) must NOT capture the cross-pin edge.

    The spec forbids a bare-name join and REQUIRES USR-unification precisely because
    a local type spelled identically to the dep type would mis-bind a name-only join.
    The fixture defines both `mini::ntt::NTT` (dep) and `app::NTT` (local decoy) with
    the SAME unqualified spelling `NTT` but DISTINCT USRs, and the consumer references
    both. This asserts:
      1. clangd assigns the two `NTT`s DISTINCT USRs (a name-join could not tell them
         apart -- that is the hazard),
      2. the stored cross_edge.to_symbol is the DEP USR, and
      3. cross_edge(local_decoy_USR) returns NOTHING -- the local type produces no
         cross-pin edge, so a name-join would have mis-bound here but USR-unification
         does not.
    """
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    conn = store.init_db(str(tmp_path / "index.db"))

    with ClangdSession(clangd_path, fx.compile_db_dir) as session:
        # Resolve BOTH USRs from the same live session (before/independent of index).
        session.open_file(fx.header_path)
        session.open_file(fx.local_header_path)
        session.open_file(fx.consumer_path)
        session.wait_for_shard("consumer.cpp", timeout=90.0)
        dep_usr = session.symbol_info(
            ClangdSession.uri_of(fx.header_path), fx.ntt_def_pos
        )
        local_usr = session.symbol_info(
            ClangdSession.uri_of(fx.local_header_path), fx.local_ntt_def_pos
        )

        ntt_def = DefSymbol(
            def_path=fx.header_path,
            def_pos=fx.ntt_def_pos,
            kind="class",
            display_name="mini::ntt::NTT",
        )
        n_cross = index_boundary(
            conn,
            session,
            def_symbols=[ntt_def],
            dep_marker=fx.dep_include_root,
            repo="mini",
            via="mini::ntt",
        )

    # (1) same spelling, DISTINCT USRs -- the whole reason a bare-name join is unsafe.
    assert dep_usr is not None and local_usr is not None
    assert dep_usr != local_usr, (
        "dep mini::ntt::NTT and local app::NTT must have distinct USRs; a name-join "
        f"on 'NTT' could not distinguish them (dep={dep_usr}, local={local_usr})"
    )
    assert dep_usr == "c:@N@mini@N@ntt@ST>1#T@NTT"
    assert local_usr == "c:@N@app@ST>1#T@NTT"

    assert n_cross >= 1, "no cross-pin edge extracted for the dep NTT"

    # (2) every stored cross_edge binds to the DEP USR, never the local decoy.
    dep_edges = store.cross_edge(conn, dep_usr)
    assert len(dep_edges) >= 1
    for e in dep_edges:
        assert e["to_symbol"] == dep_usr
        assert e["to_symbol"] != local_usr
        assert e["from_symbol"] != local_usr, (
            "a cross edge originates from the local decoy -- USR-unification failed "
            "and a name-join mis-bound the edge"
        )

    # (3) querying the local decoy USR returns NOTHING -- it produces no cross-pin edge.
    assert store.cross_edge(conn, local_usr) == [], (
        "the same-named LOCAL app::NTT produced a cross-pin edge; a bare-name join "
        "would have mis-bound to it, but USR-unification must yield zero edges here"
    )


@pytest.mark.requires_clangd
def test_dependent_context_type_edge_survives_method_ref_absent(clangd_path, tmp_path):
    """FIX 2: reproduce the real target's dependent-context, type-edge-only signal.

    The fixture's `Wrapper<W>` uses the dep type in a DEPENDENT (template-parameter)
    context (`mini::ntt::NTT<W>`) and calls a method on a DEPENDENT EXPRESSION
    (`make().degree()`). This asserts WHAT CLANGD ACTUALLY DOES (observed, not
    assumed) on the pinned clangd 19.1.7:

      - the TYPE edge IS captured: references(dep NTT) include the dependent-context
        type-use line, and the stored cross_edges contain a type edge FROM the
        `Wrapper` template (`c:@ST>1#T@Wrapper`) TO the dep NTT USR;
      - the dependent-expression METHOD call yields NO cross-pin method ref:
        references(dep `degree()`) do NOT include the `make().degree()` line
        (they include only the CONCRETE call inside `probe()`).

    This is a hermetic regression-lock on the real signal shape from the dependent-context observation:
    dependent-context member calls are unresolved by clangd, so only the type edge
    survives. See deeplens-fixB.md for the honest note on where this synthetic case
    matches vs differs from the real dependent-context consumer.
    """
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))
    conn = store.init_db(str(tmp_path / "index.db"))

    with ClangdSession(clangd_path, fx.compile_db_dir) as session:
        session.open_file(fx.header_path)
        session.open_file(fx.local_header_path)
        session.open_file(fx.consumer_path)
        session.wait_for_shard("consumer.cpp", timeout=90.0)

        dep_uri = ClangdSession.uri_of(fx.header_path)
        dep_usr = session.symbol_info(dep_uri, fx.ntt_def_pos)

        # Consumer-side reference LINES for the dep TYPE and the dep METHOD.
        type_ref_lines = {
            r["line"]
            for r in session.references(dep_uri, fx.ntt_def_pos)
            if r["uri"].endswith("consumer.cpp")
        }
        method_ref_lines = {
            r["line"]
            for r in session.references(dep_uri, fx.dep_method_def_pos)
            if r["uri"].endswith("consumer.cpp")
        }

        ntt_def = DefSymbol(
            def_path=fx.header_path,
            def_pos=fx.ntt_def_pos,
            kind="class",
            display_name="mini::ntt::NTT",
        )
        index_boundary(
            conn,
            session,
            def_symbols=[ntt_def],
            dep_marker=fx.dep_include_root,
            repo="mini",
            via="mini::ntt",
        )

    # OBSERVED: the dependent-context TYPE ref IS surfaced by clangd.
    assert fx.dependent_type_line in type_ref_lines, (
        "clangd did not surface the dependent-context dep-type ref "
        f"(line {fx.dependent_type_line}); type refs seen: {sorted(type_ref_lines)}"
    )
    # OBSERVED: the dependent-EXPRESSION method call is NOT surfaced (the dependent-context observation).
    assert fx.dependent_call_line not in method_ref_lines, (
        "clangd DID surface the dependent-expression method call "
        f"(line {fx.dependent_call_line}) -- the synthetic fixture no longer "
        "reproduces the real 'no dependent-context method ref' signal; update "
        f"the fixture and deeplens-fixB.md. Method refs seen: {sorted(method_ref_lines)}"
    )
    # Sanity: the CONCRETE method call inside probe() IS surfaced (control).
    concrete_call_line = _find_line(fx.consumer_path, "n.degree()")
    assert concrete_call_line in method_ref_lines, (
        "control failed: the concrete probe() method call must be surfaced"
    )

    # The TYPE edge survives into the store: a type cross-edge FROM the Wrapper
    # template TO the dep NTT USR. (Wrapper's enclosing-def USR is the template's.)
    wrapper_usr = "c:@ST>1#T@Wrapper"
    dep_edges = store.cross_edge(conn, dep_usr)
    wrapper_edges = [
        e for e in dep_edges
        if e["from_symbol"] == wrapper_usr and e["to_symbol"] == dep_usr
    ]
    assert wrapper_edges, (
        "the dependent-context TYPE edge (Wrapper -> mini::ntt::NTT) was not stored; "
        f"cross edges from Wrapper: {[dict(e) for e in dep_edges]}"
    )
    assert all(e["kind"] == "type" for e in wrapper_edges)
    # No cross edge is a 'call'/method edge -- only the type edge survived.
    assert all(e["kind"] == "type" for e in dep_edges), (
        "a non-type (method/call) cross edge was stored for the dependent context; "
        "only the TYPE edge should survive"
    )


def _find_line(path: str, needle: str) -> int:
    """0-based line number of the first line containing `needle`."""
    with open(path) as fh:
        for i, line in enumerate(fh):
            if needle in line:
                return i
    raise AssertionError(f"{needle!r} not found in {path}")


# ---------------------------------------------------------------------------
# Clangd-free fail-honest contract tests
# These tests stub the session duck-type so the fail-honest AC runs in any CI
# without a clangd binary.
# ---------------------------------------------------------------------------


class _StubSession:
    """Minimal duck-type of ClangdSession for index_boundary stub tests.

    Implements only the methods index_boundary calls:
      consumer_files(), open_file(), wait_for_shard(),
      references(), symbol_info(), document_symbols()
    """

    def __init__(self, *, consumer_files, symbol_info_map, references_map, document_symbols_map):
        self._consumer_files = consumer_files
        self._symbol_info_map = symbol_info_map     # (uri, pos_line) -> usr or None
        self._references_map = references_map       # header_uri -> [ref dicts]
        self._document_symbols_map = document_symbols_map  # ref_uri -> [sym dicts]

    def consumer_files(self):
        return list(self._consumer_files)

    def open_file(self, path):
        pass  # no-op: stub does not start a real process

    def wait_for_shard(self, basename, timeout=90.0):
        return True  # immediately ready

    def references(self, header_uri, pos):
        return list(self._references_map.get(header_uri, []))

    def symbol_info(self, uri, pos):
        return self._symbol_info_map.get((uri, pos["line"]))

    def document_symbols(self, uri):
        return list(self._document_symbols_map.get(uri, []))


def test_fail_honest_unresolved_consumer_usr_yields_no_cross_edge(tmp_path):
    """AC: consumer-side symbol_info returns None -> NO cross_edge row written.

    No clangd required: a stub session drives index_boundary end-to-end.
    The def USR resolves fine; the consumer-side symbol_info returns None
    (simulating an unresolved symbol). Assert zero cross_edges rows.
    """
    from code_index import store
    from code_index.extract import DefSymbol, index_boundary

    dep_dir = tmp_path / "dep" / "include" / "mini"
    dep_dir.mkdir(parents=True)
    header = dep_dir / "ntt.hpp"
    header.write_text("// stub header\nclass NTT {};\n")

    consumer_file = tmp_path / "app" / "consumer.cpp"
    consumer_file.parent.mkdir(parents=True)
    consumer_file.write_text("// stub consumer\n#include <mini/ntt.hpp>\nvoid probe() {}\n")

    dep_include_root = str(tmp_path / "dep" / "include")

    header_abs = str(header.resolve())
    consumer_abs = str(consumer_file.resolve())
    header_uri = ClangdSession.uri_of(header_abs)
    consumer_uri = ClangdSession.uri_of(consumer_abs)

    DEF_USR = "c:@ST>1#T@NTT"
    REF_LINE = 2

    consumer_syms = [
        {
            "name": "probe",
            "range_start_line": REF_LINE,
            "range_end_line": REF_LINE,
            "sel_line": REF_LINE,
            "sel_char": 5,
        }
    ]

    # def-site resolves; consumer site intentionally absent -> symbol_info returns None
    symbol_info_map = {
        (header_uri, 1): DEF_USR,
    }

    stub = _StubSession(
        consumer_files=[consumer_abs],
        symbol_info_map=symbol_info_map,
        references_map={
            header_uri: [{"uri": consumer_abs, "line": REF_LINE, "character": 0}]
        },
        document_symbols_map={consumer_uri: consumer_syms},
    )

    conn = store.init_db(":memory:")
    def_sym = DefSymbol(
        def_path=header_abs,
        def_pos={"line": 1, "character": 6},
        kind="class",
        display_name="NTT",
    )

    n = index_boundary(conn, stub, def_symbols=[def_sym], dep_marker=dep_include_root,
                       repo="stub", via="mini::ntt")

    assert n == 0, f"expected 0 cross-edges (unresolved consumer), got {n}"
    rows = conn.execute("SELECT COUNT(*) FROM cross_edges").fetchone()[0]
    assert rows == 0, f"expected 0 rows in cross_edges, got {rows}"


def test_fail_honest_resolved_consumer_usr_emits_cross_edge(tmp_path):
    """Positive control: consumer-side symbol_info returns a USR -> ONE cross_edge row.

    No clangd required. Same stub setup but consumer symbol_info returns a real USR.
    Assert exactly one cross_edges row with correct endpoints.
    """
    from code_index import store
    from code_index.extract import DefSymbol, index_boundary

    dep_dir = tmp_path / "dep" / "include" / "mini"
    dep_dir.mkdir(parents=True)
    header = dep_dir / "ntt.hpp"
    header.write_text("// stub header\nclass NTT {};\n")

    consumer_file = tmp_path / "app" / "consumer.cpp"
    consumer_file.parent.mkdir(parents=True)
    consumer_file.write_text("// stub consumer\n#include <mini/ntt.hpp>\nvoid probe() {}\n")

    dep_include_root = str(tmp_path / "dep" / "include")

    header_abs = str(header.resolve())
    consumer_abs = str(consumer_file.resolve())
    header_uri = ClangdSession.uri_of(header_abs)
    consumer_uri = ClangdSession.uri_of(consumer_abs)

    DEF_USR = "c:@ST>1#T@NTT"
    CONSUMER_USR = "c:@F@probe#"
    REF_LINE = 2

    consumer_syms = [
        {
            "name": "probe",
            "range_start_line": REF_LINE,
            "range_end_line": REF_LINE,
            "sel_line": REF_LINE,
            "sel_char": 5,
        }
    ]

    symbol_info_map = {
        (header_uri, 1): DEF_USR,
        (consumer_uri, REF_LINE): CONSUMER_USR,  # consumer resolves
    }

    stub = _StubSession(
        consumer_files=[consumer_abs],
        symbol_info_map=symbol_info_map,
        references_map={
            header_uri: [{"uri": consumer_abs, "line": REF_LINE, "character": 0}]
        },
        document_symbols_map={consumer_uri: consumer_syms},
    )

    conn = store.init_db(":memory:")
    def_sym = DefSymbol(
        def_path=header_abs,
        def_pos={"line": 1, "character": 6},
        kind="class",
        display_name="NTT",
    )

    n = index_boundary(conn, stub, def_symbols=[def_sym], dep_marker=dep_include_root,
                       repo="stub", via="mini::ntt")

    assert n == 1, f"expected 1 cross-edge (resolved consumer), got {n}"
    rows = conn.execute("SELECT COUNT(*) FROM cross_edges").fetchone()[0]
    assert rows == 1, f"expected 1 row in cross_edges, got {rows}"
    edge = conn.execute("SELECT * FROM cross_edges").fetchone()
    assert edge["from_symbol"] == CONSUMER_USR
    assert edge["to_symbol"] == DEF_USR
    assert edge["via"] == "mini::ntt"
    # provenance populated at index time (FIX 2): consumer = first-party, dep = via
    assert edge["from_package"] == "<first-party>"
    assert edge["to_package"] == "mini::ntt"
