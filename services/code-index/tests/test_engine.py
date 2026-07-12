import os

import pytest

from code_index.engine import ClangdSession
from tests.fixtures import mini_ntt


@pytest.mark.requires_clangd
def test_static_index_cross_pin_reference_and_usr_join(clangd_path, tmp_path):
    fx = mini_ntt.build_fixture(str(tmp_path / "mini"))

    with ClangdSession(clangd_path, fx.compile_db_dir) as session:
        # HYBRID mechanism (portable across clangd versions): open the def header
        # AND every consumer TU, then let the background index settle.
        session.open_file(fx.header_path)
        for tu in session.consumer_files():
            session.open_file(tu)
        # shard presence = discovery/settle signal (not the ref source on v19)
        assert session.wait_for_shard("consumer.cpp", timeout=90.0), \
            "clangd never produced a static shard for consumer.cpp"

        header_uri = ClangdSession.uri_of(fx.header_path)
        refs = session.references(header_uri, fx.ntt_def_pos)
        # a reference to the NTT class def must be located in consumer.cpp
        assert any(os.path.basename(r["uri"]) == "consumer.cpp" for r in refs), \
            f"no cross-pin ref into consumer.cpp; got {refs}"

        # USR at the def site and at the consumer use site must be byte-identical
        usr_def = session.symbol_info(header_uri, fx.ntt_def_pos)
        consumer_uri = ClangdSession.uri_of(fx.consumer_path)
        usr_use = session.symbol_info(consumer_uri, fx.ntt_use_pos)

        assert usr_def is not None and usr_def == usr_use, \
            f"USR join mismatch: def={usr_def!r} use={usr_use!r}"
        assert usr_def.startswith("c:")  # a clang USR string, not the SymbolID hash
