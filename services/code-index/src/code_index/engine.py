"""Batch-LSP clangd driver -- the batch static-index mechanism, in-code (HYBRID for clangd 19).

LSP transport: start clangd with --background-index=true, complete the LSP
handshake, then read cross-pin references + the version-stable USR via
textDocument/symbolInfo. PORTABILITY: earlier prototyping read the cross-pin ref
from the STATIC shard alone on clang-21, but the pinned clangd 19 background
SymbolCollector does not persist the cross-TU ref to the consumer shard -- so this
driver opens BOTH the def header AND every consumer TU (the caller does;
consumer_files() enumerates them) before querying references. The background index
is kept for shard discovery/settle and real-scale indexing, not as the ref source.
"""

import glob
import json
import os
import select
import subprocess
import time


class ClangdSession:
    def __init__(self, clangd_path: str, compile_db_dir: str) -> None:
        self.clangd_path = clangd_path
        self.compile_db_dir = os.path.abspath(compile_db_dir)
        self.index_dir = os.path.join(self.compile_db_dir, ".cache", "clangd", "index")
        self._rid = 100
        self._proc: subprocess.Popen | None = None

    # -- lifecycle -----------------------------------------------------------
    def __enter__(self) -> "ClangdSession":
        self._proc = subprocess.Popen(
            [
                self.clangd_path,
                f"--compile-commands-dir={self.compile_db_dir}",
                "--background-index=true",
                "--log=error",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # DEVNULL: we never drain stderr; PIPE would let clangd fill the ~64KB
            # kernel buffer on a real corpus (--log=error on 133 TUs), block on its
            # stderr write, stop responding on stdout, and surface as an RPC timeout.
            stderr=subprocess.DEVNULL,
        )
        try:
            self._rpc(
                "initialize",
                {
                    "processId": os.getpid(),
                    "rootUri": self.uri_of(self.compile_db_dir),
                    "capabilities": {
                        "textDocument": {
                            "documentSymbol": {"hierarchicalDocumentSymbolSupport": True}
                        }
                    },
                },
            )
            self._notify("initialized", {})
        except Exception:
            # __exit__ is never called when __enter__ raises, so terminate the child
            # here to prevent an orphaned clangd process.
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.kill()
            self._proc = None
            raise
        return self

    def __exit__(self, *exc) -> None:
        if self._proc is None:
            return
        try:
            self._rpc("shutdown", None, timeout=5)
            self._notify("exit", {})
        except Exception:
            pass
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except Exception:
            self._proc.kill()

    # -- LSP transport -------------------------------------------------------
    def _send(self, msg: dict) -> None:
        body = json.dumps(msg).encode()
        self._proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        self._proc.stdin.flush()

    def _notify(self, method: str, params) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _rpc(self, method: str, params, timeout: float = 45.0) -> dict:
        self._rid += 1
        mid = self._rid
        self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        return self._read_until(mid, timeout)

    def _read_until(self, target_id: int, timeout: float) -> dict:
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([self._proc.stdout], [], [], max(0.05, deadline - time.time()))
            if not ready:
                continue
            chunk = os.read(self._proc.stdout.fileno(), 65536)
            if not chunk:
                break
            buf += chunk
            while b"\r\n\r\n" in buf:
                head, rest = buf.split(b"\r\n\r\n", 1)
                length = None
                for line in head.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":")[1])
                if length is None or len(rest) < length:
                    break
                body, buf = rest[:length], rest[length:]
                msg = json.loads(body)
                if msg.get("id") == target_id and ("result" in msg or "error" in msg):
                    return msg
        return {"error": "timeout"}

    def _drain(self, dur: float) -> None:
        end = time.time() + dur
        while time.time() < end:
            ready, _, _ = select.select([self._proc.stdout], [], [], end - time.time())
            if ready:
                os.read(self._proc.stdout.fileno(), 65536)

    # -- API -----------------------------------------------------------------
    @staticmethod
    def uri_of(path: str) -> str:
        # realpath, NOT abspath: clangd resolves symlinks and reports refs at the
        # real path (e.g. macOS /var -> /private/var; any symlinked checkout). If we
        # open a file under one path and query documentSymbol/references at another,
        # clangd has no open doc at that URI and returns []. realpath makes the
        # opened URI match clangd's reported URIs. (Verified: without this, the
        # cross-pin edge is silently lost on macOS tmp dirs.)
        return "file://" + os.path.realpath(path)

    def consumer_files(self) -> list[str]:
        """Distinct real `file` paths from the compile DB -- the consumer TUs."""
        cdb_path = os.path.join(self.compile_db_dir, "compile_commands.json")
        with open(cdb_path) as fh:
            entries = json.load(fh)
        seen: list[str] = []
        for e in entries:
            f = os.path.realpath(e["file"])
            if f not in seen:
                seen.append(f)
        return seen

    def open_file(self, path: str) -> None:
        """didOpen a source/header file (the def header AND each consumer TU)."""
        with open(path) as fh:
            text = fh.read()
        self._notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": self.uri_of(path),
                    "languageId": "cpp",
                    "version": 1,
                    "text": text,
                }
            },
        )
        self._drain(1.0)

    def wait_for_shard(self, consumer_basename: str, timeout: float = 90.0) -> bool:
        """Poll for <index_dir>/<consumer_basename>.*.idx while draining LSP output."""
        deadline = time.time() + timeout
        pattern = os.path.join(self.index_dir, f"{consumer_basename}.*.idx")
        while time.time() < deadline:
            if glob.glob(pattern):
                self._drain(2.0)  # settle so the refs merge sees the fresh shard
                return True
            self._drain(1.5)
        return bool(glob.glob(pattern))

    def references(self, header_uri: str, pos: dict) -> list[dict]:
        """textDocument/references at pos on header_uri -> [{uri,line,character}].

        Drains BEFORE each attempt: the opened consumer TUs' ASTs may lag the shard,
        so a settle precedes the first query and each retry (measured: the cross-pin
        ref surfaces ~1s after didOpen on the pinned clangd).
        """
        out: list[dict] = []
        _prev_count: int = -1
        for _ in range(12):
            self._drain(1.0)  # settle before querying (consumer AST may lag)
            msg = self._rpc(
                "textDocument/references",
                {
                    "textDocument": {"uri": header_uri},
                    "position": pos,
                    "context": {"includeDeclaration": False},
                },
            )
            res = msg.get("result") or []
            out = [
                {
                    "uri": loc.get("uri", "").replace("file://", ""),
                    "line": loc.get("range", {}).get("start", {}).get("line"),
                    "character": loc.get("range", {}).get("start", {}).get("character"),
                }
                for loc in res
            ]
            if out and len(out) == _prev_count:
                break  # stable non-empty result: converged
            _prev_count = len(out)
        return out

    def symbol_info(self, uri: str, pos: dict) -> str | None:
        """textDocument/symbolInfo at pos -> the first result's `usr` (reject `id`)."""
        msg = self._rpc(
            "textDocument/symbolInfo",
            {"textDocument": {"uri": uri}, "position": pos},
        )
        res = msg.get("result")
        if isinstance(res, list) and res:
            return res[0].get("usr")  # the USR string; NOT res[0]["id"] (the hash)
        return None

    def document_symbols(self, uri: str) -> list[dict]:
        """textDocument/documentSymbol -> flattened {name, range span, selectionRange}.

        Retries with a settle: the consumer TU's AST may lag its didOpen, so an
        early query returns [] until the symbols are built.
        """
        for _ in range(10):
            msg = self._rpc(
                "textDocument/documentSymbol", {"textDocument": {"uri": uri}}
            )
            res = msg.get("result") or []
            if res:
                out: list[dict] = []
                for sym in res:
                    rng = sym.get("range", {})
                    sel = sym.get("selectionRange", {}).get("start", {})
                    out.append(
                        {
                            "name": sym.get("name"),
                            "range_start_line": rng.get("start", {}).get("line"),
                            "range_end_line": rng.get("end", {}).get("line"),
                            "sel_line": sel.get("line"),
                            "sel_char": sel.get("character"),
                        }
                    )
                return out
            self._drain(1.0)
        return []
