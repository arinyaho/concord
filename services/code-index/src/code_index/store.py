"""SQLite store for the INDEX sub-system (Stage-1).

Single store: struct tables + an rtree range index (def_ranges) + an FTS5 trigram
vtable. symbol_id is the clang USR string (a TEXT primary key). The rtree keys on
integers only, so `symbol_rowids` maps each USR to a stable integer surrogate.
"""

import sqlite3

# clangd RefKind Definition bit (0x2). The clangd RefKind enum is:
#   Declaration=0x1, Definition=0x2, Reference=0x4, Spelled=0x8.
# v1 needs only Definition-vs-Reference: a reference occurrence has this bit UNSET,
# which is how callers_of finds usage sites.
ROLE_DEFINITION = 0x2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS symbols (
    symbol_id    TEXT PRIMARY KEY,   -- clang USR string
    package      TEXT,               -- empty for C++ (no package-manager component)
    kind         TEXT,
    def_doc      TEXT,
    def_start    INTEGER,
    def_end      INTEGER,
    display_name TEXT
);

-- Integer surrogate for the rtree (rtree rowids must be integers; USRs are strings).
CREATE TABLE IF NOT EXISTS symbol_rowids (
    symbol_id TEXT PRIMARY KEY,
    rid       INTEGER UNIQUE
);

CREATE TABLE IF NOT EXISTS occurrences (
    symbol_id TEXT,
    doc       TEXT,
    start     INTEGER,
    end       INTEGER,
    roles     INTEGER   -- packed clangd RefKind bits; ROLE_DEFINITION marks a def
);
CREATE INDEX IF NOT EXISTS idx_occ_symbol ON occurrences(symbol_id);
CREATE INDEX IF NOT EXISTS idx_occ_doc_start ON occurrences(doc, start);

-- Materialized at index time: each reference occurrence resolved to its enclosing def.
CREATE TABLE IF NOT EXISTS call_edges (
    caller_symbol TEXT,
    callee_symbol TEXT,
    repo          TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_caller ON call_edges(caller_symbol);
CREATE INDEX IF NOT EXISTS idx_call_callee ON call_edges(callee_symbol);

CREATE TABLE IF NOT EXISTS cross_edges (
    from_symbol    TEXT,
    to_symbol      TEXT,
    kind           TEXT,   -- e.g. 'type' or 'call'
    via            TEXT,   -- canonical CMake alias (the build-contract identity)
    from_package   TEXT,   -- canonical package/alias slug of the FROM endpoint (provenance)
    to_package     TEXT,   -- canonical package/alias slug of the TO endpoint (provenance)
    evidence_doc   TEXT,   -- binding-site citation (nullable)
    evidence_start INTEGER,
    evidence_end   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cross_from ON cross_edges(from_symbol);
CREATE INDEX IF NOT EXISTS idx_cross_to   ON cross_edges(to_symbol);

-- Range-containment index for enclosing_def. Keyed by the integer surrogate rid;
-- +doc is an rtree auxiliary column (SQLite >= 3.24), post-filtered after the stab.
CREATE VIRTUAL TABLE IF NOT EXISTS def_ranges USING rtree(
    rid,
    start, end,
    +doc TEXT
);

-- Sparse signal: FTS5 trigram over identifiers / display names.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
    symbol_id UNINDEXED,
    text,
    tokenize = 'trigram'
);
"""


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    conn.commit()


def init_db(path: str) -> sqlite3.Connection:
    """Open/create the store at `path`, run the DDL idempotently, return the conn."""
    major, minor, _ = (int(x) for x in sqlite3.sqlite_version.split("."))
    if (major, minor) < (3, 24):
        raise RuntimeError(
            f"SQLite >= 3.24 required (rtree aux column); found {sqlite3.sqlite_version}"
        )
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _create_schema(conn)
    return conn


def insert_symbol(
    conn: sqlite3.Connection,
    symbol_id: str,
    kind: str,
    def_doc: str,
    def_start: int,
    def_end: int,
    display_name: str,
    package: str = "",
) -> None:
    """UPSERT a symbol row (idempotent on symbol_id) and mirror it into FTS."""
    with conn:
        conn.execute(
            """
            INSERT INTO symbols (symbol_id, package, kind, def_doc, def_start, def_end, display_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol_id) DO UPDATE SET
                package=excluded.package, kind=excluded.kind, def_doc=excluded.def_doc,
                def_start=excluded.def_start, def_end=excluded.def_end,
                display_name=excluded.display_name
            """,
            (symbol_id, package, kind, def_doc, def_start, def_end, display_name),
        )
        # keep FTS in lockstep: drop any prior row for this USR, then insert
        conn.execute("DELETE FROM fts_symbols WHERE symbol_id = ?", (symbol_id,))
        conn.execute(
            "INSERT INTO fts_symbols (symbol_id, text) VALUES (?, ?)",
            (symbol_id, f"{display_name} {symbol_id}"),
        )


def _rowid_for(conn: sqlite3.Connection, symbol_id: str) -> int:
    """Allocate/fetch the stable integer surrogate rid for a USR (rtree key).

    NOTE: MAX+1 allocation is safe only for Stage-1 single-writer ingestion;
    switch to AUTOINCREMENT or INSERT OR IGNORE if concurrent writers are added.
    """
    row = conn.execute(
        "SELECT rid FROM symbol_rowids WHERE symbol_id = ?", (symbol_id,)
    ).fetchone()
    if row is not None:
        return row["rid"]
    nxt = conn.execute("SELECT COALESCE(MAX(rid), 0) + 1 AS n FROM symbol_rowids").fetchone()["n"]
    conn.execute(
        "INSERT INTO symbol_rowids (symbol_id, rid) VALUES (?, ?)", (symbol_id, nxt)
    )
    return nxt


def insert_occurrence(
    conn: sqlite3.Connection,
    symbol_id: str,
    doc: str,
    start: int,
    end: int,
    roles: int,
) -> None:
    """Append an occurrence; a Definition occurrence also seeds def_ranges."""
    with conn:
        conn.execute(
            "INSERT INTO occurrences (symbol_id, doc, start, end, roles) VALUES (?, ?, ?, ?, ?)",
            (symbol_id, doc, start, end, roles),
        )
        if roles & ROLE_DEFINITION:
            rid = _rowid_for(conn, symbol_id)
            # replace any prior def range for this rid (a symbol has one def span)
            conn.execute("DELETE FROM def_ranges WHERE rid = ?", (rid,))
            conn.execute(
                "INSERT INTO def_ranges (rid, start, end, doc) VALUES (?, ?, ?, ?)",
                (rid, start, end, doc),
            )


def enclosing_def(
    conn: sqlite3.Connection, doc: str, pos: int
) -> sqlite3.Row | None:
    """Smallest def span containing `pos` in `doc` -> its symbols row (or None).

    POSITION UNIT: `pos` and the stored def_ranges start/end are integers in ONE
    unit chosen by the writer; this query only requires writer + query to agree.
    The real pipeline (extract.index_boundary) writes LINE NUMBERS (0-based), so a
    changed-line query -- the retriever's actual use case -- stabs the enclosing
    def by line-containment. The store-unit tests pass arbitrary integers and are
    unit-agnostic; they exercise containment/nesting/doc-boundary logic only.
    """
    hit = conn.execute(
        """
        SELECT r.rid AS rid
        FROM def_ranges r
        WHERE r.start <= ? AND r.end >= ? AND r.doc = ?
        ORDER BY (r.end - r.start) ASC
        LIMIT 1
        """,
        (pos, pos, doc),
    ).fetchone()
    if hit is None:
        return None
    return conn.execute(
        """
        SELECT s.* FROM symbols s
        JOIN symbol_rowids m ON m.symbol_id = s.symbol_id
        WHERE m.rid = ?
        """,
        (hit["rid"],),
    ).fetchone()


def def_(conn: sqlite3.Connection, usr: str) -> sqlite3.Row | None:
    """Point lookup of a symbol definition by its USR.

    Assumes conn.row_factory = sqlite3.Row (set by init_db); callers using a raw
    sqlite3.connect() must set this themselves or dict-style column access will fail.
    """
    return conn.execute("SELECT * FROM symbols WHERE symbol_id = ?", (usr,)).fetchone()


def materialize_call_edges(conn: sqlite3.Connection, repo: str = "") -> int:
    """Resolve every reference occurrence to its enclosing def; write call_edges.

    A batch-LSP find-references returns bare locations (no container), so callers
    are resolved via the enclosing_def rtree stab -- the portable path. Idempotent:
    clears this repo's edges first. Returns the number of edges written.
    """
    rows = conn.execute(
        "SELECT symbol_id, doc, start FROM occurrences WHERE (roles & ?) = 0",
        (ROLE_DEFINITION,),
    ).fetchall()
    edges = []
    for occ in rows:
        caller_row = enclosing_def(conn, occ["doc"], occ["start"])
        if caller_row is None:
            continue
        caller = caller_row["symbol_id"]
        if caller == occ["symbol_id"]:
            # a def's own body referencing itself is not a call edge
            continue
        edges.append((caller, occ["symbol_id"], repo))
    with conn:
        conn.execute("DELETE FROM call_edges WHERE repo = ?", (repo,))
        conn.executemany(
            "INSERT INTO call_edges (caller_symbol, callee_symbol, repo) VALUES (?, ?, ?)",
            edges,
        )
    return len(edges)


def callers_of(conn: sqlite3.Connection, usr: str) -> list[str]:
    """Distinct caller USRs of `usr`, from the materialized call_edges."""
    return [
        r["caller_symbol"]
        for r in conn.execute(
            "SELECT DISTINCT caller_symbol FROM call_edges WHERE callee_symbol = ? "
            "ORDER BY caller_symbol",
            (usr,),
        )
    ]


def insert_cross_edge(
    conn: sqlite3.Connection,
    from_symbol: str,
    to_symbol: str,
    kind: str,
    via: str,
    from_package: str | None = None,
    to_package: str | None = None,
    evidence_doc: str | None = None,
    evidence_start: int | None = None,
    evidence_end: int | None = None,
) -> None:
    """Append one cross-repo edge (USR endpoints; via = canonical CMake alias).

    from_package / to_package carry each endpoint's canonical package/alias slug so
    the I-3 "which repo is each end in" report reads provenance straight from the
    row instead of re-deriving repo identity from path strings. Nullable so legacy
    call sites keep working; the real index_boundary call site populates both.
    """
    with conn:
        conn.execute(
            """
            INSERT INTO cross_edges
                (from_symbol, to_symbol, kind, via,
                 from_package, to_package, evidence_doc, evidence_start, evidence_end)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                from_symbol, to_symbol, kind, via,
                from_package, to_package, evidence_doc, evidence_start, evidence_end,
            ),
        )


def cross_edge(conn: sqlite3.Connection, usr: str) -> list[sqlite3.Row]:
    """Every cross edge where `usr` is the from- OR to- endpoint."""
    return conn.execute(
        """
        SELECT * FROM cross_edges
        WHERE from_symbol = ? OR to_symbol = ?
        ORDER BY from_symbol, to_symbol, kind
        """,
        (usr, usr),
    ).fetchall()


def k_hop(conn: sqlite3.Connection, usr: str, k: int, fan_out: int = 64) -> set[str]:
    """Symbols reachable from `usr` within k directed hops over call+cross edges.

    k is clamped to <= 3; each node expands at most `fan_out` out-edges (a
    per-node cap that bounds fan-out on hub nodes). The start node is excluded.
    """
    depth = max(0, min(k, 3))
    if depth == 0:
        return set()
    rows = conn.execute(
        """
        WITH edges(src, dst) AS (
            SELECT caller_symbol, callee_symbol FROM call_edges
            UNION ALL
            SELECT from_symbol, to_symbol FROM cross_edges
        ),
        -- rank out-edges per source so the fan-out cap is deterministic
        capped(src, dst) AS (
            SELECT src, dst FROM (
                SELECT src, dst,
                       ROW_NUMBER() OVER (PARTITION BY src ORDER BY dst) AS rn
                FROM edges
            ) WHERE rn <= :fan
        ),
        walk(node, depth) AS (
            SELECT :start, 0
            UNION
            SELECT c.dst, w.depth + 1
            FROM walk w
            JOIN capped c ON c.src = w.node
            WHERE w.depth < :maxd
        )
        SELECT DISTINCT node FROM walk WHERE node <> :start
        """,
        {"start": usr, "maxd": depth, "fan": fan_out},
    ).fetchall()
    return {r["node"] for r in rows}


def fts_search(conn: sqlite3.Connection, q: str) -> list[str]:
    """Symbol USRs whose identifier/display text matches the trigram query `q`."""
    if len(q) < 3:
        return []  # trigram tokenizer needs at least 3 characters to match
    rows = conn.execute(
        "SELECT DISTINCT symbol_id FROM fts_symbols WHERE text MATCH ? ORDER BY symbol_id",
        (q,),
    ).fetchall()
    return [r["symbol_id"] for r in rows]
