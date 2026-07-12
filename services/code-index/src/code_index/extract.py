"""index_boundary: drive ClangdSession over a compile DB + exported def symbols,
emit symbols/occurrences/cross_edges into the store, then materialize call edges.

The cross-pin extraction mechanism, in-code: the cross-pin edge is emitted ONLY when clangd
unifies both endpoints on a byte-identical USR. A ref whose consumer-side USR does
not resolve is dropped (fail-honest -- an unresolved edge is ABSENT, never faked).
"""

import os
import sqlite3
import time
from dataclasses import dataclass

from code_index import store
from code_index.engine import ClangdSession

# Provenance marker for a first-party (consumer-side) endpoint of a cross edge.
# The consumer is not a pinned dependency, so it has no dep alias; this sentinel
# lets the I-3 report tell "which repo is each end in" without re-parsing paths.
FIRST_PARTY_PACKAGE = "<first-party>"


@dataclass
class DefSymbol:
    def_path: str      # the def-side header holding this definition
    def_pos: dict      # 0-based {line,character} of the definition name
    kind: str
    display_name: str


def _inside_dep(path: str, dep_marker: str) -> bool:
    """True if `path` lies under the pinned dependency's include root.

    realpath both sides: clangd reports ref paths symlink-resolved, so the marker
    must be compared in the same normalized form (see ClangdSession.uri_of).
    """
    real_dep = os.path.realpath(dep_marker)
    real_path = os.path.realpath(path)
    # commonpath equality requires a separator boundary -- prevents false match on
    # sibling dirs like .../dep/include-extra when dep_marker is .../dep/include
    try:
        return os.path.commonpath([real_dep, real_path]) == real_dep
    except ValueError:
        return False


def _enclosing_consumer(session: ClangdSession, ref_uri: str, ref_line: int):
    """The consumer documentSymbol whose body range contains `ref_line` (or None).

    A cross-pin ref's symbolInfo returns the REFERENCED type, not the enclosing
    function -- so the edge's from_symbol (the consumer that depends on the dep) is
    resolved via documentSymbol range-containment, smallest span wins.
    """
    best = None
    best_span = None
    for sym in session.document_symbols(ref_uri):
        lo, hi = sym["range_start_line"], sym["range_end_line"]
        if lo is None or hi is None:
            continue
        if lo <= ref_line <= hi:
            span = hi - lo
            if best_span is None or span < best_span:
                best, best_span = sym, span
    return best


def index_boundary(
    conn: sqlite3.Connection,
    session: ClangdSession,
    def_symbols: list[DefSymbol],
    dep_marker: str,
    repo: str = "mini",
    via: str = "mini::ntt",
    budget_s: float = 600.0,
) -> int:
    """Index one pin boundary; return the number of cross-pin edges written."""
    cross_written = 0

    # HYBRID: open the def headers AND every consumer TU BEFORE any references
    # (the pinned clangd v19 does not surface the cross-TU ref from the static
    # shard alone -- the open consumer TUs make the ref resolvable).
    opened: set[str] = set()
    for sym in def_symbols:
        p = os.path.abspath(sym.def_path)
        if p not in opened:
            session.open_file(p)
            opened.add(p)
    for tu in session.consumer_files():
        if tu not in opened:
            session.open_file(tu)
            opened.add(tu)
    # derive consumer basenames from the compile DB (not a hardcoded fixture name)
    consumer_basenames = [os.path.basename(f) for f in session.consumer_files()]
    # Wall-clock budget: on a large compile DB each consumer_basename gets up to 90s,
    # so N consumers x 90s has no global ceiling -- a CI-hang waiting to happen.
    # budget_s caps total shard-wait time; on exhaustion we proceed with whatever
    # shards settled (fail-safe, not fail-hard). The mini-ntt fixture finishes in
    # seconds, well under the default 600s budget.
    _budget_start = time.monotonic()
    for cb in consumer_basenames:
        if time.monotonic() - _budget_start >= budget_s:
            break  # budget exhausted; proceed with whatever shards have settled
        session.wait_for_shard(cb, timeout=90.0)  # discovery/settle per TU

    for sym in def_symbols:
        def_uri = ClangdSession.uri_of(sym.def_path)
        def_usr = session.symbol_info(def_uri, sym.def_pos)
        if def_usr is None:
            continue  # cannot key this symbol -> skip (fail-honest)

        # POSITION UNIT = 0-based LINE number (see store.enclosing_def). The def
        # symbol here is the pinned DEP type, resolved by symbol_info at a point;
        # we do not have its full body range, so its def occurrence spans just the
        # def-name line. That is fine: the retriever queries the CONSUMER side for
        # changed lines, and the consumer def below DOES get a real body span.
        def_line = sym.def_pos["line"]
        store.insert_symbol(
            conn,
            symbol_id=def_usr,
            kind=sym.kind,
            def_doc=os.path.realpath(sym.def_path),
            def_start=def_line,
            def_end=def_line,
            display_name=sym.display_name,
        )
        store.insert_occurrence(
            conn, def_usr, os.path.realpath(sym.def_path), def_line, def_line, store.ROLE_DEFINITION
        )

        for ref in session.references(def_uri, sym.def_pos):
            ref_path = ref["uri"]  # already symlink-resolved by clangd
            if not ref_path:
                continue
            char = ref["character"] or 0
            ref_line = ref["line"] or 0
            # every ref is an occurrence of the def symbol (Definition bit unset).
            # UNIT = line: so materialize_call_edges -> enclosing_def(doc, ref_line)
            # stabs the consumer body span stored below (same line unit).
            store.insert_occurrence(
                conn, def_usr, os.path.realpath(ref_path), ref_line, ref_line, 0
            )
            if _inside_dep(ref_path, dep_marker):
                continue  # self-reference inside the dep, not a cross-pin edge

            # cross-pin: the edge's FROM endpoint is the enclosing consumer def, not
            # the referenced type (symbol_info at the ref returns the type). Resolve
            # the enclosing function via documentSymbol, then its USR at its name.
            ref_uri = ClangdSession.uri_of(ref_path)
            encl = _enclosing_consumer(session, ref_uri, ref["line"])
            if encl is None:
                continue  # ref outside any consumer def (fail-honest: no edge)
            consumer_usr = session.symbol_info(
                ref_uri, {"line": encl["sel_line"], "character": encl["sel_char"]}
            )
            if consumer_usr is None or consumer_usr == def_usr:
                continue  # unresolved, or the type itself -> absent, never synthesized
            # record the consumer def symbol + its Definition occurrence spanning the
            # REAL BODY range (range_start_line..range_end_line, already fetched by
            # _enclosing_consumer via documentSymbol) -- NOT the name point. This is
            # what makes enclosing_def(consumer_doc, a-line-inside-the-body) resolve
            # back to this consumer USR. UNIT = 0-based line (matches occurrences +
            # enclosing_def query); insert_occurrence seeds def_ranges from it.
            body_lo = encl["range_start_line"]
            body_hi = encl["range_end_line"]
            store.insert_symbol(
                conn,
                symbol_id=consumer_usr,
                kind="function",
                def_doc=os.path.realpath(ref_path),
                def_start=body_lo,
                def_end=body_hi,
                display_name=encl["name"] or consumer_usr,
            )
            store.insert_occurrence(
                conn,
                consumer_usr,
                os.path.realpath(ref_path),
                body_lo,
                body_hi,
                store.ROLE_DEFINITION,
            )
            # provenance recorded at index time (I-3): the TO endpoint is the pinned
            # dep (its canonical alias = `via`); the FROM endpoint is first-party.
            store.insert_cross_edge(
                conn,
                from_symbol=consumer_usr,
                to_symbol=def_usr,
                kind="type",
                via=via,
                from_package=FIRST_PARTY_PACKAGE,
                to_package=via,
                evidence_doc=os.path.realpath(ref_path),
                evidence_start=char,
                evidence_end=char + len(sym.display_name),
            )
            cross_written += 1

    store.materialize_call_edges(conn, repo=repo)
    return cross_written
