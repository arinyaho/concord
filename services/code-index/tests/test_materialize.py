from code_index import materialize


def test_resolve_pinned_include_root_extracts_marked_dash_I():
    cdb = [
        {
            "arguments": [
                "clang++", "-std=c++17",
                "-I/home/u/proj/build/_deps/foo-lib-src/include",
                "-I/home/u/proj/app",
                "-c", "/home/u/proj/app/consumer.cpp",
            ],
        }
    ]
    root = materialize.resolve_pinned_include_root(cdb, package_marker="foo-lib-src")
    assert root == "/home/u/proj/build/_deps/foo-lib-src/include"


def test_resolve_pinned_include_root_handles_split_dash_I_form():
    cdb = [{"arguments": ["clang++", "-I", "/x/_deps/bar-lib-src/include", "-c", "a.cpp"]}]
    assert materialize.resolve_pinned_include_root(cdb, "bar-lib-src") \
        == "/x/_deps/bar-lib-src/include"


def test_resolve_pinned_include_root_absent_marker_returns_none():
    cdb = [{"arguments": ["clang++", "-I/x/app", "-c", "a.cpp"]}]
    assert materialize.resolve_pinned_include_root(cdb, "foo-lib-src") is None


def test_dedupe_by_alias_collapses_duplicate_roots():
    roots = {
        "acme::foo": [
            "/p/build/_deps/foo-lib-src/include",
            "/p/build/_deps/foolib-src/include",   # same logical package under a different _deps slug
        ],
    }
    out = materialize.dedupe_by_alias(roots)
    # one canonical root per alias (lexicographically first)
    assert out == {"acme::foo": "/p/build/_deps/foo-lib-src/include"}


def test_sibling_override_only_when_head_equals_pin():
    pin = "abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    def head_matches(_path):    # stubbed git HEAD == pin
        return pin

    def head_differs(_path):    # stubbed git HEAD != pin
        return "def5678000000000000000000000000000000000"

    assert materialize.sibling_override(pin, "/sib/foo-lib", head_matches) == "/sib/foo-lib"
    assert materialize.sibling_override(pin, "/sib/foo-lib", head_differs) is None


def test_resolve_pinned_include_root_rejects_marker_inside_longer_component():
    # "foo" appears inside "myfoo-extra" -- no /foo/ boundary, does not end with /foo.
    # The tightened 2-clause contract must NOT select this decoy root.
    cdb = [
        {
            "arguments": [
                "clang++",
                "-I/p/build/_deps/myfoo-extra/include",  # decoy: marker mid-component
                "-c", "a.cpp",
            ],
        }
    ]
    assert materialize.resolve_pinned_include_root(cdb, "foo") is None
