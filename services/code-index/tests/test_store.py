import sqlite3

from code_index import store


def test_init_db_creates_all_tables_and_enforces_sqlite_version():
    conn = store.init_db(":memory:")

    names = {
        r["name"]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    # struct tables + the rtree shadow + the fts shadow are all present
    assert {"symbols", "symbol_rowids", "occurrences", "call_edges", "cross_edges"} <= names
    assert "def_ranges" in names          # rtree main table
    assert "fts_symbols" in names         # fts5 main table

    # SQLite floor (rtree aux column needs >= 3.24)
    major, minor, _ = (int(x) for x in sqlite3.sqlite_version.split("."))
    assert (major, minor) >= (3, 24)


def test_init_db_is_idempotent():
    conn = store.init_db(":memory:")
    # running the DDL again on the same connection must not raise
    store._create_schema(conn)
    assert conn.execute("SELECT count(*) FROM symbols").fetchone()[0] == 0


def test_insert_symbol_then_def_lookup_roundtrips():
    conn = store.init_db(":memory:")
    usr = "c:@N@mini@N@ntt@ST>1#T@NTT"
    store.insert_symbol(
        conn,
        symbol_id=usr,
        kind="class",
        def_doc="/abs/dep/include/mini/ntt.hpp",
        def_start=120,
        def_end=460,
        display_name="mini::ntt::NTT",
    )

    row = store.def_(conn, usr)
    assert row is not None
    assert row["symbol_id"] == usr
    assert row["kind"] == "class"
    assert row["def_doc"].endswith("mini/ntt.hpp")
    assert (row["def_start"], row["def_end"]) == (120, 460)
    assert row["display_name"] == "mini::ntt::NTT"

    # FTS mirror must contain exactly one row for this symbol_id
    fts_count = conn.execute(
        "SELECT count(*) FROM fts_symbols WHERE symbol_id = ?", (usr,)
    ).fetchone()[0]
    assert fts_count == 1


def test_insert_symbol_is_idempotent_upsert():
    conn = store.init_db(":memory:")
    usr = "c:@N@mini@N@ntt@ST>1#T@NTT"
    store.insert_symbol(conn, usr, "class", "/a.hpp", 1, 2, "old")
    store.insert_symbol(conn, usr, "class", "/a.hpp", 1, 2, "new")  # re-insert = update
    assert conn.execute("SELECT count(*) FROM symbols").fetchone()[0] == 1
    assert store.def_(conn, usr)["display_name"] == "new"

    # FTS mirror must have exactly one row (not two) and reflect the updated display_name
    fts_count = conn.execute(
        "SELECT count(*) FROM fts_symbols WHERE symbol_id = ?", (usr,)
    ).fetchone()[0]
    assert fts_count == 1
    fts_row = conn.execute(
        "SELECT text FROM fts_symbols WHERE symbol_id = ?", (usr,)
    ).fetchone()
    assert fts_row is not None
    assert "new" in fts_row[0]


def test_def_missing_returns_none():
    conn = store.init_db(":memory:")
    assert store.def_(conn, "c:@N@nope") is None


def test_enclosing_def_returns_containing_definition():
    conn = store.init_db(":memory:")
    caller = "c:@F@compute"
    store.insert_symbol(conn, caller, "function", "/app/consumer.cpp", 100, 300, "compute")
    # the def occurrence spans [100,300] in consumer.cpp
    store.insert_occurrence(conn, caller, "/app/consumer.cpp", 100, 300, store.ROLE_DEFINITION)

    hit = store.enclosing_def(conn, "/app/consumer.cpp", 150)
    assert hit is not None
    assert hit["symbol_id"] == caller


def test_enclosing_def_smallest_span_wins_on_nesting():
    conn = store.init_db(":memory:")
    outer, inner = "c:@F@outer", "c:@F@inner"
    store.insert_symbol(conn, outer, "function", "/app/x.cpp", 0, 1000, "outer")
    store.insert_symbol(conn, inner, "function", "/app/x.cpp", 200, 400, "inner")
    store.insert_occurrence(conn, outer, "/app/x.cpp", 0, 1000, store.ROLE_DEFINITION)
    store.insert_occurrence(conn, inner, "/app/x.cpp", 200, 400, store.ROLE_DEFINITION)

    # pos 300 is inside BOTH spans; the smaller (inner) must win
    assert store.enclosing_def(conn, "/app/x.cpp", 300)["symbol_id"] == inner
    # pos 100 is only inside outer
    assert store.enclosing_def(conn, "/app/x.cpp", 100)["symbol_id"] == outer


def test_enclosing_def_respects_doc_boundary():
    conn = store.init_db(":memory:")
    s = "c:@F@f"
    store.insert_symbol(conn, s, "function", "/app/a.cpp", 0, 500, "f")
    store.insert_occurrence(conn, s, "/app/a.cpp", 0, 500, store.ROLE_DEFINITION)
    # same offset, different doc -> no hit
    assert store.enclosing_def(conn, "/app/b.cpp", 100) is None


def test_reference_occurrence_does_not_create_def_range():
    conn = store.init_db(":memory:")
    s = "c:@F@f"
    store.insert_symbol(conn, s, "function", "/app/a.cpp", 0, 500, "f")
    # a plain reference (Definition bit unset) must NOT become a def range
    store.insert_occurrence(conn, s, "/app/a.cpp", 700, 710, 0)
    assert store.enclosing_def(conn, "/app/a.cpp", 705) is None


def test_materialize_call_edges_resolves_caller_via_enclosing_def():
    conn = store.init_db(":memory:")
    caller = "c:@F@compute"
    callee = "c:@F@helper"
    # caller is DEFINED spanning [100,300] in consumer.cpp
    store.insert_symbol(conn, caller, "function", "/app/consumer.cpp", 100, 300, "compute")
    store.insert_occurrence(conn, caller, "/app/consumer.cpp", 100, 300, store.ROLE_DEFINITION)
    # callee is referenced (Definition bit unset) at offset 150 -- inside caller's def span
    store.insert_symbol(conn, callee, "function", "/lib/helper.cpp", 10, 40, "helper")
    store.insert_occurrence(conn, callee, "/app/consumer.cpp", 150, 156, 0)

    n = store.materialize_call_edges(conn, repo="mini")
    assert n == 1
    assert store.callers_of(conn, callee) == [caller]
    assert store.callers_of(conn, caller) == []  # nobody calls the caller


def test_materialize_call_edges_is_idempotent():
    conn = store.init_db(":memory:")
    caller, callee = "c:@F@a", "c:@F@b"
    store.insert_symbol(conn, caller, "function", "/x.cpp", 0, 100, "a")
    store.insert_occurrence(conn, caller, "/x.cpp", 0, 100, store.ROLE_DEFINITION)
    store.insert_symbol(conn, callee, "function", "/y.cpp", 0, 5, "b")
    store.insert_occurrence(conn, callee, "/x.cpp", 50, 51, 0)

    store.materialize_call_edges(conn, repo="mini")
    store.materialize_call_edges(conn, repo="mini")  # re-run must not duplicate
    assert conn.execute("SELECT count(*) FROM call_edges").fetchone()[0] == 1


def test_reference_outside_any_def_yields_no_edge():
    conn = store.init_db(":memory:")
    callee = "c:@F@b"
    store.insert_symbol(conn, callee, "function", "/y.cpp", 0, 5, "b")
    # a reference at file scope (no enclosing def) -> no caller -> no edge
    store.insert_occurrence(conn, callee, "/x.cpp", 9999, 10000, 0)
    assert store.materialize_call_edges(conn, repo="mini") == 0
    assert store.callers_of(conn, callee) == []


def test_cross_edge_matches_from_and_to_endpoints():
    conn = store.init_db(":memory:")
    ntt = "c:@N@mini@N@ntt@ST>1#T@NTT"
    consumer = "c:@F@probe"
    store.insert_cross_edge(
        conn,
        from_symbol=consumer,
        to_symbol=ntt,
        kind="type",
        via="mini::ntt",
        from_package="<first-party>",
        to_package="mini::ntt",
        evidence_doc="/app/consumer.cpp",
        evidence_start=74,
        evidence_end=90,
    )

    # queried from the TO endpoint (the def side)
    to_rows = store.cross_edge(conn, ntt)
    assert len(to_rows) == 1
    assert to_rows[0]["from_symbol"] == consumer
    assert to_rows[0]["to_symbol"] == ntt
    assert to_rows[0]["kind"] == "type"
    assert to_rows[0]["via"] == "mini::ntt"
    # provenance columns carried per endpoint (I-3 report reads these directly)
    assert to_rows[0]["from_package"] == "<first-party>"
    assert to_rows[0]["to_package"] == "mini::ntt"
    assert to_rows[0]["evidence_doc"].endswith("consumer.cpp")

    # queried from the FROM endpoint (the consumer side) -> same edge
    from_rows = store.cross_edge(conn, consumer)
    assert len(from_rows) == 1
    assert from_rows[0]["to_symbol"] == ntt


def test_cross_edge_absent_symbol_returns_empty():
    conn = store.init_db(":memory:")
    assert store.cross_edge(conn, "c:@N@nope") == []


def test_cross_edge_nullable_evidence():
    conn = store.init_db(":memory:")
    store.insert_cross_edge(conn, "c:@F@a", "c:@F@b", kind="call", via="lib::x")
    row = store.cross_edge(conn, "c:@F@a")[0]
    assert row["evidence_doc"] is None
    assert row["evidence_start"] is None
    # package provenance is optional too: legacy call sites omit it -> NULL
    assert row["from_package"] is None
    assert row["to_package"] is None


def test_k_hop_walks_call_and_cross_edges_within_k():
    conn = store.init_db(":memory:")
    # a -> b (call), b -> c (cross), c -> d (call)
    conn.execute("INSERT INTO call_edges VALUES ('a','b','mini')")
    conn.execute("INSERT INTO cross_edges (from_symbol,to_symbol,kind,via) VALUES ('b','c','type','x')")
    conn.execute("INSERT INTO call_edges VALUES ('c','d','mini')")
    conn.commit()

    assert store.k_hop(conn, "a", 1) == {"b"}
    assert store.k_hop(conn, "a", 2) == {"b", "c"}
    assert store.k_hop(conn, "a", 3) == {"b", "c", "d"}


def test_k_hop_clamps_k_to_three():
    conn = store.init_db(":memory:")
    # chain a->b->c->d->e (5 nodes, 4 hops); k=99 must still stop at depth 3 (=> {b,c,d})
    for x, y in [("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")]:
        conn.execute("INSERT INTO call_edges VALUES (?,?,'mini')", (x, y))
    conn.commit()
    assert store.k_hop(conn, "a", 99) == {"b", "c", "d"}


def test_k_hop_excludes_start_and_handles_cycle():
    conn = store.init_db(":memory:")
    # cycle a->b->a; must terminate and exclude the start node from the result
    conn.execute("INSERT INTO call_edges VALUES ('a','b','mini')")
    conn.execute("INSERT INTO call_edges VALUES ('b','a','mini')")
    conn.commit()
    assert store.k_hop(conn, "a", 3) == {"b"}


def test_fts_search_finds_symbol_by_substring():
    conn = store.init_db(":memory:")
    store.insert_symbol(conn, "c:@N@mini@N@ntt@ST>1#T@NTT", "class",
                        "/a.hpp", 1, 2, "mini::ntt::NTT")
    store.insert_symbol(conn, "c:@F@degree", "function",
                        "/a.hpp", 3, 4, "mini::ntt::degree")
    store.insert_symbol(conn, "c:@F@unrelated", "function",
                        "/a.hpp", 5, 6, "some::other::thing")

    hits = store.fts_search(conn, "degree")
    assert "c:@F@degree" in hits
    assert "c:@F@unrelated" not in hits


def test_fts_search_short_query_returns_empty():
    conn = store.init_db(":memory:")
    store.insert_symbol(conn, "c:@F@x", "function", "/a.hpp", 1, 2, "xx")
    assert store.fts_search(conn, "xx") == []  # < 3 chars, trigram cannot match


def test_fts_search_tracks_upsert():
    conn = store.init_db(":memory:")
    usr = "c:@F@x"
    store.insert_symbol(conn, usr, "function", "/a.hpp", 1, 2, "alphaname")
    store.insert_symbol(conn, usr, "function", "/a.hpp", 1, 2, "betaname")  # renamed
    assert store.fts_search(conn, "alphaname") == []      # old text gone
    assert usr in store.fts_search(conn, "betaname")      # new text present
